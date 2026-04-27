/**
 * api/gmb-debug.js
 * GET /api/gmb-debug
 *
 * Diagnóstico completo de Google Business Profile.
 * Auto-descubre cuentas y ubicaciones usando el mismo flujo que data.js.
 * No requiere GMB_LOCATION_NAME.
 *
 * Visita: https://dashboard-profile-google.vercel.app/api/gmb-debug
 */

const { google } = require('googleapis');

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

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({
      error: 'Faltan credenciales de Google en Vercel',
      missing: [
        !clientId     && 'GOOGLE_CLIENT_ID',
        !clientSecret && 'GOOGLE_CLIENT_SECRET',
        !refreshToken && 'GOOGLE_REFRESH_TOKEN',
      ].filter(Boolean),
    });
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  const result = {
    step1_token:    null,
    step2_accounts: null,
    step3_locations: null,
    step4_reviews_test: null,
    diagnosis: [],
    nelly_coverage: null,
  };

  try {
    // ── Step 1: Get access token ──────────────────────────────────────────────
    let token;
    try {
      const tokenRes = await auth.getAccessToken();
      token = tokenRes.token;
      result.step1_token = { ok: true, hint: 'Token obtenido correctamente' };
    } catch (e) {
      result.step1_token = { ok: false, error: e.message };
      result.diagnosis.push('ERROR: No se pudo obtener token. Verifica GOOGLE_REFRESH_TOKEN y que el OAuth client esté configurado correctamente.');
      return res.status(200).json(result);
    }

    const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ── Step 2: List accounts ─────────────────────────────────────────────────
    const acctRaw = await fetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: hdrs, signal: AbortSignal.timeout(8000) }
    ).catch(e => ({ ok: false, status: 0, _err: e.message }));

    if (!acctRaw.ok) {
      const body = await acctRaw.text().catch(() => '');
      result.step2_accounts = {
        ok: false,
        status: acctRaw.status,
        body: body.slice(0, 300),
      };
      if (acctRaw.status === 403) {
        result.diagnosis.push('ERROR 403 en accounts: El token no tiene el scope "business.manage". Reconecta en /api/auth.');
      } else {
        result.diagnosis.push(`ERROR ${acctRaw.status} en accounts API: ${body.slice(0, 150)}`);
      }
      return res.status(200).json(result);
    }

    const acctData = await acctRaw.json();
    const accounts = acctData.accounts || [];
    result.step2_accounts = {
      ok: true,
      count: accounts.length,
      accounts: accounts.map(a => ({ name: a.name, accountName: a.accountName, type: a.type })),
    };

    if (!accounts.length) {
      result.diagnosis.push('No se encontraron cuentas de Google Business. La cuenta de Google conectada no tiene ningún Business Profile asociado.');
      return res.status(200).json(result);
    }

    // ── Step 3: List locations for each account ───────────────────────────────
    const allLocations = [];
    for (const acct of accounts) {
      const locRaw = await fetch(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100`,
        { headers: hdrs, signal: AbortSignal.timeout(8000) }
      ).catch(e => ({ ok: false, status: 0, _err: e.message }));

      if (!locRaw.ok) {
        const body = await locRaw.text().catch(() => '');
        allLocations.push({ account: acct.name, error: `${locRaw.status}: ${body.slice(0,150)}` });
        continue;
      }

      const locData = await locRaw.json();
      (locData.locations || []).forEach(loc => {
        const placeId = loc.metadata?.placeId || null;
        allLocations.push({
          account:      acct.name,
          locationName: loc.name,
          title:        loc.title || '(sin nombre)',
          city:         loc.storefrontAddress?.locality || null,
          placeId,
          knownAs:      KNOWN_PLACES[placeId] || null,
          mapsUri:      loc.metadata?.mapsUri || null,
        });
      });
    }

    result.step3_locations = {
      ok: true,
      total: allLocations.length,
      locations: allLocations,
    };

    // Check Nelly coverage
    const foundPlaceIds = allLocations.map(l => l.placeId).filter(Boolean);
    const nellyEntries  = Object.entries(KNOWN_PLACES);
    result.nelly_coverage = {
      total_sucursales: nellyEntries.length,
      encontradas: nellyEntries.filter(([pid]) => foundPlaceIds.includes(pid)).map(([,name]) => name),
      no_encontradas: nellyEntries.filter(([pid]) => !foundPlaceIds.includes(pid)).map(([,name]) => name),
    };

    if (result.nelly_coverage.encontradas.length === 0) {
      result.diagnosis.push('Las sucursales de Nelly RAC no aparecen en la cuenta de Google conectada. Verifica que estés usando la cuenta de Google correcta (la que administra el Business Profile de Nelly RAC).');
    }

    // ── Step 4: Test reviews API on first matched location ────────────────────
    const firstNelly = allLocations.find(l => KNOWN_PLACES[l.placeId]);
    if (firstNelly) {
      const locationId = firstNelly.locationName.split('/').pop();
      const revRaw = await fetch(
        `https://mybusinessreviews.googleapis.com/v1/locations/${locationId}/reviews?pageSize=1`,
        { headers: hdrs, signal: AbortSignal.timeout(8000) }
      ).catch(e => ({ ok: false, status: 0, _err: e.message }));

      if (!revRaw.ok) {
        const body = await revRaw.text().catch(() => '');
        result.step4_reviews_test = {
          ok: false, status: revRaw.status,
          location_tested: firstNelly.title,
          body: body.slice(0, 300),
        };
        if (revRaw.status === 403) {
          result.diagnosis.push('ERROR 403 en Reviews API: La API de reseñas de Google Business Profile requiere aprobación especial. Solicita acceso en: https://developers.google.com/my-business/content/prereqs');
        } else if (revRaw.status === 404) {
          result.diagnosis.push('ERROR 404 en Reviews API: El endpoint de reseñas no reconoce esta ubicación. El locationId puede tener un formato incorrecto.');
        }
      } else {
        const revData = await revRaw.json();
        result.step4_reviews_test = {
          ok: true,
          location_tested: firstNelly.title,
          reviews_found: (revData.reviews || []).length,
          total_review_count: revData.totalReviewCount || 0,
        };
        result.diagnosis.push('OK: La API de reseñas funciona correctamente.');
      }
    } else {
      result.step4_reviews_test = { skipped: 'No se encontraron sucursales de Nelly RAC para probar' };
    }

    if (!result.diagnosis.length) {
      result.diagnosis.push('Todo parece correcto. Si GMB no muestra datos en el dashboard, puede ser un problema de caché. Espera 5 min y recarga.');
    }

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
};
