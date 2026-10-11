/* SENTINEL v2 — YAMNet post-processing: watch categories (sets of AudioSet classes), median-3 + EMA smoothing,
 * adaptive per-category ambient baseline subtraction (learns steady wind/rain/insect confusions), noise-floor gate,
 * per-category thresholds and minimum duration. Pure JS (window.SAudioLogic / module.exports). */
(function (global) {
  'use strict';
  var CATS = {
    Gunshot:   { re: /^Gunshot, gunfire$|^Machine gun$|^Fusillade$|^Cap gun$|^Artillery fire$/, thr: 0.25, minWin: 1 },
    Chainsaw:  { re: /^Chainsaw$/, thr: 0.25, minWin: 2 },
    Vehicle:   { re: /^Car$|^Truck$|^Motorcycle$|^Motor vehicle \(road\)$|^Car passing by$|^Idling$|^Accelerating, revving, vroom$|^Engine$|^Off-road vehicle$|^All-terrain vehicle$/, thr: 0.3, minWin: 2 },
    Dog:       { re: /^Dog$|^Bark$|^Bow-wow$|^Growling$|^Howl$|^Yip$/, thr: 0.3, minWin: 1 },
    Speech:    { re: /^Speech$|^Conversation$|^Shout$|^Yell$|^Male speech, man speaking$|^Female speech, woman speaking$|^Whispering$/, thr: 0.45, minWin: 2 },
    Footsteps: { re: /^Walk, footsteps$|^Run$|^Shuffle$/, thr: 0.2, minWin: 2 },
    Bird:      { re: /^Bird$|^Bird vocalization, bird call, bird song$|^Chirp, tweet$|^Crow$|^Caw$|^Owl$|^Hoot$/, thr: 0.3, minWin: 2 },
    Scream:    { re: /^Screaming$/, thr: 0.35, minWin: 1 },
    Glass:     { re: /^Glass$|^Shatter$/, thr: 0.35, minWin: 1 }
  };
  // Broadband ambient classes that YAMNet often confuses with vehicles/speech/animals in wind & rain.
  var AMBIENT = /^Wind$|^Wind noise \(microphone\)$|^Rustling leaves$|^Rustle$|^Rain$|^Raindrop$|^Rain on surface$|^Thunderstorm$|^Thunder$|^Water$|^Stream$|^Waves, surf$|^Ocean$|^White noise$|^Pink noise$|^Static$/;
  function indexCats(classes, cats) { var m = {}; Object.keys(cats).forEach(function (k) { m[k] = []; classes.forEach(function (c, i) { if (cats[k].re.test(c)) m[k].push(i); }); }); return m; }
  function Smoother(classes, o) {
    o = o || {}; this.cfg = {}; var self = this;
    Object.keys(CATS).forEach(function (k) { self.cfg[k] = { thr: CATS[k].thr, minWin: CATS[k].minWin, on: true }; Object.assign(self.cfg[k], (o.cats || {})[k] || {}); });
    this.idx = indexCats(classes, CATS); this.amb = []; classes.forEach(function (c, i) { if (AMBIENT.test(c)) self.amb.push(i); }); this.ambBoost = o.ambBoost != null ? o.ambBoost : 0.2; this.ambOn = o.ambOn != null ? o.ambOn : 0.4; this.alphaEma = o.alphaEma || 0.5; this.alphaBase = o.alphaBase || 0.03; this.baseGain = o.baseGain != null ? o.baseGain : 1.0;
    this.gateDb = o.gateDb != null ? o.gateDb : 3; this.debounceMs = o.debounceMs || 10000; this.reset();
  }
  Smoother.prototype.reset = function () { this.hist = {}; this.ema = {}; this.base = {}; this.run = {}; this.last = {}; this.dbHist = []; this.n = 0; };
  /** scores: array-like 521 (or sparse object idx->score), db: window RMS dBFS, now ms. Returns {cats:{k:{raw,smooth,base,eff,active}}, events:[{cat, score, raw, durWin}], floorDb, gated} */
  Smoother.prototype.push = function (scores, db, now) {
    var self = this, get = function (i) { return (scores[i] || 0); }, out = { cats: {}, events: [] };
    this.dbHist.push(db); if (this.dbHist.length > 120) this.dbHist.shift();
    var sorted = this.dbHist.slice().sort(function (a, b) { return a - b; }), floor = sorted[Math.floor(sorted.length * 0.1)];
    var gated = this.dbHist.length >= 10 && db < floor + this.gateDb && db < -45; // quiet relative to running floor & absolutely quiet
    out.floorDb = floor; out.gated = gated; this.n++;
    var amb = 0; this.amb.forEach(function (i) { amb = Math.max(amb, get(i)); }); this.ambEma = this.ambEma == null ? amb : this.ambEma + 0.3 * (amb - this.ambEma);
    var boost = this.ambEma >= this.ambOn ? this.ambBoost : 0; out.ambient = this.ambEma; out.boost = boost;
    Object.keys(this.idx).forEach(function (k) {
      var raw = 0; self.idx[k].forEach(function (i) { raw = Math.max(raw, get(i)); });
      var h = self.hist[k] = (self.hist[k] || []).concat(raw).slice(-3), med = h.slice().sort(function (a, b) { return a - b; })[h.length >> 1];
      // impulsive categories (minWin 1) use the raw score max'd with the median so a single 1-window bang is not erased
      var x = self.cfg[k].minWin <= 1 ? Math.max(med, raw * 0.85) : med;
      var e = self.ema[k] = self.ema[k] == null ? x : self.ema[k] + self.alphaEma * (x - self.ema[k]);
      var b = self.base[k] || 0, eff = Math.max(0, e - self.baseGain * b), c = self.cfg[k];
      var active = c.on && !gated && eff >= Math.min(0.95, c.thr + boost);
      self.run[k] = active ? (self.run[k] || 0) + 1 : 0;
      // learn ambient level; 8x slower while the category is firing, so a sustained sound reports its onset and is absorbed after ~1-2 min
      self.base[k] = b + (active ? self.alphaBase / 8 : self.alphaBase) * (e - b);
      if (active && self.run[k] >= c.minWin && (self.last[k] == null || now - self.last[k] >= self.debounceMs)) { self.last[k] = now; out.events.push({ cat: k, score: +eff.toFixed(3), raw: +raw.toFixed(3), durWin: self.run[k] }); }
      out.cats[k] = { raw: raw, smooth: e, base: b, eff: eff, active: active };
    });
    return out;
  };
  /** v1 behaviour for benchmarking: top-3 label substring match vs watch terms, score >= thr, 10 s debounce. */
  function V1(classes, watch, thr) { this.c = classes; this.w = watch; this.thr = thr; this.last = {}; }
  V1.prototype.push = function (scores, db, now) {
    var arr = []; for (var i = 0; i < this.c.length; i++) arr.push([scores[i] || 0, i]); arr.sort(function (a, b) { return b[0] - a[0]; });
    var self = this, ev = [];
    arr.slice(0, 3).forEach(function (p) { if (p[0] < self.thr) return; self.w.forEach(function (w) { if (self.c[p[1]].toLowerCase().indexOf(w.toLowerCase()) >= 0 && (self.last[w] == null || now - self.last[w] >= 10000)) { self.last[w] = now; ev.push({ cat: w, score: p[0] }); } }); });
    return { events: ev };
  };
  var api = { CATS: CATS, Smoother: Smoother, V1: V1, indexCats: indexCats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.SAudioLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
