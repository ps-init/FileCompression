/**
 * imageCompression.js
 *
 * Handles lossy JPEG compression and lossless PNG compression
 * for the MACS JC Project 2 Chrome Extension.
 *
 * Libraries used:
 *   - UPNG.js  (upng.js at repo root) : Optimised PNG encoder with DEFLATE.
 *                                        Requires pako loaded before it.
 *   - pako     (CDN)                  : DEFLATE engine required by UPNG.js.
 *   - JPEG     : Browser Canvas API   : No external library needed.
 *
 * Required load order in HTML:
 *   1. pako CDN
 *   2. upng.js
 *   3. imageCompression.js
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — FILE READING UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads a File object into a raw ArrayBuffer.
 * @param {File} file
 * @returns {Promise<ArrayBuffer>}
 */
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader   = new FileReader();
        reader.onload  = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error("FileReader failed: " + file.name));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Decodes any browser-supported image into raw RGBA pixel data via canvas.
 * Returns data, width, height, and the canvas element for reuse.
 *
 * @param {File|Blob} imageFile
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number, canvas: HTMLCanvasElement}>}
 */
function decodeImageToRGBA(imageFile) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(imageFile);

        img.onload = () => {
            const canvas  = document.createElement("canvas");
            canvas.width  = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx     = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve({ data: imageData.data, width: canvas.width, height: canvas.height, canvas, ctx });
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Failed to decode image: " + imageFile.name));
        };

        img.src = url;
    });
}

/**
 * Alias — decodes a Blob (e.g. compressed JPEG) back to RGBA pixels.
 * Used during decompression to get rebuilt pixels for PSNR/SSIM.
 *
 * @param {Blob} imageBlob
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
function decodeBlobToRGBA(imageBlob) {
    return decodeImageToRGBA(imageBlob);
}

/**
 * Converts a canvas to a JPEG Blob using the browser's native encoder.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality - Float 0.0–1.0
 * @returns {Promise<Blob>}
 */
function canvasToJPEGBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("canvas.toBlob failed.")),
            "image/jpeg",
            quality
        );
    });
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — COMPRESSION METRICS  (PDF Section 6)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compression ratio: originalSize / compressedSize  (PDF 6.1)
 * @param {number} originalSize
 * @param {number} compressedSize
 * @returns {string} e.g. "4.32:1"
 */
function computeCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return "∞:1";
    return (originalSize / compressedSize).toFixed(2) + ":1";
}

/**
 * Space savings percentage  (PDF 6.2)
 * @param {number} originalSize
 * @param {number} compressedSize
 * @returns {string} e.g. "76.85%"
 */
function computeSpaceSavings(originalSize, compressedSize) {
    return (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) + "%";
}

/**
 * Peak Signal-to-Noise Ratio between two RGBA pixel arrays  (PDF 6.3)
 * >40 dB = excellent, <25 dB = visibly degraded.
 *
 * @param {Uint8ClampedArray} originalPixels
 * @param {Uint8ClampedArray} compressedPixels
 * @returns {string} e.g. "37.42 dB"
 */
function computePSNR(originalPixels, compressedPixels) {
    if (originalPixels.length !== compressedPixels.length) return "N/A (size mismatch)";

    let sse = 0;
    const n = originalPixels.length / 4;

    for (let i = 0; i < originalPixels.length; i += 4) {
        const dr = originalPixels[i]     - compressedPixels[i];
        const dg = originalPixels[i + 1] - compressedPixels[i + 1];
        const db = originalPixels[i + 2] - compressedPixels[i + 2];
        sse += (dr * dr + dg * dg + db * db) / 3;
    }

    const mse = sse / n;
    if (mse === 0) return "Identical (∞ dB)";
    return (10 * Math.log10(65025 / mse)).toFixed(2) + " dB";
}

/**
 * Structural Similarity Index between two RGBA pixel arrays  (PDF 6.3)
 * Returns 0–1; 1 = perfect match.
 *
 * @param {Uint8ClampedArray} originalPixels
 * @param {Uint8ClampedArray} compressedPixels
 * @returns {string} e.g. "0.9812"
 */
