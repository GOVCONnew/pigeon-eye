# Third-party components (all vendored, served same-origin)
| Component | Version | License | Path |
|---|---|---|---|
| MediaPipe Tasks Vision (bundle + WASM) | 0.10.21 | Apache-2.0 | vendor/mp/ |
| EfficientDet-Lite0 float16 (MediaPipe model zoo) | — | Apache-2.0 | models/effdet/ |
| TensorFlow.js | 4.22.0 | Apache-2.0 | vendor/tf.min.js |
| COCO-SSD lite_mobilenet_v2 weights (tfjs-models) | — | Apache-2.0 | vendor/coco/ |
| YAMNet (TF Hub, tfjs) + class map | 1 | Apache-2.0 | models/yamnet/ |
| jsQR | 1.4.0 | Apache-2.0 | vendor/jsQR.js |
| qrcode-generator (Kazuhiko Arase) | 1.4.4 | MIT | vendor/qrcode.js |
| PeerJS (optional online signaling) | 1.5.4 | MIT | vendor/peerjs.min.js |
| werift (tests only, not shipped) | 0.19 | MIT | npm |

Code reused from Newton SENTINEL Mobile 2.0: js/core.js, js/track.js, js/detectors.js, js/audio.js, js/audiologic.js.
Test images: test/eval/ (Wikimedia Commons, per-image license + author in test/eval/ground_truth.json); test/person_dog.jpg (public domain, see SENTINEL ATTRIBUTION).
