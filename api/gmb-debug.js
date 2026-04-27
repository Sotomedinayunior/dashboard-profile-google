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

  // ── Método 1: API v4 (quota separada de v1) ───────────────────────────────
  const v4 = await safe('https://mybusiness.googleapis.com/v4/accounts');
  result.methods_tried.push({ method: 'v4 accounts API', status: v4.status, ok: v4.ok });

  if (v4.ok && v4.data?.accounts?.length) {
    const acc = v4.data.accounts[0];
    result.account_found = acc.name; // "accounts/XXXXXXXXX"
    result.methods_tried[0].account = acc.name;
    result.methods_tried[0].accountName = acc.accountName;
  }

  // ── Método 2: googleLocations:search (busca por placeId directamente) ─────
  // Funciona sin saber el account — y nos da el resourceName con account incluido
  if (!result.account_found) {
    for (const placeId of NELLY_PLACE_IDS) {
      const search = await fetch(
        'https://mybusinessbusinessinformation.googleapis.com/v1/googleLocations:search',
        {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({ pageSize: 5, query: NELLY_NAMES[placeId] }),
          signal: AbortSignal.timeout(8000),
        }
      ).then(r => r.json()).catch(() => null);

      const matched = (search?.googleLocations || []).find(l =>
        l.location?.metadata?.placeId === placeId ||
        l.requestAdminRightsUri?.includes(placeId)
      );

      if (matched?.name) {
        // name format: "googleLocations/locations/XXXXXXXXX" or similar
        result.methods_tried.push({ method: `googleLocations:search for ${NELLY_NAMES[placeId]}`, found: matched.name });
        break;
      }
    }
  }

  // ── Método 3: Si ya tenemos el account, listar sus ubicaciones ────────────
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
      `➡️  Agrega en Vercel → Settings → Environment Variables:`,
      `   GMB_ACCOUNT_NAME = ${result.account_found}`,
      `➡️  Luego haz Redeploy en Vercel.`,
    ].join('\n');
  } else {
    result.instructions = [
      '⚠️  No se pudo obtener el account ID automáticamente.',
      '',
      'OPCIÓN A — Aumentar cuota (recomendado, permanente):',
      '  1. Ve a: https://console.cloud.google.com/apis/api/mybusinessaccountmanagement.googleapis.com/quotas?project=868126352484',
      '  2. Busca "Requests per minute"',
      '  3. Haz clic en el lapicero → solicita 100 req/min',
      '  4. Espera aprobación (~24h) y el 429 desaparece para siempre.',
      '',
      'OPCIÓN B — Encontrar manualmente:',
      '  1. Ve a https://business.google.com con la cuenta de Google correcta',
      '  2. Abre DevTools → Network → filtra por "mybusiness"',
      '  3. Recarga la página',
      '  4. Busca un request con URL que incluya "accounts/XXXXXXXXX"',
      '  5. Copia ese número y ponlo como GMB_ACCOUNT_NAME en Vercel',
    ].join('\n');
  }

  return res.status(200).json(result);
};
