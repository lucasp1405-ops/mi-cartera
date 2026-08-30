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

async function fetchCompanyNews(company) {
  // Ventana de 3 días: suficiente para tener contexto fresco sin repetir siempre lo mismo.
  const query = `${company} empresa OR acciones OR stock when:3d`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=US&ceid=US:es-419`;
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 8);
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const SYSTEM_PROMPT = `Sos un analista de inversiones de largo plazo que le arma al usuario una newsletter diaria sobre su cartera de acciones individuales.

No te limites a resumir titulares. Tu trabajo es:
- Trabajar de forma ACUMULATIVA: conectar las noticias de hoy con el "Contexto previo" que te paso (watchlist y tesis clave de la última newsletter), nunca analizar como si fuera la primera vez.
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

  const newsByCompany = {};
  for (const company of portfolio) {
    try {
      newsByCompany[company] = await fetchCompanyNews(company);
    } catch (err) {
      console.log(`Error buscando noticias de ${company}:`, err.message);
      newsByCompany[company] = [];
    }
  }

  const newsBlock = portfolio.map((company) => {
    const items = newsByCompany[company] || [];
    if (items.length === 0) return `## ${company}\n(sin noticias nuevas relevantes en los últimos días)`;
    const lines = items.map((it) => `- ${it.title}${it.source ? ` (${it.source})` : ''}${it.pubDate ? ` — ${it.pubDate}` : ''}`);
    return `## ${company}\n${lines.join('\n')}`;
  }).join('\n\n');

  const userMessage = `Contexto previo (watchlist y tesis de la última newsletter):\n${
    prevState ? JSON.stringify(prevState) : '(esta es la primera newsletter, todavía no hay contexto previo)'
  }\n\nNoticias de los últimos días por empresa:\n\n${newsBlock}\n\nEscribí la newsletter de hoy.`;

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
  if (newState) await writeFile(STATE_FILE, JSON.stringify(newState, null, 2) + '\n');

  console.log('Newsletter generada y guardada para', today);
}

main().catch((err) => {
  console.log('Error inesperado generando la newsletter:', err.message);
  process.exitCode = 1;
});
