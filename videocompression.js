/**
 * videocompression.js
 *
 * Video compression for the MACS JC Project 2 Chrome Extension.
 *
 * ─── NO FFMPEG — zero new libraries ───────────────────────────────────────
 *
 * LOSSY  (CRF 1–51): Uses the browser-native MediaRecorder API + VP9 codec.
 *   - Built into Chrome, no installation needed.
 *   - Maps CRF value to a target video bitrate (kbps).
 *   - Output: .webm container with VP9 video + Opus audio.
 *
 * LOSSLESS (CRF 0): Uses pako GZIP (already loaded globally via CDN).
 *   - Wraps the original .mp4 in a GZIP archive (.mp4.gz).
 *   - SHA-256 of the original is stored and verified on rebuild.
 *   - Output: .mp4.gz archive, decompressed back to original .mp4.
 *
 * Dependencies:
 *   - pako    (global, already loaded via CDN in index.html)
 *   - No other libraries needed.
 *
 * Exports (global functions called by popup.js):
 *   compressVideoLossy(file, crf, preset, onLog, onProgress)
 *   compressVideoLossless(file, onLog, onProgress)
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SHARED UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a human-readable file size string.
 * @param {number} bytes
 * @returns {string}  e.g. "4.20 MB"
 */
function videoFormatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * Compression ratio: originalSize / compressedSize  (PDF §6.1)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}  e.g. "2.87:1"
 */
function videoCompressionRatio(original, compressed) {
    if (compressed === 0) return "∞:1";
    return (original / compressed).toFixed(2) + ":1";
}

/**
 * Space savings percentage  (PDF §6.2)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}  e.g. "65.15%"
 */
function videoSpaceSavings(original, compressed) {
    return (((original - compressed) / original) * 100).toFixed(2) + "%";
}

/**
 * Video bitrate in kbps — quality metric for lossy compression  (PDF §6.3)
 * Formula: (fileSizeBytes × 8) / (durationSeconds × 1000)
 * @param {number} bytes
 * @param {number} durationSec
 * @returns {string}  e.g. "1280 kbps"
 */
function videoComputeBitrate(bytes, durationSec) {
    if (!durationSec || durationSec <= 0) return "N/A";
    return Math.round((bytes * 8) / (durationSec * 1000)) + " kbps";
}

/**
 * SHA-256 hash via SubtleCrypto — no external library needed  (PDF §6.4)
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}  lowercase hex string
 */
async function videoComputeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, "0"))
                .join("");
}

/**
 * Reads video duration, width, and height via the HTML5 video element.
 * @param {File|Blob} videoFile
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function getVideoMetadata(videoFile) {
    return new Promise((resolve, reject) => {
        const video   = document.createElement("video");
        video.preload = "metadata";
        video.muted   = true;
        const url     = URL.createObjectURL(videoFile);

        video.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve({
                duration: video.duration,
                width:    video.videoWidth,
                height:   video.videoHeight,
            });
        };

        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(
                "Could not read video metadata. " +
                "The file may be unsupported or corrupted."
            ));
        };

        video.src = url;
    });
}

/**
 * Maps a CRF value (H.264 scale 0–51) to a target bitrate in bits/sec.
 * Each 6 CRF units approximately halves the bitrate (same as x264 behaviour).
 *
 * CRF 18 → ~3 Mbps   (near-transparent)
 * CRF 24 → ~1.5 Mbps (good quality, default)
 * CRF 30 → ~750 kbps (medium)
 * CRF 36 → ~375 kbps (low)
 * CRF 42 → ~188 kbps (very low)
 *
 * @param {number} crf  1–51 (0 is routed to lossless, not here)
 * @returns {number}  bits per second
 */
function crfToBitrate(crf) {
    const bps = Math.round(3000000 / Math.pow(2, (crf - 18) / 6));
    // Clamp: minimum 150 kbps, maximum 8 Mbps
    return Math.min(8000000, Math.max(150000, bps));
}

/**
 * Returns the best supported VP9/VP8 MIME type for MediaRecorder,
 * or a generic "video/webm" fallback.
 * @returns {string}
 */
