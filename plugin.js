/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v3.7.1
// Schedule : livesoccertv.com (México /es/ + USA)
// Streams  : iptv-org.github.io (m3u8 directos)

const LSTV_MX  = "https://www.livesoccertv.com/es/";
const LSTV_US  = "https://www.livesoccertv.com/";
const IPTV_M3U = "https://iptv-org.github.io/iptv/categories/sports.m3u";

const IPTV_KEY  = "iptv-index-v371";
const IPTV_TTL  = 6 * 60 * 60 * 1000;  // 6 horas
const SCHED_TTL = 15 * 60 * 1000;      // 15 min

const REAL_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── Utilidades ─────────────────────────────────────────────────────────────

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
  if (typeof text !== "string") return [];
  const lines = text.split("\n");
  const out = [];
  let meta = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith("#EXTINF:")) {
      const idM   = line.match(/tvg-id="([^"]+)"/);
      const nameM = line.match(/tvg-name="([^"]+)"/);
      const comma = line.lastIndexOf(",");

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

let _iptvIndex = null;

async function getIptvIndex() {
  await null;
  if (_iptvIndex) return _iptvIndex;

  const cached = kino.storage.get(IPTV_KEY);

  if (cached) {
    try {
      _iptvIndex = new Map(JSON.parse(cached));
      return _iptvIndex;
    } catch {
      /* re-fetch */
    }
  }

  try {
    const r = await kino.fetch(IPTV_M3U, {
      headers: { "User-Agent": REAL_USER_AGENT }
    });

    if (!r.ok) return new Map();

    const text = r.text();
    const channels = parseM3U(text);
    const byId = new Map();

    for (const ch of channels) {
      if (!ch.url || !ch.name) continue;
      const key = ch.channel_id || ch.name;
      const ex = byId.get(key);

      if (!ex || (!ex.url.startsWith("https") && ch.url.startsWith("https"))) {
        byId.set(key, ch);
      }
    }

    _iptvIndex = new Map();

    for (const [, ch] of byId) {
      const key = norm(ch.name);
      if (key && !_iptvIndex.has(key)) {
        _iptvIndex.set(key, { name: ch.name, url: ch.url });
      }
    }

    try {
      const ser = JSON.stringify([..._iptvIndex]);
      kino.storage.set(IPTV_KEY, ser, { ttlMs: IPTV_TTL });
    } catch {
      /* ignore */
    }

    return _iptvIndex;
  } catch {
    return new Map();
  }
}

function findIptv(index, name) {
  if (!name || !index || !index.size) return null;

  const n = norm(name);
  if (index.has(n)) return index.get(n);

  let best = null;
  let bestScore = 0;

  for (const [key, val] of index) {
    const s = similarity(n, key);
    if (s > bestScore && s >= 0.5) {
      bestScore = s;
      best = val;
    }
  }

  return best;
}

// ── Parsear HTML de LiveSoccerTV ──────────────────────────────────────────

