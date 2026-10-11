// Squad-link test with real WebRTC data channels in Node (werift: pure-JS WebRTC), exercising js/squad.js unchanged:
// host + 2 members, iceServers: [], manual signaling strings (what the QR codes carry), star relay, positions/waypoints/rooms, RTT.
// (Used because headless Chrome in this sandbox cannot enumerate network interfaces → gathers no ICE candidates.)
const path = require('path'); let werift; try { werift = require(process.env.WERIFT || '/tmp/pe_node/node_modules/werift'); } catch (e) { werift = require('werift'); }
globalThis.RTCPeerConnection = werift.RTCPeerConnection; globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64'); globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
const { Squad, decode } = require('../js/squad.js'), sleep = ms => new Promise(r => setTimeout(r, ms)), wait = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await sleep(100); } return true; };
module.exports = (async () => {
  const res = []; const check = (n, ok, info) => { res.push({ name: n, ok: !!ok, info }); console.log((ok ? 'ok   ' : 'FAIL ') + n + (info ? ' — ' + JSON.stringify(info) : '')); };
  const mk = (id, cs) => { const box = { msgs: [] }; box.sq = new Squad({ me: { id, callsign: cs, color: '#0ef' }, onMessage: (m, from) => box.msgs.push({ m, from }) }); return box; };
  const H = mk('host1', 'HAWK'), M1 = mk('mem1', 'FALCON'), M2 = mk('mem2', 'OWL');
  try {
    for (const M of [M1, M2]) {
      const offer = await H.sq.hostCreateOffer(); const o = await decode(offer);
      const cands = o.s.split('\n').filter(l => l.startsWith('a=candidate')).length;
      const answer = await M.sq.joinFromOffer(offer); await H.sq.hostAcceptAnswer(answer);
      check(`pairing ${M.sq.me.callsign}: offer ${offer.length} / answer ${answer.length} chars (QR-sized), ${cands} host candidates`, offer.length < 2900 && answer.length < 2900 && cands > 0);
    }
    check('host has 2 direct links', await wait(() => H.sq.status().filter(s => s.link === 'direct').length === 2), H.sq.status().map(s => s.callsign + ':' + s.link));
    await wait(() => M1.sq.status().length >= 2 && M2.sq.status().length >= 2, 5000);
    check('members learn full roster via host', M1.sq.status().some(s => s.callsign === 'OWL') && M2.sq.status().some(s => s.callsign === 'FALCON'), { m1: M1.sq.status().map(s => s.callsign + ':' + s.link), m2: M2.sq.status().map(s => s.callsign + ':' + s.link), m2msgs: M2.msgs.map(x => x.m.t) });
    M1.sq.send({ t: 'state', s: { x: 10.1, y: -3, mode: 'PDR', heading: 90 } }); M1.sq.send({ t: 'waypoint', w: { id: 'w1', name: 'RALLY', x: 5, y: 5 } });
    H.sq.send({ t: 'room', r: { id: 'r1', name: 'Room 1', x: 0, y: 0 } }); H.sq.send({ t: 'sync', origin: null });
    check('member→host position', await wait(() => H.msgs.some(x => x.m.t === 'state' && x.from === 'mem1' && x.m.s.x === 10.1)));
    check('member→member waypoint relayed by host (star)', await wait(() => M2.msgs.some(x => x.m.t === 'waypoint' && x.from === 'mem1' && x.m.w.name === 'RALLY')));
    check('host room-clear + sync reach both members', await wait(() => [M1, M2].every(M => M.msgs.some(x => x.m.t === 'room') && M.msgs.some(x => x.m.t === 'sync'))));
    await sleep(4500); const rtts = H.sq.status().map(s => s.rtt);
    check('latency (RTT) measured on both links', rtts.every(r => r != null && r < 500), rtts);
    M2.sq.close(); await sleep(16500); // stale-member fading
    check('closed member goes stale/fading on host', H.sq.status().some(s => s.callsign === 'OWL' && s.state !== 'live') && H.sq.status().some(s => s.callsign === 'FALCON' && s.state === 'live'), H.sq.status().map(s => s.callsign + ':' + s.state));
  } catch (e) { check('exception', false, e.stack); }
  [H, M1, M2].forEach(b => b.sq.close());
  return res;
})();
if (require.main === module) module.exports.then(r => { console.log(r.filter(x => x.ok).length + '/' + r.length + ' squad checks'); process.exit(r.every(x => x.ok) ? 0 : 1); });
