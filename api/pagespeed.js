/**
 * api/pagespeed.js
 * GET /api/pagespeed?strategy=mobile|desktop
 *
 * Runs Google PageSpeed Insights on all sitemap pages.
 * No API key required (uses public endpoint, rate limited to 25k/day).
 */

const SITEMAPS = [
  'https://nellyrac.do/page-sitemap.xml',
  'https://nellyrac.do/post-sitemap.xml',
];
const CONCURRENCY = 2;   // lower = safer within Vercel timeout
const TIMEOUT_MS  = 15000; // 15s per page
const MAX_URLS    = 15;  // cap at 15 URLs to stay within 60s limit

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=3600');

  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';

  try {
    let urls = await getAllUrls();
    if (!urls.length) return res.status(200).json({ ok: false, error: 'No URLs found in sitemaps' });
    // Cap to avoid Vercel timeout
    if (urls.length > MAX_URLS) urls = urls.slice(0, MAX_URLS);

    const results = await checkBatch(urls, strategy, CONCURRENCY);

    const summary = {
      total:   results.length,
      good:    results.filter(r => r.score >= 90).length,
      needsWork: results.filter(r => r.score >= 50 && r.score < 90).length,
      poor:    results.filter(r => r.score < 50 && r.score !== null).length,
      failed:  results.filter(r => r.score === null).length,
      avgScore: results.filter(r => r.score !== null).length
        ? Math.round(results.filter(r => r.score !== null).reduce((s, r) => s + r.score, 0) / results.filter(r => r.score !== null).length)
        : null,
    };

    results.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

    return res.status(200).json({ ok: true, strategy, summary, results, checkedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};

async function getAllUrls() {
  const all = [];
  for (const sitemapUrl of SITEMAPS) {
    try {
      const r = await fetchWithTimeout(sitemapUrl, 8000);
      if (!r.ok) continue;
      const xml = await r.text();
      const matches = [...xml.matchAll(/<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/g)];
      matches.forEach(m => { const u = m[1].trim(); if (!all.includes(u)) all.push(u); });
    } catch {}
  }
  return all;
}

async function checkBatch(urls, strategy, concurrency) {
  const results = [];
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const checked = await Promise.all(batch.map(u => checkPage(u, strategy)));
    results.push(...checked);
  }
  return results;
}

async function checkPage(url, strategy) {
  const key = process.env.PAGESPEED_API_KEY ? `&key=${process.env.PAGESPEED_API_KEY}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance${key}`;
  try {
    const r = await fetchWithTimeout(apiUrl, TIMEOUT_MS);
    if (!r.ok) return { url, score: null, error: `HTTP ${r.status}`, cwv: null };
    const data = await r.json();

    const cats  = data.lighthouseResult?.categories || {};
    const audits = data.lighthouseResult?.audits || {};

    const score = cats.performance?.score != null ? Math.round(cats.performance.score * 100) : null;

    const cwv = {
      fcp:  getMetric(audits, 'first-contentful-paint'),
      lcp:  getMetric(audits, 'largest-contentful-paint'),
      tbt:  getMetric(audits, 'total-blocking-time'),
      cls:  getMetric(audits, 'cumulative-layout-shift'),
      ttfb: getMetric(audits, 'server-response-time'),
      si:   getMetric(audits, 'speed-index'),
    };

    const opportunities = Object.values(audits)
      .filter(a => a.details?.type === 'opportunity' && a.score != null && a.score < 0.9)
      .map(a => ({ title: a.title, impact: a.score < 0.5 ? 'high' : 'medium' }))
      .slice(0, 5);

    return { url, score, cwv, opportunities, error: null };

  } catch (err) {
    return { url, score: null, error: 'Timeout o error de red', cwv: null, opportunities: [] };
  }
}

function getMetric(audits, key) {
  const a = audits[key];
  if (!a) return null;
  return {
    value:       a.numericValue != null ? +a.numericValue.toFixed(2) : null,
    displayValue: a.displayValue || null,
    score:       a.score != null ? Math.round(a.score * 100) : null,
  };
}

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(t));
}
