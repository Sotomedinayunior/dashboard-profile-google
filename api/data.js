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
  res.setHeader('Cache-Control', 's-maxage=3600');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Use GET' });
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const gscProperty  = process.env.GSC_PROPERTY;
  const ga4Property  = process.env.GA4_PROPERTY_ID || null;
  const gmbLocation  = process.env.GMB_LOCATION_NAME || null;

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

  const [gsc, gmb, ga4] = await Promise.allSettled([
    fetchGSC(auth, gscProperty),
    gmbLocation ? fetchGMB(auth, gmbLocation) : Promise.resolve(EMPTY_GMB),
    ga4Property ? fetchGA4(auth, ga4Property) : Promise.resolve(null),
  ]);

  const gscData = gsc.status === 'fulfilled' ? gsc.value : { error: gsc.reason?.message };
  const gmbData = gmb.status === 'fulfilled' ? gmb.value : { ...EMPTY_GMB, error: gmb.reason?.message };
  const ga4Data = ga4.status === 'fulfilled' ? ga4.value : { error: ga4.reason?.message };

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

  const run = (body) =>
    fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body) })
      .then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(e?.error?.message || 'GA4 error'); }))
      .catch(() => null);

  const [overview, channels, pages, devices, countries, daily7d, daily28d, daily6m] = await Promise.all([
    // Overview totals (6 months)
    run({
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
const EMPTY_GMB = {
  configured: false, rating: null, reviewCount: null, reviews: [],
  performance: { views: { maps: null, search: null, total: null },
                 actions: { calls: null, websiteClicks: null, directions: null, total: null }, daily: [] },
};

async function fetchGMB(auth, locationName) {
  console.log('[GMB] locationName:', locationName);
  const { token } = await auth.getAccessToken();
  const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // locationName format: "accounts/{accountId}/locations/{locationId}"
  const parts = locationName.split('/');
  const locationId = parts[3] || parts[1];
  console.log('[GMB] locationId:', locationId);

  // locationName = "accounts/{accountId}/locations/{locationId}"
  // New Reviews API needs just "locations/{locationId}"
  const locSegment = locationName.includes('/locations/')
    ? 'locations/' + locationName.split('/locations/')[1]
    : locationName;

  // Try all known API patterns in order
  const fetchReviews = async () => {
    const attempts = [
      // New API (2022+) - with just locations/{id}
      `https://mybusinessreviews.googleapis.com/v1/${locSegment}/reviews?pageSize=50`,
      // New API - with full accounts/.../locations/... path
      `https://mybusinessreviews.googleapis.com/v1/${locationName}/reviews?pageSize=50`,
      // Old v4 API (deprecated but may still work)
      `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50`,
    ];
    for (const url of attempts) {
      try {
        const r = await fetch(url, { headers: hdrs });
        if (r.ok) {
          const data = await r.json();
          console.log('[GMB Reviews] OK:', url.split('googleapis.com')[1]);
          return data;
        }
        const errBody = await r.text().catch(() => '');
        console.log('[GMB Reviews] failed', r.status, url.split('googleapis.com')[1], errBody.slice(0, 120));
      } catch (e) {
        console.log('[GMB Reviews] exception:', url.split('googleapis.com')[1], e.message);
      }
    }
    return null;
  };

  const [reviewsRes, perfRes] = await Promise.all([
    fetchReviews().catch(() => null),
    (() => {
      const end = new Date(), start = new Date();
      start.setDate(start.getDate() - 90);
      return fetch(
        `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
        {
          method: 'POST', headers: hdrs,
          body: JSON.stringify({
            dailyMetrics: ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
                           'BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
                           'CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS'],
            dailyRange: {
              startDate: { year: start.getFullYear(), month: start.getMonth()+1, day: start.getDate() },
              endDate:   { year: end.getFullYear(),   month: end.getMonth()+1,   day: end.getDate() },
            },
          }),
        }
      ).then(r => r.ok ? r.json() : null).catch(() => null);
    })(),
  ]);

  const STARS = { ONE:1, TWO:2, THREE:3, FOUR:4, FIVE:5 };
  const reviews = (reviewsRes?.reviews || []).map(r => ({
    id: r.reviewId, reviewer: r.reviewer?.displayName || 'Anónimo',
    stars: STARS[r.starRating] || 0, comment: r.comment || '',
    date: r.createTime?.split('T')[0] || '', replied: !!r.reviewReply,
  }));

  const series   = perfRes?.multiDailyMetricTimeSeries || [];
  const metricMap = {};
  series.forEach(s => { metricMap[s.dailyMetric] = s.timeSeries?.datedValues || []; });

  const sumMetric = key => (metricMap[key] || []).slice(-30).reduce((a,v) => a+(parseInt(v.value)||0), 0);
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
   'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH','BUSINESS_IMPRESSIONS_MOBILE_SEARCH'].forEach(k => addMetric(k,'views'));
  ['CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS'].forEach(k => addMetric(k,'actions'));

  // averageRating can be a string ("4.5") or number depending on API version
  const avgRating = reviewsRes?.averageRating != null ? parseFloat(reviewsRes.averageRating) : null;
  const totalCount = reviewsRes?.totalReviewCount != null ? parseInt(reviewsRes.totalReviewCount) : (reviews.length || null);

  return {
    configured: true,
    rating:      isNaN(avgRating) ? null : avgRating,
    reviewCount: isNaN(totalCount) ? null : totalCount,
    reviews,
    reviewsApiError: reviewsRes === null
      ? `API de reseñas norespondió. Location: ${locSegment}. Verifica en Vercel logs.`
      : null,
    performance: {
      views:   { maps: mapsViews, search: searchViews, total: mapsViews+searchViews },
      actions: { calls, websiteClicks: webClicks, directions: dirs, total: calls+webClicks+dirs },
      daily:   Object.values(dailyIdx).sort((a,b) => a.date.localeCompare(b.date)),
    },
  };
}
