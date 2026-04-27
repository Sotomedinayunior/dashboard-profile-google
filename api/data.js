/**
 * api/data.js
 * GET /api/data
 *
 * Fetches GSC + GMB + GA4 data using server-side environment variables.
 * No login required — all credentials live in Vercel env vars.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *   GSC_PROPERTY  (e.g. https://nellyrac.do/)
 *   GA4_PROPERTY_ID (e.g. properties/341199344)
 */
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use GET' });
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const gscProperty  = process.env.GSC_PROPERTY;
  const ga4Property  = process.env.GA4_PROPERTY_ID || null;
  const serpKey      = process.env.SERPAPI_KEY      || null;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no configurados en Vercel' });
  }
  if (!refreshToken) {
    return res.status(500).json({ error: 'GOOGLE_REFRESH_TOKEN no configurado en Vercel' });
  }
  if (!gscProperty) {
    return res.status(500).json({ error: 'GSC_PROPERTY no configurado en Vercel' });
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  // Only fetch GMB if GMB_ACCOUNT_NAME is configured — avoids quota exhaustion
  // on mybusinessaccountmanagement.googleapis.com during setup.
  // Set GMB_ACCOUNT_NAME=accounts/XXXXXXXXX in Vercel to enable GMB data.
  // GMB_ACCOUNT_NAME = accounts/14783610060775958761 (fallback hardcoded)
  const gmbPromise = fetchGMB(auth);

  const [gsc, gmb, ga4, serpGmbResult] = await Promise.allSettled([
    fetchGSC(auth, gscProperty),
    gmbPromise,
    ga4Property ? fetchGA4(auth, ga4Property) : Promise.resolve(null),
    serpKey     ? fetchSerpGMBData(serpKey)    : Promise.resolve(null),
  ]);

  const gscData     = gsc.status  === 'fulfilled' ? gsc.value  : { error: gsc.reason?.message };
  let   gmbData     = gmb.status  === 'fulfilled' ? gmb.value  : { ...EMPTY_GMB, error: gmb.reason?.message };
  const ga4Data     = ga4.status  === 'fulfilled' ? ga4.value  : { error: ga4.reason?.message };
  const serpGmbData = serpGmbResult.status === 'fulfilled' ? serpGmbResult.value : null;

  // If native GMB API has no locations yet, use SerpAPI data for KPIs
  if (serpGmbData && !(gmbData.locations?.length)) {
    gmbData = {
      ...gmbData,
      configured:     true,
      rating:         serpGmbData.avgRating,
      reviewCount:    serpGmbData.totalReviews,
      bestLocation:   serpGmbData.bestLocation,
      locations:      serpGmbData.locations,
      serpApiFallback: true,    // tells the frontend to show "API pending" in reviews
      reviewsApiError: null,    // clear native GMB error since SerpAPI is working
    };
  }

  // Cache successful responses for 1 hour; never cache errors
  const hasError = gscData.error || ga4Data?.error;
  res.setHeader('Cache-Control', hasError ? 'no-store' : 's-maxage=3600, stale-while-revalidate=600');

  return res.status(200).json({ ...gscData, gmb: gmbData, ga4: ga4Data });
};

