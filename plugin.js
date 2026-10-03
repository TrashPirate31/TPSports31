/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v5.1.1
// Schedule : livesoccertv.com (solo partidos EN VIVO ahora)
// Streams  : canales.m3u en el repo (streams directos)

const LSTV_MX = "https://www.livesoccertv.com/es/";
const LSTV_US = "https://www.livesoccertv.com/";
const MY_M3U  = "https://raw.githubusercontent.com/TrashPirate31/TPSports31/refs/heads/main/canales.m3u";

const M3U_KEY = "my-canales-v500";
const M3U_TTL = 60 * 60 * 1000; // 1 hora

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// ── Utilidades ──────────────────────────────────────────────────────────────

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

// ── Parsear M3U ─────────────────────────────────────────────────────────────

function parseM3U(text) {
  if (typeof text !== "string") return [];
  const lines = text.split("\n");
  const out = [];
  let meta = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const nameM = line.match(/tvg-name="([^"]+)"/);
      const comma = line.lastIndexOf(",");
      meta = { name: nameM && nameM[1] || (comma >= 0 ? line.slice(comma + 1).trim() : "") };
    } else if (line.startsWith("http") && meta) {
      if (meta.name) out.push({ name: meta.name, url: line });
      meta = null;
    } else if (!line.startsWith("#")) {
      meta = null;
    }
  }
  return out;
}

// ── Índice de canales (desde tu repo) ───────────────────────────────────────

let _index = null;

async function getIndex() {
  await null;
  if (_index) return _index;

  const cached = kino.storage.get(M3U_KEY);
  if (cached) {
    try { _index = new Map(JSON.parse(cached)); return _index; } catch { /* re-fetch */ }
  }

  let text = "";
  try {
    const r = await kino.fetch(MY_M3U, { headers: { "User-Agent": UA } });
    if (r && r.ok) text = r.text();
  } catch { /* seguir con índice vacío */ }

  const channels = parseM3U(text);
  _index = new Map();
  for (const ch of channels) {
    const key = norm(ch.name);
    if (key && !_index.has(key)) _index.set(key, { name: ch.name, url: ch.url });
  }

  kino.log("Canales cargados:", _index.size);

  try {
    const ser = JSON.stringify([..._index]);
    if (ser.length < 250000) kino.storage.set(M3U_KEY, ser, { ttlMs: M3U_TTL });
  } catch { /* ignorar */ }

  return _index;
}

function findChannel(index, name) {
  if (!name || !index.size) return null;
  const n = norm(name);
  if (index.has(n)) return index.get(n);
  let best = null, bestScore = 0;
  for (const [key, val] of index) {
    const s = similarity(n, key);
    if (s > bestScore && s >= 0.55) { bestScore = s; best = val; }
  }
  return best;
}

// ── Parsear HTML de livesoccertv ────────────────────────────────────────────

function parseLSTV(html) {
  if (typeof html !== "string" || !html) return [];
  const matches = [];
  const rowRe = /<tr[^>]+class="([^"]*match[_-]?row[^"]*)"[^>]*>([\s\S]*?)<\/tr>/gi;
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

    // Solo partidos en vivo ahora
    const trLive     = trClass.split(/\s+/).includes("live") || trClass.includes("match_live");
    const spanLive   = /<span[^>]+class="[^"]*\blive\b[^"]*"/i.test(timeRaw);
    const minuteLive = /^\d+(\+\d+)?['"]?$/.test(timeClean);
    const keyLive    = ["HT","LIVE","EN VIVO","1H","2H","MT","ET"].includes(timeClean.toUpperCase());
    if (!trLive && !spanLive && !minuteLive && !keyLive) continue;

    const tvM = row.match(/<td[^>]+class="[^"]*tvstation[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const channels = [];
    if (tvM) {
      const linkRe = /<a[^>]+href="[^"]*\/channels\/([^/"]+)\/*"[^>]*>([^<]+)<\/a>/gi;
      let lm;
      while ((lm = linkRe.exec(tvM[1])) !== null) {
        const slug = lm[1].trim();
        const name = lm[2].trim();
        if (slug && name) channels.push({ slug, name });
      }
      if (!channels.length) {
        const clean = tvM[1].replace(/<[^>]+>/g, "").replace(/►/g, "").trim();
        for (const p of clean.split(",").map(p => p.trim()).filter(Boolean)) {
          channels.push({ slug: slugify(p), name: p });
        }
      }
    }

    matches.push({ matchTitle, time: timeClean, competition, channels });
  }
  return matches;
}

// ── Fetch del schedule ───────────────────────────────────────────────────────

async function fetchSchedule(url) {
  await null;
  try {
    const r = await kino.fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      },
    });
    if (!r && r.ok) return [];
    return parseLSTV(r.text());
  } catch {
    return [];
  }
}

