const http = require("http");
const fs   = require("fs");
const path = require("path");

const MIME = {
    ".html": "text/html", ".js": "application/javascript",
    ".css": "text/css",   ".wasm": "application/wasm",
    ".mp4": "video/mp4",  ".png": "image/png",
    ".jpg": "image/jpeg", ".json": "application/json",
    ".gz": "application/gzip", ".wav": "audio/wav", ".mp3": "audio/mpeg"
};

http.createServer((req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy",   "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

    let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("Not found"); return; }

    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
    fs.createReadStream(filePath).pipe(res);
}).listen(8080, () => console.log("Open: http://127.0.0.1:8080"));