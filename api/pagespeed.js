/**
 * api/pagespeed.js
 * GET /api/pagespeed?strategy=mobile|desktop
 *
 * Runs Google PageSpeed Insights using PAGESPEED_API_KEY (required).
 * All pages run in parallel — completes in ~3-5s with a valid key.
 */

const KEY_PAGES = [
  'https://nellyrac.do/',
  'https://nellyrac.do/reserva/',
  'https://nellyrac.do/flota/',
  'https://nellyrac.do/contacto/',
  'https://nellyrac.do/sobre-nosotros/',
  'https://nellyrac.do/blog/',
];

const TIMEOUT_MS = 45000; // 45s — homepage can be slow on PageSpeed API

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'PAGESPEED_API_KEY no configurada en Vercel → Settings → Environment Variables',
    });
  }

  const strategy = req.query.strategy === 'desktop' ? 'desktop' : 'mobile';

  // Run all pages in parallel; retry pages that timeout once
  let results = await Promise.all(KEY_PAGES.map(url => checkPage(url, strategy, apiKey)));

  // Retry any that timed out (homepage / heavy pages sometimes need a second attempt)
  const retryIndices = results
    .map((r, i) => (r.error === 'Timeout' ? i : -1))
    .filter(i => i >= 0);

  if (retryIndices.length > 0) {
    const retried = await Promise.all(
      retryIndices.map(i => checkPage(KEY_PAGES[i], strategy, apiKey))
    );
    retryIndices.forEach((origIdx, ri) => { results[origIdx] = retried[ri]; });
  }

  results.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));

  const scored = results.filter(r => r.score !== null);
  const summary = {
    total:     results.length,
    good:      scored.filter(r => r.score >= 90).length,
    needsWork: scored.filter(r => r.score >= 50 && r.score < 90).length,
    poor:      scored.filter(r => r.score < 50).length,
    failed:    results.filter(r => r.score === null).length,
    avgScore:  scored.length
      ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length)
      : null,
  };

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=300');
  return res.status(200).json({
    ok: true, strategy, summary, results,
    checkedAt: new Date().toISOString(),
  });
};

async function checkPage(url, strategy, apiKey) {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&key=${apiKey}`;
  try {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r    = await fetch(apiUrl, { signal: ctrl.signal }).finally(() => clearTimeout(t));

    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return { url, score: null, error: body?.error?.message || `HTTP ${r.status}`, cwv: null, opportunities: [] };
    }

    const data   = await r.json();
    const cats   = data.lighthouseResult?.categories || {};
    const audits = data.lighthouseResult?.audits     || {};
    const score  = cats.performance?.score != null ? Math.round(cats.performance.score * 100) : null;

    const cwv = {
      fcp:  metric(audits, 'first-contentful-paint'),
      lcp:  metric(audits, 'largest-contentful-paint'),
      tbt:  metric(audits, 'total-blocking-time'),
      cls:  metric(audits, 'cumulative-layout-shift'),
      ttfb: metric(audits, 'server-response-time'),
      si:   metric(audits, 'speed-index'),
    };

    const opportunities = Object.values(audits)
      .filter(a => a.details?.type === 'opportunity' && a.score != null && a.score < 0.9)
      .map(a => ({ title: a.title, impact: a.score < 0.5 ? 'high' : 'medium' }))
      .slice(0, 5);

    return { url, score, cwv, opportunities, error: null };

  } catch (err) {
    return {
      url, score: null,
      error: err.name === 'AbortError' ? 'Timeout' : err.message,
      cwv: null, opportunities: [],
    };
  }
}

function metric(audits, key) {
  const a = audits[key];
  if (!a) return null;
  return {
    value:        a.numericValue != null ? +a.numericValue.toFixed(2) : null,
    displayValue: a.displayValue || null,
    score:        a.score != null ? Math.round(a.score * 100) : null,
  };
}
