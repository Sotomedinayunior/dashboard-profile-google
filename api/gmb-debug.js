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
  'ChIJIfF1mPt_pY4RDB9kOOVbvz0': 'Las Américas',
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

  // ── Método DIRECTO: probar account ID extraído de URL business.google.com ──
  const CANDIDATE_ACCOUNT = 'accounts/14783610060775958761';
  const directLocRes = await safe(
    `https://mybusinessbusinessinformation.googleapis.com/v1/${CANDIDATE_ACCOUNT}/locations?readMask=name,title,metadata`
  );
  result.methods_tried.push({
    method: 'direct candidate account (from business.google.com URL)',
    account_tested: CANDIDATE_ACCOUNT,
    status: directLocRes.status,
    ok: directLocRes.ok,
    rawResponse: directLocRes.data,
  });
  if (directLocRes.ok) {
    result.account_found = CANDIDATE_ACCOUNT;
    result.locations_found = (directLocRes.data?.locations || []).map(l => ({
      locationName: l.name,
      title: l.title,
      placeId: l.metadata?.placeId,
      knownAs: NELLY_NAMES[l.metadata?.placeId] || null,
    }));
  }

  // ── Método 0: v4 legacy API (no usa mybusinessaccountmanagement) ──────────
  const v4 = await safe('https://mybusiness.googleapis.com/v4/accounts');
  result.methods_tried.push({ method: 'v4 legacy accounts', status: v4.status, ok: v4.ok, rawResponse: v4.data });
  if (v4.ok && v4.data?.accounts?.length) {
    const acc = v4.data.accounts[0];
    result.account_found = acc.name; // formato: accounts/XXXXXXXXXXXXXXXXXX
    result.methods_tried[0].account = acc.name;
  }

  // ── Método 1: v1 accounts ─────────────────────────────────────────────────
  if (!result.account_found) {
    const v1 = await safe('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    result.methods_tried.push({ method: 'v1 accounts API', status: v1.status, ok: v1.ok, rawResponse: v1.data });
    if (v1.ok && v1.data?.accounts?.length) {
      const acc = v1.data.accounts[0];
      result.account_found = acc.name;
      result.methods_tried[result.methods_tried.length - 1].account = acc.name;
    }
  }

  // ── Método 2: googleLocations:search (no necesita account ID) ────────────
  if (!result.account_found) {
    const searchRes = await safe(
      'https://mybusinessbusinessinformation.googleapis.com/v1/googleLocations:search',
      { method: 'POST', body: JSON.stringify({ query: 'Nelly Rent A Car' }) }
    );
    // Log raw response so we can debug the exact structure
    result.methods_tried.push({
      method: 'googleLocations:search',
      status: searchRes.status,
      ok: searchRes.ok,
      rawResponse: searchRes.data,           // ← full raw response
    });

    if (searchRes.ok && searchRes.data) {
      const d = searchRes.data;
      // Try multiple possible structures Google may return
      const locations = d.googleLocations || d.locations || [];
      for (const gl of locations) {
        // Structure A: gl.location.name = "accounts/123/locations/456"
        // Structure B: gl.name = "googleLocations/ChIJ..."
        // Structure C: gl.requestAdminRightsUrl contains account info
        const candidates = [
          gl.location?.name,
          gl.name,
          gl.requestAdminRightsUrl,
        ].filter(Boolean);

        for (const candidate of candidates) {
          const match = candidate.match(/accounts\/(\d+)/);
          if (match) {
            result.account_found = `accounts/${match[1]}`;
            result.methods_tried[result.methods_tried.length - 1].account = result.account_found;
            result.methods_tried[result.methods_tried.length - 1].extractedFrom = candidate;
            break;
          }
        }
        if (result.account_found) break;
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
      result.methods_tried.push({
        method: `placeId search: ${placeId}`,
        status: placeRes.status,
        ok: placeRes.ok,
        rawResponse: placeRes.data,          // ← full raw response
      });
      if (placeRes.ok && placeRes.data) {
        const d = placeRes.data;
        const locations = d.googleLocations || d.locations || [];
        for (const gl of locations) {
          const candidates = [
            gl.location?.name,
            gl.name,
            gl.requestAdminRightsUrl,
          ].filter(Boolean);
          for (const candidate of candidates) {
            const match = candidate.match(/accounts\/(\d+)/);
            if (match) {
              result.account_found = `accounts/${match[1]}`;
              result.methods_tried[result.methods_tried.length - 1].account = result.account_found;
              result.methods_tried[result.methods_tried.length - 1].extractedFrom = candidate;
              break;
            }
          }
          if (result.account_found) break;
        }
      }
    }
  }

  // ── Método 4b: businessprofileperformance accounts (alternativo) ─────────
  if (!result.account_found) {
    // Intenta la nueva API de Business Profile Performance que a veces lista cuentas
    const bppRes = await safe('https://businessprofileperformance.googleapis.com/v1/accounts');
    result.methods_tried.push({
      method: 'businessprofileperformance accounts',
      status: bppRes.status,
      ok: bppRes.ok,
      rawResponse: bppRes.data,
    });
    if (bppRes.ok && bppRes.data?.accounts?.length) {
      result.account_found = bppRes.data.accounts[0].name;
    }
  }

  // ── Método 4c: mybusinessaccountmanagement con parámetros adicionales ────
  if (!result.account_found) {
    const v1b = await safe('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20&filter=type=PERSONAL');
    result.methods_tried.push({
      method: 'v1 accounts (type=PERSONAL filter)',
      status: v1b.status,
      ok: v1b.ok,
      rawResponse: v1b.data,
    });
    if (v1b.ok && v1b.data?.accounts?.length) {
      result.account_found = v1b.data.accounts[0].name;
    }
  }

  // ── Método 5: Si ya tenemos account, listar ubicaciones ──────────────────
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
