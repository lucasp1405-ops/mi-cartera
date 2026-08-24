// Revisa noticias nuevas de cada empresa de la cartera y, si encuentra algo, le pide a
// OneSignal que mande el aviso push. Corre desde GitHub Actions cada 20 minutos, así que
// funciona aunque el teléfono esté bloqueado o la app esté cerrada.
//
// No necesita ningún paquete externo: usa fetch, que ya viene incluido en Node 20+.
 
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
 
const APP_ID = process.env.ONESIGNAL_APP_ID;
const API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const STATE_FILE = fileURLToPath(new URL('./seen-news.json', import.meta.url));
 
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
    const link = stripCdata((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim();
    const pubDate = stripCdata((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim();
    const sourceRaw = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const source = decodeEntities(stripCdata(sourceRaw));
    if (title && link) items.push({ title, link, pubDate, source });
  }
  return items;
}
 
async function fetchCompanyNews(company) {
  // Misma consulta y misma ventana de 7 días que usa la app para no traer noticias viejas.
  const query = `${company} empresa OR acciones OR stock when:7d`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=US&ceid=US:es-419`;
  const res = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 6);
}
 
async function getPortfolioFromOneSignal() {
  const res = await fetch(`https://onesignal.com/api/v1/players?app_id=${APP_ID}&limit=300`, {
    headers: { Authorization: `Key ${API_KEY}` },
  });
  if (!res.ok) {
    console.log('No se pudo leer los dispositivos suscriptos en OneSignal:', res.status, await res.text());
    return [];
  }
  const data = await res.json();
  const set = new Set();
  for (const player of data.players || []) {
    const tag = player.tags && player.tags.portfolio;
    if (tag) tag.split('|').forEach((c) => { if (c.trim()) set.add(c.trim()); });
  }
  return [...set];
}
 
async function sendPush(title, body) {
  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${API_KEY}`,
    },
    body: JSON.stringify({
      app_id: APP_ID,
      included_segments: ['Subscribed Users'],
      headings: { en: title, es: title },
      contents: { en: body, es: body },
    }),
  });
  if (!res.ok) {
    console.log('OneSignal devolvió un error al mandar el aviso:', res.status, await res.text());
  }
}
 
async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
 
async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}
 
async function main() {
  if (!APP_ID || !API_KEY) {
    console.log('Todavía faltan los secrets ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY en el repositorio.');
    return;
  }
 
  const portfolio = await getPortfolioFromOneSignal();
  if (portfolio.length === 0) {
    console.log('Todavía nadie activó los avisos desde la app (o la cartera está vacía), no hay nada que revisar.');
    return;
  }
  console.log('Revisando noticias para:', portfolio.join(', '));
 
  const state = await loadState();
 
  for (const company of portfolio) {
    try {
      const items = await fetchCompanyNews(company);
      const isFirstCheck = !state[company];
      const alreadySeen = new Set(state[company] || []);
      const fresh = items.filter((it) => it.link && !alreadySeen.has(it.link));
 
      const merged = [...new Set([...(state[company] || []), ...items.map((it) => it.link).filter(Boolean)])].slice(-40);
      state[company] = merged;
 
      if (!isFirstCheck && fresh.length > 0) {
        const title = fresh.length === 1
          ? `Noticia nueva de ${company}`
          : `${fresh.length} noticias nuevas de ${company}`;
        await sendPush(title, fresh[0].title);
        console.log('Aviso enviado ->', title);
      } else {
        console.log(`${company}: sin novedades${isFirstCheck ? ' (primera revisión, no avisa)' : ''}.`);
      }
    } catch (err) {
      console.log(`Error revisando ${company}:`, err.message);
    }
  }
 
  await saveState(state);
}
 
try {
  await main();
} catch (err) {
  console.log('Error inesperado revisando noticias:', err.message);
  process.exitCode = 1;
}
 
