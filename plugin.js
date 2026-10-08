/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v9.0.0
// Categorías = APIs: DaddyLive, StreamFree, BinTV, WatchFooty, DamiTV
// Streams: kino.browser.capture en resolve()
// Hora: México Central (UTC-6)

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

// ── Fuentes ───────────────────────────────────────────────────────────────────
var SOURCES = {
  "daddylive": {
    id: "daddylive",
    title: "DaddyLive",
    base: "https://daddylive.mov",
  },
  "streamfree": {
    id: "streamfree",
    title: "StreamFree",
    base: "https://streamfree.top",
  },
  "bintv": {
    id: "bintv",
    title: "BinTV",
    base: "https://bintvjson.lovable.app",
  },
  "watchfooty": {
    id: "watchfooty",
    title: "WatchFooty",
    base: "https://api.watchfooty.st",
  },
  "damitv": {
    id: "damitv",
    title: "DamiTV",
    base: "https://ondemand.st",
  },
};

// ── Hora México Central (UTC-6) ───────────────────────────────────────────────
function toMXTime(timestamp) {
  // timestamp en ms o segundos
  var ms = timestamp > 9999999999 ? timestamp : timestamp * 1000;
  var d = new Date(ms - 6 * 60 * 60 * 1000); // UTC-6
  var h = d.getUTCHours();
  var m = d.getUTCMinutes();
  var ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm + " MX";
}

function isLive(status) {
  if (!status) return false;
  var s = String(status).toLowerCase();
  return s === "live" || s === "in" || s === "inprogress" || s === "1";
}

function isUpcoming(status) {
  if (!status) return false;
  var s = String(status).toLowerCase();
  return s === "upcoming" || s === "pre" || s === "scheduled" || s === "0";
}

// ── Slugify / safeId ──────────────────────────────────────────────────────────
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "item";
}

function safeId(src, raw) {
  var s = src + "-" + slugify(String(raw || "")).slice(0, 80);
  if (/^[A-Za-z0-9._~-]{1,128}$/.test(s)) return s;
  return s.replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 128);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function getJSON(url) {
  await null;
  var r;
  try {
    r = await kino.fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
  } catch (e) {
    throw kino.error("unavailable", "Sin conexión: " + url.split("/")[2]);
  }
  if (r.status === 429) throw kino.error("rate_limited");
  if (!r.ok) throw kino.error("unavailable", "Error " + r.status);
  return r.json();
}

// ── Normalizar eventos de cada API ────────────────────────────────────────────
// Devuelve: [{ id, title, embedUrls, status, time, sport }]

async function fetchDaddyLive() {
  await null;
  var data = await getJSON("https://daddylive.mov/api/events");
  var cats = data.categories || {};
  var out = [];
  for (var cat in cats) {
    if (!Object.prototype.hasOwnProperty.call(cats, cat)) continue;
    var events = cats[cat];
    if (!Array.isArray(events)) continue;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.event || !ev.channels || !ev.channels.length) continue;
      var urls = ev.channels.map(function(c) { return c.url; }).filter(Boolean);
      if (!urls.length) continue;
      out.push({
        id: safeId("dl", ev.event + (ev.time || "")),
        title: String(ev.event),
        embedUrls: urls,
        status: "live",
        time: ev.time || "",
        sport: cat,
      });
    }
  }
  return out;
}

async function fetchStreamFree() {
  await null;
  var data = await getJSON("https://streamfree.top/api/v1/streams");
  var streams = data.streams || [];
  var out = [];
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if (!s.name || !s.sources || !s.sources.length) continue;
    out.push({
      id: safeId("sf", s.id || s.stream_key || s.name),
      title: String(s.name),
      embedUrls: s.sources.filter(Boolean),
      status: "live",
      time: "",
      sport: s.category || "",
    });
  }
  return out;
}

async function fetchBinTV() {
  await null;
  var data = await getJSON("https://bintvjson.lovable.app/api/public/bintvjson");
  var live = data["Live Events"] || [];
  var upcoming = data["Upcoming Events"] || [];
  var out = [];

  for (var i = 0; i < live.length; i++) {
    var ev = live[i];
    if (!ev.name) continue;
    var urls = (ev.streams || []).map(function(s) { return s.url; }).filter(Boolean);
    out.push({
      id: safeId("bt", ev.id || ev.name),
      title: String(ev.name),
      embedUrls: urls,
      status: "live",
      time: "",
      sport: ev.category || "",
      poster: ev.poster || "",
    });
  }

  for (var j = 0; j < upcoming.length; j++) {
    var uev = upcoming[j];
    if (!uev.name) continue;
    var utime = uev.starts_at ? toMXTime(uev.starts_at) : "";
    out.push({
      id: safeId("bt", uev.id || uev.name),
      title: String(uev.name),
      embedUrls: [],
      status: "upcoming",
      time: utime,
      sport: uev.category || "",
      poster: uev.poster || "",
    });
  }
  return out;
}

