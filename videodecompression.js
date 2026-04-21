/**
 * videoDecompression.js
 *
 * Handles decompression and rebuild verification for video files
 * compressed by videoCompression.js, for the MACS JC Project 2 Chrome Extension.
 *
 * Updated to work with MediaRecorder output (WebM format) instead of
 * ffmpeg.wasm MP4 output. Core verification logic is unchanged.
 *
 * Dependencies (must be loaded before this file):
 *   - videoCompression.js (provides: computeSHA256, computeCompressionRatio,
 *     computeSpaceSavings, computeBitrate, formatBytes, formatDuration,
 *     getVideoMetadata, downloadBlob)
 *
 * PDF references: Section 6.3, 6.4, 8.1
 */


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — LOSSLESS VIDEO DECOMPRESSION & REBUILD VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies the integrity of a re-uploaded lossless-compressed video using
 * SHA-256 hash comparison and metadata cross-checks.
 *
 * @param {File}   reuploadedFile    - The compressed WebM video uploaded back
 * @param {string} storedHash        - SHA-256 string returned by compressVideoLossless()
 * @param {Object} originalMetadata  - { duration, width, height } from compressVideoLossless()
 * @param {number} originalSize      - Original file size in bytes
 * @param {string} [originalName="video"]
 * @returns {Promise<Object>}
 */
async function decompressVideoLossless(reuploadedFile, storedHash, originalMetadata, originalSize, originalName = "video") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressVideoLossless: reuploadedFile must be a File object.");
    }
    if (typeof storedHash !== "string" || storedHash.length !== 64) {
        throw new Error("decompressVideoLossless: storedHash must be a 64-character SHA-256 hex string.");
    }
    if (!originalMetadata || typeof originalMetadata.duration !== "number") {
        throw new Error("decompressVideoLossless: originalMetadata must be the object from compressVideoLossless().");
    }

    const rebuiltSize = reuploadedFile.size;

    // Step 1 — Hash check
    const fileBuffer  = await reuploadedFile.arrayBuffer();
    const rebuiltHash = await computeSHA256(fileBuffer);
    const hashMatch   = rebuiltHash === storedHash;

    // Step 2 — Metadata check
    let rebuiltMeta;
    try {
        rebuiltMeta = await getVideoMetadata(reuploadedFile);
    } catch (metaError) {
        throw new Error("Could not read metadata from re-uploaded video. Details: " + metaError.message);
    }

    // MediaRecorder has ~1s duration tolerance (container timestamps less precise than ffmpeg)
    const durationMatch   = Math.abs(originalMetadata.duration - rebuiltMeta.duration) < 1.0;
    const dimensionsMatch = originalMetadata.width  === rebuiltMeta.width &&
                            originalMetadata.height === rebuiltMeta.height;
    const integrityVerified = hashMatch && durationMatch && dimensionsMatch;

    const baseName = originalName.replace(/\.[^.]+$/, "");

    return {
        storedHash,
        rebuiltHash,
        hashMatch,
        durationMatch,
        dimensionsMatch,
        integrityVerified,
        status: integrityVerified
            ? "✅ All checks passed — video is fully verified."
            : "⚠️ One or more checks failed — see details below.",
        checks: [
            (hashMatch       ? "✅" : "❌") + " SHA-256 hash "      + (hashMatch       ? "matches"  : "mismatch"),
            (durationMatch   ? "✅" : "⚠️") + " Duration: "         + formatDuration(rebuiltMeta.duration),
            (dimensionsMatch ? "✅" : "⚠️") + " Dimensions: "       + rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        ],
        originalSizeHR:     formatBytes(originalSize),
        rebuiltSizeHR:      formatBytes(rebuiltSize),
        ratio:              computeCompressionRatio(originalSize, rebuiltSize),
        savings:            computeSpaceSavings(originalSize, rebuiltSize),
        originalDuration:   formatDuration(originalMetadata.duration),
        rebuiltDuration:    formatDuration(rebuiltMeta.duration),
        originalDimensions: originalMetadata.width + " × " + originalMetadata.height + " px",
        rebuiltDimensions:  rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        downloadBlob:       new Blob([fileBuffer], { type: reuploadedFile.type }),
        downloadName:       baseName + "_verified_lossless.webm",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — LOSSY VIDEO DECOMPRESSION & QUALITY VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a lossy-compressed video by bitrate comparison (PDF Section 6.3).
 *
 * @param {File}   reuploadedFile        - The compressed WebM uploaded back
 * @param {number} originalSize          - Original file size in bytes
 * @param {number} originalDurationSec   - Original duration in seconds
 * @param {number} [crfUsed=23]          - CRF level used during compression
 * @param {string} [originalName="video"]
 * @returns {Promise<Object>}
 */
async function decompressVideoLossy(reuploadedFile, originalSize, originalDurationSec, crfUsed = 23, originalName = "video") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressVideoLossy: reuploadedFile must be a File object.");
    }
    if (typeof originalSize !== "number" || originalSize <= 0) {
        throw new Error("decompressVideoLossy: originalSize must be a positive number (bytes).");
    }
    if (typeof originalDurationSec !== "number" || originalDurationSec <= 0) {
        throw new Error("decompressVideoLossy: originalDurationSec must be a positive number (seconds).");
    }

    const rebuiltSize = reuploadedFile.size;

    let rebuiltMeta;
    try {
        rebuiltMeta = await getVideoMetadata(reuploadedFile);
    } catch (metaError) {
        throw new Error("Could not read metadata from re-uploaded video. Details: " + metaError.message);
    }

    const originalBitrateKbps  = (originalSize * 8) / (originalDurationSec * 1000);
    const rebuiltBitrateKbps   = (rebuiltSize  * 8) / ((rebuiltMeta.duration || originalDurationSec) * 1000);
    const bitrateReductionPct  = ((originalBitrateKbps - rebuiltBitrateKbps) / originalBitrateKbps) * 100;

    const baseName = originalName.replace(/\.[^.]+$/, "");

    return {
        originalSizeHR:    formatBytes(originalSize),
        rebuiltSizeHR:     formatBytes(rebuiltSize),
        ratio:             computeCompressionRatio(originalSize, rebuiltSize),
        savings:           computeSpaceSavings(originalSize, rebuiltSize),
        originalBitrate:   originalBitrateKbps.toFixed(0)  + " kbps",
        rebuiltBitrate:    rebuiltBitrateKbps.toFixed(0)   + " kbps",
        bitrateReduction:  bitrateReductionPct.toFixed(2)  + "%",
        bitrateRating:     rateLossyVideo(crfUsed, bitrateReductionPct),
        crfUsed,
        rebuiltDuration:   formatDuration(rebuiltMeta.duration),
        rebuiltDimensions: rebuiltMeta.width + " × " + rebuiltMeta.height + " px",
        downloadBlob:      reuploadedFile,
        downloadName:      baseName + "_compressed_crf" + crfUsed + ".webm",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — QUALITY RATING HELPER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Quality label for lossy video based on CRF and bitrate reduction.
 * @param {number} crf
 * @param {number} bitrateReductionPct
 * @returns {string}
 */
function rateLossyVideo(crf, bitrateReductionPct) {
    if (crf <= 17) return "Visually Lossless (CRF ≤ 17) — minimal quality loss";
    if (crf <= 23) return "Good Quality (CRF 18–23) — recommended balance";
    if (crf <= 28) return "Acceptable Quality (CRF 24–28) — noticeable compression";
    return "Heavy Compression (CRF > 28) — " + bitrateReductionPct.toFixed(1) + "% bitrate saved";
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