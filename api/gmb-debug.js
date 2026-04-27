/**
 * api/gmb-debug.js
 * GET /api/gmb-debug
 *
 * Encuentra el GMB account ID usando múltiples métodos sin depender
 * de mybusinessaccountmanagement (que tiene cuota muy baja).
 */

const { google } = require('googleapis');

const NELLY_PLACE_IDS = [
  'ChIJPRzgUXlipY4RTFpdm7Gtz2M',
  'ChIJBUNVazXRsY4R76jNG9B5mUQ',
  'ChIJNSahrlDksY4RdDGaHelddiY',
  'ChIJPZ6a5d6TqI4R5-DvEC5384M',
  'ChIJIfF1mPt_pY4RDB9kOOVbvz0',
];

const NELLY_NAMES = {
  'ChIJPRzgUXlipY4RTFpdm7Gtz2M': 'Independencia',
  'ChIJBUNVazXRsY4R76jNG9B5mUQ': 'Santiago · Cibao',
  'ChIJNSahrlDksY4RdDGaHelddiY': 'Puerto Plata',
  'ChIJPZ6a5d6TqI4R5-DvEC5384M': 'Punta Cana',
  'ChIJIfF1mPt_pY4RDB9kOOVbvz0': 'Boca Chica',
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN en Vercel' });
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  let token;
  try {
    const t = await auth.getAccessToken();
    token = t.token;
  } catch (e) {
    return res.status(500).json({ error: 'No se pudo obtener token: ' + e.message });
  }

  const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const safe = (url, opts = {}) =>
    fetch(url, { ...opts, headers: hdrs, signal: AbortSignal.timeout(8000) })
      .then(async r => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }))
      .catch(e => ({ ok: false, status: 0, data: null, error: e.message }));

  const result = {
    token_ok: true,
    methods_tried: [],
    account_found: null,
    locations_found: [],
    instructions: null,
  };

  // ── Método 1: v1 accounts ─────────────────────────────────────────────────
  const v1 = await safe('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  result.methods_tried.push({ method: 'v1 accounts API', status: v1.status, ok: v1.ok });
  if (v1.ok && v1.data?.accounts?.length) {
    const acc = v1.data.accounts[0];
    result.account_found = acc.name;
    result.methods_tried[0].account = acc.name;
  }

  // ── Método 2: googleLocations:search (no necesita account ID) ────────────
  if (!result.account_found) {
    const searchRes = await safe(
      'https://mybusinessbusinessinformation.googleapis.com/v1/googleLocations:search',
      { method: 'POST', body: JSON.stringify({ query: 'Nelly Rent A Car' }) }
    );
    result.methods_tried.push({ method: 'googleLocations:search', status: searchRes.status, ok: searchRes.ok });

    if (searchRes.ok && searchRes.data?.googleLocations?.length) {
      // El resource name de la ubicación tiene formato: accounts/{id}/locations/{id}
      for (const gl of searchRes.data.googleLocations) {
        const locName = gl.location?.name || gl.name || '';
        const match = locName.match(/^(accounts\/\d+)\//);
        if (match) {
          result.account_found = match[1];
          result.methods_tried[result.methods_tried.length - 1].account = match[1];
          result.methods_tried[result.methods_tried.length - 1].rawLocation = locName;
          break;
        }
      }
    }
  }

  // ── Método 3: buscar por Place ID ─────────────────────────────────────────
  if (!result.account_found) {
    for (const placeId of NELLY_PLACE_IDS.slice(0, 2)) {
      const placeRes = await safe(
        `https://mybusinessbusinessinformation.googleapis.com/v1/googleLocations:search`,
        { method: 'POST', body: JSON.stringify({ placeId }) }
      );
      result.methods_tried.push({ method: `placeId search: ${placeId}`, status: placeRes.status, ok: placeRes.ok });
      if (placeRes.ok && placeRes.data?.googleLocations?.length) {
        const locName = placeRes.data.googleLocations[0]?.location?.name || '';
        const match = locName.match(/^(accounts\/\d+)\//);
        if (match) {
          result.account_found = match[1];
          break;
        }
      }
    }
  }

  // ── Método 4: Si ya tenemos account, listar ubicaciones ──────────────────
  if (result.account_found) {
    const locRes = await safe(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${result.account_found}/locations?readMask=name,title,metadata`
    );
    result.methods_tried.push({ method: 'list locations', status: locRes.status, ok: locRes.ok });
    if (locRes.ok) {
      result.locations_found = (locRes.data?.locations || []).map(l => ({
        locationName: l.name,
        title: l.title,
        placeId: l.metadata?.placeId,
        knownAs: NELLY_NAMES[l.metadata?.placeId] || null,
      }));
    }
  }

  // ── Instrucciones finales ─────────────────────────────────────────────────
  if (result.account_found) {
    result.instructions = [
      `✅ Account ID encontrado: ${result.account_found}`,
      ``,
      `➡️  Agrega en Vercel → Settings → Environment Variables:`,
      `   GMB_ACCOUNT_NAME = ${result.account_found}`,
      ``,
      `➡️  Luego haz Redeploy en Vercel para activar las reseñas.`,
    ].join('\n');
  } else {
    result.instructions = [
      '⚠️  No se pudo detectar el account ID automáticamente.',
      '',
      'Verifica que el Refresh Token tenga el scope business.manage:',
      '  1. Ve a: https://developers.google.com/oauthplayground',
      '  2. ⚙️ → Use your own OAuth credentials → Client ID + Secret',
      '  3. Scope: https://www.googleapis.com/auth/business.manage',
      '  4. Authorize → Exchange → copia el nuevo Refresh token',
      '  5. Actualiza GOOGLE_REFRESH_TOKEN en Vercel → Redeploy',
      '  6. Llama /api/gmb-debug de nuevo',
    ].join('\n');
  }

  return res.status(200).json(result);
};
