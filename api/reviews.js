/**
 * api/reviews.js
 *
 * GET /api/reviews
 * → Resumen de TODAS las sucursales (1 página c/u en paralelo, ~4s)
 *
 * GET /api/reviews?place_id=ChIJ...
 * → Reseñas de UNA sucursal (hasta MAX_PAGES páginas)
 *
 * Requiere: SERPAPI_KEY en Vercel env vars.
 */

const MAX_PAGES     = 5;  // single-location: hasta 5 páginas × ~20 reviews = ~100 reviews
const MAX_PAGES_ALL = 3;  // all-locations:   hasta 3 páginas × 5 sucursales en paralelo
const CALL_TIMEOUT  = 8000; // 8s per SerpAPI call

// Sucursales Nelly RAC 
const LOCATIONS = [
  { id: 'independencia', name: 'Independencia', placeId: 'ChIJPRzgUXlipY4RTFpdm7Gtz2M' },
  { id: 'santiago', name: 'Santiago · Cibao', placeId: 'ChIJBUNVazXRsY4R76jNG9B5mUQ' },
  { id: 'puertoplata', name: 'Puerto Plata', placeId: 'ChIJNSahrlDksY4RdDGaHelddiY' },
  { id: 'puntacana', name: 'Punta Cana', placeId: 'ChIJPZ6a5d6TqI4R5-DvEC5384M' },
  { id: 'bocachica', name: 'Las Americas', placeId: 'ChIJIfF1mPt_pY4RDB9kOOVbvz0' },
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SERPAPI_KEY no configurada en Vercel' });

  const placeId = req.query.place_id;

  try {
  // Modo: una sucursal específica 
  if (placeId) {
  const loc = LOCATIONS.find(l => l.placeId === placeId)
  || { id: 'custom', name: 'Sucursal', placeId };

  const reviews = await fetchAllPages(placeId, apiKey, MAX_PAGES);
  // Cache successful single-location responses for 15 min
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
  return res.status(200).json({
  ok: true,
  mode: 'single',
  location: loc,
  ...buildStats(reviews),
  });
  }

  // Modo: resumen de todas las sucursales (1 página c/u en paralelo) 
  const results = await Promise.all(
  LOCATIONS.map(async loc => {
  try {
  const reviews = await fetchAllPages(loc.placeId, apiKey, MAX_PAGES_ALL);
  return { ...loc, ...buildStats(reviews), ok: true };
  } catch (err) {
  return { ...loc, ok: false, error: err.message, reviews: [], total: 0, avgRating: null };
  }
  })
  );

  // Global aggregate
  const allReviews = results.flatMap(l =>
  (l.reviews || []).map(r => ({ ...r, _locationId: l.id, _locationName: l.name }))
  );
  const global = buildStats(allReviews);

  // Cache successful all-locations response for 30 min
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=600');
  return res.status(200).json({
  ok: true,
  mode: 'all',
  global,
  locations: results,
  });

  } catch (err) {
  // Never cache errors
  res.setHeader('Cache-Control', 'no-store');
  console.error('[Reviews]', err.message);
  return res.status(500).json({ error: err.message });
  }
};

// Fetch paginated reviews for one place 
async function fetchAllPages(placeId, apiKey, maxPages) {
  const all = [];
  let nextPageToken = null;
  let page = 0;

  while (page < maxPages) {
  const params = new URLSearchParams({
  engine: 'google_maps_reviews',
  place_id: placeId,
  api_key: apiKey,
  hl: 'es',
  sort_by: 'newestFirst',
  num: '20',   // pedir 20 reviews por página (primera y siguientes)
  });
  if (nextPageToken) {
  params.set('next_page_token', nextPageToken);
  }

  const r = await fetch(`https://serpapi.com/search.json?${params}`, {
  signal: AbortSignal.timeout(CALL_TIMEOUT),
  });

  if (!r.ok) {
  const err = await r.json().catch(() => ({}));
  throw new Error(err.error || `SerpAPI ${r.status}`);
  }
  const data = await r.json();

  (data.reviews || []).forEach(rev => {
  all.push({
  id: rev.review_id || String(all.length),
  reviewer: rev.user?.name || 'Anónimo',
  avatar: rev.user?.thumbnail || null,
  stars: rev.rating || 0,
  comment: rev.snippet || rev.extracted_snippet?.original || '',
  date: rev.date || '',
  iso_date: rev.iso_date || '',
  replied: !!rev.response,
  reply: rev.response?.snippet || null,
  likes: rev.likes || 0,
  link: rev.link || null,           // URL directa a la reseña en Google Maps
  });
  });

  nextPageToken = data.serpapi_pagination?.next_page_token || null;
  page++;
  if (!nextPageToken || (data.reviews || []).length === 0) break;
  }

  return all;
}

// Build stats from a reviews array 
function buildStats(reviews) {
  const total = reviews.length;
  const avgRating = total
  ? +(reviews.reduce((s, r) => s + r.stars, 0) / total).toFixed(1)
  : null;
  const replied = reviews.filter(r => r.replied).length;
  const negative = reviews.filter(r => r.stars <= 2).length;
  const positive = reviews.filter(r => r.stars >= 4).length;
  const neutral = reviews.filter(r => r.stars === 3).length;

  const dist = {};
  [1, 2, 3, 4, 5].forEach(s => {
  dist[s] = reviews.filter(r => r.stars === s).length;
  });

  return {
  total,
  avgRating,
  replyRate: total ? Math.round(replied / total * 100) : 0,
  repliedCount: replied,
  negative,
  positive,
  neutral,
  distribution: dist,
  reviews,
  };
}
