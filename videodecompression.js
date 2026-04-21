/**
 * videodecompression.js
 *
 * Video decompression and rebuild verification for the
 * MACS JC Project 2 Chrome Extension.
 *
 * Handles two cases that match the new videocompression.js:
 *
 *   LOSSLESS (.mp4.gz):
 *     Decompresses with pako.ungzip() → computes SHA-256 of the
 *     rebuilt .mp4 → compares against the hash stored during
 *     compression. A match proves byte-for-byte perfect rebuild.
 *     (PDF §6.4)
 *
 *   LOSSY (.webm, from MediaRecorder):
 *     The user re-uploads the compressed .webm file.
 *     We compute its bitrate and compare against the original MP4
 *     bitrate, matching how the PDF describes quality verification
 *     for lossy video (§6.3 — bitrate comparison).
 *
 * Dependencies:
 *   - pako (global, already loaded via CDN)
 *   - No other libraries.
 *
 * Exports (global functions called by popup.js):
 *   decompressVideoLossless(file, storedHash, originalMetadata, originalSize, originalName)
 *   decompressVideoLossy(file, originalSize, originalDurationRaw, crfUsed, originalName)
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SHARED UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Human-readable file size.
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
 * Compression ratio string.
 * @param {number} original
 * @param {number} compressed
 * @returns {string}
 */
function videoDecompCompressionRatio(original, compressed) {
    if (compressed === 0) return "∞:1";
    return (original / compressed).toFixed(2) + ":1";
}

/**
 * Space savings percentage string.
 * @param {number} original
 * @param {number} compressed
 * @returns {string}
 */
function videoDecompSpaceSavings(original, compressed) {
    return (((original - compressed) / original) * 100).toFixed(2) + "%";
}

/**
 * SHA-256 hash via SubtleCrypto (built into Chrome, no library needed).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}  lowercase hex string
 */
async function videoDecompComputeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, "0"))
                .join("");
}

/**
 * Reads duration/dimensions of a video Blob or File via HTML5 video element.
 * @param {File|Blob} videoFile
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function videoDecompGetMetadata(videoFile) {
    return new Promise((resolve) => {
        const video   = document.createElement("video");
        video.preload = "metadata";
        video.muted   = true;
        const url     = URL.createObjectURL(videoFile);

        video.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve({
                duration: isFinite(video.duration) ? video.duration : 0,
                width:    video.videoWidth,
                height:   video.videoHeight,
            });
        };

        // Resolve with zeros on error — non-critical for verification
        video.onerror = () => {
            URL.revokeObjectURL(url);
            resolve({ duration: 0, width: 0, height: 0 });
        };

        video.src = url;
    });
}

/**
 * Bitrate string in kbps.  (PDF §6.3)
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
 * @param {number} originalBps   — original bitrate (bits/sec)
 * @param {number} compressedBps — compressed bitrate (bits/sec)
 * @returns {string}
 */
