# PIGEON EYE — Architecture (v1.3.0)

PIGEON EYE is a static, offline-capable web app. There's no build step and no server, and everything runs on the device. Plain `<script>` files load in order from `index.html`, and `sw.js` precaches all of them so the app works with no signal.

## Modules

| Layer | File | Role |
|---|---|---|
| Libraries (pure, unit-tested in Node) | `js/geo.js`, `js/tiles.js`, `js/squad.js`, `js/detectors.js`, `js/poselogic.js` | Maths, ENU/geo, tile cache, squad protocol, detector tracking/fusion. Also pose logic: One Euro filter, `PoseTracker`, hands/hands-up state. No DOM. |
| Runtimes (lazy-loaded) | `js/pose.js`, MediaPipe detector loader | Wrap the on-device models (vendored under `models/`). |
| Bus | `js/bus.js` | `PE.bus` event bus and the `PE.register` feature registry. |
| Features | `js/features/pose.js`, `js/features/map.js` | Self-contained UI features. They register themselves and talk to the core only through `ctx` and bus events. |
| Core | `js/app.js` | Owns the sensors, camera, detection loop, HUD, settings, squad link, log/export. It builds `ctx`, emits events, then calls `PE.start(ctx)`. |

Load order is: libraries → `bus.js` → `features/*.js` → `app.js`. Features call `PE.register` at load time. Their `setup(ctx)` runs when the core calls `PE.start(ctx)`, or straight away if the feature is registered later.

## Event bus

```js
const off = PE.bus.on('detect:update', d => { ... });  // returns an unsubscribe fn
PE.bus.emit('my:event', payload);                       // handler errors are caught → PE.errors, never break the loop
```

| Event | Payload | When |
|---|---|---|
| `frame` | – | Every HUD animation frame (rAF) |
| `detect:update` | `{tracks, events, W, H, now, ms}` | After each object-detection pass |
| `detector:ready` | – | Detector model loaded |
| `settings:change` | key | A setting changed (`ctx.S[key]`) |
| `session:start` | – | START pressed |
| `contact` | contact | New confirmed contact |
| `waypoint` / `room` | object | Waypoint added / room marked clear |
| `squad:<type>` | message | Squad message received (`pos`, `wp`, `room`, `sync`…) |
| `pose:ready` | – | Pose model loaded |
| `feature:ready` | name | A feature's setup finished |

## `ctx` (the core API for features)

- **Helpers:** `$`, `esc`, `toast`, `dialog`, `logEv(type, text)`, `loadScript(src)`, `save()`, `openSheet(name)`.
- **State:** `S` (settings), `G` (GPS/fusion state), `me`, `heading()`, `running()`, `fps()`, and the getters `path`, `waypoints`, `rooms`, `contacts`, `squadState`.
- **Elements and objects:** `video`, `hud`, `mm` (minimap canvas), `resize`, `cover`, `tracker` (detector tracker), `fuser`, `tiles`, `squad`, `drawErr`.
- **Actions:** `memberENU`, `waypointDialog`, `addWaypoint`, `markClear`.

Features should read the core through `ctx`, react to bus events, and expose their own API by returning an object. That object is available as `PE.features[name]`.

## Adding a feature

1. Create `js/features/myfeature.js`:

```js
PE.register('myfeature', function (ctx) {
  'use strict';
  let count = 0;
  PE.bus.on('detect:update', d => { count = d.tracks.length; });
  PE.bus.on('frame', () => { /* draw on your own canvas, or update DOM */ });
  return { count: () => count };          // → PE.features.myfeature
});
```

2. Add `<script src="js/features/myfeature.js"></script>` to `index.html`, after `js/bus.js` and before `js/app.js`.
3. Add the file, and any model or asset it uses, to the precache list in `sw.js`, then bump the cache version `V`.
4. Put pure logic in a DOM-free library file and unit-test it in `test/unit.js`. Add a browser check in `test/run_tests.js` or in a module like `test/pose_tests.js`.
5. Keep it on-device and free, with no network calls at runtime. Vendor models and libraries, and record their licences in `docs/LICENSES.md`.

## Pose pipeline (feature `pose`)

1. `requestVideoFrameCallback` fires once per *presented camera frame*; rAF is the fallback. Pose runs only when the detector currently sees a person, or a pose track is still alive.
2. **Adaptive stride.** Pose runs on every frame when inference takes under 28 ms and the HUD runs at 24 fps or more. Otherwise it runs every 2nd frame (under 50 ms, 15 fps or more) or every 3rd frame. Low-power mode always uses every 3rd frame or slower.
3. **`PoseTracker.update`** matches poses greedily. Cost = (1 − IoU) + centroid distance / box diagonal + landmark distance / box diagonal, with a gate of 1.6. This keeps ids stable when people move or cross. Unmatched poses start new tracks, and tracks are dropped after 600 ms unseen.
4. Each landmark x/y goes through a **One Euro filter** (minCutoff 0.8 Hz, beta 0.008 in pixel units). That gives low jitter when the person is still and little lag when they move fast. The track keeps a per-landmark velocity.
5. **Drawing** happens in the HUD frame. It uses `tracker.predict(track, now)`, which extrapolates by velocity for up to 150 ms, so the skeleton stays on a moving person between pose frames.
6. Pose tracks are linked to detector person tracks by box IoU, with the pose centroid required to fall inside the box (`forTrack(detId)`).

## Roadmap for further splitting

Sensors/fusion, detection, squad UI and the log/export still live in `app.js`. They already reach each other through `ctx` and bus events, so each can move to `js/features/` the same way `map` and `pose` did.
