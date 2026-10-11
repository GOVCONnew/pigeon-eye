// Map tiles + compass tape tests (browser): satellite/OSM rendering under the minimap, heading-up rotation, offline saved-area
// tiles rendering after an offline reload, heading smoothing wraparound in the live loop, tape screenshots.
const path = require('path'), sleep = ms => new Promise(r => setTimeout(r, ms));
const LOC = { latitude: 38.8895, longitude: -77.0353, accuracy: 5 }; // National Mall, Washington DC
module.exports = async function (browser, BASE, check, newPage, OUT) {
  const ctx = await browser.createBrowserContext(); await ctx.overridePermissions(new URL(BASE).origin, ['geolocation', 'camera']);
  const p = await newPage(ctx, 'map'); await p.setGeolocation(LOC);
  const start = async () => { await p.goto(BASE, { waitUntil: 'load' }); await p.click('#btn-start'); await p.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 30000 }); await p.waitForFunction(() => __pe.fuser.mode === 'GPS', { timeout: 20000 }); };
  await start();
  // compass tape at several headings (smoothing snapped)
  for (const h of [0, 47, 90, 180, 271, 359]) { await p.evaluate(h => __pe.setHeading(h), h); await sleep(250); await p.screenshot({ path: path.join(OUT, 'shot_compass_tape_' + String(h).padStart(3, '0') + '.png'), clip: { x: 0, y: 0, width: 390, height: 110 } }); }
  // smoothing wraparound in the running rAF loop: 350 → 10 must pass through north
  const sm = await p.evaluate(async () => { __pe.S.smooth = 0.25; __pe.setHeading(350); __pe.setRawHeading(10); const seen = []; for (let i = 0; i < 40; i++) { await new Promise(r => requestAnimationFrame(r)); seen.push(__pe.heading()); } return seen; });
  check('live smoothing 350°→10° goes through 0° (no 180° spin) and settles', sm.every(v => v >= 349.9 || v <= 10.1) && Math.abs(sm[sm.length - 1] - 10) < 1.5 && sm.length > 30, sm.filter((_, i) => i % 8 === 0).map(v => Math.round(v)));
  const fps = await p.evaluate(async () => { const t0 = performance.now(); let n = 0; while (performance.now() - t0 < 1000) { await new Promise(r => requestAnimationFrame(r)); n++; } return n; });
  check('tape/heading animates every frame (rAF, independent of sensor rate)', fps >= 20, fps + ' frames/s headless');
  // satellite + OSM layers in the full map
  await p.evaluate(() => { __pe.setHeading(0); __pe.S.mapMode = 'north'; __pe.S.layer = 'sat'; }); await p.click('#minimap');
  await p.waitForFunction(() => __pe.mapInfo().tiles >= 4, { timeout: 30000 }).catch(() => {}); await sleep(1500);
  const sat = await p.evaluate(() => ({ tiles: __pe.mapInfo().tiles, z: __pe.tiles.lastZ, stats: __pe.tiles.stats }));
  check('satellite tiles (Esri) render under the full map', sat.tiles >= 4, sat);
  await p.evaluate(() => { for (let i = 0; i < 25; i++) __pe.step(); __pe.addWaypoint({ x: 40, y: 60 }, 'RALLY', '#FFB000'); __pe.markClear('Pavilion'); }); await sleep(600);
  await p.screenshot({ path: path.join(OUT, 'shot_minimap_sat.png') });
  await p.evaluate(() => { __pe.S.mapMode = 'heading'; __pe.setHeading(60); }); await sleep(800); await p.screenshot({ path: path.join(OUT, 'shot_minimap_sat_headingup060.png') });
  await p.evaluate(() => { __pe.S.mapMode = 'north'; __pe.setHeading(0); __pe.S.layer = 'map'; });
  await p.waitForFunction(n => __pe.tiles.stats.net + __pe.tiles.stats.cache >= n + 4, { timeout: 30000 }, sat.stats.net).catch(() => {}); await sleep(2000);
  const osm = await p.evaluate(() => ({ tiles: __pe.mapInfo().tiles, stats: __pe.tiles.stats }));
  check('OpenStreetMap tiles render (layer toggle)', osm.tiles >= 4, osm); await p.screenshot({ path: path.join(OUT, 'shot_minimap_map.png') });
  await p.evaluate(() => { __pe.S.layer = 'none'; }); await sleep(300); const grid = await p.evaluate(() => __pe.mapInfo().tiles); check('GRID layer draws no tiles', grid === 0, grid);
  // save area → offline reload → saved Sentinel-2 tiles render
  await p.evaluate(() => { __pe.S.layer = 'sat'; }); await p.click('#m-save'); await p.select('#sa-r', '500'); await p.click('#sa-go');
  await p.waitForFunction(() => /^saved \d+/.test(document.getElementById('sa-p').textContent), { timeout: 120000 }).catch(() => {});
  const saved = await p.$eval('#sa-p', e => e.textContent); check('SAVE AREA (0.5 km, z12–15) downloads with progress + size', /^saved (\d+)\/\1 tiles \([\d.]+ MB\)/.test(saved), saved);
  await p.evaluate(() => { document.getElementById('sa-x').click(); localStorage.setItem('pe.settings', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('pe.settings') || '{}'), { layer: 'sat', mapMode: 'north' }))); });
  await p.setOfflineMode(true); await start();
  await p.click('#minimap'); await p.waitForFunction(() => __pe.mapInfo().tiles >= 1, { timeout: 30000 }).catch(() => {}); await sleep(1500);
  const off = await p.evaluate(() => ({ tiles: __pe.mapInfo().tiles, stats: __pe.tiles.stats, online: navigator.onLine }));
  check('offline reload: map renders from saved tiles (EOX), missing tiles = grid', !off.online && off.tiles >= 1 && off.stats.cache >= 1 && off.stats.net === 0, off);
  await p.screenshot({ path: path.join(OUT, 'shot_minimap_offline.png') }); await p.setOfflineMode(false); await ctx.close();
};
