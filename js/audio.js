/* SENTINEL — YAMNet environmental sound classification (vendored TF.js graph model) + mic capture with 16 kHz mono resampling. */
(function (global) {
  'use strict';
  var BASE = (global.SENTINEL_BASE || '') + 'models/yamnet/';
  var model = null, classes = null, WIN = 15600; // 0.975 s @ 16 kHz
  function parseCSV(txt) {
    return txt.trim().split(/\r?\n/).slice(1).map(function (line) { var a = line.indexOf(','), b = line.indexOf(',', a + 1); return line.slice(b + 1).trim().replace(/^"|"$/g, ''); });
  }
  async function load(onStatus) {
    if (model) return model;
    onStatus && onStatus('LOADING YAMNET');
    var r = await fetch(BASE + 'yamnet_class_map.csv'); if (!r.ok) throw new Error('class map HTTP ' + r.status);
    classes = parseCSV(await r.text());
    model = await tf.loadGraphModel(BASE + 'model.json');
    var z = tf.zeros([WIN]); var o = model.predict(z); (Array.isArray(o) ? o : [o]).forEach(function (t) { t.dispose(); }); z.dispose();
    return model;
  }
  /** Classify Float32Array of 16 kHz mono samples (any length >= WIN). Returns {top:[{label,score,index}], scores Float32Array, ms} */
  async function classify(wave, k) {
    var t0 = performance.now(), x = tf.tensor1d(wave), outs = model.predict(x);
    outs = Array.isArray(outs) ? outs : [outs];
    var mean = tf.tidy(function () { return outs[0].mean(0); });
    var scores = await mean.data();
    x.dispose(); mean.dispose(); outs.forEach(function (t) { t.dispose(); });
    var idx = Array.from(scores.keys()).sort(function (a, b) { return scores[b] - scores[a]; }).slice(0, k || 3);
    return { top: idx.map(function (i) { return { index: i, label: classes[i], score: scores[i] }; }), scores: scores, ms: performance.now() - t0 };
  }
  /** Simple anti-aliased resampler (box-average when downsampling, linear interp otherwise). */
  function resample(input, fromRate, toRate) {
    if (fromRate === toRate) return Float32Array.from(input);
    var ratio = fromRate / toRate, n = Math.floor(input.length / ratio), out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var s = i * ratio, e = s + ratio;
      if (ratio > 1) { var a = Math.floor(s), b = Math.min(input.length, Math.ceil(e)), sum = 0; for (var j = a; j < b; j++) sum += input[j]; out[i] = sum / Math.max(1, b - a); }
      else { var i0 = Math.floor(s), f = s - i0; out[i] = input[i0] * (1 - f) + (input[Math.min(i0 + 1, input.length - 1)] || 0) * f; }
    }
    return out;
  }
  /** Mic capture → rolling 16 kHz buffer. */
  function Mic() { this.buf = new Float32Array(WIN); this.filled = 0; this.level = 0; this.ctx = null; this.stream = null; this.mode = null; }
  Mic.prototype._push = function (chunk, rate) {
    var s = resample(chunk, rate, 16000), sum = 0;
    for (var i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    this.level = Math.sqrt(sum / Math.max(1, chunk.length));
    if (s.length >= WIN) { this.buf.set(s.subarray(s.length - WIN)); }
    else { this.buf.copyWithin(0, s.length); this.buf.set(s, WIN - s.length); }
    this.filled = Math.min(WIN, this.filled + s.length);
  };
  Mic.prototype.start = async function (stream) {
    var self = this, AC = global.AudioContext || global.webkitAudioContext; if (!AC) throw new Error('No WebAudio');
    this.stream = stream; this.ctx = new AC(); if (this.ctx.state === 'suspended') await this.ctx.resume();
    var src = this.ctx.createMediaStreamSource(stream), rate = this.ctx.sampleRate;
    try {
      var code = "class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('sentinel-tap',P);";
      var url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      var node = new AudioWorkletNode(this.ctx, 'sentinel-tap'), acc = [], accN = 0;
      node.port.onmessage = function (e) { acc.push(e.data); accN += e.data.length; if (accN >= 2048) { var m = new Float32Array(accN), o = 0; acc.forEach(function (a) { m.set(a, o); o += a.length; }); acc = []; accN = 0; self._push(m, rate); } };
      src.connect(node); var g = this.ctx.createGain(); g.gain.value = 0; node.connect(g); g.connect(this.ctx.destination); this.mode = 'AudioWorklet';
    } catch (e) {
      console.warn('AudioWorklet unavailable → ScriptProcessor', e);
      var sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = function (ev) { self._push(ev.inputBuffer.getChannelData(0), rate); };
      src.connect(sp); var g2 = this.ctx.createGain(); g2.gain.value = 0; sp.connect(g2); g2.connect(this.ctx.destination); this.mode = 'ScriptProcessor';
    }
    this.rate = rate;
  };
  Mic.prototype.ready = function () { return this.filled >= WIN; };
  Mic.prototype.stop = function () { try { this.ctx && this.ctx.close(); } catch (e) {} this.ctx = null; this.filled = 0; };
  global.SAudio = { load: load, classify: classify, resample: resample, Mic: Mic, WIN: WIN, getClasses: function () { return classes; }, isReady: function () { return !!model; } };
})(window);
