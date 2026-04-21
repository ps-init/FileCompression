/**
 * videoCompression.js
 *
 * Handles lossy video compression using the browser's built-in
 * MediaRecorder API — no ffmpeg.wasm, no external libraries, no
 * SharedArrayBuffer required.
 *
 * Strategy:
 *   1. Draw video frames onto a canvas element in real time.
 *   2. Capture the canvas stream with MediaRecorder at a controlled bitrate.
 *   3. Collect the recorded chunks into a WebM Blob.
 *
 * Quality control: videoBitsPerSecond maps to the CRF slider in the UI.
 *   CRF 0  → 8,000,000 bps (8 Mbps — highest quality)
 *   CRF 23 → 1,500,000 bps (1.5 Mbps — default balance)
 *   CRF 51 →   200,000 bps (0.2 Mbps — smallest file)
 *
 * PDF references: Section 4.4, 6.1, 6.2, 6.3
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — VIDEO METADATA
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads duration, width, and height from a video file via HTML5 video element.
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
        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not read video metadata."));
        };
        video.src = url;
    });
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — CRF TO BITRATE MAPPING
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Converts CRF (0-51) to target bitrate in bps using exponential curve.
 * @param {number} crf
 * @returns {number}
 */
function crfToBitrate(crf) {
    const MAX_BPS = 8000000;
    const MIN_BPS =  200000;
    const t = crf / 51;
    return Math.round(MAX_BPS * Math.pow(MIN_BPS / MAX_BPS, t));
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION METRICS
   ───────────────────────────────────────────────────────────────────────────── */

function computeCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return "∞:1";
    return (originalSize / compressedSize).toFixed(2) + ":1";
}
function computeSpaceSavings(originalSize, compressedSize) {
    return (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) + "%";
}
function computeBitrate(fileSizeBytes, durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0) return "N/A";
    return ((fileSizeBytes * 8) / (durationSeconds * 1000)).toFixed(0) + " kbps";
}
async function computeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}
function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds)) return "Unknown";
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — MEDIARECORDER CORE
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Plays a video into a hidden canvas and records it via MediaRecorder.
 * @param {File} videoFile
 * @param {{duration, width, height}} meta
 * @param {number} targetBitrate - bps
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Blob>}
 */
