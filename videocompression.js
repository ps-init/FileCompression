/**
 * videoCompression.js
 *
 * Handles lossy H.264/MP4 and lossless H.264 CRF-0 video compression
 * for the MACS JC Project 2 Chrome Extension via ffmpeg.wasm.
 *
 * Library used:
 *   - ffmpeg.wasm v0.11 (loaded from CDN in HTML, no manual download needed)
 *     Uses the single-threaded core (@ffmpeg/core-st) which works without
 *     SharedArrayBuffer, so no special HTTP headers are required.
 *
 * Quality metric: bitrate comparison (kbps before vs after).
 * Frame-by-frame PSNR/SSIM for video would require decoding every frame
 * in the browser, which is impractical. Bitrate comparison is explicitly
 * permitted by PDF Section 6.3.
 *
 * Hash note: CRF-0 re-encoding does NOT produce byte-identical output to the
 * original (container metadata differs). The SHA-256 stored is of the compressed
 * file itself — re-uploading that exact file confirms it hasn't been altered.
 *
 * Required script in HTML before this file:
 *   <script src="https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js"></script>
 */


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — FFMPEG INSTANCE MANAGEMENT
   ───────────────────────────────────────────────────────────────────────────── */

/** Shared ffmpeg.wasm instance — only loaded once to avoid re-downloading the core. */
let ffmpegInstance = null;

/**
 * Returns an initialised ffmpeg.wasm instance, loading it if not yet ready.
 * Safe to call multiple times — skips loading if already done.
 *
 * @param {Function|null} onLog      - Optional callback receiving ffmpeg log strings
 * @param {Function|null} onProgress - Optional callback receiving progress ratio (0–1)
 * @returns {Promise<Object>} Loaded ffmpeg instance
 */
async function getFFmpegInstance(onLog = null, onProgress = null) {
    if (ffmpegInstance) return ffmpegInstance;

    if (typeof FFmpeg === "undefined" || typeof FFmpeg.createFFmpeg === "undefined") {
        throw new Error(
            "ffmpeg.wasm is not loaded. Add this script tag before videoCompression.js:\n" +
            '<script src="https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js"></script>'
        );
    }

    ffmpegInstance = FFmpeg.createFFmpeg({
        corePath: "https://unpkg.com/@ffmpeg/core-st@0.11.0/dist/ffmpeg-core.js",
        log:      true,
        logger:   ({ message }) => { if (onLog) onLog(message); },
        progress: ({ ratio })   => { if (onProgress) onProgress(Math.min(ratio, 1)); },
    });

    await ffmpegInstance.load();
    return ffmpegInstance;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — VIDEO METADATA EXTRACTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads duration, width, and height from a video file using the HTML5 video element.
 * Used for bitrate calculation and lossless rebuild verification.
 *
 * @param {File|Blob} videoFile - A video file or blob
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function getVideoMetadata(videoFile) {
    return new Promise((resolve, reject) => {
        const videoElement     = document.createElement("video");
        videoElement.preload   = "metadata";
        videoElement.muted     = true;
        const objectURL        = URL.createObjectURL(videoFile);

        videoElement.onloadedmetadata = () => {
            URL.revokeObjectURL(objectURL);
            resolve({
                duration: videoElement.duration,
                width:    videoElement.videoWidth,
                height:   videoElement.videoHeight,
            });
        };

        videoElement.onerror = () => {
            URL.revokeObjectURL(objectURL);
            reject(new Error("Could not read video metadata. File may be unsupported or corrupted."));
        };

        videoElement.src = objectURL;
    });
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION METRICS  (PDF Section 6)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Computes compression ratio (PDF Section 6.1).
 *
 * @param {number} originalSize   - Original size in bytes
 * @param {number} compressedSize - Compressed size in bytes
 * @returns {string} e.g. "3.24:1"
 */
function computeCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return "∞:1";
    return (originalSize / compressedSize).toFixed(2) + ":1";
}

/**
 * Computes space savings percentage (PDF Section 6.2).
 *
 * @param {number} originalSize   - Original size in bytes
 * @param {number} compressedSize - Compressed size in bytes
 * @returns {string} e.g. "69.14%"
 */
function computeSpaceSavings(originalSize, compressedSize) {
    return (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) + "%";
}

/**
 * Computes video bitrate in kbps.
 * Used as the quality metric for video per PDF Section 6.3:
 * "PSNR, SSIM, or a bit-rate comparison".
 *
 * Formula: (fileSizeBytes × 8) / (durationSeconds × 1000)
 *
 * @param {number} fileSizeBytes   - File size in bytes
 * @param {number} durationSeconds - Video duration in seconds
 * @returns {string} e.g. "2048 kbps"
 */
function computeBitrate(fileSizeBytes, durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0) return "N/A";
    const kbps = (fileSizeBytes * 8) / (durationSeconds * 1000);
    return kbps.toFixed(0) + " kbps";
}

