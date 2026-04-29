/**
 * api/ads.js
 * GET /api/ads
 *
 * Obtiene datos EXACTOS de Google Ads directamente desde la API oficial
 * (Google Ads API v18 — REST). A diferencia de los datos de GA4 que
 * aproximan el gasto por canal, esta API devuelve cifras reales por
 * campaña, grupo de anuncios y keyword.
 *
 * ─── Variables de entorno requeridas en Vercel ──────────────────────────────
 *
 *  GOOGLE_CLIENT_ID          → mismo que usa data.js
 *  GOOGLE_CLIENT_SECRET      → mismo que usa data.js
 *  GOOGLE_REFRESH_TOKEN      → debe incluir el scope:
 *                              https://www.googleapis.com/auth/adwords
 *                              Si el token actual NO lo tiene, generarlo de nuevo
 *                              en OAuth Playground con ese scope adicional.
 *
 *  GOOGLE_ADS_DEVELOPER_TOKEN → token de desarrollador
 *                               Obtener en: ads.google.com → Herramientas
 *                               → Configuración → API Center → Developer Token
 *                               (el token de prueba ("test account") funciona
 *                               solo con cuentas de test; solicitar "Basic access"
 *                               para producción — se aprueba en 24-48 h)
 *
 *  GOOGLE_ADS_CUSTOMER_ID    → ID de cliente de Google Ads SIN guiones
 *                               Ej: si el ID es 123-456-7890 → poner 1234567890
 *                               Lo ves arriba a la derecha en ads.google.com
 *
 *  GOOGLE_ADS_LOGIN_CUSTOMER_ID → (Solo si usas una cuenta MCC / administrador)
 *                               ID de la cuenta MCC sin guiones
 *
 * ─── Respuesta JSON ─────────────────────────────────────────────────────────
 *
 *  {
 *    configured: bool,
 *    hasData:    bool,
 *    period:     { start, end, days },
 *    summary:    { spend, clicks, impressions, ctr, avgCpc, conversions,
 *                  costPerConv, monthlyAvgSpend },
 *    campaigns:  [ { id, name, status, channelType, spend, clicks,
 *                    impressions, ctr, avgCpc, conversions } ],
 *    adGroups:   [ { id, name, campaignName, spend, clicks, impressions,
 *                    ctr, avgCpc, conversions } ],
 *    keywords:   [ { text, matchType, campaignName, adGroupName, spend,
 *                    clicks, impressions, ctr, avgCpc, conversions } ],
 *    monthly:    [ { month, spend, clicks, impressions, conversions } ],
 *    daily:      [ { date, spend, clicks, impressions } ],
 *    error:      null | "mensaje de error parcial"
 *  }
 */

const { google } = require('googleapis');

