"use strict";

// ---- sw.js ----
// Makes the app properly installable ("加到主畫面") and usable offline
// after a first visit. Modeled on the sibling Orbit project's own sw.js
// (same network-first-for-HTML / cache-first-for-everything-else split,
// same version-tagged cache name so a new deploy never leaves stale
// entries behind) but adapted for this app's very different asset shape:
// Orbit's whole app is a handful of files; this one ships 3,060 audio
// clips (data/audio/*.mp3) that together run to many megabytes - nowhere
// near worth precaching on install just so a word nobody has practiced
// yet works offline immediately. Audio (and everything else not listed in
// APP_SHELL below) is cached the ordinary lazy way instead: the first time
// a word is actually played, its clip is cached, and every replay after
// that - on this device, whether or not it's still online - is served
// from Cache Storage.
//
// "__BUILD_VERSION__" is a literal token, not a variable - the Pages
// deploy workflow's sed step (see .github/workflows/pages.yml) replaces
// it, and the matching token in index.html's own ?v= query strings, with
// the checked-out commit's short hash. That keeps this file's own cache
// name in sync with a real deploy automatically, with nothing to remember
// to bump by hand.
const APP_VERSION = "__BUILD_VERSION__";
const CACHE_NAME = "vocab-tool-cache-" + APP_VERSION;

// The minimum needed to boot the app and start a test round while
// offline: the shell scripts/styles, the vocab word list itself, and this
// file's own icons/manifest (so "加到主畫面" still shows the right icon
// after an OS reinstalls/refreshes it while offline). Pre-fetched on
// install so even a FIRST offline visit right after installing works, not
// just a second visit.
const APP_SHELL = [
  "./",
  "index.html",
  "style.css",
  "logic.js",
  "app.js",
  "sync.js",
  "manifest.json",
  "data/vocab.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// Same reasoning as Orbit's sw.js: caps how long a request waits on the
// network (a post-deploy CDN hiccup can otherwise hang a request forever)
// before falling back to whatever's cached - the network fetch itself
// keeps running in the background regardless, so the cache still ends up
// fresh the moment it lands.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // A single missing/renamed shell file (e.g. mid-refactor) must never
      // block installation entirely - the app still works online either
      // way, this only affects the offline fallback's completeness.
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Never intercept cross-origin requests (the sync proxy, Web Speech
  // fallback voices, etc.) - this cache is for this app's own assets only.
  if (url.origin !== self.location.origin) return;

  const isNavigation = request.mode === "navigate" || request.destination === "document";
  event.respondWith(isNavigation ? networkFirst(request) : cacheFirst(request));
});

// HTML shell: always prefer a fresh network copy (caching it for the
// offline fallback below); fall back to whatever's cached both when the
// network request fails outright and when it's simply taking too long.
async function networkFirst(request) {
  const fetchPromise = fetch(request);
  fetchPromise
    .then((response) => {
      if (response && response.ok) {
        caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      }
    })
    .catch(() => {});

  try {
    return await Promise.race([
      fetchPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("sw: network timeout")), NETWORK_TIMEOUT_MS)),
    ]);
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      return await fetchPromise;
    } catch (e2) {
      return Response.error();
    }
  }
}

// Everything else - audio clips, app.js/style.css, icons, the manifest:
// all explicitly ?v= versioned (or, for audio, effectively immutable -
// a word's pronunciation doesn't change), so a cached copy is never stale
// under its own URL. This is also what makes an already-practiced word's
// audio playable offline on a later visit, without ever precaching the
// other ~3,000 clips nobody has asked for yet.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return Response.error();
  }
}
