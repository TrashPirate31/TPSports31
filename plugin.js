/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v6.0.0
// Schedule : bintvjson.lovable.app (eventos en vivo con status:"live")
// Streams  : canales.m3u del repo (primero) o grandemx.org via base64 (fallback)

const BINTV_API = "https://bintvjson.lovable.app/api/public/bintvjson";
const MY_M3U    = "https://raw.githubusercontent.com/TrashPirate31/TPSports31/refs/heads/main/canales.m3u";

const M3U_KEY  = "canales-v600";
const M3U_TTL  = 2 * 60 * 60 * 1000; // 2 horas
// La API de BinTV NO se cachea — siempre fresca para saber qué está en vivo

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

// ── Decodificar base64 (atob disponible en QuickJS) ──────────────────────────
function decodeBase64Url(b64) {
  try {
    return atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch (e) {
    return "";
  }
}

// Extraer URL real del stream de BinTV (base64 en el param ?id=)
function extractStreamUrl(bintUrl) {
  if (!bintUrl) return "";
  try {
    var idx = bintUrl.indexOf("?id=");
    if (idx < 0) return bintUrl;
    var b64 = bintUrl.slice(idx + 4);
    return decodeBase64Url(b64);
  } catch (e) {
    return bintUrl;
  }
}

// ── Parsear M3U ─────────────────────────────────────────────────────────────

function parseM3U(text) {
  if (typeof text !== "string") return [];
  var lines = text.split("\n");
  var out = [];
  var meta = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXTINF:") === 0) {
      var nameM = line.match(/tvg-name="([^"]+)"/);
      var comma = line.lastIndexOf(",");
      meta = { name: (nameM && nameM[1]) || (comma >= 0 ? line.slice(comma + 1).trim() : "") };
    } else if (line.indexOf("http") === 0 && meta) {
      if (meta.name) out.push({ name: meta.name, url: line });
      meta = null;
    } else if (line.indexOf("#") !== 0) {
      meta = null;
    }
  }
  return out;
}

// ── Índice de canales propios ────────────────────────────────────────────────

var _index = null;

async function getIndex() {
  await null;
  if (_index) return _index;

  var cached = kino.storage.get(M3U_KEY);
  if (cached) {
    try {
      _index = new Map(JSON.parse(cached));
      return _index;
    } catch (e) { /* re-fetch */ }
  }

  var text = "";
  try {
    var r = await kino.fetch(MY_M3U, { headers: { "User-Agent": UA } });
    if (r.ok) text = r.text();
  } catch (e) { /* seguir con índice vacío */ }

  var channels = parseM3U(text);
  _index = new Map();
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var key = norm(ch.name);
    if (key && !_index.has(key)) _index.set(key, { name: ch.name, url: ch.url });
  }
  kino.log("Canales propios cargados:", _index.size);

  try {
    var ser = JSON.stringify([..._index]);
    if (ser.length < 250000) kino.storage.set(M3U_KEY, ser, { ttlMs: M3U_TTL });
  } catch (e) { /* ignorar */ }

  return _index;
}

function findChannel(index, name) {
  if (!name || !index.size) return null;
  var n = norm(name);
  if (index.has(n)) return index.get(n);
  var best = null, bestScore = 0;
  for (var entry of index) {
    var s = similarity(n, entry[0]);
    if (s > bestScore && s >= 0.5) { bestScore = s; best = entry[1]; }
  }
  return best;
}

// ── Fetch de la API de BinTV ─────────────────────────────────────────────────