function parseLSTV(html) {
  if (typeof html !== "string" || !html) return [];
  const matches = [];
  const normalized = html.replace(/([a-zA-Z-]+)='([^']*?)'/g, '$1="$2"');
  // Expresión regular corregida para capturar match_row, matchrow o match_row live
  const rowRe = /<tr[^>]+class="[^"]*match[_\-]?row[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;

  while ((rowM = rowRe.exec(normalized)) !== null) {
    const row = rowM[1];

    const timeM = row.match(/<td[^>]+class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const time = timeM ? timeM[1].replace(/<[^>]+>/g, "").trim() : "";

    const compM = row.match(/<td[^>]+class="[^"]*competition[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const competition = compM ? compM[1].replace(/<[^>]+>/g, "").trim() : "";

    const matchM = row.match(/<td[^>]+class="[^"]*match[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const matchTitle = matchM ? matchM[1].replace(/<[^>]+>/g, "").trim() : "";
    if (!matchTitle) continue;

    const tvM = row.match(/<td[^>]+class="[^"]*tvstation[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const channels = [];

    if (tvM) {
      const tvHtml = tvM[1];
      const linkRe = /<a[^>]+href="[^"]*\/channels\/([^/"]+)\/*"[^>]*>([^<]+)<\/a>/gi;
      let lm;

      while ((lm = linkRe.exec(tvHtml)) !== null) {
        const slug = lm[1].trim();
        const name = lm[2].trim();
        if (slug && name) channels.push({ slug, name });
      }

      if (!channels.length) {
        const cleanText = tvHtml.replace(/<[^>]+>/g, "").replace(/►/g, "").trim();
        if (cleanText) {
          const parts = cleanText.split(",").map(p => p.trim()).filter(Boolean);
          for (const p of parts) {
            channels.push({ slug: slugify(p), name: p });
          }
        }
      }
    }

    matches.push({ matchTitle, time, competition, channels });
  }

  return matches;
}

// ── Fetch del schedule ─────────────────────────────────────────────────────

async function fetchSchedule(baseUrl) {
  await null;
  try {
    const r = await kino.fetch(baseUrl, {
      headers: {
        "User-Agent": REAL_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      },
    });

    if (!r.ok) return [];
    return parseLSTV(r.text());
  } catch {
    return [];
  }
}

// ── Fusionar schedules ────────────────────────────────────────────────────

async function getDayMatches() {
  await null;
  const cacheKey = "sched-v371";
  const cached = kino.storage.get(cacheKey);

  if (cached) {
    try {
      return new Map(JSON.parse(cached));
    } catch {
      /* re-fetch */
    }
  }

  const [mxMatches, usMatches] = await Promise.all([
    fetchSchedule(LSTV_MX),
    fetchSchedule(LSTV_US),
  ]);

  const merged = new Map();

  for (const m of [...mxMatches, ...usMatches]) {
    const key = norm(m.matchTitle);
    if (!key) continue;

    if (merged.has(key)) {
      const ex = merged.get(key);
      const existingSlugs = new Set(ex.allChannels.map((c) => c.slug));

      for (const ch of m.channels) {
        if (!existingSlugs.has(ch.slug)) {
          ex.allChannels.push(ch);
        }
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
    kino.storage.set(cacheKey, ser, { ttlMs: SCHED_TTL });
  } catch {
    /* ignorar */
  }

  return merged;
}

// ── Construir ítems de canal ──────────────────────────────────────────────

function matchItems(matchKey, matchData, iptvIndex) {
  const items = [];
  const seenChannels = new Set();

  for (const ch of matchData.allChannels) {
    const iptvEntry = findIptv(iptvIndex, ch.name);
    if (!iptvEntry) continue;

    const channelNorm = norm(ch.name);
    if (seenChannels.has(channelNorm)) continue;
    seenChannels.add(channelNorm);

    const id = slugify(matchKey + "-" + channelNorm).slice(0, 128);
    const title = matchData.matchTitle + " · " + ch.name;
    const ref = "live|" + id + "|" + encodeURIComponent(iptvEntry.name);

    items.push({ id, title, ref, channelName: ch.name });
  }

  return items;
}

// ── TV EN VIVO: Categorías ────────────────────────────────────────────────

export async function liveCategories() {
  return [
    {
      id: "todos-los-eventos",
      title: "Todos los Eventos Deportivos de Hoy",
      genre: "deportes"
    }
  ];
}

// ── TV EN VIVO: Listado Completo ──────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  let index = new Map();
  let dayMatches = new Map();

  try {
    [index, dayMatches] = await Promise.all([
      getIptvIndex(),
      getDayMatches(),
    ]);
  } catch (e) {
    kino.log("Error en liveChannels:", e.message);
  }

  const PAGE = 100;
  const start = cursor ? parseInt(cursor, 10) : 0;
  const items = [];
  const seenIds = new Set();

  // 1. Partidos con reproductor/stream en vivo detectado
  for (const [key, data] of dayMatches) {
    const matchStreams = matchItems(key, data, index);
    for (const item of matchStreams) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);

      items.push({
        id: item.id,
        title: item.title,
        categoryId,
        ref: item.ref,
        badges: [data.competition, data.time].filter(Boolean).map(b => b.slice(0, 20)).slice(0, 3)
      });
    }
  }

  // 2. Todos los demás partidos agendados hoy (aunque no tengan stream directo)
  for (const [key, data] of dayMatches) {
    const matchStreams = matchItems(key, data, index);
    if (!matchStreams.length) {
      const id = slugify(key).slice(0, 128);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const chList = data.allChannels.length 
        ? " (" + data.allChannels.map(c => c.name).join(", ") + ")" 
        : "";

      items.push({
        id,
        title: data.matchTitle + chList,
        categoryId,
        ref: "live|" + id + "|sin-stream",
        badges: [data.competition, data.time].filter(Boolean).map(b => b.slice(0, 20)).slice(0, 3)
      });
    }
  }

  // 3. Canal de prueba al final como respaldo
  if (!items.length) {
    items.push({
      id: "item-prueba-hls",
      title: "Canal de Prueba · Test de Reproductor HLS",
      categoryId,
      ref: "live|test|test-stream",
      badges: ["ONLINE", "Test Stream"]
    });
  }

  const page = items.slice(start, start + PAGE);
  const next = start + PAGE < items.length ? String(start + PAGE) : undefined;

  return {
    items: page,
    next,
  };
}

// ── BÚSQUEDA ───────────────────────────────────────────────────────────────

export async function search(query) {
  const q = String(query?.q || "").trim();
  if (!q) return [];

  const [index, dayMatches] = await Promise.all([
    getIptvIndex(),
    getDayMatches(),
  ]);

  const items = [];
  const seenIds = new Set();

  for (const [key, data] of dayMatches) {
    if (norm(data.matchTitle).includes(norm(q)) || norm(data.competition).includes(norm(q))) {
      const matchStreams = matchItems(key, data, index);
      for (const item of matchStreams) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          items.push({
            id: item.id,
            title: item.title,
            kind: "live",
            ref: item.ref,
            badges: [data.competition, data.time].filter(Boolean).map(b => b.slice(0, 20)).slice(0, 3)
          });
        }
      }
    }
  }

  return items;
}

// ── RESOLVER ───────────────────────────────────────────────────────────────

export async function resolve(ref) {
  await null;
  const parts = String(ref).split("|");

  if (parts.length < 3 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  const channelName = decodeURIComponent(parts[2]);

  if (channelName === "test-stream") {
    return {
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      mime: "application/vnd.apple.mpegurl",
    };
  }

  if (channelName === "sin-stream") {
    throw kino.error(
      "unavailable",
      "Este partido está en la agenda pero no cuenta con un enlace de transmisión HLS directo."
    );
  }

  const index = await getIptvIndex();
  const entry = findIptv(index, channelName);

  if (!entry?.url) {
    throw kino.error(
      "not_found",
      "No se encontró un stream activo para: " + channelName
    );
  }

  return {
    url: entry.url,
    mime: "application/vnd.apple.mpegurl",
  };
      }
                                                     
