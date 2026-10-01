/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v2.1.0
// Schedule : livesoccertv.com (México /mx/ + USA en español /us-es/)
// Streams  : iptv-org.github.io (m3u8 directos, sin token)
// Canales  : cuando un partido tiene varios, el usuario elige cuál ver

const LSTV_MX  = "https://www.livesoccertv.com/mx/schedules/";   // México
const LSTV_US  = "https://www.livesoccertv.com/us-es/schedules/"; // USA en español
const IPTV_M3U = "https://iptv-org.github.io/iptv/categories/sports.m3u";

const IPTV_KEY   = "iptv-index-v2";
const IPTV_TTL   = 6 * 60 * 60 * 1000;   // 6 h
const SCHED_TTL  = 30 * 60 * 1000;        // 30 min

// ── Utilidades ─────────────────────────────────────────────────────────────

function todayStr() {
  // YYYY-MM-DD en UTC (livesoccertv usa UTC para las rutas)
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "item";
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function wordSet(s) {
  return new Set((norm(s).match(/[a-z0-9]{2,}/g) || []));
}

function similarity(a, b) {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

// ── Parsear M3U ────────────────────────────────────────────────────────────

function parseM3U(text) {
  const lines = text.split("\n");
  const out = [];
  let meta = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const idM    = line.match(/tvg-id="([^"]+)"/);
      const nameM  = line.match(/tvg-name="([^"]+)"/);
      const comma  = line.lastIndexOf(",");
      meta = {
        channel_id: idM?.[1] || "",
        name: nameM?.[1] || (comma >= 0 ? line.slice(comma + 1).trim() : ""),
      };
    } else if (line.startsWith("http") && meta) {
      if (meta.name) out.push({ ...meta, url: line });
      meta = null;
    } else if (!line.startsWith("#")) {
      meta = null;
    }
  }
  return out;
}

// ── Índice IPTV ────────────────────────────────────────────────────────────
// Map<normName, { url, name, channel_id }>

let _iptvIndex = null;

async function getIptvIndex() {
  await null;
  if (_iptvIndex) return _iptvIndex;

  const cached = kino.storage.get(IPTV_KEY);
  if (cached) {
    try { _iptvIndex = new Map(JSON.parse(cached)); return _iptvIndex; } catch { /* re-fetch */ }
  }

  let text;
  try {
    const r = await kino.fetch(IPTV_M3U);
    if (!r.ok) throw kino.error("unavailable", "IPTV-org " + r.status);
    text = r.text();
  } catch (e) {
    if (e.kinoCode) throw e;
    throw kino.error("unavailable", "no se pudo cargar la lista IPTV");
  }

  const channels = parseM3U(text);
  kino.log("IPTV sports:", channels.length, "entradas");

  // Un canal puede tener varios streams; preferir https
  const byId = new Map();
  for (const ch of channels) {
    if (!ch.url || !ch.name) continue;
    const ex = byId.get(ch.channel_id);
    if (!ex || (!ex.url.startsWith("https") && ch.url.startsWith("https"))) {
      byId.set(ch.channel_id, ch);
    }
  }

  _iptvIndex = new Map();
  for (const [, ch] of byId) {
    const key = norm(ch.name);
    if (key && !_iptvIndex.has(key)) _iptvIndex.set(key, ch);
  }

  try {
    const ser = JSON.stringify([..._iptvIndex]);
    if (ser.length < 250000) kino.storage.set(IPTV_KEY, ser, { ttlMs: IPTV_TTL });
  } catch { /* ignorar */ }

  return _iptvIndex;
}

function findIptv(index, name) {
  if (!name || !index.size) return null;
  const n = norm(name);
  if (index.has(n)) return index.get(n);
  let best = null, bestScore = 0;
  for (const [key, val] of index) {
    const s = similarity(n, key);
    if (s > bestScore && s >= 0.5) { bestScore = s; best = val; }
  }
  return best;
}

// ── Parsear HTML de livesoccertv ───────────────────────────────────────────
// Devuelve: [{ matchTitle, time, competition, channels: [{ name, slug }] }]
//
// Estructura HTML relevante (simplificada):
//   <tr class="matchrow ...">
//     <td class="time">HH:MM</td>
//     <td class="competition">Liga MX</td>
//     <td class="match"><a>Equipo A vs Equipo B</a></td>
//     <td class="tvstation"><a href="/channels/espn-mexico/">ESPN México</a> ...</td>
//   </tr>

