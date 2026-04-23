/**
 * videodecompression.js
 *
 * Video decompression and rebuild verification for the
 * MACS JC Project 2 Chrome Extension.
 *
 * Two decompression paths:
 *
 *   LOSSLESS (.mp4.gz — CRF 0 path):
 *     pako.ungzip() reverses the GZIP compression, recovering the exact
 *     original MP4 bytes. SHA-256 hash confirms byte-for-byte perfect rebuild.
 *     The decompressed .mp4 file is downloadable and playable.  (PDF §6.4)
 *
 *   LOSSY (.webm — MediaRecorder path):
 *     Re-encodes are irreversible — original MP4 data was permanently
 *     re-encoded. "Decompression" here means: decode the WebM and report
 *     bitrate quality metrics comparing original vs compressed.  (PDF §6.3)
 *     The .webm file itself is returned as the downloadable output.
 *
 * Dependency: pako (global, loaded in index.html)
 * PDF references: Section 4.4, 6.3, 6.4, 8.1
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SHARED UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Human-readable file size string.
 * @param {number} bytes
 * @returns {string}
 */
function videoDecompFormatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * Compression ratio string.  (PDF §6.1)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}
 */
function videoDecompCompressionRatio(original, compressed) {
    if (compressed === 0) return "∞:1";
    return (original / compressed).toFixed(2) + ":1";
}

/**
 * Space savings percentage string.  (PDF §6.2)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}
 */
function videoDecompSpaceSavings(original, compressed) {
    return (((original - compressed) / original) * 100).toFixed(2) + "%";
}

/**
 * SHA-256 hash via SubtleCrypto.  (PDF §6.4)
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function videoDecompComputeSHA256(buffer) {
    const h = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads duration, width, height from a video Blob/File via HTML5 video element.
 * @param {File|Blob} videoFile
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function videoDecompGetMetadata(videoFile) {
    return new Promise((resolve) => {
        const video   = document.createElement("video");
        video.preload = "metadata";
        video.muted   = true;
        const url     = URL.createObjectURL(videoFile);

        const timeout = setTimeout(() => {
            URL.revokeObjectURL(url);
            resolve({ duration: 0, width: 0, height: 0 });
        }, 8000);

        video.onloadedmetadata = () => {
            clearTimeout(timeout);
            URL.revokeObjectURL(url);
            resolve({
                duration: isFinite(video.duration) ? video.duration : 0,
                width:    video.videoWidth,
                height:   video.videoHeight,
            });
        };

        video.onerror = () => {
            clearTimeout(timeout);
            URL.revokeObjectURL(url);
            resolve({ duration: 0, width: 0, height: 0 });
        };

        video.src = url;
    });
}

/**
 * Bitrate in kbps.  (PDF §6.3)
 * @param {number} bytes
 * @param {number} durationSec
 * @returns {string}
 */
function videoDecompBitrate(bytes, durationSec) {
    if (!durationSec || durationSec <= 0) return "N/A";
    return Math.round((bytes * 8) / (durationSec * 1000)) + " kbps";
}

/**
 * Perceptual quality rating based on bitrate reduction.
 * @param {number} originalBps
 * @param {number} compressedBps
 * @returns {string}
 */
function videoDecompQualityRating(originalBps, compressedBps) {
    if (originalBps <= 0) return "N/A";
    const r = (originalBps - compressedBps) / originalBps;
    if (r < 0.20) return "Excellent — minimal quality loss (<20% bitrate reduction)";
    if (r < 0.40) return "Good — minor quality loss (20–40% reduction)";
    if (r < 0.65) return "Acceptable — moderate artefacts (40–65% reduction)";
    if (r < 0.85) return "Low quality — visible artefacts (65–85% reduction)";
    return "Heavy compression — significant degradation (>85% reduction)";
}

/**
 * Human-readable duration string.
 * @param {number} s - seconds
 * @returns {string}
 */
