/**
 * api/callback.js — Recibe el código OAuth2 de Google y muestra el refresh_token
 * GET /api/callback?code=...
 *
 * Después de autorizar en Google, esta página te muestra el refresh_token
 * para que lo copies y lo guardes como variable de entorno en Vercel.
 */

const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.status(400).send(`
      <h2>Error de autorización</h2>
      <p>${error}</p>
      <a href="/api/auth">Intentar de nuevo</a>
    `);
  }

  if (!code) {
    return res.redirect('/api/auth');
  }

  const host        = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const protocol    = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/callback`;

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );

  try {
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    // Try to fetch GMB account + location IDs to help with setup
    let gmbInfo = '';
    try {
      const accessToken = tokens.access_token;
      const hdrs = { Authorization: `Bearer ${accessToken}` };

      const acctRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: hdrs });
      const accounts = acctRes.ok ? await acctRes.json() : {};

      if (accounts.accounts?.length) {
        const acct     = accounts.accounts[0];
        const acctName = acct.name; // e.g., accounts/123456789

        const locRes = await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acctName}/locations?readMask=name,title`,
          { headers: hdrs }
        );
        const locs = locRes.ok ? await locRes.json() : {};

        if (locs.locations?.length) {
          gmbInfo = `
            <div style="background:#e8f5e9;border-radius:8px;padding:16px;margin-top:16px">
              <h3 style="color:#2e7d32;margin:0 0 12px">✅ Google My Business encontrado</h3>
              <p style="margin:0 0 8px"><strong>Cuenta:</strong> ${acct.accountName || acctName}</p>
              <p style="margin:0 0 8px"><strong>Account Name:</strong> <code>${acctName}</code></p>
              ${locs.locations.map(l => `
                <p style="margin:4px 0"><strong>Ubicación:</strong> ${l.title || l.name}</p>
                <p style="margin:4px 0"><strong>GMB_LOCATION_NAME:</strong> <code style="background:#c8e6c9;padding:2px 6px;border-radius:4px">${l.name}</code></p>
              `).join('')}
            </div>
          `;
        }
      }
    } catch (e) {
      gmbInfo = `<p style="color:#666;font-size:13px">No se pudo obtener datos de GMB automáticamente, pero el token es válido.</p>`;
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Setup completo — Nelly Dashboard</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; color: #1a1a1a; }
          h1 { color: #E8610A; }
          .token-box { background: #1a1a1a; color: #f5f5f5; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 13px; word-break: break-all; margin: 10px 0; }
          .step { background: #fff8f4; border-left: 4px solid #E8610A; padding: 12px 16px; margin: 16px 0; border-radius: 0 8px 8px 0; }
          .step h3 { margin: 0 0 8px; color: #c04f00; }
          code { background: #f0efed; padding: 2px 6px; border-radius: 4px; }
          .btn { display: inline-block; background: #E8610A; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin-top: 20px; font-weight: 600; }
        </style>
      </head>
      <body>
        <h1>🎉 Autorización exitosa</h1>
        <p>Ya tienes los tokens. Guárdalos como variables de entorno en Vercel.</p>

        <div class="step">
          <h3>1️⃣ Copia tu GOOGLE_REFRESH_TOKEN</h3>
          <p>Este token es permanente — solo necesitas obtenerlo una vez.</p>
          <div class="token-box">${tokens.refresh_token || '⚠️ No se generó refresh_token — vuelve a /api/auth'}</div>
        </div>

        ${gmbInfo}

        <div class="step">
          <h3>2️⃣ Agrega estas variables en Vercel</h3>
          <p>Ve a tu proyecto en Vercel → <strong>Settings → Environment Variables</strong> y agrega:</p>
          <ul>
            <li><code>GOOGLE_CLIENT_ID</code> — ya lo tienes</li>
            <li><code>GOOGLE_CLIENT_SECRET</code> — ya lo tienes</li>
            <li><code>GOOGLE_REFRESH_TOKEN</code> — el token de arriba</li>
            <li><code>GSC_PROPERTY</code> → <code>https://nellyrac.do/</code></li>
            <li><code>GMB_LOCATION_NAME</code> → el valor de arriba (accounts/.../locations/...)</li>
          </ul>
        </div>

        <div class="step">
          <h3>3️⃣ Redeploy</h3>
          <p>Después de agregar las variables, haz un redeploy en Vercel para activarlas.</p>
        </div>

        <a href="/" class="btn">← Volver al dashboard</a>
      </body>
      </html>
    `);

  } catch (err) {
    res.status(500).send(`
      <h2>Error al obtener tokens</h2>
      <pre>${err.message}</pre>
      <a href="/api/auth">Intentar de nuevo</a>
    `);
  }
};
