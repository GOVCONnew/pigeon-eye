# Newton PIGEON EYE

An awareness HUD for iPhone Safari, for **recreational airsoft and casual play**. It has no scoring and no ballistics. Everything runs on the phone. No frames, audio or positions go to any server.

**Live:** https://govconnew.github.io/pigeon-eye/

- **HUD**: full-screen rear camera, compass tape (`webkitCompassHeading`), GPS/PDR mode + accuracy, clock, battery (where the browser exposes it), contact counts. Confirmed people and animals get bracket boxes with confidence, `~distance` (pinhole model: assumed height × focal ÷ box height; `≤` when the box is cut off) and bearing.
- **Off-screen arrows** point to squad mates, waypoints and contacts from the last 60 s, with distance.
- **Minimap** (tap to expand) over SAT (Esri) / MAP (OSM) / GRID layers, with SAVE AREA (Sentinel-2, offline);: heading-up or north-up, breadcrumb trail, squad, waypoints, decaying contact markers, rooms marked clear. Tap the map (or the HUD at a bearing) to drop a waypoint.
- **Positioning**: GPS when ±15 m or better; otherwise pedestrian dead reckoning (step detector on `devicemotion` × step length along the compass), blended in a local ENU frame. Exports as GeoJSON or CSV.
- **Squad link**: WebRTC data channels with `iceServers: []` over shared Wi-Fi or a Personal Hotspot. Pairing uses QR codes (offer → answer). The host relays to 2–6 phones in a star. Shared data: callsign, colour, position, heading, waypoints, room clears, contacts. There's a "sync start point" step, and links show latency and fade when stale. Optional online pairing goes through the PeerJS cloud, which only sees signaling metadata.
- **Detection**: EfficientDet-Lite0 (MediaPipe, WASM) with a COCO-SSD fallback, plus the SENTINEL 2.0 confirmation tracker. Squad mates are **not** recognised by the camera; their markers come from shared positions.
- **Pose (v1.2)**: optional stick-figure skeleton from MediaPipe Pose Landmarker lite (on-device, up to 4 people, smoothed). Shows a HANDS: 2/1 visible / not visible readout and a HANDS UP / 1 HAND UP tag (wrists above shoulders for about 0.5 s, with hysteresis, upper body only). When someone is crouched or cut off, distance is estimated from shoulder width (marked “(sh)”). No weapon or object detection of any kind.
- **Offline**: a service worker precaches the shell, libraries and detector. YAMNet sound classification is optional and off by default.
- **Session log**: IndexedDB. Exports JSON / events CSV / path CSV / GeoJSON. Monitoring gaps are logged.

Tests: `node test/run_tests.js [url]` runs unit math/PDR/minimap/codec tests, a Node WebRTC squad test (werift), a detector eval, the full-app headless flow, a QR render+decode check, the browser↔browser squad link (when Chrome can gather ICE candidates; see CI) and an offline reload. Licenses: docs/LICENSES.md.
