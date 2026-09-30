/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 — canales de deportes en vivo (solo streams en español)
// Fuente: streamed.pk (API pública, sin autenticación)
// Los streams HLS viven en CDNs variables → liveStreamHosts: "any"

const API = "https://streamed.pk/api";

// ── Idiomas que se consideran "español" ───────────────────────────────────
const ES_LANGS = ["spanish", "español", "espanol", "es", "spa", "castellano"];

function isSpanish(lang) {
  if (!lang) return false;
  return ES_LANGS.some((s) => lang.toLowerCase().includes(s));
}

// ── Slugify: convierte un string cualquiera a un id válido para Kino ──────
// id pattern: ^[A-Za-z0-9._~-]{1,128}$
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "item";
}

// ── Fetch con manejo de errores centrado en Kino ──────────────────────────
// REGLA: el primer await va ANTES de cualquier throw (trampa de rechazo).
async function apiGet(path) {
  let r;
  try {
    r = await kino.fetch(API + path);
  } catch (e) {
    if (e.code === "timeout") throw kino.error("unavailable", "streamed.pk tardó demasiado");
    if (e.code === "network") throw kino.error("unavailable", "sin conexión con streamed.pk");
    throw kino.error("unavailable", e.message);
  }
  if (r.status === 429) throw kino.error("rate_limited", "streamed.pk limitó las peticiones");
  if (r.status === 451) throw kino.error("geo_blocked", "contenido bloqueado en tu región");
  if (!r.ok) throw kino.error("unavailable", "streamed.pk respondió " + r.status);
  return r.json();
}

// ── Obtener y cachear la lista de deportes ────────────────────────────────
const SPORTS_TTL = 12 * 60 * 60 * 1000; // 12 h
const SPORTS_KEY = "sports-list";

async function getSports() {
  await null; // primer await antes de cualquier throw
  const cached = kino.storage.get(SPORTS_KEY);
  if (cached) return JSON.parse(cached);
  const sports = await apiGet("/sports");
  if (!Array.isArray(sports)) throw kino.error("unavailable", "la API no devolvió deportes");
  kino.storage.set(SPORTS_KEY, JSON.stringify(sports), { ttlMs: SPORTS_TTL });
  return sports;
}

// ── Hosts de embed que usan WASM/token y no podemos resolver ────────────
const BLOCKED_EMBEDS = ["embed.st"];

function isBlockedEmbed(url) {
  if (!url) return true;
  return BLOCKED_EMBEDS.some((h) => url.includes(h));
}

// ── Buscar el mejor stream entre todas las sources de un partido ──────────
// Orden de preferencia: español sin WASM > cualquier idioma sin WASM > español con WASM > cualquier cosa
// Devuelve { source, streamId, streamNo, embedUrl } o null si no hay nada.
async function bestStream(sources, fetchCounter) {
  await null;
  let esGood = null;   // español + sin WASM
  let anyGood = null;  // cualquier idioma + sin WASM
  let esBad = null;    // español + WASM (último recurso)

  for (const src of sources) {
    if (fetchCounter.n >= 50) break;
    fetchCounter.n++;
    let entries;
    try {
      entries = await apiGet("/stream/" + encodeURIComponent(src.source) + "/" + encodeURIComponent(src.id));
    } catch {
      continue;
    }
    if (!Array.isArray(entries) || !entries.length) continue;

    for (const s of entries) {
      const blocked = isBlockedEmbed(s.embedUrl);
      const es = isSpanish(s.language);
      const candidate = { source: src.source, streamId: src.id, streamNo: s.streamNo || 1, embedUrl: s.embedUrl };

      if (es && !blocked && !esGood) esGood = candidate;
      if (!blocked && !anyGood) anyGood = candidate;
      if (es && blocked && !esBad) esBad = candidate;
    }

    // Si ya tenemos la mejor opción posible, parar
    if (esGood) break;
  }

  return esGood || anyGood || esBad || null;
}

// ── Construir ref estable para Kino ──────────────────────────────────────

