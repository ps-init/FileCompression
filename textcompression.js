/**
 * textcompression.js
 *
 * Handles .txt and .csv file compression and decompression using pako GZIP.
 * Lossless — perfect rebuild guaranteed via SHA-256 verification.
 *
 * Exports: compressText(file), decompressText(file, storedHash, originalName)
 * Dependency: pako (global, loaded in index.html)
 * PDF references: Section 4.1, 6.1, 6.2, 6.4
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

function _textFormatBytes(bytes) {
    if (bytes < 1024)    return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(2) + " KB";
    return (bytes / 1048576).toFixed(2) + " MB";
}
function _textRatio(o, c) { return c === 0 ? "∞:1" : (o / c).toFixed(2) + ":1"; }
function _textSavings(o, c) { return (((o - c) / o) * 100).toFixed(2) + "%"; }

async function _textSHA256(buffer) {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — COMPRESSION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a .txt or .csv file with GZIP (level 9) via pako.
 * SHA-256 of the ORIGINAL is stored so decompression can verify perfect rebuild.
 *
 * @param {File} file
 * @returns {Promise<Object>}
 */
async function compressText(file) {
    if (typeof pako === "undefined") {
        throw new Error("pako is not loaded. Cannot compress text file.");
    }

    const buffer       = await file.arrayBuffer();
    const originalSize = file.size;
    const originalHash = await _textSHA256(buffer);   // hash of ORIGINAL for rebuild check

    const compressed     = pako.gzip(new Uint8Array(buffer), { level: 9 });
    const compressedBlob = new Blob([compressed], { type: "application/gzip" });
    const compressedSize = compressedBlob.size;

    return {
        format:           "GZIP (pako level 9)",
        type:             "lossless",
        originalSize,
        compressedSize,
        originalSizeHR:   _textFormatBytes(originalSize),
        compressedSizeHR: _textFormatBytes(compressedSize),
        ratio:            _textRatio(originalSize, compressedSize),
        savings:          _textSavings(originalSize, compressedSize),
        compressedBlob,
        compressedHash:   originalHash,  // stored for decompression verification
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — DECOMPRESSION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a .gz text file and verifies rebuild via SHA-256.
 * Decompressed file is byte-for-byte identical to the original.
 *
 * @param {File}   file         - The .gz file to decompress
 * @param {string} storedHash   - SHA-256 of the original file (from compressText)
 * @param {string} originalName - Original filename for naming the download
 * @returns {Promise<Object>}
 */
async function decompressText(file, storedHash, originalName = "file") {
    if (typeof pako === "undefined") {
        throw new Error("pako is not loaded. Cannot decompress text file.");
    }

    const buffer = await file.arrayBuffer();
    let decompressed;

    try {
        decompressed = pako.ungzip(new Uint8Array(buffer));
    } catch (e) {
        throw new Error("GZIP decompression failed — file may be corrupted. Detail: " + e.message);
    }

    const rebuiltHash = await _textSHA256(decompressed.buffer);
    const isMatch     = storedHash ? rebuiltHash === storedHash : false;

    const baseName    = originalName.replace(/\.[^.]+$/, "");
    const origExt     = originalName.match(/\.[^.]+$/)?.[0] || ".txt";
    const downloadName = baseName + "_decompressed" + origExt;

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        status: isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match. File is byte-for-byte identical to original."
            : storedHash
                ? "❌ Hash mismatch — the file may have been modified or corrupted."
                : "⚠️ No stored hash available. Compress the file again in this session to verify.",
        downloadBlob: new Blob([decompressed], { type: "text/plain" }),
        downloadName,
    };
}