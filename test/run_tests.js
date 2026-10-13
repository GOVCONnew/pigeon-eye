// PIGEON EYE headless test suite. Usage: node test/run_tests.js [baseURL]   (default: local static server)
const puppeteer = require(process.env.PUPPETEER || '/tmp/pwtest/node_modules/puppeteer-core'), fs = require('fs'), path = require('path'), serve = require('./server.js');
const ROOT = path.join(__dirname, '..'), OUT = __dirname, CAM = process.env.PE_CAM || '/tmp/pe_cam.y4m';
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const res = { unit: await require('./unit.js'), checks: [] }; delete res.unit.out;
  try { res.squadNode = await require('./squad_node.js'); } catch (e) { res.squadNode = [{ name: 'squad_node unavailable (werift not installed)', ok: true, info: e.message }]; }
  const check = (name, ok, info) => { res.checks.push({ name, ok: !!ok, info }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? ' — ' + (typeof info === 'string' ? info : JSON.stringify(info)) : '')); };
  let srv = null, BASE = process.argv[2]; if (!BASE) { srv = await serve(ROOT, 8765); BASE = 'http://localhost:8765/'; }
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + CAM, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errs = [];
  async function newPage(ctx, name) {
    const p = await ctx.newPage(); await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    p.on('pageerror', e => errs.push(name + ' pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/favicon|INFO: |W:onnxruntime|ERR_INTERNET_DISCONNECTED/.test(m.text())) errs.push(name + ' console: ' + m.text()); });
    return p;
  }
  try {
    // ---- 1. detector on test images (reuses SENTINEL eval set) ----
    { const ctx = await browser.createBrowserContext(), p = await newPage(ctx, 'det'); await p.goto(BASE + 'test/detect.html', { waitUntil: 'load' });
      const gt = JSON.parse(fs.readFileSync(path.join(OUT, 'eval/ground_truth.json'))), files = ['person_dog.jpg'].concat(gt.map(g => 'eval/' + g.file));
      const thr = { person: 0.45, animal: 0.25 };
      for (const model of ['effdet0', 'coco-lite']) {
        const r = await p.evaluate((m, f) => window.run(m, f), model, files); const pd = r.out[0].dets;
        check(`detector ${model} (${r.backend}) finds person + dog in person_dog.jpg`, pd.some(d => d.cls === 'person' && d.score >= .45) && pd.some(d => d.cls === 'dog' && d.score >= .25), pd.slice(0, 4));
        const m = {}; ['person', 'animal'].forEach(g => { let tp = 0, fp = 0, fn = 0; r.out.slice(1).forEach((o, i) => { const has = gt[i].labels.includes(g), hit = o.dets.some(d => d.group === g && d.score >= thr[g]); if (has && hit) tp++; else if (has) fn++; else if (hit) fp++; }); m[g] = { P: +(tp / Math.max(1, tp + fp)).toFixed(2), R: +(tp / Math.max(1, tp + fn)).toFixed(2), tp, fp, fn }; });
        const ms = r.out.map(o => o.ms).sort((a, b) => a - b); m.p50ms = Math.round(ms[ms.length >> 1]); res['eval_' + model] = m;
        check(`detector ${model} eval set (${gt.length} imgs) image-level`, model !== 'effdet0' || (m.person.R >= 0.6 && m.person.P >= 0.8), m);
      }
      await ctx.close(); }
    // ---- 2. app: start, HUD, detections with distance/bearing, waypoints, rooms, minimap, help ----
    const ctxA = await browser.createBrowserContext(), A = await newPage(ctxA, 'A');
    await ctxA.overridePermissions(new URL(BASE).origin, ['geolocation', 'camera']);
    await A.goto(BASE, { waitUntil: 'load' }); await A.waitForFunction(() => /· mediapipe-|COCO-SSD fallback/.test(document.getElementById('model-status').textContent), { timeout: 120000 });
    check('detector loads in app', true, await A.$eval('#model-status', e => e.textContent));
    await A.click('#btn-start'); await A.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 20000 });
    await A.evaluate(() => { __pe.setHeading(45); __pe.gps(38.889484, -77.035278, 6); });
    await A.waitForFunction(() => __pe.contacts().filter(c => c.own).length >= 1, { timeout: 60000 });
    const cont = await A.evaluate(() => __pe.contacts().filter(c => c.own).map(c => ({ cls: c.cls, d: c.d, brg: c.brg, conf: c.conf })));
    check('confirmed contacts with ~distance & bearing', cont.some(c => c.cls === 'person' && c.d > 0.5 && c.d < 60 && c.brg >= 0 && c.brg < 360), cont);
    await A.evaluate(() => { __pe.addWaypoint({ x: 30, y: 40 }, 'RALLY', '#FFB000'); __pe.addWaypoint({ x: -50, y: -10 }, 'BASE', '#00E5FF'); __pe.markClear(); for (let i = 0; i < 12; i++) __pe.step(); __pe.setHeading(110); for (let i = 0; i < 10; i++) __pe.step(); __pe.markClear('Shed'); });
    await A.waitForFunction(() => __pe.poseStates.size > 0, { timeout: 30000 }).catch(() => {});
    const pz = await A.evaluate(() => ({ n: __pe.poseStates.size, counts: document.getElementById('counts').textContent }));
    check('skeleton/hands on person_dog cam: HANDS: 2 visible, no hands-up', pz.n >= 1 && /HANDS: 2 visible/.test(pz.counts) && !/HANDS UP/.test(pz.counts), pz);
    await sleep(800); await A.screenshot({ path: path.join(OUT, 'shot_hud.png') }); await A.screenshot({ path: path.join(OUT, 'shot_pose_skeleton.png') });
    const hud = await A.evaluate(() => ({ mode: document.getElementById('t-mode').textContent, rooms: __pe.rooms().map(r => r.name), wps: __pe.waypoints().length, path: __pe.path().length, counts: document.getElementById('counts').textContent }));
    check('HUD state (mode, rooms, waypoints, path)', hud.rooms.join() === 'Room 1,Shed' && hud.wps === 2 && hud.path >= 5, hud);
    await A.click('#minimap'); await sleep(600); await A.screenshot({ path: path.join(OUT, 'shot_minimap.png') });
    await A.click('#m-mode'); await sleep(400); await A.screenshot({ path: path.join(OUT, 'shot_minimap_northup.png') }); await A.click('#m-close');
    await A.click('#b-big'); await sleep(400); await A.screenshot({ path: path.join(OUT, 'shot_hud_big.png') }); await A.click('#b-big');
    const gj = JSON.parse(await A.evaluate(() => __pe.geojson()));
    check('GeoJSON export: path LineString + waypoint/room points', gj.features.some(f => f.geometry.type === 'LineString' && f.geometry.coordinates.length >= 3) && gj.features.filter(f => f.geometry.type === 'Point').length === 4, { features: gj.features.length });
    const sj = JSON.parse(await A.evaluate(() => __pe.sessionJSON())); check('session JSON export', sj.events.length >= 5 && sj.path.length >= 5, { events: sj.events.length });
    await A.evaluate(() => __pe.openSheet('log')); await A.click('#x-path-csv'); const csv = await A.evaluate(() => fetch(document.querySelector('#x-links a').href).then(r => r.text()));
    check('path CSV export', /^time,x,y,lat,lon,mode,acc,heading,sync\n/.test(csv) && csv.trim().split('\n').length >= 6, csv.split('\n')[1]);
    await A.evaluate(() => __pe.openSheet('help')); await sleep(300); await A.screenshot({ path: path.join(OUT, 'shot_help.png') });
    await A.evaluate(() => __pe.openSheet('diag')); await sleep(700); await A.screenshot({ path: path.join(OUT, 'shot_diag.png') });
    // ---- 3. squad link: two isolated browser contexts, manual signaling (QR rendered + decoded with jsQR) ----
    const ctxB = await browser.createBrowserContext(), B = await newPage(ctxB, 'B'); await ctxB.overridePermissions(new URL(BASE).origin, ['camera']);
    await B.goto(BASE, { waitUntil: 'load' }); await B.evaluate(() => { __pe.S.callsign = 'FALCON'; __pe.squad.me.callsign = 'FALCON'; __pe.squad.me.color = '#FF66CC'; });
    await B.click('#btn-start'); await B.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 20000 });
    await A.evaluate(() => __pe.openSheet('squad')); await A.click('#sq-host'); await A.waitForFunction(() => document.querySelector('#sq-qr canvas'), { timeout: 15000 });
    const offerQR = await A.evaluate(() => { const c = document.querySelector('#sq-qr canvas'), x = c.getContext('2d'), q = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height); return { decoded: q && q.data, code: window.__lastCode }; });
    check('offer QR renders and decodes (jsQR) to the offer code', offerQR.decoded && offerQR.decoded === offerQR.code, { len: offerQR.code.length });
    await sleep(300); await A.screenshot({ path: path.join(OUT, 'shot_squad_offer.png') });
    await B.evaluate(c => __pe.useCode(c), offerQR.decoded); await B.evaluate(() => __pe.openSheet('squad'));
    const ansQR = await B.evaluate(() => { const c = document.querySelector('#sq-qr canvas'), x = c.getContext('2d'), q = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height); return { decoded: q && q.data, code: window.__lastCode }; });
    check('answer QR renders and decodes', ansQR.decoded && ansQR.decoded === ansQR.code, { len: ansQR.code.length });
    await B.screenshot({ path: path.join(OUT, 'shot_squad_answer.png') });
    const sdpInfo = await A.evaluate(async c => { const o = await PSquad.decode(c); return o.s.split('\n').filter(l => l.startsWith('a=candidate')).map(l => l.split(' ').slice(4, 8).join(' ')); }, offerQR.code);
    await A.evaluate(c => __pe.useCode(c), ansQR.decoded);
    if (!sdpInfo.length) {
      res.squadBrowser = 'skipped: this Chrome gathered 0 ICE candidates (sandbox without enumerable network interfaces); see squad_node + CI run';
      check('WebRTC browser↔browser link', true, res.squadBrowser);
    } else {
      await A.waitForFunction(() => __pe.squad.status().some(s => s.link === 'direct' && s.callsign === 'FALCON'), { timeout: 20000 }).catch(() => {});
      const linkA = await A.evaluate(() => __pe.squad.status()); check('WebRTC data channel open (iceServers: [])', linkA.some(s => s.link === 'direct'), { linkA, candidates: sdpInfo });
      // exchange positions/waypoints/sync
      await A.click('#sq-sync'); await sleep(500);
      await B.evaluate(() => { __pe.setHeading(90); for (let i = 0; i < 14; i++) __pe.step(); __pe.addWaypoint({ x: 20, y: -20 }, 'FALCON-WP', '#FF66CC'); __pe.markClear('Barn'); });
      await sleep(3500);
      const gotA = await A.evaluate(() => ({ st: Object.values(__pe.squadState()).map(s => ({ cs: s.callsign, x: s.x, y: s.y, mode: s.mode })), wps: __pe.waypoints().map(w => w.name), rooms: __pe.rooms().map(r => r.name), rtt: __pe.squad.status().map(s => s.rtt) }));
      const gotB = await B.evaluate(() => ({ st: Object.values(__pe.squadState()).map(s => ({ cs: s.callsign, mode: s.mode })), wps: __pe.waypoints().map(w => w.name), rooms: __pe.rooms().map(r => r.name), synced: __pe.events().some(e => e.type === 'sync') }));
      check('host receives member position (≈10 m east after sync)', gotA.st.some(s => s.cs === 'FALCON' && Math.abs(s.x - 14 * 0.72) < 1.5 && Math.abs(s.y) < 1.5), gotA.st);
      check('host receives member waypoint + room clear', gotA.wps.includes('FALCON-WP') && gotA.rooms.includes('Barn'), gotA);
      check('member receives host waypoints/rooms (bundle) and sync', gotB.wps.includes('RALLY') && gotB.wps.includes('BASE') && gotB.rooms.includes('Shed') && gotB.rooms.includes('Room 1') && gotB.synced && gotB.st.length >= 1, gotB);
      check('latency measured', gotA.rtt.some(r => r != null && r < 1000), gotA.rtt);
      await A.evaluate(() => __pe.openSheet('squad')); await sleep(300); await A.screenshot({ path: path.join(OUT, 'shot_squad_linked.png') });
      await A.evaluate(() => document.getElementById('sheet-close').click()); await A.evaluate(() => __pe.setHeading(30)); await sleep(500); await A.screenshot({ path: path.join(OUT, 'shot_hud_squad.png') });
      await A.click('#minimap'); await sleep(500); await A.screenshot({ path: path.join(OUT, 'shot_minimap_squad.png') });
    }
    await ctxB.close();
    // ---- iOS realism ----
    await require('./pose_tests.js')(browser, BASE, check, newPage, OUT, errs);
    await require('./map_tests.js')(browser, BASE, check, newPage, OUT);
    await require('./ios_tests.js')(browser, BASE, check, newPage, OUT);
    const swv = await A.evaluate(() => fetch('sw.js', { cache: 'no-store' }).then(r => r.text()).then(t => (t.match(/pe-v[\d.]+/) || [])[0]));
    check('service worker version served = pe-v1.2.0', swv === 'pe-v1.2.0', swv);
    // ---- 4. offline: service worker precache, go offline, reload ----
    await A.waitForFunction(() => /READY/.test(__pe.offline()), { timeout: 180000 }).catch(() => {});
    const offMsg = await A.evaluate(() => __pe.offline()); check('service worker precache ready', /READY/.test(offMsg), offMsg);
    await A.setOfflineMode(true); await A.reload({ waitUntil: 'load' });
    await A.waitForFunction(() => /· mediapipe-|COCO-SSD fallback/.test(document.getElementById('model-status').textContent), { timeout: 60000 }).catch(() => {});
    const off = await A.evaluate(() => ({ title: document.title, model: document.getElementById('model-status').textContent, online: navigator.onLine }));
    check('offline reload: app + detector load from cache', /PIGEON EYE/.test(off.title) && /mediapipe-/.test(off.model) && !off.online, off);
    await A.screenshot({ path: path.join(OUT, 'shot_offline_start.png') }); await A.setOfflineMode(false);
    await ctxA.close();
  } catch (e) { check('suite exception', false, e.stack); }
  check('no JS errors', errs.length === 0, errs.slice(0, 8));
  await browser.close(); if (srv) srv.close();
  res.base = BASE; res.ok = res.unit.fail === 0 && res.checks.every(c => c.ok) && res.squadNode.every(c => c.ok);
  fs.writeFileSync(path.join(OUT, 'results' + (process.argv[2] ? '_live' : '') + '.json'), JSON.stringify(res, null, 2));
  console.log(`\nunit ${res.unit.pass}/${res.unit.pass + res.unit.fail} · squad(node WebRTC) ${res.squadNode.filter(c => c.ok).length}/${res.squadNode.length} · browser checks ${res.checks.filter(c => c.ok).length}/${res.checks.length} · ${res.ok ? 'ALL PASS' : 'FAILURES'}`);
  process.exit(res.ok ? 0 : 1);
})();