function videoDecompFormatDuration(s) {
    if (!isFinite(s) || s <= 0) return "Unknown";
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — LOSSLESS VIDEO DECOMPRESSION
   ─────────────────────────────────────────────────────────────────────────────
   The .mp4.gz file is decompressed using pako.ungzip() which reverses the
   GZIP (LZ77 + Huffman) compression applied during compressVideoLossless().
   The recovered bytes are byte-for-byte identical to the original MP4.
   SHA-256 confirms perfect rebuild.  (PDF §6.4)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a .mp4.gz file back to the original .mp4.
 *
 * Uses pako.ungzip() to reverse GZIP compression and recover the exact
 * original video bytes. SHA-256 hash comparison confirms perfect rebuild.
 *
 * @param {File}   file             - Re-uploaded .mp4.gz file
 * @param {string} storedHash       - SHA-256 of ORIGINAL stored during compression
 * @param {Object} originalMetadata - {duration, width, height} from compression
 * @param {number} originalSize     - Original file size in bytes
 * @param {string} originalName     - Original filename
 * @returns {Promise<Object>}
 */
async function decompressVideoLossless(file, storedHash, originalMetadata, originalSize, originalName = "video") {
    if (typeof pako === "undefined") {
        throw new Error("pako is not loaded. Cannot decompress video.");
    }

    // Validate: expect a .gz file
    if (!file.name.toLowerCase().endsWith(".gz")) {
        throw new Error(
            "Expected a .mp4.gz file. Got: \"" + file.name + "\". " +
            "Please re-upload the compressed file that was downloaded."
        );
    }

    // Step 1: Read the .gz file
    const gzipBuffer = await file.arrayBuffer();
    const gzipBytes  = new Uint8Array(gzipBuffer);

    // Step 2: GZIP decompress with pako → recovers original MP4 bytes
    let decompressedBytes;
    try {
        decompressedBytes = pako.ungzip(gzipBytes);
    } catch (err) {
        throw new Error(
            "GZIP decompression failed. The .mp4.gz file may be corrupted. " +
            "Detail: " + err.message
        );
    }

    const decompressedBuffer = decompressedBytes.buffer;
    const decompressedSize   = decompressedBytes.length;

    // Step 3: SHA-256 of rebuilt bytes — compare with hash of ORIGINAL
    const rebuiltHash = await videoDecompComputeSHA256(decompressedBuffer);
    const hashMatch   = storedHash ? (rebuiltHash === storedHash) : false;

    // Step 4: Read metadata from decompressed video to confirm structural integrity
    const decompressedBlob = new Blob([decompressedBuffer], { type: "video/mp4" });
    const rebuiltMeta      = await videoDecompGetMetadata(decompressedBlob);

    const durationMatch  = originalMetadata
        ? Math.abs((originalMetadata.duration || 0) - rebuiltMeta.duration) < 0.5
        : true;
    const dimensionsMatch = originalMetadata
        ? (originalMetadata.width  === rebuiltMeta.width &&
           originalMetadata.height === rebuiltMeta.height)
        : true;

    // Step 5: Build verification checks array
    const checks = [
        (hashMatch       ? "✅" : "❌") + " SHA-256 hash "   + (hashMatch       ? "matches — byte-for-byte perfect rebuild" : "mismatch — file may be corrupted"),
        (durationMatch   ? "✅" : "⚠️") + " Duration: "      + videoDecompFormatDuration(rebuiltMeta.duration),
        (dimensionsMatch ? "✅" : "⚠️") + " Dimensions: "    + rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        "✅ Decompressed size: " + videoDecompFormatBytes(decompressedSize),
    ];

    const baseName = originalName.replace(/\.[^.]+$/, "");

    return {
        rebuiltHash,
        storedHash,
        hashMatch,
        durationMatch,
        dimensionsMatch,
        checks,
        status: hashMatch
            ? "✅ Perfect rebuild — GZIP decompression successful. SHA-256 verified."
            : storedHash
                ? "❌ SHA-256 mismatch — file may have been altered or corrupted."
                : "⚠️ Decompressed successfully. No stored hash (session lost) — cannot verify.",
        compressedSizeHR:    videoDecompFormatBytes(file.size),
        decompressedSizeHR:  videoDecompFormatBytes(decompressedSize),
        originalSizeHR:      videoDecompFormatBytes(originalSize || decompressedSize),
        downloadBlob:        decompressedBlob,
        downloadName:        baseName + "_decompressed.mp4",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — LOSSY VIDEO DECOMPRESSION / QUALITY VERIFICATION
   ─────────────────────────────────────────────────────────────────────────────
   MediaRecorder re-encoding is irreversible — original MP4 data was permanently
   re-encoded into WebM format. True pixel-level decompression is not possible.
   
   Quality verification uses bitrate comparison (PDF §6.3):
   - Original bitrate (kbps) computed from source MP4 size + duration
   - Compressed bitrate (kbps) measured from the re-uploaded .webm
   
   The .webm file is returned as the downloadable decompressed output —
   it IS the decompressed, playable video.  (PDF §8.1)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a lossy-compressed WebM video by bitrate comparison.
 *
 * The re-uploaded .webm is the "decompressed" output — it is a playable
 * video file containing the re-encoded frames. Bitrate comparison shows
 * how much quality was traded for file size.  (PDF §6.3)
 *
 * @param {File}   file                - Re-uploaded .webm file
 * @param {number} originalSize        - Original MP4 size in bytes
 * @param {number} originalDurationRaw - Original duration in seconds
 * @param {number} crfUsed             - CRF value used during compression
 * @param {string} originalName        - Original filename
 * @returns {Promise<Object>}
 */
async function decompressVideoLossy(file, originalSize, originalDurationRaw, crfUsed, originalName = "video") {
    if (!file || !(file instanceof File)) {
        throw new Error("decompressVideoLossy: file must be a File object.");
    }

    // Get metadata from the re-uploaded compressed video
    const rebuiltMeta = await videoDecompGetMetadata(file);
    const rebuiltSize = file.size;

    // Use original duration as fallback if rebuilt metadata unavailable
    const rebuiltDuration = rebuiltMeta.duration > 0
        ? rebuiltMeta.duration
        : (originalDurationRaw || 1);

    // Compute bitrates in bps for quality rating
    const originalBps = originalDurationRaw > 0
        ? (originalSize * 8) / originalDurationRaw : 0;
    const rebuiltBps  = rebuiltDuration > 0
        ? (rebuiltSize  * 8) / rebuiltDuration : 0;

    const bitrateReductionPct = originalBps > 0
        ? (((originalBps - rebuiltBps) / originalBps) * 100).toFixed(1) + "%"
        : "N/A";

    const baseName = originalName.replace(/\.[^.]+$/, "");

    return {
        originalBitrate:   videoDecompBitrate(originalSize, originalDurationRaw),
        rebuiltBitrate:    videoDecompBitrate(rebuiltSize,  rebuiltDuration),
        bitrateReduction:  bitrateReductionPct,
        bitrateRating:     videoDecompQualityRating(originalBps, rebuiltBps),
        ratio:             videoDecompCompressionRatio(originalSize, rebuiltSize),
        savings:           videoDecompSpaceSavings(originalSize, rebuiltSize),
        originalSizeHR:    videoDecompFormatBytes(originalSize),
        rebuiltSizeHR:     videoDecompFormatBytes(rebuiltSize),
        rebuiltDuration:   videoDecompFormatDuration(rebuiltMeta.duration),
        rebuiltDimensions: rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        crfUsed,
        downloadBlob:      file,
        downloadName:      baseName + "_decompressed.webm",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — DOWNLOAD UTILITY (defensive duplicate)
   ───────────────────────────────────────────────────────────────────────────── */

if (typeof downloadBlob === "undefined") {
    function downloadBlob(blob, filename) { // eslint-disable-line no-unused-vars
        const url    = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href     = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}