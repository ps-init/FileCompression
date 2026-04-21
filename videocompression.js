/**
 * videoCompression.js
 *
 * Two compression paths:
 *   LOSSLESS (CRF 0): pako GZIP on raw video bytes — true lossless, perfect rebuild.
 *   LOSSY  (CRF > 0): MediaRecorder canvas re-encode at CRF-mapped bitrate — no ffmpeg needed.
 *
 * No SharedArrayBuffer, no ffmpeg.wasm, no external libraries beyond pako (already loaded).
 * PDF references: Section 4.4, 6.1, 6.2, 6.3, 6.4
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — VIDEO METADATA
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads duration, width, height from a video file via HTML5 video element.
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
            resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
        };
        video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read video metadata.")); };
        video.src = url;
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — CRF TO BITRATE MAPPING (for lossy path)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Converts CRF (1–51) to a target bitrate in bps using exponential curve.
 * @param {number} crf
 * @returns {number} bps
 */
function crfToBitrate(crf) {
    const MAX_BPS = 8000000;
    const MIN_BPS =  200000;
    const t = Math.max(1, crf) / 51;
    return Math.round(MAX_BPS * Math.pow(MIN_BPS / MAX_BPS, t));
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — METRICS
   ───────────────────────────────────────────────────────────────────────────── */

function computeCompressionRatio(o, c) { return c === 0 ? "∞:1" : (o / c).toFixed(2) + ":1"; }
function computeSpaceSavings(o, c)     { return (((o - c) / o) * 100).toFixed(2) + "%"; }
function computeBitrate(bytes, dur)    { return (!dur || dur <= 0) ? "N/A" : ((bytes * 8) / (dur * 1000)).toFixed(0) + " kbps"; }

async function computeSHA256(buffer) {
    const h = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function formatBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(2) + " KB";
    if (b < 1073741824) return (b / 1048576).toFixed(2) + " MB";
    return (b / 1073741824).toFixed(2) + " GB";
}
function formatDuration(s) {
    if (!isFinite(s)) return "Unknown";
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}
function getFileExtension(filename) {
    const m = filename.match(/\.[^.]+$/);
    return m ? m[0].toLowerCase() : ".mp4";
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — LOSSLESS COMPRESSION (GZIP raw bytes)
   ─────────────────────────────────────────────────────────────────────────────
   The original video bytes are GZIPped with pako.
   Decompression recovers the exact original file — byte-for-byte identical.
   SHA-256 of the ORIGINAL is stored for verification.  (PDF §6.4)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Losslessly compresses a video by GZIPping its raw bytes via pako.
 * Decompression recovers the original file perfectly.
 *
 * @param {File}          videoFile
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossless(videoFile, onLog = null, onProgress = null) {
    if (typeof pako === "undefined") throw new Error("pako is not loaded.");

    const buffer       = await videoFile.arrayBuffer();
    const originalSize = videoFile.size;
    const originalHash = await computeSHA256(buffer);   // hash of ORIGINAL for rebuild check
    const originalMetadata = await getVideoMetadata(videoFile);

    if (onLog) onLog("GZIP compressing " + formatBytes(originalSize) + "...");
    if (onProgress) onProgress(0.1);

    const compressed     = pako.gzip(new Uint8Array(buffer), { level: 6 });
    const compressedBlob = new Blob([compressed], { type: "application/gzip" });
    const compressedSize = compressedBlob.size;

    if (onProgress) onProgress(1);
    if (onLog) onLog("Lossless GZIP complete: " + formatBytes(compressedSize));

    return {
        type:             "lossless",
        format:           "GZIP (pako)",
        compressedBlob,
        originalSize,
        compressedSize,
        originalSizeHR:   formatBytes(originalSize),
        compressedSizeHR: formatBytes(compressedSize),
        ratio:            computeCompressionRatio(originalSize, compressedSize),
        savings:          computeSpaceSavings(originalSize, compressedSize),
        compressedHash:   originalHash,   // SHA-256 of ORIGINAL for decompression verification
        originalMetadata,
        originalDuration: formatDuration(originalMetadata.duration),
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — LOSSY COMPRESSION (MediaRecorder canvas re-encode)
   ─────────────────────────────────────────────────────────────────────────────
   Video frames are drawn to a canvas and re-recorded via MediaRecorder at
   a lower bitrate. Audio is also captured and included in the WebM output.
   No ffmpeg.wasm, no SharedArrayBuffer needed.  (PDF §4.4, §6.3)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Lossy video compression via MediaRecorder at a CRF-mapped bitrate.
 * Output is WebM (VP9/VP8 + Opus audio).
 *
 * @param {File}          videoFile
 * @param {number}        crf       - 1–51 (0 is lossless path, handled separately)
 * @param {string}        preset    - ignored, kept for API compatibility
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossy(videoFile, crf = 23, preset = "ultrafast", onLog = null, onProgress = null) {
    crf = Math.max(1, Math.min(51, Math.round(crf)));

    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    // Cap bitrate so compressed output is always smaller than original
    const originalBitrateRaw = (originalSize * 8) / (originalMetadata.duration || 1);
    const targetBitrate      = Math.min(crfToBitrate(crf), Math.round(originalBitrateRaw * 0.85));

    if (onLog) onLog("CRF " + crf + " → target " + (targetBitrate / 1000).toFixed(0) + " kbps");

    const compressedBlob = await _recordVideoToBlob(videoFile, originalMetadata, targetBitrate, onLog, onProgress);
    const compressedSize = compressedBlob.size;
    const compressedMeta = await getVideoMetadata(compressedBlob);

    return {
        type:                "lossy",
        format:              "WebM (MediaRecorder)",
        compressedBlob,
        originalSize,
        compressedSize,
        originalSizeHR:      formatBytes(originalSize),
        compressedSizeHR:    formatBytes(compressedSize),
        ratio:               computeCompressionRatio(originalSize, compressedSize),
        savings:             computeSpaceSavings(originalSize, compressedSize),
        originalBitrate:     computeBitrate(originalSize, originalMetadata.duration),
        compressedBitrate:   computeBitrate(compressedSize, compressedMeta.duration),
        originalDuration:    formatDuration(originalMetadata.duration),
        compressedDuration:  formatDuration(compressedMeta.duration),
        originalDimensions:  originalMetadata.width + " × " + originalMetadata.height + " px",
        compressedDimensions:compressedMeta.width   + " × " + compressedMeta.height   + " px",
        crfUsed:             crf,
        presetUsed:          "MediaRecorder",
        originalDurationRaw: originalMetadata.duration,
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — MEDIARECORDER CORE (with audio capture)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Plays a video onto a canvas and records it via MediaRecorder.
 * Audio tracks from the video element are captured and included in output.
 *
 * @param {File}          videoFile
 * @param {{duration, width, height}} meta
 * @param {number}        targetBitrate - bps
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Blob>}
 */
function _recordVideoToBlob(videoFile, meta, targetBitrate, onLog, onProgress) {
    return new Promise((resolve, reject) => {
        const video         = document.createElement("video");
        video.muted         = true;   // mute PLAYBACK (no speakers), audio still captured via stream
        video.style.display = "none";
        document.body.appendChild(video);

        const canvas  = document.createElement("canvas");
        canvas.width  = meta.width  || 640;
        canvas.height = meta.height || 360;
        const ctx     = canvas.getContext("2d");

        // Pick best supported codec with audio (Opus)
        const mimeType =
            MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" :
            MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" :
            "video/webm";

        let recorder = null;
        const chunks = [];
        let rafId;

        const cleanup = () => {
            cancelAnimationFrame(rafId);
            if (document.body.contains(video)) document.body.removeChild(video);
        };

        const timeout = setTimeout(() => {
            cleanup();
            try { if (recorder) recorder.stop(); } catch (_) {}
            reject(new Error("Video compression timed out after 10 minutes."));
        }, 600000);

        video.onloadedmetadata = () => {
            // Build combined stream: canvas (video) + video element (audio)
            const canvasStream   = canvas.captureStream(30);
            const combinedStream = new MediaStream();

            // Add video track from canvas
            canvasStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));

            // Add audio track from video element (muted = playback only, stream still has audio)
            try {
                const vs = video.captureStream ? video.captureStream() :
                           video.mozCaptureStream ? video.mozCaptureStream() : null;
                if (vs) vs.getAudioTracks().forEach(t => { try { combinedStream.addTrack(t); } catch (_) {} });
            } catch (e) {
                if (onLog) onLog("Audio capture unavailable: " + e.message);
            }

            recorder = new MediaRecorder(combinedStream, {
                mimeType,
                videoBitsPerSecond: targetBitrate,
            });

            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

            recorder.onstop = () => {
                clearTimeout(timeout);
                cleanup();
                resolve(new Blob(chunks, { type: mimeType }));
            };

            recorder.onerror = (e) => {
                clearTimeout(timeout);
                cleanup();
                reject(new Error("MediaRecorder error: " + (e.error || e)));
            };

            recorder.start(100);
            video.play().catch(reject);
            if (onLog) onLog("Recording started at " + (targetBitrate / 1000).toFixed(0) + " kbps (audio+video)...");
        };

        const drawFrame = () => {
            if (video.paused || video.ended) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            if (onProgress && meta.duration > 0) onProgress(video.currentTime / meta.duration);
            rafId = requestAnimationFrame(drawFrame);
        };
        video.onplay = drawFrame;

        video.onended = () => {
            cancelAnimationFrame(rafId);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            setTimeout(() => { try { if (recorder) recorder.stop(); } catch (_) {} }, 300);
            if (onLog) onLog("Recording complete.");
        };

        video.onerror = () => {
            clearTimeout(timeout);
            cleanup();
            reject(new Error("Failed to load video for re-encoding."));
        };

        video.src = URL.createObjectURL(videoFile);
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 7 — DOWNLOAD UTILITY
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Triggers a browser file download for a Blob.
 * @param {Blob}   blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url    = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href     = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}