// ── Date helpers ──────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ── GSC ───────────────────────────────────────────────────────────────────────
async function fetchGSC(auth, property) {
  const sc = google.searchconsole({ version: 'v1', auth });

  const dateEnd  = daysAgo(2);
  const start6M  = daysAgo(182);
  const start28D = daysAgo(28);
  const start7D  = daysAgo(7);

  const q = (startDate, endDate, dimensions, rowLimit = 100) =>
    sc.searchanalytics.query({
      siteUrl: property,
      requestBody: { startDate, endDate, dimensions, rowLimit },
    }).then(r => r.data.rows || []).catch(() => []);

  const [daily, queries, pages, countries, devices, d28, d7] = await Promise.all([
    q(start6M, dateEnd, ['date'],    182),
    q(start6M, dateEnd, ['query'],  1000),
    q(start6M, dateEnd, ['page'],    250),
    q(start6M, dateEnd, ['country'], 200),
    q(start6M, dateEnd, ['device'],   10),
    q(start28D, dateEnd, ['date'],    28),
    q(start7D,  dateEnd, ['date'],     7),
  ]);

  const sum = rows => {
    const tc = rows.reduce((a, r) => a + r.clicks, 0);
    const ti = rows.reduce((a, r) => a + r.impressions, 0);
    return {
      total_clicks: tc, total_impressions: ti,
      avg_ctr:      ti ? +((tc / ti) * 100).toFixed(2) : 0,
      avg_position: ti ? +(rows.reduce((a, r) => a + r.position * r.impressions, 0) / ti).toFixed(1) : 0,
    };
  };

  const fmt = (rows, keys) => rows.map(r => {
    const obj = {};
    keys.forEach((k, i) => { obj[k] = r.keys[i]; });
    return { ...obj, clicks: r.clicks, impressions: r.impressions,
             ctr: +(r.ctr * 100).toFixed(2), position: +r.position.toFixed(2) };
  });

  const s6m = sum(daily);
  return {
    meta: {
      updated_at:   new Date().toISOString().split('T')[0],
      date_start:   start6M,
      date_end:     dateEnd,
      gsc_property: property,
      source:       'live',
    },
    summary_6m: {
      ...s6m,
      avg_clicks_per_day: daily.length ? +(s6m.total_clicks / daily.length).toFixed(1) : 0,
      days: daily.length,
    },
    summary_28d: sum(d28),
    summary_7d:  sum(d7),
    chart:     fmt(daily,    ['date']),
    queries:   fmt(queries,  ['query']),
    pages:     fmt(pages,    ['page']),
    countries: fmt(countries,['country']),
    devices:   fmt(devices,  ['device']),
  };
}

