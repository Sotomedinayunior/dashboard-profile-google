/**
 * api/reviews.js
 *
 * GET /api/reviews
 *   → Resumen de TODAS las sucursales (página 1 cada una, paralelo)
 *
 * GET /api/reviews?place_id=ChIJ...
 *   → Reseñas completas de UNA sucursal (pagina hasta MAX_PAGES)
 *
 * Requiere: SERPAPI_KEY en Vercel env vars.
 */

const MAX_PAGES = 5;

// ── Sucursales Nelly RAC ──────────────────────────────────────────────────────
const LOCATIONS = [
  { id: 'independencia', name: 'Independencia',     emoji: '🏢', placeId: 'ChIJPRzgUXlipY4RTFpdm7Gtz2M' },
  { id: 'santiago',      name: 'Santiago · Cibao',  emoji: '✈️', placeId: 'ChIJBUNVazXRsY4R76jNG9B5mUQ' },
  { id: 'puertoplata',   name: 'Puerto Plata',       emoji: '🌊', placeId: 'ChIJNSahrlDksY4RdDGaHelddiY' },
  { id: 'puntacana',     name: 'Punta Cana',         emoji: '🌴', placeId: 'ChIJPZ6a5d6TqI4R5-DvEC5384M' },
  { id: 'bocachica',     name: 'Boca Chica',         emoji: '🏖️', placeId: 'ChIJIfF1mPt_pY4RDB9kOOVbvz0' },
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=1800'); // 30 min cache

  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const apiKey  = process.env.SERPAPI_KEY;
  if (!apiKey)  return res.status(500).json({ error: 'SERPAPI_KEY no configurada en Vercel' });

  const placeId = req.query.place_id;

  try {
    // ── Modo: una sucursal específica (todas las páginas) ─────────────────────
    if (placeId) {
      const loc = LOCATIONS.find(l => l.placeId === placeId)
        || { id: 'custom', name: 'Sucursal', emoji: '📍', placeId };

      const reviews = await fetchAllPages(placeId, apiKey, MAX_PAGES);
      return res.status(200).json({
        ok: true,
        mode: 'single',
        location: loc,
        ...buildStats(reviews),
      });
    }

    // ── Modo: resumen de todas las sucursales (solo página 1 c/u) ─────────────
    const results = await Promise.all(
      LOCATIONS.map(async loc => {
        try {
          const reviews = await fetchAllPages(loc.placeId, apiKey, 1); // 1 page only
          return { ...loc, ...buildStats(reviews), ok: true };
        } catch (err) {
          return { ...loc, ok: false, error: err.message, reviews: [], total: 0, avgRating: null };
        }
      })
    );

    // Global aggregate
    const allReviews = results.flatMap(l => (l.reviews || []).map(r => ({ ...r, _locationId: l.id, _locationName: l.name })));
    const global = buildStats(allReviews);

    return res.status(200).json({
      ok: true,
      mode: 'all',
      global,
      locations: results,
    });

  } catch (err) {
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
      engine:    'google_maps_reviews',
      place_id:  placeId,
      api_key:   apiKey,
      hl:        'es',
      sort_by:   'newestFirst',
    });
    if (nextPageToken) {
      params.set('next_page_token', nextPageToken);
      params.set('num', '20');
    }

    const r = await fetch(`https://serpapi.com/search.json?${params}`);
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
  const total    = reviews.length;
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
    total,
    avgRating,
    replyRate:    total ? Math.round(replied / total * 100) : 0,
    repliedCount: replied,
    negative,
    positive,
    neutral,
    distribution: dist,
    reviews,
  };
}
