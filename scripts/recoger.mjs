// Robot de Politic.IA: lee los RSS de los medios, se queda con las noticias
// políticas de las últimas 48 horas y agrupa las que hablan de lo mismo.
// Uso: node scripts/recoger.mjs            (lee los RSS de internet)
//      node scripts/recoger.mjs prueba/    (lee archivos .xml de una carpeta, para probar)
import Parser from 'rss-parser';
import { readFile, writeFile, readdir } from 'node:fs/promises';

const HORAS = 48;
const UMBRAL = 0.4;  // parecido mínimo entre titulares para considerarlos la misma noticia
const AGENTE = 'PoliticIA-bot/1.0 (+https://juanmartinfisioterapia-code.github.io/politic.ia/criterios.html)';

const medios = JSON.parse(await readFile(new URL('../medios.json', import.meta.url)));
const parser = new Parser();
const carpetaPrueba = process.argv[2];

const VACIAS = new Set(('el la los las un una unos unas de del al a en y o u que por para con sin sobre tras ante entre ' +
  'se su sus lo le les es son ser ha han hay fue era este esta estos estas ese esa eso como mas más pero no ni ya muy ' +
  'tambien también hasta desde cuando donde quien quién qué cómo dice dicen según tras hoy ayer mañana año años sus nos ' +
  'vez tiene tienen sera será sido pide pone dar hace todo todos otra otro contra primer primera dia día vea').split(' '));

const POLITICA = ['gobierno', 'congreso', 'senado', 'diputad', 'senador', 'ministr', 'presidente', 'presidenta', 'ley ',
  'psoe', 'pp ', 'vox', 'sumar', 'podemos', 'erc', 'junts', 'bildu', 'pnv', 'bng', 'parlament', 'elecciones', 'electoral',
  'moncloa', 'sánchez', 'feijóo', 'abascal', 'díaz', 'ayuso', 'alcald', 'votación', 'presupuestos', 'boe',
  'tribunal', 'fiscal', 'amnistía', 'oposición', 'coalición', 'investidura', 'decreto', 'autonómic', 'portavoz'];

const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', ndash: '–', mdash: '—' };
const entidades = t => t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10))
  : (ENT[e.toLowerCase()] ?? m));
