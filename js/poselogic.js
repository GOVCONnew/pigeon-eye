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
  PoseState.prototype.update = function (raw, W, H, now) {
    var a = CFG.alpha;
    if (!this.lm || now - this.lastT > 1000) this.lm = raw.map(function (p) { return { x: p.x, y: p.y, visibility: p.visibility == null ? 1 : p.visibility }; });
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
  var api = { L: L, EDGES: EDGES, CFG: CFG, vis: vis, bbox: bbox, handsVisible: handsVisible, handsText: handsText, raise: raise, shoulderDistance: shoulderDistance, PoseState: PoseState, associate: associate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.PPose = api;
})(typeof window !== 'undefined' ? window : globalThis);
