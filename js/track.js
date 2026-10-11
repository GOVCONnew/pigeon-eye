/* SENTINEL v2 — temporal confirmation: ByteTrack-style two-stage association with alpha-beta (constant-velocity)
 * motion prediction, per-category thresholds and N-of-M persistence, zones (ROI / exclusion polygons) and
 * per-detection rejection reasons. Pure JS (browser: window.STrack, Node: module.exports). */
(function (global) {
  'use strict';
  var GROUP = {};
  ['person'].forEach(function (c) { GROUP[c] = 'person'; });
  ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'].forEach(function (c) { GROUP[c] = 'animal'; });
  ['bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat'].forEach(function (c) { GROUP[c] = 'vehicle'; });
  function groupOf(cls) { return GROUP[cls] || 'other'; }
  // Defaults tuned on bench/eval (see docs/V2_RESULTS.md); user-editable in Settings.
  var DEFAULT_CAT = {
    person:  { thr: 0.45, n: 3, m: 5 },
    animal:  { thr: 0.25, n: 3, m: 6 },
    vehicle: { thr: 0.45, n: 3, m: 5 },
    other:   { thr: 0.55, n: 4, m: 6 }
  };
  function iou(a, b) { var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h), i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), u = a.w * a.h + b.w * b.h - i; return u > 0 ? i / u : 0; }
  function pointInPoly(x, y, pts) { var inside = false; for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) { var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi)) inside = !inside; } return inside; }
  /** Zone check for a normalized point. zones: [{type:'roi'|'exclude', pts:[[x,y],..]}]. Returns null (ok) or reason. */
  function zoneReason(nx, ny, zones) {
    if (!zones || !zones.length) return null;
    for (var i = 0; i < zones.length; i++) if (zones[i].type === 'exclude' && pointInPoly(nx, ny, zones[i].pts)) return 'in_exclusion_zone';
    var rois = zones.filter(function (z) { return z.type === 'roi'; });
    if (rois.length && !rois.some(function (z) { return pointInPoly(nx, ny, z.pts); })) return 'outside_roi';
    return null;
  }
  /** Anchor point of a box used for zone tests: bottom-centre ("foot point") — where an object stands. */
  function anchor(b, W, H) { return [(b.x + b.w / 2) / W, Math.min(1, (b.y + b.h) / H)]; }

  function Tracker(o) {
    o = o || {}; this.cat = JSON.parse(JSON.stringify(o.cat || DEFAULT_CAT)); this.lowFrac = o.lowFrac || 0.5; this.iouHigh = o.iouHigh || 0.3; this.iouLow = o.iouLow || 0.2;
    this.maxLostMs = o.maxLostMs || 3000; this.allowedClasses = o.allowedClasses || null; this.zones = o.zones || []; this.reset();
  }
  Tracker.prototype.reset = function () { this.tracks = []; this.nextId = 1; this.frame = 0; };
  Tracker.prototype._predict = function (t, now) {
    var dt = Math.min(1000, now - t.lastT) / 1000; return { x: t.box.x + t.v.x * dt, y: t.box.y + t.v.y * dt, w: t.box.w, h: t.box.h };
  };
  /** dets: RAW detections in source px [{cls,score,x,y,w,h}], W,H frame size, now ms.
   * Returns {tracks, confirmed:[new confirmed], events:[confirmed tracks that are zone-valid & newly eligible], diag:[{det, reason, trackId}]} */
  Tracker.prototype.update = function (dets, W, H, now) {
    var self = this, diag = [], fresh = [], events = []; this.frame++;
    var high = [], low = [];
    dets.forEach(function (d) {
      var g = groupOf(d.cls), c = self.cat[g], rec = { det: d, group: g, reason: null, trackId: null };
      diag.push(rec);
      if (self.allowedClasses && !self.allowedClasses.has(d.cls)) { rec.reason = 'class_filtered'; return; }
      if (d.score >= c.thr) high.push(rec); else if (d.score >= c.thr * self.lowFrac) low.push(rec); else rec.reason = 'below_class_threshold';
    });
    var live = this.tracks.filter(function (t) { return t.state !== 'removed'; });
    live.forEach(function (t) { t.pred = self._predict(t, now); t.matched = false; });
    function associate(recs, minIou, isLow) {
      var pairs = [];
      recs.forEach(function (r, i) { live.forEach(function (t, j) { if (t.matched || t.group !== r.group) return; var v = iou(t.pred, r.det); if (v >= minIou) pairs.push([v + (t.label === r.det.cls ? 0.05 : 0), i, j]); }); });
      pairs.sort(function (a, b) { return b[0] - a[0]; }); var used = {};
      pairs.forEach(function (p) { var r = recs[p[1]], t = live[p[2]]; if (used[p[1]] || t.matched) return; used[p[1]] = 1; t.matched = true; self._hit(t, r, now, isLow); });
      return recs.filter(function (r, i) { return !used[i]; });
    }
    var unHigh = associate(high, this.iouHigh, false);
    var unLow = associate(low, this.iouLow, true);
    unLow.forEach(function (r) { r.reason = 'below_class_threshold'; });
    unHigh.forEach(function (r) {
      var t = { id: null, tmpId: 'T' + self.frame + '_' + Math.random().toString(36).slice(2, 6), group: r.group, label: r.det.cls, votes: {}, box: { x: r.det.x, y: r.det.y, w: r.det.w, h: r.det.h }, v: { x: 0, y: 0 },
        firstT: now, lastT: now, lastHitT: now, hist: [], hits: 0, score: r.det.score, maxScore: r.det.score, scoreSum: 0, n: 0, state: 'tentative', confirmedT: null, best: null, matched: true, evented: false, zone: null };
      live.push(t); self._hit(t, r, now, false, true);
    });
    live.forEach(function (t) {
      if (!t.matched) { t.hist.push(0); t.visible = false; if (t.state === 'confirmed' && now - t.lastHitT > 400) t.state = 'lost'; }
      var c = self.cat[t.group]; if (t.hist.length > c.m) t.hist.splice(0, t.hist.length - c.m);
      var nh = t.hist.reduce(function (a, b) { return a + b; }, 0);
      if (t.state === 'tentative' && nh >= c.n) {
        t.state = 'confirmed'; t.id = self.nextId++; t.confirmedT = now; fresh.push(t);
      }
      if (t.state === 'tentative' && t.hist.length >= c.m && nh < c.n && now - t.lastHitT > 1000) t.state = 'removed';
      if ((t.state === 'lost' || t.state === 'tentative') && now - t.lastHitT > (t.state === 'lost' ? self.maxLostMs : 1200)) t.state = 'removed';
      if (t.state === 'lost' && t.matched) t.state = 'confirmed';
      var a = anchor(t.box, W, H); t.zone = zoneReason(a[0], a[1], self.zones);
      if (t.state === 'confirmed' && !t.evented && !t.zone) { t.evented = true; events.push(t); }
      if (t.lastRec) { if (t.state === 'tentative') t.lastRec.reason = t.lastRec.reason || 'pending_persistence'; else if (t.zone) t.lastRec.reason = t.zone; t.lastRec.trackId = t.id || t.tmpId; t.lastRec.trackState = t.state; t.lastRec = null; }
    });
    this.tracks = live.filter(function (t) { return t.state !== 'removed'; });
    return { tracks: this.tracks, confirmed: fresh, events: events, diag: diag };
  };
  Tracker.prototype._hit = function (t, r, now, isLow, isNew) {
    var d = r.det, dt = Math.max(1, now - t.lastT) / 1000, a = 0.55, b = 0.25;
    if (!isNew) {
      var p = t.pred || t.box, rx = d.x - p.x, ry = d.y - p.y;
      t.box = { x: p.x + a * rx, y: p.y + a * ry, w: t.box.w + a * (d.w - t.box.w), h: t.box.h + a * (d.h - t.box.h) };
      t.v = { x: t.v.x + b * rx / dt, y: t.v.y + b * ry / dt };
    }
    t.lastT = now; t.lastHitT = now; t.visible = true; t.score = d.score; t.maxScore = Math.max(t.maxScore, d.score); t.scoreSum += d.score; t.n++;
    t.votes[d.cls] = (t.votes[d.cls] || 0) + d.score; var bv = -1; for (var k in t.votes) if (t.votes[k] > bv) { bv = t.votes[k]; t.label = k; }
    t.hist.push(isLow ? 0 : 1); // low-score matches keep the track alive but do not count towards confirmation
    var q = d.score * Math.sqrt(d.w * d.h); if (!t.best || q > t.best.q) t.best = { q: q, score: d.score, box: { x: d.x, y: d.y, w: d.w, h: d.h }, t: now, fresh: true };
    r.trackId = t.id || t.tmpId; t.lastRec = r; if (isLow) r.reason = null;
  };
  Tracker.prototype.confirmedVisible = function () { return this.tracks.filter(function (t) { return (t.state === 'confirmed') && t.visible; }); };
  var api = { Tracker: Tracker, DEFAULT_CAT: DEFAULT_CAT, groupOf: groupOf, pointInPoly: pointInPoly, zoneReason: zoneReason, anchor: anchor, iou: iou };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.STrack = api;
})(typeof window !== 'undefined' ? window : globalThis);