const limpiar = t => entidades(entidades(t || '')).replace(/\s+/g, ' ').trim();
const palabras = t => new Set(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').split(' ').filter(p => p.length > 2 && !VACIAS.has(p)));
const esPolitica = t => { const x = ' ' + t.toLowerCase() + ' '; return POLITICA.some(k => x.includes(k)); };
const enDirecto = t => /en directo|en vivo|última hora|ultima hora/i.test(t);

async function leerMedio(m) {
  if (carpetaPrueba) {
    const archivos = await readdir(carpetaPrueba);
    if (!archivos.includes(m.id + '.xml')) throw new Error('sin archivo de prueba');
    return parser.parseString(await readFile(carpetaPrueba + m.id + '.xml', 'utf8'));
  }
  // Cada medio puede tener varias direcciones: se usa la primera que funcione y traiga noticias.
  const urls = Array.isArray(m.rss) ? m.rss : [m.rss];
  let error;
  for (const u of urls) {
    try {
      const f = await leerURL(u);
      if ((f.items || []).length) { f.usada = u; return f; }
      error = new Error('sin noticias');
    } catch (e) { error = e; }
  }
  throw error;
}

// Descarga con corte duro a los 15 segundos, para que ningún medio deje colgado al robot.
async function leerURL(url) {
  const r = await fetch(url, { headers: { 'User-Agent': AGENTE, 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parser.parseString(await r.text());
}

const limite = Date.now() - HORAS * 3600 * 1000;
const noticias = [];
const estado = [];

// Todos los medios a la vez; luego se procesan en el orden de la lista.
const resultados = await Promise.allSettled(medios.map(m => m.retirado ? Promise.reject(new Error('retirado a petición del medio')) : leerMedio(m)));

for (const [k, m] of medios.entries()) {
  try {
    if (resultados[k].status === 'rejected') throw resultados[k].reason;
    const feed = resultados[k].value;
    let n = 0;
    for (const it of feed.items || []) {
      const titulo = limpiar(it.title);
      const fecha = new Date(it.isoDate || it.pubDate || Date.now());
      if (!titulo || !it.link || isNaN(fecha) || fecha < limite || !esPolitica(titulo) || enDirecto(titulo)) continue;
      noticias.push({ medio: m.id, titulo, url: it.link, fecha: fecha.toISOString(), p: palabras(titulo) });
      n++;
    }
    estado.push({ medio: m.nombre, ok: true, n, rss: feed.usada });
  } catch (e) {
    estado.push({ medio: m.nombre, ok: false, n: 0, error: String(e.message).slice(0, 120) });
  }
}

// Agrupar. Las palabras que salen en muchos titulares (Sánchez, PSOE, elecciones...) cuentan poco;
// las raras (ático, Tribunal de Cuentas, Corvillo...) cuentan mucho. Dos titulares van juntos
// si comparten al menos 2 palabras raras y se parecen lo suficiente al primero del grupo.
noticias.sort((a, b) => b.fecha.localeCompare(a.fecha));
const N = noticias.length || 1;
const df = {};
for (const n of noticias) for (const w of n.p) df[w] = (df[w] || 0) + 1;
const idf = w => Math.log(N / (df[w] || 1));
const peso = s => [...s].reduce((a, w) => a + idf(w), 0);
const RARA = Math.max(2, N * 0.04);
function parecido(a, b) {
  const comunes = [...a].filter(w => b.has(w));
  if (comunes.filter(w => df[w] <= RARA).length < 2) return 0;
  return comunes.reduce((x, w) => x + idf(w), 0) / (Math.min(peso(a), peso(b)) || 1);
}
const grupos = [];
for (const n of noticias) {
  let mejor = null, max = 0;
  for (const g of grupos) {
    if (g.items.some(i => i.medio === n.medio)) continue; // un titular por medio en cada grupo
    const s = Math.max(...g.items.slice(0, 2).map(i => parecido(n.p, i.p)));
    if (s > max) { max = s; mejor = g; }
  }
  if (mejor && max >= UMBRAL) mejor.items.push(n); else grupos.push({ items: [n] });
}

// Tendencias: lo más buscado en Google en España ahora mismo (gratis, por RSS).
// Las de X (Twitter) se pueden añadir más adelante: su API cobra por consulta.
let tendencias = [];
if (!carpetaPrueba) {
  try {
    const t = await leerURL('https://trends.google.com/trending/rss?geo=ES');
    // Solo tendencias de política: que suenen a política o que coincidan con alguna noticia recogida.
    tendencias = (t.items || []).map(i => limpiar(i.title)).filter(Boolean)
      .filter(x => esPolitica(x) || noticias.some(n => [...palabras(x)].every(p => n.p.has(p)) && palabras(x).size))
      .slice(0, 10);
    estado.push({ medio: 'Google Trends', ok: true, n: tendencias.length });
  } catch (e) {
    estado.push({ medio: 'Google Trends', ok: false, n: 0, error: String(e.message).slice(0, 120) });
  }
}
const marcarTendencia = items => tendencias.find(t => {
  const pt = palabras(t);
  return pt.size && items.some(i => [...pt].every(p => i.p.has(p)));
}) || null;

const salida = {
  actualizado: new Date().toISOString(),
  tendencias,
  grupos: grupos
    .map(g => ({
      n: g.items.length,
      ultima: g.items[0].fecha,
      tendencia: marcarTendencia(g.items),
      items: g.items.map(({ p, ...resto }) => resto)
    }))
    .sort((a, b) => (!!b.tendencia - !!a.tendencia) * 0.5 + (b.n - a.n) || b.ultima.localeCompare(a.ultima))
    .slice(0, 150),
  estado
};

await writeFile(new URL('../data/noticias.json', import.meta.url), JSON.stringify(salida));

// Archivo de los últimos 30 días para el buscador: se añaden las nuevas y se borran las viejas.
const DIAS_ARCHIVO = 30;
const rutaArchivo = new URL('../data/archivo.json', import.meta.url);
let archivo = [];
try { archivo = JSON.parse(await readFile(rutaArchivo, 'utf8')); } catch {}
const vistas = new Set(archivo.map(a => a.u));
for (const n of noticias) if (!vistas.has(n.url)) archivo.push({ m: n.medio, t: n.titulo, u: n.url, f: n.fecha });
const corte = new Date(Date.now() - DIAS_ARCHIVO * 86400000).toISOString();
archivo = archivo.filter(a => a.f >= corte).sort((a, b) => b.f.localeCompare(a.f));
if (!carpetaPrueba) await writeFile(rutaArchivo, JSON.stringify(archivo));
console.log(`Medios OK: ${estado.filter(e => e.ok).length}/${medios.length} · noticias: ${noticias.length} · grupos: ${salida.grupos.length}`);
for (const e of estado.filter(e => !e.ok)) console.log(`  Falla ${e.medio}: ${e.error}`);
