/**
 * api/pagespeed.js
 * GET /api/pagespeed?strategy=mobile|desktop
 *
 * Fetches pages from the site sitemap dynamically, then runs
 * Google PageSpeed Insights on each public page.
 */

// Pages to skip — private/dynamic flows that don't make sense to test
const SKIP_PATHS = new Set([
  '/my-profile/', '/my-rentals/', '/my-reservations/',
  '/success-reservation/', '/select-vehicle/', '/landing-pages/',
  '/cart/', '/checkout/', '/wp-admin/', '/wp-login.php',
]);

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

  // ── Fetch pages from sitemap ────────────────────────────────────────────────
  const siteBase = (process.env.GSC_PROPERTY || '').replace(/\/$/, '');
  const pages    = await fetchSitemapPages(siteBase);

  if (!pages.length) {
    return res.status(500).json({ ok: false, error: 'No se pudieron obtener páginas del sitemap' });
  }

  // ── Run PageSpeed on all pages in parallel ──────────────────────────────────
  let results = await Promise.all(pages.map(url => checkPage(url, strategy, apiKey)));

  // Retry pages that timed out once
  const retryIdx = results.map((r, i) => r.error === 'Timeout' ? i : -1).filter(i => i >= 0);
  if (retryIdx.length > 0) {
    const retried = await Promise.all(retryIdx.map(i => checkPage(pages[i], strategy, apiKey)));
    retryIdx.forEach((origIdx, ri) => { results[origIdx] = retried[ri]; });
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

// ── Fetch & parse sitemap pages ───────────────────────────────────────────────
async function fetchSitemapPages(siteBase) {
  const candidates = siteBase
    ? [
        `${siteBase}/page-sitemap.xml`,
        `${siteBase}/sitemap.xml`,
        `${siteBase}/wp-sitemap.xml`,
      ]
    : [];

  for (const sitemapUrl of candidates) {
    try {
      const r = await fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const xml = await r.text();

      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
      if (!locs.length) continue;

      // If sitemapindex — follow child sitemaps
      if (xml.includes('<sitemapindex')) {
        const childUrls = [];
        for (const childSitemap of locs.slice(0, 15)) {
          try {
            const cr = await fetch(childSitemap, { signal: AbortSignal.timeout(6000) });
            if (!cr.ok) continue;
            const cxml = await cr.text();
            const clocs = [...cxml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
            childUrls.push(...clocs);
          } catch {}
        }
        return filterPages(childUrls);
      }

      return filterPages(locs);
    } catch {}
  }
  return [];
}

// ── Filter out private/dynamic pages ─────────────────────────────────────────
function filterPages(urls) {
  return urls.filter(url => {
    try {
      const path = new URL(url).pathname;
      // Skip exact matches and sub-paths of skipped routes
      for (const skip of SKIP_PATHS) {
        if (path === skip || path.startsWith(skip)) return false;
      }
      return true;
    } catch {
      return false;
    }
  });
}

// ── PageSpeed check ───────────────────────────────────────────────────────────
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