async function fetchWatchFooty() {
  await null;
  var live = [];
  var upcoming = [];
  try {
    var liveData = await getJSON("https://api.watchfooty.st/api/v1/matches/live");
    live = Array.isArray(liveData) ? liveData : (liveData.matches || []);
  } catch (e) { /* continuar */ }
  try {
    var upData = await getJSON("https://api.watchfooty.st/api/v1/matches/upcoming");
    upcoming = Array.isArray(upData) ? upData : (upData.matches || []);
  } catch (e) { /* continuar */ }

  var out = [];
  for (var i = 0; i < live.length; i++) {
    var m = live[i];
    if (!m.title && !m.name) continue;
    var title = m.title || m.name;
    var urls = (m.streams || []).map(function(s) { return s.url || s.embedUrl || ""; }).filter(Boolean);
    out.push({
      id: safeId("wf", m.matchId || m.id || title),
      title: String(title),
      embedUrls: urls,
      status: "live",
      time: m.currentMinute || "",
      sport: m.sport || m.league || "",
      poster: m.poster || "",
    });
  }
  for (var j = 0; j < upcoming.length; j++) {
    var um = upcoming[j];
    if (!um.title && !um.name) continue;
    var utitle = um.title || um.name;
    var utime = um.timestamp ? toMXTime(um.timestamp) : (um.time || "");
    out.push({
      id: safeId("wf", um.matchId || um.id || utitle),
      title: String(utitle),
      embedUrls: [],
      status: "upcoming",
      time: utime,
      sport: um.sport || um.league || "",
      poster: um.poster || "",
    });
  }
  return out;
}

async function fetchDamiTV() {
  await null;
  var data = await getJSON("https://ondemand.st/papi/api/streams");
  var streams = data.streams || [];
  var out = [];
  for (var i = 0; i < streams.length; i++) {
    var cat = streams[i];
    var events = cat.streams || [];
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      if (!ev.name) continue;
      var urls = [];
      if (ev.embed) urls.push(ev.embed);
      var st = ev.status === 1 || ev.status === "live" ? "live" :
               ev.status === 0 || ev.status === "upcoming" ? "upcoming" : "live";
      var utime = (st === "upcoming" && ev.starts_at) ? toMXTime(ev.starts_at) : (ev.time || "");
      out.push({
        id: safeId("dm", ev.id || ev.name),
        title: String(ev.name),
        embedUrls: urls,
        status: st,
        time: utime,
        sport: cat.category || "",
        poster: ev.poster || "",
      });
    }
  }
  return out;
}

var FETCHERS = {
  "daddylive": fetchDaddyLive,
  "streamfree": fetchStreamFree,
  "bintv":      fetchBinTV,
  "watchfooty": fetchWatchFooty,
  "damitv":     fetchDamiTV,
};

// ── liveCategories ────────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  return [
    { id: "daddylive", title: "🔴 DaddyLive" },
    { id: "streamfree", title: "🔴 StreamFree" },
    { id: "bintv",      title: "🔴 BinTV" },
    { id: "watchfooty", title: "🔴 WatchFooty" },
    { id: "damitv",     title: "🔴 DamiTV" },
  ];
}

// ── liveChannels ──────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  var fetcher = FETCHERS[categoryId];
  if (!fetcher) {
    return { items: [{ id: "unknown-src", title: "Fuente desconocida", categoryId: categoryId, ref: "live|x|sin-stream|" }] };
  }

  var events;
  try {
    events = await fetcher();
  } catch (e) {
    kino.log("Error fetching", categoryId, ":", e.message || e.code);
    return {
      items: [{
        id: "error-" + categoryId,
        title: "No se pudo conectar con " + (SOURCES[categoryId] && SOURCES[categoryId].title || categoryId),
        categoryId: categoryId,
        ref: "live|x|sin-stream|",
      }]
    };
  }

  if (!events.length) {
    return {
      items: [{
        id: "sin-eventos-" + categoryId,
        title: "No hay eventos disponibles en este momento",
        categoryId: categoryId,
        ref: "live|x|sin-stream|",
      }]
    };
  }

  var items = [];
  var seenIds = new Set();

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var id = ev.id;
    if (seenIds.has(id)) { id = id + "-" + i; }
    seenIds.add(id);

    var live = ev.status === "live";
    var upcoming = ev.status === "upcoming";

    // Prefijo e icono
    var prefix = live ? "🔴 " : "⏳ ";
    var title = prefix + ev.title;

    // Badge: hora MX para próximos, minuto para en vivo
    var timeBadge = ev.time ? String(ev.time).slice(0, 25) : (live ? "En vivo" : "Próximo");
    var sportBadge = ev.sport ? String(ev.sport).slice(0, 25) : "";
    var badges = [timeBadge, sportBadge].filter(Boolean);

    // Ref
    var ref;
    if (!ev.embedUrls.length) {
      ref = "live|" + id + "|sin-stream|";
    } else {
      var refData = ev.embedUrls.join("^^");
      ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
      if (ref.length > 4000) {
        ref = "live|" + id + "|single|" + encodeURIComponent(ev.embedUrls[0]);
      }
    }

    items.push({
      id: id,
      title: title.slice(0, 200),
      categoryId: categoryId,
      ref: ref,
      poster: ev.poster || undefined,
      badges: badges,
    });
  }

  return { items: items };
}

