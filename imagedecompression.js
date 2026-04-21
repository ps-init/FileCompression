/**
 * imageDecompression.js
 *
 * Handles decompression and rebuild verification for image files
 * compressed by imageCompression.js, for the MACS JC Project 2 Chrome Extension.
 *
 * No external libraries required — uses browser Canvas API for JPEG decoding.
 *
 * Dependencies:
 *   - imageCompression.js (provides: computeSHA256, computePSNR, computeSSIM,
 *     computeCompressionRatio, computeSpaceSavings, formatBytes,
 *     readFileAsArrayBuffer, decodeBlobToRGBA, downloadBlob)
 *
 * PDF references: Section 6.3, 6.4, 8.1
 */


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — PNG LOSSLESS DECOMPRESSION & REBUILD VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies the integrity of a re-uploaded compressed PNG and produces a
 * downloadable verified copy.
 *
 * The SHA-256 of the re-uploaded file is compared against the hash captured
 * at compression time. A match confirms the file is byte-for-byte intact.
 *
 * @param {File}   reuploadedFile  - The compressed PNG the user uploads back
 * @param {string} storedHash      - SHA-256 string returned by compressImagePNG()
 * @param {string} [originalName="image"] - Used to name the download file
 * @returns {Promise<Object>} Verification result with status and downloadable blob
 */
async function decompressPNG(reuploadedFile, storedHash, originalName = "image") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressPNG: reuploadedFile must be a File object.");
    }
    if (typeof storedHash !== "string" || storedHash.length !== 64) {
        throw new Error("decompressPNG: storedHash must be a 64-character SHA-256 hex string.");
    }

    const fileBuffer  = await readFileAsArrayBuffer(reuploadedFile);
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;

    const downloadBlob = new Blob([fileBuffer], { type: "image/png" });
    const baseName     = originalName.replace(/\.[^.]+$/, "");
    const downloadName = baseName + "_verified.png";

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        status:       isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match. File is byte-for-byte intact."
            : "❌ Hash mismatch — the file may have been modified or corrupted.",
        fileSizeHR:   formatBytes(reuploadedFile.size),
        downloadBlob,
        downloadName,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — JPEG LOSSY DECOMPRESSION & QUALITY VERIFICATION
   ─────────────────────────────────────────────────────────────────────────────
   Uses the browser Canvas API to decode the JPEG — no jpeg-js needed.
   The JPEG is drawn onto a canvas, pixel data is extracted via getImageData(),
   and PSNR/SSIM are computed against the original pixels saved at compression.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses (decodes) a re-uploaded JPEG using the Canvas API, measures
 * quality loss against the original pixels, and produces a downloadable PNG.
 *
 * @param {File}              reuploadedFile   - The compressed JPEG uploaded back
 * @param {Uint8ClampedArray} originalPixels   - Pixel data from compressImageJPEG()
 * @param {number}            originalSize     - Original file size in bytes
 * @param {number}            originalWidth    - Width returned by compressImageJPEG()
 * @param {number}            originalHeight   - Height returned by compressImageJPEG()
 * @param {string}            [originalName="image"] - Used to name the download file
 * @returns {Promise<Object>} Quality metrics and downloadable decoded PNG blob
 */
async function decompressJPEG(reuploadedFile, originalPixels, originalSize, originalWidth, originalHeight, originalName = "image") {
    if (!reuploadedFile || !(reuploadedFile instanceof File)) {
        throw new Error("decompressJPEG: reuploadedFile must be a File object.");
    }
    if (!(originalPixels instanceof Uint8ClampedArray) && !(originalPixels instanceof Uint8Array)) {
        throw new Error("decompressJPEG: originalPixels must be the Uint8ClampedArray from compressImageJPEG().");
    }

    const compressedSize = reuploadedFile.size;

    // Decode JPEG back to RGBA pixels using the Canvas API
    let decoded;
    try {
        decoded = await decodeBlobToRGBA(reuploadedFile);
    } catch (decodeError) {
        throw new Error(
            "Canvas API failed to decode the file. Ensure you are uploading a valid JPEG. " +
            "Details: " + decodeError.message
        );
    }

    const rebuiltPixels = decoded.data;
    const psnrValue     = computePSNR(originalPixels, rebuiltPixels);
    const ssimValue     = computeSSIM(originalPixels, rebuiltPixels);
    const psnrRating    = ratePSNR(psnrValue);

    // Export decoded pixels as a PNG blob so the user can download them
    // Download the compressed JPEG itself (lossy — original pixels are recovered visually)
    // Decoding back to PNG would change format; returning JPEG preserves original format.
    const downloadBlob = new Blob([await reuploadedFile.arrayBuffer()], { type: "image/jpeg" });
    const baseName     = originalName.replace(/\.[^.]+$/, "");
    const downloadName = baseName + "_decompressed.jpg";

    return {
        psnr:             psnrValue,
        ssim:             ssimValue,
        psnrRating,
        originalSizeHR:   formatBytes(originalSize),
        compressedSizeHR: formatBytes(compressedSize),
        ratio:            computeCompressionRatio(originalSize, compressedSize),
        savings:          computeSpaceSavings(originalSize, compressedSize),
        downloadBlob,
        downloadName,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — PSNR RATING HELPER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Converts a PSNR string (e.g. "38.21 dB") into a plain-English quality label.
 * Thresholds from PDF Section 6.3: >40 dB excellent, <25 dB visibly degraded.
 *
 * @param {string} psnrString - Value returned by computePSNR()
 * @returns {string} Quality label for display in the extension UI
 */
function ratePSNR(psnrString) {
    if (psnrString.includes("Identical") || psnrString.includes("∞")) return "Perfect (lossless)";
    if (psnrString.includes("N/A"))                                      return "Cannot compute";
    const n = parseFloat(psnrString);
    if (isNaN(n))  return "Unknown";
    if (n >= 40)   return "Excellent (>40 dB)";
    if (n >= 35)   return "Good (35–40 dB)";
    if (n >= 25)   return "Acceptable (25–35 dB)";
    return "Visibly Degraded (<25 dB)";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — DOWNLOAD UTILITY (defensive duplicate)
   ───────────────────────────────────────────────────────────────────────────── */

if (typeof downloadBlob === "undefined") {
    function downloadBlob(blob, filename) { // eslint-disable-line no-unused-vars
        const objectURL = URL.createObjectURL(blob);
        const anchor    = document.createElement("a");
        anchor.href     = objectURL;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    }
}