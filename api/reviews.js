/**
 * api/reviews.js
 *
 * GET /api/reviews
 *   → Resumen de TODAS las sucursales en paralelo (~3s, dentro del límite de Vercel)
 *
 * GET /api/reviews?place_id=ChIJ...
 *   → Reseñas de UNA sucursal (hasta MAX_PAGES páginas)
 *
 * Por qué paralelo y no secuencial:
 *   - Vercel Hobby tiene timeout de 10s
 *   - 5 sucursales × ~3s cada una = 15s secuencial → timeout garantizado
 *   - Paralelo: todas arrancan a la vez → ~3s total → dentro del límite
 *   - Si alguna recibe 429, esa sucursal devuelve error individual, las demás siguen
 *   - Respuesta exitosa se cachea 1 hora → visitas siguientes usan 0 créditos SerpAPI
 *
 * Requiere: SERPAPI_KEY en Vercel env vars.
 */

const MAX_PAGES     = 2;    // single-location: hasta 2 páginas
const MAX_PAGES_ALL = 1;    // all-locations overview: 1 página por sucursal
const CALL_TIMEOUT  = 8000; // 8s por llamada individual a SerpAPI

// ── Sucursales Nelly RAC ──────────────────────────────────────────────────────
const LOCATIONS = [
  { id: 'independencia', name: 'Independencia',    placeId: 'ChIJPRzgUXlipY4RTFpdm7Gtz2M' },
  { id: 'santiago',      name: 'Santiago · Cibao', placeId: 'ChIJBUNVazXRsY4R76jNG9B5mUQ' },
  { id: 'puertoplata',   name: 'Puerto Plata',      placeId: 'ChIJNSahrlDksY4RdDGaHelddiY' },
  { id: 'puntacana',     name: 'Punta Cana',        placeId: 'ChIJPZ6a5d6TqI4R5-DvEC5384M' },
  { id: 'bocachica',     name: 'Las Americas',      placeId: 'ChIJIfF1mPt_pY4RDB9kOOVbvz0' },
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SERPAPI_KEY no configurada en Vercel' });

  const placeId = req.query.place_id;

  try {
    // ── Modo: una sucursal específica ─────────────────────────────────────────
    if (placeId) {
      const loc = LOCATIONS.find(l => l.placeId === placeId)
        || { id: 'custom', name: 'Sucursal', placeId };

      const reviews = await fetchAllPages(placeId, apiKey, MAX_PAGES);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
      return res.status(200).json({
        ok: true,
        mode: 'single',
        location: loc,
        ...buildStats(reviews),
      });
    }

    // ── Modo: todas las sucursales en PARALELO ────────────────────────────────
    // Cada sucursal falla independientemente — un 429 no rompe todas las demás
    const results = await Promise.all(
      LOCATIONS.map(async loc => {
        try {
          const reviews = await fetchAllPages(loc.placeId, apiKey, MAX_PAGES_ALL);
          return { ...loc, ...buildStats(reviews), ok: true };
        } catch (err) {
          // 429 u otro error: devolver datos vacíos para esta sucursal
          const is429 = err.message.includes('429');
          return {
            ...loc,
            ok: false,
            error: is429
              ? 'Limite de SerpAPI (429) — verifica tu cuota en serpapi.com'
              : err.message,
            reviews: [], total: 0, avgRating: null,
          };
        }
      })
    );

    const okCount    = results.filter(r => r.ok).length;
    const allReviews = results.flatMap(l =>
      (l.reviews || []).map(r => ({ ...r, _locationId: l.id, _locationName: l.name }))
    );
    const global = buildStats(allReviews);

    // Solo cachear si al menos una sucursal respondió bien
    if (okCount > 0) {
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }

    return res.status(200).json({
      ok: okCount > 0,
      mode: 'all',
      global,
      locations: results,
      // Info para debugging
      _meta: { ok: okCount, failed: results.length - okCount, total: results.length },
    });

  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    console.error('[Reviews]', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Fetch paginated reviews for one place ─────────────────────────────────────
async function fetchAllPages(placeId, apiKey, maxPages) {
  const all = [];
  let nextPageToken = null;
  let page = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      engine:   'google_maps_reviews',
      place_id:  placeId,
      api_key:   apiKey,
      hl:        'es',
      sort_by:   'newestFirst',
    });
    if (nextPageToken) {
      params.set('next_page_token', nextPageToken);
      params.set('num', '20');
    }

    const r = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });

    if (r.status === 429) {
      throw new Error('429: Cuota de SerpAPI agotada. Ve a serpapi.com para verificar tu plan.');
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `SerpAPI ${r.status}`);
    }

    const data = await r.json();

    (data.reviews || []).forEach(rev => {
      all.push({
        id:       rev.review_id || String(all.length),
        reviewer: rev.user?.name || 'Anónimo',
        avatar:   rev.user?.thumbnail || null,
        stars:    rev.rating || 0,
        comment:  rev.snippet || rev.extracted_snippet?.original || '',
        date:     rev.date || '',
        iso_date: rev.iso_date || '',
        replied:  !!rev.response,
        reply:    rev.response?.snippet || null,
        likes:    rev.likes || 0,
        link:     rev.link || null,
      });
    });

    nextPageToken = data.serpapi_pagination?.next_page_token || null;
    page++;
    if (!nextPageToken || (data.reviews || []).length === 0) break;
  }

  return all;
}

// ── Build stats from a reviews array ──────────────────────────────────────────
function buildStats(reviews) {
  const total     = reviews.length;
  const avgRating = total
    ? +(reviews.reduce((s, r) => s + r.stars, 0) / total).toFixed(1)
    : null;
  const replied  = reviews.filter(r => r.replied).length;
  const negative = reviews.filter(r => r.stars <= 2).length;
  const positive = reviews.filter(r => r.stars >= 4).length;
  const neutral  = reviews.filter(r => r.stars === 3).length;

  const dist = {};
  [1, 2, 3, 4, 5].forEach(s => {
    dist[s] = reviews.filter(r => r.stars === s).length;
  });

  return {
    total, avgRating,
    replyRate:    total ? Math.round(replied / total * 100) : 0,
    repliedCount: replied,
    negative, positive, neutral,
    distribution: dist,
    reviews,
  };
}
