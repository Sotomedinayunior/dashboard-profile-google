/**
 * api/gmb-debug.js
 * GET /api/gmb-debug
 *
 * Diagnóstico: lista todas las locaciones del Business Profile
 * usando SOLO mybusinessbusinessinformation (no account management).
 *
 * Extrae el account name de GMB_LOCATION_NAME que ya tienes configurado.
 * Devuelve locationName + placeId de cada sucursal → úsalos para GMB_LOCATION_MAP.
 *
 * Requiere: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GMB_LOCATION_NAME
 */

const { google } = require('googleapis');

// Nelly RAC — place IDs conocidos (para mostrar nombre amigable en el diagnóstico)
const KNOWN_PLACES = {
  'ChIJPRzgUXlipY4RTFpdm7Gtz2M': 'Independencia (Santo Domingo)',
  'ChIJBUNVazXRsY4R76jNG9B5mUQ': 'Santiago · Cibao',
  'ChIJNSahrlDksY4RdDGaHelddiY': 'Puerto Plata',
  'ChIJPZ6a5d6TqI4R5-DvEC5384M': 'Punta Cana',
  'ChIJIfF1mPt_pY4RDB9kOOVbvz0': 'Las Americas / Boca Chica',
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const gmbLocation  = process.env.GMB_LOCATION_NAME; // e.g. "accounts/123/locations/456"

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({
      error: 'Faltan: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REFRESH_TOKEN en Vercel',
    });
  }

  if (!gmbLocation) {
    return res.status(500).json({
      error: 'Falta GMB_LOCATION_NAME en Vercel. Debe tener el formato: accounts/XXXXXXXXX/locations/YYYYYYYYY',
    });
  }

  // Extraer el account name: "accounts/123456789"
  const accountName = gmbLocation.split('/locations/')[0]; // "accounts/123456789"
  if (!accountName || !accountName.startsWith('accounts/')) {
    return res.status(500).json({
      error: `GMB_LOCATION_NAME tiene formato incorrecto: "${gmbLocation}". Debe ser accounts/XXX/locations/YYY`,
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

    // ── Obtener todas las locaciones del account (sin Account Management API) ─
    let pageToken = '';
    const allLocations = [];

    do {
      const url =
        `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations` +
        `?readMask=name,title,storefrontAddress,metadata&pageSize=100` +
        (pageToken ? `&pageToken=${pageToken}` : '');

      const locRes = await fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(10000),
      });

      if (!locRes.ok) {
        const body = await locRes.text();
        return res.status(502).json({
          error: `Error al listar locaciones (${locRes.status})`,
          accountUsed: accountName,
          detail: body,
          hint: locRes.status === 403
            ? 'El token no tiene permiso. Reconecta en /api/auth para obtener el scope business.manage.'
            : 'Verifica que GMB_LOCATION_NAME sea correcto en Vercel.',
        });
      }

      const data = await locRes.json();
      (data.locations || []).forEach(loc => {
        const placeId = loc.metadata?.placeId || null;
        allLocations.push({
          locationName: loc.name,
          title:        loc.title || '(sin nombre)',
          placeId,
          knownAs:      placeId ? (KNOWN_PLACES[placeId] || null) : null,
          mapsUri:      loc.metadata?.mapsUri || null,
          city:         loc.storefrontAddress?.locality || null,
          rawMetadata:  loc.metadata || {},
        });
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    // ── Generar GMB_LOCATION_MAP ──────────────────────────────────────────────
    const locationMap = {};
    const missingPlaceId = [];

    for (const loc of allLocations) {
      if (loc.placeId) {
        locationMap[loc.placeId] = loc.locationName;
      } else {
        missingPlaceId.push(loc.locationName);
      }
    }

    // Verificar cobertura de las 5 sucursales Nelly
    const nellyPlaceIds = Object.keys(KNOWN_PLACES);
    const covered   = nellyPlaceIds.filter(p => locationMap[p]);
    const missing   = nellyPlaceIds.filter(p => !locationMap[p]);

    return res.status(200).json({
      ok: true,
      accountUsed: accountName,
      totalLocations: allLocations.length,
      locations: allLocations,

      // ── Copia esto como valor de GMB_LOCATION_MAP en Vercel ──────────────
      GMB_LOCATION_MAP: JSON.stringify(locationMap),

      coverage: {
        nellySucursales: nellyPlaceIds.length,
        encontradas: covered.length,
        encontradasNombres: covered.map(p => KNOWN_PLACES[p]),
        noEncontradas: missing.map(p => KNOWN_PLACES[p]),
      },

      nextStep: Object.keys(locationMap).length > 0
        ? '✅ Copia el valor de "GMB_LOCATION_MAP" y agrégalo como variable de entorno en Vercel → Settings → Environment Variables. Luego haz Redeploy.'
        : '⚠️ No se encontró placeId en las locaciones. Revisa "rawMetadata" de cada una para identificar el campo correcto.',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
