/* SENTINEL Mobile — pure logic core (no DOM required): COCO class groups, motion analysis,
 * tracker, debounce, field-test metrics, CSV/JSON export. Works in browser (window.SCore) and Node (module.exports). */
(function (global) {
  'use strict';
  var GROUPS = {
    People: ['person'],
    Animals: ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'],
    Vehicles: ['bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat'],
    Other: ['traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'backpack', 'umbrella', 'handbag', 'tie',
      'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard',
      'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
      'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
      'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
      'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush']
  };
  var DEFAULT_CLASSES = GROUPS.People.concat(GROUPS.Animals, GROUPS.Vehicles, ['backpack', 'umbrella', 'handbag', 'suitcase', 'bottle', 'cell phone', 'knife']);
  function groupOf(cls) { for (var g in GROUPS) if (GROUPS[g].indexOf(cls) >= 0) return g; return 'Other'; }

  // ---------- motion ----------
  /** RGBA -> grayscale Uint8Array */
  function toGray(rgba, w, h) {
    var n = w * h, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    return g;
  }
  /** sensitivity 0..100 -> per-pixel abs diff threshold (high sensitivity = low threshold) */
  function diffThreshold(sens) { return Math.round(60 - (Math.max(0, Math.min(100, sens)) / 100) * 52); } // 60..8
  function inRoi(x, y, w, h, roi) {
    if (!roi) return true;
    if (roi.type === 'box') { var fx = x / w, fy = y / h; return fx >= roi.x && fx <= roi.x + roi.w && fy >= roi.y && fy <= roi.y + roi.h; }
    if (roi.type === 'grid') { var gx = Math.min(roi.cols - 1, Math.floor(x / w * roi.cols)), gy = Math.min(roi.rows - 1, Math.floor(y / h * roi.rows)); return !!roi.cells[gy * roi.cols + gx]; }
    return true;
  }
  /** Frame difference. Returns {pct (0..100 of ROI pixels changed), mask Uint8Array (1=changed), count, total} */
  function motion(prev, cur, w, h, sens, roi) {
    var thr = diffThreshold(sens), mask = new Uint8Array(w * h), cnt = 0, tot = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      if (!inRoi(x, y, w, h, roi)) continue;
      var i = y * w + x; tot++;
      if (Math.abs(cur[i] - prev[i]) > thr) { mask[i] = 1; cnt++; }
    }
    return { pct: tot ? 100 * cnt / tot : 0, mask: mask, count: cnt, total: tot };
  }
  /** Scene change vs reference: mean abs luminance diff as % of 255, plus % pixels changed beyond 25 */
  function sceneChange(ref, cur, roi, w, h) {
    var s = 0, n = 0, big = 0;
    for (var i = 0; i < cur.length; i++) {
      if (roi && !inRoi(i % w, (i / w) | 0, w, h, roi)) continue;
      var d = Math.abs(cur[i] - ref[i]); s += d; n++; if (d > 25) big++;
    }
    return { meanPct: n ? 100 * s / n / 255 : 0, changedPct: n ? 100 * big / n : 0 };
  }

  // ---------- debounce ----------
  function Debouncer(ms) { this.ms = ms; this.last = {}; }
  Debouncer.prototype.ok = function (key, now) { if (this.last[key] != null && now - this.last[key] < this.ms) return false; this.last[key] = now; return true; };

  // ---------- tracker (IoU + centroid, adapted from CQB Sight) ----------
  function iou(a, b) {
    var x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    var inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1), u = a.w * a.h + b.w * b.h - inter; return u > 0 ? inter / u : 0;
  }
  function Tracker(o) { o = o || {}; this.iouThresh = o.iouThresh || 0.25; this.maxAgeMs = o.maxAgeMs || 2000; this.minHits = o.minHits || 2; this.tracks = []; this.nextId = 1; }
  Tracker.prototype.reset = function () { this.tracks = []; this.nextId = 1; };
  Tracker.prototype.update = function (dets, now) {
    var self = this, live = this.tracks, pairs = [], fresh = [];
    dets.forEach(function (d, di) {
      live.forEach(function (t, ti) {
        if (t.cls !== d.cls) return;
        var ov = iou(t.box, d), dist = Math.hypot(t.box.x + t.box.w / 2 - d.x - d.w / 2, t.box.y + t.box.h / 2 - d.y - d.h / 2), diag = Math.hypot(t.box.w, t.box.h);
        var cOk = dist < diag * 0.4;
        if (ov >= self.iouThresh || cOk) pairs.push({ d: di, t: ti, s: ov + (cOk ? 0.5 * (1 - dist / (diag + 1e-6)) : 0) });
      });
    });
    pairs.sort(function (a, b) { return b.s - a.s; });
    var uD = {}, uT = {};
    pairs.forEach(function (p) {
      if (uD[p.d] || uT[p.t]) return; uD[p.d] = uT[p.t] = 1;
      var t = live[p.t], d = dets[p.d], a = 0.6;
      t.box = { x: t.box.x * (1 - a) + d.x * a, y: t.box.y * (1 - a) + d.y * a, w: t.box.w * (1 - a) + d.w * a, h: t.box.h * (1 - a) + d.h * a };
      t.score = d.score; t.maxScore = Math.max(t.maxScore, d.score); t.lastSeen = now; t.hits++; t.visible = true;
      if (!t.confirmed && t.hits >= self.minHits) { t.confirmed = true; t.id = self.nextId++; fresh.push(t); }
    });
    live.forEach(function (t, i) { if (!uT[i]) t.visible = false; });
    dets.forEach(function (d, i) {
      if (uD[i]) return;
      var t = { id: null, cls: d.cls, score: d.score, maxScore: d.score, box: { x: d.x, y: d.y, w: d.w, h: d.h }, firstSeen: now, lastSeen: now, hits: 1, confirmed: false, visible: true };
      if (self.minHits <= 1) { t.confirmed = true; t.id = self.nextId++; fresh.push(t); }
      live.push(t);
    });
    this.tracks = live.filter(function (t) { return now - t.lastSeen <= (t.confirmed ? self.maxAgeMs : 500); });
    return fresh;
  };
  Tracker.prototype.visible = function () { return this.tracks.filter(function (t) { return t.confirmed && t.visible; }); };

  // ---------- field test metrics ----------
  /** trials: [{id, start, end, truth: {label: true|false}, dets: [{label, score, t}], marks: [{kind:'fp'|'miss', label, t}]}]
   * Per trial and class: present&detected=TP, present&!detected=FN, absent(or not listed)&detected=FP.
   * Manual 'mark FP' adds an FP; manual 'mark miss' adds an FN (operator saw a miss the detector-level tally didn't catch).
   * Returns {classes: {label: {tp, fp, fn, precision, recall, f1, meanConf, meanTTFD, trials}}, overall: {...}} */
  function fieldMetrics(trials) {
    var C = {};
    function c(l) { return C[l] || (C[l] = { tp: 0, fp: 0, fn: 0, confSum: 0, confN: 0, ttfdSum: 0, ttfdN: 0, trials: 0 }); }
    trials.forEach(function (tr) {
      var seen = {};
      (tr.dets || []).forEach(function (d) {
        var s = seen[d.label] || (seen[d.label] = { first: d.t, confSum: 0, n: 0 });
        s.first = Math.min(s.first, d.t); s.confSum += d.score; s.n++;
      });
      var labels = {}; Object.keys(tr.truth || {}).forEach(function (l) { labels[l] = 1; }); Object.keys(seen).forEach(function (l) { labels[l] = 1; });
      Object.keys(labels).forEach(function (l) {
        var k = c(l), present = !!(tr.truth && tr.truth[l]), det = !!seen[l]; k.trials++;
        if (det) { k.confSum += seen[l].confSum; k.confN += seen[l].n; }
        if (present && det) { k.tp++; k.ttfdSum += (seen[l].first - tr.start); k.ttfdN++; }
        else if (present) k.fn++;
        else if (det) k.fp++;
      });
      (tr.marks || []).forEach(function (m) { var k = c(m.label); if (m.kind === 'fp') k.fp++; else if (m.kind === 'miss') k.fn++; });
    });
    var O = { tp: 0, fp: 0, fn: 0, confSum: 0, confN: 0, ttfdSum: 0, ttfdN: 0, trials: trials.length };
    function fin(k) {
      var p = k.tp + k.fp ? k.tp / (k.tp + k.fp) : null, r = k.tp + k.fn ? k.tp / (k.tp + k.fn) : null;
      return { tp: k.tp, fp: k.fp, fn: k.fn, precision: p, recall: r, f1: p != null && r != null && p + r > 0 ? 2 * p * r / (p + r) : (p === 0 || r === 0 ? 0 : null),
        meanConf: k.confN ? k.confSum / k.confN : null, meanTTFDms: k.ttfdN ? k.ttfdSum / k.ttfdN : null, trials: k.trials };
    }
    var out = {};
    Object.keys(C).sort().forEach(function (l) { var k = C[l]; out[l] = fin(k); ['tp', 'fp', 'fn', 'confSum', 'confN', 'ttfdSum', 'ttfdN'].forEach(function (f) { O[f] += k[f]; }); });
    return { classes: out, overall: fin(O) };
  }

  // ---------- export ----------
  function csvCell(v) {
    if (v == null) return '';
    var s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows, cols) {
    cols = cols || (rows[0] ? Object.keys(rows[0]) : []);
    return [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(','); })).join('\n') + '\n';
  }
  var EVENT_COLS = ['id', 'ts', 'type', 'label', 'confidence', 'detail', 'lat', 'lon', 'acc_m', 'snapshot'];
  function eventsCSV(evts) { return toCSV(evts.map(function (e) { return { id: e.id, ts: e.ts, type: e.type, label: e.label, confidence: e.conf, detail: e.detail, lat: e.geo && e.geo.lat, lon: e.geo && e.geo.lon, acc_m: e.geo && e.geo.acc, snapshot: e.snap ? 'snapshots/' + e.id + '.jpg' : '' }; }), EVENT_COLS); }
  function metricsCSV(m) {
    var rows = Object.keys(m.classes).map(function (l) { var k = m.classes[l]; return Object.assign({ label: l }, k); });
    rows.push(Object.assign({ label: 'OVERALL' }, m.overall));
    return toCSV(rows, ['label', 'trials', 'tp', 'fp', 'fn', 'precision', 'recall', 'f1', 'meanConf', 'meanTTFDms']);
  }
  function trialsCSV(trials) {
    return toCSV(trials.map(function (t) { return { trial: t.id, start: new Date(t.start).toISOString(), end: t.end ? new Date(t.end).toISOString() : '', duration_s: t.end ? (t.end - t.start) / 1000 : null,
      present: Object.keys(t.truth).filter(function (k) { return t.truth[k]; }).join('|'), absent: Object.keys(t.truth).filter(function (k) { return !t.truth[k]; }).join('|'),
      detected: Array.from(new Set(t.dets.map(function (d) { return d.label; }))).join('|'), marks: (t.marks || []).map(function (m) { return m.kind + ':' + m.label; }).join('|') }; }),
      ['trial', 'start', 'end', 'duration_s', 'present', 'absent', 'detected', 'marks']);
  }


  // ---------- v2: class-aware NMS ----------
  /** Greedy NMS per class. Returns {kept, suppressed:[{det, by, iou}]} sorted by score desc. */
  function nmsClassAware(dets, iouT, maxDets) {
    var s = dets.slice().sort(function (a, b) { return b.score - a.score; }), kept = [], sup = [];
    for (var i = 0; i < s.length; i++) {
      var d = s[i], hit = null;
      for (var j = 0; j < kept.length; j++) { if (kept[j].cls !== d.cls) continue; var v = iou(kept[j], d); if (v > iouT) { hit = { det: d, by: kept[j], iou: v }; break; } }
      if (hit) sup.push(hit); else if (kept.length < (maxDets || 100)) kept.push(d);
    }
    return { kept: kept, suppressed: sup };
  }
  // ---------- v2: low-light enhancement (auto gamma + percentile contrast stretch), in-place on RGBA ----------
  /** opts: {mode:'auto'|'always', darkMean:0.38}. Applies only when mean luminance < darkMean (auto) or always. */
  function enhanceRGBA(px, opts) {
    opts = opts || {}; var n = px.length / 4, hist = new Uint32Array(256), sum = 0;
    for (var i = 0; i < px.length; i += 16) { var y = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8; hist[y]++; sum += y; }
    var cnt = Math.ceil(n / 4), mean = sum / cnt / 255;
    if (opts.mode !== 'always' && mean >= (opts.darkMean || 0.38)) return { applied: false, mean: mean };
    var lo = 0, hi = 255, acc = 0; for (lo = 0; lo < 255 && (acc += hist[lo]) < cnt * 0.01; lo++); acc = 0; for (hi = 255; hi > 0 && (acc += hist[hi]) < cnt * 0.01; hi--);
    if (hi - lo < 16) { lo = Math.max(0, lo - 8); hi = Math.min(255, hi + 8); }
    var m2 = Math.min(0.95, Math.max(0.02, (mean * 255 - lo) / (hi - lo))), g = Math.max(0.4, Math.min(1, Math.log(0.45) / Math.log(m2)));
    var lut = new Uint8ClampedArray(256); for (var v = 0; v < 256; v++) lut[v] = 255 * Math.pow(Math.min(1, Math.max(0, (v - lo) / (hi - lo))), g);
    for (var k = 0; k < px.length; k += 4) { px[k] = lut[px[k]]; px[k + 1] = lut[px[k + 1]]; px[k + 2] = lut[px[k + 2]]; }
    return { applied: true, mean: mean, gamma: g, lo: lo, hi: hi };
  }

  var api = { nmsClassAware: nmsClassAware, enhanceRGBA: enhanceRGBA, GROUPS: GROUPS, DEFAULT_CLASSES: DEFAULT_CLASSES, groupOf: groupOf, toGray: toGray, diffThreshold: diffThreshold, inRoi: inRoi,
    motion: motion, sceneChange: sceneChange, Debouncer: Debouncer, iou: iou, Tracker: Tracker, fieldMetrics: fieldMetrics,
    csvCell: csvCell, toCSV: toCSV, eventsCSV: eventsCSV, metricsCSV: metricsCSV, trialsCSV: trialsCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.SCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
