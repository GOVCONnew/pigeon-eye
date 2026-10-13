/* PIGEON EYE — MediaPipe Pose Landmarker (lite, vendored, CPU/WASM, VIDEO mode, up to 4 people). On-device only. */
(function (global) {
  'use strict';
  var lm = null, loading = null, lastTs = 0, info = { backend: null, ms: [] };
  async function load() {
    if (lm) return lm; if (loading) return loading;
    loading = (async function () {
      var base = new URL((global.SENTINEL_BASE || '') + 'vendor/mp/', location.href).href, vis = await import(base + 'vision_bundle.mjs'), fs = await vis.FilesetResolver.forVisionTasks(base + 'wasm');
      lm = await vis.PoseLandmarker.createFromOptions(fs, { baseOptions: { modelAssetPath: (global.SENTINEL_BASE || '') + 'models/pose/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 4, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      info.backend = 'mediapipe-cpu'; return lm;
    })(); try { return await loading; } catch (e) { loading = null; throw e; }
  }
  /** Returns array of landmark arrays (normalised) for the given video/image. */
  function detect(src) {
    if (!lm) return []; var t0 = performance.now(), ts = Math.max(lastTs + 1, Math.round(t0)); lastTs = ts;
    var r = lm.detectForVideo(src, ts); info.ms.push(performance.now() - t0); if (info.ms.length > 60) info.ms.shift(); return (r && r.landmarks) || [];
  }
  global.PPoseRun = { load: load, detect: detect, ready: function () { return !!lm; }, info: info };
})(window);
