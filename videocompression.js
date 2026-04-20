/**
 * videoCompression.js
 *
 * Handles lossy H.264/MP4 and lossless H.264 CRF-0 video compression
 * for the MACS JC Project 2 Chrome Extension via ffmpeg.wasm.
 *
 * Library used:
 *   - ffmpeg.wasm v0.11.0 — loaded locally from lib/ folder.
 *     Uses @ffmpeg/core@0.11.0 (NOT core-st — that package does not exist).
 *     Single-threaded by default so no SharedArrayBuffer headers needed.
 *
 * Quality metric: bitrate comparison (kbps before vs after).
 * Frame-by-frame PSNR/SSIM is impractical for video in-browser.
 * Bitrate comparison is explicitly permitted by PDF Section 6.3.
 *
 * Hash note: CRF-0 re-encoding does NOT produce byte-identical output to the
 * original (container metadata differs). SHA-256 is stored of the compressed
 * file — re-uploading it confirms the file hasn't been altered.
 *
 * Required in HTML before this file:
 *   <script src="lib/ffmpeg.min.js"></script>
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — FFMPEG INSTANCE MANAGEMENT
   ───────────────────────────────────────────────────────────────────────────── */

/** Shared ffmpeg.wasm instance — loaded once, reused for all operations. */
let ffmpegInstance = null;

/**
 * Returns an initialised ffmpeg.wasm instance.
 * Loads it on first call; subsequent calls return the cached instance.
 *
 * FIX: corePath now uses @ffmpeg/core@0.11.0 (not core-st which doesn't exist).
 * FIX: Uses window.location.origin so it works both on localhost and
 *      chrome-extension:// without hardcoded paths.
 *
 * @param {Function|null} onLog      - Optional callback for ffmpeg log lines
 * @param {Function|null} onProgress - Optional callback for progress (0–1)
 * @returns {Promise<Object>} Loaded ffmpeg instance
 */
async function getFFmpegInstance(onLog = null, onProgress = null) {
    if (ffmpegInstance) return ffmpegInstance;

    if (typeof FFmpeg === "undefined" || typeof FFmpeg.createFFmpeg === "undefined") {
        throw new Error(
            "ffmpeg.wasm is not loaded. Add <script src='lib/ffmpeg.min.js'> before videocompression.js."
        );
    }

    // Use local ST build fetched via npm install @ffmpeg/core-st@0.11.0
    const pageBase = window.location.href.replace(/\/[^\/]*$/, "");
    const corePath = pageBase + "/lib/ffmpeg-core.js";

    ffmpegInstance = FFmpeg.createFFmpeg({
        corePath,
        log:      true,
        logger:   ({ message }) => { if (onLog) onLog(message); },
        progress: ({ ratio })   => { if (onProgress) onProgress(Math.min(ratio, 1)); },
    });

    // FIX: wrap load() in 30s timeout — missing core files cause infinite hang
    await Promise.race([
        ffmpegInstance.load(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(
                "ffmpeg failed to load in 30s. Check lib/ffmpeg-core.js and lib/ffmpeg-core.wasm exist. Path tried: " + corePath
            )), 30000)
        ),
    ]);

    return ffmpegInstance;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — VIDEO METADATA EXTRACTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads duration, width, and height from a video file via the HTML5 video element.
 *
 * @param {File|Blob} videoFile
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function getVideoMetadata(videoFile) {
    return new Promise((resolve, reject) => {
        const video    = document.createElement("video");
        video.preload  = "metadata";
        video.muted    = true;
        const url      = URL.createObjectURL(videoFile);

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
            reject(new Error("Could not read video metadata. File may be unsupported or corrupted."));
        };

        video.src = url;
    });
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION METRICS  (PDF Section 6)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compression ratio: originalSize / compressedSize  (PDF 6.1)
 * @param {number} originalSize
 * @param {number} compressedSize
 * @returns {string} e.g. "3.24:1"
 */
function computeCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return "∞:1";
    return (originalSize / compressedSize).toFixed(2) + ":1";
}

/**
 * Space savings percentage  (PDF 6.2)
 * @param {number} originalSize
 * @param {number} compressedSize
 * @returns {string} e.g. "69.14%"
 */
