/**
 * api/reviews.js
 * GET /api/reviews?place_id=ChIJ...
 *
 * Fetches ALL Google Maps reviews via SerpAPI (paginates up to 5 pages / ~100 reviews).
 * Requires SERPAPI_KEY environment variable in Vercel.
 */

const MAX_PAGES = 5;

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=1800'); // cache 30 min

  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const apiKey   = process.env.SERPAPI_KEY;
  const placeId  = req.query.place_id || process.env.SERPAPI_PLACE_ID;

  if (!apiKey)   return res.status(500).json({ error: 'SERPAPI_KEY no configurada en Vercel' });
  if (!placeId)  return res.status(400).json({ error: 'place_id requerido' });

  try {
    const allReviews = [];
    let nextPageToken = null;
    let page = 0;

    while (page < MAX_PAGES) {
      const params = new URLSearchParams({
        engine:       'google_maps_reviews',
        place_id:     placeId,
        api_key:      apiKey,
        hl:           'es',
        sort_by:      'newestFirst',
        num:          '20',
      });
      if (nextPageToken) params.set('next_page_token', nextPageToken);

      const r = await fetch(`https://serpapi.com/search.json?${params}`);
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `SerpAPI error ${r.status}`);
      }
      const data = await r.json();

      const reviews = data.reviews || [];
      reviews.forEach(rev => {
        allReviews.push({
          id:       rev.review_id || rev.link || String(allReviews.length),
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
      if (!nextPageToken || reviews.length === 0) break;
    }

    // Compute stats
    const total      = allReviews.length;
    const avgRating  = total
      ? +(allReviews.reduce((s, r) => s + r.stars, 0) / total).toFixed(1)
      : 0;
    const replied    = allReviews.filter(r => r.replied).length;
    const dist       = [1, 2, 3, 4, 5].map(s => ({
      stars: s,
      count: allReviews.filter(r => r.stars === s).length,
    }));

    return res.status(200).json({
      ok:          true,
      total,
      avgRating,
      replyRate:   total ? Math.round(replied / total * 100) : 0,
      distribution: dist,
      reviews:     allReviews,
    });

  } catch (err) {
    console.error('[Reviews] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
