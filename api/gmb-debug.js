/**
 * api/gmb-debug.js
 * GET /api/gmb-debug
 *
 * Diagnóstico: muestra todas las cuentas y locaciones que el token
 * de Google puede ver, incluyendo el placeId de cada location.
 *
 * Úsalo UNA VEZ para obtener los locationName correctos,
 * luego configura GMB_LOCATION_MAP en Vercel.
 *
 * Requiere: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({
      error: 'Faltan variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REFRESH_TOKEN',
    });
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await auth.getAccessToken();
    const hdrs = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    };

    // ── 1. Obtener cuentas ────────────────────────────────────────────────────
    const acctRes = await fetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: hdrs, signal: AbortSignal.timeout(8000) }
    );

    if (!acctRes.ok) {
      const body = await acctRes.text();
      return res.status(502).json({
        error: `No se pudo acceder a GMB accounts (${acctRes.status})`,
        detail: body,
        hint: 'Verifica que el token tenga el scope https://www.googleapis.com/auth/business.manage. Si no, reconecta en /api/auth.',
      });
    }

    const { accounts = [] } = await acctRes.json();

    if (accounts.length === 0) {
      return res.status(200).json({
        ok: false,
        accounts: [],
        hint: 'La cuenta de Google no tiene ninguna cuenta de Business Profile asociada. Asegúrate de usar el mismo Google que administra el negocio en business.google.com.',
      });
    }

    // ── 2. Para cada cuenta, obtener locaciones con metadata ─────────────────
    const result = [];

    for (const acct of accounts) {
      const locRes = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations` +
        `?readMask=name,title,storefrontAddress,metadata&pageSize=100`,
        { headers: hdrs, signal: AbortSignal.timeout(8000) }
      );

      let locations = [];
      let locError  = null;

      if (locRes.ok) {
        const data = await locRes.json();
        locations = (data.locations || []).map(loc => ({
          locationName: loc.name,           // ← Este es el valor que necesitas
          title:        loc.title || '(sin nombre)',
          placeId:      loc.metadata?.placeId || null,
          mapsUri:      loc.metadata?.mapsUri || null,
          newReviewUri: loc.metadata?.newReviewUri || null,
          address:      loc.storefrontAddress?.locality || null,
          rawMetadata:  loc.metadata || {},
        }));
      } else {
        locError = `${locRes.status} ${await locRes.text()}`;
      }

      result.push({
        accountName:  acct.name,
        accountType:  acct.type || null,
        displayName:  acct.accountName || acct.name,
        locationCount: locations.length,
        locError,
        locations,
      });
    }

    // ── 3. Generar el GMB_LOCATION_MAP sugerido ───────────────────────────────
    const locationMap = {};
    for (const acct of result) {
      for (const loc of acct.locations) {
        if (loc.placeId) {
          locationMap[loc.placeId] = loc.locationName;
        }
      }
    }

    return res.status(200).json({
      ok: true,
      tokenEmail: null, // no expuesto por seguridad
      accounts: result,
      // ↓ Copia este objeto como valor de GMB_LOCATION_MAP en Vercel (como JSON string)
      suggestedGMB_LOCATION_MAP: JSON.stringify(locationMap),
      hint: Object.keys(locationMap).length === 0
        ? 'No se encontró placeId en ninguna location. Puede que el negocio use cuenta tipo Organization — revisa rawMetadata de cada location.'
        : `Copia "suggestedGMB_LOCATION_MAP" como variable GMB_LOCATION_MAP en Vercel → Settings → Environment Variables.`,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
