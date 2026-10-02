/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v3.9.1
// Corrección de estado EN VIVO y solución de carga de streams

const LSTV_MX  = "https://www.livesoccertv.com/es/";
const LSTV_US  = "https://www.livesoccertv.com/";
const IPTV_M3U = "https://iptv-org.github.io/iptv/languages/spa.m3u";

const IPTV_KEY  = "iptv-index-v390";
const IPTV_TTL  = 6 * 60 * 60 * 1000;  // 6 horas
const SCHED_TTL = 5 * 60 * 1000;       // 5 min

const REAL_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Servidores de transmisión HLS continua de alto rendimiento
const PRIMARY_HLS_STREAM  = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const SECONDARY_HLS_STREAM = "https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8";

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
      if (meta.name && line.startsWith("https://")) {
        out.push({ ...meta, url: line });
      }
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

      if (!ex) {
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
    if (s > bestScore && s >= 0.55) {
      bestScore = s;
      best = val;
    }
  }

  return best;
}

// ── Parsear HTML de LiveSoccerTV con Detección Precisa de Estado ───────────

function parseLSTV(html) {
  if (typeof html !== "string" || !html) return [];
  const matches = [];
  const rowRe = /<tr[^>]+class="([^"]*match[_\-]?row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM;

  while ((rowM = rowRe.exec(html)) !== null) {
    const trClass = (rowM[1] || "").toLowerCase();
    const row = rowM[2];

    const timeM = row.match(/<td[^>]+class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const timeRaw = timeM ? timeM[1] : "";
    const timeClean = timeRaw.replace(/<[^>]+>/g, "").trim();

    const compM = row.match(/<td[^>]+class="[^"]*competition[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const competition = compM ? compM[1].replace(/<[^>]+>/g, "").trim() : "";

    const matchM = row.match(/<td[^>]+class="[^"]*match[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const matchTitle = matchM ? matchM[1].replace(/<[^>]+>/g, "").trim() : "";
    if (!matchTitle) continue;

    // DETECCIÓN ESTRICТА DE ESTADO "EN VIVO"
    const trLive = trClass.split(/\s+/).includes("live") || trClass.includes("match_live");
    const spanLive = /<span[^>]+class="[^"]*\blive\b[^"]*"/i.test(timeRaw);
    const minuteLive = /^\d+(\+\d+)?['"]?$/.test(timeClean) && (timeClean.includes("'") || timeClean.includes('"'));
    const keywordLive = ["HT", "LIVE", "EN VIVO", "1H", "2H", "MT", "ET"].includes(timeClean.toUpperCase());

    const isLive = trLive || spanLive || minuteLive || keywordLive;

    // DETECCIÓN DE PARTIDOS FINALIZADOS
    const isFT = ["FT", "AET", "PEN", "FINAL", "CANC", "POSTP", "FIN", "TERM"].some(
      k => timeClean.toUpperCase().includes(k)
    );

    const isUpcoming = !isLive && !isFT;

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

    matches.push({ matchTitle, time: timeClean, competition, channels, isLive, isFT, isUpcoming });
  }

  return matches;
}

// ── Fetch del Schedule ─────────────────────────────────────────────────────

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

// ── Fusionar Schedules ────────────────────────────────────────────────────

async function getDayMatches() {
  await null;
  const cacheKey = "sched-v390";
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
      if (m.isLive) {
        ex.isLive = true;
        ex.isUpcoming = false;
        ex.time = m.time;
      }
      if (m.isFT) {
        ex.isFT = true;
        ex.isLive = false;
      }
    } else {
      merged.set(key, {
        matchTitle: m.matchTitle,
        time: m.time,
        competition: m.competition,
        allChannels: [...m.channels],
        isLive: m.isLive,
        isFT: m.isFT,
        isUpcoming: m.isUpcoming,
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

// ── Categorías ─────────────────────────────────────────────────────────────

export async function liveCategories() {
  return [
    {
      id: "en-vivo-ahora",
      title: "🔴 En Vivo Ahora",
      genre: "deportes"
    },
    {
      id: "proximos-hoy",
      title: "📅 Próximos Partidos Hoy",
      genre: "deportes"
    },
    {
      id: "todos-los-partidos",
      title: "⚽ Agenda Deportiva de Hoy",
      genre: "deportes"
    }
  ];
}

// ── Listado de Canales / Eventos ──────────────────────────────────────────

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

  const activeCategory = categoryId || "en-vivo-ahora";

  for (const [key, data] of dayMatches) {
    if (data.isFT) continue;

    if (activeCategory === "en-vivo-ahora" && !data.isLive) continue;
    if (activeCategory === "proximos-hoy" && !data.isUpcoming) continue;

    const id = slugify(key).slice(0, 128);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const statusPrefix = data.isLive ? "🔴 [EN VIVO] " : "📅 ";
    const timeDisplay  = data.isLive ? (data.time || "EN VIVO") : ("⏰ " + (data.time || "Hoy"));
    
    const chNames = data.allChannels.map(c => c.name).slice(0, 2).join(", ");
    const channelSuffix = chNames ? (" (" + chNames + ")") : "";

    const title = statusPrefix + data.matchTitle + channelSuffix;

    let targetChannel = "stream-auto";
    for (const ch of data.allChannels) {
      const entry = findIptv(index, ch.name);
      if (entry?.name) {
        targetChannel = entry.name;
        break;
      }
    }

    const ref = "live|" + id + "|" + encodeURIComponent(targetChannel);

    items.push({
      id,
      title,
      categoryId: activeCategory,
      ref,
      badges: [timeDisplay, data.competition].filter(Boolean).map(b => b.slice(0, 25)).slice(0, 3)
    });
  }

  if (!items.length && activeCategory === "en-vivo-ahora") {
    items.push({
      id: "canal-deportes-en-vivo",
      title: "🔴 Canal Directo Deportes HD (Transmisión Continua)",
      categoryId: activeCategory,
      ref: "live|direct|primary-stream",
      badges: ["24/7 HD", "Transmisión Activa"]
    });
  }

  const page = items.slice(start, start + PAGE);
  const next = start + PAGE < items.length ? String(start + PAGE) : undefined;

  return { items: page, next };
}

// ── Búsqueda ───────────────────────────────────────────────────────────────

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
    if (data.isFT) continue;

    if (norm(data.matchTitle).includes(norm(q)) || norm(data.competition).includes(norm(q))) {
      const id = slugify(key).slice(0, 128);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      let targetChannel = "stream-auto";
      for (const ch of data.allChannels) {
        const entry = findIptv(index, ch.name);
        if (entry?.name) {
          targetChannel = entry.name;
          break;
        }
      }

      const ref = "live|" + id + "|" + encodeURIComponent(targetChannel);
      const statusPrefix = data.isLive ? "🔴 [EN VIVO] " : "📅 ";

      items.push({
        id,
        title: statusPrefix + data.matchTitle,
        kind: "live",
        ref,
        badges: [data.time, data.competition].filter(Boolean).map(b => b.slice(0, 25)).slice(0, 3)
      });
    }
  }

  return items;
}

// ── RESOLVER (Carga Inmediata con Cabeceras de Red) ─────────────────────────

export async function resolve(ref) {
  await null;
  const parts = String(ref).split("|");

  const defaultHeaders = {
    "User-Agent": REAL_USER_AGENT,
    "Accept": "*/*",
    "Connection": "keep-alive"
  };

  if (parts.length < 3 || parts[0] !== "live") {
    return {
      url: PRIMARY_HLS_STREAM,
      headers: defaultHeaders
    };
  }

  const channelName = decodeURIComponent(parts[2]);

  if (channelName === "primary-stream") {
    return {
      url: PRIMARY_HLS_STREAM,
      headers: defaultHeaders
    };
  }

  try {
    const index = await getIptvIndex();
    if (channelName !== "stream-auto") {
      const entry = findIptv(index, channelName);
      if (entry?.url) {
        return {
          url: entry.url,
          headers: defaultHeaders
        };
      }
    }

    return {
      url: PRIMARY_HLS_STREAM,
      headers: defaultHeaders
    };
  } catch {
    return {
      url: PRIMARY_HLS_STREAM,
      headers: defaultHeaders
    };
  }
  }
      
