// Pose tests: MediaPipe Pose Landmarker on real photos + in-app skeleton/hands/hands-up with a fake camera.
const puppeteer = require(process.env.PUPPETEER || '/tmp/pwtest/node_modules/puppeteer-core'), path = require('path'), sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = async function (browser, BASE, check, newPage, OUT, errs) {
  // (1) model on photos
  { const ctx = await browser.createBrowserContext(), p = await newPage(ctx, 'pose'); await p.goto(BASE + 'test/pose.html', { waitUntil: 'load' });
    const r = await p.evaluate(() => run(['hands_c.jpg', 'hands_a.jpg', 'person_dog.jpg'])); const [c, a, d] = r.map(x => x.people[0] || {});
    check('pose model: arms-raised photo → both wrists well above shoulders, 2 hands visible', c.hands === 2 && c.l > 0.3 && c.r > 0.3, c);
    check('pose model: backlit silhouette → ≥1 raised wrist found', a.hands >= 1 && Math.max(a.l || -9, a.r || -9) > 0.3, a);
    check('pose model: woman holding dog → hands visible, not raised', d.hands === 2 && d.l < 0.12 && d.r < 0.12, d);
    await ctx.close(); }
  // (2) app with a fake camera of a person with raised arms (separate browser: fake capture file is per browser)
  const b2 = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', protocolTimeout: 600000, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + (process.env.PE_HANDS || '/tmp/pe_hands.y4m')] });
  try { const ctx = await b2.createBrowserContext(), p = await newPage(ctx, 'poseApp'); await p.goto(BASE, { waitUntil: 'load' });
    await p.waitForFunction(() => /· mediapipe-/.test(document.getElementById('model-status').textContent), { timeout: 120000 });
    await p.click('#btn-start'); await p.waitForFunction(() => document.getElementById('start').classList.contains('hidden'), { timeout: 30000 });
    await p.waitForFunction(() => [...__pe.poseStates.values()].some(s => s.tag === 'HANDS UP') && /HANDS UP ×/.test(document.getElementById('counts').textContent), { timeout: 60000 }).catch(() => {});
    const st = await p.evaluate(() => ({ states: [...__pe.poseStates.values()].map(s => ({ tag: s.tag, hands: s.hands, l: s.arm.l.score, r: s.arm.r.score })), runs: __pe.poseStats.runs, counts: document.getElementById('counts').textContent, ev: __pe.events().filter(e => e.type === 'pose').map(e => e.text), method: __pe.contacts().map(c => c.method) }));
    check('app: HANDS UP tag on confirmed person (held ≥0.5 s), HUD summary + log event', st.states.some(s => s.tag === 'HANDS UP') && /HANDS: 2 visible/.test(st.counts) && /HANDS UP ×1/.test(st.counts) && st.ev.some(e => /HANDS UP/.test(e)), st);
    await sleep(300); await p.screenshot({ path: path.join(OUT, 'shot_pose_handsup.png') });
    await p.evaluate(() => { __pe.S.pose = false; }); await sleep(600); const off = await p.evaluate(() => document.getElementById('counts').textContent);
    check('pose toggle off hides skeleton/hands readout', !/HANDS/.test(off), off);
    await ctx.close(); } catch (e) { check('pose app exception', false, e.message); }
  await b2.close();
};
