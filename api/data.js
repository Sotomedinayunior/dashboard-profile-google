/**
 * api/data.js — Vercel Serverless Function
 * Fetches Google Search Console + Google My Business data.
 * Works for any site — configure via SITE_URL / GSC_PROPERTY env vars.
 *
 * GET /api/data
 */

const { google } = require('googleapis');

// Resolve the active site URL from env vars
const ACTIVE_SITE = process.env.GSC_PROPERTY || process.env.SITE_URL || '';

// ── Fallback (when API is not configured) ────────────────────────────────────
// Uses generic placeholder data — replaced by real data once tokens are set
const FALLBACK_GSC = {
  meta: { updated_at: '—', date_start: '—', date_end: '—', source: 'fallback' },
  summary_6m: { total_clicks: 0, total_impressions: 0, avg_ctr: 0, avg_position: 0, avg_clicks_per_day: 0, days: 0 },
  summary_28d: { total_clicks: 0, total_impressions: 0, avg_ctr: 0, avg_position: 0 },
  summary_7d:  { total_clicks: 0, total_impressions: 0, avg_ctr: 0, avg_position: 0 },
  chart: [],
  queries: [],
  pages: [],
  countries: [
    { country: 'United States',      clicks: 2993, impressions: 238839, ctr: 1.25, position: 6.51 },
    { country: 'Dominican Republic', clicks: 2589, impressions: 109024, ctr: 2.37, position: 5.85 },
    { country: 'Spain',              clicks: 624,  impressions: 27140,  ctr: 2.30, position: 6.36 },
    { country: 'Italy',              clicks: 187,  impressions: 7246,   ctr: 2.58, position: 4.61 },
    { country: 'France',             clicks: 176,  impressions: 12797,  ctr: 1.38, position: 11.43 },
  ],
  devices: [],
};

const FALLBACK_GMB = {
  configured: false,
  rating: null,
  reviewCount: null,
  reviews: [],
  performance: {
    views: { maps: null, search: null, total: null },
    actions: { calls: null, websiteClicks: null, directions: null, total: null },
    daily: [],
  },
};

// ── Build OAuth2 client ───────────────────────────────────────────────────────
function buildAuth() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) return null;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ── Fetch GSC data ────────────────────────────────────────────────────────────
async function fetchGSC(auth) {
  const sc = google.searchconsole({ version: 'v1', auth });
  const property = process.env.GSC_PROPERTY || process.env.SITE_URL || '';

  const dateEnd    = daysAgo(2);   // GSC lags ~2 days
  const start6M    = daysAgo(182);
  const start28D   = daysAgo(28);
  const start7D    = daysAgo(7);

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

  // ── Compute summaries ────────────────────────────────────────────────
  const sum = (rows) => {
    const tot_c = rows.reduce((a, r) => a + r.clicks, 0);
    const tot_i = rows.reduce((a, r) => a + r.impressions, 0);
    const avg_ctr = tot_i ? +((tot_c / tot_i) * 100).toFixed(2) : 0;
    const avg_pos = tot_i
      ? +(rows.reduce((a, r) => a + r.position * r.impressions, 0) / tot_i).toFixed(1)
      : 0;
    return { total_clicks: tot_c, total_impressions: tot_i, avg_ctr, avg_position: avg_pos };
  };

  const s6m  = sum(daily);
  const s28d = sum(d28);
  const s7d  = sum(d7);

  const fmt = (rows, keys) => rows.map(r => {
    const obj = {};
    keys.forEach((k, i) => { obj[k] = r.keys[i]; });
    return {
      ...obj,
      clicks:      r.clicks,
      impressions: r.impressions,
      ctr:         +( r.ctr * 100).toFixed(2),
      position:    +(r.position).toFixed(2),
    };
  });

  return {
    meta: {
      updated_at:   new Date().toISOString().split('T')[0],
      date_start:   start6M,
      date_end:     dateEnd,
      gsc_property: property,
      site_name:    process.env.SITE_NAME || '',
      site_url:     process.env.SITE_URL  || property,
      source:       'live',
    },
    summary_6m: {
      ...s6m,
      avg_clicks_per_day: daily.length ? +(s6m.total_clicks / daily.length).toFixed(1) : 0,
      days: daily.length,
    },
    summary_28d: s28d,
    summary_7d:  s7d,
    chart:     fmt(daily,    ['date']),
    queries:   fmt(queries,  ['query']),
    pages:     fmt(pages,    ['page']),
    countries: fmt(countries,['country']),
    devices:   fmt(devices,  ['device']),
  };
}