const ADS_VERSION = 'v18';
const ADS_URL     = `https://googleads.googleapis.com/${ADS_VERSION}`;

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Usa GET' });
  }

  // ── Validar env vars ──────────────────────────────────────────────────────
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const devToken     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId   = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const loginCustId  = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(200).json({
      configured: false, hasData: false,
      error: 'Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN en Vercel',
    });
  }
  if (!devToken) {
    return res.status(200).json({
      configured: false, hasData: false,
      error: 'Falta GOOGLE_ADS_DEVELOPER_TOKEN · Obtener en ads.google.com → Herramientas → API Center',
    });
  }
  if (!customerId) {
    return res.status(200).json({
      configured: false, hasData: false,
      error: 'Falta GOOGLE_ADS_CUSTOMER_ID (ID sin guiones, ej: 1234567890) en Vercel',
    });
  }

  // ── Access token via OAuth2 ───────────────────────────────────────────────
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  let accessToken;
  try {
    const t = await auth.getAccessToken();
    accessToken = t.token;
  } catch (e) {
    return res.status(200).json({
      configured: true, hasData: false,
      error: `No se pudo obtener access token: ${e.message}. ` +
             `Regenera el refresh token incluyendo el scope adwords.`,
    });
  }

  // ── Headers para Google Ads API ───────────────────────────────────────────
  const hdrs = {
    'Authorization':  `Bearer ${accessToken}`,
    'developer-token': devToken,
    'Content-Type':   'application/json',
  };
  if (loginCustId) hdrs['login-customer-id'] = loginCustId;

  // ── Helper: ejecutar GAQL via searchStream ────────────────────────────────
  async function gaql(query) {
    const url  = `${ADS_URL}/customers/${customerId}/googleAds:searchStream`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(18000),
    });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      // Google Ads devuelve errores en varios formatos posibles
      const msg =
        body?.error?.message ||
        body?.[0]?.error?.details?.[0]?.errors?.[0]?.message ||
        body?.[0]?.error?.message ||
        `HTTP ${resp.status}`;
      throw new Error(msg);
    }

    // searchStream devuelve líneas de JSON separadas
    const text   = await resp.text();
    const rows   = [];
    for (const line of text.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const items  = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (Array.isArray(item.results)) rows.push(...item.results);
        }
      } catch {}
    }
    return rows;
  }

  // ── Fechas ────────────────────────────────────────────────────────────────
  const today   = new Date();
  const fmt     = d => d.toISOString().split('T')[0];
  const end30   = fmt(today);
  const start30 = fmt(new Date(+today - 30 * 86400000));
  const start6M = fmt(new Date(+today - 182 * 86400000));

  // ── Lanzar todas las queries en paralelo ──────────────────────────────────
  const [resCamp, resAG, resKW, resMon, resDay] = await Promise.allSettled([

    // 1. Campañas — últimos 30 días
    gaql(`
      SELECT
        campaign.id, campaign.name, campaign.status,
        campaign.advertising_channel_type,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.ctr, metrics.average_cpc,
        metrics.conversions, metrics.cost_per_conversion,
        metrics.all_conversions
      FROM campaign
      WHERE segments.date BETWEEN '${start30}' AND '${end30}'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `),

    // 2. Grupos de anuncios — últimos 30 días
    gaql(`
      SELECT
        ad_group.id, ad_group.name, campaign.name,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.ctr, metrics.average_cpc, metrics.conversions
      FROM ad_group
      WHERE segments.date BETWEEN '${start30}' AND '${end30}'
        AND ad_group.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 100
    `),

    // 3. Keywords — últimas 30 días
    gaql(`
      SELECT
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group.name, campaign.name,
        metrics.cost_micros, metrics.clicks, metrics.impressions,
        metrics.ctr, metrics.average_cpc, metrics.conversions
      FROM keyword_view
      WHERE segments.date BETWEEN '${start30}' AND '${end30}'
        AND ad_group_criterion.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 50
    `),

    // 4. Tendencia mensual — últimos 6 meses
    gaql(`
      SELECT
        segments.month,
        metrics.cost_micros, metrics.clicks,
        metrics.impressions, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${start6M}' AND '${end30}'
        AND campaign.status != 'REMOVED'
      ORDER BY segments.month ASC
    `),

    // 5. Tendencia diaria — últimos 30 días
    gaql(`
      SELECT
        segments.date,
        metrics.cost_micros, metrics.clicks, metrics.impressions
      FROM campaign
      WHERE segments.date BETWEEN '${start30}' AND '${end30}'
        AND campaign.status != 'REMOVED'
      ORDER BY segments.date ASC
    `),
  ]);

  // ── Helpers de parseo ─────────────────────────────────────────────────────
  const usd  = micros => +(Number(micros || 0) / 1_000_000).toFixed(2);
  const num  = v      => Number(v || 0);
  const pct  = (clicks, impressions) =>
    impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0;

  // ── 1. Campañas ───────────────────────────────────────────────────────────
  const campaigns = [];
  if (resCamp.status === 'fulfilled') {
    // searchStream puede regresar una fila por día × campaña → agrupar
    const map = new Map();
    for (const row of resCamp.value) {
      const id = String(row.campaign?.id || '');
      if (!map.has(id)) {
        map.set(id, {
          id, name: row.campaign?.name || '',
          status:      row.campaign?.status || '',
          channelType: row.campaign?.advertisingChannelType || '',
          cost: 0, clicks: 0, impressions: 0, conversions: 0,
        });
      }
      const c = map.get(id);
      c.cost        += num(row.metrics?.costMicros);
      c.clicks      += num(row.metrics?.clicks);
      c.impressions += num(row.metrics?.impressions);
      c.conversions += num(row.metrics?.conversions);
    }
    for (const c of map.values()) {
      campaigns.push({
        id:          c.id,
        name:        c.name,
        status:      c.status,
        channelType: c.channelType,
        spend:       usd(c.cost),
        clicks:      c.clicks,
        impressions: c.impressions,
        ctr:         pct(c.clicks, c.impressions),
        avgCpc:      c.clicks > 0 ? usd(c.cost / c.clicks) : 0,
        conversions: +c.conversions.toFixed(1),
        costPerConv: c.conversions > 0 ? usd(c.cost / c.conversions) : null,
      });
    }
    campaigns.sort((a, b) => b.spend - a.spend);
  }

  // ── 2. Grupos de anuncios ─────────────────────────────────────────────────
  const adGroups = [];
  if (resAG.status === 'fulfilled') {
    const map = new Map();
    for (const row of resAG.value) {
      const id = String(row.adGroup?.id || '');
      if (!map.has(id)) {
        map.set(id, {
          id, name: row.adGroup?.name || '',
          campaignName: row.campaign?.name || '',
          cost: 0, clicks: 0, impressions: 0, conversions: 0,
        });
      }
      const g = map.get(id);
      g.cost        += num(row.metrics?.costMicros);
      g.clicks      += num(row.metrics?.clicks);
      g.impressions += num(row.metrics?.impressions);
      g.conversions += num(row.metrics?.conversions);
    }
    for (const g of map.values()) {
      adGroups.push({
        id:           g.id,
        name:         g.name,
        campaignName: g.campaignName,
        spend:        usd(g.cost),
        clicks:       g.clicks,
        impressions:  g.impressions,
        ctr:          pct(g.clicks, g.impressions),
        avgCpc:       g.clicks > 0 ? usd(g.cost / g.clicks) : 0,
        conversions:  +g.conversions.toFixed(1),
      });
    }
    adGroups.sort((a, b) => b.spend - a.spend);
  }

  // ── 3. Keywords ───────────────────────────────────────────────────────────
  const keywords = [];
  if (resKW.status === 'fulfilled') {
    const map = new Map();
    for (const row of resKW.value) {
      const key = [
        row.adGroupCriterion?.keyword?.text,
        row.adGroupCriterion?.keyword?.matchType,
        row.adGroup?.name,
      ].join('|');
      if (!map.has(key)) {
        map.set(key, {
          text:         row.adGroupCriterion?.keyword?.text || '',
          matchType:    row.adGroupCriterion?.keyword?.matchType || '',
          adGroupName:  row.adGroup?.name   || '',
          campaignName: row.campaign?.name  || '',
          cost: 0, clicks: 0, impressions: 0, conversions: 0,
        });
      }
      const k = map.get(key);
      k.cost        += num(row.metrics?.costMicros);
      k.clicks      += num(row.metrics?.clicks);
      k.impressions += num(row.metrics?.impressions);
      k.conversions += num(row.metrics?.conversions);
    }
    for (const k of map.values()) {
      keywords.push({
        text:         k.text,
        matchType:    k.matchType,
        adGroupName:  k.adGroupName,
        campaignName: k.campaignName,
        spend:        usd(k.cost),
        clicks:       k.clicks,
        impressions:  k.impressions,
        ctr:          pct(k.clicks, k.impressions),
        avgCpc:       k.clicks > 0 ? usd(k.cost / k.clicks) : 0,
        conversions:  +k.conversions.toFixed(1),
      });
    }
    keywords.sort((a, b) => b.spend - a.spend);
  }

  // ── 4. Tendencia mensual ──────────────────────────────────────────────────
  const monMap = new Map();
  if (resMon.status === 'fulfilled') {
    for (const row of resMon.value) {
      const month = row.segments?.month || '';
      if (!month) continue;
      if (!monMap.has(month)) monMap.set(month, { month, cost: 0, clicks: 0, impressions: 0, conversions: 0 });
      const m = monMap.get(month);
      m.cost        += num(row.metrics?.costMicros);
      m.clicks      += num(row.metrics?.clicks);
      m.impressions += num(row.metrics?.impressions);
      m.conversions += num(row.metrics?.conversions);
    }
  }
  const monthly = [...monMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({
      month:       m.month,
      spend:       usd(m.cost),
      clicks:      m.clicks,
      impressions: m.impressions,
      conversions: +m.conversions.toFixed(1),
    }));

  // ── 5. Tendencia diaria ───────────────────────────────────────────────────
  const dayMap = new Map();
  if (resDay.status === 'fulfilled') {
    for (const row of resDay.value) {
      const date = row.segments?.date || '';
      if (!date) continue;
      if (!dayMap.has(date)) dayMap.set(date, { date, cost: 0, clicks: 0, impressions: 0 });
      const d = dayMap.get(date);
      d.cost        += num(row.metrics?.costMicros);
      d.clicks      += num(row.metrics?.clicks);
      d.impressions += num(row.metrics?.impressions);
    }
  }
  const daily = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      date:        d.date,
      spend:       usd(d.cost),
      clicks:      d.clicks,
      impressions: d.impressions,
    }));

  // ── Resumen global ────────────────────────────────────────────────────────
  const totalSpend   = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalClicks  = campaigns.reduce((s, c) => s + c.clicks, 0);
  const totalImpr    = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalConv    = campaigns.reduce((s, c) => s + c.conversions, 0);
  const hasData      = totalSpend > 0 || totalClicks > 0;
  const monthAvg     = monthly.length > 0
    ? +(monthly.reduce((s, m) => s + m.spend, 0) / monthly.length).toFixed(2)
    : null;

  // Errores parciales de queries individuales
  const partialErrors = [
    resCamp.status === 'rejected' ? `campaigns: ${resCamp.reason?.message}` : null,
    resAG.status   === 'rejected' ? `adGroups: ${resAG.reason?.message}`    : null,
    resKW.status   === 'rejected' ? `keywords: ${resKW.reason?.message}`    : null,
    resMon.status  === 'rejected' ? `monthly: ${resMon.reason?.message}`    : null,
    resDay.status  === 'rejected' ? `daily: ${resDay.reason?.message}`      : null,
  ].filter(Boolean);

  // Cache corto si no hay datos o hay errores
  res.setHeader(
    'Cache-Control',
    (hasData && !partialErrors.length)
      ? 's-maxage=600, stale-while-revalidate=120'
      : 'no-store',
  );

  return res.status(200).json({
    configured: true,
    hasData,
    period: { start: start30, end: end30, days: 30 },
    summary: hasData ? {
      spend:           +totalSpend.toFixed(2),
      clicks:          totalClicks,
      impressions:     totalImpr,
      ctr:             pct(totalClicks, totalImpr),
      avgCpc:          totalClicks > 0 ? +(totalSpend / totalClicks).toFixed(2) : 0,
      conversions:     +totalConv.toFixed(1),
      costPerConv:     totalConv > 0 ? +(totalSpend / totalConv).toFixed(2) : null,
      monthlyAvgSpend: monthAvg,
    } : null,
    campaigns,
    adGroups:  adGroups.slice(0, 30),
    keywords:  keywords.slice(0, 30),
    monthly,
    daily,
    error: partialErrors.length ? partialErrors.join(' | ') : null,
    _meta: {
      apiVersion: ADS_VERSION,
      customerId,
      dataSource: 'Google Ads API — datos exactos (no estimados)',
      queriedAt:  new Date().toISOString(),
      note: hasData ? null
        : 'Sin gasto en los últimos 30 días. Si las campañas están pausadas, ' +
          'aparecerán cuando se reactiven.',
    },
  });
};
