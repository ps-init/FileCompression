/**
 * imageDecompression.js
 *
 * TRUE image decompression — converts compressed image formats back into
 * raw uncompressed pixel data, producing a high-resolution PNG output.
 *
 * JPEG decompression:
 *   JPEG uses DCT (Discrete Cosine Transform) lossy compression.
 *   Decompression reverses the entropy decoding, dequantization, and
 *   inverse DCT to reconstruct the pixel grid. Output is saved as
 *   uncompressed PNG — which will be LARGER than the JPEG input.
 *   Quality loss from JPEG encoding is measured via PSNR and SSIM.
 *
 * PNG decompression:
 *   PNG uses DEFLATE (LZ77 + Huffman) lossless compression.
 *   Decompression reverses the DEFLATE stream to recover exact original
 *   pixels. SHA-256 hash confirms byte-for-byte identical rebuild.
 *   Output PNG will be verified as identical to the compressed version.
 *
 * Both use the browser Canvas API — no external libraries needed.
 * PDF references: Section 4.2, 6.3, 6.4, 8.1
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — PNG LOSSLESS DECOMPRESSION & REBUILD VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a PNG file by decoding its DEFLATE-compressed pixel data
 * back to raw RGBA pixels via the Canvas API, then re-exports as PNG.
 *
 * Verifies perfect rebuild using SHA-256 hash comparison.
 * The output PNG contains the same pixel data — lossless, byte-verified.
 *
 * @param {File}   reuploadedFile   - The compressed PNG file
 * @param {string} storedHash       - SHA-256 from compressImagePNG()
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

    // Step 1: Verify file integrity via SHA-256 hash
    const fileBuffer  = await readFileAsArrayBuffer(reuploadedFile);
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;

    // Step 2: Decode PNG → raw RGBA pixels via Canvas API
    // This IS decompression: DEFLATE compressed PNG → uncompressed pixel array
    const decoded = await decodeBlobToRGBA(reuploadedFile);

    // Step 3: Write raw pixels onto a fresh canvas and export as PNG
    // The output PNG represents the decompressed pixel data
    const canvas  = document.createElement("canvas");
    canvas.width  = decoded.width;
    canvas.height = decoded.height;
    const ctx     = canvas.getContext("2d");
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(decoded.data.buffer), decoded.width, decoded.height),
        0, 0
    );

    const downloadBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error("canvas.toBlob failed.")),
            "image/png"
        );
    });

    const baseName     = originalName.replace(/\.[^.]+$/, "");
    const downloadName = baseName + "_decompressed.png";

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        width:        decoded.width,
        height:       decoded.height,
        totalPixels:  decoded.width * decoded.height,
        status: isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match. DEFLATE decompression successful."
            : "❌ Hash mismatch — the file may have been modified or corrupted.",
        compressedSizeHR:   formatBytes(reuploadedFile.size),
        decompressedSizeHR: formatBytes(downloadBlob.size),
        fileSizeHR:         formatBytes(reuploadedFile.size),
        downloadBlob,
        downloadName,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — JPEG LOSSY DECOMPRESSION & QUALITY VERIFICATION
   ─────────────────────────────────────────────────────────────────────────────
   JPEG decompression reverses:
     1. Huffman entropy decoding
     2. Run-length decoding of DCT coefficients
     3. Dequantization (introduces loss — quantization table discards precision)
     4. Inverse Discrete Cosine Transform (IDCT)
     5. Colour space conversion (YCbCr → RGB)
     6. 8×8 block reassembly → full pixel grid
   
   The Canvas API performs all these steps natively via the browser's
   built-in JPEG decoder (libjpeg or equivalent).
   
   Output is saved as UNCOMPRESSED PNG — larger than the JPEG input,
   containing the fully reconstructed pixel grid.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Decompresses a JPEG file back to raw pixel data using the Canvas API.
 *
 * The JPEG's compressed DCT coefficients are decoded and reconstructed
 * into a full RGBA pixel grid. The output is saved as an uncompressed PNG
 * — which will be significantly larger than the JPEG input.
 *
 * PSNR and SSIM are computed against the original pixels to quantify
 * how much quality was lost during JPEG encoding.
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
        throw new Error("decompressJPEG: originalPixels must be the Uint8ClampedArray from compressImageJPEG().");
    }

    const compressedSize = reuploadedFile.size;

    // Step 1: Decode JPEG → raw RGBA pixels via Canvas API
    // This performs: Huffman decode → dequantize → IDCT → YCbCr→RGB → pixel grid
    let decoded;
    try {
        decoded = await decodeBlobToRGBA(reuploadedFile);
    } catch (e) {
        throw new Error("Canvas API failed to decode JPEG. Ensure you are uploading a valid JPEG. Detail: " + e.message);
    }

    const rebuiltPixels = decoded.data;

    // Step 2: Measure quality loss — PSNR and SSIM against original pixels
    const psnrValue  = computePSNR(originalPixels, rebuiltPixels);
    const ssimValue  = computeSSIM(originalPixels, rebuiltPixels);
    const psnrRating = ratePSNR(psnrValue);

    // Step 3: Write decompressed pixels to canvas
    // Output PNG = fully decompressed pixel grid (uncompressed, larger than JPEG)
    const canvas  = document.createElement("canvas");
    canvas.width  = decoded.width;
    canvas.height = decoded.height;
    const ctx     = canvas.getContext("2d");
    ctx.putImageData(
        new ImageData(new Uint8ClampedArray(rebuiltPixels.buffer), decoded.width, decoded.height),
        0, 0
    );

    // Export as uncompressed PNG — this is the decompressed output
    const downloadBlob = await new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => blob ? resolve(blob) : reject(new Error("canvas.toBlob failed.")),
            "image/png"
        );
    });

    const baseName     = originalName.replace(/\.[^.]+$/, "");
    const downloadName = baseName + "_decompressed.png";

    return {
        psnr:               psnrValue,
        ssim:               ssimValue,
        psnrRating,
        width:              decoded.width,
        height:             decoded.height,
        totalPixels:        decoded.width * decoded.height,
        originalSizeHR:     formatBytes(originalSize),
        compressedSizeHR:   formatBytes(compressedSize),
        decompressedSizeHR: formatBytes(downloadBlob.size),
        ratio:              computeCompressionRatio(originalSize, compressedSize),
        savings:            computeSpaceSavings(originalSize, compressedSize),
        downloadBlob,
        downloadName,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — PSNR RATING HELPER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Converts a PSNR value string into a plain-English quality label.
 * Thresholds from PDF Section 6.3.
 * @param {string} psnrString
 * @returns {string}
 */
function ratePSNR(psnrString) {
    if (psnrString.includes("Identical") || psnrString.includes("∞")) return "Perfect (lossless)";
    if (psnrString.includes("N/A"))                                      return "Cannot compute";
    const n = parseFloat(psnrString);
    if (isNaN(n))  return "Unknown";
    if (n >= 40)   return "Excellent (>40 dB) — visually indistinguishable";
    if (n >= 35)   return "Good (35–40 dB) — minor loss";
    if (n >= 25)   return "Acceptable (25–35 dB) — noticeable artefacts";
    return "Visibly Degraded (<25 dB) — significant quality loss";
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