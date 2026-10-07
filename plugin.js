/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v8.0.0
// Schedule + canales: daddylive.mov (API pública, sin key)
// Streams: kino.browser.capture en resolve() para obtener m3u8 real
// apiVersion 6: browser oculto + streamHosts:any

const API      = "https://daddylive.mov/api";
const PLAYER   = "https://daddylive.mov";
const UA       = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

// ── Utilidades ──────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "item";
}

function safeId(raw) {
  var s = String(raw || "");
  if (/^[A-Za-z0-9._~-]{1,128}$/.test(s)) return s;
  return slugify(s);
}

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function apiFetch(path) {
  await null;
  var r;
  try {
    r = await kino.fetch(API + path, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
  } catch (e) {
    throw kino.error("unavailable", "Sin conexión con DaddyLive");
  }
  if (r.status === 429) throw kino.error("rate_limited");
  if (!r.ok) throw kino.error("unavailable", "DaddyLive respondió " + r.status);
  return r.json();
}

// ── Traducciones de categoría ────────────────────────────────────────────────

var CAT_ES = {
  "Football":       "⚽ Fútbol",
  "Basketball":     "🏀 Baloncesto",
  "Hockey":         "🏒 Hockey",
  "Boxing":         "🥊 Boxeo",
  "MMA / UFC":      "🥋 MMA / UFC",
  "Baseball":       "⚾ Béisbol",
  "American Football": "🏈 Fútbol Americano",
  "Racing":         "🏎 Automovilismo",
  "Tennis":         "🎾 Tenis",
  "Cricket":        "🏏 Cricket",
  "Rugby":          "🏉 Rugby",
  "Golf":           "⛳ Golf",
  "Live Events":    "🔴 Eventos en Vivo",
  "Darts":          "🎯 Dardos",
  "Snooker":        "🎱 Snooker",
};

function catTitle(cat) {
  return CAT_ES[cat] || ("🔴 " + cat);
}

// ── liveCategories ────────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  var data;
  try {
    data = await apiFetch("/events");
  } catch (e) {
    return [{ id: "all", title: "🔴 En Vivo" }];
  }
  var cats = new Map();
  cats.set("all", { id: "all", title: "🔴 Todos en Vivo" });
  var categories = data.categories || {};
  for (var cat in categories) {
    if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
    var id = slugify(cat);
    if (!cats.has(id)) cats.set(id, { id: id, title: catTitle(cat) });
  }
  cats.set("canales", { id: "canales", title: "📺 Canales 24/7" });
  return Array.from(cats.values()).slice(0, 200);
}

// ── liveChannels ──────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  // Canales 24/7
  if (categoryId === "canales") {
    var chData;
    try {
      chData = await apiFetch("/channels");
    } catch (e) {
      return { items: [] };
    }
    var channels = Array.isArray(chData) ? chData : [];
    var PAGE_CH = 100;
    var startCh = cursor ? parseInt(cursor, 10) : 0;
    var pageCh = channels.slice(startCh, startCh + PAGE_CH);
    var nextCh = startCh + PAGE_CH < channels.length ? String(startCh + PAGE_CH) : undefined;
    var itemsCh = [];
    var seenCh = new Set();
    for (var i = 0; i < pageCh.length; i++) {
      var ch = pageCh[i];
      if (!ch.channel_name || !ch.url) continue;
      var id = safeId(slugify(ch.channel_name));
      if (seenCh.has(id)) continue;
      seenCh.add(id);
      itemsCh.push({
        id: id,
        title: ch.channel_name,
        categoryId: "canales",
        ref: "live|canal|" + encodeURIComponent(ch.url),
      });
    }
    if (!itemsCh.length) {
      return { items: [{ id: "sin-canales", title: "No hay canales disponibles", categoryId: "canales", ref: "live|vacio|sin-stream" }] };
    }
    return { items: itemsCh, next: nextCh };
  }

  // Eventos en vivo
  var evData;
  try {
    evData = await apiFetch("/events");
  } catch (e) {
    return { items: [{ id: "error-api", title: "No se pudo conectar con DaddyLive", categoryId: categoryId, ref: "live|vacio|sin-stream" }] };
  }

  var categories = evData.categories || {};
  var allEvents = [];

  for (var cat in categories) {
    if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
    var catId = slugify(cat);
    if (categoryId !== "all" && catId !== categoryId) continue;
    var events = categories[cat];
    if (!Array.isArray(events)) continue;
    for (var j = 0; j < events.length; j++) {
      allEvents.push({ event: events[j], cat: cat });
    }
  }

  if (!allEvents.length) {
    return {
      items: [{
        id: "sin-eventos-" + safeId(categoryId),
        title: "No hay eventos en vivo en este momento",
        categoryId: categoryId,
        ref: "live|vacio|sin-stream",
      }]
    };
  }

  var items = [];
  var seenIds = new Set();

  for (var k = 0; k < allEvents.length; k++) {
    var entry = allEvents[k];
    var ev = entry.event;
    if (!ev.event || !ev.channels || !ev.channels.length) continue;

    var rawId = slugify(ev.event) + "-" + (ev.time || "").replace(/[^0-9]/g, "");
    var id = safeId(rawId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // Primer canal como stream principal, el resto como lazy copies en el ref
    var mainChannel = ev.channels[0];
    var mainUrl = mainChannel.url || "";

    // Guardar todas las URLs en el ref separadas por ^^
    var allUrls = ev.channels.map(function(c) { return c.url; }).filter(Boolean);
    var refData = allUrls.join("^^");
    var ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
    if (ref.length > 4000) {
      ref = "live|" + id + "|single|" + encodeURIComponent(mainUrl);
    }

    items.push({
      id: id,
      title: "🔴 " + String(ev.event).slice(0, 180),
      categoryId: categoryId,
      ref: ref,
      badges: [ev.time || "En vivo", entry.cat].filter(Boolean).map(function(b) { return String(b).slice(0, 25); }),
    });
  }

  return { items: items };
}

