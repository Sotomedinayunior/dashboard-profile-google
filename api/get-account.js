/**
 * api/get-account.js
 * GET /api/get-account
 *
 * Obtiene el GMB Account Name usando el token de Google almacenado.
 * Solo hace UNA llamada a mybusinessaccountmanagement.googleapis.com.
 * Visita esta URL DESPUÉS de esperar 2 minutos sin abrir el dashboard.
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
    return res.status(500).json({ error: 'Faltan credenciales Google en Vercel' });
  }

  try {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    const { token } = await auth.getAccessToken();

    const r = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: `API ${r.status}: ${data?.error?.message || JSON.stringify(data)}`,
        tip: r.status === 429
          ? 'Cuota agotada. Espera 2 minutos más y reintenta.'
          : 'Verifica las credenciales en Vercel.',
      });
    }

    const accounts = (data.accounts || []).map(a => ({
      name:        a.name,
      accountName: a.accountName,
      type:        a.type,
    }));

    return res.status(200).json({
      ok: true,
      accounts,
      // Copia este valor en Vercel como GMB_ACCOUNT_NAME:
      GMB_ACCOUNT_NAME: accounts[0]?.name || null,
      next: accounts[0]?.name
        ? `Agrega en Vercel: GMB_ACCOUNT_NAME = ${accounts[0].name} → Redeploy`
        : 'No se encontraron cuentas GMB para este token.',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