function parseLSTV(html) {
  const matches = [];
  // Normalizar comillas simples en atributos a dobles para simplificar el parsing
  const normalized = html.replace(/([a-z]+=)'([^']*?)'/gi, '$1"$2"');
  const rowRe = /<tr[^>]+class="[^"]*matchrow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;
  while ((rowM = rowRe.exec(normalized)) !== null) {
    const row = rowM[1];

    const timeM = row.match(/<td[^>]+class="[^"]*time[^"]*"[^>]*>([^<]+)</i);
    const time = timeM ? timeM[1].trim() : "";

    const compM = row.match(/<td[^>]+class="[^"]*competition[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const competition = compM ? compM[1].replace(/<[^>]+>/g, "").trim() : "";

    const matchM = row.match(/<td[^>]+class="[^"]*match[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const matchTitle = matchM ? matchM[1].replace(/<[^>]+>/g, "").trim() : "";

    if (!matchTitle) continue;

    const tvM = row.match(/<td[^>]+class="[^"]*tvstation[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const channels = [];
    if (tvM) {
      const linkRe = /<a[^>]+href="[^"]*\/channels\/([^/"]+)\/"[^>]*>([^<]+)<\/a>/gi;
      let lm;
      while ((lm = linkRe.exec(tvM[1])) !== null) {
        const slug = lm[1].trim();
        const name = lm[2].trim();
        if (slug && name) channels.push({ slug, name });
      }
    }

    if (channels.length) {
      matches.push({ matchTitle, time, competition, channels });
    }
  }
  return matches;
}

// ── Fetch del schedule ─────────────────────────────────────────────────────

async function fetchSchedule(baseUrl, date) {
  await null;
  const url = baseUrl + date + "/";
  let r;
  try {
    r = await kino.fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Kino/3.0)",
        "Accept-Language": "es-MX,es;q=0.9",
      },
    });
  } catch (e) {
    kino.log("fetchSchedule error:", url, e.message);
    return [];
  }
  if (!r.ok) { kino.log("fetchSchedule HTTP", r.status, url); return []; }
  return parseLSTV(r.text());
}

// ── Fusionar schedules MX + US ────────────────────────────────────────────
// Devuelve: Map<matchTitle_norm, { matchTitle, time, competition, allChannels: [{name,slug}] }>

async function getDayMatches() {
  await null;
  const date = todayStr();
  const cacheKey = "sched-" + date;

  const cached = kino.storage.get(cacheKey);
  if (cached) {
    try { return new Map(JSON.parse(cached)); } catch { /* re-fetch */ }
  }

  const [mxMatches, usMatches] = await Promise.all([
    fetchSchedule(LSTV_MX, date),
    fetchSchedule(LSTV_US, date),
  ]);

  // Fusionar por título normalizado
  const merged = new Map();

  for (const m of [...mxMatches, ...usMatches]) {
    const key = norm(m.matchTitle);
    if (!key) continue;
    if (merged.has(key)) {
      // Agregar canales que no estén ya
      const ex = merged.get(key);
      const existingSlugs = new Set(ex.allChannels.map((c) => c.slug));
      for (const ch of m.channels) {
        if (!existingSlugs.has(ch.slug)) ex.allChannels.push(ch);
      }
    } else {
      merged.set(key, {
        matchTitle: m.matchTitle,
        time: m.time,
        competition: m.competition,
        allChannels: [...m.channels],
      });
    }
  }

  try {
    const ser = JSON.stringify([...merged]);
    if (ser.length < 200000) kino.storage.set(cacheKey, ser, { ttlMs: SCHED_TTL });
  } catch { /* ignorar */ }

  return merged;
}

// ── Construir ítems de canal para Kino ────────────────────────────────────
// Cada canal disponible para un partido se convierte en un ítem separado
// con el nombre del canal en el título → el usuario elige cuál ver.
//
// ref = "live|<matchId>|<channelNorm>"

function matchItems(matchKey, matchData, iptvIndex) {
  const items = [];
  const seenChannels = new Set();

  for (const ch of matchData.allChannels) {
    const iptvEntry = findIptv(iptvIndex, ch.name);
    if (!iptvEntry) continue;
    const channelNorm = norm(ch.name);
    if (seenChannels.has(channelNorm)) continue;
    seenChannels.add(channelNorm);

    // id único por partido+canal
    const id = slugify(matchKey + "-" + channelNorm).slice(0, 128);
    const title = matchData.matchTitle + " · " + ch.name;
    const ref = "live|" + id + "|" + encodeURIComponent(iptvEntry.name);

    items.push({ id, title, ref, channelName: ch.name });
  }
  return items;
}

