/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v10.1.0
// Fuentes: DaddyLive + streamed.pk
// Streams: kino.browser.capture, prueba cada link uno por uno, timeout máximo en el último

const API    = "https://daddylive.mov/api";
const STREAMED = "https://streamed.pk/api";
const UA     = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
const MAX_MS = 25000; // timeout máximo permitido por Kino
const MID_MS = 15000; // timeout para links intermedios

// ── Utilidades ────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "item";
}

function safeId(raw) {
  var s = "dl-" + slugify(String(raw || "")).slice(0, 80);
  return s.replace(/[^A-Za-z0-9._~-]/g, "-").slice(0, 128);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function apiGet(path) {
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

// ── Traducción de categorías ──────────────────────────────────────────────────

var CAT_ES = {
  "Football":          "⚽ Fútbol",
  "Basketball":        "🏀 Baloncesto",
  "Hockey":            "🏒 Hockey",
  "Boxing":            "🥊 Boxeo",
  "MMA / UFC":         "🥋 MMA / UFC",
  "Baseball":          "⚾ Béisbol",
  "American Football": "🏈 Fútbol Americano",
  "Racing":            "🏎 Automovilismo",
  "Tennis":            "🎾 Tenis",
  "Cricket":           "🏏 Cricket",
  "Rugby":             "🏉 Rugby",
  "Golf":              "⛳ Golf",
  "Darts":             "🎯 Dardos",
  "Snooker":           "🎱 Snooker",
};

function catTitle(cat) {
  return CAT_ES[cat] || ("🏟 " + cat);
}

// ── streamed.pk ───────────────────────────────────────────────────────────────

async function fetchStreamedLive() {
  await null;
  var r;
  try {
    r = await kino.fetch(STREAMED + "/matches/live", {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
  } catch (e) { return []; }
  if (!r.ok) return [];
  var matches = r.json();
  if (!Array.isArray(matches)) return [];
  var out = [];
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    if (!m.id || !m.sources || !m.sources.length) continue;
    var home = m.teams && m.teams.home && m.teams.home.name;
    var away = m.teams && m.teams.away && m.teams.away.name;
    var title = (home && away) ? (home + " vs " + away) : (m.title || "Partido");
    var urls = m.sources.map(function(s) {
      return "https://embedme.top/embed/" + s.source + "/" + s.id + "/1";
    });
    if (!urls.length) continue;
    var badge = m.teams && m.teams.home && m.teams.home.badge;
    out.push({
      id: "sk-" + slugify(String(m.id)).slice(0, 80),
      title: title,
      embedUrls: urls,
      sport: m.category || "",
      poster: badge ? ("https://streamed.pk/api/images/badge/" + badge + ".webp") : undefined,
    });
  }
  return out;
}

// ── liveCategories ────────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  var data;
  try {
    data = await apiGet("/events");
  } catch (e) {
    return [{ id: "all", title: "🔴 En Vivo" }];
  }
  var cats = new Map();
  cats.set("all", { id: "all", title: "🔴 Todos en Vivo" });
  cats.set("streamed", { id: "streamed", title: "🔴 streamed.pk" });
  var categories = data.categories || {};
  for (var cat in categories) {
    if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
    var id = slugify(cat);
    if (!cats.has(id)) {
      cats.set(id, { id: id, title: catTitle(cat) });
    }
  }
  return Array.from(cats.values()).slice(0, 200);
}

// ── liveChannels ──────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  // ── streamed.pk ──
  if (categoryId === "streamed") {
    var skList;
    try { skList = await fetchStreamedLive(); } catch (e) { skList = []; }
    if (!skList.length) {
      return { items: [{ id: "sin-sk", title: "No hay partidos en vivo en streamed.pk", categoryId: "streamed", ref: "live|x|sin-stream|" }] };
    }
    var skItems = [];
    var skSeen = new Set();
    for (var si = 0; si < skList.length; si++) {
      var sev = skList[si];
      if (skSeen.has(sev.id)) continue;
      skSeen.add(sev.id);
      var sref = "live|" + sev.id + "|multi|" + encodeURIComponent(sev.embedUrls.join("^^"));
      if (sref.length > 4000) sref = "live|" + sev.id + "|single|" + encodeURIComponent(sev.embedUrls[0]);
      skItems.push({ id: sev.id, title: "🔴 " + sev.title, categoryId: "streamed", ref: sref, poster: sev.poster, badges: [sev.sport].filter(Boolean).map(function(b){ return String(b).slice(0,25); }) });
    }
    return { items: skItems };
  }

  var data;
  try {
    data = await apiGet("/events");
  } catch (e) {
    return {
      items: [{
        id: "error-dl",
        title: "No se pudo conectar con DaddyLive",
        categoryId: categoryId,
        ref: "live|x|sin-stream|",
      }]
    };
  }

  var categories = data.categories || {};
  var allEvents = [];

  for (var cat in categories) {
    if (!Object.prototype.hasOwnProperty.call(categories, cat)) continue;
    var catId = slugify(cat);
    if (categoryId !== "all" && catId !== categoryId) continue;
    var events = categories[cat];
    if (!Array.isArray(events)) continue;
    for (var i = 0; i < events.length; i++) {
      allEvents.push({ ev: events[i], cat: cat });
    }
  }

  if (!allEvents.length) {
    return {
      items: [{
        id: "sin-eventos-" + slugify(categoryId),
        title: "No hay eventos en vivo en este momento",
        categoryId: categoryId,
        ref: "live|x|sin-stream|",
      }]
    };
  }

  var items = [];
  var seenIds = new Set();

  for (var k = 0; k < allEvents.length; k++) {
    var entry = allEvents[k];
    var ev = entry.ev;
    if (!ev.event || !ev.channels || !ev.channels.length) continue;

    var id = safeId(ev.event + "-" + (ev.time || "").replace(/[^0-9]/g, ""));
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    var urls = ev.channels.map(function(c) { return c.url; }).filter(Boolean);
    if (!urls.length) continue;

    var refData = urls.join("^^");
    var ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
    if (ref.length > 4000) {
      ref = "live|" + id + "|single|" + encodeURIComponent(urls[0]);
    }

    items.push({
      id: id,
      title: "🔴 " + String(ev.event).slice(0, 180),
      categoryId: categoryId,
      ref: ref,
      badges: [
        ev.time ? String(ev.time).slice(0, 25) : "En vivo",
        entry.cat ? String(entry.cat).slice(0, 25) : "",
      ].filter(Boolean),
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
    data = await apiGet("/events");
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

      var id = safeId(ev.event + "-" + (ev.time || "").replace(/[^0-9]/g, ""));
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      var urls = ev.channels.map(function(c) { return c.url; }).filter(Boolean);
      var refData = urls.join("^^");
      var ref = "live|" + id + "|multi|" + encodeURIComponent(refData);
      if (ref.length > 4000) ref = "live|" + id + "|single|" + encodeURIComponent(urls[0]);

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

// ── resolve: prueba cada link uno por uno, timeout máximo en el último ────────

export async function resolve(ref) {
  await null;

  var parts = String(ref).split("|");
  if (parts.length < 4 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  var type  = parts[2];
  var value = parts.slice(3).join("|");

  if (type === "sin-stream") {
    throw kino.error("unavailable", "Este evento no tiene stream disponible");
  }

  var embedUrls = [];
  if (type === "multi") {
    embedUrls = decodeURIComponent(value).split("^^").filter(Boolean);
  } else if (type === "single" || type === "canal") {
    var u = decodeURIComponent(value);
    if (u) embedUrls = [u];
  }

  if (!embedUrls.length) {
    throw kino.error("not_found", "No hay streams para este evento");
  }

  if (typeof kino.browser === "undefined" || typeof kino.browser.capture !== "function") {
    throw kino.error("unavailable", "Este plugin necesita Kino 0.9.50 o más reciente");
  }

  // Probar cada link uno por uno
  // Los primeros usan MID_MS para no gastar todo el tiempo en uno solo
  // El último usa MAX_MS para darle la mejor oportunidad
  var lastError = null;
  var total = Math.min(embedUrls.length, 5); // máximo 5 links (el tiempo total de resolve es 75s)

  for (var i = 0; i < total; i++) {
    var embedUrl = embedUrls[i];
    if (!embedUrl || embedUrl.indexOf("http") !== 0) continue;

    var isLast = (i === total - 1);
    var timeout = isLast ? MAX_MS : MID_MS;

    try {
      kino.log("Link " + (i + 1) + "/" + total + " (" + timeout + "ms):", embedUrl);

      var page = await kino.browser.capture(embedUrl, {
        timeoutMs: timeout,
        headers: { "Referer": "https://daddylive.mov/" },
      });

      if (!page.media || !page.media.length) {
        kino.log("Sin media en link", i + 1);
        continue;
      }

      var main = page.media[0];
      var alts = [];

      // Otras calidades de esta página
      for (var j = 1; j < Math.min(page.media.length, 4); j++) {
        alts.push({
          url: page.media[j].url,
          headers: page.media[j].headers,
        });
      }

      // Links restantes como lazy copies
      for (var k = i + 1; k < Math.min(embedUrls.length, 8); k++) {
        alts.push({
          label: "Link " + (k + 1),
          ref: "live|" + parts[1] + "|single|" + encodeURIComponent(embedUrls[k]),
        });
      }

      kino.log("OK en link", i + 1);
      return {
        url: main.url,
        headers: main.headers,
        mime: "application/vnd.apple.mpegurl",
        label: "Link " + (i + 1),
        alternatives: alts.slice(0, 8),
      };

    } catch (e) {
      kino.log("Link", i + 1, "falló:", e.code || e.message);
      lastError = e;
      if (e.code === "busy") {
        throw kino.error("unavailable", "Otro stream está cargando, espera un momento e intenta de nuevo");
      }
      if (e.code === "browser_unavailable") {
        throw kino.error("unavailable", "Este dispositivo no soporta el reproductor oculto");
      }
      // timeout o blocked: pasar al siguiente link
      continue;
    }
  }

  // Todos fallaron
  if (lastError && lastError.kinoCode) throw lastError;
  throw kino.error("unavailable", "Ningún link respondió. El evento puede haber terminado");
      }
                               
