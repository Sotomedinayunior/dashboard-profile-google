/**
 * api/gmb-data.js
 * GET /api/gmb-data
 *
 * Fetches business profile info for all Nelly RAC locations
 * using SerpAPI google_maps engine (no GMB API approval needed).
 *
 * Calls are serialized with a 300ms stagger to avoid SerpAPI 429.
 * Requires: SERPAPI_KEY
 */

const LOCATIONS = [
  { id: 'independencia', name: 'Independencia',    placeId: 'ChIJPRzgUXlipY4RTFpdm7Gtz2M' },
  { id: 'santiago',      name: 'Santiago · Cibao', placeId: 'ChIJBUNVazXRsY4R76jNG9B5mUQ' },
  { id: 'puertoplata',   name: 'Puerto Plata',      placeId: 'ChIJNSahrlDksY4RdDGaHelddiY' },
  { id: 'puntacana',     name: 'Punta Cana',        placeId: 'ChIJPZ6a5d6TqI4R5-DvEC5384M' },
  { id: 'bocachica',     name: 'Las Americas',      placeId: 'ChIJIfF1mPt_pY4RDB9kOOVbvz0' },
];

const CALL_TIMEOUT = 8000; // per-request timeout

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SERPAPI_KEY no configurada' });

  try {
    // Parallel: all 5 at once — ~3s total vs 15s+ sequential (which causes timeout)
    const results = await Promise.all(LOCATIONS.map(loc => fetchPlaceData(loc, apiKey)));

    const allOk = results.every(r => r.ok);
    // Cache 1 hour when successful; never cache errors
    res.setHeader('Cache-Control', allOk
      ? 's-maxage=3600, stale-while-revalidate=600'
      : 'no-store'
    );

    return res.status(200).json({
      ok: true,
      locations: results,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: err.message });
  }
};

async function fetchPlaceData(loc, apiKey) {
  try {
    const params = new URLSearchParams({
      engine:   'google_maps',
      place_id: loc.placeId,
      api_key:  apiKey,
      hl:       'es',
    });

    const r = await fetch(`https://serpapi.com/search.json?${params}`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT),
    });

    if (r.status === 429) {
      throw new Error('429: Cuota de SerpAPI agotada. Ve a serpapi.com para verificar tu plan.');
    }
    if (!r.ok) throw new Error(`SerpAPI ${r.status}`);

    const data = await r.json();
    const p = data.place_results || data.local_results?.[0] || {};

    const today    = new Date().toLocaleDateString('es-DO', { weekday: 'long' }).toLowerCase();
    const hoursArr = p.hours?.schedule || [];
    const todayHrs = hoursArr.find(h => (h.day || '').toLowerCase().includes(today.slice(0, 3)));

    return {
      id:           loc.id,
      name:         p.title || loc.name,
      placeId:      loc.placeId,
      rating:       p.rating || null,
      reviewsCount: p.reviews || p.reviews_original || null,
      address:      p.address || null,
      phone:        p.phone || null,
      website:      p.website || null,
      thumbnail:    p.thumbnail || null,
      photosCount:  p.photos_count || p.media_count || null,
      todayHours:   todayHrs?.hours || (p.open_state || null),
      isOpenNow:    p.hours?.currently_open ?? null,
      category:     p.type || 'Alquiler de automóviles',
      mapsUrl:      `https://www.google.com/maps/place/?q=place_id:${loc.placeId}`,
      gmbUrl:       'https://business.google.com/reviews',
      ok: true,
    };
  } catch (err) {
    return { ...loc, ok: false, error: err.message };
  }
}