// ── GA4 ───────────────────────────────────────────────────────────────────────
async function fetchGA4(auth, propertyId) {
  const { token } = await auth.getAccessToken();
  const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Normalize property id → "properties/XXXXXXX"
  const prop = propertyId.toString().startsWith('properties/')
    ? propertyId
    : `properties/${propertyId}`;

  const url = `https://analyticsdata.googleapis.com/v1beta/${prop}:runReport`;

  const dateEnd   = daysAgo(1);
  const date6M    = daysAgo(182);
  const date28D   = daysAgo(28);
  const date7D    = daysAgo(7);

  const TIMEOUT = AbortSignal.timeout(7000);

  // Primera llamada sin silenciar errores para detectar el problema real
  const runFirst = async (body) => {
    const r = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e?.error?.message || `GA4 HTTP ${r.status}`);
    }
    return r.json();
  };
  const run = (body) =>
    fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) })
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.error?.message || 'GA4 error'); }))
      .catch(() => null);

  const [overview, channels, pages, devices, countries, daily7d, daily28d, daily6m] = await Promise.all([
    // Overview: usa runFirst para que el error sea visible
    runFirst({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      metrics: [
        { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' },
        { name: 'engagementRate' }, { name: 'averageSessionDuration' }, { name: 'screenPageViews' },
        { name: 'bounceRate' },
      ],
    }),
    // Traffic channels
    run({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    }),
    // Top pages
    run({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'averageSessionDuration' }, { name: 'engagementRate' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 20,
    }),
    // Devices
    run({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
    // Countries
    run({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    }),
    // Daily chart 7 days
    run({
      dateRanges: [{ startDate: date7D, endDate: dateEnd }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    // Daily chart 28 days
    run({
      dateRanges: [{ startDate: date28D, endDate: dateEnd }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    // Daily chart 6 months
    run({
      dateRanges: [{ startDate: date6M, endDate: dateEnd }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
  ]);

  const metVal = (row, idx) => parseFloat(row?.metricValues?.[idx]?.value || 0);
  const dimVal = (row, idx) => row?.dimensionValues?.[idx]?.value || '';

  // Overview
  const ov = overview?.rows?.[0];
  const summary = {
    sessions:        Math.round(metVal(ov, 0)),
    users:           Math.round(metVal(ov, 1)),
    newUsers:        Math.round(metVal(ov, 2)),
    engagementRate:  +(metVal(ov, 3) * 100).toFixed(1),
    avgSessionDur:   +metVal(ov, 4).toFixed(0),
    pageViews:       Math.round(metVal(ov, 5)),
    bounceRate:      +(metVal(ov, 6) * 100).toFixed(1),
  };

  // Channels
  const channelRows = (channels?.rows || []).map(r => ({
    channel:         dimVal(r, 0),
    sessions:        Math.round(metVal(r, 0)),
    users:           Math.round(metVal(r, 1)),
    engagementRate:  +(metVal(r, 2) * 100).toFixed(1),
  }));

  // Pages
  const pageRows = (pages?.rows || []).map(r => ({
    page:            dimVal(r, 0),
    pageViews:       Math.round(metVal(r, 0)),
    sessions:        Math.round(metVal(r, 1)),
    avgDuration:     +metVal(r, 2).toFixed(0),
    engagementRate:  +(metVal(r, 3) * 100).toFixed(1),
  }));

  // Devices
  const deviceRows = (devices?.rows || []).map(r => ({
    device:          dimVal(r, 0),
    sessions:        Math.round(metVal(r, 0)),
    users:           Math.round(metVal(r, 1)),
    engagementRate:  +(metVal(r, 2) * 100).toFixed(1),
  }));

  // Countries
  const countryRows = (countries?.rows || []).map(r => ({
    country:         dimVal(r, 0),
    sessions:        Math.round(metVal(r, 0)),
    users:           Math.round(metVal(r, 1)),
    engagementRate:  +(metVal(r, 2) * 100).toFixed(1),
  }));

  // Daily charts
  const fmtDaily = (report) => (report?.rows || []).map(r => ({
    date:     dimVal(r, 0),
    sessions: Math.round(metVal(r, 0)),
    users:    Math.round(metVal(r, 1)),
  }));

  return {
    configured: true,
    property:   prop,
    summary,
    channels:   channelRows,
    pages:      pageRows,
    devices:    deviceRows,
    countries:  countryRows,
    daily7d:    fmtDaily(daily7d),
    daily28d:   fmtDaily(daily28d),
    daily6m:    fmtDaily(daily6m),
  };
}

// ── GMB ───────────────────────────────────────────────────────────────────────

// Las 5 sucursales de Nelly RAC con sus Place IDs de Google Maps
const NELLY_LOCATIONS = [
  { id: 'independencia', name: 'Independencia',       shortName: 'Independencia', placeId: 'ChIJPRzgUXlipY4RTFpdm7Gtz2M' },
  { id: 'cibao',         name: 'Aeropuerto Cibao',    shortName: 'Cibao STI',     placeId: 'ChIJBUNVazXRsY4R76jNG9B5mUQ' },
  { id: 'puertoplata',   name: 'Gregorio Luperón',    shortName: 'Pto. Plata',    placeId: 'ChIJNSahrlDksY4RdDGaHelddiY' },
  { id: 'puntacana',     name: 'Punta Cana',          shortName: 'Punta Cana',    placeId: 'ChIJPZ6a5d6TqI4R5-DvEC5384M' },
  { id: 'bocachica',     name: 'Boca Chica',          shortName: 'Boca Chica',    placeId: 'ChIJIfF1mPt_pY4RDB9kOOVbvz0' },
];

const EMPTY_PERF = {
  views:   { maps: null, search: null, total: null },
  actions: { calls: null, websiteClicks: null, directions: null, total: null },
  daily:   [],
};

const EMPTY_GMB = {
  configured: false, rating: null, reviewCount: null, reviews: [],
  locations: [],
  performance: { views: { maps: null, search: null, total: null },
                 actions: { calls: null, websiteClicks: null, directions: null, total: null }, daily: [] },
};

// Fecha helper para GMB performance
function gmbDateRange(daysBack) {
  const end = new Date(), start = new Date();
  start.setDate(start.getDate() - daysBack);
  return {
    startDate: { year: start.getFullYear(), month: start.getMonth()+1, day: start.getDate() },
    endDate:   { year: end.getFullYear(),   month: end.getMonth()+1,   day: end.getDate() },
  };
}

// Fetch reviews for one location trying multiple URL patterns
async function fetchLocationReviews(hdrs, locationResourceName) {
  const locationId = locationResourceName.split('/').pop();
  const attempts = [
    `https://mybusinessreviews.googleapis.com/v1/locations/${locationId}/reviews?pageSize=50`,
    `https://mybusinessreviews.googleapis.com/v1/${locationResourceName}/reviews?pageSize=50`,
    `https://mybusiness.googleapis.com/v4/${locationResourceName}/reviews?pageSize=50`,
  ];
  for (const url of attempts) {
    try {
      const r = await fetch(url, { headers: hdrs });
      if (r.ok) {
        console.log('[GMB Reviews] OK:', url.split('googleapis.com')[1]);
        return r.json();
      }
      const txt = await r.text().catch(() => '');
      console.log('[GMB Reviews] failed', r.status, url.split('googleapis.com')[1], txt.slice(0,120));
    } catch (e) {
      console.log('[GMB Reviews] exception:', e.message);
    }
  }
  return null;
}

// Fetch performance metrics for one location
async function fetchLocationPerformance(hdrs, locationId) {
  const range = gmbDateRange(90);
  try {
    const r = await fetch(
      `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
      {
        method: 'POST', headers: hdrs,
        body: JSON.stringify({
          dailyMetrics: [
            'BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
            'BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
            'CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS',
          ],
          dailyRange: range,
        }),
      }
    );
    return r.ok ? r.json() : null;
  } catch (e) { return null; }
}

// Parse performance response into views/actions/daily
function parsePerformance(perfRes) {
  const STARS = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 };
  const series = perfRes?.multiDailyMetricTimeSeries || [];
  const metricMap = {};
  series.forEach(s => { metricMap[s.dailyMetric] = s.timeSeries?.datedValues || []; });

  const sumMetric = key => (metricMap[key]||[]).slice(-30).reduce((a,v)=>a+(parseInt(v.value)||0),0);
  const mapsViews   = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_MAPS')  + sumMetric('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const searchViews = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') + sumMetric('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const calls = sumMetric('CALL_CLICKS'), webClicks = sumMetric('WEBSITE_CLICKS'), dirs = sumMetric('BUSINESS_DIRECTION_REQUESTS');

  const dailyIdx = {};
  const addMetric = (key, field) => (metricMap[key]||[]).forEach(v => {
    const d = `${v.date.year}-${String(v.date.month).padStart(2,'0')}-${String(v.date.day).padStart(2,'0')}`;
    if (!dailyIdx[d]) dailyIdx[d] = { date:d, views:0, actions:0 };
    dailyIdx[d][field] = (dailyIdx[d][field]||0) + (parseInt(v.value)||0);
  });
  ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_MOBILE_MAPS',
   'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH','BUSINESS_IMPRESSIONS_MOBILE_SEARCH'].forEach(k=>addMetric(k,'views'));
  ['CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS'].forEach(k=>addMetric(k,'actions'));

  return {
    views:   { maps: mapsViews, search: searchViews, total: mapsViews+searchViews },
    actions: { calls, websiteClicks: webClicks, directions: dirs, total: calls+webClicks+dirs },
    daily:   Object.values(dailyIdx).sort((a,b)=>a.date.localeCompare(b.date)),
  };
}

// Fetch one location's full data (reviews + performance)
async function fetchOneLocation(hdrs, locationResourceName, nellyLoc) {
  const locationId = locationResourceName.split('/').pop();
  const STARS = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 };

  const [reviewsRes, perfRes] = await Promise.all([
    fetchLocationReviews(hdrs, locationResourceName),
    fetchLocationPerformance(hdrs, locationId),
  ]);

  const reviews = (reviewsRes?.reviews || []).map(r => ({
    id: r.reviewId,
    reviewer: r.reviewer?.displayName || 'Anónimo',
    stars: STARS[r.starRating] || 0,
    comment: r.comment || '',
    date: r.createTime?.split('T')[0] || '',
    replied: !!r.reviewReply,
    _locId: nellyLoc.id,
    locationName: nellyLoc.shortName,
  }));

  const avgRating  = reviewsRes?.averageRating  != null ? parseFloat(reviewsRes.averageRating)  : null;
  const totalCount = reviewsRes?.totalReviewCount != null ? parseInt(reviewsRes.totalReviewCount) : (reviews.length || null);
  const perf = parsePerformance(perfRes);

  return {
    id:          nellyLoc.id,
    name:        nellyLoc.name,
    shortName:   nellyLoc.shortName,
    placeId:     nellyLoc.placeId,
    resourceName: locationResourceName,
    configured:  true,
    rating:      isNaN(avgRating)  ? null : avgRating,
    reviewCount: isNaN(totalCount) ? null : totalCount,
    reviews,
    reviewsApiError: reviewsRes === null
      ? `Reseñas no disponibles para ${nellyLoc.name}.`
      : null,
    performance: perf,
  };
}

// Main GMB fetcher — uses GMB_ACCOUNT_NAME env var when set (avoids quota-heavy
// mybusinessaccountmanagement API). Falls back to auto-discovery if not set.
async function fetchGMB(auth) {
  const { token } = await auth.getAccessToken();
  const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Step 1: Resolve account name(s) ──────────────────────────────────────
  // Prefer GMB_ACCOUNT_NAME env var to avoid hitting the Account Management API
  // (which has very low quota limits and causes 429 errors).
  // Format: "accounts/XXXXXXXXX"  — find it in business.google.com URL or Vercel logs.
  // Fallback al account ID conocido de business.google.com/n/14783610060775958761
  const accountNameEnv = (process.env.GMB_ACCOUNT_NAME || 'accounts/14783610060775958761').trim();

  let accounts = [];

  if (accountNameEnv) {
    // Use hardcoded account — no API call needed
    accounts = [{ name: accountNameEnv }];
    console.log('[GMB] using account:', accountNameEnv);
  } else {
    // Auto-discover via Account Management API (may hit 429 quota)
    const accountsRaw = await fetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: hdrs, signal: AbortSignal.timeout(8000) }
    ).catch(e => ({ ok: false, _err: e.message }));

    if (accountsRaw.ok) {
      const accountsRes = await accountsRaw.json().catch(() => null);
      accounts = accountsRes?.accounts || [];
      console.log('[GMB] auto-discovered accounts:', accounts.length);
    } else {
      let body = '';
      try { body = await accountsRaw.text(); } catch (_) {}
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const apiMsg = parsed?.error?.message || body.slice(0, 200) || accountsRaw._err || '';
      const errDetail = `HTTP ${accountsRaw.status || '?'}: ${apiMsg}`;
      console.error('[GMB] accounts API error:', errDetail);

      const hint = accountsRaw.status === 429
        ? 'Cuota excedida en mybusinessaccountmanagement API. Agrega GMB_ACCOUNT_NAME en Vercel (formato: accounts/XXXXXXXXX) para evitar esta llamada.'
        : errDetail;

      return { ...EMPTY_GMB, configured: true, reviewsApiError: hint };
    }
  }

  if (!accounts.length) {
    return { ...EMPTY_GMB, configured: true,
      reviewsApiError: 'No se encontraron cuentas. Agrega GMB_ACCOUNT_NAME=accounts/XXXXXXXXX en Vercel.' };
  }

  // Step 2: List all locations for each account
  let allApiLocations = [];
  for (const account of accounts) {
    const locRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,metadata`,
      { headers: hdrs, signal: AbortSignal.timeout(8000) }
    ).then(r => r.ok ? r.json() : null).catch(() => null);

    const locs = locRes?.locations || [];
    console.log('[GMB] locations in', account.name, ':', locs.length);
    allApiLocations.push(...locs);
  }

  // Step 3: Match discovered locations with NELLY_LOCATIONS by placeId
  const knownPlaceIds = new Set(NELLY_LOCATIONS.map(l => l.placeId));
  const matchedPairs = [];

  for (const nellyLoc of NELLY_LOCATIONS) {
    const apiLoc = allApiLocations.find(l => l.metadata?.placeId === nellyLoc.placeId);
    if (apiLoc) {
      matchedPairs.push({ apiLoc, nellyLoc });
    } else {
      console.log('[GMB] no match for:', nellyLoc.name, '(placeId:', nellyLoc.placeId, ')');
    }
  }

  // If no matches (API not yet approved), return configured but empty
  if (!matchedPairs.length) {
    // Try with all discovered locations as fallback (first 5)
    const fallback = allApiLocations.slice(0, 5);
    if (!fallback.length) {
      return {
        ...EMPTY_GMB, configured: true,
        reviewsApiError: 'Google Business API conectada pero sin ubicaciones accesibles. La aprobación puede estar pendiente.',
      };
    }
    // Use fallback locations with generic names
    matchedPairs.push(...fallback.map((apiLoc, i) => ({
      apiLoc,
      nellyLoc: NELLY_LOCATIONS[i] || { id: `loc${i}`, name: apiLoc.title || `Sucursal ${i+1}`, shortName: `Sucursal ${i+1}`, placeId: '' },
    })));
  }

  console.log('[GMB] processing', matchedPairs.length, 'locations');

  // Step 4: Fetch reviews + performance for each matched location in parallel
  const locationData = await Promise.all(
    matchedPairs.map(({ apiLoc, nellyLoc }) =>
      fetchOneLocation(hdrs, apiLoc.name, nellyLoc)
    )
  );

  // Step 5: Aggregate totals across all locations
  const allReviews   = locationData.flatMap(l => l.reviews);
  const ratedLocs    = locationData.filter(l => l.rating !== null);
  const avgRating    = ratedLocs.length
    ? +(ratedLocs.reduce((s,l) => s + l.rating, 0) / ratedLocs.length).toFixed(1)
    : null;
  const totalReviews = locationData.reduce((s,l) => s + (l.reviewCount || 0), 0);
  const bestLoc      = ratedLocs.length
    ? ratedLocs.reduce((best,l) => l.rating > best.rating ? l : best)
    : null;

  const aggPerf = locationData.reduce((agg, l) => ({
    views: {
      maps:   (agg.views.maps   || 0) + (l.performance.views.maps   || 0),
      search: (agg.views.search || 0) + (l.performance.views.search || 0),
      total:  (agg.views.total  || 0) + (l.performance.views.total  || 0),
    },
    actions: {
      calls:         (agg.actions.calls         || 0) + (l.performance.actions.calls         || 0),
      websiteClicks: (agg.actions.websiteClicks || 0) + (l.performance.actions.websiteClicks || 0),
      directions:    (agg.actions.directions    || 0) + (l.performance.actions.directions    || 0),
      total:         (agg.actions.total         || 0) + (l.performance.actions.total         || 0),
    },
  }), { views: {}, actions: {} });

  // Merge daily timeseries across all locations
  const dailyMerged = {};
  locationData.forEach(l => {
    (l.performance.daily || []).forEach(d => {
      if (!dailyMerged[d.date]) dailyMerged[d.date] = { date: d.date, views: 0, actions: 0 };
      dailyMerged[d.date].views   += d.views   || 0;
      dailyMerged[d.date].actions += d.actions || 0;
    });
  });

  const anyError = locationData.filter(l => l.reviewsApiError).map(l => l.reviewsApiError).join(' | ');

  return {
    configured:  true,
    rating:      avgRating,
    reviewCount: totalReviews || null,
    bestLocation: bestLoc ? { name: bestLoc.name, rating: bestLoc.rating } : null,
    reviews:     allReviews,
    reviewsApiError: anyError || null,
    locations:   locationData,
    performance: {
      views:   aggPerf.views,
      actions: aggPerf.actions,
      daily:   Object.values(dailyMerged).sort((a,b) => a.date.localeCompare(b.date)),
    },
  };
}

// ── SerpAPI GMB fallback — una búsqueda por sucursal para máxima fiabilidad ────
const SERP_SEARCHES = [
  { locId: 'independencia', q: 'Nelly Rent A Car Independencia Santo Domingo' },
  { locId: 'cibao',         q: 'Nelly Rent A Car Aeropuerto Cibao Santiago'   },
  { locId: 'puertoplata',   q: 'Nelly Rent A Car Puerto Plata'                },
  { locId: 'puntacana',     q: 'Nelly Rent A Car Punta Cana'                  },
  { locId: 'bocachica',     q: 'Nelly Rent A Car Boca Chica'                  },
];

async function fetchOneBranch(nelly, q, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_maps',
    q,
    gl:      'do',
    hl:      'es',
    api_key: apiKey,
  });

  try {
    const r = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    // SerpAPI puede devolver local_results (lista) o place_results (lugar específico)
    let match = null;

    // 1. Buscar en local_results
    if (!match && data.local_results?.length) {
      match = data.local_results.find(
        m => m.place_id === nelly.placeId || m.title?.toLowerCase().includes('nelly')
      ) || data.local_results[0]; // primer resultado si no hay match exacto
    }

    // 2. Buscar en place_results (resultado único de negocio específico)
    if (!match && data.place_results) {
      const p = data.place_results;
      if (p.place_id === nelly.placeId || p.title?.toLowerCase().includes('nelly') || p.title?.toLowerCase().includes('rent')) {
        match = p;
      }
    }

    if (match) {
      return {
        id: nelly.id, name: nelly.name, shortName: nelly.shortName, placeId: nelly.placeId,
        configured:  true,
        rating:      typeof match.rating  === 'number' ? match.rating  : null,
        reviewCount: typeof match.reviews === 'number' ? match.reviews :
                     typeof match.reviews_count === 'number' ? match.reviews_count : null,
        address:     match.address || null,
        phone:       match.phone   || null,
        isOpen:      match.hours?.current_status || match.open_state || null,
        reviews:     [],
        performance: EMPTY_PERF,
      };
    }
  } catch (e) {
    console.error('[SerpAPI branch]', nelly.id, e.message);
  }

  // Sin resultado para esta sucursal
  return {
    id: nelly.id, name: nelly.name, shortName: nelly.shortName, placeId: nelly.placeId,
    configured: false, rating: null, reviewCount: null,
    reviews: [], performance: EMPTY_PERF,
  };
}

async function fetchSerpGMBData(apiKey) {
  // Todas las sucursales en paralelo
  const locations = await Promise.all(
    NELLY_LOCATIONS.map(nelly => {
      const search = SERP_SEARCHES.find(s => s.locId === nelly.id);
      return fetchOneBranch(nelly, search?.q || `Nelly Rent A Car ${nelly.name}`, apiKey);
    })
  );

  const withRating   = locations.filter(l => l.rating !== null);
  const avgRating    = withRating.length
    ? +(withRating.reduce((s, l) => s + l.rating, 0) / withRating.length).toFixed(1)
    : null;
  const totalReviews = locations.reduce((s, l) => s + (l.reviewCount || 0), 0);
  const bestLoc      = [...withRating].sort((a, b) => b.rating - a.rating)[0] || null;

  return {
    avgRating,
    totalReviews,
    bestLocation: bestLoc ? { name: bestLoc.shortName, rating: bestLoc.rating } : null,
    locations,
  };
}
