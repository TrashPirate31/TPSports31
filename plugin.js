/// <reference path="./sdk/kino.d.ts" />
// StreamedSports31 v5.0.0
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