// ── search ────────────────────────────────────────────────────────────────────

export async function search(query) {
  await null;
  var q = String((query && query.q) || "").trim().toLowerCase();
  if (!q) return [];

  // Buscar en todas las APIs en paralelo
  var results = await Promise.all(
    Object.keys(FETCHERS).map(function(srcId) {
      return FETCHERS[srcId]().catch(function() { return []; });
    })
  );

  var items = [];
  var seenIds = new Set();
  var srcIds = Object.keys(FETCHERS);

  for (var s = 0; s < results.length; s++) {
    var events = results[s];
    var srcId = srcIds[s];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.title || ev.title.toLowerCase().indexOf(q) < 0) continue;
      var id = ev.id;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      var prefix = ev.status === "live" ? "🔴 " : "⏳ ";
      var ref;
      if (!ev.embedUrls.length) {
        ref = "live|" + id + "|sin-stream|";
      } else {
        var refData = ev.embedUrls.join("^^");
        ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
        if (ref.length > 4000) ref = "live|" + id + "|single|" + encodeURIComponent(ev.embedUrls[0]);
      }

      items.push({
        id: id,
        title: prefix + ev.title,
        kind: "live",
        ref: ref,
        poster: ev.poster || undefined,
        badges: [ev.time || (ev.status === "live" ? "En vivo" : "Próximo"), srcId].filter(Boolean).map(function(b) { return String(b).slice(0, 25); }),
      });

      if (items.length >= 60) break;
    }
    if (items.length >= 60) break;
  }

  return items;
}

// ── resolve ───────────────────────────────────────────────────────────────────

export async function resolve(ref) {
  await null;

  var parts = String(ref).split("|");
  if (parts.length < 4 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  var type  = parts[2];
  var value = parts.slice(3).join("|");

  if (type === "sin-stream") {
    throw kino.error("unavailable", "Este evento no tiene stream disponible todavía");
  }

  var embedUrls = [];
  if (type === "multi") {
    embedUrls = decodeURIComponent(value).split("^^").filter(Boolean);
  } else if (type === "single" || type === "canal") {
    var u = decodeURIComponent(value);
    if (u) embedUrls = [u];
  }

  if (!embedUrls.length) {
    throw kino.error("not_found", "No hay streams disponibles para este evento");
  }

  if (typeof kino.browser === "undefined" || typeof kino.browser.capture !== "function") {
    throw kino.error("unavailable", "Este plugin necesita Kino 0.9.50 o más reciente");
  }

  var lastError = null;
  for (var i = 0; i < Math.min(embedUrls.length, 3); i++) {
    var embedUrl = embedUrls[i];
    if (!embedUrl || embedUrl.indexOf("http") !== 0) continue;

    try {
      kino.log("Capturando:", embedUrl);
      var page = await kino.browser.capture(embedUrl, {
        timeoutMs: 20000,
        headers: { "Referer": embedUrl.split("/").slice(0, 3).join("/") + "/" },
      });

      if (!page.media || !page.media.length) {
        kino.log("Sin media en:", embedUrl);
        continue;
      }

      var main = page.media[0];
      var alts = [];

      // Otras calidades de esta misma página
      for (var j = 1; j < Math.min(page.media.length, 4); j++) {
        alts.push({ url: page.media[j].url, headers: page.media[j].headers });
      }

      // Otros links del evento como lazy copies
      for (var k = i + 1; k < Math.min(embedUrls.length, 6); k++) {
        alts.push({
          label: "Link " + (k + 1),
          ref: "live|" + parts[1] + "|single|" + encodeURIComponent(embedUrls[k]),
        });
      }

      return {
        url: main.url,
        headers: main.headers,
        mime: "application/vnd.apple.mpegurl",
        label: "Link " + (i + 1),
        alternatives: alts.slice(0, 8),
      };

    } catch (e) {
      kino.log("Error en link", i + 1, ":", e.code || e.message);
      lastError = e;
      if (e.code === "busy") throw kino.error("unavailable", "Otro stream está cargando, intenta en un momento");
      if (e.code === "browser_unavailable") throw kino.error("unavailable", "Este dispositivo no soporta el reproductor oculto");
      continue;
    }
  }

  if (lastError && lastError.kinoCode) throw lastError;
  throw kino.error("unavailable", "Ningún link respondió. Intenta más tarde");
}