/**
 * Computes SHA-256 hash of an ArrayBuffer using the built-in SubtleCrypto API.
 * No external library required (PDF Section 6.4).
 *
 * @param {ArrayBuffer} buffer - Raw bytes to hash
 * @returns {Promise<string>} Lowercase hex-encoded SHA-256 string
 */
async function computeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashBytes  = Array.from(new Uint8Array(hashBuffer));
    return hashBytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Formats a byte count to a human-readable string.
 *
 * @param {number} bytes - Size in bytes
 * @returns {string} e.g. "14.32 MB"
 */
function formatBytes(bytes) {
    if (bytes < 1024)                return bytes + " B";
    if (bytes < 1024 * 1024)         return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * Formats a duration in seconds to a readable string.
 *
 * @param {number} totalSeconds - Duration in seconds
 * @returns {string} e.g. "2m 14s" or "38s"
 */
function formatDuration(totalSeconds) {
    if (!isFinite(totalSeconds)) return "Unknown";
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Extracts the lowercase file extension including the dot from a filename.
 * Falls back to ".mp4" if no extension is found.
 *
 * @param {string} filename - e.g. "clip.mov"
 * @returns {string} e.g. ".mov"
 */
function getFileExtension(filename) {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0].toLowerCase() : ".mp4";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — LOSSY COMPRESSION: H.264 with configurable CRF
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a video using H.264 lossy encoding at a given CRF level.
 * Output is always an MP4 file with H.264 video and AAC audio.
 *
 * CRF (Constant Rate Factor) controls the quality vs file size trade-off:
 *   0   = lossless (use compressVideoLossless instead)
 *   18  = visually lossless — barely distinguishable from original
 *   23  = ffmpeg default — good balance
 *   28  = noticeable compression, significantly smaller
 *   51  = worst quality
 *
 * Preset controls encoding speed vs compression efficiency:
 *   ultrafast → veryslow (faster = larger file; slower = smaller file)
 *   "medium" is the best balance for this project.
 *
 * @param {File} videoFile        - Input video (MP4, WebM, MOV, AVI, MKV)
 * @param {number} crf            - Quality level 0–51. Default: 23
 * @param {string} preset         - Encoding preset. Default: "medium"
 * @param {Function|null} onLog   - Optional log callback
 * @param {Function|null} onProgress - Optional progress callback (0–1)
 * @returns {Promise<Object>} Compression result with metrics and compressed blob
 */
async function compressVideoLossy(videoFile, crf = 23, preset = "medium", onLog = null, onProgress = null) {
    crf = Math.max(0, Math.min(51, Math.round(crf)));

    const validPresets = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
    if (!validPresets.includes(preset)) preset = "medium";

    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    const ffmpeg    = await getFFmpegInstance(onLog, onProgress);
    const inputName = "input_lossy" + getFileExtension(videoFile.name);
    const outputName = "output_lossy.mp4";

    ffmpeg.FS("writeFile", inputName, await FFmpeg.fetchFile(videoFile));

    await ffmpeg.run(
        "-i",        inputName,
        "-c:v",      "libx264",
        "-crf",      String(crf),
        "-preset",   preset,
        "-c:a",      "aac",
        "-b:a",      "128k",
        outputName
    );

    const outputData      = ffmpeg.FS("readFile", outputName);
    const compressedBlob  = new Blob([outputData.buffer], { type: "video/mp4" });
    const compressedSize  = compressedBlob.size;
    const compressedMeta  = await getVideoMetadata(compressedBlob);

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
 * IMPORTANT — hash behaviour:
 * Re-encoding at CRF 0 does NOT produce byte-identical output to the original
 * because container metadata and encoder headers will differ. This is expected.
 * The SHA-256 stored here is of the compressed output file. Re-uploading that
 * exact file will match this hash, confirming it hasn't been corrupted.
 *
 * Integrity is also verified by checking that duration and dimensions are unchanged.
 *
 * @param {File} videoFile           - Input video
 * @param {Function|null} onLog      - Optional log callback
 * @param {Function|null} onProgress - Optional progress callback (0–1)
 * @returns {Promise<Object>} Compression result with hash and integrity status
 */
async function compressVideoLossless(videoFile, onLog = null, onProgress = null) {
    const originalSize     = videoFile.size;
    const originalMetadata = await getVideoMetadata(videoFile);

    const ffmpeg     = await getFFmpegInstance(onLog, onProgress);
    const inputName  = "input_lossless" + getFileExtension(videoFile.name);
    const outputName = "output_lossless.mp4";

    ffmpeg.FS("writeFile", inputName, await FFmpeg.fetchFile(videoFile));

    await ffmpeg.run(
        "-i",       inputName,
        "-c:v",     "libx264",
        "-crf",     "0",
        "-preset",  "ultrafast",
        "-c:a",     "copy",
        "-pix_fmt", "yuv420p",
        outputName
    );

    const outputData     = ffmpeg.FS("readFile", outputName);
    const compressedBlob = new Blob([outputData.buffer], { type: "video/mp4" });
    const compressedSize = compressedBlob.size;
    const compressedMeta = await getVideoMetadata(compressedBlob);

    ffmpeg.FS("unlink", inputName);
    ffmpeg.FS("unlink", outputName);

    const compressedHash = await computeSHA256(outputData.buffer);

    const durationMatches   = Math.abs(originalMetadata.duration - compressedMeta.duration) < 0.1;
    const dimensionsMatch   = originalMetadata.width === compressedMeta.width &&
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
 * Verifies a lossless video rebuild by comparing the SHA-256 of the
 * re-uploaded file against the hash stored at compression time.
 *
 * @param {File} reuploadedFile - The compressed video uploaded back by the user
 * @param {string} storedHash   - Hash from compressVideoLossless()
 * @returns {Promise<Object>} Verification result
 */
async function verifyLosslessVideoRebuild(reuploadedFile, storedHash) {
    const fileBuffer  = await reuploadedFile.arrayBuffer();
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;

    return {
        storedHash,
        rebuiltHash,
        isMatch,
        status: isMatch
            ? "✅ Hash match — compressed file is intact"
            : "❌ Hash mismatch — file may have been altered",
        downloadBlob: new Blob([fileBuffer], { type: "video/mp4" }),
    };
}

/**
 * Verifies a lossy video rebuild by computing bitrate before and after,
 * showing the bitrate reduction as the quality trade-off indicator.
 *
 * @param {File} reuploadedFile        - The compressed video uploaded back
 * @param {number} originalSize        - Original file size in bytes
 * @param {number} originalDurationSec - Original duration in seconds
 * @returns {Promise<Object>} Bitrate comparison result
 */
async function verifyLossyVideoRebuild(reuploadedFile, originalSize, originalDurationSec) {
    const rebuiltMetadata  = await getVideoMetadata(reuploadedFile);
    const rebuiltSize      = reuploadedFile.size;

    const originalBitrateKbps = (originalSize * 8) / (originalDurationSec * 1000);
    const rebuiltBitrateKbps  = (rebuiltSize  * 8) / (rebuiltMetadata.duration * 1000);
    const bitrateReduction    = (((originalBitrateKbps - rebuiltBitrateKbps) / originalBitrateKbps) * 100).toFixed(2) + "%";

    return {
        originalSizeHR:    formatBytes(originalSize),
        rebuiltSizeHR:     formatBytes(rebuiltSize),
        ratio:             computeCompressionRatio(originalSize, rebuiltSize),
        savings:           computeSpaceSavings(originalSize, rebuiltSize),
        originalBitrate:   originalBitrateKbps.toFixed(0) + " kbps",
        rebuiltBitrate:    rebuiltBitrateKbps.toFixed(0) + " kbps",
        bitrateReduction,
        rebuiltDuration:   formatDuration(rebuiltMetadata.duration),
        rebuiltDimensions: `${rebuiltMetadata.width} × ${rebuiltMetadata.height} px`,
        downloadBlob:      reuploadedFile,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 7 — DOWNLOAD UTILITY
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Triggers a browser download for a given Blob.
 *
 * @param {Blob} blob       - File data to download
 * @param {string} filename - Filename shown in the save dialog
 * @returns {void}
 */
function downloadBlob(blob, filename) {
    const objectURL = URL.createObjectURL(blob);
    const anchor    = document.createElement("a");
    anchor.href     = objectURL;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}