function _recordVideoToBlob(videoFile, meta, targetBitrate, onLog, onProgress) {
    return new Promise((resolve, reject) => {
        const video         = document.createElement("video");
        video.muted         = true;
        video.style.display = "none";
        document.body.appendChild(video);

        const canvas  = document.createElement("canvas");
        canvas.width  = meta.width  || 640;
        canvas.height = meta.height || 360;
        const ctx     = canvas.getContext("2d");

        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
            ? "video/webm;codecs=vp9"
            : "video/webm";

        const stream   = canvas.captureStream(30);
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: targetBitrate });
        const chunks   = [];

        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        let rafId;
        const cleanup = () => {
            cancelAnimationFrame(rafId);
            if (document.body.contains(video)) document.body.removeChild(video);
        };

        recorder.onstop = () => {
            cleanup();
            resolve(new Blob(chunks, { type: mimeType }));
        };

        recorder.onerror = (e) => {
            cleanup();
            reject(new Error("MediaRecorder error: " + (e.error || e)));
        };

        const timeout = setTimeout(() => {
            cleanup();
            try { recorder.stop(); } catch (_) {}
            reject(new Error("Video compression timed out after 10 minutes."));
        }, 600000);

        // Override onstop to also clear timeout
        const origStop  = recorder.onstop;
        recorder.onstop = () => { clearTimeout(timeout); origStop(); };

        video.onloadedmetadata = () => {
            recorder.start(100);
            video.play().catch(reject);
            if (onLog) onLog("Recording started at " + (targetBitrate / 1000).toFixed(0) + " kbps...");
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
            setTimeout(() => { try { recorder.stop(); } catch (_) {} }, 300);
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
   SECTION 5 — PUBLIC COMPRESSION FUNCTIONS
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Lossy video compression via MediaRecorder at CRF-mapped bitrate.
 * @param {File} videoFile
 * @param {number} crf - 0-51
 * @param {string} preset - ignored, kept for API compatibility
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossy(videoFile, crf = 23, preset = "ultrafast", onLog = null, onProgress = null) {
    crf = Math.max(0, Math.min(51, Math.round(crf)));
    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);
    const targetBitrate    = crfToBitrate(crf);

    if (onLog) onLog("CRF " + crf + " → " + (targetBitrate / 1000).toFixed(0) + " kbps");

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

/**
 * Near-lossless video compression at maximum bitrate (8 Mbps).
 * @param {File} videoFile
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossless(videoFile, onLog = null, onProgress = null) {
    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    const compressedBlob = await _recordVideoToBlob(videoFile, originalMetadata, 8000000, onLog, onProgress);
    const compressedSize = compressedBlob.size;
    const compressedMeta = await getVideoMetadata(compressedBlob);

    const compressedBuffer = await compressedBlob.arrayBuffer();
    const compressedHash   = await computeSHA256(compressedBuffer);
    const durationMatches  = Math.abs(originalMetadata.duration - compressedMeta.duration) < 1.0;
    const dimensionsMatch  = originalMetadata.width === compressedMeta.width &&
                             originalMetadata.height === compressedMeta.height;

    return {
        type:                "lossless",
        format:              "WebM high-bitrate (MediaRecorder)",
        compressedBlob,
        originalSize,
        compressedSize,
        originalSizeHR:      formatBytes(originalSize),
        compressedSizeHR:    formatBytes(compressedSize),
        ratio:               computeCompressionRatio(originalSize, compressedSize),
        savings:             computeSpaceSavings(originalSize, compressedSize),
        compressedHash,
        originalDuration:    formatDuration(originalMetadata.duration),
        compressedDuration:  formatDuration(compressedMeta.duration),
        durationMatches,
        dimensionsMatch,
        integrityVerified:   durationMatches && dimensionsMatch,
        integrityStatus:     (durationMatches && dimensionsMatch)
            ? "✅ Duration and dimensions verified"
            : "⚠️ Metadata mismatch",
        originalMetadata,
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — DECOMPRESSION / VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a lossless video by SHA-256 hash comparison.
 * @param {File}   reuploadedFile
 * @param {string} storedHash
 * @param {Object} originalMetadata
 * @param {number} originalSize
 * @param {string} originalName
 * @returns {Promise<Object>}
 */
async function decompressVideoLossless(reuploadedFile, storedHash, originalMetadata, originalSize, originalName = "video") {
    const fileBuffer  = await reuploadedFile.arrayBuffer();
    const rebuiltHash = await computeSHA256(fileBuffer);
    const hashMatch   = rebuiltHash === storedHash;
    const rebuiltMeta = await getVideoMetadata(reuploadedFile);

    const durationMatches = originalMetadata
        ? Math.abs((originalMetadata.duration || 0) - rebuiltMeta.duration) < 1.0 : true;
    const dimensionsMatch = originalMetadata
        ? (originalMetadata.width === rebuiltMeta.width && originalMetadata.height === rebuiltMeta.height) : true;

    const baseName = originalName.replace(/\.[^.]+$/, "");
    return {
        rebuiltHash, storedHash, hashMatch,
        checks: [
            (hashMatch       ? "✅" : "❌") + " SHA-256 hash "  + (hashMatch       ? "matches"  : "mismatch"),
            (durationMatches ? "✅" : "⚠️") + " Duration: "     + formatDuration(rebuiltMeta.duration),
            (dimensionsMatch ? "✅" : "⚠️") + " Dimensions: "   + rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        ],
        status:       hashMatch ? "✅ Hash match — file intact." : "❌ Hash mismatch.",
        downloadBlob: new Blob([fileBuffer], { type: reuploadedFile.type }),
        downloadName: baseName + "_verified.webm",
    };
}

/**
 * Verifies a lossy video by bitrate comparison.
 * @param {File}   reuploadedFile
 * @param {number} originalSize
 * @param {number} originalDurationSec
 * @param {number} crfUsed
 * @param {string} originalName
 * @returns {Promise<Object>}
 */
async function decompressVideoLossy(reuploadedFile, originalSize, originalDurationSec, crfUsed, originalName = "video") {
    const rebuiltMeta        = await getVideoMetadata(reuploadedFile);
    const rebuiltSize        = reuploadedFile.size;
    const origBps            = (originalSize * 8) / (originalDurationSec * 1000);
    const rebuiltBps         = (rebuiltSize  * 8) / ((rebuiltMeta.duration || originalDurationSec) * 1000);
    const reductionPct       = (((origBps - rebuiltBps) / origBps) * 100).toFixed(2);
    const bitrateRating      = rebuiltBps > 2000 ? "Excellent" :
                               rebuiltBps > 1000 ? "Good"      :
                               rebuiltBps > 500  ? "Acceptable": "Heavily Compressed";
    const baseName = originalName.replace(/\.[^.]+$/, "");
    return {
        originalBitrate:  origBps.toFixed(0)    + " kbps",
        rebuiltBitrate:   rebuiltBps.toFixed(0) + " kbps",
        bitrateReduction: reductionPct + "%",
        bitrateRating,
        ratio:            computeCompressionRatio(originalSize, rebuiltSize),
        savings:          computeSpaceSavings(originalSize, rebuiltSize),
        rebuiltDuration:  formatDuration(rebuiltMeta.duration),
        rebuiltDimensions:rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        downloadBlob:     reuploadedFile,
        downloadName:     baseName + "_decompressed.webm",
    };
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