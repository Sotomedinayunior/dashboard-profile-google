/**
 * api/serp.js
 * GET /api/serp?keywords=rent+a+car+santo+domingo,nelly+rac&gl=do&hl=es
 *
 * Checks real Google SERP positions for given keywords via SerpAPI.
 * Also returns top 10 competitors per keyword.
 * Uses SERPAPI_KEY env var.
 */

const DOMAIN = 'nellyrac.do';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  // Never cache errors; cache successful results 1 hour
  res.setHeader('Cache-Control', 'no-store');

  const apiKey   = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SERPAPI_KEY no configurada en Vercel. Agrega SERPAPI_KEY en Settings → Environment Variables.' });

  // Keywords: from query param or use defaults from top GSC queries
  const kwParam = req.query.keywords;
  const gl      = req.query.gl  || 'do';
  const hl      = req.query.hl  || 'es';

  const keywords = kwParam
    ? kwParam.split(',').map(k => k.trim()).filter(Boolean).slice(0, 10)
    : [
        'rent a car santo domingo',
        'alquiler de carros santo domingo',
        'nelly rent a car',
        'rent a car republica dominicana',
        'alquiler de autos dominicana',
      ];

  try {
    const results = await Promise.all(keywords.map(kw => checkKeyword(kw, gl, hl, apiKey)));
    const found   = results.filter(r => r.position !== null).length;

    // Check if all failed with 429
    const all429 = results.every(r => r.error?.includes('429'));
    if (all429) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).json({ ok: false, error: 'Cuota de SerpAPI agotada (429). Verifica tu plan en serpapi.com o espera al próximo ciclo mensual.' });
    }

    // Cache only if at least some succeeded
    if (found > 0 || results.some(r => !r.error)) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    }

    return res.status(200).json({
      ok: true,
      domain: DOMAIN,
      keywords: results,
      summary: {
        total:     results.length,
        ranking:   found,
        notFound:  results.length - found,
        avgPos:    found ? +(results.filter(r => r.position).reduce((s,r) => s + r.position, 0) / found).toFixed(1) : null,
        top3:      results.filter(r => r.position && r.position <= 3).length,
        top10:     results.filter(r => r.position && r.position <= 10).length,
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

async function checkKeyword(keyword, gl, hl, apiKey) {
  const params = new URLSearchParams({
    engine:  'google',
    q:       keyword,
    gl,
    hl,
    num:     '20',
    api_key: apiKey,
  });

  try {
    const r = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 429) throw new Error('429 — Cuota SerpAPI agotada');
    if (!r.ok) {
      const errData = await r.json().catch(() => ({}));
      throw new Error(errData.error || `SerpAPI ${r.status}`);
    }
    const data = await r.json();

    const organic = data.organic_results || [];

    // Find our domain position
    let position = null;
    let ourResult = null;
    organic.forEach((res, i) => {
      if (!ourResult && res.link && res.link.includes(DOMAIN)) {
        position = res.position || (i + 1);
        ourResult = { url: res.link, title: res.title, snippet: res.snippet };
      }
    });

    // Top 5 competitors (excluding our domain)
    const competitors = organic
      .filter(r => r.link && !r.link.includes(DOMAIN))
      .slice(0, 5)
      .map(r => ({
        position: r.position,
        domain:   extractDomain(r.link),
        title:    r.title,
        url:      r.link,
      }));

    return {
      keyword,
      position,
      url:         ourResult?.url || null,
      title:       ourResult?.title || null,
      competitors,
      totalResults: data.search_information?.total_results || null,
    };

  } catch (err) {
    return { keyword, position: null, url: null, title: null, competitors: [], error: err.message };
  }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}