// ── Partidos en vivo (sin caché — siempre fresco) ───────────────────────────

async function getLiveMatches() {
  await null;
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
      const seen = new Set(ex.channels.map(c => c.slug));
      for (const ch of m.channels) {
        if (!seen.has(ch.slug)) ex.channels.push(ch);
      }
    } else {
      merged.set(key, {
        matchTitle: m.matchTitle,
        time: m.time,
        competition: m.competition,
        channels: [...m.channels],
      });
    }
  }
  return merged;
}

// ── liveCategories ───────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  return [
    { id: "en-vivo-ahora", title: "🔴 En Vivo Ahora" },
    { id: "canal-prueba",  title: "📡 Canal de Prueba" },
  ];
}

// ── liveChannels ─────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  if (categoryId === "canal-prueba") {
    return {
      items: [{
        id: "canal-prueba-tudn",
        title: "TUDN (Prueba)",
        categoryId: "canal-prueba",
        ref: "live|prueba|TUDN",
      }]
    };
  }

  const [index, liveMatches] = await Promise.all([getIndex(), getLiveMatches()]);
  const items = [];
  const seenIds = new Set();

  for (const [key, data] of liveMatches) {
    const id = slugify(key).slice(0, 128);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    let targetChannel = null;
    for (const ch of data.channels) {
      const entry = findChannel(index, ch.name);
      if (entry && entry.name) { targetChannel = entry.name; break; }
    }

    const chNames = data.channels.map(c => c.name).slice(0, 2).join(", ");
    const title = "🔴 " + data.matchTitle + (chNames ? " (" + chNames + ")" : "");
    const ref = "live|" + id + "|" + encodeURIComponent(targetChannel || "sin-stream");

    items.push({
      id,
      title,
      categoryId: "en-vivo-ahora",
      ref,
      badges: [data.time || "EN VIVO", data.competition].filter(Boolean).map(b => b.slice(0, 25)),
    });
  }

  if (!items.length) {
    items.push({
      id: "sin-partidos-ahora",
      title: "No hay partidos en vivo en este momento",
      categoryId: "en-vivo-ahora",
      ref: "live|vacio|sin-stream",
    });
  }

  return { items };
}

// ── search ───────────────────────────────────────────────────────────────────

export async function search(query) {
  await null;
  const q = String((query && query.q) || "").trim();
  if (!q) return [];

  const [index, liveMatches] = await Promise.all([getIndex(), getLiveMatches()]);
  const items = [];
  const seenIds = new Set();

  for (const [key, data] of liveMatches) {
    if (!norm(data.matchTitle).includes(norm(q)) && !norm(data.competition).includes(norm(q))) continue;
    const id = slugify(key).slice(0, 128);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    let targetChannel = null;
    for (const ch of data.channels) {
      const entry = findChannel(index, ch.name);
      if (entry && entry.name) { targetChannel = entry.name; break; }
    }

    items.push({
      id,
      title: "🔴 " + data.matchTitle,
      kind: "live",
      ref: "live|" + id + "|" + encodeURIComponent(targetChannel || "sin-stream"),
      badges: [data.time, data.competition].filter(Boolean).map(b => b.slice(0, 25)),
    });
  }

  return items;
}

// ── resolve ───────────────────────────────────────────────────────────────────

export async function resolve(ref) {
  await null;
  const parts = String(ref).split("|");
  if (parts.length < 3 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  const channelName = decodeURIComponent(parts[2]);

  if (channelName === "sin-stream" || channelName === "") {
    throw kino.error("unavailable", "Este partido no tiene stream disponible por el momento");
  }

  const index = await getIndex();
  const entry = findChannel(index, channelName);

  if (!entry && entry.url) {
    throw kino.error("unavailable", "Canal no disponible: " + channelName);
  }

  return {
    url: entry.url,
    mime: "application/vnd.apple.mpegurl",
  };
}
