/**
 * api/claude.js
 * POST /api/claude
 *
 * action = 'plan'  → SEO action plan (default)
 * action = 'reply' → AI-generated Google review reply
 *
 * Env var requerida: CLAUDE_API_KEY
 */

const CLAUDE_MODEL  = 'claude-haiku-4-5-20251001';
const CLAUDE_API    = 'https://api.anthropic.com/v1/messages';
const DOMAIN        = 'nellyrac.do';
const BUSINESS_NAME = 'Nelly RAC';
const BUSINESS_CTX  = 'empresa de alquiler de autos en República Dominicana, Santo Domingo';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY no configurada en Vercel' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Body JSON inválido' }); }

  const action = body.action || 'plan';

  // ── Route: review reply ────────────────────────────────────────────────────
  if (action === 'reply') {
    return handleReply(body, apiKey, res);
  }

  // ── Route: SEO action plan (default) ──────────────────────────────────────
  return handlePlan(body, apiKey, res);
};

// ═══════════════════════════════════════════════════════════════════════════════
// REPLY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handleReply(body, apiKey, res) {
  const { reviewText, stars, reviewerName, locationName } = body;
  if (!stars) return res.status(400).json({ error: 'stars requerido' });

  const firstName = (reviewerName || 'Cliente').split(' ')[0];
  const starsNum  = parseInt(stars, 10);
  const isNeg     = starsNum <= 2;
  const isNeu     = starsNum === 3;
  const isPos     = starsNum >= 4;

  const tone = isPos ? 'cálida, agradecida y entusiasta'
             : isNeu ? 'cordial, agradecida y con enfoque en mejorar'
             : 'empática, disculpándose sinceramente y ofreciendo solución';

  const systemPrompt = `Eres el community manager de Nelly RAC, empresa de alquiler de autos en República Dominicana.
Escribes respuestas a reseñas de Google en español dominicano natural y profesional.
Reglas:
- Máximo 4 oraciones
- Usa el nombre del cliente (${firstName})
- Tono ${tone}
- Menciona la sucursal "${locationName || 'Nelly RAC'}" si es relevante
- Si es negativa: pide disculpas, ofrece contacto directo (no des datos reales, solo menciona "contáctenos directamente")
- Nunca menciones que eres una IA
- Termina siempre invitando al cliente a volver o a contactarnos
- Responde SOLO con el texto de la respuesta, sin comillas ni explicaciones`;

  const userPrompt = `Reseña recibida (${starsNum} estrella${starsNum > 1 ? 's' : ''}) de ${firstName}:
"${reviewText || 'Sin comentario escrito'}"

Escribe la respuesta para esta reseña.`;

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
        max_tokens: 300,
        system:     systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      return res.status(502).json({ error: `Claude API ${response.status}: ${err.slice(0, 200)}` });
    }

    const data  = await response.json();
    const reply = data.content?.[0]?.text?.trim() || '';

    return res.status(200).json({ ok: true, reply });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePlan(body, apiKey, res) {
  const { gsc, ga4, serp, reviews, pagespeed } = body;

  // ── Construir contexto de datos ───────────────────────────────────────────
  const lines = [];

  if (gsc) {
    lines.push('## Google Search Console (últimos 6 meses)');
    lines.push(`- Clics totales: ${fmt(gsc.clicks)}`);
    lines.push(`- Impresiones: ${fmt(gsc.impressions)}`);
    lines.push(`- CTR promedio: ${gsc.ctr ?? '—'}`);
    lines.push(`- Posición media en Google: ${gsc.avgPos ?? '—'}`);
    if (gsc.topQueries?.length) {
      lines.push(`- Principales búsquedas: ${gsc.topQueries.slice(0,8)
        .map(q => `"${q.keys?.[0] || q.query}" (posición ${(+(q.position||0)).toFixed(1)}, ${q.clicks} clics)`)
        .join(' | ')}`);
    }
    if (gsc.topPages?.length) {
      lines.push(`- Páginas más visitadas: ${gsc.topPages.slice(0,5)
        .map(p => `${p.keys?.[0] || p.page} (${p.clicks} clics)`).join(' | ')}`);
    }
  }

  if (ga4) {
    lines.push('\n## Google Analytics 4 (últimos 6 meses)');
    lines.push(`- Sesiones: ${fmt(ga4.sessions)}`);
    lines.push(`- Usuarios únicos: ${fmt(ga4.users)}`);
    lines.push(`- Tasa de engagement: ${ga4.engagementRate ?? '—'}`);
    lines.push(`- Páginas vistas: ${fmt(ga4.pageviews)}`);
    if (ga4.channels?.length) {
      lines.push(`- Canales de tráfico: ${ga4.channels.slice(0,5)
        .map(c => `${c.channel || c.sessionDefaultChannelGroup}(${c.sessions})`).join(', ')}`);
    }
  }

  if (serp) {
    lines.push('\n## Posiciones en Google (SERP)');
    lines.push(`- Keywords rastreadas: ${serp.total ?? '—'}`);
    lines.push(`- Aparecen en top 20: ${serp.ranking ?? '—'} de ${serp.total ?? '—'}`);
    lines.push(`- En top 3: ${serp.top3 ?? '—'} | En primera página (top 10): ${serp.top10 ?? '—'}`);
    lines.push(`- Posición promedio: ${serp.avgPos ?? '—'}`);
    if (serp.keywords?.length) {
      lines.push(`- Detalle: ${serp.keywords
        .map(k => `"${k.keyword}" → ${k.position ? `#${k.position}` : 'no encontrado'}`).join(' | ')}`);
    }
  }

  if (reviews) {
    lines.push('\n## Reseñas en Google');
    lines.push(`- Calificación promedio: ${reviews.rating ?? '—'} / 5 estrellas`);
    lines.push(`- Número total de reseñas: ${fmt(reviews.count)}`);
    if (reviews.dist) {
      const d = reviews.dist;
      lines.push(`- Distribución: 5★=${d[5]||0}  4★=${d[4]||0}  3★=${d[3]||0}  2★=${d[2]||0}  1★=${d[1]||0}`);
    }
  }

  if (pagespeed) {
    lines.push('\n## Velocidad del sitio (PageSpeed Mobile)');
    lines.push(`- Score promedio: ${pagespeed.avgScore ?? '—'} / 100`);
    lines.push(`- Páginas rápidas (90+): ${pagespeed.good ?? '—'}`);
    lines.push(`- Páginas por mejorar (50-89): ${pagespeed.needsWork ?? '—'}`);
    lines.push(`- Páginas lentas (menos de 50): ${pagespeed.poor ?? '—'}`);
  }

  if (!lines.length) lines.push('No se proporcionaron datos. Genera recomendaciones generales para un negocio de rent-a-car en RD.');
  const dataContext = lines.join('\n');

  // ── Prompts ───────────────────────────────────────────────────────────────
  const systemPrompt = `Eres un consultor experto en marketing digital y SEO para pequeñas y medianas empresas latinoamericanas.
Estás analizando el rendimiento digital de ${BUSINESS_NAME}, una ${BUSINESS_CTX} (dominio: ${DOMAIN}).
Tu objetivo es generar un plan de acción claro, práctico y motivador, escrito en español simple y directo.
Escribe como si le hablaras directamente al dueño del negocio: sin tecnicismos innecesarios, con ejemplos concretos y pasos accionables.
Responde ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown, sin bloques de código.`;

  const userPrompt = `Aquí están los datos actuales de ${BUSINESS_NAME}:

${dataContext}

Genera un plan de acción priorizado. Usa este JSON exacto:
{
  "diagnosis": "2-3 oraciones amigables sobre la situación actual. Menciona puntos fuertes Y áreas de mejora. Escribe como si hablaras con el dueño del negocio.",
  "score": <número entero del 1 al 10>,
  "actions": [
    {
      "priority": "alta|media|baja",
      "category": "SEO Técnico|Contenido|Local SEO|Velocidad|Conversión|Analítica|Reseñas",
      "title": "Título claro y directo (máx 55 caracteres)",
      "what": "Explica qué hacer en 2-3 oraciones. Usa lenguaje simple, sin siglas. Incluye un ejemplo o paso concreto cuando sea posible.",
      "why": "1-2 oraciones explicando el beneficio real para el negocio. Enfócate en clientes, reservas o visibilidad.",
      "impact": "alto|medio|bajo",
      "effort": "bajo|medio|alto",
      "timeframe": "inmediato|1 semana|1 mes|3 meses"
    }
  ]
}

Reglas:
- Entre 7 y 9 acciones en total
- Ordénalas: alta prioridad primero, luego media, luego baja
- Sé específico para rent-a-car en República Dominicana (turismo, aeropuerto, Santo Domingo, temporadas altas)
- El campo "what" debe ser accionable, no genérico
- El campo "why" debe mencionar impacto en clientes o reservas`;

  // ── Llamar a Claude con prefill para forzar JSON ──────────────────────────
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
        max_tokens: 2500,
        system:     systemPrompt,
        messages: [
          { role: 'user',      content: userPrompt },
          { role: 'assistant', content: '{' }, // prefill: fuerza inicio JSON
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(502).json({ error: `Claude API ${response.status}: ${errText.slice(0, 300)}` });
    }

    const claudeRes = await response.json();
    // El prefill '{ ' ya está incluido, Claude continúa desde ahí
    const rawText = '{' + (claudeRes.content?.[0]?.text || '');

    const plan = extractJSON(rawText);

    return res.status(200).json({
      ok: true,
      plan,
      model:        CLAUDE_MODEL,
      generatedAt:  new Date().toISOString(),
      inputTokens:  claudeRes.usage?.input_tokens  || 0,
      outputTokens: claudeRes.usage?.output_tokens || 0,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('es-DO');
}

function extractJSON(text) {
  // 1. Try direct parse
  try { return JSON.parse(text); } catch {}

  // 2. Strip markdown fences
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(stripped); } catch {}

  // 3. Find the outermost { ... } block
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }

  // 4. Fallback — show raw text as diagnosis
  return {
    diagnosis: 'El plan fue generado pero hubo un problema al procesarlo. Por favor vuelve a intentarlo.',
    score: null,
    actions: [],
    _raw: text.slice(0, 500),
  };
}
