/**
 * api/post-reply.js
 * POST /api/post-reply
 *
 * Publica una respuesta a una reseña de Google directamente
 * usando la Google Business Profile API con las credenciales OAuth almacenadas.
 *
 * Body: { placeId, reviewId, replyText }
 * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

const { google } = require('googleapis');

// In-memory cache: placeId → GMB location name (e.g. "accounts/123/locations/456")
// Resets on cold start, but saves extra API calls within the same execution
const locationCache = {};

// Static map loaded from GMB_LOCATION_MAP env var (JSON string).
// Format: { "placeId": "accounts/123/locations/456", ... }
// Set this in Vercel to skip the dynamic API lookup (use /api/gmb-debug to get the values).
let staticLocationMap = null;
function getStaticMap() {
  if (staticLocationMap !== null) return staticLocationMap;
  try {
    staticLocationMap = process.env.GMB_LOCATION_MAP
      ? JSON.parse(process.env.GMB_LOCATION_MAP)
      : {};
  } catch {
    staticLocationMap = {};
  }
  return staticLocationMap;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Credenciales de Google no configuradas en Vercel' });
  }

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body inválido' }); }

  const { placeId, reviewId, replyText } = body;
  if (!placeId)              return res.status(400).json({ error: 'placeId requerido' });
  if (!reviewId)             return res.status(400).json({ error: 'reviewId requerido' });
  if (!replyText?.trim())    return res.status(400).json({ error: 'replyText requerido' });

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await auth.getAccessToken();
    const hdrs = {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
    };

    // ── 1. Resolve GMB location name from placeId ─────────────────────────────
    // Priority: memory cache → static map (GMB_LOCATION_MAP) → individual env var → API lookup
    let locationName =
      locationCache[placeId] ||
      getStaticMap()[placeId] ||
      process.env[`GMB_LOC_${placeId}`] ||
      null;

    if (!locationName) {
      locationName = await findLocationByPlaceId(placeId, hdrs);
      if (locationName) locationCache[placeId] = locationName;
    }

    if (!locationName) {
      return res.status(404).json({
        error: `No se encontró la sucursal con place_id "${placeId}" en tu cuenta de Google Business.`,
        detail: 'La cuenta de Google en Vercel puede no tener este negocio vinculado, o el placeId no coincide con el registrado en Business Profile.',
        fix: 'Ve a /api/gmb-debug para ver qué locaciones ve tu token. Luego agrega GMB_LOCATION_MAP en Vercel con el JSON que te devuelve ese endpoint.',
      });
    }

    // ── 2. POST reply ─────────────────────────────────────────────────────────
    // Review path: accounts/{acctId}/locations/{locId}/reviews/{reviewId}
    const reviewPath = `${locationName}/reviews/${reviewId}`;

    const replyRes = await fetch(
      `https://mybusinessreviews.googleapis.com/v1/${reviewPath}/reply`,
      {
        method:  'PUT',
        headers: hdrs,
        body:    JSON.stringify({ comment: replyText.trim() }),
        signal:  AbortSignal.timeout(8000),
      }
    );

    if (!replyRes.ok) {
      const errJson = await replyRes.json().catch(() => ({}));
      const msg = errJson?.error?.message || errJson?.error?.status || `HTTP ${replyRes.status}`;
      // Surface scope error clearly
      if (replyRes.status === 403) {
        return res.status(403).json({
          error: `Permiso denegado (403). El token de Google no tiene el scope "business.manage". Necesitas reconectar la cuenta en /api/auth para agregar ese permiso.`,
        });
      }
      return res.status(502).json({ error: `Google API: ${msg}` });
    }

    return res.status(200).json({
      ok: true,
      message: 'Respuesta publicada correctamente en Google Business.',
      locationName,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Discover GMB location name from Google Maps place ID ──────────────────────
async function findLocationByPlaceId(targetPlaceId, hdrs) {
  const safe = (url, opts) =>
    fetch(url, { ...opts, signal: AbortSignal.timeout(5000) })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);

  // Get accounts
  const acctData = await safe(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    { headers: hdrs }
  );
  const accounts = acctData?.accounts || [];

  for (const acct of accounts) {
    // Fetch all locations with metadata (includes placeId)
    const locData = await safe(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations` +
      `?readMask=name,metadata&pageSize=100`,
      { headers: hdrs }
    );
    for (const loc of locData?.locations || []) {
      if (loc.metadata?.placeId === targetPlaceId) {
        return loc.name; // "accounts/123/locations/456"
      }
    }
  }

  return null;
}
