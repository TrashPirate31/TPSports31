/// <reference path="./sdk/kino.d.ts" />
// StreamedIPTV31
// Schedule: streamed.pk (eventos del día, partidos en vivo)
// Streams:  iptv-org.github.io (m3u8 directos, sin token, sin WASM)
//
// Lógica de emparejamiento:
//   streamed.pk  →  source:"admin", id:"ppv-nfl-network"
//   IPTV-org     →  channel_id:"NFLNetwork.us", url: "https://..."
//   Se empareja por similitud de nombre (fuzzy match).

const STREAMED_API = "https://streamed.pk/api";
const IPTV_SPORTS_M3U = "https://iptv-org.github.io/iptv/categories/sports.m3u";
const IPTV_STREAMS_JSON = "https://iptv-org.github.io/api/streams.json";

// ── Cachés en memoria (duran lo que dure la sesión del sandbox) ───────────
let iptvIndex = null;      // Map<nombreNormalizado, { url, channel_id }>
const IPTV_TTL = 6 * 60 * 60 * 1000; // 6 horas en storage
const IPTV_KEY = "iptv-sports-index";
const SPORTS_KEY = "sports-list";
const SPORTS_TTL = 12 * 60 * 60 * 1000;

// ── Normalizar texto para comparación fuzzy ───────────────────────────────
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Extrae palabras significativas (>2 chars)
function words(s) {
  return norm(s).split("").reduce((acc, c, i, arr) => {
    // reconstruir palabras del string normalizado
    return acc;
  }, norm(s).match(/[a-z0-9]{2,}/g) || []);
}

// Puntuación de similitud entre dos strings normalizados
function similarity(a, b) {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

// ── Parsear M3U de IPTV-org ───────────────────────────────────────────────
// Formato:
//   #EXTINF:-1 tvg-id="NFLNetwork.us" tvg-name="NFL Network" ...,NFL Network
//   https://...index.m3u8
function parseM3U(text) {
  const lines = text.split("\n");
  const channels = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      // extraer tvg-id y tvg-name
      const idMatch = line.match(/tvg-id="([^"]+)"/);
      const nameMatch = line.match(/tvg-name="([^"]+)"/);
      const commaIdx = line.lastIndexOf(",");
      const displayName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : "";
      meta = {
        channel_id: idMatch?.[1] || "",
        name: nameMatch?.[1] || displayName,
      };
    } else if (line.startsWith("http") && meta) {
      channels.push({ ...meta, url: line });
      meta = null;
    } else if (!line.startsWith("#")) {
      meta = null;
    }
  }
  return channels;
}

// ── Construir índice IPTV (nombre normalizado → stream) ───────────────────
async function getIptvIndex() {
  await null;

  // 1. Memoria
  if (iptvIndex) return iptvIndex;

  // 2. Storage
  const cached = kino.storage.get(IPTV_KEY);
  if (cached) {
    try {
      iptvIndex = new Map(JSON.parse(cached));
      return iptvIndex;
    } catch { /* corrupto, re-fetch */ }
  }

  // 3. Fetch M3U deportes
  let m3uText;
  try {
    const r = await kino.fetch(IPTV_SPORTS_M3U);
    if (!r.ok) throw kino.error("unavailable", "IPTV-org respondió " + r.status);
    m3uText = r.text();
  } catch (e) {
    if (e.kinoCode) throw e;
    throw kino.error("unavailable", "no se pudo obtener la lista de canales IPTV");
  }

  const channels = parseM3U(m3uText);
  kino.log("IPTV-org sports: " + channels.length + " canales cargados");

  // Construir índice: nombre normalizado → mejor URL (https primero)
  // Guardamos también channel_id para deduplicar
  const tempMap = new Map(); // channel_id → { name, url }
  for (const ch of channels) {
    if (!ch.url || !ch.name) continue;
    const existing = tempMap.get(ch.channel_id);
    // Preferir https sobre http
    if (!existing || (!existing.url.startsWith("https") && ch.url.startsWith("https"))) {
      tempMap.set(ch.channel_id, { name: ch.name, url: ch.url, channel_id: ch.channel_id });
    }
  }

  // Índice por nombre normalizado (puede haber varios nombres para un canal)
  iptvIndex = new Map();
  for (const [, ch] of tempMap) {
    const key = norm(ch.name);
    if (key && !iptvIndex.has(key)) {
      iptvIndex.set(key, { url: ch.url, channel_id: ch.channel_id, name: ch.name });
    }
  }

  // Guardar en storage (serializar como array de pares)
  try {
    const serialized = JSON.stringify([...iptvIndex]);
    if (serialized.length < 250000) { // respetar límite 256 KB
      kino.storage.set(IPTV_KEY, serialized, { ttlMs: IPTV_TTL });
    }
  } catch { /* ignorar error de storage */ }

  return iptvIndex;
}

