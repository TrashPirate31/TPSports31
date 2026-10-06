/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v7.0.0
// Fuente: streamfree.top API pública (sin API key)
// Streams: strmfree.st/embed (reproductor directo)

const API_BASE = "https://streamfree.top/api/v1";
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

// ── Fetch helper ─────────────────────────────────────────────────────────────

async function apiFetch(path) {
  await null;
  var r;
  try {
    r = await kino.fetch(API_BASE + path, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
  } catch (e) {
    throw kino.error("unavailable", "Sin conexión con StreamFree");
  }
  if (r.status === 404) throw kino.error("not_found", "No encontrado");
  if (r.status === 429) throw kino.error("rate_limited", "StreamFree limitó las peticiones");
  if (!r.ok) throw kino.error("unavailable", "StreamFree respondió " + r.status);
  return r.json();
}

// ── Traducciones de categoría ─────────────────────────────────────────────────

var CAT_NAMES = {
  "soccer":     "⚽ Fútbol",
  "basketball": "🏀 Baloncesto",
  "hockey":     "🏒 Hockey",
  "combat":     "🥊 Combate",
  "baseball":   "⚾ Béisbol",
  "football":   "🏈 Fútbol Americano",
  "racing":     "🏎 Automovilismo",
  "tennis":     "🎾 Tenis",
  "cricket":    "🏏 Cricket",
};

function catTitle(cat) {
  return CAT_NAMES[cat] || cat;
}

// ── liveCategories ────────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  var data;
  try {
    data = await apiFetch("/categories");
  } catch (e) {
    return [{ id: "soccer", title: "⚽ Fútbol" }];
  }

  var cats = (data.categories || []).map(function(cat) {
    return { id: cat, title: catTitle(cat) };
  });

  // Agregar categoría "todos" al principio
  cats.unshift({ id: "all", title: "🔴 Todos en vivo" });
  return cats;
}

// ── liveChannels ──────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  var path = categoryId === "all"
    ? "/streams"
    : "/streams?category=" + encodeURIComponent(categoryId);

  var data;
  try {
    data = await apiFetch(path);
  } catch (e) {
    if (e.kinoCode) throw e;
    throw kino.error("unavailable", "No se pudieron cargar los eventos");
  }

  var streams = data.streams || [];

  if (!streams.length) {
    return {
      items: [{
        id: "sin-eventos-" + slugify(categoryId),
        title: "No hay eventos en vivo en este momento",
        categoryId: categoryId,
        ref: "live|vacio|sin-stream",
      }]
    };
  }

  var items = [];
  var seenIds = new Set();

  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if (!s.id || !s.name) continue;

    var rawId = String(s.stream_key || s.id);
    var id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    var sources = s.sources || [];
    var hasSources = sources.length > 0;

    // Preferir la fuente de mayor calidad (1080p primero)
    var bestSource = "";
    for (var j = 0; j < sources.length; j++) {
      if (sources[j].indexOf("1080p") >= 0) { bestSource = sources[j]; break; }
    }
    if (!bestSource && sources.length > 0) bestSource = sources[0];

    var ref = hasSources
      ? "live|" + id + "|embed|" + bestSource
      : "live|" + id + "|sin-stream|";

    // Logo del equipo como poster
    var poster = (s.thumbnail_url) || undefined;
    var logo = (s.team1 && s.team1.logo) || undefined;

    var viewers = s.viewers > 0 ? s.viewers + " espectadores" : "";
    var badges = [s.league, viewers].filter(Boolean).map(function(b) { return b.slice(0, 25); });

    items.push({
      id: id,
      title: (hasSources ? "🔴 " : "⏳ ") + s.name,
      categoryId: categoryId,
      ref: ref,
      poster: poster || logo,
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

  var data;
  try {
    data = await apiFetch("/streams");
  } catch (e) {
    return [];
  }

  var streams = data.streams || [];
  var items = [];
  var seenIds = new Set();

  for (var i = 0; i < streams.length; i++) {
    var s = streams[i];
    if (!s.id || !s.name) continue;
    if (s.name.toLowerCase().indexOf(q) < 0 &&
        (s.league || "").toLowerCase().indexOf(q) < 0 &&
        (s.category || "").toLowerCase().indexOf(q) < 0) continue;

    var rawId = String(s.stream_key || s.id);
    var id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    var sources = s.sources || [];
    var bestSource = "";
    for (var j = 0; j < sources.length; j++) {
      if (sources[j].indexOf("1080p") >= 0) { bestSource = sources[j]; break; }
    }
    if (!bestSource && sources.length > 0) bestSource = sources[0];

    var ref = bestSource
      ? "live|" + id + "|embed|" + bestSource
      : "live|" + id + "|sin-stream|";

    items.push({
      id: id,
      title: "🔴 " + s.name,
      kind: "live",
      ref: ref,
      poster: s.thumbnail_url || undefined,
      badges: [s.league, s.category].filter(Boolean).map(function(b) { return b.slice(0, 25); }),
    });
  }

  return items.slice(0, 50);
}

// ── resolve ───────────────────────────────────────────────────────────────────

export async function resolve(ref) {
  await null;

  var parts = String(ref).split("|");
  if (parts.length < 4 || parts[0] !== "live") {
    throw kino.error("not_found", "ref desconocida");
  }

  var type = parts[2];
  var value = parts.slice(3).join("|");

  if (type === "sin-stream") {
    throw kino.error("unavailable", "Este evento no tiene stream disponible todavía");
  }

  if (type === "embed") {
    if (!value || value.indexOf("http") !== 0) {
      throw kino.error("not_found", "URL de stream inválida");
    }
    // Intentar obtener sources frescas de la API antes de reproducir
    var streamKey = parts[1];
    try {
      var fresh = await apiFetch("/sources/" + encodeURIComponent(streamKey));
      var freshSources = fresh.sources || [];
      if (freshSources.length > 0) {
        // Preferir 1080p
        var best = "";
        for (var i = 0; i < freshSources.length; i++) {
          if (freshSources[i].indexOf("1080p") >= 0) { best = freshSources[i]; break; }
        }
        if (!best) best = freshSources[0];
        value = best;
      }
    } catch (e) {
      // Usar la URL del ref si falla la actualización
      kino.log("No se pudo actualizar sources, usando ref:", e.message);
    }

    return {
      url: value,
      mime: "text/html",
    };
  }

  throw kino.error("not_found", "Tipo de ref desconocido: " + type);
}
  