// ── Fetch GMB data ────────────────────────────────────────────────────────────
async function fetchGMB(auth) {
  const locationName = process.env.GMB_LOCATION_NAME;
  if (!locationName) return { ...FALLBACK_GMB, error: 'GMB_LOCATION_NAME not set' };

  // Get fresh access token
  const tokenRes  = await auth.getAccessToken();
  const token     = tokenRes.token;
  const hdrs      = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Extract IDs from location name (accounts/{acct}/locations/{loc})
  const parts     = locationName.split('/');
  const locationId = parts[3] || parts[1]; // handles both full and short form

  // ── Parallel fetch: reviews + performance ────────────────────────────
  const [reviewsRes, perfRes] = await Promise.all([
    // Reviews (My Business API v4)
    fetch(`https://mybusiness.googleapis.com/v4/${locationName}/reviews?pageSize=10`, { headers: hdrs })
      .then(r => r.ok ? r.json() : null).catch(() => null),

    // Performance metrics (Business Profile Performance API)
    (() => {
      const end   = new Date();
      const start = new Date(); start.setDate(start.getDate() - 90);
      return fetch(
        `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
        {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({
            dailyMetrics: [
              'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
              'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
              'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
              'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
              'CALL_CLICKS',
              'WEBSITE_CLICKS',
              'BUSINESS_DIRECTION_REQUESTS',
            ],
            dailyRange: {
              startDate: { year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() },
              endDate:   { year: end.getFullYear(),   month: end.getMonth() + 1,   day: end.getDate() },
            },
          }),
        }
      ).then(r => r.ok ? r.json() : null).catch(() => null);
    })(),
  ]);

  // ── Parse reviews ─────────────────────────────────────────────────────
  const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  const rawReviews = reviewsRes?.reviews || [];
  const reviews = rawReviews.map(r => ({
    id:          r.reviewId,
    reviewer:    r.reviewer?.displayName || 'Anónimo',
    isAnonymous: r.reviewer?.isAnonymous || false,
    stars:       STARS[r.starRating] || 0,
    comment:     r.comment || '',
    date:        r.createTime ? r.createTime.split('T')[0] : '',
    replied:     !!r.reviewReply,
    replyText:   r.reviewReply?.comment || '',
  }));

  // ── Parse performance metrics ─────────────────────────────────────────
  const series = perfRes?.multiDailyMetricTimeSeries || [];
  const metricMap = {};
  series.forEach(s => {
    metricMap[s.dailyMetric] = s.timeSeries?.datedValues || [];
  });

  // Aggregate totals (last 30 days from the series)
  const sumMetric = (key) => (metricMap[key] || [])
    .slice(-30)
    .reduce((a, v) => a + (parseInt(v.value) || 0), 0);

  const mapsViews   = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_MAPS')
                    + sumMetric('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const searchViews = sumMetric('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH')
                    + sumMetric('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  const calls       = sumMetric('CALL_CLICKS');
  const webClicks   = sumMetric('WEBSITE_CLICKS');
  const directions  = sumMetric('BUSINESS_DIRECTION_REQUESTS');

  // Build daily array (merged across metrics)
  const dailyIndex = {};
  const buildDaily = (key, field) => {
    (metricMap[key] || []).forEach(v => {
      const d = `${v.date.year}-${String(v.date.month).padStart(2,'0')}-${String(v.date.day).padStart(2,'0')}`;
      if (!dailyIndex[d]) dailyIndex[d] = { date: d, views: 0, actions: 0 };
      dailyIndex[d][field] = (dailyIndex[d][field] || 0) + (parseInt(v.value) || 0);
    });
  };
  ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_MOBILE_MAPS',
   'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH','BUSINESS_IMPRESSIONS_MOBILE_SEARCH'].forEach(k => buildDaily(k,'views'));
  ['CALL_CLICKS','WEBSITE_CLICKS','BUSINESS_DIRECTION_REQUESTS'].forEach(k => buildDaily(k,'actions'));
  const daily = Object.values(dailyIndex).sort((a,b) => a.date.localeCompare(b.date));

  return {
    configured:  true,
    rating:      reviewsRes?.averageRating ?? null,
    reviewCount: reviewsRes?.totalReviewCount ?? null,
    reviews,
    performance: {
      views:   { maps: mapsViews, search: searchViews, total: mapsViews + searchViews },
      actions: { calls, websiteClicks: webClicks, directions, total: calls + webClicks + directions },
      daily,
    },
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const auth = buildAuth();

  if (!auth) {
    // No credentials — return fallback data with GMB stub
    return res.status(200).json({ ...FALLBACK_GSC, gmb: FALLBACK_GMB });
  }

  // Fetch GSC and GMB in parallel
  const [gsc, gmb] = await Promise.allSettled([
    fetchGSC(auth),
    fetchGMB(auth),
  ]);

  const gscData = gsc.status === 'fulfilled' ? gsc.value : FALLBACK_GSC;
  const gmbData = gmb.status === 'fulfilled' ? gmb.value : { ...FALLBACK_GMB, error: gmb.reason?.message };

  return res.status(200).json({ ...gscData, gmb: gmbData });
};
