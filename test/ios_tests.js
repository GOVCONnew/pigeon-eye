// iOS-realism browser tests: mocked iOS permission APIs that REJECT when called outside the synchronous part of a tap
// handler (window.event is the click only before the first await, like iOS's transient activation), webkitCompassHeading
// events, geolocation display with poor accuracy / denied, minimap drawing with no GPS / no heading, SW version.
const path = require('path'), sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK = (mode) => {
  window.__permCalls = []; let ori = mode.ori || 'granted';
  const gate = (name, result) => () => { const ev = window.event, ok = !!ev && /click|touchend|pointerup/.test(ev.type); window.__permCalls.push({ name, inGesture: ok }); return ok ? Promise.resolve(typeof result === 'function' ? result() : result) : Promise.reject(new DOMException('Requires user gesture', 'NotAllowedError')); };
  function DOE() {} DOE.requestPermission = gate('orientation', () => { const r = ori; if (mode.oriThenGrant) ori = 'granted'; return r; });
  function DME() {} DME.requestPermission = gate('motion', 'granted');
  Object.defineProperty(window, 'DeviceOrientationEvent', { value: DOE, configurable: true }); Object.defineProperty(window, 'DeviceMotionEvent', { value: DME, configurable: true });
  if (mode.geoGesture) { const g = navigator.geolocation, gcp = g.getCurrentPosition.bind(g); g.getCurrentPosition = function (a, b, c) { window.__permCalls.push({ name: 'geo.getCurrentPosition', inGesture: !!window.event && window.event.type === 'click' }); return gcp(a, b, c); }; }
  window.__fireOri = (o) => { const e = new Event('deviceorientation'); for (const k in o) Object.defineProperty(e, k, { value: o[k] }); window.dispatchEvent(e); };
};
module.exports = async function (browser, BASE, check, newPage, OUT) {
  // (a) the mock itself rejects after an await (negative control)
  { const ctx = await browser.createBrowserContext(), p = await newPage(ctx, 'iosA'); await p.evaluateOnNewDocument(MOCK, {}); await p.goto(BASE + 'test/detect.html');
    const r = await p.evaluate(() => new Promise(res => { const b = document.createElement('button'); b.textContent = 'x'; document.body.append(b); b.onclick = async () => { const s = await DeviceOrientationEvent.requestPermission().catch(e => e.name); await new Promise(r => setTimeout(r, 0)); const t = await DeviceOrientationEvent.requestPermission().catch(e => e.name); res({ sync: s, afterAwait: t }); }; window.__btn = b; }).then(x => x) && 0);
    await p.click('button'); await sleep(200); const calls = await p.evaluate(() => window.__permCalls);
    check('iOS mock: requestPermission succeeds in tap, rejects after an await on async work like getUserMedia (control)', calls.length === 2 && calls[0].inGesture && !calls[1].inGesture, calls); await ctx.close(); }
  // (b) START ordering: orientation + motion + getCurrentPosition all inside the gesture; compass heading from webkitCompassHeading
  { const ctx = await browser.createBrowserContext(); await ctx.overridePermissions(new URL(BASE).origin, ['geolocation', 'camera']); const p = await newPage(ctx, 'iosB');
    await p.evaluateOnNewDocument(MOCK, { geoGesture: true }); await p.setGeolocation({ latitude: 40.7128, longitude: -74.006, accuracy: 85 });
    await p.goto(BASE, { waitUntil: 'load' }); const ver = await p.$eval('#ver', e => e.textContent); check('start screen shows version', ver === 'v1.1.0', ver);
    await p.click('#btn-start'); await p.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 20000 });
    const calls = await p.evaluate(() => window.__permCalls), sens = await p.evaluate(() => ({ ori: __pe.sens.ori.perm, mot: __pe.sens.mot.perm }));
    check('START calls orientation, motion and getCurrentPosition synchronously inside the tap', ['orientation', 'motion', 'geo.getCurrentPosition'].every(n => calls.some(c => c.name === n && c.inGesture)) && calls.every(c => c.inGesture), { calls, sens });
    check('permissions granted state recorded', sens.ori === 'granted' && sens.mot === 'granted', sens);
    for (const h of [10, 20, 30, 40, 47]) { await p.evaluate(h => window.__fireOri({ alpha: 300, beta: 80, gamma: 0, webkitCompassHeading: h, webkitCompassAccuracy: 10 }), h); await sleep(30); }
    await sleep(1500); const hd = await p.evaluate(() => ({ h: Math.round(__pe.S && window.__pe.sens.ori.last.webkitCompassHeading), src: document.getElementById('t-hs').textContent }));
    const diag = await p.evaluate(() => { __pe.openSheet('sensors'); return document.getElementById('sensors').innerText; });
    check('heading follows webkitCompassHeading (47° → tape)', /Heading used\s+47°\s·\scompass/.test(diag), diag.split('\n').filter(l => /Heading used|webkit/.test(l)));
    await sleep(1600); const ll = await p.$eval('#t-ll', e => e.textContent);
    check('GPS coords + accuracy shown even when > 15 m (fusion still PDR)', /40\.7128\d? -74\.0060\d? ±85m/.test(ll), ll);
    await p.screenshot({ path: path.join(OUT, 'shot_sensors.png') });
    await p.evaluate(() => document.getElementById('sheet-close').click());
    await p.evaluate(() => window.__fireOri({ alpha: 120, beta: 80, gamma: 0, webkitCompassHeading: null }));
    await sleep(2300); await p.evaluate(() => window.__fireOri({ alpha: 120, beta: 80, gamma: 0, webkitCompassHeading: null })); await sleep(600);
    const rel = await p.evaluate(() => ({ hs: document.getElementById('t-hs').textContent, note: __pe.sens.ori.note }));
    check('null webkitCompassHeading → alpha fallback, flagged RELATIVE with calibration note', rel.hs === 'HDG RELATIVE' && /Compass Calibration/.test(rel.note), rel);
    await p.screenshot({ path: path.join(OUT, 'shot_hud_ios.png') }); await ctx.close(); }
  // (c) orientation denied first → ENABLE COMPASS button → retry in a fresh tap grants; geolocation denied → clear status; minimap draws with no GPS/heading
  { const ctx = await browser.createBrowserContext(); await ctx.overridePermissions(new URL(BASE).origin, ['camera']); const p = await newPage(ctx, 'iosC');
    await p.evaluateOnNewDocument(MOCK, { ori: 'denied', oriThenGrant: true }); await p.goto(BASE, { waitUntil: 'load' });
    await p.click('#btn-start'); await p.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 20000 }); await sleep(1500);
    const st = await p.evaluate(() => ({ perm: __pe.sens.ori.perm, btn: !document.getElementById('b-compass').classList.contains('hidden'), geo: document.getElementById('t-ll').textContent }));
    check('denied orientation → ENABLE COMPASS button shown', st.perm === 'denied' && st.btn, st);
    check('geolocation denied → HUD says GPS DENIED', /GPS DENIED/.test(st.geo), st.geo);
    await p.click('#b-compass'); await sleep(300); const st2 = await p.evaluate(() => ({ perm: __pe.sens.ori.perm, calls: window.__permCalls }));
    check('ENABLE COMPASS retries inside the fresh tap → granted', st2.perm === 'granted' && st2.calls.filter(c => c.name === 'orientation').every(c => c.inGesture), st2);
    await p.evaluate(() => { __pe.setHeading(NaN); for (let i = 0; i < 8; i++) __pe.step(); }); await sleep(500);
    const mm = await p.evaluate(() => { const c = document.getElementById('minimap'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return { lit: n, w: c.width, err: __pe.drawErr, path: __pe.path().length, finite: __pe.path().every(q => isFinite(q.x) && isFinite(q.y)) }; });
    check('minimap renders with no GPS and NaN heading (PDR path, DPR-sized canvas)', mm.lit > 500 && mm.w >= 300 && !Object.keys(mm.err).length && mm.path >= 2 && mm.finite, mm);
    await p.screenshot({ path: path.join(OUT, 'shot_minimap_nogps.png') }); await ctx.close(); }
};
