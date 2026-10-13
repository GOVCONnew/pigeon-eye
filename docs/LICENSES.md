# Third-party components (all vendored, served same-origin)
| Component | Version | License | Path |
|---|---|---|---|
| MediaPipe Tasks Vision (bundle + WASM) | 0.10.21 | Apache-2.0 | vendor/mp/ |
| MediaPipe Pose Landmarker lite (pose_landmarker_lite.task, float16) | latest (2026-10) | Apache-2.0 | models/pose/ |
| EfficientDet-Lite0 float16 (MediaPipe model zoo) | — | Apache-2.0 | models/effdet/ |
| TensorFlow.js | 4.22.0 | Apache-2.0 | vendor/tf.min.js |
| COCO-SSD lite_mobilenet_v2 weights (tfjs-models) | — | Apache-2.0 | vendor/coco/ |
| YAMNet (TF Hub, tfjs) + class map | 1 | Apache-2.0 | models/yamnet/ |
| jsQR | 1.4.0 | Apache-2.0 | vendor/jsQR.js |
| qrcode-generator (Kazuhiko Arase) | 1.4.4 | MIT | vendor/qrcode.js |
| PeerJS (optional online signaling) | 1.5.4 | MIT | vendor/peerjs.min.js |
| werift (tests only, not shipped) | 0.19 | MIT | npm |

Code reused from Newton SENTINEL Mobile 2.0: js/core.js, js/track.js, js/detectors.js, js/audio.js, js/audiologic.js.
Pose test photos: test/hands_c.jpg “Raise those arms” by Thomas Quine (CC BY 2.0, Wikimedia Commons File:Raise_those_arms_(31482765357).jpg); test/hands_a.jpg by Allef Vinicius (CC0, Wikimedia Commons File:Allef_Vinicius_2017-02-24_(Unsplash).jpg).
Test images: test/eval/ (Wikimedia Commons, per-image license + author in test/eval/ground_truth.json); test/person_dog.jpg (public domain, see SENTINEL ATTRIBUTION).

# Map tiles (fetched at runtime, not vendored)
| Layer | Source | Terms / attribution shown | Offline use |
|---|---|---|---|
| MAP | OpenStreetMap standard tiles (tile.openstreetmap.org) | © OpenStreetMap contributors (ODbL); OSM Tile Usage Policy: attribution, low volume, no bulk prefetch | **No prefetch.** Only tiles you have viewed are kept (cache `pe-tiles-view`, trimmed to 600) |
| SAT (online) | Esri World Imagery (server.arcgisonline.com) | "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community". Esri's terms: free non-commercial use with attribution, nominally tied to a free ArcGIS developer account; bulk harvesting/offline export outside Esri packages is **not** allowed | **No prefetch.** Viewed tiles only, same capped cache |
| SAT (offline) / SAVE AREA | EOX Sentinel-2 cloudless 2023 (tiles.maps.eox.at) | "Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (modified Copernicus Sentinel data 2023)", CC BY-NC-SA 4.0 (non-commercial) | SAVE AREA downloads z12–15 (about 10 m/px) for 0.5/1/2 km, max 500 tiles per download, stored in Cache Storage `pe-tiles-saved` |
| GRID | none | — | always |