async function fetchBinTV() {
  await null;
  try {
    var r = await kino.fetch(BINTV_API, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    return r.json();
  } catch (e) {
    kino.log("BinTV API error:", e.message);
    return null;
  }
}

// ── liveCategories ───────────────────────────────────────────────────────────

export async function liveCategories() {
  await null;
  return [
    { id: "en-vivo",      title: "🔴 En Vivo Ahora" },
    { id: "proximos",     title: "🕐 Próximos Eventos" },
    { id: "canal-prueba", title: "📡 Canal de Prueba" },
  ];
}

// ── liveChannels ─────────────────────────────────────────────────────────────

export async function liveChannels({ categoryId, cursor }) {
  await null;

  // Canal de prueba
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

  var [index, data] = await Promise.all([getIndex(), fetchBinTV()]);

  if (!data) {
    return {
      items: [{
        id: "error-api",
        title: "No se pudo conectar con la fuente de eventos",
        categoryId: categoryId,
        ref: "live|error|sin-stream",
      }]
    };
  }

  var events = categoryId === "en-vivo"
    ? (data["Live Events"] || [])
    : (data["Upcoming Events"] || []);

  if (!events.length) {
    return {
      items: [{
        id: "sin-eventos-" + categoryId,
        title: categoryId === "en-vivo"
          ? "No hay eventos en vivo en este momento"
          : "No hay próximos eventos programados",
        categoryId: categoryId,
        ref: "live|vacio|sin-stream",
      }]
    };
  }

  var items = [];
  var seenIds = new Set();

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    if (!event.id || !event.name) continue;

    // Crear un ID válido para Kino
    var rawId = String(event.id);
    var id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // Buscar el mejor canal disponible
    var streams = event.streams || [];
    var bestChannelName = null;
    var bestStreamUrl = null;

    for (var j = 0; j < streams.length; j++) {
      var stream = streams[j];
      // Primero buscar en nuestra lista propia
      var own = findChannel(index, stream.name);
      if (own && own.url) {
        bestChannelName = own.name;
        bestStreamUrl = own.url;
        break;
      }
    }

    // Si no hay canal propio, usar el stream de BinTV (grandemx.org)
    if (!bestStreamUrl && streams.length > 0) {
      var bintUrl = streams[0].url || "";
      var decoded = extractStreamUrl(bintUrl);
      if (decoded && decoded.indexOf("http") === 0) {
        bestChannelName = streams[0].name || "Stream";
        bestStreamUrl = decoded;
      }
    }

    var channelNames = streams.map(function(s) { return s.name; }).slice(0, 2).join(", ");
    var prefix = categoryId === "en-vivo" ? "🔴 " : "🕐 ";
    var title = prefix + event.name + (channelNames ? " (" + channelNames + ")" : "");

    var ref;
    if (bestStreamUrl) {
      // Guardar la URL directamente en el ref (máx 4096 chars)
      ref = "live|" + id + "|url|" + bestStreamUrl;
      if (ref.length > 4096) {
        ref = "live|" + id + "|chan|" + encodeURIComponent(bestChannelName || "");
      }
    } else {
      ref = "live|" + id + "|sin-stream|";
    }

    items.push({
      id: id,
      title: title.slice(0, 200),
      categoryId: categoryId,
      ref: ref,
      poster: event.poster || undefined,
      badges: [event.category].filter(Boolean),
    });
  }

  return { items: items };
}

// ── search ───────────────────────────────────────────────────────────────────

export async function search(query) {
  await null;
  var q = String((query && query.q) || "").trim();
  if (!q) return [];

  var data = await fetchBinTV();
  if (!data) return [];

  var all = (data["Live Events"] || []).concat(data["Upcoming Events"] || []);
  var normQ = norm(q);
  var items = [];
  var seenIds = new Set();

  for (var i = 0; i < all.length; i++) {
    var event = all[i];
    if (!event.id || !event.name) continue;
    if (norm(event.name).indexOf(normQ) < 0 && norm(event.category || "").indexOf(normQ) < 0) continue;

    var rawId = String(event.id);
    var id = /^[A-Za-z0-9._~-]{1,128}$/.test(rawId) ? rawId : slugify(rawId);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    var streams = event.streams || [];
    var bintUrl = streams.length > 0 ? (streams[0].url || "") : "";
    var decoded = extractStreamUrl(bintUrl);
    var ref = decoded && decoded.indexOf("http") === 0
      ? "live|" + id + "|url|" + decoded
      : "live|" + id + "|sin-stream|";

    if (ref.length > 4096) ref = "live|" + id + "|sin-stream|";

    items.push({
      id: id,
      title: (event.status === "live" ? "🔴 " : "🕐 ") + event.name,
      kind: "live",
      ref: ref,
      poster: event.poster || undefined,
      badges: [event.category, event.status === "live" ? "En vivo" : "Próximo"].filter(Boolean),
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
    throw kino.error("unavailable", "Este evento no tiene stream disponible");
  }

  // URL directa guardada en el ref
  if (type === "url") {
    if (!value || value.indexOf("http") !== 0) {
      throw kino.error("not_found", "URL de stream inválida");
    }
    return {
      url: value,
      mime: "application/vnd.apple.mpegurl",
    };
  }

  // Canal propio por nombre
  if (type === "chan") {
    var channelName = decodeURIComponent(value);
    var index = await getIndex();
    var entry = findChannel(index, channelName);
    if (!entry || !entry.url) {
      throw kino.error("unavailable", "Canal no disponible: " + channelName);
    }
    return {
      url: entry.url,
      mime: "application/vnd.apple.mpegurl",
    };
  }

  // Caso especial: canal de prueba
  if (type === "prueba" || value === "TUDN") {
    var index2 = await getIndex();
    var tudn = findChannel(index2, "TUDN");
    if (!tudn || !tudn.url) {
      throw kino.error("unavailable", "Canal de prueba no disponible");
    }
    return {
      url: tudn.url,
      mime: "application/vnd.apple.mpegurl",
    };
  }

  throw kino.error("not_found", "Tipo de ref desconocido: " + type);
    }
        
