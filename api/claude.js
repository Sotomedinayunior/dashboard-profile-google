/**
 * api/claude.js
 * POST /api/claude
 *
 * Receives a dashboard data snapshot and calls Claude API
 * to generate a prioritized SEO action plan.
 *
 * Required env var: CLAUDE_API_KEY
 * Model: claude-haiku-4-5-20251001 (fast, cost-efficient)
 */

const CLAUDE_MODEL  = 'claude-haiku-4-5-20251001';
const CLAUDE_API    = 'https://api.anthropic.com/v1/messages';
const DOMAIN        = 'nellyrac.do';
const BUSINESS_NAME = 'Nelly RAC';
const BUSINESS_CTX  = 'empresa de alquiler de autos (rent-a-car) en República Dominicana, Santo Domingo';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY no configurada' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Body JSON inválido' });
  }

  const { gsc, ga4, serp, reviews, pagespeed } = body || {};

  // ── Build context string ──────────────────────────────────────────────────
  const lines = [];

  if (gsc) {
    lines.push('## Google Search Console (últimos 6 meses)');
    lines.push(`- Clics: ${gsc.clicks ?? '—'}`);
    lines.push(`- Impresiones: ${gsc.impressions ?? '—'}`);
    lines.push(`- CTR promedio: ${gsc.ctr ?? '—'}`);
    lines.push(`- Posición media: ${gsc.avgPos ?? '—'}`);
    if (gsc.topQueries?.length) {
      lines.push(`- Top queries: ${gsc.topQueries.slice(0,8).map(q=>`"${q.keys?.[0]||q.query}" (pos ${(q.position||0).toFixed(1)}, ${q.clicks} clics)`).join('; ')}`);
    }
    if (gsc.topPages?.length) {
      lines.push(`- Top páginas: ${gsc.topPages.slice(0,5).map(p=>`${p.keys?.[0]||p.page} (${p.clicks} clics)`).join('; ')}`);
    }
  }

  if (ga4) {
    lines.push('\n## Google Analytics 4 (últimos 6 meses)');
    lines.push(`- Sesiones: ${ga4.sessions ?? '—'}`);
    lines.push(`- Usuarios: ${ga4.users ?? '—'}`);
    lines.push(`- Engagement rate: ${ga4.engagementRate ?? '—'}`);
    lines.push(`- Páginas vistas: ${ga4.pageviews ?? '—'}`);
    if (ga4.channels?.length) {
      lines.push(`- Canales: ${ga4.channels.slice(0,5).map(c=>`${c.channel}(${c.sessions})`).join(', ')}`);
    }
  }

  if (serp) {
    lines.push('\n## Posiciones SERP Google');
    lines.push(`- Keywords rastreadas: ${serp.total ?? '—'}`);
    lines.push(`- Keywords posicionadas (top 20): ${serp.ranking ?? '—'}`);
    lines.push(`- Top 3: ${serp.top3 ?? '—'} | Top 10: ${serp.top10 ?? '—'}`);
    lines.push(`- Posición media: ${serp.avgPos ?? '—'}`);
    if (serp.keywords?.length) {
      lines.push(`- Detalle: ${serp.keywords.map(k=>`"${k.keyword}" → pos ${k.position||'N/A'}`).join('; ')}`);
    }
  }

  if (reviews) {
    lines.push('\n## Google Reviews');
    lines.push(`- Calificación: ${reviews.rating ?? '—'}/5`);
    lines.push(`- Total reseñas: ${reviews.count ?? '—'}`);
    if (reviews.dist) {
      lines.push(`- Distribución: 5★(${reviews.dist[5]||0}) 4★(${reviews.dist[4]||0}) 3★(${reviews.dist[3]||0}) 2★(${reviews.dist[2]||0}) 1★(${reviews.dist[1]||0})`);
    }
    if (reviews.recentThemes?.length) {
      lines.push(`- Temas frecuentes en reseñas: ${reviews.recentThemes.join(', ')}`);
    }
  }

  if (pagespeed) {
    lines.push('\n## PageSpeed Insights (Mobile)');
    lines.push(`- Score promedio: ${pagespeed.avgScore ?? '—'}/100`);
    lines.push(`- Páginas con score bueno (90+): ${pagespeed.good ?? '—'}`);
    lines.push(`- Páginas por mejorar (50-89): ${pagespeed.needsWork ?? '—'}`);
    lines.push(`- Páginas lentas (<50): ${pagespeed.poor ?? '—'}`);
  }

  const dataContext = lines.join('\n') || 'No se proporcionaron datos del dashboard.';

  // ── Prompt ────────────────────────────────────────────────────────────────
  const systemPrompt = `Eres un experto en SEO y marketing digital especializado en negocios locales latinoamericanos.
Tu cliente es ${BUSINESS_NAME}, una ${BUSINESS_CTX}, con dominio ${DOMAIN}.
Debes analizar los datos de rendimiento digital y generar un plan de acción concreto y priorizado.
Responde ÚNICAMENTE con un objeto JSON válido. No incluyas markdown, texto extra ni bloques de código.`;

  const userPrompt = `Analiza estos datos de rendimiento digital de ${BUSINESS_NAME}:

${dataContext}

Genera un plan de acción SEO y marketing digital priorizado. Responde con este JSON exacto (sin markdown):
{
  "diagnosis": "Diagnóstico general en 2-3 oraciones sobre la situación actual del sitio",
  "score": número del 1 al 10 representando salud digital general,
  "actions": [
    {
      "id": 1,
      "priority": "alta|media|baja",
      "category": "SEO Técnico|Contenido|Local SEO|Velocidad|Conversión|Analítica|Reseñas",
      "title": "Título corto de la acción (máx 60 chars)",
      "what": "Qué hacer exactamente (2-3 oraciones claras)",
      "why": "Por qué es importante para el negocio (1-2 oraciones)",
      "impact": "alto|medio|bajo",
      "effort": "bajo|medio|alto",
      "timeframe": "inmediato|1 semana|1 mes|3 meses"
    }
  ]
}

Genera entre 6 y 10 acciones concretas, ordenadas por prioridad descendente (alta primero).
Enfócate en acciones específicas para rent-a-car en República Dominicana.`;

  // ── Call Claude API ───────────────────────────────────────────────────────
  try {
    const response = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 2048,
        system:     systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(502).json({ error: `Claude API error ${response.status}: ${errText.slice(0,200)}` });
    }

    const claudeRes = await response.json();
    const rawText   = claudeRes.content?.[0]?.text || '';

    // Parse JSON from Claude's response
    let plan;
    try {
      // Strip any accidental markdown fences
      const clean = rawText.replace(/^```(?:json)?\n?/,'').replace(/\n?```$/,'').trim();
      plan = JSON.parse(clean);
    } catch {
      // If Claude returned something not parseable, wrap it
      plan = { diagnosis: rawText, score: null, actions: [] };
    }

    return res.status(200).json({
      ok: true,
      plan,
      model:      CLAUDE_MODEL,
      generatedAt: new Date().toISOString(),
      inputTokens:  claudeRes.usage?.input_tokens  || 0,
      outputTokens: claudeRes.usage?.output_tokens || 0,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
