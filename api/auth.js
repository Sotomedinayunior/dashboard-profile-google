/**
 * api/auth.js — Inicia el flujo OAuth2 de Google
 * GET /api/auth  →  redirige al consent screen de Google
 *
 * Úsalo solo durante el setup inicial para obtener tu refresh_token.
 * Después guarda el token como variable de entorno y ya no necesitas esta ruta.
 */

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage',
];

module.exports = function handler(req, res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({
      error: 'Faltan variables de entorno: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET',
      hint: 'Agrega estas variables en Vercel → Settings → Environment Variables',
    });
  }

  // Build redirect URI — works both locally and on Vercel
  const host        = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const protocol    = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = `${protocol}://${host}/api/callback`;

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );

  const authUrl = auth.generateAuthUrl({
    access_type:   'offline',   // needed to get refresh_token
    prompt:        'consent',   // force consent to always get refresh_token
    scope:         SCOPES,
    response_type: 'code',
  });

  res.redirect(authUrl);
};
