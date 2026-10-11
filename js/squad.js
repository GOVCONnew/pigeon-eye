/* PIGEON EYE — squad link. WebRTC DataChannels, star topology (host relays), no server:
 * manual signaling by QR codes (offer → joiner, answer → host). iceServers: [] → only host (LAN / hotspot) candidates.
 * Optional online mode via PeerJS cloud signaling (signaling metadata only; data stays peer-to-peer). */
(function (global) {
  'use strict';
  // ---- compact signaling codec: "PE1." + base64url(deflate-raw(json)) or "PE0." + base64url(json) ----
  function b64u(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), o = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  async function pipe(bytes, Stream) { var cs = new Stream('deflate-raw'), w = cs.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
  /** Strip SDP lines not needed on a LAN data-channel-only link to shrink the QR. */
  function slimSdp(sdp) { return sdp.split(/\r?\n/).filter(function (l) { return l && !/^a=(extmap|rtcp-fb|ssrc|msid-semantic)/.test(l) && !/typ (srflx|relay)/.test(l); }).join('\r\n') + '\r\n'; }
  async function encode(obj) {
    var js = new TextEncoder().encode(JSON.stringify(obj));
    if (global.CompressionStream) { try { return 'PE1.' + b64u(await pipe(js, CompressionStream)); } catch (e) {} }
    return 'PE0.' + b64u(js);
  }
  async function decode(str) {
    str = String(str).trim(); var k = str.slice(0, 4), body = unb64u(str.slice(4));
    if (k === 'PE1.') body = await pipe(body, DecompressionStream); else if (k !== 'PE0.') throw new Error('not a PIGEON EYE pairing code');
    return JSON.parse(new TextDecoder().decode(body));
  }
  function waitIce(pc, ms) { return new Promise(function (res) { if (pc.iceGatheringState === 'complete') return res(); var t = setTimeout(res, ms || 4000); pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); }); }
  function rid() { return Math.random().toString(36).slice(2, 8); }

  function Squad(o) {
    this.me = o.me; // {id, callsign, color}
    this.onMessage = o.onMessage || function () {}; this.onRoster = o.onRoster || function () {}; this.onLog = o.onLog || function () {};
    this.role = null; this.links = {}; this.pending = {}; this.roster = {}; this.peer = null; this.mode = null;
    var self = this; this._ping = setInterval(function () { self._pingAll(); self._stale(); }, 2000);
  }
  Squad.prototype._cfg = function () { return { iceServers: [] }; };
  Squad.prototype._attach = function (ch, peerId, via) {
    var self = this, L = { ch: ch, id: peerId, via: via, rtt: null, open: false };
    var onOpen = function () { L.open = true; self._send(L, { t: 'hello', from: self.me.id, callsign: self.me.callsign, color: self.me.color, role: self.role }); self.onLog('link open', peerId); if (self.role === 'host') self._broadcastRoster(); self.onRoster(); };
    var onMsg = function (data) { if (!L.open) onOpen(); var m; try { m = typeof data === 'string' ? JSON.parse(data) : data; } catch (e) { return; } self._recv(L, m); };
    var onClose = function () { L.open = false; if (self.roster[L.id]) self.roster[L.id].link = 'closed'; self.onLog('link closed', L.id); self.onRoster(); };
    if (via === 'peerjs') { ch.on('open', onOpen); ch.on('data', onMsg); ch.on('close', onClose); if (ch.open) onOpen(); }
    else { ch.onopen = onOpen; ch.onmessage = function (e) { onMsg(e.data); }; ch.onclose = onClose; if (ch.readyState === 'open') onOpen(); }
    this.links[peerId] = L; return L;
  };
  Squad.prototype._send = function (L, m) { if (!L.open) return false; try { var s = JSON.stringify(m); if (L.via === 'peerjs') L.ch.send(s); else L.ch.send(s); return true; } catch (e) { return false; } };
  Squad.prototype._recv = function (L, m) {
    if (m.t === 'ping') { var rp = this.roster[L.id]; if (rp) rp.lastSeen = Date.now(); this._send(L, { t: 'pong', ts: m.ts, from: this.me.id }); return; }
    if (m.t === 'pong') { L.rtt = Date.now() - m.ts; var r0 = this.roster[L.id]; if (r0) { r0.rtt = L.rtt; r0.lastSeen = Date.now(); } this.onRoster(); return; }
    if (m.t === 'hello') { var oldId = L.id; if (oldId !== m.from) { delete this.links[oldId]; L.id = m.from; this.links[m.from] = L; } }
    var from = m.from || L.id, r = this.roster[from] || (this.roster[from] = { id: from });
    if (m.callsign) r.callsign = m.callsign; if (m.color) r.color = m.color; r.lastSeen = Date.now(); r.link = from === L.id ? 'direct' : 'via host'; if (from === L.id) r.rtt = L.rtt;
    if (m.t === 'roster' && this.role === 'member') { var self = this; (m.members || []).forEach(function (x) { if (x.id !== self.me.id) { var q = self.roster[x.id] || (self.roster[x.id] = { id: x.id }); q.callsign = x.callsign; q.color = x.color; q.link = 'via host'; q.lastSeen = q.lastSeen || Date.now(); } }); }
    if (this.role === 'host' && m.t !== 'hello' && m.t !== 'roster') this._relay(m, L.id); // star relay
    if (this.role === 'host' && m.t === 'hello') this._broadcastRoster();
    this.onMessage(m, from); this.onRoster();
  };
  Squad.prototype._relay = function (m, exceptId) { for (var k in this.links) if (k !== exceptId) this._send(this.links[k], m); };
  Squad.prototype._broadcastRoster = function () { var me = this.me, list = [{ id: me.id, callsign: me.callsign, color: me.color }]; for (var k in this.roster) list.push({ id: k, callsign: this.roster[k].callsign, color: this.roster[k].color }); for (var j in this.links) this._send(this.links[j], { t: 'roster', from: me.id, members: list }); };
  Squad.prototype._pingAll = function () { for (var k in this.links) this._send(this.links[k], { t: 'ping', ts: Date.now(), from: this.me.id }); };
  Squad.prototype._stale = function () { var now = Date.now(), ch = false; for (var k in this.roster) { var r = this.roster[k], s = now - (r.lastSeen || 0) > 15000 ? 'stale' : now - (r.lastSeen || 0) > 6000 ? 'fading' : 'live'; if (r.state !== s) { r.state = s; ch = true; } } if (ch) this.onRoster(); };
  /** Broadcast a message to the squad (host → everyone, member → host which relays). */
  Squad.prototype.send = function (m) { m.from = this.me.id; m.callsign = this.me.callsign; m.color = this.me.color; var n = 0; for (var k in this.links) if (this._send(this.links[k], m)) n++; return n; };
  // ---- manual (QR) signaling ----
  Squad.prototype.hostCreateOffer = async function () {
    this.role = 'host'; this.mode = 'lan'; var pc = new RTCPeerConnection(this._cfg()), nonce = rid(), ch = pc.createDataChannel('pigeon', { ordered: true });
    this.pending[nonce] = { pc: pc, ch: ch }; await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc);
    var self = this; pc.onconnectionstatechange = function () { self.onLog('pc ' + pc.connectionState, nonce); };
    return encode({ k: 'o', n: nonce, h: this.me.id, c: this.me.callsign, s: slimSdp(pc.localDescription.sdp) });
  };
  Squad.prototype.hostAcceptAnswer = async function (str) {
    var a = await decode(str); if (a.k !== 'a') throw new Error('not an answer code'); var p = this.pending[a.n]; if (!p) throw new Error('answer does not match the current offer');
    await p.pc.setRemoteDescription({ type: 'answer', sdp: a.s }); delete this.pending[a.n];
    var r = this.roster[a.j] || (this.roster[a.j] = { id: a.j }); r.callsign = a.c; r.lastSeen = Date.now(); this._attach(p.ch, a.j, 'rtc').pc = p.pc; this.onRoster(); return a.j;
  };
  Squad.prototype.joinFromOffer = async function (str) {
    var o = await decode(str); if (o.k !== 'o') throw new Error('not an offer code'); this.role = 'member'; this.mode = 'lan';
    var pc = new RTCPeerConnection(this._cfg()), self = this;
    pc.ondatachannel = function (e) { self._attach(e.channel, o.h, 'rtc').pc = pc; };
    await pc.setRemoteDescription({ type: 'offer', sdp: o.s }); await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc);
    var r = this.roster[o.h] || (this.roster[o.h] = { id: o.h }); r.callsign = o.c; r.lastSeen = Date.now();
    return encode({ k: 'a', n: o.n, j: this.me.id, c: this.me.callsign, s: slimSdp(pc.localDescription.sdp) });
  };
  // ---- optional online signaling (PeerJS cloud) ----
  Squad.prototype.hostOnline = function () {
    var self = this; this.role = 'host'; this.mode = 'online'; var code = 'pigeoneye-' + rid();
    return new Promise(function (res, rej) { self.peer = new Peer(code); self.peer.on('open', function () { res(code); }); self.peer.on('error', rej); self.peer.on('connection', function (c) { self._attach(c, c.peer, 'peerjs'); }); });
  };
  Squad.prototype.joinOnline = function (code) {
    var self = this; this.role = 'member'; this.mode = 'online';
    return new Promise(function (res, rej) { self.peer = new Peer(); self.peer.on('error', rej); self.peer.on('open', function () { var c = self.peer.connect(code, { reliable: true }); self._attach(c, code, 'peerjs'); c.on('open', function () { res(code); }); }); });
  };
  Squad.prototype.status = function () { var out = []; for (var k in this.roster) { var r = this.roster[k], L = this.links[k]; out.push({ id: k, callsign: r.callsign, color: r.color, link: L && L.open ? 'direct' : r.link || '—', rtt: r.rtt, state: r.state || 'live', age: Date.now() - (r.lastSeen || 0) }); } return out; };
  Squad.prototype.close = function () { clearInterval(this._ping); for (var k in this.links) { try { this.links[k].ch.close(); this.links[k].pc && this.links[k].pc.close(); } catch (e) {} } if (this.peer) this.peer.destroy(); this.links = {}; };
  var api = { Squad: Squad, encode: encode, decode: decode, slimSdp: slimSdp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else global.PSquad = api;
})(typeof window !== 'undefined' ? window : globalThis);