// ── Buscar el mejor stream IPTV para un nombre de canal ───────────────────
function findIptvStream(index, channelName) {
  if (!channelName || !index.size) return null;
  const normName = norm(channelName);

  // Coincidencia exacta primero
  if (index.has(normName)) return index.get(normName);

  // Fuzzy: buscar el que tenga mayor similitud
  let best = null;
  let bestScore = 0;
  for (const [key, val] of index) {
    const score = similarity(normName, key);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = val;
    }
  }
  return best;
}

// ── Extraer nombre de canal del id de streamed.pk ─────────────────────────
// Ejemplos:
//   "ppv-nfl-network"        → "NFL Network"
//   "admin-tennis-channel"   → "Tennis Channel"
//   "ppv-sky-sports-golf"    → "Sky Sports Golf"
//   "ppv-fox-cricket"        → "Fox Cricket"
function channelNameFromId(id) {
  return String(id || "")
    .replace(/^ppv-|^admin-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Fetch helper ──────────────────────────────────────────────────────────
async function apiGet(path) {
  let r;
  try {
    r = await kino.fetch(STREAMED_API + path);
  } catch (e) {
    if (e.code === "timeout") throw kino.error("unavailable", "streamed.pk tardó demasiado");
    throw kino.error("unavailable", "sin conexión con streamed.pk");
  }
  if (r.status === 429) throw kino.error("rate_limited");
  if (r.status === 451) throw kino.error("geo_blocked");
  if (!r.ok) throw kino.error("unavailable", "streamed.pk " + r.status);
  return r.json();
}

// ── Obtener deportes (cacheados) ──────────────────────────────────────────
async function getSports() {
  await null;
  const cached = kino.storage.get(SPORTS_KEY);
  if (cached) return JSON.parse(cached);
  const sports = await apiGet("/sports");
  if (!Array.isArray(sports)) throw kino.error("unavailable", "sin deportes");
  kino.storage.set(SPORTS_KEY, JSON.stringify(sports), { ttlMs: SPORTS_TTL });
  return sports;
}

// ── Slugify para IDs de Kino ──────────────────────────────────────────────
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "item";
}

// ── Construir ref estable ─────────────────────────────────────────────────
// ref = "live|<matchId>|<channelName urlencoded>"
// En resolve() buscamos el stream IPTV por channelName en ese momento
function buildRef(matchId, channelName) {
  return "live|" + matchId + "|" + encodeURIComponent(channelName);
}

// ── Convertir partido + canal IPTV a LiveChannel de Kino ─────────────────
function matchToChannel(match, categoryId, iptvStream) {
  const rawId = String(match.id || "");
  const id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
  const home = match.teams?.home?.name;
  const away = match.teams?.away?.name;
  const title = home && away ? `${home} vs ${away}` : (match.title || "Partido en vivo");
  let logo;
  const badge = match.teams?.home?.badge;
  if (badge) logo = `https://streamed.pk/api/images/badge/${encodeURIComponent(badge)}.webp`;

  return {
    id,
    title: title.slice(0, 200),
    categoryId,
    ref: buildRef(id, iptvStream.name),
    logo,
    stream: undefined,
  };
}

// ── liveCategories ────────────────────────────────────────────────────────
export async function liveCategories() {
  const sports = await getSports();
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

// ── liveChannels ──────────────────────────────────────────────────────────
export async function liveChannels({ categoryId, cursor }) {
  await null;

  // Cargar índice IPTV y deportes en paralelo
  const [index, sports] = await Promise.all([getIptvIndex(), getSports()]);

  const sport = sports.find((s) => slugify(s.id || s.name || "") === categoryId);
  const sportId = sport?.id || categoryId;

  let matches;
  try {
    matches = await apiGet("/matches/" + encodeURIComponent(sportId));
  } catch {
    return { items: [] };
  }
  if (!Array.isArray(matches) || !matches.length) return { items: [] };

  // Paginación
  const PAGE = 40;
  const start = cursor ? parseInt(cursor, 10) : 0;
  const page = matches.slice(start, start + PAGE);
  const next = start + PAGE < matches.length ? String(start + PAGE) : undefined;

  const items = [];
  const seen = new Set();

  for (const match of page) {
    // Para partidos con source "admin", el id del canal está en sources[0].id
    // Ej: { source: "admin", id: "ppv-nfl-network" }
    // Para otros sources (golf, delta, hotel), el partido no tiene canal fijo
    // sino que es un evento → buscamos por título del partido o categoría

    let channelName = null;

    // Buscar nombre de canal en las sources
    for (const src of (match.sources || [])) {
      if (src.source === "admin") {
        channelName = channelNameFromId(src.id);
        break;
      }
    }

    // Si no hay canal admin, intentar con el título del partido
    // (a veces streamed.pk pone directamente el nombre del canal como título)
    if (!channelName && match.title) {
      // Solo si el título parece un canal (no tiene "vs")
      if (!match.title.includes(" vs ") && !match.title.includes(" v ")) {
        channelName = match.title;
      }
    }

    if (!channelName) continue; // partido sin canal identificable

    // Buscar stream en IPTV-org
    const iptvStream = findIptvStream(index, channelName);
    if (!iptvStream) {
      kino.log("Sin stream IPTV para:", channelName);
      continue;
    }

    const rawId = String(match.id || "");
    const id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (seen.has(id)) continue;
    seen.add(id);

    const ch = matchToChannel(match, categoryId, iptvStream);
    items.push(ch);
  }

  return { items, next };
}

// ── home ──────────────────────────────────────────────────────────────────
export async function home() {
  await null;

  const [index, matches] = await Promise.all([
    getIptvIndex(),
    apiGet("/matches/all-today").catch(() => []),
  ]);

  if (!Array.isArray(matches) || !matches.length) return [];

  // Separar en dos grupos: con canal identificable y sin él
  const withChannel = [];
  const withoutChannel = [];

  for (const match of matches.slice(0, 200)) {
    let channelName = null;
    for (const src of (match.sources || [])) {
      if (src.source === "admin") {
        channelName = channelNameFromId(src.id);
        break;
      }
    }
    if (!channelName && match.title && !match.title.includes(" vs ")) {
      channelName = match.title;
    }

    if (channelName) {
      const iptvStream = findIptvStream(index, channelName);
      if (iptvStream) {
        withChannel.push({ match, channelName, iptvStream });
        continue;
      }
    }
    withoutChannel.push({ match, channelName });
  }

  const rows = [];
  const seen = new Set();

  // Fila 1: partidos con canal en IPTV (hasta 60)
  if (withChannel.length) {
    const items = [];
    for (const { match, iptvStream } of withChannel.slice(0, 60)) {
      const rawId = String(match.id || "");
      const id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
      if (seen.has(id)) continue;
      seen.add(id);
      const home = match.teams?.home?.name;
      const away = match.teams?.away?.name;
      const title = home && away ? `${home} vs ${away}` : (match.title || "Partido");
      let poster;
      const badge = match.teams?.home?.badge;
      if (badge) poster = `https://streamed.pk/api/images/badge/${encodeURIComponent(badge)}.webp`;

      items.push({
        id,
        title: title.slice(0, 200),
        kind: "live",
        ref: buildRef(id, iptvStream.name),
        poster,
        badges: [match.category ? String(match.category).slice(0, 20) : undefined].filter(Boolean),
      });
    }
    if (items.length) {
      rows.push({ id: "eventos-con-stream", title: "Eventos de hoy con stream disponible", items });
    }
  }

  // Fila 2: partidos populares sin canal en IPTV (informativos, hasta 60)
  const popularSin = withoutChannel.filter((x) => x.match.popular).slice(0, 60);
  if (popularSin.length) {
    const items = [];
    for (const { match } of popularSin) {
      const rawId = String(match.id || "");
      const id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
      if (seen.has(id)) continue;
      seen.add(id);
      const home = match.teams?.home?.name;
      const away = match.teams?.away?.name;
      const title = home && away ? `${home} vs ${away}` : (match.title || "Partido");
      let poster;
      const badge = match.teams?.home?.badge;
      if (badge) poster = `https://streamed.pk/api/images/badge/${encodeURIComponent(badge)}.webp`;

      // Ref vacío — estos no tienen stream disponible todavía
      // Los incluimos para que el usuario sepa qué hay hoy
      items.push({
        id,
        title: title.slice(0, 200),
        kind: "live",
        ref: "live|" + id + "|sin-stream",
        poster,
        badges: [match.category ? String(match.category).slice(0, 20) : undefined].filter(Boolean),
      });
    }
    if (items.length) {
      rows.push({ id: "eventos-sin-stream", title: "Más eventos de hoy", items });
    }
  }

  return rows.slice(0, 20);
}

// ── resolve ───────────────────────────────────────────────────────────────
// ref = "live|<matchId>|<channelName urlencoded>"
export async function resolve(ref) {
  await null;
  const parts = String(ref).split("|");
  if (parts.length < 3 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }
  const channelName = decodeURIComponent(parts[2]);
  if (channelName === "sin-stream") {
    throw kino.error("unavailable", "este evento no tiene stream disponible en IPTV-org");
  }

  // Buscar stream en IPTV-org
  const index = await getIptvIndex();
  const iptvStream = findIptvStream(index, channelName);

  if (!iptvStream?.url) {
    throw kino.error("not_found", "no se encontró stream para: " + channelName);
  }

  return {
    url: iptvStream.url,
    mime: "application/vnd.apple.mpegurl",
  };
}
