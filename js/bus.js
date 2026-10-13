/* PIGEON EYE — event bus + feature registry. See docs/ARCHITECTURE.md.
 *   PE.bus.on(evt, fn) / off / emit(evt, payload)
 *   PE.register(name, function setup(ctx) { ...; return api; })   — features self-register at load time
 *   PE.start(ctx) — called once by the core (js/app.js) after it has built the context; runs every setup(ctx).
 *   PE.features[name] — the API object a feature returned (other modules/tests may use it). */
(function (global) {
  'use strict';
  var handlers = {}, pending = [], started = null, PE = global.PE || {};
  PE.bus = {
    on: function (e, fn) { (handlers[e] = handlers[e] || []).push(fn); return function () { PE.bus.off(e, fn); }; },
    off: function (e, fn) { handlers[e] = (handlers[e] || []).filter(function (f) { return f !== fn; }); },
    emit: function (e, p) { var hs = (handlers[e] || []).slice(), ok = 0; for (var i = 0; i < hs.length; i++) { try { hs[i](p); ok++; } catch (err) { (PE.errors = PE.errors || []).push(e + ': ' + err.message); if (global.console) console.warn('PE handler ' + e, err); } } return ok; }
  };
  PE.features = PE.features || {}; PE.errors = PE.errors || [];
  PE.register = function (name, setup) { if (started) { PE.features[name] = setup(started) || {}; PE.bus.emit('feature:ready', name); } else pending.push([name, setup]); };
  PE.start = function (ctx) { started = ctx; pending.forEach(function (p) { try { PE.features[p[0]] = p[1](ctx) || {}; PE.bus.emit('feature:ready', p[0]); } catch (e) { (PE.errors = PE.errors || []).push('setup ' + p[0] + ': ' + e.message); if (global.console) console.error('feature ' + p[0], e); } }); pending = []; };
  global.PE = PE;
  if (typeof module !== 'undefined' && module.exports) module.exports = PE;
})(typeof window !== 'undefined' ? window : globalThis);