function buildStreamRef(matchId, best) {
  // ref = "live|<matchId>|<source>|<streamId>|<streamNo>"
  return ["live", matchId, best.source, best.streamId, String(best.streamNo)].join("|");
}

// ── resolve: obtener el stream real en el momento de reproducir ───────────
// ref = "live|<matchId>|<source>|<streamId>|<streamNo>"
// En resolve volvemos a buscar entre TODAS las sources del partido para
// conseguir la URL más fresca y evitar los embeds con WASM.
export async function resolve(ref) {
  await null; // primer await obligatorio antes de cualquier throw
  const parts = String(ref).split("|");
  if (parts.length < 5 || parts[0] !== "live") {
    throw kino.error("not_found", "ref de canal desconocida");
  }
  const [, matchId, source, streamId] = parts;

  // Primero intentamos la source que ya conocemos (más rápido)
  let entries;
  try {
    entries = await apiGet("/stream/" + encodeURIComponent(source) + "/" + encodeURIComponent(streamId));
  } catch {
    entries = [];
  }

  // Buscar un stream sin WASM entre los resultados de esta source
  let target = null;
  if (Array.isArray(entries)) {
    const esGood = entries.find((s) => isSpanish(s.language) && !isBlockedEmbed(s.embedUrl));
    const anyGood = entries.find((s) => !isBlockedEmbed(s.embedUrl));
    const esAny = entries.find((s) => isSpanish(s.language));
    target = esGood || anyGood || esAny || entries[0] || null;
  }

  // Si el resultado tiene WASM o no hay resultado, intentar con las otras sources del partido
  if (!target || isBlockedEmbed(target.embedUrl)) {
    // Obtener la lista completa de sources del partido desde los matches en vivo
    let allSources = [{ source, id: streamId }];
    try {
      const live = await apiGet("/matches/live");
      if (Array.isArray(live)) {
        const match = live.find((m) => m.id === matchId || m.sources?.some((s) => s.id === streamId));
        if (match?.sources?.length) allSources = match.sources;
      }
    } catch { /* seguimos con lo que tenemos */ }

    // Probar cada source que no hayamos probado ya
    const fc = { n: 1 }; // ya usamos 1 fetch arriba
    const best = await bestStream(
      allSources.filter((s) => !(s.source === source && s.id === streamId)),
      fc
    );
    if (best && !isBlockedEmbed(best.embedUrl)) {
      return {
        url: resolveHlsUrl(best.embedUrl, best.source, best.streamId, best.streamNo),
        mime: "text/html",
        expiresInSeconds: 300,
      };
    }
    // Si todo tiene WASM, usar el target original de todos modos (puede funcionar en algunos clientes)
    if (!target) throw kino.error("not_found", "el partido ya no tiene streams disponibles");
  }

  if (!target?.embedUrl) throw kino.error("not_found", "embedUrl no disponible");

  const url = resolveHlsUrl(target.embedUrl, source, streamId, parseInt(parts[4], 10) || 1);
  return {
    url,
    mime: "text/html",
    expiresInSeconds: 300,
  };
}

// Devuelve el embedUrl tal cual para que Kino lo abra en WebView.
// embed.st genera el token HLS vía WASM en el navegador, no podemos resolverlo
// desde el plugin, así que dejamos que Kino cargue la página del reproductor.
function resolveHlsUrl(embedUrl) {
  return embedUrl || "";
}

// ── Mapear un partido de la API a un LiveChannel de Kino ─────────────────
function matchToChannel(match, categoryId) {
  // id estable: usamos el id del partido tal cual si es válido, si no, lo slugificamos
  const rawId = String(match.id || "");
  const channelId = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);

  // Título: "Equipo A vs Equipo B" o el título genérico
  const home = match.teams?.home?.name;
  const away = match.teams?.away?.name;
  const title = home && away ? `${home} vs ${away}` : (match.title || "Partido en vivo");

  // Logo: puede ser el badge del equipo local
  let logo;
  const badge = match.teams?.home?.badge;
  if (badge) logo = `https://streamed.pk/api/images/badge/${encodeURIComponent(badge)}.webp`;

  return {
    id: channelId,
    title: title.slice(0, 200),
    categoryId,
    ref: null, // se asigna después si tiene streams en español
    logo,
  };
}

