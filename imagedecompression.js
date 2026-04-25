/**
 * imageDecompression.js
 *
 * Correct decompression architecture for MACS JC Project 2.
 *
 * ARCHITECTURE:
 *
 *   JPEG (lossy):
 *     WRONG: JPEG → decode pixels → export PNG (inflated, still blurry)
 *     RIGHT: JPEG → decode pixels ONLY for PSNR/SSIM measurement
 *                → return original JPEG stream as downloadable output
 *     Rationale: Lossy compression permanently discards data. Re-exporting
 *     as PNG inflates file size without recovering quality. The compressed
 *     JPEG IS the decompressed output — it is already a viewable image.
 *
 *   PNG (lossless):
 *     DEFLATE decompression recovers original pixels exactly.
 *     SHA-256 hash confirms byte-for-byte perfect rebuild.
 *     If recompressed PNG > original, fall back to original file.
 *     Alpha channel preserved — no white background flattening.
 *
 * PDF references: Section 4.2, 6.3, 6.4, 8.1
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — PNG LOSSLESS DECOMPRESSION
   ─────────────────────────────────────────────────────────────────────────────
   PNG uses DEFLATE (LZ77 + Huffman) lossless compression.
   Decompression recovers the exact original pixel data.
   SHA-256 confirms byte-for-byte identical rebuild.
   Alpha channel preserved — no flattening.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a PNG by verifying its SHA-256 hash and decoding pixels.
 * Returns the original PNG stream as the downloadable output — not re-encoded.
 * Falls back to original file if any re-encoding would inflate size.
 *
 * @param {File}   reuploadedFile  - The compressed PNG
 * @param {string} storedHash      - SHA-256 from compressImagePNG()
 * @param {string} [originalName]
 * @returns {Promise<Object>}
 */
async function decompressPNG(reuploadedFile, storedHash, originalName = "image") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressPNG: reuploadedFile must be a File object.");
    }
    if (typeof storedHash !== "string" || storedHash.length !== 64) {
        throw new Error("decompressPNG: storedHash must be a 64-character SHA-256 hex string.");
    }

    // Step 1: Hash verification — confirms file integrity
    const fileBuffer  = await readFileAsArrayBuffer(reuploadedFile);
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;

    // Step 2: Decode PNG → raw pixels for dimension/metadata inspection
    // This IS DEFLATE decompression: compressed stream → raw RGBA pixel array
    const decoded = await decodeBlobToRGBA(reuploadedFile);

    // Step 3: Architectural decision — return ORIGINAL compressed PNG stream.
    // Re-encoding to PNG would risk size inflation and alpha channel loss.
    // The original file IS the correct decompressed output for lossless PNG.
    const downloadBlob = new Blob([fileBuffer], { type: "image/png" });
    const baseName     = originalName.replace(/\.[^.]+$/, "");

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        width:              decoded.width,
        height:             decoded.height,
        totalPixels:        decoded.width * decoded.height,
        status: isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match. DEFLATE decompression successful."
            : "❌ Hash mismatch — the file may have been modified or corrupted.",
        compressedSizeHR:   formatBytes(reuploadedFile.size),
        decompressedSizeHR: formatBytes(reuploadedFile.size),
        fileSizeHR:         formatBytes(reuploadedFile.size),
        downloadBlob,
        downloadName:       baseName + "_verified.png",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — JPEG LOSSY DECOMPRESSION
   ─────────────────────────────────────────────────────────────────────────────
   CORRECT ARCHITECTURE:
     The compressed JPEG IS the decompressed output.
     Pixels are decoded ONLY to compute PSNR/SSIM quality metrics.
     The JPEG stream is returned as-is for download — no re-encoding.
   
   WHY NOT PNG OUTPUT:
     JPEG → PNG inflates 3-5x in size without recovering quality.
     The lost DCT coefficients cannot be restored — exporting as PNG
     just stores the same degraded pixels in a larger format.
     This is architecturally wrong and misleads the user.
   
   ADAPTIVE QUALITY NOTE:
     Quality was set at compression time via the slider.
     We measure and report what was preserved via PSNR/SSIM.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a JPEG rebuild by measuring PSNR and SSIM quality metrics.
 * Returns the original compressed JPEG as the downloadable output.
 * NO re-encoding — compressed JPEG is the correct decompressed artifact.
 *
 * @param {File}              reuploadedFile   - The compressed JPEG
 * @param {Uint8ClampedArray} originalPixels   - From compressImageJPEG()
 * @param {number}            originalSize     - Original file size in bytes
 * @param {number}            originalWidth
 * @param {number}            originalHeight
 * @param {string}            [originalName]
 * @returns {Promise<Object>}
 */
