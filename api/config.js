/**
 * api/config.js — Expone configuración pública (no sensible) al frontend
 * GET /api/config
 *
 * El frontend llama esto al arrancar para saber el nombre del sitio,
 * la URL, y si las APIs están configuradas.
 */
module.exports = function handler(req, res) {
  const siteUrl  = process.env.SITE_URL  || process.env.GSC_PROPERTY || '';
  const siteName = process.env.SITE_NAME || deriveName(siteUrl);

  const configured = !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
  const gmbConfigured = configured && !!process.env.GMB_LOCATION_NAME;

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    siteName,
    siteUrl: siteUrl.replace(/\/$/, ''),           // sin trailing slash
    gscProperty: process.env.GSC_PROPERTY || siteUrl,
    configured,
    gmbConfigured,
  });
};

/** Deriva un nombre legible de la URL cuando no se definió SITE_NAME */
function deriveName(url) {
  if (!url) return 'Mi Sitio';
  try {
    const host = new URL(url).hostname;           // dualsym.com
    return host.replace(/^www\./, '')             // quita www
               .split('.')[0]                      // toma primera parte
               .replace(/-/g, ' ')                // guiones → espacios
               .replace(/\b\w/g, l => l.toUpperCase()); // Title Case
  } catch {
    return 'Mi Sitio';
  }
}