function videoDecompQualityRating(originalBps, compressedBps) {
    if (originalBps <= 0) return "N/A";
    const reduction = (originalBps - compressedBps) / originalBps;
    if (reduction < 0.20) return "Excellent — minimal quality loss";
    if (reduction < 0.40) return "Good — minor quality loss";
    if (reduction < 0.65) return "Medium — moderate compression artefacts";
    if (reduction < 0.85) return "Low — visible compression artefacts";
    return "Very low — significant quality degradation";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — LOSSLESS DECOMPRESSION + VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a .mp4.gz file and verifies the rebuild by SHA-256.
 *
 * The user re-uploads the .mp4.gz file they downloaded after lossless
 * compression. This function:
 *   1. Decompresses it with pako.ungzip().
 *   2. Computes SHA-256 of the rebuilt .mp4 bytes.
 *   3. Compares against storedHash (SHA-256 of the original .mp4
 *      computed during compression).
 *   4. A match = byte-for-byte perfect rebuild.  (PDF §6.4)
 *
 * @param {File}   file             — Re-uploaded .mp4.gz file
 * @param {string} storedHash       — SHA-256 stored during compression
 * @param {Object} originalMetadata — {duration, width, height} of original
 * @param {number} originalSize     — Original file size in bytes
 * @param {string} originalName     — Original filename (e.g. "clip.mp4")
 *
 * @returns {Promise<{
 *   rebuiltHash:  string,
 *   hashMatch:    boolean,
 *   checks:       string[],
 *   status:       string,
 *   downloadBlob: Blob,
 *   downloadName: string,
 * }>}
 */
async function decompressVideoLossless(file, storedHash, originalMetadata, originalSize, originalName) {

    // Guard: pako must be loaded
    if (typeof pako === "undefined") {
        throw new Error(
            "pako is not loaded. Ensure pako.min.js is included before videodecompression.js."
        );
    }

    // Validate: expect a .gz file
    if (!file.name.toLowerCase().endsWith(".gz")) {
        throw new Error(
            "Expected a .mp4.gz file. Got: \"" + file.name + "\". " +
            "Please re-upload the compressed file that was downloaded."
        );
    }

    // ── Step 1: Decompress with pako ─────────────────────────────────────
    const gzipBuffer = await file.arrayBuffer();
    const gzipBytes  = new Uint8Array(gzipBuffer);

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

    // ── Step 2: SHA-256 of the rebuilt file ───────────────────────────────
    const rebuiltHash = await videoDecompComputeSHA256(decompressedBuffer);
    const hashMatch   = storedHash ? rebuiltHash === storedHash : false;

    // ── Step 3: Get metadata of the rebuilt video ─────────────────────────
    const rebuiltBlob = new Blob([decompressedBuffer], { type: "video/mp4" });
    const rebuiltMeta = await videoDecompGetMetadata(rebuiltBlob);

    // ── Step 4: Build the checks array ────────────────────────────────────
    const checks = [];

    // Hash check
    checks.push(
        hashMatch
            ? "✅ SHA-256 hash match — byte-for-byte perfect rebuild"
            : "❌ SHA-256 mismatch — file may have been altered or corrupted"
    );

    // Duration check (within 0.1s tolerance for container metadata)
    if (originalMetadata && originalMetadata.duration) {
        const durationOk = Math.abs(rebuiltMeta.duration - originalMetadata.duration) < 0.1;
        checks.push(
            durationOk
                ? "✅ Duration match — " + rebuiltMeta.duration.toFixed(1) + "s"
                : "⚠️ Duration differs — original: " + originalMetadata.duration.toFixed(1) +
                  "s, rebuilt: " + rebuiltMeta.duration.toFixed(1) + "s"
        );
    }

    // Dimensions check
    if (originalMetadata && originalMetadata.width) {
        const dimsOk = rebuiltMeta.width  === originalMetadata.width &&
                       rebuiltMeta.height === originalMetadata.height;
        checks.push(
            dimsOk
                ? "✅ Dimensions match — " + rebuiltMeta.width + " × " + rebuiltMeta.height + " px"
                : "⚠️ Dimensions differ — original: " + originalMetadata.width + "×" +
                  originalMetadata.height + ", rebuilt: " + rebuiltMeta.width + "×" + rebuiltMeta.height
        );
    }

    // File size check
    const sizeMatch = decompressedBytes.length === originalSize;
    checks.push(
        sizeMatch
            ? "✅ File size match — " + videoDecompFormatBytes(decompressedBytes.length)
            : "⚠️ Size differs — original: " + videoDecompFormatBytes(originalSize) +
              ", rebuilt: " + videoDecompFormatBytes(decompressedBytes.length)
    );

    // ── Step 5: Build download filename ───────────────────────────────────
    // e.g. "clip_compressed.mp4.gz" → "clip_decompressed.mp4"
    const baseName   = file.name
        .replace(/\.gz$/i,  "")          // remove .gz
        .replace(/\.[^.]+$/, "")         // remove .mp4 or similar
        .replace(/_compressed$/, "");    // remove _compressed suffix
    const downloadName = baseName + "_decompressed.mp4";

    const overallStatus = hashMatch
        ? "✅ Perfect rebuild — SHA-256 verified, byte-for-byte match confirmed."
        : storedHash
            ? "❌ Rebuild verification FAILED — SHA-256 mismatch. " +
              "The file may have been modified or corrupted."
            : "⚠️ No stored hash available (session was lost). " +
              "Re-compress the file in the same session to enable verification.";

    return {
        rebuiltHash,
        hashMatch,
        checks,
        status:       overallStatus,
        downloadBlob: rebuiltBlob,
        downloadName,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — LOSSY DECOMPRESSION / QUALITY VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a lossy-compressed video (.webm) by bitrate comparison.
 *
 * For lossy video (MediaRecorder → VP9/WebM), there is no mathematical
 * "decompression" — the original MP4 data was permanently re-encoded.
 * Quality is assessed by comparing:
 *   - Original bitrate (kbps) computed from the source MP4
 *   - Compressed bitrate (kbps) measured from the re-uploaded .webm
 * This is the quality metric described in PDF §6.3.
 *
 * @param {File}   file                — Re-uploaded .webm compressed file
 * @param {number} originalSize        — Original MP4 size in bytes (from session)
 * @param {number} originalDurationRaw — Original duration in seconds (from session)
 * @param {number} crfUsed             — CRF value that was used during compression
 * @param {string} originalName        — Original filename
 *
 * @returns {Promise<{
 *   originalBitrate:   string,
 *   rebuiltBitrate:    string,
 *   bitrateReduction:  string,
 *   bitrateRating:     string,
 *   ratio:             string,
 *   savings:           string,
 *   downloadBlob:      Blob,
 *   downloadName:      string,
 * }>}
 */
async function decompressVideoLossy(file, originalSize, originalDurationRaw, crfUsed, originalName) {

    // Validate file extension — should be .webm
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext !== "webm" && ext !== "mp4") {
        throw new Error(
            "Expected a .webm file (from MediaRecorder compression). Got: \"" + file.name + "\". " +
            "Please re-upload the compressed video file."
        );
    }

    // Get metadata (duration, dimensions) of the re-uploaded compressed file
    const rebuiltMeta = await videoDecompGetMetadata(file);
    const rebuiltSize = file.size;

    // Use original duration as fallback if rebuilt metadata is unavailable
    const rebuiltDuration = rebuiltMeta.duration > 0
        ? rebuiltMeta.duration
        : (originalDurationRaw || 0);

    // Compute bitrates in bps for quality rating calculation
    const originalBps  = originalDurationRaw > 0
        ? (originalSize * 8) / originalDurationRaw
        : 0;
    const rebuiltBps   = rebuiltDuration > 0
        ? (rebuiltSize * 8) / rebuiltDuration
        : 0;

    // Bitrate reduction percentage
    const bitrateReductionPct = originalBps > 0
        ? (((originalBps - rebuiltBps) / originalBps) * 100).toFixed(1) + "%"
        : "N/A";

    // Build the download filename
    const baseName   = file.name.replace(/\.[^.]+$/, "").replace(/_crf\d+$/, "");
    const downloadName = baseName + "_verified.webm";

    return {
        originalBitrate:  videoDecompBitrate(originalSize, originalDurationRaw),
        rebuiltBitrate:   videoDecompBitrate(rebuiltSize,  rebuiltDuration),
        bitrateReduction: bitrateReductionPct,
        bitrateRating:    videoDecompQualityRating(originalBps, rebuiltBps),
        ratio:            videoDecompCompressionRatio(originalSize, rebuiltSize),
        savings:          videoDecompSpaceSavings(originalSize, rebuiltSize),
        downloadBlob:     file,              // .webm is the decompressed deliverable
        downloadName,
    };
}