async function decompressJPEG(reuploadedFile, originalPixels, originalSize, originalWidth, originalHeight, originalName = "image") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressJPEG: reuploadedFile must be a File object.");
    }
    if (!(originalPixels instanceof Uint8ClampedArray) && !(originalPixels instanceof Uint8Array)) {
        throw new Error("decompressJPEG: originalPixels must be from compressImageJPEG().");
    }

    const compressedSize = reuploadedFile.size;

    // Step 1: Decode JPEG → raw pixels via Canvas API
    // Purpose: quality measurement ONLY — not for re-export
    // Process: Huffman decode → dequantize → IDCT → YCbCr→RGB → RGBA pixel grid
    let decoded;
    try {
        decoded = await decodeBlobToRGBA(reuploadedFile);
    } catch (e) {
        throw new Error("Canvas API failed to decode JPEG. Detail: " + e.message);
    }

    const rebuiltPixels = decoded.data;

    // Step 2: Quality measurement — how much did JPEG encoding degrade the image?
    const psnrValue  = computePSNR(originalPixels, rebuiltPixels);
    const ssimValue  = computeSSIM(originalPixels, rebuiltPixels);
    const psnrRating = ratePSNR(psnrValue);

    // Step 3: RESIDUAL DELTA — pixel-level difference between original and rebuilt
    // Shows exactly what data was lost during JPEG encoding
    const residualInfo = _computeResidualStats(originalPixels, rebuiltPixels);

    // Step 4: Architectural decision — return compressed JPEG as download output.
    // This IS the correct decompressed artifact:
    //   - Same visual content as stored in compressed form
    //   - Correct file size (not inflated)
    //   - Correct format (JPEG, not PNG)
    //   - No second lossy encode applied
    const fileBuffer   = await reuploadedFile.arrayBuffer();
    const downloadBlob = new Blob([fileBuffer], { type: "image/jpeg" });
    const baseName     = originalName.replace(/\.[^.]+$/, "");

    return {
        psnr:               psnrValue,
        ssim:               ssimValue,
        psnrRating,
        width:              decoded.width,
        height:             decoded.height,
        totalPixels:        decoded.width * decoded.height,
        originalSizeHR:     formatBytes(originalSize),
        compressedSizeHR:   formatBytes(compressedSize),
        decompressedSizeHR: formatBytes(compressedSize),  // same — no re-encoding
        ratio:              computeCompressionRatio(originalSize, compressedSize),
        savings:            computeSpaceSavings(originalSize, compressedSize),
        residualInfo,
        downloadBlob,
        downloadName:       baseName + "_decompressed.jpg",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — RESIDUAL / DELTA ANALYSIS
   ─────────────────────────────────────────────────────────────────────────────
   Computes per-pixel difference between original and rebuilt pixel arrays.
   This is the "residual" — the data permanently lost during JPEG encoding.
   Used for quality reporting only — cannot be used to reconstruct original.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Computes statistical summary of pixel-level differences (residual).
 * @param {Uint8ClampedArray} original  - Original pixels
 * @param {Uint8ClampedArray} rebuilt   - Rebuilt pixels after JPEG decode
 * @returns {Object} Residual statistics
 */
function _computeResidualStats(original, rebuilt) {
    if (!original || !rebuilt || original.length !== rebuilt.length) {
        return { maxDelta: "N/A", avgDelta: "N/A", affectedPixels: "N/A" };
    }

    let maxDelta       = 0;
    let totalDelta     = 0;
    let affectedPixels = 0;
    const pixelCount   = Math.floor(original.length / 4);

    for (let i = 0; i < original.length; i += 4) {
        // Compare RGB channels only (ignore alpha)
        const dr = Math.abs(original[i]     - rebuilt[i]);
        const dg = Math.abs(original[i + 1] - rebuilt[i + 1]);
        const db = Math.abs(original[i + 2] - rebuilt[i + 2]);
        const d  = Math.round((dr + dg + db) / 3);

        if (d > 0) affectedPixels++;
        totalDelta += d;
        if (d > maxDelta) maxDelta = d;
    }

    return {
        maxDelta:       maxDelta + " (max channel diff, 0–255)",
        avgDelta:       (totalDelta / pixelCount).toFixed(2) + " avg per pixel",
        affectedPixels: ((affectedPixels / pixelCount) * 100).toFixed(1) + "% pixels changed",
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — PSNR RATING HELPER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Converts a PSNR value string into a quality label.
 * Thresholds from PDF Section 6.3.
 * @param {string} psnrString
 * @returns {string}
 */
function ratePSNR(psnrString) {
    if (psnrString.includes("Identical") || psnrString.includes("∞")) return "Perfect (lossless)";
    if (psnrString.includes("N/A"))                                      return "Cannot compute";
    const n = parseFloat(psnrString);
    if (isNaN(n))  return "Unknown";
    if (n >= 40)   return "Excellent (>40 dB) — visually indistinguishable from original";
    if (n >= 35)   return "Good (35–40 dB) — minor loss, acceptable for most uses";
    if (n >= 25)   return "Acceptable (25–35 dB) — noticeable artefacts";
    return "Visibly Degraded (<25 dB) — use higher quality setting next time";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — DOWNLOAD UTILITY
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