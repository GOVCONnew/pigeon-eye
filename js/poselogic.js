/* PIGEON EYE — pose post-processing (pure JS, testable): landmark smoothing, hand visibility, hands-up with
 * hysteresis + hold time (upper-body only, so it works crouched), shoulder-width distance estimate.
 * Landmarks: MediaPipe 33-point pose, normalised x,y in [0,1] of the frame, visibility in [0,1]. */
(function (global) {
  'use strict';
  var L = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lPi: 17, rPi: 18, lIx: 19, rIx: 20, lTh: 21, rTh: 22, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28 };
  var EDGES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [28, 30], [30, 32]];
  var CFG = { visMin: 0.5, upOn: 0.30, upOff: 0.12, holdOnMs: 500, holdOffMs: 350, alpha: 0.5, shoulderM: 0.40 };
  function vis(p, t) { return !!p && (p.visibility == null ? 1 : p.visibility) >= (t || CFG.visMin) && p.x >= -0.02 && p.x <= 1.02 && p.y >= -0.02 && p.y <= 1.02; }
  function bbox(lm, W, H) { var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; lm.forEach(function (p) { if (!vis(p, 0.3)) return; x0 = Math.min(x0, p.x * W); y0 = Math.min(y0, p.y * H); x1 = Math.max(x1, p.x * W); y1 = Math.max(y1, p.y * H); }); return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
  /** Hands visible = per side, wrist or any hand point (pinky/index/thumb) visible. */
  function handsVisible(lm) { var n = 0; [[15, 17, 19, 21], [16, 18, 20, 22]].forEach(function (s) { if (s.some(function (i) { return vis(lm[i]); })) n++; }); return n; }
  function handsText(n) { return n === 2 ? '2 visible' : n === 1 ? '1 visible' : 'not visible'; }
  /** Per-arm raise score: (shoulderY - wristY) / shoulderWidth (image y grows downward). null if unknown. */
  function raise(lm, side, W, H) {
    var sh = lm[side === 'l' ? 11 : 12], wr = lm[side === 'l' ? 15 : 16], a = lm[11], b = lm[12];
    if (!vis(sh) || !vis(wr) || !vis(a, 0.3) || !vis(b, 0.3)) return null;
    var sw = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H); if (sw < 4) return null; return (sh.y - wr.y) * H / sw;
  }
  /** Shoulder-width distance (m): realShoulder × f / shoulderPx. Under-estimates width when the person is side-on → over-estimates distance. */
  function shoulderDistance(lm, W, H, focal) { var a = lm[11], b = lm[12]; if (!vis(a) || !vis(b)) return null; var px = Math.hypot((a.x - b.x) * W, (a.y - b.y) * H); return px < 6 ? null : CFG.shoulderM * focal / px; }
  /** Per-person state: smoothing + hands-up hysteresis. */
  function PoseState() { this.lm = null; this.arm = { l: { up: false, since: null }, r: { up: false, since: null } }; this.lastT = 0; }
  PoseState.prototype.update = function (raw, W, H, now, preFiltered) {
    var a = CFG.alpha;
    if (preFiltered || !this.lm || now - this.lastT > 1000) this.lm = raw.map(function (p) { return { x: p.x, y: p.y, visibility: p.visibility == null ? 1 : p.visibility }; });
    else this.lm = this.lm.map(function (o, i) { var p = raw[i]; return { x: o.x + a * (p.x - o.x), y: o.y + a * (p.y - o.y), visibility: o.visibility + a * ((p.visibility == null ? 1 : p.visibility) - o.visibility) }; });
    this.lastT = now; var self = this;
    ['l', 'r'].forEach(function (s) {
      var r = raise(self.lm, s, W, H), st = self.arm[s], want = st.up ? !(r == null || r < CFG.upOff) : (r != null && r > CFG.upOn);
      if (want !== st.up) { if (st.since == null) st.since = now; if (now - st.since >= (want ? CFG.holdOnMs : CFG.holdOffMs)) { st.up = want; st.since = null; } } else st.since = null;
      st.score = r;
    });
    var n = (this.arm.l.up ? 1 : 0) + (this.arm.r.up ? 1 : 0);
    this.handsUp = n; this.tag = n === 2 ? 'HANDS UP' : n === 1 ? '1 HAND UP' : ''; this.hands = handsVisible(this.lm); return this;
  };
  function iou(a, b) { var x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0); return i / (a.w * a.h + b.w * b.h - i + 1e-9); }
  /** Match poses to person boxes: highest IoU, pose bbox centre must fall inside the box. Returns Map(trackId → pose index). */
  function associate(boxes, poses, W, H) {
    var pairs = [], out = new Map(), used = {};
    poses.forEach(function (lm, j) { var pb = bbox(lm, W, H); if (!pb) return; var cx = pb.x + pb.w / 2, cy = pb.y + pb.h / 2; boxes.forEach(function (b) { if (cx >= b.box.x && cx <= b.box.x + b.box.w && cy >= b.box.y && cy <= b.box.y + b.box.h) pairs.push([iou(b.box, pb), b.id, j]); }); });
    pairs.sort(function (a, b) { return b[0] - a[0]; }).forEach(function (p) { if (!out.has(p[1]) && !used[p[2]]) { out.set(p[1], p[2]); used[p[2]] = 1; } }); return out;
  }
  // ---- One Euro filter (Casiez et al. 2012): low jitter when still, low lag when moving ----
  function lpAlpha(cutoff, dt) { var tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  function OneEuro(minCutoff, beta, dCutoff) { this.minCutoff = minCutoff == null ? 0.8 : minCutoff; this.beta = beta == null ? 0.008 : beta; this.dCutoff = dCutoff || 1; this.x = null; this.dx = 0; this.t = null; }
  OneEuro.prototype.filter = function (x, tSec) {
    if (this.x == null || !isFinite(this.x)) { this.x = x; this.dx = 0; this.t = tSec; return x; }
    var dt = Math.max(1e-3, tSec - this.t); this.t = tSec; var d = (x - this.x) / dt;
    this.dx = this.dx + lpAlpha(this.dCutoff, dt) * (d - this.dx); var cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x = this.x + lpAlpha(cutoff, dt) * (x - this.x); return this.x;
  };
  // ---- pose identity tracking frame-to-frame ----
  function centroid(lm, W, H) { var sx = 0, sy = 0, n = 0; [11, 12, 23, 24, 0].forEach(function (i) { if (vis(lm[i], 0.3)) { sx += lm[i].x * W; sy += lm[i].y * H; n++; } }); if (!n) { var b = bbox(lm, W, H); return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null; } return { x: sx / n, y: sy / n }; }
  function lmDist(a, b, W, H) { var s = 0, n = 0; for (var i = 0; i < 33; i++) if (vis(a[i], 0.4) && vis(b[i], 0.4)) { s += Math.hypot((a[i].x - b[i].x) * W, (a[i].y - b[i].y) * H); n++; } return n ? s / n : Infinity; }
  /** Tracks poses across frames with stable ids. Each track: filtered landmarks (One Euro per coordinate), velocity, hands-up state. */
  function PoseTracker(o) { o = o || {}; this.maxMissMs = o.maxMissMs || 600; this.gate = o.gate || 1.6; this.tracks = []; this.nextId = 1; this.minCutoff = o.minCutoff; this.beta = o.beta; }
  PoseTracker.prototype.update = function (poses, W, H, tMs) {
    var self = this, diag = Math.hypot(W, H), dets = poses.map(function (lm) { return { lm: lm, box: bbox(lm, W, H), c: centroid(lm, W, H) }; }).filter(function (d) { return d.box && d.c; }), pairs = [];
    this.tracks.forEach(function (tr, i) { var pred = self.predict(tr, tMs); dets.forEach(function (d, j) {
      var bd = Math.hypot(tr.box.w, tr.box.h) || 1, cost = (1 - iou(tr.box, d.box)) + Math.hypot(tr.c.x - d.c.x, tr.c.y - d.c.y) / bd + Math.min(2, lmDist(pred, d.lm, W, H) / bd);
      if (cost < self.gate) pairs.push([cost, i, j]); }); });
    pairs.sort(function (a, b) { return a[0] - b[0]; }); var ut = {}, ud = {};
    pairs.forEach(function (p) { if (ut[p[1]] || ud[p[2]]) return; ut[p[1]] = ud[p[2]] = 1; self._absorb(self.tracks[p[1]], dets[p[2]], W, H, tMs); });
    dets.forEach(function (d, j) { if (ud[j]) return; var tr = { id: self.nextId++, filters: [], hits: 0, state: new PoseState(), vel: null, lm: null }; self._absorb(tr, d, W, H, tMs); self.tracks.push(tr); });
    this.tracks = this.tracks.filter(function (tr) { return tMs - tr.t <= self.maxMissMs; }); return this.tracks;
  };
  PoseTracker.prototype._absorb = function (tr, d, W, H, tMs) {
    var ts = tMs / 1000, prev = tr.lm, self = this, dt = tr.t != null ? Math.max(1e-3, (tMs - tr.t) / 1000) : null;
    tr.lm = d.lm.map(function (p, i) { var f = tr.filters[i] || (tr.filters[i] = [new OneEuro(self.minCutoff, self.beta), new OneEuro(self.minCutoff, self.beta)]); return { x: f[0].filter(p.x * W, ts) / W, y: f[1].filter(p.y * H, ts) / H, visibility: p.visibility == null ? 1 : p.visibility }; });
    tr.vel = prev && dt ? tr.lm.map(function (p, i) { return { x: (p.x - prev[i].x) / dt, y: (p.y - prev[i].y) / dt }; }) : tr.lm.map(function () { return { x: 0, y: 0 }; });
    tr.box = d.box; tr.c = d.c; tr.t = tMs; tr.hits++; tr.state.update(tr.lm, W, H, tMs, true);
  };
  /** Landmarks extrapolated to time tMs with the last velocity (max 150 ms ahead) — used to draw between pose frames. */
  PoseTracker.prototype.predict = function (tr, tMs) { var dt = Math.min(0.15, Math.max(0, (tMs - tr.t) / 1000)); if (!dt || !tr.vel) return tr.lm; return tr.lm.map(function (p, i) { return { x: p.x + tr.vel[i].x * dt, y: p.y + tr.vel[i].y * dt, visibility: p.visibility }; }); };
  var api = { OneEuro: OneEuro, PoseTracker: PoseTracker, centroid: centroid, L: L, EDGES: EDGES, CFG: CFG, vis: vis, bbox: bbox, handsVisible: handsVisible, handsText: handsText, raise: raise, shoulderDistance: shoulderDistance, PoseState: PoseState, associate: associate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.PPose = api;
})(typeof window !== 'undefined' ? window : globalThis);
