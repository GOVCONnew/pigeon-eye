/* PIGEON EYE — awareness HUD controller (Newton). Recreational airsoft / casual play only.
 * Camera → EfficientDet-Lite0 → SENTINEL confirmation tracker → bracket boxes with ~distance & bearing.
 * Sensors: compass (webkitCompassHeading / deviceorientationabsolute), steps (devicemotion), GPS → fused position.
 * Squad: WebRTC data channels (QR signaling, LAN/hotspot) — everything stays on the phones. */
(function () {
  'use strict';
  var VERSION = '1.0.0', $ = function (id) { return document.getElementById(id); }, G = PGeo;
  var ANIMALS = ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'], VEH = ['bicycle', 'car', 'motorcycle', 'bus', 'truck', 'boat'];
  var DEF = { callsign: 'PIGEON-' + Math.floor(Math.random() * 90 + 10), color: '#00E5FF', fov: 73, ph: 1.75, step: 0.72, animals: true, vehicles: false, audio: false, low: false, model: 'effdet0', mapMode: 'heading', mapScale: 2, big: false, id: Math.random().toString(36).slice(2, 10) };
  var S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('pe.settings') || '{}')); function save() { localStorage.setItem('pe.settings', JSON.stringify(S)); applyClasses(); }
  var video = $('cam'), hud = $('hud'), hx = hud.getContext('2d'), mm = $('minimap'), mx = mm.getContext('2d');
  var stream = null, started = false, running = false, busy = false, lastDet = 0, gap = null;
  var heading = 0, headingSrc = 'none', headingAcc = null, fuser = new G.Fuser({ stepLen: S.step }), steps = new G.StepDetector(), stepCal = null, gpsFix = null, battery = null;
  var tracker = new STrack.Tracker({}), contacts = [], waypoints = [], rooms = [], path = [], events = [], squadState = {}, roomN = 1, wpN = 1;
  var stats = { det: [], skipped: 0, detTimes: [], steps: 0, gpsFixes: 0, oriEvents: 0, motEvents: 0 };
  var squad = new PSquad.Squad({ me: { id: S.id, callsign: S.callsign, color: S.color }, onMessage: onSquadMsg, onRoster: renderRoster, onLog: function (a, b) { logEv('squad', a + ' ' + (b || '')); } });
  function applyClasses() { tracker.allowedClasses = new Set(['person'].concat(S.animals ? ANIMALS : [], S.vehicles ? VEH : [])); fuser.stepLen = S.step; squad.me.callsign = S.callsign; squad.me.color = S.color; document.body.classList.toggle('big', !!S.big); }
  applyClasses();
  function toast(t, ms) { var e = $('toast'); e.textContent = t; e.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { e.classList.add('hidden'); }, ms || 2200); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(a, q) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
  function push(a, v, n) { a.push(v); if (a.length > (n || 120)) a.shift(); }
  function me() { return fuser.pos; }

  // ---------- event log (IndexedDB, falls back to memory) ----------
  var db = null;
  (function openDB() { try { var r = indexedDB.open('pigeon-eye', 1); r.onupgradeneeded = function () { r.result.createObjectStore('events', { keyPath: 'id' }); }; r.onsuccess = function () { db = r.result; var q = db.transaction('events').objectStore('events').getAll(); q.onsuccess = function () { events = (q.result || []).sort(function (a, b) { return a.ts < b.ts ? -1 : 1; }).concat(events); }; }; } catch (e) {} })();
  function logEv(type, text, data) {
    var e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: new Date().toISOString(), type: type, text: text, data: data || null, pos: { x: +me().x.toFixed(1), y: +me().y.toFixed(1), mode: fuser.mode } };
    events.push(e); if (db) try { db.transaction('events', 'readwrite').objectStore('events').put(e); } catch (er) {}
    if (!$('sheet').classList.contains('hidden') && $('p-log').classList.contains('active')) renderLog(); return e;
  }

  // ---------- sensors ----------
  function onOrientation(e) {
    stats.oriEvents++; var h = null;
    if (e.webkitCompassHeading != null) { h = e.webkitCompassHeading; headingSrc = 'webkitCompassHeading'; headingAcc = e.webkitCompassAccuracy; }
    else if (e.absolute && e.alpha != null) { h = 360 - e.alpha; headingSrc = 'absolute alpha'; }
    if (h == null) return;
    var so = (screen.orientation && screen.orientation.angle) || window.orientation || 0; heading = G.norm360(h + (e.webkitCompassHeading != null ? so : 0));
  }
  function onMotion(e) {
    stats.motEvents++; var a = e.accelerationIncludingGravity; if (!a || a.x == null || gap) return;
    if (steps.push(e.timeStamp || performance.now(), a.x, a.y, a.z)) { stats.steps++; if (stepCal) stepCal.n++; fuser.step(heading); addPathPoint(); }
  }
  function onGps(p) { stats.gpsFixes++; gpsFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() }; fuser.gps(gpsFix); addPathPoint(); }
  function addPathPoint() { var p = me(), last = path[path.length - 1]; if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.5 && Date.now() - last.t < 5000) return; var ll = fuser.latlon(); path.push({ t: Date.now(), x: +p.x.toFixed(2), y: +p.y.toFixed(2), lat: ll ? +ll.lat.toFixed(7) : null, lon: ll ? +ll.lon.toFixed(7) : null, mode: fuser.mode, acc: fuser.acc != null ? +fuser.acc.toFixed(1) : null, heading: Math.round(heading) }); if (path.length > 20000) path.shift(); }
  function setP(id, txt, ok) { $(id).querySelector('b').textContent = txt; $(id).querySelector('b').style.color = ok ? '' : 'var(--warn)'; }
  async function startSensors() {
    // iOS 13+: both need a user gesture; we are inside the START tap handler
    try { if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) { var r = await DeviceOrientationEvent.requestPermission(); setP('p-ori', r, r === 'granted'); } else setP('p-ori', 'available', true); } catch (e) { setP('p-ori', 'error ' + e.name, false); }
    try { if (window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) { var r2 = await DeviceMotionEvent.requestPermission(); setP('p-mot', r2, r2 === 'granted'); } else setP('p-mot', window.DeviceMotionEvent ? 'available' : 'unsupported', !!window.DeviceMotionEvent); } catch (e) { setP('p-mot', 'error ' + e.name, false); }
    window.addEventListener('deviceorientationabsolute', onOrientation); window.addEventListener('deviceorientation', onOrientation); window.addEventListener('devicemotion', onMotion);
    if (navigator.geolocation) navigator.geolocation.watchPosition(function (p) { setP('p-geo', 'ok ±' + Math.round(p.coords.accuracy) + ' m', true); onGps(p); }, function (e) { setP('p-geo', e.code === 1 ? 'denied — PDR only' : 'unavailable — PDR only', false); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    else setP('p-geo', 'unsupported — PDR only', false);
    if (navigator.getBattery) navigator.getBattery().then(function (b) { battery = b; }).catch(function () {});
  }

  // ---------- camera + detection ----------
  async function startCamera() {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play(); await new Promise(function (r) { if (video.videoWidth) r(); else video.onloadedmetadata = r; });
    stream.getVideoTracks().forEach(function (t) { t.onended = function () { beginGap('camera ended'); }; t.onmute = function () { beginGap('camera muted'); }; t.onunmute = endGap; });
  }
  function resize() { var d = devicePixelRatio || 1; [hud, mm].forEach(function (c) { var r = c.getBoundingClientRect(); c.width = Math.max(1, r.width * d); c.height = Math.max(1, r.height * d); c.getContext('2d').setTransform(d, 0, 0, d, 0, 0); }); }
  window.addEventListener('resize', resize);
  async function detStep(now) {
    busy = true;
    try {
      var W = video.videoWidth, H = video.videoHeight, r = await SDet2.detect(video, W, H, { floor: 0.15, iou: 0.5 });
      push(stats.det, r.t.pre + r.t.infer + r.t.post); push(stats.detTimes, now, 30);
      var u = tracker.update(r.dets, W, H, now);
      u.events.forEach(function (t) { var c = contactFrom(t, W, H); if (!c) return; contacts.push(c); logEv('contact', t.label + ' #' + t.id + ' ~' + G.fmtDist(c.d) + ' ' + Math.round(c.brg) + '°', c); squad.send({ t: 'contact', c: c }); });
      tracker.confirmedVisible().forEach(function (t) { var c = contacts.filter(function (k) { return k.trackId === t.id && k.own; })[0], n = contactFrom(t, W, H); if (c && n) { c.brg = n.brg; c.d = n.d; c.x = n.x; c.y = n.y; c.ts = n.ts; c.clipped = n.clipped; } });
    } catch (e) { console.warn('detect', e); }
    busy = false;
  }
  function contactFrom(t, W, H) {
    var real = t.group === 'person' ? S.ph : ({ dog: 0.6, cat: 0.3, bird: 0.25, horse: 1.6, cow: 1.5, sheep: 0.9, bear: 1.2, car: 1.5, truck: 3, bicycle: 1.1, motorcycle: 1.2 })[t.label] || 1;
    var d = G.estDistance(t.box, W, H, S.fov, real), brg = G.bearingOf(t.box.x + t.box.w / 2, W, H, S.fov, heading); if (!d) return null;
    var p = G.polarToENU(brg, d.m); return { id: S.id + ':' + t.id, trackId: t.id, own: true, by: S.callsign, cls: t.label, conf: +t.maxScore.toFixed(2), brg: +brg.toFixed(1), d: +d.m.toFixed(1), clipped: d.clipped, x: +(me().x + p.x).toFixed(1), y: +(me().y + p.y).toFixed(1), ts: Date.now() };
  }

  // ---------- squad ----------
  function onSquadMsg(m, from) {
    if (m.t === 'state') { squadState[from] = Object.assign(squadState[from] || {}, m.s, { callsign: m.callsign, color: m.color, t: Date.now() }); }
    else if (m.t === 'contact') { var c = Object.assign({}, m.c, { own: false }); if (!contacts.some(function (k) { return k.id === c.id && k.ts === c.ts; })) { contacts.push(c); logEv('contact', 'shared by ' + m.callsign + ': ' + c.cls + ' ~' + G.fmtDist(c.d), c); } }
    else if (m.t === 'waypoint') { upsert(waypoints, m.w); logEv('waypoint', m.callsign + ' set waypoint ' + m.w.name, m.w); }
    else if (m.t === 'room') { upsert(rooms, m.r); logEv('room', m.callsign + ' marked ' + m.r.name + ' clear', m.r); }
    else if (m.t === 'sync') { doSync(m.origin, m.callsign); }
    else if (m.t === 'bundle') { (m.waypoints || []).forEach(function (w) { upsert(waypoints, w); }); (m.rooms || []).forEach(function (r) { upsert(rooms, r); }); }
    else if (m.t === 'hello') { logEv('squad', m.callsign + ' joined'); toast(m.callsign + ' linked'); if (squad.role === 'host') squad.send({ t: 'bundle', waypoints: waypoints, rooms: rooms }); }
  }
  function upsert(arr, o) { var i = arr.findIndex(function (x) { return x.id === o.id; }); if (i >= 0) arr[i] = o; else arr.push(o); }
  /** Squad members' positions in MY frame: lat/lon when both sides have a GPS origin, else shared PDR frame (after SYNC). */
  function memberENU(s) { if (s.lat != null && fuser.origin && s.mode === 'GPS') return G.toENU({ lat: s.lat, lon: s.lon }, fuser.origin); return { x: s.x, y: s.y }; }
  function doSync(origin, by) { fuser.sync(origin || (gpsFix && gpsFix.acc <= 15 ? { lat: gpsFix.lat, lon: gpsFix.lon } : fuser.origin)); path.push({ t: Date.now(), x: 0, y: 0, sync: true, mode: fuser.mode }); logEv('sync', 'start point synced' + (by ? ' by ' + by : ''), { origin: fuser.origin }); toast('Start point synced'); }
  setInterval(function () { if (!started) return; var ll = fuser.latlon(); squad.send({ t: 'state', s: { x: +me().x.toFixed(1), y: +me().y.toFixed(1), lat: ll && fuser.mode === 'GPS' ? +ll.lat.toFixed(6) : null, lon: ll && fuser.mode === 'GPS' ? +ll.lon.toFixed(6) : null, acc: fuser.acc != null ? Math.round(fuser.acc) : null, mode: fuser.mode, heading: Math.round(heading) } }); }, 1000);
  function renderRoster() {
    var st = squad.status(); $('t-link').textContent = st.length ? (squad.role === 'host' ? 'HOST ' : 'LINK ') + st.filter(function (s) { return s.state !== 'stale'; }).length + '/' + st.length : 'SOLO';
    $('t-link').className = 'pill' + (st.length ? (st.some(function (s) { return s.state !== 'live'; }) ? ' warn' : '') : ' dim');
    $('sq-roster').innerHTML = '<b>' + esc(S.callsign) + '</b> (you, ' + (squad.role || 'not linked') + (squad.mode ? ', ' + squad.mode : '') + ')<br>' + (st.length ? st.map(function (s) { var p = squadState[s.id]; return '<span style="color:' + esc(s.color || '#0ef') + '">■</span> ' + esc(s.callsign || s.id) + ' · ' + s.link + ' · ' + (s.rtt != null ? s.rtt + ' ms' : '-- ms') + ' · ' + s.state + (p ? ' · ' + p.mode + (p.acc != null ? ' ±' + p.acc + 'm' : '') : ''); }).join('<br>') : '<span class="muted">no squad members</span>');
  }
  function showQR(str, caption) {
    var q = qrcode(0, 'L'); q.addData(str, 'Byte'); q.make(); var n = q.getModuleCount(), c = document.createElement('canvas'), k = 6; c.width = c.height = n * k; var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var cc = 0; cc < n; cc++) if (q.isDark(r, cc)) x.fillRect(cc * k, r * k, k, k);
    $('sq-qr').innerHTML = ''; $('sq-qr').append(c); var t = document.createElement('div'); t.className = 'mono muted'; t.textContent = caption + ' (' + str.length + ' chars)'; $('sq-qr').append(t); window.__lastCode = str;
  }
  async function scanQR() {
    var ov = $('scanner'), v = $('scanvid'); ov.classList.remove('hidden'); v.srcObject = stream; await v.play().catch(function () {});
    var bd = ('BarcodeDetector' in window) ? new BarcodeDetector({ formats: ['qr_code'] }) : null, c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    return new Promise(function (res, rej) {
      var stop = false; $('scan-cancel').onclick = function () { stop = true; ov.classList.add('hidden'); rej(new Error('cancelled')); };
      (async function tick() {
        if (stop) return;
        try { if (bd) { var r = await bd.detect(v); if (r[0]) { ov.classList.add('hidden'); return res(r[0].rawValue); } }
          else if (v.videoWidth) { var k = Math.min(1, 800 / v.videoWidth); c.width = v.videoWidth * k; c.height = v.videoHeight * k; x.drawImage(v, 0, 0, c.width, c.height); var q = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' }); if (q) { ov.classList.add('hidden'); return res(q.data); } } } catch (e) {}
        setTimeout(tick, 200);
      })();
    });
  }
  async function useCode(str) {
    str = String(str).trim(); var o = await PSquad.decode(str);
    if (o.k === 'o') { var ans = await squad.joinFromOffer(str); showQR(ans, 'ANSWER — show this to the host'); logEv('squad', 'answer created for host ' + o.c); }
    else if (o.k === 'a') { await squad.hostAcceptAnswer(str); $('sq-qr').innerHTML = '<div class="mono">Answer accepted — connecting to ' + esc(o.c) + '…</div>'; }
  }
  $('sq-host').onclick = async function () { try { showQR(await squad.hostCreateOffer(), 'OFFER — joiner scans this'); logEv('squad', 'hosting: offer created'); } catch (e) { toast('Offer failed: ' + e.message); } };
  $('sq-host-scan').onclick = $('sq-join-scan').onclick = async function () { try { await useCode(await scanQR()); } catch (e) { if (e.message !== 'cancelled') toast('Pairing: ' + e.message); } };
  $('sq-paste-go').onclick = function () { useCode($('sq-paste').value).catch(function (e) { toast('Pairing: ' + e.message); }); };
  $('sq-copy').onclick = function () { if (window.__lastCode) { navigator.clipboard && navigator.clipboard.writeText(window.__lastCode); toast('Code copied'); } };
  $('sq-sync').onclick = function () { var origin = gpsFix && gpsFix.acc <= 15 ? { lat: gpsFix.lat, lon: gpsFix.lon } : null; squad.send({ t: 'sync', origin: origin }); doSync(origin); };
  $('sq-on-host').onclick = function () { if (!window.Peer) return loadPeer().then(function () { $('sq-on-host').onclick(); }); $('sq-on-status').textContent = 'contacting PeerJS cloud…'; squad.hostOnline().then(function (code) { $('sq-on-status').textContent = 'ONLINE host code: ' + code + ' (signaling via PeerJS cloud)'; showQR(code, 'ONLINE host code'); }).catch(function (e) { $('sq-on-status').textContent = 'online mode failed (no internet?) ' + e.type; }); };
  $('sq-on-join').onclick = function () { if (!window.Peer) return loadPeer().then(function () { $('sq-on-join').onclick(); }); squad.joinOnline($('sq-on-code').value.trim()).then(function () { $('sq-on-status').textContent = 'joined online'; }).catch(function (e) { $('sq-on-status').textContent = 'join failed ' + (e.type || e); }); };
  function loadPeer() { return new Promise(function (r, j) { var s = document.createElement('script'); s.src = 'vendor/peerjs.min.js'; s.onload = r; s.onerror = j; document.head.append(s); }); }

  // ---------- waypoints / rooms ----------
  function dialog(html) { var d = $('dialog'); d.innerHTML = html; d.classList.remove('hidden'); return d; }
  function waypointDialog(pt, label) {
    var d = dialog('<h3>WAYPOINT ' + esc(label || '') + '</h3><label>Name <input id="wp-name" value="WP ' + wpN + '"></label><label>Colour <input id="wp-color" type="color" value="#FFB000"></label><div class="row"><button class="btn primary" id="wp-ok">DROP</button><button class="btn ghost" id="wp-x">CANCEL</button></div>');
    $('wp-x').onclick = function () { d.classList.add('hidden'); };
    $('wp-ok').onclick = function () { d.classList.add('hidden'); addWaypoint(pt, $('wp-name').value, $('wp-color').value); };
  }
  function addWaypoint(pt, name, color) { wpN++; var ll = fuser.origin ? G.fromENU(pt, fuser.origin) : null; var w = { id: S.id + ':w' + Date.now().toString(36), name: name || ('WP ' + wpN), color: color || '#FFB000', x: +pt.x.toFixed(1), y: +pt.y.toFixed(1), lat: ll && +ll.lat.toFixed(6), lon: ll && +ll.lon.toFixed(6), by: S.callsign, ts: Date.now() }; waypoints.push(w); squad.send({ t: 'waypoint', w: w }); logEv('waypoint', 'waypoint ' + w.name, w); toast('Waypoint ' + w.name); return w; }
  function markClear(name) { var r = { id: S.id + ':r' + Date.now().toString(36), name: name || ('Room ' + roomN++), x: +me().x.toFixed(1), y: +me().y.toFixed(1), by: S.callsign, ts: Date.now(), mode: fuser.mode }; rooms.push(r); squad.send({ t: 'room', r: r }); logEv('room', r.name + ' marked clear', r); toast(r.name + ' CLEAR'); return r; }
  $('b-clear').onclick = function () { var d = dialog('<h3>MARK CLEAR</h3><label>Name <input id="rc-name" value="Room ' + roomN + '"></label><div class="row"><button class="btn primary" id="rc-ok">MARK CLEAR</button><button class="btn ghost" id="rc-x">CANCEL</button></div>'); $('rc-x').onclick = function () { d.classList.add('hidden'); }; $('rc-ok').onclick = function () { d.classList.add('hidden'); var n = $('rc-name').value; if (n === 'Room ' + roomN) n = null; markClear(n); }; };
  $('b-wp').onclick = function () { waypointDialog({ x: me().x, y: me().y }, 'at my position'); };
  hud.addEventListener('click', function (e) {
    if (!started) return; var r = hud.getBoundingClientRect(), T = cover(); if (!T) return;
    var rel = Math.atan((e.clientX - r.left - r.width / 2) / (T.f)) * 180 / Math.PI, brg = G.norm360(heading + rel);
    var d = dialog('<h3>WAYPOINT AT ' + Math.round(brg) + '°</h3><label>Distance <input id="wp-d" type="number" value="20" min="1"> m</label><label>Name <input id="wp-name" value="WP ' + wpN + '"></label><div class="row"><button class="btn primary" id="wp-ok">DROP</button><button class="btn ghost" id="wp-x">CANCEL</button></div>');
    $('wp-x').onclick = function () { d.classList.add('hidden'); };
    $('wp-ok').onclick = function () { d.classList.add('hidden'); var p = G.polarToENU(brg, +$('wp-d').value || 20); addWaypoint({ x: me().x + p.x, y: me().y + p.y }, $('wp-name').value); };
  });
  // minimap: tap small → expand; tap full → waypoint at tapped spot
  mm.addEventListener('click', function (e) {
    if (!mm.classList.contains('full')) { mm.classList.add('full'); $('mapbar').classList.remove('hidden'); resize(); return; }
    var r = mm.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2, sc = S.mapScale * 1.0, dx = (e.clientX - r.left - cx) / sc, dy = -(e.clientY - r.top - cy) / sc;
    if (S.mapMode === 'heading') { var t = heading * Math.PI / 180, rx = dx * Math.cos(t) + dy * Math.sin(t), ry = -dx * Math.sin(t) + dy * Math.cos(t); dx = rx; dy = ry; }
    waypointDialog({ x: me().x + dx, y: me().y + dy }, 'from map');
  });
  $('m-close').onclick = function () { mm.classList.remove('full'); $('mapbar').classList.add('hidden'); resize(); };
  $('m-mode').onclick = function () { S.mapMode = S.mapMode === 'heading' ? 'north' : 'heading'; save(); this.textContent = S.mapMode === 'heading' ? 'HEADING-UP' : 'NORTH-UP'; };
  $('m-zin').onclick = function () { S.mapScale = Math.min(40, S.mapScale * 1.5); save(); }; $('m-zout').onclick = function () { S.mapScale = Math.max(0.2, S.mapScale / 1.5); save(); };

  // ---------- drawing ----------
  var GREEN = '#9ACD32';
  function cover() { var W = video.videoWidth, H = video.videoHeight, r = hud.getBoundingClientRect(); if (!W) return null; var s = Math.max(r.width / W, r.height / H); return { s: s, ox: (r.width - W * s) / 2, oy: (r.height - H * s) / 2, f: G.focalPx(W, H, S.fov) * s, vw: r.width, vh: r.height, hfov: 2 * Math.atan(r.width / 2 / (G.focalPx(W, H, S.fov) * s)) * 180 / Math.PI }; }
  function fs(n) { return Math.round(n * (S.big ? 1.45 : 1)); }
  function bracket(x, y, w, h, col) { var c = Math.max(6, Math.min(w, h) * 0.22); hx.strokeStyle = col; hx.lineWidth = 1.5; hx.beginPath(); [[x, y + c, x, y, x + c, y], [x + w - c, y, x + w, y, x + w, y + c], [x, y + h - c, x, y + h, x + c, y + h], [x + w - c, y + h, x + w, y + h, x + w, y + h - c]].forEach(function (p) { hx.moveTo(p[0], p[1]); hx.lineTo(p[2], p[3]); hx.lineTo(p[4], p[5]); }); hx.stroke(); }
  function txt(s, x, y, col, size, align) { hx.font = '500 ' + fs(size || 12) + 'px ui-monospace, Menlo, monospace'; hx.textAlign = align || 'left'; hx.lineWidth = 3; hx.strokeStyle = 'rgba(0,0,0,.8)'; hx.strokeText(s, x, y); hx.fillStyle = col || GREEN; hx.fillText(s, x, y); }
  function drawCompass(W) {
    var span = 90, y0 = 0, h = fs(46) + 14, top = Math.max(0, $('topbar').offsetTop - (S.big ? 98 : 78)) + 8; // = safe-area inset + 8
    hx.fillStyle = 'rgba(0,0,0,.45)'; hx.fillRect(0, top, W, h);
    var pxPerDeg = W / span; hx.strokeStyle = GREEN; hx.lineWidth = 1;
    for (var d = Math.floor((heading - span / 2) / 5) * 5; d <= heading + span / 2; d += 5) {
      var x = W / 2 + (d - heading) * pxPerDeg, n = G.norm360(d), big = n % 15 === 0; hx.beginPath(); hx.moveTo(x, top + h - 2); hx.lineTo(x, top + h - (big ? 12 : 6)); hx.stroke();
      if (n % 45 === 0) txt(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][n / 45], x, top + h - 16, n === 0 ? '#fff' : GREEN, 12, 'center'); else if (big) txt(String(n), x, top + h - 16, '#8a9a78', 10, 'center');
    }
    function mark(brg, col) { var rel = G.norm180(brg - heading); if (Math.abs(rel) > span / 2) return; var x = W / 2 + rel * pxPerDeg; hx.fillStyle = col; hx.beginPath(); hx.moveTo(x, top + h); hx.lineTo(x - 5, top + h + 7); hx.lineTo(x + 5, top + h + 7); hx.fill(); }
    waypoints.forEach(function (w) { mark(G.enuDistBrg(me(), w).brg, w.color); }); Object.keys(squadState).forEach(function (k) { var s = squadState[k]; if (Date.now() - s.t < 15000) mark(G.enuDistBrg(me(), memberENU(s)).brg, s.color || '#0ef'); });
    contacts.forEach(function (c) { if (Date.now() - c.ts < 60000) mark(G.enuDistBrg(me(), c).brg, '#FF3B30'); });
    txt(String(Math.round(heading)).padStart(3, '0') + '° ' + G.cardinal(heading), W / 2, top + fs(22), '#fff', 20, 'center');
    hx.strokeStyle = '#fff'; hx.beginPath(); hx.moveTo(W / 2, top + h - 2); hx.lineTo(W / 2, top + h - 18); hx.stroke();
  }
  function arrow(ind, col, label) { hx.save(); hx.translate(ind.x, ind.y); hx.rotate(ind.angle * Math.PI / 180); hx.fillStyle = col; hx.beginPath(); hx.moveTo(0, -14); hx.lineTo(-8, 4); hx.lineTo(8, 4); hx.closePath(); hx.fill(); hx.restore(); txt(label, Math.min(Math.max(ind.x, 40), hud.clientWidth - 40), ind.y + (ind.y > hud.clientHeight / 2 ? -14 : 24), col, 11, 'center'); }
  function drawWorldMarker(p, col, label, T, W, H, shape) {
    var db = G.enuDistBrg(me(), p), rel = G.norm180(db.brg - heading), ind = G.edgeIndicator(db.brg, heading, T.hfov, W, H, 40);
    if (ind) { arrow(ind, col, label + ' ' + G.fmtDist(db.d)); return; }
    var x = W / 2 + T.f * Math.tan(rel * Math.PI / 180), y = H * 0.42; hx.strokeStyle = col; hx.lineWidth = 1.5; hx.beginPath();
    if (shape === 'diamond') { hx.moveTo(x, y - 9); hx.lineTo(x + 9, y); hx.lineTo(x, y + 9); hx.lineTo(x - 9, y); hx.closePath(); } else { hx.arc(x, y, 7, 0, 7); } hx.stroke();
    txt(label + ' ' + G.fmtDist(db.d), x, y + 22, col, 12, 'center');
  }
  function drawHUD() {
    var r = hud.getBoundingClientRect(), W = r.width, H = r.height; hx.clearRect(0, 0, W, H); var T = cover(); if (!T) return;
    drawCompass(W);
    // confirmed detections
    var vis = tracker.confirmedVisible(), counts = {};
    vis.forEach(function (t) {
      var b = { x: t.box.x * T.s + T.ox, y: t.box.y * T.s + T.oy, w: t.box.w * T.s, h: t.box.h * T.s }, c = contacts.filter(function (k) { return k.trackId === t.id && k.own; })[0], col = t.group === 'person' ? GREEN : '#00E5FF';
      bracket(b.x, b.y, b.w, b.h, col); counts[t.label] = (counts[t.label] || 0) + 1;
      var lx = Math.max(6, Math.min(W - fs(150), b.x)), ly = Math.max(fs(118) + 18, b.y - 4); if (ly > b.y - 4) ly = Math.min(H - 120, ly + 0); // keep labels on screen, below the top bar
      txt(t.label.toUpperCase() + ' ' + Math.round(t.score * 100) + '%', lx, ly - 14 * (S.big ? 1.45 : 1), col, 12);
      if (c) txt((c.clipped ? '≤' : '~') + G.fmtDist(c.d) + ' · ' + String(Math.round(c.brg)).padStart(3, '0') + '°', lx, ly, col, 13);
    });
    $('counts').textContent = Object.keys(counts).map(function (k) { return k.toUpperCase() + ' ' + counts[k]; }).join('  ') || 'NO CONTACTS'; if (topSound) $('counts').textContent += '  ♪ ' + topSound.label;
    // squad (friendly, from shared positions), waypoints, recent contacts out of view
    Object.keys(squadState).forEach(function (k) { var s = squadState[k], age = Date.now() - s.t; if (age > 60000) return; hx.globalAlpha = age > 15000 ? 0.35 : age > 6000 ? 0.65 : 1; drawWorldMarker(memberENU(s), s.color || '#0ef', '◆' + (s.callsign || k), T, W, H, 'diamond'); hx.globalAlpha = 1; });
    waypoints.forEach(function (w) { drawWorldMarker(w, w.color, w.name, T, W, H); });
    contacts.forEach(function (c) { var age = Date.now() - c.ts; if (age > 60000 || (c.own && vis.some(function (t) { return t.id === c.trackId; }))) return; var db = G.enuDistBrg(me(), c), ind = G.edgeIndicator(db.brg, heading, T.hfov, W, H, 40); if (ind) { hx.globalAlpha = Math.max(0.3, 1 - age / 60000); arrow(ind, '#FF3B30', c.cls + ' ' + G.fmtDist(db.d) + ' ' + Math.round(age / 1000) + 's'); hx.globalAlpha = 1; } });
  }
  function drawMap() {
    var r = mm.getBoundingClientRect(), W = r.width, H = r.height, cx = W / 2, cy = H / 2, sc = S.mapScale * (mm.classList.contains('full') ? 1 : 0.6), P = function (p) { return G.project(p, me(), S.mapMode, heading, sc, cx, cy); };
    mx.clearRect(0, 0, W, H); mx.save(); if (!mm.classList.contains('full')) { mx.beginPath(); mx.arc(cx, cy, W / 2, 0, 7); mx.clip(); }
    mx.strokeStyle = 'rgba(154,205,50,.25)'; mx.lineWidth = 1; [10, 25, 50, 100, 250].forEach(function (m) { if (m * sc < Math.max(W, H)) { mx.beginPath(); mx.arc(cx, cy, m * sc, 0, 7); mx.stroke(); } });
    mx.strokeStyle = 'rgba(154,205,50,.8)'; mx.beginPath(); path.slice(-3000).forEach(function (p, i) { var q = P(p); if (i && !p.sync) mx.lineTo(q.x, q.y); else mx.moveTo(q.x, q.y); }); mx.stroke();
    rooms.forEach(function (rm) { var q = P(rm); mx.strokeStyle = GREEN; mx.strokeRect(q.x - 6, q.y - 6, 12, 12); mx.beginPath(); mx.moveTo(q.x - 4, q.y); mx.lineTo(q.x - 1, q.y + 3); mx.lineTo(q.x + 4, q.y - 3); mx.stroke(); mtxt(rm.name, q.x + 8, q.y + 4, GREEN); });
    waypoints.forEach(function (w) { var q = P(w); mx.fillStyle = w.color; mx.beginPath(); mx.moveTo(q.x, q.y - 7); mx.lineTo(q.x + 5, q.y); mx.lineTo(q.x, q.y + 7); mx.lineTo(q.x - 5, q.y); mx.fill(); mtxt(w.name, q.x + 7, q.y + 4, w.color); });
    contacts.forEach(function (c) { var age = Date.now() - c.ts; if (age > 300000) return; var q = P(c); mx.globalAlpha = Math.max(0.15, 1 - age / 300000); mx.strokeStyle = '#FF3B30'; mx.beginPath(); mx.moveTo(q.x - 4, q.y - 4); mx.lineTo(q.x + 4, q.y + 4); mx.moveTo(q.x + 4, q.y - 4); mx.lineTo(q.x - 4, q.y + 4); mx.stroke(); if (mm.classList.contains('full')) mtxt(c.cls + ' ' + Math.round(age / 1000) + 's', q.x + 6, q.y + 3, '#FF3B30'); mx.globalAlpha = 1; });
    Object.keys(squadState).forEach(function (k) { var s = squadState[k], age = Date.now() - s.t; if (age > 60000) return; var q = P(memberENU(s)); mx.globalAlpha = age > 15000 ? 0.35 : 1; mx.fillStyle = s.color || '#0ef'; mx.beginPath(); mx.arc(q.x, q.y, 5, 0, 7); mx.fill(); mtxt(s.callsign || k, q.x + 7, q.y + 4, s.color || '#0ef'); mx.globalAlpha = 1; });
    // me
    mx.save(); mx.translate(cx, cy); mx.rotate(S.mapMode === 'heading' ? 0 : heading * Math.PI / 180); mx.fillStyle = '#fff'; mx.beginPath(); mx.moveTo(0, -9); mx.lineTo(6, 7); mx.lineTo(0, 3); mx.lineTo(-6, 7); mx.fill(); mx.restore();
    if (S.mapMode === 'heading') { var nq = G.project({ x: me().x, y: me().y + 1000 }, me(), 'heading', heading, 1, cx, cy), a = Math.atan2(nq.x - cx, cy - nq.y); mtxt('N', cx + Math.sin(a) * (Math.min(W, H) / 2 - 12) - 4, cy - Math.cos(a) * (Math.min(W, H) / 2 - 12) + 4, '#fff'); } else mtxt('N', cx - 4, 14, '#fff');
    mx.restore(); $('m-scale').textContent = Math.round(50 / sc) + ' m / 50 px';
  }
  function mtxt(s, x, y, col) { mx.font = '11px ui-monospace, Menlo, monospace'; mx.fillStyle = col; mx.fillText(s, x, y); }
  function topbar() {
    var m = fuser.tick(Date.now()), ll = fuser.latlon(); $('t-mode').textContent = m; $('t-mode').className = 'pill' + (m === 'PDR' ? ' warn' : '');
    $('t-acc').textContent = '±' + (fuser.acc != null ? Math.round(fuser.acc) + 'm' : '--');
    $('t-ll').textContent = gpsFix ? gpsFix.lat.toFixed(5) + ' ' + gpsFix.lon.toFixed(5) : (ll ? '' : 'no GPS · rel ' + me().x.toFixed(0) + 'E ' + me().y.toFixed(0) + 'N');
    $('t-clock').textContent = new Date().toTimeString().slice(0, 8); $('t-bat').textContent = battery ? Math.round(battery.level * 100) + '%' + (battery.charging ? '+' : '') : '';
  }
  function loop() {
    requestAnimationFrame(loop); if (!started) return; var now = performance.now();
    if (running && !gap && SDet2.isReady() && video.videoWidth) { if (!busy && now - lastDet >= (S.low ? 800 : 250)) { lastDet = now; detStep(now); } else if (busy && now - lastDet > 250) stats.skipped++; }
    drawHUD(); drawMap(); if (((now / 500) | 0) !== loop._k) { loop._k = (now / 500) | 0; topbar(); if (!$('sheet').classList.contains('hidden') && $('p-diag').classList.contains('active')) renderDiag(); }
  }


  // ---------- optional sound classification (YAMNet, off by default; model fetched/cached only when enabled) ----------
  var mic = null, smoother = null, audioOn = false, topSound = null, audioBusy = false;
  function loadScript(src) { return new Promise(function (r, j) { if (document.querySelector('script[src="' + src + '"]')) return r(); var s = document.createElement('script'); s.src = src; s.onload = r; s.onerror = function () { j(new Error('load ' + src)); }; document.head.append(s); }); }
  async function startAudio() {
    try {
      toast('Loading sound model (~16 MB)…', 4000);
      await loadScript('vendor/tf.min.js'); await loadScript('js/audio.js'); await loadScript('js/audiologic.js');
      var as = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      mic = new SAudio.Mic(); await mic.start(as); await SAudio.load();
      smoother = new SAudioLogic.Smoother(SAudio.getClasses(), {}); audioOn = true; logEv('sound', 'sound classification on'); toast('Sound classification on');
    } catch (e) { audioOn = false; toast('Sound unavailable: ' + e.message); }
  }
  function stopAudio() { if (mic) mic.stop(); mic = null; audioOn = false; topSound = null; }
  setInterval(async function () {
    if (!audioOn || audioBusy || gap || !mic || !mic.ready()) return; audioBusy = true;
    try { var r = await SAudio.classify(mic.buf, 3), st = smoother.push(r.scores, 20 * Math.log10(mic.level + 1e-8), Date.now()); topSound = r.top[0];
      st.events.forEach(function (e) { logEv('sound', e.cat + ' ' + Math.round(e.score * 100) + '% (top: ' + r.top.map(function (t) { return t.label; }).join(', ') + ')', e); }); } catch (e) {}
    audioBusy = false;
  }, 1000);

  // ---------- gaps ----------
  function beginGap(why) { if (gap || !started) return; gap = { t: Date.now(), why: why }; $('gapbanner').classList.remove('hidden'); }
  function endGap() { if (!gap) return; var d = (Date.now() - gap.t) / 1000; logEv('gap', 'NOT tracking for ' + d.toFixed(0) + ' s (' + gap.why + ')', { from: new Date(gap.t).toISOString(), sec: Math.round(d) }); gap = null; $('gapbanner').classList.add('hidden'); tracker.reset(); toast('Resumed — gap logged'); }
  document.addEventListener('visibilitychange', async function () { if (!started) return; if (document.visibilityState === 'hidden') return beginGap('app hidden / screen locked'); keepAwake(); if (stream && stream.getVideoTracks().some(function (t) { return t.readyState === 'ended'; })) { try { await startCamera(); } catch (e) { toast('Camera restart failed — reload'); } } try { await video.play(); } catch (e) {} endGap(); });
  window.addEventListener('pagehide', function () { beginGap('page hidden'); });
  var wakeLock = null; async function keepAwake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', function () { wakeLock = null; }); } } catch (e) {} try { await $('nosleep').play(); } catch (e) {} }

  // ---------- sheet: settings / log / diag ----------
  function openSheet(p) { $('sheet').classList.remove('hidden'); document.querySelectorAll('.pane').forEach(function (x) { x.classList.toggle('active', x.id === 'p-' + p); }); document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.p === p); }); if (p === 'log') renderLog(); if (p === 'diag') renderDiag(); if (p === 'squad') renderRoster(); }
  document.querySelectorAll('#tabs button').forEach(function (b) { b.onclick = function () { openSheet(b.dataset.p); }; });
  $('sheet-close').onclick = function () { $('sheet').classList.add('hidden'); }; $('b-menu').onclick = function () { openSheet('settings'); }; $('b-squad').onclick = function () { openSheet('squad'); };
  $('b-big').onclick = function () { S.big = !S.big; save(); this.classList.toggle('on', S.big); };
  $('btn-start-help').onclick = function () { openSheet('help'); };
  function bind(id, key, num) { var e = $(id); if (e.type === 'checkbox') e.checked = !!S[key]; else e.value = S[key]; e.onchange = function () { S[key] = e.type === 'checkbox' ? e.checked : num ? +e.value : e.value; save(); if (key === 'model') SDet2.load(S.model).then(function () { toast('Detector ready'); }); if (key === 'audio') { if (S.audio && started) startAudio(); else stopAudio(); } }; }
  [['s-call', 'callsign'], ['s-color', 'color'], ['s-fov', 'fov', 1], ['s-ph', 'ph', 1], ['s-step', 'step', 1], ['s-animals', 'animals'], ['s-vehicles', 'vehicles'], ['s-audio', 'audio'], ['s-low', 'low'], ['s-model', 'model']].forEach(function (b) { bind(b[0], b[1], b[2]); });
  $('s-cal').onclick = function () { var d = +$('s-cal-d').value, t = tracker.confirmedVisible().filter(function (x) { return x.group === 'person'; }).sort(function (a, b) { return b.box.h - a.box.h; })[0]; if (!d || !t) return toast('Need a known distance and a confirmed person in view'); if (t.box.y <= 2 || t.box.y + t.box.h >= video.videoHeight - 2) return toast('Person is cut off by the frame — step back'); S.fov = +G.calibrateFov(t.box.h, video.videoWidth, video.videoHeight, S.ph, d).toFixed(1); save(); $('s-fov').value = S.fov; logEv('calibration', 'FOV calibrated to ' + S.fov + '°'); toast('FOV = ' + S.fov + '°'); };
  $('s-step-start').onclick = function () { stepCal = { n: 0, t: Date.now() }; $('s-step-info').textContent = 'Walk the measured distance now…'; };
  $('s-step-stop').onclick = function () { var d = +$('s-step-d').value; if (!stepCal || !d || stepCal.n < 4) { $('s-step-info').textContent = 'Need ≥4 steps and a distance (' + (stepCal ? stepCal.n : 0) + ' steps)'; return; } S.step = +(d / stepCal.n).toFixed(3); save(); $('s-step').value = S.step; $('s-step-info').textContent = stepCal.n + ' steps → ' + S.step + ' m/step'; logEv('calibration', 'step length ' + S.step + ' m'); stepCal = null; };
  function renderLog() { $('log-list').innerHTML = events.slice(-300).reverse().map(function (e) { return '<li>' + e.ts.slice(11, 19) + ' ' + e.type.toUpperCase() + ' · ' + esc(e.text) + '</li>'; }).join(''); }
  function renderDiag() {
    var c = SDet2.current(), rate = stats.detTimes.length > 1 ? (1000 * (stats.detTimes.length - 1) / (stats.detTimes[stats.detTimes.length - 1] - stats.detTimes[0])).toFixed(2) : '0';
    var rows = [['Version', VERSION], ['Detector', c ? c.label + ' · ' + c.backend + ' · ' + c.inputSize + 'px' : 'loading'], ['Detections/s', rate], ['Latency p50 / p95', (pct(stats.det, .5) || 0).toFixed(0) + ' / ' + (pct(stats.det, .95) || 0).toFixed(0) + ' ms'], ['Skipped slots', stats.skipped],
      ['Tracks', tracker.tracks.map(function (t) { return (t.id || '…') + ':' + t.label + ':' + t.state; }).join(', ') || 'none'], ['Heading', Math.round(heading) + '° via ' + headingSrc + (headingAcc != null ? ' (±' + headingAcc + '°)' : '') + ' · events ' + stats.oriEvents],
      ['Position', fuser.mode + ' · ' + me().x.toFixed(1) + 'E ' + me().y.toFixed(1) + 'N · ±' + (fuser.acc != null ? fuser.acc.toFixed(1) : '--') + ' m · origin ' + (fuser.origin ? fuser.origin.lat.toFixed(5) + ',' + fuser.origin.lon.toFixed(5) : 'none (relative)')],
      ['Steps', stats.steps + ' · step ' + S.step + ' m · path ' + fuser.pathLen.toFixed(0) + ' m · motion events ' + stats.motEvents], ['GPS fixes', stats.gpsFixes + (gpsFix ? ' · last ±' + Math.round(gpsFix.acc) + ' m' : '')], ['FOV', S.fov + '° long side → ' + (video.videoWidth ? G.hfovDeg(video.videoWidth, video.videoHeight, S.fov).toFixed(1) + '° horizontal (frame)' : '')],
      ['Squad', (squad.role || 'solo') + ' · ' + squad.status().map(function (s) { return s.callsign + ' ' + s.link + ' ' + (s.rtt != null ? s.rtt + 'ms' : '') + ' ' + s.state; }).join('; ')], ['Offline cache', offlineMsg], ['Path points / events', path.length + ' / ' + events.length]];
    $('diag').innerHTML = rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('');
  }
  // ---------- export ----------
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }
  function offer(name, txt, type) { var f = new File([txt], name, { type: type }), a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = name; a.textContent = '⬇ ' + name; $('x-links').prepend(a); a.click(); return f; }
  function csv(rows, cols) { return cols.join(',') + '\n' + rows.map(function (r) { return cols.map(function (c) { var v = r[c]; v = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n') + '\n'; }
  function sessionJSON() { return JSON.stringify({ app: 'Newton PIGEON EYE', version: VERSION, exported: new Date().toISOString(), callsign: S.callsign, origin: fuser.origin, settings: { fov: S.fov, personHeight: S.ph, step: S.step }, events: events, path: path, waypoints: waypoints, rooms: rooms, contacts: contacts, squad: squad.status(), diagnostics: { p50: pct(stats.det, .5), p95: pct(stats.det, .95), steps: stats.steps, gpsFixes: stats.gpsFixes, detector: SDet2.current() && SDet2.current().label } }, null, 2); }
  function geojson() {
    var o = fuser.origin, ll = function (p) { if (p.lat != null) return [p.lon, p.lat]; if (!o) return null; var q = G.fromENU(p, o); return [+q.lon.toFixed(7), +q.lat.toFixed(7)]; };
    var feats = [], coords = path.map(ll).filter(Boolean);
    if (coords.length > 1) feats.push({ type: 'Feature', properties: { name: S.callsign + ' path', points: path.length }, geometry: { type: 'LineString', coordinates: coords } });
    waypoints.forEach(function (w) { var c = ll(w); if (c) feats.push({ type: 'Feature', properties: { kind: 'waypoint', name: w.name, color: w.color, by: w.by }, geometry: { type: 'Point', coordinates: c } }); });
    rooms.forEach(function (r) { var c = ll(r); if (c) feats.push({ type: 'Feature', properties: { kind: 'room-clear', name: r.name, by: r.by, time: new Date(r.ts).toISOString() }, geometry: { type: 'Point', coordinates: c } }); });
    return JSON.stringify({ type: 'FeatureCollection', properties: { note: o ? 'PDR segments converted with the GPS/sync origin' : 'No GPS origin: positions are relative only and are omitted here — use PATH CSV (x/y metres)', localPathPoints: path.length }, features: feats });
  }
  $('x-json').onclick = function () { offer('pigeoneye_' + stamp() + '.json', sessionJSON(), 'application/json'); };
  $('x-csv').onclick = function () { offer('pigeoneye_events_' + stamp() + '.csv', csv(events.map(function (e) { return { ts: e.ts, type: e.type, text: e.text, x: e.pos.x, y: e.pos.y, mode: e.pos.mode }; }), ['ts', 'type', 'text', 'x', 'y', 'mode']), 'text/csv'); };
  $('x-path-csv').onclick = function () { offer('pigeoneye_path_' + stamp() + '.csv', csv(path.map(function (p) { return Object.assign({ time: new Date(p.t).toISOString() }, p); }), ['time', 'x', 'y', 'lat', 'lon', 'mode', 'acc', 'heading', 'sync']), 'text/csv'); };
  $('x-geojson').onclick = function () { offer('pigeoneye_' + stamp() + '.geojson', geojson(), 'application/geo+json'); };
  $('x-clear').onclick = function () { if (!confirm('Clear log, path, waypoints and rooms?')) return; events = []; path = []; waypoints = []; rooms = []; contacts = []; if (db) db.transaction('events', 'readwrite').objectStore('events').clear(); renderLog(); };

  // ---------- offline (service worker) ----------
  var offlineMsg = 'checking';
  function setOffline(t) { offlineMsg = t; $('offline-status').textContent = 'Offline cache: ' + t; }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; }).then(function (reg) { var ask = function () { reg.active && reg.active.postMessage('status'); }; ask(); setTimeout(ask, 3000); setTimeout(ask, 10000); }).catch(function (e) { setOffline('unavailable (' + e.message + ')'); });
    navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'status') setOffline(e.data.ready ? 'READY — works with no signal (' + e.data.cached + ' files)' : 'caching ' + e.data.cached + '/' + e.data.total + '…'); });
  } else setOffline('not supported in this browser');

  // ---------- boot ----------
  async function boot() {
    $('help-env').textContent = 'PIGEON EYE ' + VERSION + ' · ' + navigator.userAgent;
    try { await SDet2.load(S.model, {}, function (s) { $('model-status').textContent = 'Detector: ' + s; }); var c = SDet2.current(); $('model-status').textContent = 'Detector: ' + c.label + ' · ' + c.backend; }
    catch (e) { $('model-status').textContent = 'Detector failed (' + e.message + ') → COCO-SSD'; try { if (!window.tf) await new Promise(function (r, j) { var s = document.createElement('script'); s.src = 'vendor/tf.min.js'; s.onload = r; s.onerror = j; document.head.append(s); }); await SDet2.load('coco-lite'); $('model-status').textContent = 'Detector: COCO-SSD fallback'; } catch (e2) { $('model-status').textContent = 'Detector unavailable'; } }
  }
  $('btn-start').onclick = async function () {
    keepAwake();
    try { await startCamera(); setP('p-cam', 'ok', true); } catch (e) { setP('p-cam', e.name === 'NotAllowedError' ? 'denied — see Help' : 'error ' + e.name, false); return; }
    await startSensors();
    started = true; running = true; if (S.audio) startAudio(); $('start').classList.add('hidden'); resize(); logEv('session', 'started · ' + (SDet2.current() ? SDet2.current().label : 'no detector'));
  };
  window.__pe = { VERSION: VERSION, S: S, squad: squad, fuser: fuser, tracker: tracker, waypoints: function () { return waypoints; }, rooms: function () { return rooms; }, contacts: function () { return contacts; }, events: function () { return events; }, path: function () { return path; }, squadState: function () { return squadState; },
    useCode: useCode, addWaypoint: addWaypoint, markClear: markClear, setHeading: function (h) { heading = h; }, gps: function (lat, lon, acc) { onGps({ coords: { latitude: lat, longitude: lon, accuracy: acc } }); }, step: function () { stats.steps++; fuser.step(heading); addPathPoint(); }, sync: function () { $('sq-sync').click(); }, geojson: geojson, sessionJSON: sessionJSON, offline: function () { return offlineMsg; }, openSheet: openSheet, stats: stats };
  requestAnimationFrame(loop); boot();
})();
