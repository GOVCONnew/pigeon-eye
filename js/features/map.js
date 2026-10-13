/* PIGEON EYE feature: minimap / full map (tiles, trail, squad, waypoints, rooms, contacts), layer toggle, offline area save.
 * Registered through the feature registry; draws on every 'frame' event. See docs/ARCHITECTURE.md. */
PE.register('map', function (ctx) {
  'use strict';
  var $ = ctx.$, S = ctx.S, G = ctx.G, fuser = ctx.fuser, tiles = ctx.tiles, mm = ctx.mm, mx = mm.getContext('2d');
  var me = ctx.me, hdg = ctx.heading, save = ctx.save, resize = ctx.resize, toast = ctx.toast, dialog = ctx.dialog, logEv = ctx.logEv, waypointDialog = ctx.waypointDialog, memberENU = ctx.memberENU;
  // minimap: tap small → expand; tap full → waypoint at tapped spot
  mm.addEventListener('click', function (e) {
    if (!mm.classList.contains('full')) { mm.classList.add('full'); $('mapbar').classList.remove('hidden'); resize(); return; }
    var r = mm.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2, sc = S.mapScale * 1.0, dx = (e.clientX - r.left - cx) / sc, dy = -(e.clientY - r.top - cy) / sc;
    if (S.mapMode === 'heading') { var t = hdg() * Math.PI / 180, rx = dx * Math.cos(t) + dy * Math.sin(t), ry = -dx * Math.sin(t) + dy * Math.cos(t); dx = rx; dy = ry; }
    waypointDialog({ x: me().x + dx, y: me().y + dy }, 'from map');
  });
  $('m-close').onclick = function () { mm.classList.remove('full'); $('mapbar').classList.add('hidden'); resize(); };
  $('m-mode').onclick = function () { S.mapMode = S.mapMode === 'heading' ? 'north' : 'heading'; save(); this.textContent = S.mapMode === 'heading' ? 'HEADING-UP' : 'NORTH-UP'; };
  var LAYERS = { sat: 'SAT', map: 'MAP', none: 'GRID' }; function layerBtn() { $('m-layer').textContent = LAYERS[S.layer] || 'SAT'; } layerBtn();
  $('m-layer').onclick = function () { S.layer = S.layer === 'sat' ? 'map' : S.layer === 'map' ? 'none' : 'sat'; save(); layerBtn(); };
  $('m-save').onclick = function () {
    var ll = fuser.latlon(); if (!ll) return toast('Need a GPS fix to save an area');
    var zs = [12, 13, 14, 15], est = function (r) { var e = PTiles.estimate(ll.lat, ll.lon, r, zs); return e.tiles + ' tiles ≈ ' + (e.bytes / 1e6).toFixed(1) + ' MB'; };
    var d = dialog('<h3>SAVE AREA FOR OFFLINE</h3><p class="muted">Satellite tiles from Sentinel-2 cloudless (EOX, CC BY-NC-SA 4.0, ~10 m detail, zoom 12–15) — the source that permits caching. OSM and Esri tiles are not bulk-downloaded (their terms); tiles you have already viewed stay cached.</p><label>Radius <select id="sa-r"><option value="500">0.5 km — ' + est(500) + '</option><option value="1000" selected>1 km — ' + est(1000) + '</option><option value="2000">2 km — ' + est(2000) + '</option></select></label><div id="sa-p" class="mono muted">cap 500 tiles</div><div class="row"><button class="btn primary" id="sa-go">DOWNLOAD</button><button class="btn" id="sa-clear">DELETE SAVED</button><button class="btn ghost" id="sa-x">CLOSE</button></div>');
    PTiles.savedInfo().then(function (i) { $('sa-p').textContent = 'saved now: ' + i.tiles + ' tiles · cap 500 per download'; });
    $('sa-x').onclick = function () { d.classList.add('hidden'); }; $('sa-clear').onclick = function () { PTiles.clearSaved().then(function () { $('sa-p').textContent = 'deleted'; }); };
    $('sa-go').onclick = function () { var r = +$('sa-r').value; $('sa-go').disabled = true; tiles.saveArea(ll.lat, ll.lon, r, zs, function (a, b, by) { $('sa-p').textContent = a + ' / ' + b + ' tiles · ' + (by / 1e6).toFixed(1) + ' MB'; }, 500).then(function (res) { $('sa-p').textContent = 'saved ' + (res.tiles - res.failed) + '/' + res.tiles + ' tiles (' + (res.bytes / 1e6).toFixed(1) + ' MB)'; logEv('map', 'saved offline area r=' + r + ' m, ' + res.tiles + ' tiles'); try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} }).catch(function (e) { $('sa-p').textContent = 'failed: ' + e.message; }).then(function () { $('sa-go').disabled = false; }); };
  };
  $('m-zin').onclick = function () { S.mapScale = Math.min(40, S.mapScale * 1.5); save(); }; $('m-zout').onclick = function () { S.mapScale = Math.max(0.2, S.mapScale / 1.5); save(); };
  var mapInfo = { tiles: 0 };
  function drawMap() {
    var r = mm.getBoundingClientRect(), W = r.width, H = r.height, cx = W / 2, cy = H / 2, sc = S.mapScale * (mm.classList.contains('full') ? 1 : 0.6), P = function (p) { return G.project(p, me(), S.mapMode, hdg(), sc, cx, cy); };
    mx.clearRect(0, 0, W, H); mx.save(); if (!mm.classList.contains('full')) { mx.beginPath(); mx.arc(cx, cy, W / 2, 0, 7); mx.clip(); }
    var ll = fuser.latlon(), full = mm.classList.contains('full'); mapInfo.tiles = 0;
    if (ll && S.layer !== 'none' && isFinite(ll.lat) && isFinite(ll.lon)) { mapInfo.tiles = tiles.draw(mx, S.layer, ll.lat, ll.lon, 1 / sc, W, H, cx, cy, S.mapMode === 'heading' ? -hdg() * Math.PI / 180 : 0, devicePixelRatio || 1); if (mapInfo.tiles) { mx.fillStyle = 'rgba(0,0,0,.25)'; mx.fillRect(0, 0, W, H); } }
    if (ll && fuser.acc != null && isFinite(fuser.acc)) { mx.fillStyle = 'rgba(0,229,255,.12)'; mx.strokeStyle = 'rgba(0,229,255,.6)'; mx.beginPath(); mx.arc(cx, cy, Math.min(Math.max(W, H), fuser.acc * sc), 0, 7); mx.fill(); mx.stroke(); }
    mx.strokeStyle = 'rgba(154,205,50,.25)'; mx.lineWidth = 1; [10, 25, 50, 100, 250].forEach(function (m) { if (m * sc < Math.max(W, H)) { mx.beginPath(); mx.arc(cx, cy, m * sc, 0, 7); mx.stroke(); } });
    mx.strokeStyle = 'rgba(154,205,50,.8)'; var brk = true; mx.beginPath(); ctx.path().slice(-3000).forEach(function (p, i) { var q = P(p); if (!q) { brk = true; return; } if (i && !p.sync && !brk) mx.lineTo(q.x, q.y); else mx.moveTo(q.x, q.y); brk = false; }); mx.stroke();
    ctx.rooms().forEach(function (rm) { var q = P(rm); if (!q) return; mx.strokeStyle = GREEN; mx.strokeRect(q.x - 6, q.y - 6, 12, 12); mx.beginPath(); mx.moveTo(q.x - 4, q.y); mx.lineTo(q.x - 1, q.y + 3); mx.lineTo(q.x + 4, q.y - 3); mx.stroke(); mtxt(rm.name, q.x + 8, q.y + 4, GREEN); });
    ctx.waypoints().forEach(function (w) { var q = P(w); if (!q) return; mx.fillStyle = w.color; mx.beginPath(); mx.moveTo(q.x, q.y - 7); mx.lineTo(q.x + 5, q.y); mx.lineTo(q.x, q.y + 7); mx.lineTo(q.x - 5, q.y); mx.fill(); mtxt(w.name, q.x + 7, q.y + 4, w.color); });
    ctx.contacts().forEach(function (c) { var age = Date.now() - c.ts; if (age > 300000) return; var q = P(c); if (!q) return; mx.globalAlpha = Math.max(0.15, 1 - age / 300000); mx.strokeStyle = '#FF3B30'; mx.beginPath(); mx.moveTo(q.x - 4, q.y - 4); mx.lineTo(q.x + 4, q.y + 4); mx.moveTo(q.x + 4, q.y - 4); mx.lineTo(q.x - 4, q.y + 4); mx.stroke(); if (mm.classList.contains('full')) mtxt(c.cls + ' ' + Math.round(age / 1000) + 's', q.x + 6, q.y + 3, '#FF3B30'); mx.globalAlpha = 1; });
    Object.keys(ctx.squadState()).forEach(function (k) { var s = ctx.squadState()[k], age = Date.now() - s.t; if (age > 60000) return; var q = P(memberENU(s)); if (!q) return; mx.globalAlpha = age > 15000 ? 0.35 : 1; mx.fillStyle = s.color || '#0ef'; mx.beginPath(); mx.arc(q.x, q.y, 5, 0, 7); mx.fill(); mtxt(s.callsign || k, q.x + 7, q.y + 4, s.color || '#0ef'); mx.globalAlpha = 1; });
    // me
    mx.save(); mx.translate(cx, cy); mx.rotate(S.mapMode === 'heading' ? 0 : hdg() * Math.PI / 180); mx.fillStyle = '#fff'; mx.beginPath(); mx.moveTo(0, -9); mx.lineTo(6, 7); mx.lineTo(0, 3); mx.lineTo(-6, 7); mx.fill(); mx.restore();
    if (S.mapMode === 'heading') { var nq = G.project({ x: me().x, y: me().y + 1000 }, me(), 'heading', hdg(), 1, cx, cy), a = Math.atan2(nq.x - cx, cy - nq.y); mtxt('N', cx + Math.sin(a) * (Math.min(W, H) / 2 - 12) - 4, cy - Math.cos(a) * (Math.min(W, H) / 2 - 12) + 4, '#fff'); } else mtxt('N', cx - 4, 14, '#fff');
    var badge = !ll ? 'NO GPS FIX — grid only' : fuser.mode === 'PDR' ? 'PDR — estimated' : 'GPS ±' + Math.round(fuser.acc || 0) + ' m';
    mx.font = (full ? 12 : 9) + 'px ui-monospace, Menlo, monospace'; mx.textAlign = 'center'; mx.fillStyle = fuser.mode === 'PDR' || !ll ? '#FFB000' : '#9ACD32'; mx.fillText(badge, cx, full ? 80 : H - 30);
    if (mapInfo.tiles) { var at = S.layer === 'map' ? PTiles.SOURCES.map.attr : (navigator.onLine === false ? PTiles.SOURCES.s2.attr : PTiles.SOURCES.sat.attr); mx.font = (full ? 10 : 7) + 'px system-ui, sans-serif'; mx.fillStyle = '#fff'; if (full) { mx.textAlign = 'right'; mx.fillText(at, W - 6, H - 70); } else { mx.fillText(S.layer === 'map' ? '© OSM' : (navigator.onLine === false ? '© EOX S2' : '© Esri'), cx, H - 18); } }
    mx.textAlign = 'left'; mx.restore(); $('m-scale').textContent = Math.round(50 / sc) + ' m / 50 px';
  }
  function mtxt(s, x, y, col) { mx.font = '11px ui-monospace, Menlo, monospace'; mx.fillStyle = col; mx.fillText(s, x, y); }
  PE.bus.on('frame', function () { try { drawMap(); } catch (e) { ctx.drawErr.map = e.message; } });
  return { info: function () { return mapInfo; }, draw: drawMap, layerBtn: layerBtn };
});