// ── search ────────────────────────────────────────────────────────────────────

export async function search(query) {
  await null;
  var q = String((query && query.q) || "").trim().toLowerCase();
  if (!q) return [];

  var data;
  try {
    data = await apiFetch("/events");
  } catch (e) {
    return [];
  }

  var categories = data.categories || {};
  var items = [];
  var seenIds = new Set();

  for (var cat in categories) {
    if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
    var events = categories[cat];
    if (!Array.isArray(events)) continue;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.event) continue;
      if (ev.event.toLowerCase().indexOf(q) < 0 && cat.toLowerCase().indexOf(q) < 0) continue;
      if (!ev.channels || !ev.channels.length) continue;

      var rawId = slugify(ev.event) + "-" + (ev.time || "").replace(/[^0-9]/g, "");
      var id = safeId(rawId);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      var allUrls = ev.channels.map(function(c) { return c.url; }).filter(Boolean);
      var refData = allUrls.join("^^");
      var ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
      if (ref.length > 4000) ref = "live|" + id + "|single|" + encodeURIComponent(allUrls[0] || "");

      items.push({
        id: id,
        title: "🔴 " + String(ev.event).slice(0, 180),
        kind: "live",
        ref: ref,
        badges: [ev.time || "En vivo", cat].filter(Boolean).map(function(b) { return String(b).slice(0, 25); }),
      });
    }
  }

  return items.slice(0, 50);
}

// ── resolve con browser oculto ────────────────────────────────────────────────

export async function resolve(ref) {
  await null;

  var parts = String(ref).split("|");
  if (parts.length < 4 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  var type  = parts[2];
  var value = parts.slice(3).join("|");

  if (type === "vacio" || type === "sin-stream") {
    throw kino.error("unavailable", "Este evento no tiene stream disponible");
  }

  // Obtener las URLs del embed
  var embedUrls = [];
  if (type === "multi") {
    embedUrls = decodeURIComponent(value).split("^^").filter(Boolean);
  } else if (type === "single" || type === "canal") {
    var u = decodeURIComponent(value);
    if (u) embedUrls = [u];
  }

  if (!embedUrls.length) {
    throw kino.error("not_found", "No hay streams disponibles");
  }

  // Si no hay browser disponible, lanzar error claro
  if (typeof kino.browser === "undefined" || typeof kino.browser.capture !== "function") {
    throw kino.error("unavailable", "Este plugin necesita Kino 0.9.50 o más reciente");
  }

  // Intentar cada URL con el browser oculto
  var lastError = null;
  for (var i = 0; i < Math.min(embedUrls.length, 3); i++) {
    var embedUrl = embedUrls[i];
    if (!embedUrl || embedUrl.indexOf("http") !== 0) continue;

    try {
      kino.log("Capturando stream:", embedUrl);
      var page = await kino.browser.capture(embedUrl, {
        timeoutMs: 20000,
        headers: { "Referer": PLAYER + "/" },
      });

      if (!page.media || !page.media.length) {
        kino.log("Sin media en:", embedUrl);
        continue;
      }

      var main = page.media[0];
      // URLs alternativas: el resto de streams de esta página + otros links del evento
      var alts = [];

      // Alternativas de esta página
      for (var j = 1; j < Math.min(page.media.length, 4); j++) {
        alts.push({ url: page.media[j].url, headers: page.media[j].headers });
      }

      // Otros links del evento como lazy copies
      for (var k = i + 1; k < Math.min(embedUrls.length, 5); k++) {
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
      kino.log("Error capturando", embedUrl, ":", e.message || e.code);
      lastError = e;
      if (e.code === "busy") throw kino.error("unavailable", "Otro stream está cargando, intenta en un momento");
      if (e.code === "browser_unavailable") throw kino.error("unavailable", "Este dispositivo no soporta el browser oculto");
      // blocked o timeout: intentar el siguiente link
      continue;
    }
  }

  if (lastError && lastError.kinoCode) throw lastError;
  throw kino.error("unavailable", "No se pudo obtener el stream. Intenta con otro link");
    }
      