function computeSSIM(originalPixels, compressedPixels) {
    if (originalPixels.length !== compressedPixels.length) return "N/A (size mismatch)";

    const C1 = (0.01 * 255) ** 2;
    const C2 = (0.03 * 255) ** 2;
    const n  = originalPixels.length / 4;

    const lumA = new Float32Array(n);
    const lumB = new Float32Array(n);

    for (let i = 0; i < n; i++) {
        const o = i * 4;
        lumA[i] = 0.299 * originalPixels[o]   + 0.587 * originalPixels[o+1]   + 0.114 * originalPixels[o+2];
        lumB[i] = 0.299 * compressedPixels[o] + 0.587 * compressedPixels[o+1] + 0.114 * compressedPixels[o+2];
    }

    let muA = 0, muB = 0;
    for (let i = 0; i < n; i++) { muA += lumA[i]; muB += lumB[i]; }
    muA /= n; muB /= n;

    let vA = 0, vB = 0, cov = 0;
    for (let i = 0; i < n; i++) {
        const da = lumA[i] - muA, db = lumB[i] - muB;
        vA += da * da; vB += db * db; cov += da * db;
    }
    vA /= n; vB /= n; cov /= n;

    return (((2 * muA * muB + C1) * (2 * cov + C2)) /
            ((muA * muA + muB * muB + C1) * (vA + vB + C2))).toFixed(4);
}

/**
 * SHA-256 hash via SubtleCrypto — no external library needed  (PDF 6.4)
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} hex string
 */
async function computeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
}

/**
 * Human-readable file size.
 * @param {number} bytes
 * @returns {string} e.g. "2.31 MB"
 */
function formatBytes(bytes) {
    if (bytes < 1024)               return bytes + " B";
    if (bytes < 1048576)            return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1073741824)         return (bytes / 1048576).toFixed(2) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — JPEG LOSSY COMPRESSION  (Canvas API)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses an image to JPEG using the browser's built-in Canvas API.
 *
 * No external library needed. Chrome's native C++ encoder is used via
 * canvas.toBlob("image/jpeg", quality). PSNR and SSIM are computed by
 * decoding the output back to pixels via a second canvas draw.
 *
 * Quality guide:
 *   90–100 = near-original,  70–89 = good balance (default 75),
 *   40–69  = visible artefacts,  10–39 = heavy compression
 *
 * @param {File}   imageFile - Input image (PNG / JPG / WebP etc.)
 * @param {number} quality   - 1–100. Default: 75
 * @returns {Promise<Object>}
 */