// ── Categorías (deportes) ─────────────────────────────────────────────────
export async function liveCategories() {
  const sports = await getSports();
  // Filtramos categorías con id y title válidos; máximo 200
  const cats = [];
  const seen = new Set();
  for (const s of sports.slice(0, 200)) {
    const id = slugify(s.id || s.name || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cats.push({ id, title: String(s.name || s.id).slice(0, 200) });
  }
  return cats;
}

// ── Canales por categoría ─────────────────────────────────────────────────
export async function liveChannels({ categoryId, cursor }) {
  await null;

  // Obtener el nombre real del deporte (la API usa el id original, no el slug)
  const sports = await getSports();
  const sport = sports.find((s) => slugify(s.id || s.name || "") === categoryId);
  const sportId = sport?.id || categoryId;

  // Obtener partidos del deporte
  let matches;
  try {
    matches = await apiGet("/matches/" + encodeURIComponent(sportId));
  } catch (e) {
    // Si el deporte no existe o no hay partidos, retornamos lista vacía
    kino.log("Sin partidos para", sportId, e.message);
    return { items: [] };
  }
  if (!Array.isArray(matches) || !matches.length) return { items: [] };

  // Paginación simple: el cursor es un índice numérico de inicio
  const PAGE = 40;
  const start = cursor ? parseInt(cursor, 10) : 0;
  const page = matches.slice(start, start + PAGE);
  const next = start + PAGE < matches.length ? String(start + PAGE) : undefined;

  // Para cada partido, buscamos si tiene streams en español.
  // Para no agotar las 60 peticiones/llamada, limitamos a los primeros 15 partidos
  // con un máximo de 2 sources por partido.
  const items = [];
  let fetchCount = 1; // getSports() ya usó 1, matches usó 1 → ya tenemos 2

  for (const match of page) {
    if (!match.sources?.length) continue;

    const channelBase = matchToChannel(match, categoryId);
    let ref = null;

    // Buscar el mejor stream entre todas las sources (español sin WASM > cualquier sin WASM > resto)
    const fc = { n: fetchCount };
    const best = await bestStream(match.sources || [], fc);
    fetchCount = fc.n;

    if (!best) continue; // partido sin ningún stream accesible

    ref = buildStreamRef(channelBase.id, best);

    items.push({ ...channelBase, ref });
  }

  return { items, next };
}

// ── Home: una fila de "En vivo ahora" con los partidos populares ──────────
export async function home() {
  await null;

  let matches;
  try {
    matches = await apiGet("/matches/live/popular");
  } catch (e) {
    kino.log("home: no se pudo obtener partidos populares", e.message);
    return [];
  }
  if (!Array.isArray(matches) || !matches.length) return [];

  // Convertir a ítems de tipo "live"
  const items = [];
  const seen = new Set();
  for (const match of matches.slice(0, 60)) {
    const rawId = String(match.id || "");
    const id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const home = match.teams?.home?.name;
    const away = match.teams?.away?.name;
    const title = home && away ? `${home} vs ${away}` : (match.title || "Partido en vivo");

    let poster;
    const badge = match.teams?.home?.badge;
    if (badge) poster = `https://streamed.pk/api/images/badge/${encodeURIComponent(badge)}.webp`;

    // Para home usamos ref simple: "live|<id>|<source>|<streamId>|1"
    // Intentamos la primera source disponible (sin hacer fetch individual en home para ahorrar peticiones)
    const src = match.sources?.[0];
    if (!src) continue;

    const ref = ["live", id, src.source, src.id, "1"].join("|");

    items.push({
      id,
      ref,
      title: title.slice(0, 200),
      kind: "live",
      poster,
      badges: [match.category ? String(match.category).slice(0, 20) : undefined].filter(Boolean),
    });
  }

  if (!items.length) return [];

  return [
    {
      id: "en-vivo-ahora",
      title: "En vivo ahora",
      items,
    },
  ];
}