// ── home ──────────────────────────────────────────────────────────────────

export async function home() {
  await null;

  const [index, dayMatches] = await Promise.all([
    getIptvIndex(),
    getDayMatches(),
  ]).catch((e) => { throw e; });

  if (!dayMatches.size) return [];

  const withStream = [];
  const withoutStream = [];

  for (const [key, data] of dayMatches) {
    const items = matchItems(key, data, index);
    if (items.length) withStream.push({ key, data, items });
    else withoutStream.push({ key, data });
  }

  const rows = [];
  const seenIds = new Set();

  // Fila 1: partidos con stream disponible (hasta 60 ítems)
  if (withStream.length) {
    const rowItems = [];
    for (const { data, items } of withStream) {
      for (const item of items) {
        if (seenIds.has(item.id) || rowItems.length >= 60) continue;
        seenIds.add(item.id);
        rowItems.push({
          id: item.id,
          title: item.title,
          kind: "live",
          ref: item.ref,
          badges: [data.competition, data.time].filter(Boolean).slice(0, 2),
        });
      }
    }
    if (rowItems.length) {
      rows.push({ id: "con-stream", title: "Partidos de hoy con stream disponible", items: rowItems });
    }
  }

  // Fila 2: partidos sin stream disponible (informativos, hasta 60)
  if (withoutStream.length) {
    const rowItems = [];
    for (const { key, data } of withoutStream.slice(0, 60)) {
      const id = slugify(key).slice(0, 128);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      rowItems.push({
        id,
        title: data.matchTitle,
        kind: "live",
        ref: "live|" + id + "|sin-stream",
        badges: [data.competition, data.time].filter(Boolean).slice(0, 2),
      });
    }
    if (rowItems.length) {
      rows.push({ id: "sin-stream", title: "Más partidos de hoy (sin stream)", items: rowItems });
    }
  }

  return rows.slice(0, 20);
}

// ── liveCategories ────────────────────────────────────────────────────────
// Usamos las competiciones que aparecen en el schedule como categorías

export async function liveCategories() {
  await null;

  const dayMatches = await getDayMatches();
  const comps = new Map(); // norm → { id, title }

  for (const [, data] of dayMatches) {
    if (!data.competition) continue;
    const id = slugify(data.competition);
    if (!id || comps.has(id)) continue;
    comps.set(id, { id, title: data.competition });
  }

  if (!comps.size) {
    return [{ id: "futbol", title: "Fútbol" }];
  }

  return [...comps.values()].slice(0, 200);
}

// ── liveChannels ──────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  const [index, dayMatches] = await Promise.all([getIptvIndex(), getDayMatches()]);

  const PAGE = 40;
  const start = cursor ? parseInt(cursor, 10) : 0;

  // Filtrar partidos de esta categoría
  const filtered = [];
  for (const [key, data] of dayMatches) {
    const compId = slugify(data.competition);
    if (compId !== categoryId) continue;
    filtered.push([key, data]);
  }

  const page = filtered.slice(start, start + PAGE);
  const next = start + PAGE < filtered.length ? String(start + PAGE) : undefined;

  const items = [];
  const seenIds = new Set();

  for (const [key, data] of page) {
    const matchItems2 = matchItems(key, data, index);
    for (const item of matchItems2) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push({
        id: item.id,
        title: item.title,
        categoryId,
        ref: item.ref,
      });
    }
    // Si el partido no tiene stream en IPTV, igual lo mostramos (sin ref de stream)
    if (!matchItems2.length) {
      const id = slugify(key).slice(0, 128);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        items.push({
          id,
          title: data.matchTitle,
          categoryId,
          ref: "live|" + id + "|sin-stream",
        });
      }
    }
  }

  return { items: items.slice(0, 500), next };
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
    throw kino.error("unavailable", "este partido no tiene stream disponible en IPTV-org");
  }

  const index = await getIptvIndex();
  const entry = findIptv(index, channelName);

  if (!entry?.url) {
    throw kino.error("not_found", "no se encontró stream para: " + channelName);
  }

  return {
    url: entry.url,
    mime: "application/vnd.apple.mpegurl",
  };
}
