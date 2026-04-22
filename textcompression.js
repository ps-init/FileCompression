/**
 * textcompression.js
 *
 * Handles .txt and .csv compression (GZIP via pako) and decompression.
 * Lossless — perfect byte-for-byte rebuild guaranteed via SHA-256.
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
function _textRatio(o, c)    { return c === 0 ? "∞:1" : (o / c).toFixed(2) + ":1"; }
function _textSavings(o, c)  { return (((o - c) / o) * 100).toFixed(2) + "%"; }

async function _textSHA256(buffer) {
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — COMPRESSION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses a .txt or .csv file using GZIP (pako level 9).
 * SHA-256 of the ORIGINAL bytes is stored so decompressText() can verify
 * the rebuilt file is byte-for-byte identical.
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

    // SHA-256 of ORIGINAL — used by decompressText() to verify perfect rebuild
    const originalHash = await _textSHA256(buffer);

    // GZIP compress at level 9 (maximum compression)
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
        compressedHash:   originalHash,   // SHA-256 of ORIGINAL for rebuild verification
    };
}

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — DECOMPRESSION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a .gz text file back to the original .txt / .csv.
 * Verifies perfect rebuild using SHA-256 comparison.
 *
 * The decompressed file is byte-for-byte identical to the original —
 * this is confirmed by matching SHA-256 hashes.  (PDF §6.4)
 *
 * @param {File}   file          - The .gz file to decompress
 * @param {string} storedHash    - SHA-256 of original stored during compressText()
 * @param {string} originalName  - Original filename for naming the output
 * @returns {Promise<Object>}
 */
async function decompressText(file, storedHash, originalName = "file.txt") {
    if (typeof pako === "undefined") {
        throw new Error("pako is not loaded. Cannot decompress text file.");
    }

    // Read the .gz file
    const buffer = await file.arrayBuffer();

    // Decompress with pako — returns Uint8Array of original bytes
    let decompressed;
    try {
        decompressed = pako.ungzip(new Uint8Array(buffer));
    } catch (e) {
        throw new Error(
            "GZIP decompression failed — file may be corrupted or not a valid .gz file. " +
            "Detail: " + e.message
        );
    }

    // Verify rebuild by comparing SHA-256 of rebuilt bytes with stored hash
    const rebuiltHash = await _textSHA256(decompressed.buffer);
    const isMatch     = storedHash ? (rebuiltHash === storedHash) : false;

    // Detect original extension from session originalName
    // e.g. "document.txt" → ".txt", "data.csv" → ".csv"
    const origExt  = originalName.match(/\.[^.]+$/)?.[0] || ".txt";
    const baseName = originalName.replace(/\.[^.]+$/, "");
    const downloadName = baseName + "_decompressed" + origExt;

    // Create Blob with correct UTF-8 MIME type so browser saves readable text
    const mimeType    = origExt === ".csv" ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8";
    const downloadBlob = new Blob([decompressed], { type: mimeType });

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        status: isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match. File is byte-for-byte identical to original."
            : storedHash
                ? "❌ Hash mismatch — the file may have been modified or corrupted."
                : "⚠️ No stored hash available. Compress the file again in this session to verify.",
        downloadBlob,
        downloadName,
    };
}