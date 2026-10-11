/* PIGEON EYE — raster map tiles drawn on the minimap canvas (Web Mercator, 256 px tiles).
 * Sources: OSM standard (live only; tiles you've viewed are kept in a small cache, no prefetch — OSM tile policy),
 * Esri World Imagery (live satellite), EOX Sentinel-2 cloudless (satellite; CC BY-NC-SA 4.0, the only source used for
 * "Save area for offline"). Missing tiles fall back to a cached ancestor tile (over-zoom) or the grid. */
(function (global) {
  'use strict';
  var TS = 256, R = 6378137, C = 2 * Math.PI * R;
  // ---- math ----
  function worldPx(lat, lon, z) { var n = TS * Math.pow(2, z), s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180); return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n }; }
  function pxToLatLon(x, y, z) { var n = TS * Math.pow(2, z), lon = x / n * 360 - 180, m = Math.PI - 2 * Math.PI * y / n; return { lat: 180 / Math.PI * Math.atan(Math.sinh(m)), lon: lon }; }
  function tileOf(lat, lon, z) { var p = worldPx(lat, lon, z); return { x: Math.floor(p.x / TS), y: Math.floor(p.y / TS), z: z }; }
  function metersPerPx(lat, z) { return C * Math.cos(lat * Math.PI / 180) / (TS * Math.pow(2, z)); }
  /** Zoom whose native resolution best matches the wanted metres-per-screen-pixel (× dpr for sharpness). */
  function zoomFor(lat, mppWanted, maxZ, dpr) { var z = Math.log2(C * Math.cos(lat * Math.PI / 180) / (TS * mppWanted / (dpr || 1))); return Math.max(2, Math.min(maxZ || 19, Math.round(z))); }
  /** Tiles covering a radius (m) around a point at zoom z. */
  function tilesInRadius(lat, lon, radiusM, z) { var c = worldPx(lat, lon, z), r = radiusM / metersPerPx(lat, z), out = [], max = Math.pow(2, z) - 1;
    for (var x = Math.floor((c.x - r) / TS); x <= Math.floor((c.x + r) / TS); x++) for (var y = Math.floor((c.y - r) / TS); y <= Math.floor((c.y + r) / TS); y++) if (x >= 0 && y >= 0 && x <= max && y <= max) out.push({ z: z, x: x, y: y }); return out; }
  var SOURCES = {
    map: { name: 'OpenStreetMap', url: function (t) { return 'https://tile.openstreetmap.org/' + t.z + '/' + t.x + '/' + t.y + '.png'; }, maxZ: 19, attr: '© OpenStreetMap contributors', prefetch: false },
    sat: { name: 'Esri World Imagery', url: function (t) { return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + t.z + '/' + t.y + '/' + t.x; }, maxZ: 19, attr: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community', prefetch: false, offline: 's2' },
    s2: { name: 'Sentinel-2 cloudless (EOX)', url: function (t) { return 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/' + t.z + '/' + t.y + '/' + t.x + '.jpg'; }, maxZ: 15, attr: 'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (modified Copernicus Sentinel data 2023), CC BY-NC-SA 4.0', prefetch: true }
  };
  var VIEW_CACHE = 'pe-tiles-view', SAVED_CACHE = 'pe-tiles-saved', VIEW_CAP = 600;
  // ---- loader ----
  function Tiles() { this.mem = new Map(); this.pending = 0; this.queue = []; this.fail = new Map(); this.stats = { net: 0, cache: 0, failed: 0 }; this.viewCount = 0; }
  Tiles.prototype.key = function (s, t) { return s + '/' + t.z + '/' + t.x + '/' + t.y; };
  /** Returns an ImageBitmap/Image if ready, else null (and schedules a load). */
  Tiles.prototype.get = function (s, t) {
    var k = this.key(s, t), e = this.mem.get(k);
    if (e) { if (e.img) { this.mem.delete(k); this.mem.set(k, e); } return e.img || null; }
    var f = this.fail.get(k); if (f && Date.now() - f < 30000) return null;
    this.mem.set(k, { img: null }); this.queue.push([s, t, k]); this._pump(); return null;
  };
  Tiles.prototype._pump = function () {
    var self = this;
    while (this.pending < 4 && this.queue.length) {
      var q = this.queue.pop(); this.pending++;
      (function (s, t, k) { self._load(s, t).then(function (img) { self.mem.set(k, { img: img }); self._evict(); }, function () { self.mem.delete(k); self.fail.set(k, Date.now()); self.stats.failed++; }).then(function () { self.pending--; self._pump(); }); })(q[0], q[1], q[2]);
    }
  };
  Tiles.prototype._evict = function () { while (this.mem.size > 400) this.mem.delete(this.mem.keys().next().value); };
  Tiles.prototype._load = async function (s, t) {
    var url = SOURCES[s].url(t), r = null;
    if (global.caches) { try { r = await caches.match(url); } catch (e) {} }
    if (r) this.stats.cache++;
    else {
      if (global.navigator && navigator.onLine === false) throw new Error('offline');
      r = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (!r.ok) throw new Error('HTTP ' + r.status); this.stats.net++;
      if (global.caches && !SOURCES[s].prefetch) { var cp = r.clone(), self = this; caches.open(VIEW_CACHE).then(function (c) { c.put(url, cp); if (++self.viewCount % 50 === 0) self._trimView(); }).catch(function () {}); }
    }
    var b = await r.blob(); return global.createImageBitmap ? createImageBitmap(b) : await new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = URL.createObjectURL(b); });
  };
  Tiles.prototype._trimView = async function () { try { var c = await caches.open(VIEW_CACHE), ks = await c.keys(); for (var i = 0; i < ks.length - VIEW_CAP; i++) await c.delete(ks[i]); } catch (e) {} };
  /** Best available image for tile t: exact, else a loaded ancestor with the sub-rectangle to draw. */
  Tiles.prototype.best = function (sources, t) {
    for (var si = 0; si < sources.length; si++) { var s = sources[si], tz = Math.min(t.z, SOURCES[s].maxZ), d = t.z - tz;
      var tt = { z: tz, x: t.x >> d, y: t.y >> d }, img = this.get(s, tt);
      if (img) return { img: img, sx: (t.x - (tt.x << d)) * TS / (1 << d), sy: (t.y - (tt.y << d)) * TS / (1 << d), sw: TS / (1 << d) };
    }
    for (var up = 1; up <= 4; up++) for (var sj = 0; sj < sources.length; sj++) { var s2 = sources[sj], z = Math.min(t.z, SOURCES[s2].maxZ) - up; if (z < 0) continue; var dd = t.z - z, e = this.mem.get(this.key(s2, { z: z, x: t.x >> dd, y: t.y >> dd }));
      if (e && e.img) return { img: e.img, sx: (t.x - ((t.x >> dd) << dd)) * TS / (1 << dd), sy: (t.y - ((t.y >> dd) << dd)) * TS / (1 << dd), sw: TS / (1 << dd) }; }
    return null;
  };
  /** Draw tiles on ctx, centred on (lat,lon), with metres-per-screen-px mpp, rotated by rotRad (heading-up = -heading). */
  Tiles.prototype.draw = function (ctx, layer, lat, lon, mpp, W, H, cx, cy, rotRad, dpr) {
    var srcs = layer === 'sat' ? (navigator.onLine === false ? ['s2'] : ['sat', 's2']) : layer === 'map' ? ['map'] : null; if (!srcs) return 0;
    var z = zoomFor(lat, mpp, 19, dpr), k = metersPerPx(lat, z) / mpp, c = worldPx(lat, lon, z), half = Math.hypot(W, H) / 2 / k + TS, n = 0, max = Math.pow(2, z) - 1;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotRad); ctx.scale(k, k);
    for (var x = Math.floor((c.x - half) / TS); x <= Math.floor((c.x + half) / TS); x++) for (var y = Math.floor((c.y - half) / TS); y <= Math.floor((c.y + half) / TS); y++) {
      if (x < 0 || y < 0 || x > max || y > max) continue; var b = this.best(srcs, { z: z, x: x, y: y }); if (!b) continue;
      ctx.drawImage(b.img, b.sx, b.sy, b.sw, b.sw, x * TS - c.x, y * TS - c.y, TS + 0.5, TS + 0.5); n++;
    }
    ctx.restore(); this.lastZ = z; return n;
  };
  /** Prefetch an area from a source that permits it (EOX Sentinel-2). onProgress(done,total,bytes). Cap tiles. */
  Tiles.prototype.saveArea = async function (lat, lon, radiusM, zooms, onProgress, cap) {
    var src = SOURCES.s2, list = []; zooms.forEach(function (z) { list = list.concat(tilesInRadius(lat, lon, radiusM, Math.min(z, src.maxZ))); });
    var seen = {}; list = list.filter(function (t) { var k = t.z + '/' + t.x + '/' + t.y; if (seen[k]) return false; seen[k] = 1; return true; });
    if (list.length > (cap || 500)) throw new Error(list.length + ' tiles exceeds the cap of ' + (cap || 500) + ' — choose a smaller radius');
    var c = await caches.open(SAVED_CACHE), done = 0, bytes = 0, failed = 0, i = 0;
    async function worker() { while (i < list.length) { var t = list[i++], url = src.url(t); try { if (!(await c.match(url))) { var r = await fetch(url, { mode: 'cors', credentials: 'omit' }); if (!r.ok) throw 0; var b = await r.clone().blob(); bytes += b.size; await c.put(url, r); } } catch (e) { failed++; } done++; onProgress && onProgress(done, list.length, bytes); } }
    await Promise.all([worker(), worker(), worker()]); return { tiles: list.length, failed: failed, bytes: bytes };
  };
  function estimate(lat, lon, radiusM, zooms) { var n = 0; zooms.forEach(function (z) { n += tilesInRadius(lat, lon, radiusM, Math.min(z, 15)).length; }); return { tiles: n, bytes: n * 16000 }; }
  async function savedInfo() { try { var c = await caches.open(SAVED_CACHE), ks = await c.keys(); return { tiles: ks.length }; } catch (e) { return { tiles: 0 }; } }
  async function clearSaved() { try { await caches.delete(SAVED_CACHE); } catch (e) {} }
  var api = { TS: TS, worldPx: worldPx, pxToLatLon: pxToLatLon, tileOf: tileOf, metersPerPx: metersPerPx, zoomFor: zoomFor, tilesInRadius: tilesInRadius, SOURCES: SOURCES, Tiles: Tiles, estimate: estimate, savedInfo: savedInfo, clearSaved: clearSaved };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.PTiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