function getBestMimeType() {
    const candidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp8",
        "video/webm",
    ];
    for (const type of candidates) {
        if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "video/webm";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — LOSSY COMPRESSION: MediaRecorder + VP9
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a video file using the browser-native MediaRecorder API.
 * Encodes to WebM/VP9 at a bitrate derived from the CRF value.
 *
 * How it works:
 *   1. Loads the video into a hidden <video> element.
 *   2. Captures the playback stream via video.captureStream().
 *   3. MediaRecorder re-encodes the stream at the target bitrate.
 *   4. Collects encoded chunks and assembles them into a .webm Blob.
 *
 * IMPORTANT: The video plays in real-time during encoding.
 * Keep the extension popup open until the progress reaches 100%.
 * For testing, use short clips (the PDF recommends 30 seconds).
 *
 * @param {File}          videoFile   — Source .mp4 (or .mov, .webm, etc.)
 * @param {number}        crf         — Quality (1–51). Default 23.
 * @param {string}        preset      — Ignored (MediaRecorder has no presets)
 * @param {Function|null} onLog       — Optional log callback(message)
 * @param {Function|null} onProgress  — Optional progress callback(0–1)
 *
 * @returns {Promise<{
 *   type:                string,
 *   format:              string,
 *   compressedBlob:      Blob,
 *   originalSize:        number,
 *   compressedSize:      number,
 *   originalSizeHR:      string,
 *   compressedSizeHR:    string,
 *   ratio:               string,
 *   savings:             string,
 *   originalBitrate:     string,
 *   compressedBitrate:   string,
 *   originalDuration:    string,
 *   compressedDuration:  string,
 *   originalDimensions:  string,
 *   compressedDimensions:string,
 *   crfUsed:             number,
 *   originalDurationRaw: number,
 * }>}
 */
function compressVideoLossy(videoFile, crf = 23, preset = "medium", onLog = null, onProgress = null) {

    return new Promise(async (resolve, reject) => {

        // Guard: MediaRecorder must be available (it is in all modern Chrome)
        if (typeof MediaRecorder === "undefined") {
            return reject(new Error(
                "MediaRecorder API is not available in this browser. " +
                "Please use Chrome 94 or later."
            ));
        }

        const originalSize    = videoFile.size;
        let   originalMetadata;

        try {
            originalMetadata = await getVideoMetadata(videoFile);
        } catch (err) {
            return reject(err);
        }

        const { duration, width, height } = originalMetadata;

        if (onLog) onLog("Source: " + width + "×" + height + ", " + duration.toFixed(1) + "s");

        // Map CRF → target bitrate
        const targetBps  = crfToBitrate(crf);
        const mimeType   = getBestMimeType();

        if (onLog) onLog("Encoding to " + mimeType + " at " + Math.round(targetBps / 1000) + " kbps");

        // ── Create hidden video element ─────────────────────────────────
        const videoEl   = document.createElement("video");
        videoEl.muted   = false;    // keep audio in the stream
        videoEl.preload = "auto";
        videoEl.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;";
        document.body.appendChild(videoEl);

        const objectUrl = URL.createObjectURL(videoFile);
        videoEl.src     = objectUrl;

        videoEl.onerror = () => {
            cleanup();
            reject(new Error(
                "Failed to load video for encoding. " +
                "Try a different .mp4 file. " +
                "(Error code: " + (videoEl.error ? videoEl.error.code : "unknown") + ")"
            ));
        };

        videoEl.onloadeddata = () => {

            // ── Capture the video/audio stream ──────────────────────────
            let stream;
            try {
                stream = videoEl.captureStream();
            } catch (err) {
                cleanup();
                return reject(new Error(
                    "captureStream() failed: " + err.message + ". " +
                    "This may happen if the video codec is not supported by Chrome."
                ));
            }

            // ── Set up MediaRecorder ─────────────────────────────────────
            let recorder;
            try {
                recorder = new MediaRecorder(stream, {
                    mimeType,
                    videoBitsPerSecond: targetBps,
                    audioBitsPerSecond: 128000,
                });
            } catch (err) {
                cleanup();
                return reject(new Error(
                    "MediaRecorder setup failed: " + err.message
                ));
            }

            const chunks = [];

            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) chunks.push(e.data);
            };

            recorder.onstop = async () => {
                cleanup();

                const compressedBlob = new Blob(chunks, { type: mimeType });
                const compressedSize = compressedBlob.size;

                // Get metadata of compressed output for dimension/duration check
                let compressedMeta = { duration, width, height }; // fallback
                try {
                    compressedMeta = await getVideoMetadata(compressedBlob);
                } catch (_) { /* non-critical */ }

                if (onLog) {
                    onLog(
                        "Done. " +
                        videoFormatBytes(originalSize) + " → " +
                        videoFormatBytes(compressedSize)
                    );
                }

                resolve({
                    type:                "lossy",
                    format:              "VP9 / WebM (MediaRecorder)",
                    compressedBlob,
                    originalSize,
                    compressedSize,
                    originalSizeHR:      videoFormatBytes(originalSize),
                    compressedSizeHR:    videoFormatBytes(compressedSize),
                    ratio:               videoCompressionRatio(originalSize, compressedSize),
                    savings:             videoSpaceSavings(originalSize, compressedSize),
                    originalBitrate:     videoComputeBitrate(originalSize, duration),
                    compressedBitrate:   videoComputeBitrate(compressedSize, compressedMeta.duration || duration),
                    originalDuration:    duration.toFixed(1) + "s",
                    compressedDuration:  (compressedMeta.duration || duration).toFixed(1) + "s",
                    originalDimensions:  width + " × " + height + " px",
                    compressedDimensions:compressedMeta.width + " × " + compressedMeta.height + " px",
                    crfUsed:             crf,
                    originalDurationRaw: duration,
                });
            };

            recorder.onerror = (e) => {
                cleanup();
                reject(new Error("MediaRecorder error during encoding: " + (e.error ? e.error.message : "unknown")));
            };

            // ── Track progress via video currentTime ─────────────────────
            videoEl.ontimeupdate = () => {
                if (duration > 0 && onProgress) {
                    onProgress(videoEl.currentTime / duration);
                }
            };

            // ── Stop recorder when video ends ────────────────────────────
            videoEl.onended = () => {
                if (recorder.state !== "inactive") recorder.stop();
            };

            // ── Start encoding ───────────────────────────────────────────
            recorder.start(500); // collect data every 500ms
            videoEl.play().catch((err) => {
                cleanup();
                reject(new Error("Video playback failed: " + err.message));
            });
        };

        // ── Cleanup helper: remove hidden video element and free URL ────
        function cleanup() {
            URL.revokeObjectURL(objectUrl);
            if (videoEl.parentNode) document.body.removeChild(videoEl);
        }
    });
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — LOSSLESS COMPRESSION: GZIP via pako
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a video file losslessly by wrapping it in a GZIP archive.
 * Uses pako (already loaded globally via CDN — no new library needed).
 *
 * Every byte of the original .mp4 is preserved. SHA-256 of the original
 * is stored so decompressVideoLossless() can confirm a perfect rebuild.
 *
 * Space savings on MP4 are modest (5–25%) because H.264-encoded video
 * data already has low entropy. This is documented in PDF §4.4.
 *
 * @param {File}          videoFile
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 *
 * @returns {Promise<{
 *   type:                string,
 *   format:              string,
 *   compressedBlob:      Blob,
 *   compressedHash:      string,   SHA-256 of the ORIGINAL — used for rebuild verification
 *   originalSize:        number,
 *   compressedSize:      number,
 *   originalSizeHR:      string,
 *   compressedSizeHR:    string,
 *   ratio:               string,
 *   savings:             string,
 *   originalMetadata:    {duration, width, height},
 *   integrityStatus:     string,
 * }>}
 */
