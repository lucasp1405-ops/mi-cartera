// Genera la newsletter de inversión del día: busca noticias recientes de cada empresa de
// scripts/portfolio.json y le pide a Claude que arme el análisis (siguiendo un marco de
// trabajo acumulativo: conecta con la newsletter anterior, distingue noticia de tesis, busca
// patrones y ganadores/perdedores de segundo orden, mantiene una watchlist clasificada).
// El resultado se guarda en newsletters.json, que la app lee y muestra.
//
// No necesita ningún paquete externo: usa fetch, que ya viene incluido en Node 20+.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const EMAIL_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.NEWSLETTER_EMAIL_TO;

const PORTFOLIO_FILE = fileURLToPath(new URL('./portfolio.json', import.meta.url));
const STATE_FILE = fileURLToPath(new URL('./newsletter-state.json', import.meta.url));
const OUTPUT_FILE = fileURLToPath(new URL('../newsletters.json', import.meta.url));

const MAX_ENTRIES = 30;

function decodeEntities(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripCdata(str) {
  return (str || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const title = decodeEntities(stripCdata((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''));
    const pubDate = stripCdata((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
    const sourceRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const source = decodeEntities(stripCdata(sourceRaw));
    if (title) items.push({ title, pubDate, source });
  }
  return items;
}

async function fetchRss(query, limit) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=US&ceid=US:es-419`;
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, limit);
}

async function fetchCompanyNews(company) {
  // Ventana de 3 días: suficiente para tener contexto fresco sin repetir siempre lo mismo.
  return fetchRss(`${company} empresa OR acciones OR stock when:3d`, 8);
}

// Noticias generales del mercado, sin atarse a ninguna empresa puntual: tasas de interés,
// inflación, la Fed, geopolítica, aranceles, Wall Street. Esto es lo que permite detectar
// efectos indirectos sobre las empresas de la cartera (algo que no se ve en la búsqueda por
// nombre de empresa, porque estas noticias no las mencionan directamente).
const MARKET_QUERIES = [
  'Wall Street mercado bursátil hoy when:2d',
  'Reserva Federal tasas de interés inflación when:2d',
  'aranceles comercio geopolítica economía global when:2d',
];

async function fetchMarketNews() {
  const all = [];
  for (const query of MARKET_QUERIES) {
    try {
      all.push(...(await fetchRss(query, 6)));
    } catch (err) {
      console.log('Error buscando noticias generales del mercado:', err.message);
    }
  }
  // Dedup por título, por si dos búsquedas traen el mismo artículo.
  const seen = new Set();
  return all.filter((it) => {
    if (seen.has(it.title)) return false;
    seen.add(it.title);
    return true;
  }).slice(0, 15);
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function escapeHtmlBasic(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Convierte el texto plano de la newsletter (con los títulos con emoji) a un HTML simple
// para el cuerpo del mail.
function newsletterTextToHtml(text) {
  const headerRegex = /^(🔥|📈|⚠️|🆕|🔎|🎯)\s*(.+)$/;
  const paragraphs = (text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => {
    const lines = p.split('\n');
    const m = lines[0].match(headerRegex);
    if (m) {
      const rest = lines.slice(1).map(escapeHtmlBasic).join('<br>');
      return `<h3 style="margin:22px 0 6px;font-size:16px;">${escapeHtmlBasic(lines[0])}</h3>` +
        (rest ? `<p style="margin:0 0 4px;line-height:1.55;">${rest}</p>` : '');
    }
    return `<p style="margin:0 0 4px;line-height:1.55;">${lines.map(escapeHtmlBasic).join('<br>')}</p>`;
  }).join('');
}

async function sendNewsletterEmail(dateLabel, newsletterText) {
  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#14151A;">
    <h2 style="margin:0 0 4px;">📰 Newsletter de inversión</h2>
    <div style="opacity:0.6;font-size:13px;margin-bottom:10px;">${escapeHtmlBasic(dateLabel)}</div>
    ${newsletterTextToHtml(newsletterText)}
  </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMAIL_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Mi Cartera <onboarding@resend.dev>',
      to: [EMAIL_TO],
      subject: `📰 Newsletter de inversión — ${dateLabel}`,
      html,
    }),
  });

  if (!res.ok) {
    console.log('Error mandando el mail:', res.status, await res.text());
  } else {
    console.log('Mail enviado a', EMAIL_TO);
  }
}

const SYSTEM_PROMPT = `Sos un analista de inversiones de largo plazo que le arma al usuario una newsletter diaria sobre su cartera de acciones individuales.

No te limites a resumir titulares. Tu trabajo es:
- Trabajar de forma ACUMULATIVA: conectar las noticias de hoy con el "Contexto previo" que te paso (watchlist y tesis clave de la última newsletter), nunca analizar como si fuera la primera vez.
- Te paso dos bloques de noticias: "Noticias generales del mercado" (macro, tasas, geopolítica, Wall Street — no mencionan ninguna empresa puntual) y "Noticias por empresa". Tu trabajo más importante es CONECTARLOS: explicar cómo esas noticias generales afectan (para bien o para mal) a cada empresa de la cartera, aunque la noticia general no la nombre directamente. Eso es lo que hace que esto sea un reporte de "cómo el mercado afecta a mis acciones", no una lista de noticias sueltas.
- Extraer qué es información nueva, qué confirma una tesis previa, qué la contradice, qué abre una oportunidad nueva y qué riesgo nuevo aparece.
- Distinguir noticia de tesis: ante un dato (ej. "sube 10%"), explicar por qué pasó y qué implica, no solo reportarlo.
- Buscar patrones entre varias noticias sueltas que cuenten la misma historia, y efectos de segundo/tercer orden (ej. IA → electricidad → cobre → minería).
- Mantener una watchlist clasificada por convicción: 🟢 interesante, 🟢🟢 muy interesante, 🟢🟢🟢 prioridad alta, 🟡 esperar, 🔴 evitar.
- Separar siempre calidad de la empresa del atractivo del precio actual (una empresa excelente puede ser mala inversión si está cara, y viceversa).
- Buscar ventaja competitiva real y "picks and shovels" (quién vende las herramientas de una tendencia), no solo el producto final visible.
- Evaluar riesgos de segundo orden, no solo el lado positivo de cada noticia.
- Distinguir cambios cíclicos de cambios estructurales.
- No inventar datos que no estén en las noticias que te paso; si agregás una inferencia propia, aclaralo como tal.
- Horizonte de largo plazo (5-10 años), pero sin ignorar el precio de entrada.
- Si una noticia solo confirma algo ya sabido, decilo brevemente en vez de reexplicar todo de nuevo.
- Si no hay noticias relevantes de alguna empresa, decilo en una línea en vez de forzar contenido.

Devolvé la respuesta en ESPAÑOL, en texto plano (sin markdown, sin asteriscos), con este formato exacto:

🔥 Lo más importante
(3-6 puntos que cambian el panorama)

📈 Empresas que mejoran
(qué empresas/sectores tienen tesis más fuerte, y por qué)

⚠️ Empresas que empeoran
(qué tesis están perdiendo fuerza, y por qué)

🆕 Nuevas oportunidades
(empresas o sectores que deberían entrar en la watchlist)

🔎 Qué vigilar
(datos o eventos que van a confirmar o descartar la tesis)

🎯 Conclusión
(qué cambia concretamente respecto a la visión anterior)

Después de la newsletter, en una línea aparte, escribí exactamente:
---ESTADO---
y a continuación un JSON compacto (una sola línea, sin explicación adicional) con esta forma, para usarlo como contexto en la próxima newsletter:
{"watchlist":[{"empresa":"...","rating":"🟢🟢🟢|🟢🟢|🟢|🟡|🔴","nota":"motivo breve"}],"tesis_clave":["..."]}`;

async function main() {
  if (!API_KEY) {
    console.log('Falta el secret ANTHROPIC_API_KEY en el repositorio.');
    process.exitCode = 1;
    return;
  }

  const portfolio = await loadJson(PORTFOLIO_FILE, []);
  if (portfolio.length === 0) {
    console.log('scripts/portfolio.json está vacío — no hay nada que analizar.');
    return;
  }
  console.log('Empresas en la cartera:', portfolio.join(', '));

  const prevState = await loadJson(STATE_FILE, null);

  console.log('Buscando noticias generales del mercado...');
  const marketNews = await fetchMarketNews();

  const newsByCompany = {};
  for (const company of portfolio) {
    try {
      newsByCompany[company] = await fetchCompanyNews(company);
    } catch (err) {
      console.log(`Error buscando noticias de ${company}:`, err.message);
      newsByCompany[company] = [];
    }
  }

  const marketBlock = marketNews.length
    ? marketNews.map((it) => `- ${it.title}${it.source ? ` (${it.source})` : ''}${it.pubDate ? ` — ${it.pubDate}` : ''}`).join('\n')
    : '(sin noticias generales relevantes en los últimos días)';

  const newsBlock = portfolio.map((company) => {
    const items = newsByCompany[company] || [];
    if (items.length === 0) return `## ${company}\n(sin noticias nuevas relevantes en los últimos días)`;
    const lines = items.map((it) => `- ${it.title}${it.source ? ` (${it.source})` : ''}${it.pubDate ? ` — ${it.pubDate}` : ''}`);
    return `## ${company}\n${lines.join('\n')}`;
  }).join('\n\n');

  const userMessage = `Contexto previo (watchlist y tesis de la última newsletter):\n${
    prevState ? JSON.stringify(prevState) : '(esta es la primera newsletter, todavía no hay contexto previo)'
  }\n\nNoticias generales del mercado (macro, tasas, geopolítica — no atadas a ninguna empresa):\n${marketBlock}\n\nNoticias de los últimos días por empresa de la cartera:\n\n${newsBlock}\n\n(Usá las noticias generales del mercado para explicar efectos indirectos sobre las empresas de la cartera, además de lo que diga cada noticia puntual.)\n\nEscribí la newsletter de hoy.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    console.log('Error llamando a la API de Claude:', res.status, await res.text());
    process.exitCode = 1;
    return;
  }

  const data = await res.json();
  const fullText = (data.content || []).map((b) => b.text || '').join('').trim();

  const [newsletterTextRaw, stateJsonRaw] = fullText.split('---ESTADO---');
  const cleanText = (newsletterTextRaw || fullText).trim();

  let newState = prevState;
  if (stateJsonRaw) {
    try {
      newState = JSON.parse(stateJsonRaw.trim());
    } catch (e) {
      console.log('No se pudo leer el estado nuevo (se conserva el anterior):', e.message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const existing = await loadJson(OUTPUT_FILE, { entries: [] });
  const entries = [
    { date: today, text: cleanText },
    ...(existing.entries || []).filter((e) => e.date !== today),
  ].slice(0, MAX_ENTRIES);

  await writeFile(OUTPUT_FILE, JSON.stringify({ updated: new Date().toISOString(), entries }, null, 2) + '\n');
  // Siempre guardamos el archivo de estado, aunque Claude no haya devuelto el bloque
  // ---ESTADO--- con el formato esperado, para que el commit de más abajo nunca falle
  // por falta de este archivo.
  await writeFile(STATE_FILE, JSON.stringify(newState || {}, null, 2) + '\n');

  console.log('Newsletter generada y guardada para', today);

  if (EMAIL_API_KEY && EMAIL_TO) {
    try {
      await sendNewsletterEmail(today, cleanText);
    } catch (err) {
      console.log('Error inesperado mandando el mail:', err.message);
    }
  } else {
    console.log('No se configuraron RESEND_API_KEY / NEWSLETTER_EMAIL_TO — no se manda mail (la newsletter queda igual en la app).');
  }
}

main().catch((err) => {
  console.log('Error inesperado generando la newsletter:', err.message);
  process.exitCode = 1;
});