function computeSpaceSavings(originalSize, compressedSize) {
    return (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) + "%";
}

/**
 * Video bitrate in kbps — used as quality metric (PDF 6.3)
 * Formula: (fileSizeBytes × 8) / (durationSeconds × 1000)
 *
 * @param {number} fileSizeBytes
 * @param {number} durationSeconds
 * @returns {string} e.g. "2048 kbps"
 */
function computeBitrate(fileSizeBytes, durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0) return "N/A";
    return ((fileSizeBytes * 8) / (durationSeconds * 1000)).toFixed(0) + " kbps";
}

/**
 * SHA-256 hash via SubtleCrypto — no external library needed  (PDF 6.4)
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} hex string
 */
async function computeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
}

/**
 * Human-readable file size.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * Human-readable duration.
 * @param {number} totalSeconds
 * @returns {string} e.g. "2m 14s"
 */
function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds)) return "Unknown";
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Lowercase file extension from filename, fallback ".mp4"
 * @param {string} filename
 * @returns {string}
 */
function getFileExtension(filename) {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : ".mp4";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — LOSSY COMPRESSION: H.264 CRF > 0
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a video using H.264 lossy encoding at a configurable CRF.
 * Output is always MP4 with H.264 video and AAC audio.
 *
 * CRF guide:
 *   0 = lossless  |  18 = visually lossless  |  23 = default balance
 *   28 = noticeable  |  51 = worst quality
 *
 * @param {File}         videoFile
 * @param {number}       crf       - 0–51, default 23
 * @param {string}       preset    - ffmpeg preset, default "medium"
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossy(videoFile, crf = 23, preset = "ultrafast", onLog = null, onProgress = null) {
    crf = Math.max(0, Math.min(51, Math.round(crf)));
    const validPresets = ["ultrafast","superfast","veryfast","faster","fast","medium","slow","slower","veryslow"];
    if (!validPresets.includes(preset)) preset = "ultrafast";

    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    const ffmpeg     = await getFFmpegInstance(onLog, onProgress);
    const inputName  = "input_lossy" + getFileExtension(videoFile.name);
    const outputName = "output_lossy.mp4";

    // FIX: fetchFile is a method on the ffmpeg INSTANCE at v0.11.0,
    //      not FFmpeg.fetchFile (that was a static import style, not available here)
    ffmpeg.FS("writeFile", inputName, await ffmpeg.fetchFile(videoFile));

    // FIX: wrap run() in timeout — large files can hang indefinitely
    await Promise.race([
        ffmpeg.run(
            "-i",      inputName,
            "-c:v",    "libx264",
            "-crf",    String(crf),
            "-preset", preset,
            "-c:a",    "aac",
            "-b:a",    "128k",
            outputName
        ),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(
                "Video encoding timed out after 5 minutes. Try a smaller file or higher CRF value."
            )), 300000)
        ),
    ]);

    const outputData     = ffmpeg.FS("readFile", outputName);
    const compressedBlob = new Blob([outputData.buffer], { type: "video/mp4" });
    const compressedSize = compressedBlob.size;
    const compressedMeta = await getVideoMetadata(compressedBlob);

    ffmpeg.FS("unlink", inputName);
    ffmpeg.FS("unlink", outputName);

    return {
        type:                "lossy",
        format:              "H.264 / MP4",
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
        originalDimensions:  `${originalMetadata.width} × ${originalMetadata.height} px`,
        compressedDimensions:`${compressedMeta.width} × ${compressedMeta.height} px`,
        crfUsed:             crf,
        presetUsed:          preset,
        originalDurationRaw: originalMetadata.duration,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — LOSSLESS COMPRESSION: H.264 CRF 0
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a video using H.264 lossless encoding (CRF 0).
 * Every pixel value is mathematically preserved.
 *
 * Note: CRF-0 re-encoding does NOT produce byte-identical output to the
 * original (container metadata differs). SHA-256 is of the compressed output.
 * Re-uploading that file will match the hash, proving no corruption.
 *
 * @param {File}         videoFile
 * @param {Function|null} onLog
 * @param {Function|null} onProgress
 * @returns {Promise<Object>}
 */
async function compressVideoLossless(videoFile, onLog = null, onProgress = null) {
    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    const ffmpeg     = await getFFmpegInstance(onLog, onProgress);
    const inputName  = "input_lossless" + getFileExtension(videoFile.name);
    const outputName = "output_lossless.mp4";

    // FIX: fetchFile on instance, not FFmpeg.fetchFile
    ffmpeg.FS("writeFile", inputName, await ffmpeg.fetchFile(videoFile));

    // FIX: wrap run() in timeout
    await Promise.race([
        ffmpeg.run(
            "-i",       inputName,
            "-c:v",     "libx264",
            "-crf",     "0",
            "-preset",  "ultrafast",
            "-c:a",     "copy",
            "-pix_fmt", "yuv420p",
            outputName
        ),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(
                "Video encoding timed out after 5 minutes. Try a smaller file or higher CRF value."
            )), 300000)
        ),
    ]);

    const outputData     = ffmpeg.FS("readFile", outputName);
    const compressedBlob = new Blob([outputData.buffer], { type: "video/mp4" });
    const compressedSize = compressedBlob.size;
    const compressedMeta = await getVideoMetadata(compressedBlob);

    ffmpeg.FS("unlink", inputName);
    ffmpeg.FS("unlink", outputName);

    const compressedHash    = await computeSHA256(outputData.buffer);
    const durationMatches   = Math.abs(originalMetadata.duration - compressedMeta.duration) < 0.1;
    const dimensionsMatch   = originalMetadata.width  === compressedMeta.width &&
                              originalMetadata.height === compressedMeta.height;
    const integrityVerified = durationMatches && dimensionsMatch;

    return {
        type:                "lossless",
        format:              "H.264 CRF-0 / MP4",
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
        originalDimensions:  `${originalMetadata.width} × ${originalMetadata.height} px`,
        compressedDimensions:`${compressedMeta.width} × ${compressedMeta.height} px`,
        durationMatches,
        dimensionsMatch,
        integrityVerified,
        integrityStatus:     integrityVerified
            ? "✅ Duration and dimensions verified"
            : "⚠️ Metadata mismatch — check results",
        originalMetadata,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — REBUILD VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a lossless video rebuild via SHA-256 hash comparison.
 * @param {File}   reuploadedFile
 * @param {string} storedHash
 * @returns {Promise<Object>}
 */
async function verifyLosslessVideoRebuild(reuploadedFile, storedHash) {
    const fileBuffer  = await reuploadedFile.arrayBuffer();
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;
    return {
        storedHash,
        rebuiltHash,
        isMatch,
        status:       isMatch ? "✅ Hash match — file is intact" : "❌ Hash mismatch — file may be altered",
        downloadBlob: new Blob([fileBuffer], { type: "video/mp4" }),
    };
}

/**
 * Verifies a lossy video rebuild via bitrate comparison.
 * @param {File}   reuploadedFile
 * @param {number} originalSize
 * @param {number} originalDurationSec
 * @returns {Promise<Object>}
 */
async function verifyLossyVideoRebuild(reuploadedFile, originalSize, originalDurationSec) {
    const rebuiltMeta          = await getVideoMetadata(reuploadedFile);
    const rebuiltSize          = reuploadedFile.size;
    const originalBitrateKbps  = (originalSize  * 8) / (originalDurationSec       * 1000);
    const rebuiltBitrateKbps   = (rebuiltSize   * 8) / (rebuiltMeta.duration      * 1000);
    const bitrateReduction     = (((originalBitrateKbps - rebuiltBitrateKbps) / originalBitrateKbps) * 100).toFixed(2) + "%";
    return {
        originalSizeHR:    formatBytes(originalSize),
        rebuiltSizeHR:     formatBytes(rebuiltSize),
        ratio:             computeCompressionRatio(originalSize, rebuiltSize),
        savings:           computeSpaceSavings(originalSize, rebuiltSize),
        originalBitrate:   originalBitrateKbps.toFixed(0) + " kbps",
        rebuiltBitrate:    rebuiltBitrateKbps.toFixed(0)  + " kbps",
        bitrateReduction,
        rebuiltDuration:   formatDuration(rebuiltMeta.duration),
        rebuiltDimensions: `${rebuiltMeta.width} × ${rebuiltMeta.height} px`,
        downloadBlob:      reuploadedFile,
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