async function compressImageJPEG(imageFile, quality = 75) {
    quality = Math.max(1, Math.min(100, Math.round(quality)));

    const originalSize = imageFile.size;
    const { data: originalPixels, width, height, canvas } = await decodeImageToRGBA(imageFile);

    // Composite onto white background (JPEG has no alpha channel)
    const encCanvas = document.createElement("canvas");
    encCanvas.width  = width;
    encCanvas.height = height;
    const encCtx = encCanvas.getContext("2d");
    encCtx.fillStyle = "#ffffff";
    encCtx.fillRect(0, 0, width, height);
    encCtx.drawImage(canvas, 0, 0);

    const compressedBlob = await canvasToJPEGBlob(encCanvas, quality / 100);
    const compressedSize = compressedBlob.size;

    // Decode compressed JPEG back to pixels for quality measurement
    const { data: compressedPixels } = await decodeBlobToRGBA(compressedBlob);

    return {
        type:             "lossy",
        format:           "JPEG",
        compressedBlob,
        originalSize,
        compressedSize,
        originalSizeHR:   formatBytes(originalSize),
        compressedSizeHR: formatBytes(compressedSize),
        ratio:            computeCompressionRatio(originalSize, compressedSize),
        savings:          computeSpaceSavings(originalSize, compressedSize),
        psnr:             computePSNR(originalPixels, compressedPixels),
        ssim:             computeSSIM(originalPixels, compressedPixels),
        originalPixels,   // Uint8ClampedArray — stored in session for decompressJPEG()
        quality,
        width,
        height,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — PNG LOSSLESS COMPRESSION  (UPNG.js + pako)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses an image to PNG using UPNG.js (DEFLATE, lossless).
 *
 * UPNG.js was chosen because it applies genuine DEFLATE compression,
 * guarantees lossless output, and exposes compression level control
 * that the Canvas API does not provide. pako must be loaded before upng.js.
 *
 * @param {File} imageFile - Any browser-supported image format
 * @returns {Promise<Object>}
 */
async function compressImagePNG(imageFile) {
    if (typeof UPNG === "undefined") {
        throw new Error(
            "UPNG is not defined. Make sure pako CDN loads before upng.js, " +
            "and upng.js loads before imageCompression.js."
        );
    }

    const originalBuffer = await readFileAsArrayBuffer(imageFile);
    const originalSize   = imageFile.size;
    const originalHash   = await computeSHA256(originalBuffer);

    const { data: originalPixels, width, height } = await decodeImageToRGBA(imageFile);

    // UPNG.encode(frames, width, height, colorDepth)
    // colorDepth = 0 means auto — preserves full RGBA depth (lossless)
    const compressedBuffer = UPNG.encode([originalPixels.buffer], width, height, 0);
    const compressedSize   = compressedBuffer.byteLength;
    const compressedBlob   = new Blob([compressedBuffer], { type: "image/png" });
    const compressedHash   = await computeSHA256(compressedBuffer);

    return {
        type:             "lossless",
        format:           "PNG",
        compressedBlob,
        originalSize,
        compressedSize,
        originalSizeHR:   formatBytes(originalSize),
        compressedSizeHR: formatBytes(compressedSize),
        ratio:            computeCompressionRatio(originalSize, compressedSize),
        savings:          computeSpaceSavings(originalSize, compressedSize),
        originalHash,
        compressedHash,
        width,
        height,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — REBUILD VERIFICATION  (PDF 6.4)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a PNG rebuild via SHA-256 hash comparison.
 * @param {File}   reuploadedFile
 * @param {string} storedHash
 * @returns {Promise<Object>}
 */
async function verifyPNGRebuild(reuploadedFile, storedHash) {
    const fileBuffer  = await readFileAsArrayBuffer(reuploadedFile);
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;
    return {
        rebuiltHash,
        storedHash,
        isMatch,
        status:       isMatch ? "✅ Perfect rebuild — SHA-256 hashes match" : "❌ Hash mismatch",
        downloadBlob: new Blob([fileBuffer], { type: "image/png" }),
    };
}

/**
 * Verifies a JPEG rebuild by computing PSNR/SSIM against original pixels.
 * Uses Canvas API — no jpeg-js needed.
 *
 * @param {File}              reuploadedFile
 * @param {Uint8ClampedArray} originalPixels
 * @param {number}            originalSize
 * @returns {Promise<Object>}
 */
async function verifyJPEGRebuild(reuploadedFile, originalPixels, originalSize) {
    const { data: rebuiltPixels } = await decodeBlobToRGBA(reuploadedFile);
    const compressedSize          = reuploadedFile.size;
    return {
        psnr:             computePSNR(originalPixels, rebuiltPixels),
        ssim:             computeSSIM(originalPixels, rebuiltPixels),
        originalSizeHR:   formatBytes(originalSize),
        compressedSizeHR: formatBytes(compressedSize),
        ratio:            computeCompressionRatio(originalSize, compressedSize),
        savings:          computeSpaceSavings(originalSize, compressedSize),
        downloadBlob:     reuploadedFile,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — DOWNLOAD UTILITY
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Triggers a browser download for a Blob.
 * @param {Blob}   blob
 * @param {string} filename
 */
function downloadBlob(blob, filename) {
    const url    = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href     = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}