async function compressVideoLossless(videoFile, onLog = null, onProgress = null) {

    // Guard: pako must be loaded
    if (typeof pako === "undefined") {
        throw new Error(
            "pako is not loaded. Ensure pako.min.js is included before videocompression.js."
        );
    }

    if (onLog) onLog("Reading video file…");

    const originalBuffer  = await videoFile.arrayBuffer();
    const originalSize    = videoFile.size;

    if (onProgress) onProgress(0.1);

    // Get metadata for the result object (popup.js stores it in session)
    const originalMetadata = await getVideoMetadata(videoFile);

    if (onLog) onLog("Computing SHA-256 of original…");
    if (onProgress) onProgress(0.2);

    // Compute SHA-256 of the ORIGINAL file — verified on decompression
    const originalHash = await videoComputeSHA256(originalBuffer);

    if (onLog) onLog("Compressing with GZIP (pako)…");
    if (onProgress) onProgress(0.3);

    // GZIP compress at level 6 (good balance of speed vs size)
    const inputBytes       = new Uint8Array(originalBuffer);
    const compressedBytes  = pako.gzip(inputBytes, { level: 6 });
    const compressedBlob   = new Blob([compressedBytes], { type: "application/gzip" });
    const compressedSize   = compressedBlob.size;

    if (onProgress) onProgress(1.0);
    if (onLog) {
        onLog(
            "Done. " +
            videoFormatBytes(originalSize) + " → " +
            videoFormatBytes(compressedSize)
        );
    }

    return {
        type:                "lossless",
        format:              "GZIP / pako (lossless)",
        compressedBlob,
        compressedHash:      originalHash,   // SHA-256 of ORIGINAL for rebuild check
        originalSize,
        compressedSize,
        originalSizeHR:      videoFormatBytes(originalSize),
        compressedSizeHR:    videoFormatBytes(compressedSize),
        ratio:               videoCompressionRatio(originalSize, compressedSize),
        savings:             videoSpaceSavings(originalSize, compressedSize),
        originalMetadata,
        integrityStatus:     "✅ SHA-256 stored — verify rebuild by re-uploading the .mp4.gz",
    };
}