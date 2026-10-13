/* PIGEON EYE feature: pose — skeleton overlay, hands visible, hands-up, shoulder-width distance support.
 * Runs MediaPipe Pose Landmarker on every presented video frame (requestVideoFrameCallback, rAF fallback) while a
 * person is in view, adaptively backing off when inference is slow. Poses are tracked frame-to-frame (PoseTracker:
 * IoU + centroid + landmark distance), filtered with One Euro filters, and extrapolated with their velocity to the
 * moment of drawing so the skeleton stays on the person between pose frames. */
PE.register('pose', function (ctx) {
  'use strict';
  var S = ctx.S, video = ctx.video, tracker = new PPose.PoseTracker(), stats = { runs: 0, people: 0, skipped: 0, ms: 0, every: 1, mode: '-', tracks: 0 };
  var frameNo = 0, lastPeople = 0, loading = null, W = 0, H = 0, prevTags = {};
  function load() { if (!S.pose) return Promise.resolve(); if (loading) return loading; loading = ctx.loadScript('js/pose.js').then(function () { return PPoseRun.load(); }).then(function () { ctx.toast('Pose (skeleton/hands) ready'); PE.bus.emit('pose:ready'); }).catch(function (e) { loading = null; ctx.toast('Pose unavailable: ' + e.message); }); return loading; }
  PE.bus.on('detector:ready', load); PE.bus.on('settings:change', function (k) { if (k === 'pose' && S.pose) load(); });
  PE.bus.on('detect:update', function (d) { lastPeople = d.tracks.filter(function (t) { return t.group === 'person'; }).length; });
  /** Adaptive rate: run every frame while cheap; every 2nd/3rd frame when inference p≈ms is high or the HUD frame rate drops. */
  function stride() { var ms = stats.ms, fps = ctx.fps(); var e = ms < 28 && fps >= 24 ? 1 : ms < 50 && fps >= 15 ? 2 : 3; if (S.low) e = Math.max(e, 3); stats.every = e; return e; }
  function step(now) {
    if (!S.pose || !window.PPoseRun || !PPoseRun.ready() || !ctx.running() || !video.videoWidth) return;
    if (!lastPeople && !tracker.tracks.length) return;
    if (frameNo++ % stride()) { stats.skipped++; return; }
    W = video.videoWidth; H = video.videoHeight; var t0 = performance.now(), poses = PPoseRun.detect(video), dt = performance.now() - t0;
    stats.ms = stats.ms ? stats.ms + 0.2 * (dt - stats.ms) : dt; stats.runs++; stats.people = poses.length;
    tracker.update(poses, W, H, performance.now()); stats.tracks = tracker.tracks.length;
    tracker.tracks.forEach(function (tr) { var tag = tr.state.tag; if (tag && tag !== prevTags[tr.id]) ctx.logEv('pose', 'person ' + (matchDet(tr) || '?') + ' ' + tag); prevTags[tr.id] = tag; });
  }
  if (video.requestVideoFrameCallback) { stats.mode = 'video-frame'; var vf = function (now) { step(now); video.requestVideoFrameCallback(vf); }; video.requestVideoFrameCallback(vf); }
  else { stats.mode = 'animation-frame'; var af = function (now) { step(now); requestAnimationFrame(af); }; requestAnimationFrame(af); }
  function matchDet(tr) { var best = null, bi = 0; ctx.tracker.confirmedVisible().forEach(function (t) { if (t.group !== 'person') return; var b = t.box; if (tr.c.x < b.x || tr.c.x > b.x + b.w || tr.c.y < b.y || tr.c.y > b.y + b.h) return; var v = PPose.iou ? 0 : 0, ix = Math.max(0, Math.min(b.x + b.w, tr.box.x + tr.box.w) - Math.max(b.x, tr.box.x)) * Math.max(0, Math.min(b.y + b.h, tr.box.y + tr.box.h) - Math.max(b.y, tr.box.y)); v = ix / (b.w * b.h + tr.box.w * tr.box.h - ix + 1e-9); if (v > bi) { bi = v; best = t.id; } }); return best; }
  /** Pose view for a detector track id: predicted landmarks for "now", hands/hands-up state. null if none recent. */
  function forTrack(detId) {
    if (!S.pose) return null; var now = performance.now(), hit = null;
    tracker.tracks.forEach(function (tr) { if (!hit && now - tr.t < 600 && tr.hits >= 2 && matchDet(tr) === detId) hit = tr; });
    if (!hit) return null; var st = hit.state;
    return { id: hit.id, lm: tracker.predict(hit, now), filtered: hit.lm, tag: st.tag, hands: st.hands, handsUp: st.handsUp, arm: st.arm, seen: hit.t };
  }
  function draw(hx, T, ps, col) {
    var lm = ps.lm, W0 = video.videoWidth, H0 = video.videoHeight, P = function (i) { return { x: lm[i].x * W0 * T.s + T.ox, y: lm[i].y * H0 * T.s + T.oy }; };
    hx.strokeStyle = col; hx.lineWidth = 2; hx.lineCap = 'round'; hx.beginPath();
    PPose.EDGES.forEach(function (e) { if (!PPose.vis(lm[e[0]], 0.65) || !PPose.vis(lm[e[1]], 0.65)) return; var a = P(e[0]), b = P(e[1]); hx.moveTo(a.x, a.y); hx.lineTo(b.x, b.y); }); hx.stroke();
    hx.fillStyle = col; for (var i = 0; i < 33; i++) { if (i > 0 && i < 11) continue; if (!PPose.vis(lm[i], 0.65)) continue; var q = P(i); hx.beginPath(); hx.arc(q.x, q.y, i === 15 || i === 16 ? 4 : 2.5, 0, 7); hx.fill(); }
    if (PPose.vis(lm[0])) { var n = P(0), sw = PPose.vis(lm[11]) && PPose.vis(lm[12]) ? Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y) : 30; hx.beginPath(); hx.arc(n.x, n.y, Math.max(6, sw * 0.28), 0, 7); hx.stroke(); }
  }
  /** Map(poseTrackId → state) — diagnostics/tests. */
  function states() { var m = new Map(); tracker.tracks.forEach(function (tr) { m.set(tr.id, tr.state); }); return m; }
  return { load: load, forTrack: forTrack, draw: draw, states: states, stats: stats, tracker: tracker };
});
