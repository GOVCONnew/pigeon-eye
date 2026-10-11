// Minimal static server for tests/benchmarks (no COOP/COEP, same as GitHub Pages).
const http = require('http'), fs = require('fs'), path = require('path');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm', '.csv': 'text/csv', '.bin': 'application/octet-stream', '.mp4': 'video/mp4', '.onnx': 'application/octet-stream', '.tflite': 'application/octet-stream', '.webmanifest': 'application/manifest+json' };
module.exports = function serve(root, port) {
  const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); r.end(d); }); });
  return new Promise(res => srv.listen(port, () => res(srv)));
};
