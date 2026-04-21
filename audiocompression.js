/**
 * audiocompression.js
 *
 * Audio compression for the MACS JC Project 2 Chrome Extension.
 *
 * Strategy (no new libraries — pako is already loaded globally):
 *   WAV  → GZIP (lossless): Every byte is preserved. SHA-256 verifies
 *          perfect rebuild on decompression. Download as .wav.gz
 *   MP3  → GZIP (lossless container): MP3 is already a lossy format
 *          (perceptual coding). GZIP wraps it losslessly. We report
 *          the bitrate comparison as the quality metric (PDF §6.3).
 *          Download as .mp3.gz
 *
 * Dependency: pako (global) — already loaded via CDN in index.html.
 *
 * Exports (global functions called by popup.js):
 *   compressAudio(file)  → Promise<AudioCompressionResult>
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — UTILITY HELPERS
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a human-readable file size string.
 * @param {number} bytes
 * @returns {string}  e.g. "1.23 MB"
 */
function audioFormatBytes(bytes) {
    if (bytes < 1024)       return bytes + " B";
    if (bytes < 1048576)    return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}

/**
 * Computes compression ratio as a string.  (PDF §6.1)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}  e.g. "3.41:1"
 */
function audioCompressionRatio(original, compressed) {
    if (compressed === 0) return "∞:1";
    return (original / compressed).toFixed(2) + ":1";
}

/**
 * Computes space savings as a percentage string.  (PDF §6.2)
 * @param {number} original
 * @param {number} compressed
 * @returns {string}  e.g. "70.68%"
 */
function audioSpaceSavings(original, compressed) {
    return (((original - compressed) / original) * 100).toFixed(2) + "%";
}

/**
 * Computes SHA-256 of an ArrayBuffer using the Web Crypto API.
 * No external library needed — built into Chrome.  (PDF §6.4)
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}  Lowercase hex string
 */
async function audioComputeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, "0"))
                .join("");
}

/**
 * Reads the duration of an audio/video file in seconds
 * using the browser's HTML5 audio element.
 *
 * @param {File} file
 * @returns {Promise<number>}  Duration in seconds, or 0 if unreadable
 */
function audioGetDuration(file) {
    return new Promise((resolve) => {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        const url = URL.createObjectURL(file);

        audio.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve(isFinite(audio.duration) ? audio.duration : 0);
        };

        // Resolve with 0 on error — duration is optional, not critical
        audio.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
        audio.src = url;
    });
}

/**
 * Computes audio bitrate in kbps given file size and duration.
 * Used as the quality metric for lossy (MP3) audio.  (PDF §6.3)
 *
 * @param {number} bytes
 * @param {number} durationSec
 * @returns {string}  e.g. "192 kbps" or "N/A"
 */
function audioComputeBitrate(bytes, durationSec) {
    if (!durationSec || durationSec <= 0) return "N/A";
    return Math.round((bytes * 8) / (durationSec * 1000)) + " kbps";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — MAIN COMPRESSION FUNCTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses an audio file (WAV or MP3) using GZIP via pako.
 *
 * WAV → GZIP = LOSSLESS. Perfect rebuild guaranteed.
 *              SHA-256 of the original WAV is stored for verification.
 *
 * MP3 → GZIP = LOSSLESS container, but MP3 itself is already lossy
 *              (perceptual coding discarded data during encoding).
 *              We report original vs compressed bitrate as the quality metric.
 *
 * @param {File} file  — The audio file (.wav or .mp3)
 * @returns {Promise<{
 *   type:            string,   "lossless" | "lossy"
 *   originalSize:    number,   bytes
 *   originalSizeHR:  string,   human-readable
 *   compressedSizeHR:string,
 *   ratio:           string,   "X.XX:1"
 *   savings:         string,   "XX.XX%"
 *   compressedBlob:  Blob,
 *   compressedHash:  string,   SHA-256 of the ORIGINAL (for lossless rebuild check)
 *   outputName:      string,   suggested download filename
 *   bitrateOriginal: string,   e.g. "320 kbps" (MP3 only)
 *   bitrateGzipped:  string,   kbps of the .gz file (informational)
 * }>}
 */
async function compressAudio(file) {

    // ── Guard: pako must be loaded globally ───────────────────────────────
    if (typeof pako === "undefined") {
        throw new Error(
            "pako is not loaded. Ensure pako.min.js is included before audiocompression.js."
        );
    }

    const extension    = file.name.split(".").pop().toLowerCase();
    const isWav        = extension === "wav";
    const isMp3        = extension === "mp3";

    if (!isWav && !isMp3) {
        throw new Error(
            `Unsupported audio format ".${extension}". Only .wav and .mp3 files are supported.`
        );
    }

    // ── Step 1: Read the file into an ArrayBuffer ─────────────────────────
    const originalBuffer = await file.arrayBuffer();
    const originalSize   = file.size;

    // ── Step 2: Compute SHA-256 of the original (needed for verification) ─
    const originalHash = await audioComputeSHA256(originalBuffer);

    // ── Step 3: GZIP compress using pako (level 6 = good balance) ─────────
    const inputBytes      = new Uint8Array(originalBuffer);
    const compressedBytes = pako.gzip(inputBytes, { level: 6 });
    const compressedBlob  = new Blob([compressedBytes], { type: "application/gzip" });
    const compressedSize  = compressedBlob.size;

    // ── Step 4: Build output filename ─────────────────────────────────────
    // e.g. "song.wav" → "song_compressed.wav.gz"
    const baseName   = file.name.replace(/\.[^.]+$/, "");
    const outputName = baseName + "_compressed." + extension + ".gz";

    // ── Step 5: Build quality info ────────────────────────────────────────
    // For WAV: lossless, no quality loss, SHA-256 confirms perfect rebuild.
    // For MP3: MP3 encoding was already lossy. We report the bitrate.
    let bitrateOriginal = "N/A";
    let bitrateGzipped  = "N/A";

    if (isMp3) {
        const durationSec   = await audioGetDuration(file);
        bitrateOriginal     = audioComputeBitrate(originalSize, durationSec);
        bitrateGzipped      = audioComputeBitrate(compressedSize, durationSec);
    }

    return {
        type:             isWav ? "lossless" : "lossy",
        originalSize,
        originalSizeHR:   audioFormatBytes(originalSize),
        compressedSizeHR: audioFormatBytes(compressedSize),
        ratio:            audioCompressionRatio(originalSize, compressedSize),
        savings:          audioSpaceSavings(originalSize, compressedSize),
        compressedBlob,
        compressedHash:   originalHash,   // SHA-256 of ORIGINAL for rebuild check
        outputName,
        bitrateOriginal,
        bitrateGzipped,
        extension,
    };
}