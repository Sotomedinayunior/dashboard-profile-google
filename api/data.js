/**
 * api/data.js
 * POST /api/data
 * Body: { refreshToken, gscProperty, gmbLocation? }
 *
 * Fetches GSC + GMB data using the provided refresh token.
 * Only GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are needed as env vars.
 */
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no configurados en Vercel' });
  }

  const { refreshToken, gscProperty, gmbLocation } = req.body || {};

  if (!refreshToken) return res.status(400).json({ error: 'refreshToken requerido' });
  if (!gscProperty)  return res.status(400).json({ error: 'gscProperty requerido' });

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: refreshToken });

  const [gsc, gmb] = await Promise.allSettled([
    fetchGSC(auth, gscProperty),
    gmbLocation ? fetchGMB(auth, gmbLocation) : Promise.resolve(EMPTY_GMB),
  ]);

  const gscData = gsc.status === 'fulfilled' ? gsc.value : { error: gsc.reason?.message };
  const gmbData = gmb.status === 'fulfilled' ? gmb.value : { ...EMPTY_GMB, error: gmb.reason?.message };

  return res.status(200).json({ ...gscData, gmb: gmbData });
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

  // Try new Reviews API first (mybusinessreviews.googleapis.com/v1), fallback to v4
  const fetchReviews = async () => {
    // New API (post-2022)
    const r1 = await fetch(
      `https://mybusinessreviews.googleapis.com/v1/${locationName}/reviews?pageSize=50`,
      { headers: hdrs }
    );
    if (r1.ok) return r1.json();
    // Fallback: old v4 API
    const r2 = await fetch(
      `https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=50`,
      { headers: hdrs }
    );
    if (r2.ok) return r2.json();
    // Return error details for debugging
    const errText = await r1.text().catch(() => r1.status);
    console.error('Reviews API error:', r1.status, errText);
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
    reviewsApiError: reviewsRes === null ? 'No se pudo obtener reseñas de la API' : null,
    performance: {
      views:   { maps: mapsViews, search: searchViews, total: mapsViews+searchViews },
      actions: { calls, websiteClicks: webClicks, directions: dirs, total: calls+webClicks+dirs },
      daily:   Object.values(dailyIdx).sort((a,b) => a.date.localeCompare(b.date)),
    },
  };
}
