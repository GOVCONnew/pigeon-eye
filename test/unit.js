// Unit tests: distance/bearing math, geodesy, minimap projection, off-screen indicators, PDR step detection, fusion, signaling codec.
const G = require('../js/geo.js'), assert = require('assert');
let pass = 0, fail = 0; const out = [];
function t(name, fn) { try { fn(); pass++; out.push('ok   ' + name); } catch (e) { fail++; out.push('FAIL ' + name + ': ' + e.message); } }
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, (m || '') + ' got ' + a + ' expected ' + b + '±' + tol);
// --- distance / bearing ---
t('distance: pinhole d = H·f/h', () => { const W = 720, H = 1280, fov = 73, f = G.focalPx(W, H, fov); const h = 1.75 * f / 10; near(G.estDistance({ x: 300, y: 400, w: 60, h }, W, H, fov, 1.75).m, 10, 1e-9); });
t('distance: halves when box doubles', () => { const a = G.estDistance({ x: 0, y: 100, w: 10, h: 100 }, 720, 1280, 73, 1.75).m, b = G.estDistance({ x: 0, y: 100, w: 10, h: 200 }, 720, 1280, 73, 1.75).m; near(a / b, 2, 1e-9); });
t('distance: clipped box flagged', () => { assert(G.estDistance({ x: 0, y: 0, w: 10, h: 300 }, 720, 1280, 73, 1.75).clipped); assert(!G.estDistance({ x: 0, y: 50, w: 10, h: 300 }, 720, 1280, 73, 1.75).clipped); });
t('distance: iPhone-like geometry person at 20 m ≈ 145 px of 1280', () => { const f = G.focalPx(720, 1280, 73), h = 1.75 * f / 20; near(h, 75.0, 5); });
t('bearing: centre column = heading', () => near(G.bearingOf(360, 720, 1280, 73, 123), 123, 1e-9));
t('bearing: right edge = heading + hfov/2', () => { const hf = G.hfovDeg(720, 1280, 73); near(G.bearingOf(720, 720, 1280, 73, 10), 10 + hf / 2, 1e-9); near(hf, 45.2, 0.3); });
t('bearing: wraps through north', () => near(G.bearingOf(0, 720, 1280, 73, 5), G.norm360(5 - G.hfovDeg(720, 1280, 73) / 2), 1e-9));
t('fov calibration inverts distance', () => { const fov = G.calibrateFov(180, 720, 1280, 1.75, 12); near(G.estDistance({ x: 0, y: 100, w: 1, h: 180 }, 720, 1280, fov, 1.75).m, 12, 1e-9); });
// --- geodesy ---
t('haversine 1° lat ≈ 111.2 km', () => near(G.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 50));
t('bearing east = 90', () => near(G.bearing({ lat: 40, lon: -75 }, { lat: 40, lon: -74.999 }), 90, 0.01));
t('destination ↔ haversine/bearing round trip', () => { const a = { lat: 38.9, lon: -77.03 }, b = G.destination(a, 37, 250); near(G.haversine(a, b), 250, 0.01); near(G.bearing(a, b), 37, 0.01); });
t('ENU round trip & agreement with haversine (<0.5% at 1 km)', () => { const o = { lat: 47.6, lon: -122.3 }, p = G.destination(o, 120, 1000), e = G.toENU(p, o); near(Math.hypot(e.x, e.y), 1000, 5); const q = G.fromENU(e, o); near(q.lat, p.lat, 1e-7); near(q.lon, p.lon, 1e-7); });
t('polar → ENU: 90° = +x', () => { const e = G.polarToENU(90, 10); near(e.x, 10, 1e-9); near(e.y, 0, 1e-9); });
t('enuDistBrg', () => { const r = G.enuDistBrg({ x: 0, y: 0 }, { x: -10, y: -10 }); near(r.d, 14.142, 0.001); near(r.brg, 225, 1e-9); });
// --- minimap ---
t('minimap north-up: north point is above centre', () => { const p = G.project({ x: 0, y: 10 }, { x: 0, y: 0 }, 'north', 77, 2, 100, 100); near(p.x, 100, 1e-9); near(p.y, 80, 1e-9); });
t('minimap north-up: east point right', () => { const p = G.project({ x: 5, y: 0 }, { x: 0, y: 0 }, 'north', 0, 2, 100, 100); near(p.x, 110, 1e-9); near(p.y, 100, 1e-9); });
t('minimap heading-up: target dead ahead is straight up', () => { const tgt = G.polarToENU(60, 20), p = G.project(tgt, { x: 0, y: 0 }, 'heading', 60, 1, 50, 50); near(p.x, 50, 1e-9); near(p.y, 30, 1e-9); });
t('minimap heading-up: target 90° right of heading appears right', () => { const tgt = G.polarToENU(150, 20), p = G.project(tgt, { x: 0, y: 0 }, 'heading', 60, 1, 50, 50); near(p.x, 70, 1e-9); near(p.y, 50, 1e-9); });
t('minimap: offset by own position', () => { const p = G.project({ x: 12, y: 3 }, { x: 10, y: 3 }, 'north', 0, 3, 0, 0); near(p.x, 6, 1e-9); near(p.y, 0, 1e-9); });
t('minimap NaN guard: NaN heading → treated as 0 (finite output)', () => { const p = G.project({ x: 3, y: 4 }, { x: 0, y: 0 }, 'heading', NaN, 2, 50, 50); assert(isFinite(p.x) && isFinite(p.y)); near(p.x, 56, 1e-9); near(p.y, 42, 1e-9); });
t('minimap NaN guard: undefined/null heading', () => { [undefined, null, Infinity].forEach(h => { const p = G.project({ x: 1, y: 1 }, { x: 0, y: 0 }, 'heading', h, 1, 0, 0); assert(isFinite(p.x) && isFinite(p.y)); }); });
t('minimap NaN guard: NaN point → null (skipped, not drawn)', () => { assert.strictEqual(G.project({ x: NaN, y: 1 }, { x: 0, y: 0 }, 'north', 0, 1, 0, 0), null); assert.strictEqual(G.project(null, { x: 0, y: 0 }, 'north', 0, 1, 0, 0), null); });
t('minimap NaN guard: NaN own position → centred at origin', () => { const p = G.project({ x: 2, y: 0 }, { x: NaN, y: 0 }, 'north', 0, 1, 10, 10); near(p.x, 12, 1e-9); });
t('minimap NaN guard: bad scale', () => { const p = G.project({ x: 2, y: 0 }, { x: 0, y: 0 }, 'north', 0, NaN, 0, 0); assert(isFinite(p.x)); });
// --- map tiles (Web Mercator) ---
const T = require('../js/tiles.js');
t('tiles: (0,0) at z0 is centre of world', () => { const p = T.worldPx(0, 0, 0); near(p.x, 128, 1e-9); near(p.y, 128, 1e-9); });
t('tiles: known tile — Washington Monument z15 = 9372/12536', () => { const k = T.tileOf(38.8895, -77.0353, 15); assert.deepStrictEqual([k.x, k.y], [9372, 12536]); });
t('tiles: known tile — London z10 = 511/340', () => { const k = T.tileOf(51.5074, -0.1278, 10); assert.deepStrictEqual([k.x, k.y], [511, 340]); });
t('tiles: px ↔ lat/lon round trip (z17)', () => { const p = T.worldPx(-33.8568, 151.2153, 17), q = T.pxToLatLon(p.x, p.y, 17); near(q.lat, -33.8568, 1e-9); near(q.lon, 151.2153, 1e-9); });
t('tiles: metres/px at equator z0 = 156543 m', () => near(T.metersPerPx(0, 0), 156543.03, 0.01));
t('tiles: Mercator scale agrees with ENU (100 m east ≈ 100 m of pixels at 45°N)', () => { const o = { lat: 45, lon: 7 }, b = G.destination(o, 90, 100), z = 18, a = T.worldPx(o.lat, o.lon, z), c = T.worldPx(b.lat, b.lon, z); near((c.x - a.x) * T.metersPerPx(45, z), 100, 0.2); });
t('tiles: zoomFor picks ~1 m/px → z17 at 40°N (dpr 1)', () => { const z = T.zoomFor(40, 1, 19, 1); assert(z === 17, 'z=' + z); });
t('tiles: tilesInRadius 1 km z15 is a small set (cap-friendly)', () => { const n = T.tilesInRadius(38.89, -77.03, 1000, 15).length; assert(n >= 4 && n <= 25, n); });
t('tiles: estimate 1 km @ z12–15 under the 500-tile cap', () => { const e = T.estimate(38.89, -77.03, 1000, [12, 13, 14, 15]); assert(e.tiles < 500 && e.tiles > 5, e.tiles); });
// --- rotation: tile layer canvas rotate(-heading) agrees with overlay projection (heading-up) ---
t('rotation: tile canvas transform == G.project heading-up for many bearings/headings', () => {
  for (const h of [0, 33, 90, 181, 270, 359]) for (const b of [0, 45, 100, 200, 315]) { const e = G.polarToENU(b, 50), sc = 2, cx = 100, cy = 100;
    const north = { x: e.x * sc, y: -e.y * sc }, r = -h * Math.PI / 180, cr = { x: cx + north.x * Math.cos(r) - north.y * Math.sin(r), y: cy + north.x * Math.sin(r) + north.y * Math.cos(r) }; // canvas rotate(r)
    const p = G.project(e, { x: 0, y: 0 }, 'heading', h, sc, cx, cy); near(p.x, cr.x, 1e-6, `h${h} b${b} x`); near(p.y, cr.y, 1e-6, `h${h} b${b} y`); }
});
t('rotation: target at current heading is straight up in heading-up', () => { const p = G.project(G.polarToENU(250, 10), { x: 0, y: 0 }, 'heading', 250, 1, 0, 0); near(p.x, 0, 1e-9); near(p.y, -10, 1e-9); });
// --- heading smoothing ---
t('smoothing: circular mean of 350° and 10° = 0°, not 180°', () => { const m = G.circularMean([350, 10]); assert(Math.min(m, 360 - m) < 1e-9, m); });
t('smoothing: 359 → 1 passes through 0, never via 180', () => { const s = new G.HeadingSmoother(0.25); s.update(359, 16); let worst = 0; for (let i = 0; i < 150; i++) { const v = s.update(1, 16); const d = Math.min(Math.abs(v - 0), 360 - Math.abs(v - 0)); worst = Math.max(worst, d); } assert(worst <= 1.0001, worst); near(s.value() > 180 ? s.value() - 360 : s.value(), 1, 0.01); });
t('smoothing: 10 → 350 turns left 20° (short way)', () => { const s = new G.HeadingSmoother(0.25); s.update(10, 16); const v = s.update(350, 50); assert(v < 10 || v > 350, v); });
t('smoothing: time constant — 63% of a 40° step after tau (frame-rate independent)', () => { for (const fps of [30, 60, 120]) { const s = new G.HeadingSmoother(0.5); s.update(0, 16); let v; for (let i = 0; i < fps * 0.5; i++) v = s.update(40, 1000 / fps); assert(v > 22 && v < 30, fps + 'fps ' + v); } });
t('smoothing: tau 0 = raw', () => { const s = new G.HeadingSmoother(0); s.update(10, 16); near(s.update(200, 16), 200, 1e-9); });
t('smoothing: NaN target ignored', () => { const s = new G.HeadingSmoother(0.25); s.update(90, 16); near(s.update(NaN, 16), 90, 1e-9); });
// --- off-screen ---
t('edge: in-view target → null', () => assert.strictEqual(G.edgeIndicator(100, 90, 45, 400, 800), null));
t('edge: target to the right → right edge', () => { const e = G.edgeIndicator(90, 0, 45, 400, 800, 20); near(e.x, 380, 1e-6); near(e.y, 400, 1e-6); });
t('edge: target behind → bottom edge, behind flag', () => { const e = G.edgeIndicator(180, 0, 45, 400, 800, 20); near(e.y, 780, 1e-6); assert(e.behind); });
t('edge: left-forward diagonal stays on screen', () => { const e = G.edgeIndicator(320, 0, 45, 400, 800, 20); assert(e.x >= 20 && e.x <= 380 && e.y >= 20 && e.y <= 780 && e.x < 200); });
// --- PDR step detection on synthetic accelerometer traces ---
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function trace(sec, hz, cadence, amp, noise, seed, extra) { const r = rng(seed || 7), out = []; for (let i = 0; i < sec * hz; i++) { const t = i / hz, w = amp * Math.sin(2 * Math.PI * cadence * t) + amp * 0.3 * Math.sin(4 * Math.PI * cadence * t + 0.5) + noise * (r() - 0.5) * 2 + (extra ? extra(t) : 0); out.push([t * 1000, 0.3 + 0.2 * (r() - 0.5), 9.81 * 0.95 + w * 0.9, 9.81 * 0.3 + w * 0.3]); } return out; }
function count(tr, o) { const d = new G.StepDetector(o); let n = 0; tr.forEach(s => { if (d.push(s[0], s[1], s[2], s[3])) n++; }); return n; }
t('PDR: normal walk 1.8 Hz × 30 s ≈ 54 steps (±5%)', () => { const n = count(trace(30, 60, 1.8, 2.5, 0.4, 3)); near(n, 54, 3, 'steps'); });
t('PDR: slow walk 1.2 Hz × 30 s ≈ 36 steps', () => near(count(trace(30, 60, 1.2, 1.8, 0.3, 5)), 36, 2));
t('PDR: brisk 2.4 Hz × 20 s ≈ 48 steps', () => near(count(trace(20, 100, 2.4, 3, 0.5, 9)), 48, 3));
t('PDR: standing still with sensor noise → ≤1 step', () => assert(count(trace(30, 60, 1.5, 0, 0.35, 11)) <= 1));
t('PDR: hand tremor / small 7 Hz jitter → ≤2 steps', () => assert(count(trace(30, 100, 7, 0.4, 0.2, 13)) <= 2));
t('PDR: steps at 5 Hz (too fast) are capped by min interval', () => assert(count(trace(10, 100, 5, 3, 0.2, 17)) <= 10000 / 280 + 1));
t('PDR: fuser walks a 10×10 m square back to start', () => { const f = new G.Fuser({ stepLen: 0.5 }); [0, 90, 180, 270].forEach(h => { for (let i = 0; i < 20; i++) f.step(h); }); near(f.pos.x, 0, 1e-9); near(f.pos.y, 0, 1e-9); near(f.pathLen, 40, 1e-9); assert.strictEqual(f.mode, 'PDR'); });
t('PDR: 5° compass bias over 100 m → ~8.7 m cross-track error (documents drift)', () => { const f = new G.Fuser({ stepLen: 1 }); for (let i = 0; i < 100; i++) f.step(5); near(f.pos.x, 8.72, 0.05); });
t('fusion: good GPS → GPS mode and pulls estimate', () => { const f = new G.Fuser(); f.gps({ lat: 40, lon: -75, acc: 5, t: 0 }); for (let i = 0; i < 30; i++) f.step(0); const before = f.pos.y; const p = G.destination({ lat: 40, lon: -75 }, 0, 15); f.gps({ lat: p.lat, lon: p.lon, acc: 5, t: 1000 }); assert.strictEqual(f.mode, 'GPS'); assert(Math.abs(f.pos.y - 15) < Math.abs(before - 15)); });
t('fusion: poor GPS (±60 m) ignored → PDR', () => { const f = new G.Fuser(); f.gps({ lat: 40, lon: -75, acc: 5, t: 0 }); f.step(90); f.gps({ lat: 40.001, lon: -75, acc: 60, t: 1 }); assert.strictEqual(f.mode, 'PDR'); near(f.pos.y, 0, 1e-6); });
t('fusion: stale GPS → falls back to PDR with growing accuracy', () => { const f = new G.Fuser(); f.gps({ lat: 40, lon: -75, acc: 5, t: 0 }); assert.strictEqual(f.tick(9000), 'PDR'); const a0 = f.acc; for (let i = 0; i < 50; i++) f.step(0); f.tick(9001); assert(f.acc > a0); });
t('fusion: sync resets to shared origin', () => { const f = new G.Fuser(); f.step(0); f.sync({ lat: 1, lon: 2 }); near(f.pos.x + f.pos.y, 0, 0); assert.deepStrictEqual(f.origin, { lat: 1, lon: 2 }); });
t('fmtDist', () => { assert.strictEqual(G.fmtDist(12.4), '12m'); assert.strictEqual(G.fmtDist(233), '235m'); assert.strictEqual(G.fmtDist(1530), '1.5km'); });
// --- signaling codec ---
const P = require('../js/squad.js'); globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64'); globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
const asyncTests = (async () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=extmap:1 x\r\na=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host\r\na=candidate:2 1 udp 1686052607 1.2.3.4 1 typ srflx raddr 0.0.0.0 rport 0\r\na=fingerprint:sha-256 AA:BB\r\n';
  const slim = P.slimSdp(sdp); t('codec: slimSdp drops extmap/srflx, keeps host candidate & fingerprint', () => { assert(!/extmap|srflx/.test(slim) && /typ host/.test(slim) && /fingerprint/.test(slim)); });
  const enc = await P.encode({ k: 'o', n: 'abc', s: slim }), dec = await P.decode(enc);
  t('codec: round trip', () => { assert.strictEqual(dec.s, slim); assert(enc.startsWith('PE1.')); });
  let threw = false; try { await P.decode('hello'); } catch (e) { threw = true; } t('codec: rejects foreign QR', () => assert(threw));
})();
module.exports = asyncTests.then(() => ({ pass, fail, out }));
if (require.main === module) module.exports.then(r => { console.log(r.out.join('\n')); console.log(`\n${r.pass} passed, ${r.fail} failed`); process.exit(r.fail ? 1 : 0); });
