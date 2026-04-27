/**
 * api/get-account.js  —  ONE-TIME USE ENDPOINT
 * GET /api/get-account
 *
 * Returns the GMB account name using the stored refresh token.
 * Delete this file after getting your account ID.
 */
const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Faltan credenciales en Vercel' });
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  try {
    const { token } = await auth.getAccessToken();
    const hdrs = { Authorization: `Bearer ${token}` };

    const r = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: hdrs,
      signal: AbortSignal.timeout(9000),
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({
        error: `API ${r.status}`,
        message: data?.error?.message || JSON.stringify(data),
        tip: r.status === 429 ? 'Cuota agotada. Espera 2 min y reintenta.' : undefined,
      });
    }

    const accounts = data.accounts || [];
    return res.status(200).json({
      ok: true,
      accounts: accounts.map(a => ({ name: a.name, accountName: a.accountName, type: a.type })),
      // Copy this value to Vercel as GMB_ACCOUNT_NAME:
      GMB_ACCOUNT_NAME: accounts[0]?.name || null,
      next: accounts[0]?.name
        ? `Agrega GMB_ACCOUNT_NAME=${accounts[0].name} en Vercel → Settings → Environment Variables → Redeploy`
        : 'No se encontraron cuentas',
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
