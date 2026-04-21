/**
 * audiodecompression.js
 *
 * Audio decompression and rebuild verification for the
 * MACS JC Project 2 Chrome Extension.
 *
 * What this file does:
 *   1. Accepts a .wav.gz or .mp3.gz file uploaded by the user.
 *   2. Decompresses it using pako.ungzip() (no extra library needed).
 *   3. For WAV (lossless): computes SHA-256 of the rebuilt file and
 *      compares it to the hash stored during compression.
 *      A match proves byte-for-byte identical rebuild.  (PDF §6.4)
 *   4. For MP3 (lossy): decompresses and reports that the MP3 itself
 *      is a lossy format — the original WAV data was discarded at
 *      encoding time, not here. The GZIP layer is lossless.
 *
 * Dependency: pako (global) — already loaded via CDN in index.html.
 *
 * Exports (global function called by popup.js):
 *   decompressAudio(file, session, originalName) → Promise<AudioDecompressionResult>
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SHA-256 HELPER  (same as audiocompression.js)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Computes SHA-256 of an ArrayBuffer using the Web Crypto API.
 * Built into Chrome — no external library needed.  (PDF §6.4)
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}  Lowercase hex string
 */
async function audioDecompComputeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, "0"))
                .join("");
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — MAIN DECOMPRESSION FUNCTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a .wav.gz or .mp3.gz file and verifies the rebuild.
 *
 * For LOSSLESS (WAV):
 *   Decompresses → computes SHA-256 → compares with stored hash from
 *   the compression session → confirms byte-for-byte match.
 *
 * For LOSSY (MP3):
 *   Decompresses → note that MP3 itself is a perceptually lossy format
 *   (data was discarded during MP3 encoding, not here). The GZIP
 *   wrapper is removed and the original .mp3 is restored exactly.
 *
 * @param {File}   file          — The re-uploaded compressed file (.wav.gz or .mp3.gz)
 * @param {Object} session       — compressionSession stored by popup.js:
 *                                   { storedHash, originalName, audioType, extension }
 * @param {string} originalName  — Original filename before compression
 *
 * @returns {Promise<{
 *   type:         string,   Human-readable description for the UI
 *   isLossless:   boolean,
 *   status:       string,   Status message shown in UI
 *   hashCheck:    Object|null,  { stored, rebuilt, match } — lossless only
 *   downloadBlob: Blob,
 *   downloadName: string,
 * }>}
 */
async function decompressAudio(file, session, originalName) {

    // ── Guard: pako must be loaded globally ───────────────────────────────
    if (typeof pako === "undefined") {
        throw new Error(
            "pako is not loaded. Ensure pako.min.js is included before audiodecompression.js."
        );
    }

    // ── Step 1: Validate the uploaded file is a .gz ───────────────────────
    const uploadedName = file.name.toLowerCase();
    if (!uploadedName.endsWith(".gz")) {
        throw new Error(
            `Expected a .gz file (e.g. song_compressed.wav.gz), but got "${file.name}". ` +
            "Please upload the compressed file that was downloaded after compression."
        );
    }

    // ── Step 2: Decompress with pako.ungzip() ─────────────────────────────
    const gzipBuffer        = await file.arrayBuffer();
    const gzipBytes         = new Uint8Array(gzipBuffer);
    let   decompressedBytes;

    try {
        decompressedBytes = pako.ungzip(gzipBytes);
    } catch (pakoErr) {
        throw new Error(
            "GZIP decompression failed. The file may be corrupted or not a valid GZIP archive. " +
            "Detail: " + pakoErr.message
        );
    }

    const decompressedBuffer = decompressedBytes.buffer;

    // ── Step 3: Determine whether this was originally WAV or MP3 ─────────
    // Derive from the compressed filename: "song_compressed.wav.gz" → "wav"
    const innerExtension = uploadedName.replace(/\.gz$/, "").split(".").pop();
    const isWav          = innerExtension === "wav";

    // ── Step 4: Rebuild the output filename ───────────────────────────────
    // Strip "_compressed" suffix if present, restore original extension
    // e.g. "song_compressed.wav.gz" → "song_decompressed.wav"
    const baseName      = uploadedName
        .replace(/\.gz$/, "")          // remove .gz
        .replace(/\.[^.]+$/, "")       // remove .wav or .mp3
        .replace(/_compressed$/, "");  // remove suffix we added

    const downloadName = baseName + "_decompressed." + innerExtension;

    // ── Step 5: Create the downloadable Blob ─────────────────────────────
    const mimeType     = isWav ? "audio/wav" : "audio/mpeg";
    const downloadBlob = new Blob([decompressedBuffer], { type: mimeType });

    // ── Step 6: Verify the rebuild ────────────────────────────────────────

    if (isWav) {
        // LOSSLESS path: compute SHA-256 and compare with stored hash
        const rebuiltHash = await audioDecompComputeSHA256(decompressedBuffer);
        const storedHash  = session && session.compressedHash ? session.compressedHash : null;
        const hashMatch   = storedHash !== null && rebuiltHash === storedHash;

        let status;
        if (storedHash === null) {
            // Session was lost (e.g. extension popup closed between steps)
            status = "⚠️ No stored hash found. Compress the file again in the same session to verify.";
        } else if (hashMatch) {
            status = "✅ SHA-256 hashes match — byte-for-byte perfect rebuild confirmed.";
        } else {
            status = "❌ SHA-256 mismatch — the file may have been altered or corrupted.";
        }

        return {
            type:         "Audio — Lossless Rebuild (WAV via GZIP)",
            isLossless:   true,
            status,
            hashCheck:    {
                stored:  storedHash || "(not available — session lost)",
                rebuilt: rebuiltHash,
                match:   hashMatch,
            },
            downloadBlob,
            downloadName,
        };

    } else {
        // LOSSY path: MP3 was already a perceptually lossy format.
        // The GZIP was lossless — we've restored the exact MP3 bytes.
        // But the original WAV data (before MP3 encoding) is gone forever.
        const rebuiltHash = await audioDecompComputeSHA256(decompressedBuffer);
        const storedHash  = session && session.compressedHash ? session.compressedHash : null;
        const hashMatch   = storedHash !== null && rebuiltHash === storedHash;

        const status = hashMatch
            ? "✅ MP3 file restored exactly (GZIP layer was lossless). " +
              "Note: MP3 is a perceptually lossy codec — the original pre-encoding " +
              "audio data cannot be recovered."
            : storedHash === null
                ? "⚠️ MP3 decompressed successfully. No stored hash (session lost) — cannot verify."
                : "❌ SHA-256 mismatch — the .mp3.gz file may have been corrupted.";

        return {
            type:         "Audio — MP3 Decompressed (GZIP wrapper removed)",
            isLossless:   false,
            status,
            hashCheck:    {
                stored:  storedHash || "(not available — session lost)",
                rebuilt: rebuiltHash,
                match:   hashMatch,
            },
            downloadBlob,
            downloadName,
        };
    }
}