/* PIGEON EYE (from SENTINEL v2) — multi-backend object detection with letterboxing and class-aware NMS.
 * Backends: COCO-SSD (TF.js, raw graph decoding, own NMS), EfficientDet-Lite (MediaPipe Tasks Vision),
 * YOLO (ONNX Runtime Web: WebGPU → WASM). All return RAW candidates in source-pixel coords above a low
 * score floor; per-class thresholds and temporal confirmation are applied downstream (tracker). */
(function (global) {
  'use strict';
  var COCO90 = ['', 'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', '', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', '', 'backpack', 'umbrella', '', '', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', '', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', '', 'dining table', '', '', 'toilet', '', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', '', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];
  var COCO80 = COCO90.filter(function (s) { return s; });
  var BASE = global.SENTINEL_BASE || '';
  var CDN = { tfwasm: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/',
    ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.0/dist/', mp: new URL(BASE + 'vendor/mp/', location.href).href };
  var MODELS = {
    'effdet0':  { kind: 'mp', url: BASE + 'models/effdet/efficientdet_lite0_float16.tflite', label: 'EfficientDet-Lite0 (MediaPipe, Apache-2.0)', sizes: [320], def: 320 },
    'coco-lite': { kind: 'ssd', base: 'lite_mobilenet_v2', label: 'COCO-SSD lite_mobilenet_v2 (TF.js, Apache-2.0)', sizes: [300, 320, 416], def: 320 },
  };
  var cur = null; // {id, kind, model/session, backend, inputSize}
  var lb = document.createElement('canvas'), lbx = lb.getContext('2d', { willReadFrequently: true });

  function loadScript(src) { return new Promise(function (res, rej) { if (document.querySelector('script[src="' + src + '"]')) return res(); var s = document.createElement('script'); s.src = src; s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); }; document.head.appendChild(s); }); }
  function hasWebGL() { try { var c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } }
  async function hasWebGPU() { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { return false; } }

  async function initTF(onStatus) {
    if (tf.getBackend() && tf.getBackend() !== 'cpu') return tf.getBackend();
    try { if (!hasWebGL()) throw new Error('no webgl'); if (!(await tf.setBackend('webgl'))) throw new Error('webgl'); await tf.ready(); }
    catch (e) {
      onStatus && onStatus('NO WEBGL → WASM');
      try { await loadScript(CDN.tfwasm + 'tf-backend-wasm.min.js'); tf.wasm.setWasmPaths(CDN.tfwasm); if (!(await tf.setBackend('wasm'))) throw e; await tf.ready(); }
      catch (e2) { await tf.setBackend('cpu'); await tf.ready(); }
    }
    return tf.getBackend();
  }

  /** Letterbox source into an S×S canvas (aspect preserved, grey 114 padding). Returns transform to map back. */
  function letterbox(source, sw, sh, S, enhance) {
    if (lb.width !== S) { lb.width = S; lb.height = S; }
    var k = Math.min(S / sw, S / sh), dw = Math.round(sw * k), dh = Math.round(sh * k), ox = Math.floor((S - dw) / 2), oy = Math.floor((S - dh) / 2);
    lbx.fillStyle = 'rgb(114,114,114)'; lbx.fillRect(0, 0, S, S);
    lbx.imageSmoothingEnabled = true; lbx.imageSmoothingQuality = 'high'; lbx.drawImage(source, 0, 0, sw, sh, ox, oy, dw, dh);
    var info = null;
    if (enhance) { var id = lbx.getImageData(ox, oy, dw, dh); info = SCore.enhanceRGBA(id.data, enhance); if (info.applied) lbx.putImageData(id, ox, oy); }
    return { canvas: lb, k: k, ox: ox, oy: oy, S: S, enhance: info };
  }
  function unLB(x1, y1, x2, y2, L, sw, sh) {
    var a = Math.max(0, (x1 - L.ox) / L.k), b = Math.max(0, (y1 - L.oy) / L.k), c = Math.min(sw, (x2 - L.ox) / L.k), d = Math.min(sh, (y2 - L.oy) / L.k);
    return { x: a, y: b, w: Math.max(0, c - a), h: Math.max(0, d - b) };
  }

  async function load(id, opts, onStatus) {
    opts = opts || {}; var M = MODELS[id]; if (!M) throw new Error('unknown model ' + id);
    if (cur && cur.id === id) { cur.inputSize = opts.inputSize || cur.inputSize; return cur; }
    onStatus && onStatus('LOADING ' + M.label);
    var c = { id: id, kind: M.kind, label: M.label, inputSize: opts.inputSize && M.sizes.indexOf(opts.inputSize) >= 0 ? opts.inputSize : M.def, sizes: M.sizes };
    if (M.kind === 'ssd') {
      c.backend = await initTF(onStatus);
      c.model = await tf.loadGraphModel(BASE + 'vendor/coco/model.json');
    } else if (M.kind === 'yolo') {
      if (!global.ort) await loadScript(CDN.ort + 'ort.webgpu.min.js');
      ort.env.wasm.wasmPaths = CDN.ort; ort.env.wasm.numThreads = global.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      var eps = opts.forceWasm ? ['wasm'] : ((await hasWebGPU()) ? ['webgpu', 'wasm'] : ['wasm']);
      for (var i = 0; i < eps.length; i++) {
        try { c.model = await ort.InferenceSession.create(M.url, { executionProviders: [eps[i]], graphOptimizationLevel: 'all' }); c.backend = 'ort-' + eps[i]; break; }
        catch (e) { console.warn('ORT EP ' + eps[i] + ' failed', e); if (i === eps.length - 1) throw e; }
      }
    } else if (M.kind === 'mp') {
      var vis = await import(CDN.mp + 'vision_bundle.mjs'), fs = await vis.FilesetResolver.forVisionTasks(CDN.mp + 'wasm');
      var mk = function (delegate) { return vis.ObjectDetector.createFromOptions(fs, { baseOptions: { modelAssetPath: M.url, delegate: delegate }, runningMode: 'IMAGE', scoreThreshold: 0.1, maxResults: 50 }); };
      // CPU (WASM SIMD) delegate by default: measured faster and more predictable than the WebGL delegate; GPU on request.
      try { if (!opts.gpu) throw new Error('cpu'); c.model = await mk('GPU'); c.backend = 'mediapipe-gpu'; } catch (e) { c.model = await mk('CPU'); c.backend = 'mediapipe-cpu'; }
    }
    if (cur && cur.model && cur.model !== c.model) { try { cur.model.dispose ? cur.model.dispose() : cur.model.close && cur.model.close(); } catch (e) {} }
    cur = c;
    var w = document.createElement('canvas'); w.width = w.height = 64; await detect(w, 64, 64, { floor: 0.9 }); // warm-up
    return c;
  }

  /** Returns {dets:[{cls,score,x,y,w,h}], suppressed:[...], t:{pre,infer,post}, inputSize, enhance} */
  async function detect(source, sw, sh, opts) {
    opts = opts || {}; var floor = opts.floor != null ? opts.floor : 0.2, iouT = opts.iou != null ? opts.iou : 0.5, S = opts.inputSize || cur.inputSize;
    var t0 = performance.now(), L = letterbox(source, sw, sh, S, opts.enhance), t1 = performance.now(), cands = [], t2;
    if (cur.kind === 'ssd') {
      var x = tf.tidy(function () { return tf.browser.fromPixels(L.canvas).expandDims(0); });
      var out = await cur.model.executeAsync(x); x.dispose(); t2 = performance.now();
      var sc = await out[0].data(), bx = await out[1].data(), N = out[0].shape[1], C = out[0].shape[2]; tf.dispose(out);
      for (var i = 0; i < N; i++) {
        var best = 0, bj = -1; for (var j = 0; j < C; j++) { var v = sc[i * C + j]; if (v > best) { best = v; bj = j; } }
        if (best < floor || !COCO90[bj + 1]) continue;
        var b = unLB(bx[i * 4 + 1] * S, bx[i * 4] * S, bx[i * 4 + 3] * S, bx[i * 4 + 2] * S, L, sw, sh);
        cands.push({ cls: COCO90[bj + 1], score: best, x: b.x, y: b.y, w: b.w, h: b.h });
      }
    } else if (cur.kind === 'yolo') {
      var px = lbx.getImageData(0, 0, S, S).data, n = S * S, f = new Float32Array(3 * n);
      for (var p = 0, q = 0; p < n; p++, q += 4) { f[p] = px[q] / 255; f[n + p] = px[q + 1] / 255; f[2 * n + p] = px[q + 2] / 255; }
      t1 = performance.now();
      var feeds = {}; feeds[cur.model.inputNames[0]] = new ort.Tensor('float32', f, [1, 3, S, S]);
      var res = await cur.model.run(feeds), o = res[cur.model.outputNames[0]], d = o.data, A = o.dims[2], K = o.dims[1] - 4; t2 = performance.now();
      for (var a = 0; a < A; a++) {
        var bs = 0, bc = -1; for (var k = 0; k < K; k++) { var s = d[(4 + k) * A + a]; if (s > bs) { bs = s; bc = k; } }
        if (bs < floor) continue;
        var cx = d[a], cy = d[A + a], ww = d[2 * A + a], hh = d[3 * A + a], bb = unLB(cx - ww / 2, cy - hh / 2, cx + ww / 2, cy + hh / 2, L, sw, sh);
        cands.push({ cls: COCO80[bc], score: bs, x: bb.x, y: bb.y, w: bb.w, h: bb.h });
      }
      if (o.dispose) o.dispose();
    } else {
      var r = cur.model.detect(L.canvas); t2 = performance.now();
      r.detections.forEach(function (dd) { var c = dd.categories[0], bb = dd.boundingBox; if (c.score < floor) return; var u = unLB(bb.originX, bb.originY, bb.originX + bb.width, bb.originY + bb.height, L, sw, sh); cands.push({ cls: c.categoryName, score: c.score, x: u.x, y: u.y, w: u.w, h: u.h }); });
    }
    var nms = SCore.nmsClassAware(cands.filter(function (c) { return c.w > 1 && c.h > 1; }), iouT, opts.maxDets || 50), t3 = performance.now();
    return { dets: nms.kept, suppressed: nms.suppressed, t: { pre: t1 - t0, infer: t2 - t1, post: t3 - t2 }, inputSize: S, enhance: L.enhance, nRaw: cands.length };
  }

  global.SDet2 = { MODELS: MODELS, COCO80: COCO80, load: load, detect: detect, letterbox: letterbox, hasWebGL: hasWebGL, hasWebGPU: hasWebGPU,
    current: function () { return cur; }, isReady: function () { return !!(cur && cur.model); }, setInputSize: function (s) { if (cur && cur.sizes.indexOf(s) >= 0) cur.inputSize = s; } };
})(window);
