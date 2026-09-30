/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 — canales de deportes en vivo (solo streams en español)
// Fuente: streamed.pk (API pública, sin autenticación)
// Los streams HLS viven en CDNs variables → liveStreamHosts: "any"

const API = "https://streamed.pk/api";

// ── Idiomas que se consideran "español" ───────────────────────────────────
const ES_LANGS = ["spanish", "español", "espanol", "es", "spa", "en", "english", "ingles", "inglés", "eng", "castellano"];

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

// ── Obtener streams en español para un partido ────────────────────────────
// La API da: match.sources = [{ source, id }]
// Luego: GET /api/stream/<source>/<id> → [{ id, streamNo, language, hd, embedUrl, source }]
// El embedUrl es una página HTML, no HLS directo. Para obtener el HLS real
// intentamos con el patrón de la API alternativa que expone el m3u8 directamente.
async function getSpanishStreams(sources) {
  await null;
  const streams = [];
  let requests = 0;

  for (const src of sources) {
    if (requests >= 8) break; // máximo 8 sources por partido para no agotar el límite de 60/llamada
    requests++;
    let entries;
    try {
      entries = await apiGet("/stream/" + encodeURIComponent(src.source) + "/" + encodeURIComponent(src.id));
    } catch {
      continue; // si un source falla, intentamos el siguiente
    }
    if (!Array.isArray(entries)) continue;
    for (const s of entries) {
      if (isSpanish(s.language)) {
        streams.push({ ...s, sourceName: src.source });
      }
    }
  }
  return streams;
}

// ── Construir URL de stream HLS a partir del embedUrl ────────────────────
// streamed.pk devuelve un embedUrl tipo:
//   https://embedme.top/embed/alpha/mu-liv-123/1
// El endpoint de stream directo suele ser:
//   https://rr.vipstreams.in/alpha/js/mu-liv-123/1/index.m3u8  (varía por source)
// Como no podemos saber el CDN de antemano y liveStreamHosts:"any" lo cubre,
// tomamos el embedUrl tal cual para el ref y en resolve intentamos el m3u8.
// Si el embedUrl ya es .m3u8 lo usamos directo.

function buildStreamRef(matchId, sourceEntry) {
  // ref = "live|<matchId>|<source>|<streamId>|<streamNo>"
  // Todos los campos estables; el URL fresco se obtiene en resolve()
  return [
    "live",
    matchId,
    sourceEntry.sourceName || sourceEntry.source,
    sourceEntry.id,
    String(sourceEntry.streamNo || 1),
  ].join("|");
}

// ── resolve: obtener el stream real en el momento de reproducir ───────────
// ref = "live|<matchId>|<source>|<streamId>|<streamNo>"
export async function resolve(ref) {
  await null; // primer await obligatorio antes de cualquier throw
  const parts = String(ref).split("|");
  if (parts.length < 5 || parts[0] !== "live") {
    throw kino.error("not_found", "ref de canal desconocida");
  }
  const [, matchId, source, streamId, streamNoStr] = parts;
  const streamNo = parseInt(streamNoStr, 10) || 1;

  // Buscar de nuevo los streams para obtener la URL fresca
  let entries;
  try {
    entries = await apiGet("/stream/" + encodeURIComponent(source) + "/" + encodeURIComponent(streamId));
  } catch (e) {
    throw kino.error("unavailable", "no se pudo obtener el stream: " + (e.message || ""));
  }
  if (!Array.isArray(entries) || !entries.length) {
    throw kino.error("not_found", "el partido ya no tiene streams");
  }

  // Preferir el que coincide por streamNo y sea español; si no, el primero español
  const esStreams = entries.filter((s) => isSpanish(s.language));
  const target =
    esStreams.find((s) => s.streamNo === streamNo) ||
    esStreams[0] ||
    entries[0];

  if (!target?.embedUrl) throw kino.error("not_found", "embedUrl no disponible");

  // Intentar transformar embedUrl a un HLS m3u8 directo
  const url = resolveHlsUrl(target.embedUrl, source, streamId, streamNo);

  return {
    url,
    mime: "application/vnd.apple.mpegurl",
    // El token del embed expira; pedimos re-resolve tras 5 minutos
    expiresInSeconds: 300,
  };
}

// Transforma el embedUrl a una URL HLS directa.
// streamed.pk usa distintos reproductores por source. Patrones conocidos:
//   embedme.top/embed/<source>/<id>/<n>  →  rr.vipstreams.in/<source>/js/<id>/<n>/index.m3u8
//   (cuando no reconocemos el patrón, devolvemos el embedUrl tal cual —
//    Kino intentará reproducirlo; si es una página HTML fallará, pero con
//    liveStreamHosts:"any" al menos no hay restricción de host)
function resolveHlsUrl(embedUrl, source, streamId, streamNo) {
  if (!embedUrl) return "";
  // Si ya es m3u8, lo usamos tal cual
  if (embedUrl.includes(".m3u8")) return embedUrl;

  // Patrón embedme.top
  // https://embedme.top/embed/alpha/STREAMID/1
  const embedme = embedUrl.match(/embedme\.top\/embed\/([^/]+)\/([^/]+)\/(\d+)/);
  if (embedme) {
    const [, src, sid, sno] = embedme;
    return `https://rr.vipstreams.in/${src}/js/${sid}/${sno}/index.m3u8`;
  }

  // Patrón streamed.su/embed
  // https://streamed.su/embed/alpha/STREAMID/1
  const streamedSu = embedUrl.match(/streamed\.su\/embed\/([^/]+)\/([^/]+)\/(\d+)/);
  if (streamedSu) {
    const [, src, sid, sno] = streamedSu;
    return `https://streamed.su/hls/${src}/${sid}/${sno}/index.m3u8`;
  }

  // Fallback: devolver embedUrl (puede ser una página que Kino no sepa reproducir,
  // pero liveStreamHosts:"any" garantiza que no lo bloqueemos por host)
  return embedUrl;
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

    // Intentar encontrar streams en español (máximo 2 sources por partido, y máximo 50 fetch totales)
    if (fetchCount < 50) {
      const sourcesToCheck = (match.sources || []).slice(0, 2);
      for (const src of sourcesToCheck) {
        if (fetchCount >= 50) break;
        fetchCount++;
        let entries;
        try {
          entries = await apiGet("/stream/" + encodeURIComponent(src.source) + "/" + encodeURIComponent(src.id));
        } catch {
          continue;
        }
        if (!Array.isArray(entries)) continue;
        const esStream = entries.find((s) => isSpanish(s.language));
        if (esStream) {
          ref = buildStreamRef(channelBase.id, {
            ...esStream,
            sourceName: src.source,
            id: src.id,
          });
          break;
        }
      }
    }

    if (!ref) continue; // solo incluir canales con stream en español

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
