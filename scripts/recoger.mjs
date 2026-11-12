// Robot de Politic.IA: lee los RSS de los medios, se queda con las noticias
// políticas de las últimas 48 horas y agrupa las que hablan de lo mismo.
// Uso: node scripts/recoger.mjs            (lee los RSS de internet)
//      node scripts/recoger.mjs prueba/    (lee archivos .xml de una carpeta, para probar)
import Parser from 'rss-parser';
import { readFile, writeFile, readdir } from 'node:fs/promises';

const HORAS = 48;
const UMBRAL = 0.3; // parecido mínimo entre titulares para considerarlos la misma noticia
const AGENTE = 'PoliticIA-bot/1.0 (+https://juanmartinfisioterapia-code.github.io/politicia/criterios.html)';

const medios = JSON.parse(await readFile(new URL('../medios.json', import.meta.url)));
const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': AGENTE } });
const carpetaPrueba = process.argv[2];

const VACIAS = new Set(('el la los las un una unos unas de del al a en y o u que por para con sin sobre tras ante entre ' +
  'se su sus lo le les es son ser ha han hay fue era este esta estos estas ese esa eso como mas más pero no ni ya muy ' +
  'tambien también hasta desde cuando donde quien quién qué cómo dice dicen según tras hoy ayer mañana año años sus nos').split(' '));

const POLITICA = ['gobierno', 'congreso', 'senado', 'diputad', 'senador', 'ministr', 'presidente', 'presidenta', 'ley ',
  'psoe', 'pp ', 'vox', 'sumar', 'podemos', 'erc', 'junts', 'bildu', 'pnv', 'bng', 'parlament', 'elecciones', 'electoral',
  'moncloa', 'sánchez', 'feijóo', 'abascal', 'díaz', 'ayuso', 'alcald', 'partido', 'votación', 'presupuestos', 'boe',
  'tribunal', 'fiscal', 'amnistía', 'oposición', 'coalición', 'investidura', 'decreto', 'comunidad', 'autonómic', 'portavoz'];

const limpiar = t => (t || '').replace(/\s+/g, ' ').trim();
const palabras = t => new Set(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').split(' ').filter(p => p.length > 2 && !VACIAS.has(p)));
const esPolitica = t => { const x = ' ' + t.toLowerCase() + ' '; return POLITICA.some(k => x.includes(k)); };
const parecido = (a, b) => { let c = 0; for (const p of a) if (b.has(p)) c++; return c / (Math.min(a.size, b.size) || 1); };

async function leerMedio(m) {
  if (carpetaPrueba) {
    const archivos = await readdir(carpetaPrueba);
    if (!archivos.includes(m.id + '.xml')) throw new Error('sin archivo de prueba');
    return parser.parseString(await readFile(carpetaPrueba + m.id + '.xml', 'utf8'));
  }
  return parser.parseURL(m.rss);
}

const limite = Date.now() - HORAS * 3600 * 1000;
const noticias = [];
const estado = [];

for (const m of medios) {
  if (m.retirado) { estado.push({ medio: m.nombre, ok: false, n: 0, error: 'retirado a petición del medio' }); continue; }
  try {
    const feed = await leerMedio(m);
    let n = 0;
    for (const it of feed.items || []) {
      const titulo = limpiar(it.title);
      const fecha = new Date(it.isoDate || it.pubDate || Date.now());
      if (!titulo || !it.link || isNaN(fecha) || fecha < limite || !esPolitica(titulo)) continue;
      noticias.push({ medio: m.id, titulo, url: it.link, fecha: fecha.toISOString(), p: palabras(titulo) });
      n++;
    }
    estado.push({ medio: m.nombre, ok: true, n });
  } catch (e) {
    estado.push({ medio: m.nombre, ok: false, n: 0, error: String(e.message).slice(0, 120) });
  }
}

// Agrupar: cada noticia entra en el primer grupo al que se parezca lo suficiente.
noticias.sort((a, b) => b.fecha.localeCompare(a.fecha));
const grupos = [];
for (const n of noticias) {
  let mejor = null, max = 0;
  for (const g of grupos) {
    if (g.items.some(i => i.medio === n.medio)) continue; // un titular por medio en cada grupo
    const s = Math.max(...g.items.map(i => parecido(n.p, i.p)));
    if (s > max) { max = s; mejor = g; }
  }
  if (mejor && max >= UMBRAL) mejor.items.push(n); else grupos.push({ items: [n] });
}

// Tendencias: lo más buscado en Google en España ahora mismo (gratis, por RSS).
// Las de X (Twitter) se pueden añadir más adelante: su API cobra por consulta.
let tendencias = [];
if (!carpetaPrueba) {
  try {
    const t = await parser.parseURL('https://trends.google.com/trending/rss?geo=ES');
    tendencias = (t.items || []).map(i => limpiar(i.title)).filter(Boolean).slice(0, 20);
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
console.log(`Medios OK: ${estado.filter(e => e.ok).length}/${medios.length} · noticias: ${noticias.length} · grupos: ${salida.grupos.length}`);
for (const e of estado.filter(e => !e.ok)) console.log(`  Falla ${e.medio}: ${e.error}`);
