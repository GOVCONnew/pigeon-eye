/* PIGEON EYE — geometry: monocular distance/bearing estimates, geodesy, local ENU frame, minimap projection,
 * off-screen edge indicators, pedestrian dead reckoning (step detection) and GPS/PDR fusion. Pure JS. */
(function (global) {
  'use strict';
  var D2R = Math.PI / 180, R2D = 180 / Math.PI, RE = 6371008.8;
  function norm360(a) { a %= 360; return a < 0 ? a + 360 : a; }
  function norm180(a) { a = norm360(a); return a > 180 ? a - 360 : a; }
  /** Focal length in px for a frame whose LONG side spans fovLongDeg. */
  function focalPx(W, H, fovLongDeg) { return (Math.max(W, H) / 2) / Math.tan(fovLongDeg / 2 * D2R); }
  /** Pinhole estimate: distance ≈ realHeight · f / boxHeight. clipped = box touches top/bottom edge → true distance is ≤ estimate. */
  function estDistance(box, W, H, fovLongDeg, realH) {
    if (!box || box.h < 2) return null; var f = focalPx(W, H, fovLongDeg), d = realH * f / box.h;
    var clipped = box.y <= 2 || box.y + box.h >= H - 2; return { m: d, clipped: clipped };
  }
  /** Horizontal angle of image column cx relative to optical axis (deg, + right). */
  function offsetDeg(cx, W, H, fovLongDeg) { return Math.atan((cx - W / 2) / focalPx(W, H, fovLongDeg)) * R2D; }
  function hfovDeg(W, H, fovLongDeg) { return 2 * Math.atan((W / 2) / focalPx(W, H, fovLongDeg)) * R2D; }
  function bearingOf(cx, W, H, fovLongDeg, heading) { return norm360(heading + offsetDeg(cx, W, H, fovLongDeg)); }
  /** Calibrate FOV from a target of known height at known distance. */
  function calibrateFov(boxH, W, H, realH, distM) { var f = distM * boxH / realH; return 2 * Math.atan((Math.max(W, H) / 2) / f) * R2D; }
  // ---- geodesy ----
  function haversine(a, b) { var p1 = a.lat * D2R, p2 = b.lat * D2R, dp = p2 - p1, dl = (b.lon - a.lon) * D2R, h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * RE * Math.asin(Math.min(1, Math.sqrt(h))); }
  function bearing(a, b) { var p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R; return norm360(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D); }
  function destination(a, brgDeg, d) { var p1 = a.lat * D2R, l1 = a.lon * D2R, t = brgDeg * D2R, dr = d / RE, p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(t)), l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2)); return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 }; }
  /** Local tangent plane (equirectangular, fine for < few km): east/north metres from origin. */
  function toENU(p, o) { return { x: (p.lon - o.lon) * D2R * RE * Math.cos(o.lat * D2R), y: (p.lat - o.lat) * D2R * RE }; }
  function fromENU(e, o) { return { lat: o.lat + e.y / RE * R2D, lon: o.lon + e.x / (RE * Math.cos(o.lat * D2R)) * R2D }; }
  /** Polar (bearing from north, distance) → ENU offset. */
  function polarToENU(brg, d) { return { x: d * Math.sin(brg * D2R), y: d * Math.cos(brg * D2R) }; }
  function enuDistBrg(from, to) { var dx = to.x - from.x, dy = to.y - from.y; return { d: Math.hypot(dx, dy), brg: norm360(Math.atan2(dx, dy) * R2D) }; }
  // ---- minimap ----
  /** Project ENU point (metres) to minimap pixels. me = ENU of user, mode 'heading'|'north', scale px per metre. */
  function project(p, me, mode, heading, scale, cx, cy) {
    var dx = p.x - me.x, dy = p.y - me.y;
    if (mode === 'heading') { var t = heading * D2R, rx = dx * Math.cos(t) - dy * Math.sin(t), ry = dx * Math.sin(t) + dy * Math.cos(t); dx = rx; dy = ry; }
    return { x: cx + dx * scale, y: cy - dy * scale };
  }
  // ---- off-screen indicators ----
  /** Given target bearing, heading and horizontal FOV, return null if in view, else an edge point + arrow angle. */
  function edgeIndicator(targetBrg, heading, hfov, W, H, margin) {
    var rel = norm180(targetBrg - heading); if (Math.abs(rel) <= hfov / 2) return null;
    margin = margin || 28; var a = rel * D2R, cx = W / 2, cy = H / 2, dx = Math.sin(a), dy = -Math.cos(a);
    var sx = (W / 2 - margin) / Math.max(1e-6, Math.abs(dx)), sy = (H / 2 - margin) / Math.max(1e-6, Math.abs(dy)), s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s, angle: rel, behind: Math.abs(rel) > 135 };
  }
  // ---- PDR ----
  /** Step detector on accelerometer magnitude (incl. gravity, m/s²): band-pass via fast/slow EMA, hysteresis, cadence limits. */
  function StepDetector(o) { o = o || {}; this.hi = o.hi || 1.0; this.lo = o.lo || -0.4; this.minDt = o.minDt || 280; this.maxDt = o.maxDt || 2000; this.reset(); }
  StepDetector.prototype.reset = function () { this.fast = null; this.slow = null; this.armed = false; this.lastStep = -1e9; this.steps = 0; this.peak = 0; };
  /** returns true when a step is detected at time t (ms) */
  StepDetector.prototype.push = function (t, ax, ay, az) {
    var m = Math.sqrt(ax * ax + ay * ay + az * az);
    if (this.fast == null) { this.fast = m; this.slow = m; return false; }
    this.fast += 0.35 * (m - this.fast); this.slow += 0.02 * (m - this.slow); var v = this.fast - this.slow;
    if (v > this.hi) { this.armed = true; this.peak = Math.max(this.peak, v); }
    if (this.armed && v < this.lo) { this.armed = false; var pk = this.peak; this.peak = 0; if (t - this.lastStep >= this.minDt && pk > this.hi) { this.lastStep = t; this.steps++; return true; } }
    return false;
  };
  /** Position fuser in a local ENU frame. Steps move along heading; good GPS fixes pull the estimate (complementary blend). */
  function Fuser(o) { o = o || {}; this.stepLen = o.stepLen || 0.72; this.goodAcc = o.goodAcc || 15; this.origin = o.origin || null; this.pos = { x: 0, y: 0 }; this.mode = 'PDR'; this.acc = null; this.lastGps = null; this.pathLen = 0; this.pdrErr = 0; }
  Fuser.prototype.step = function (heading) { var d = polarToENU(heading, this.stepLen); this.pos = { x: this.pos.x + d.x, y: this.pos.y + d.y }; this.pathLen += this.stepLen; this.pdrErr += this.stepLen * 0.05; return this.pos; };
  /** fix {lat,lon,acc,t}. Returns current mode. */
  Fuser.prototype.gps = function (fix) {
    this.lastGps = fix;
    if (fix.acc > this.goodAcc * 3) { this.mode = 'PDR'; return this.mode; }
    if (!this.origin) { this.origin = { lat: fix.lat, lon: fix.lon }; this.pos = { x: 0, y: 0 }; }
    var g = toENU(fix, this.origin), w = Math.max(0.05, Math.min(0.9, (this.goodAcc * 2 - fix.acc) / (this.goodAcc * 2)));
    if (fix.acc <= this.goodAcc) { this.pos = { x: this.pos.x + w * (g.x - this.pos.x), y: this.pos.y + w * (g.y - this.pos.y) }; this.mode = 'GPS'; this.acc = fix.acc; this.pdrErr = 0; }
    else { this.mode = 'PDR'; }
    return this.mode;
  };
  Fuser.prototype.tick = function (now) { if (this.mode === 'GPS' && (!this.lastGps || now - this.lastGps.t > 8000)) this.mode = 'PDR'; if (this.mode === 'PDR') this.acc = (this.lastGps && this.lastGps.acc <= this.goodAcc ? this.lastGps.acc : 0) + this.pdrErr; return this.mode; };
  Fuser.prototype.sync = function (origin) { this.pos = { x: 0, y: 0 }; this.pathLen = 0; this.pdrErr = 0; if (origin) this.origin = origin; };
  Fuser.prototype.latlon = function () { return this.origin ? fromENU(this.pos, this.origin) : null; };
  function fmtDist(m) { if (m == null || !isFinite(m)) return '--'; return m < 100 ? Math.round(m) + 'm' : m < 1000 ? (Math.round(m / 5) * 5) + 'm' : (m / 1000).toFixed(1) + 'km'; }
  var CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']; function cardinal(h) { return CARD[Math.round(norm360(h) / 45) % 8]; }
  var api = { norm360: norm360, norm180: norm180, focalPx: focalPx, estDistance: estDistance, offsetDeg: offsetDeg, hfovDeg: hfovDeg, bearingOf: bearingOf, calibrateFov: calibrateFov, haversine: haversine, bearing: bearing, destination: destination,
    toENU: toENU, fromENU: fromENU, polarToENU: polarToENU, enuDistBrg: enuDistBrg, project: project, edgeIndicator: edgeIndicator, StepDetector: StepDetector, Fuser: Fuser, fmtDist: fmtDist, cardinal: cardinal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.PGeo = api;
})(typeof window !== 'undefined' ? window : globalThis);
