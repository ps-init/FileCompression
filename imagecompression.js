/**
 * imageCompression.js
 *
 * Handles lossy JPEG compression and lossless PNG compression
 * for the MACS JC Project 2 Chrome Extension.
 *
 * Libraries used:
 *   - UPNG.js  (lib/upng.js) : Optimised PNG encoder with DEFLATE compression.
 *                               Chosen for its lossless guarantee and compression
 *                               level control unavailable in the Canvas API.
 *
 *   - JPEG     : Uses the browser's built-in Canvas API (canvas.toBlob with
 *                "image/jpeg" mime type). No external library required.
 *                Chrome's native JPEG encoder is faster, always available,
 *                and produces smaller files than pure-JS alternatives.
 *
 * Required load order in HTML:
 *   1. lib/upng.js
 *   2. imageCompression.js
 */


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — FILE READING UTILITIES
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Reads a File object into a raw ArrayBuffer.
 * Used to get the original byte content for hashing.
 *
 * @param {File} file - Any File object from an <input type="file">
 * @returns {Promise<ArrayBuffer>} The raw byte contents of the file
 */
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (event) => resolve(event.target.result);
        reader.onerror = () => reject(new Error("FileReader failed for: " + file.name));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Decodes any browser-supported image file into raw RGBA pixel data
 * by drawing it onto an offscreen canvas.
 *
 * The returned `data` is a Uint8ClampedArray where every 4 values
 * represent one pixel as [R, G, B, A].
 *
 * @param {File|Blob} imageFile - The image to decode
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number, canvas: HTMLCanvasElement}>}
 */
function decodeImageToRGBA(imageFile) {
    return new Promise((resolve, reject) => {
        const image     = new Image();
        const objectURL = URL.createObjectURL(imageFile);

        image.onload = () => {
            const canvas  = document.createElement("canvas");
            canvas.width  = image.naturalWidth;
            canvas.height = image.naturalHeight;

            const context   = canvas.getContext("2d");
            context.drawImage(image, 0, 0);

            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(objectURL);

            resolve({
                data:    imageData.data,
                width:   canvas.width,
                height:  canvas.height,
                canvas,          // returned so JPEG encoder can reuse it
                context,
            });
        };

        image.onerror = () => {
            URL.revokeObjectURL(objectURL);
            reject(new Error("Failed to decode image: " + imageFile.name));
        };

        image.src = objectURL;
    });
}

/**
 * Reads the pixel data out of a Blob that contains a JPEG (or any image).
 * Used during decompression to get the rebuilt pixel array for PSNR/SSIM.
 *
 * @param {Blob} imageBlob - An image blob (JPEG, PNG, etc.)
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
function decodeBlobToRGBA(imageBlob) {
    return decodeImageToRGBA(imageBlob);
}

/**
 * Converts a canvas to a JPEG Blob using the browser's native encoder.
 * Quality is a float 0.0–1.0 (we convert from 1–100 scale before calling).
 *
 * @param {HTMLCanvasElement} canvas  - Canvas with the image drawn on it
 * @param {number}            quality - Float 0.0–1.0
 * @returns {Promise<Blob>} JPEG blob
 */
function canvasToJPEGBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (blob) resolve(blob);
                else reject(new Error("canvas.toBlob failed — browser could not encode JPEG."));
            },
            "image/jpeg",
            quality
        );
    });
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — COMPRESSION METRICS  (PDF Section 6)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Computes the compression ratio (PDF Section 6.1).
 * Formula: originalSize / compressedSize
 *
 * @param {number} originalSize   - Original file size in bytes
 * @param {number} compressedSize - Compressed file size in bytes
 * @returns {string} e.g. "4.32:1"
 */
function computeCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return "∞:1";
    return (originalSize / compressedSize).toFixed(2) + ":1";
}

/**
 * Computes the space savings percentage (PDF Section 6.2).
 * Formula: ((original - compressed) / original) × 100
 *
 * @param {number} originalSize   - Original file size in bytes
 * @param {number} compressedSize - Compressed file size in bytes
 * @returns {string} e.g. "76.85%"
 */
function computeSpaceSavings(originalSize, compressedSize) {
    const percentage = ((originalSize - compressedSize) / originalSize) * 100;
    return percentage.toFixed(2) + "%";
}

/**
 * Computes Peak Signal-to-Noise Ratio (PSNR) between original and compressed
 * pixel arrays (PDF Section 6.3). Higher is better.
 * Threshold: >40 dB = excellent, <25 dB = visibly degraded.
 * Only RGB channels used; alpha is excluded.
 *
 * @param {Uint8ClampedArray} originalPixels   - RGBA pixels of original image
 * @param {Uint8ClampedArray} compressedPixels - RGBA pixels of compressed image
 * @returns {string} e.g. "37.42 dB"
 */
function computePSNR(originalPixels, compressedPixels) {
    if (originalPixels.length !== compressedPixels.length) {
        return "N/A (size mismatch)";
    }

    let sumSquaredError = 0;
    const totalPixels   = originalPixels.length / 4;

    for (let i = 0; i < originalPixels.length; i += 4) {
        const redDiff   = originalPixels[i]     - compressedPixels[i];
        const greenDiff = originalPixels[i + 1] - compressedPixels[i + 1];
        const blueDiff  = originalPixels[i + 2] - compressedPixels[i + 2];
        sumSquaredError += (redDiff * redDiff + greenDiff * greenDiff + blueDiff * blueDiff) / 3;
    }

    const meanSquaredError = sumSquaredError / totalPixels;
    if (meanSquaredError === 0) return "Identical (∞ dB)";

    return (10 * Math.log10((255 * 255) / meanSquaredError)).toFixed(2) + " dB";
}

/**
 * Computes the Structural Similarity Index (SSIM) between original and compressed
 * images using luminance values (PDF Section 6.3). Returns 0–1; 1 = perfect match.
 *
 * @param {Uint8ClampedArray} originalPixels   - RGBA pixels of original image
 * @param {Uint8ClampedArray} compressedPixels - RGBA pixels of compressed image
 * @returns {string} e.g. "0.9812"
 */
function computeSSIM(originalPixels, compressedPixels) {
    if (originalPixels.length !== compressedPixels.length) {
        return "N/A (size mismatch)";
    }

    const C1         = (0.01 * 255) ** 2;
    const C2         = (0.03 * 255) ** 2;
    const pixelCount = originalPixels.length / 4;

    const luminanceOriginal   = new Float32Array(pixelCount);
    const luminanceCompressed = new Float32Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        const byteOffset = i * 4;
        luminanceOriginal[i]   = 0.299 * originalPixels[byteOffset]   + 0.587 * originalPixels[byteOffset + 1]   + 0.114 * originalPixels[byteOffset + 2];
        luminanceCompressed[i] = 0.299 * compressedPixels[byteOffset] + 0.587 * compressedPixels[byteOffset + 1] + 0.114 * compressedPixels[byteOffset + 2];
    }

    let meanOriginal   = 0;
    let meanCompressed = 0;
    for (let i = 0; i < pixelCount; i++) {
        meanOriginal   += luminanceOriginal[i];
        meanCompressed += luminanceCompressed[i];
    }
    meanOriginal   /= pixelCount;
    meanCompressed /= pixelCount;

    let varianceOriginal   = 0;
    let varianceCompressed = 0;
    let covariance         = 0;
    for (let i = 0; i < pixelCount; i++) {
        const diffOriginal   = luminanceOriginal[i]   - meanOriginal;
        const diffCompressed = luminanceCompressed[i] - meanCompressed;
        varianceOriginal   += diffOriginal   * diffOriginal;
        varianceCompressed += diffCompressed * diffCompressed;
        covariance         += diffOriginal   * diffCompressed;
    }
    varianceOriginal   /= pixelCount;
    varianceCompressed /= pixelCount;
    covariance         /= pixelCount;

    const numerator   = (2 * meanOriginal * meanCompressed + C1) * (2 * covariance + C2);
    const denominator = (meanOriginal ** 2 + meanCompressed ** 2 + C1) * (varianceOriginal + varianceCompressed + C2);

    return (numerator / denominator).toFixed(4);
}

/**
 * Computes a SHA-256 hash of raw bytes using the built-in SubtleCrypto Web API.
 * No external library needed — available natively in Chrome (PDF Section 6.4).
 *
 * @param {ArrayBuffer} buffer - The file bytes to hash
 * @returns {Promise<string>} Lowercase hex-encoded SHA-256 string
 */
async function computeSHA256(buffer) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashBytes  = Array.from(new Uint8Array(hashBuffer));
    return hashBytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Formats a raw byte count into a human-readable string.
 *
 * @param {number} bytes - File size in bytes
 * @returns {string} e.g. "2.31 MB"
 */
function formatBytes(bytes) {
    if (bytes < 1024)               return bytes + " B";
    if (bytes < 1024 * 1024)        return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — JPEG LOSSY COMPRESSION  (Canvas API — no external library)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses an image to JPEG using the browser's built-in Canvas API.
 *
 * Why Canvas API instead of jpeg-js:
 *   - No external library needed — works in every Chrome version
 *   - Uses Chrome's native C++ JPEG encoder — faster and smaller output
 *   - The quality parameter (0–100) maps directly to canvas.toBlob quality (0.0–1.0)
 *   - Output blob can be decoded back to pixels via a second canvas draw,
 *     allowing PSNR/SSIM measurement just as accurately as jpeg-js would
 *
 * Quality guide:
 *   90–100 = near-original quality, large file
 *   70–89  = good balance (recommended default: 75)
 *   40–69  = visible artefacts, much smaller
 *   10–39  = heavy compression, very small
 *
 * @param {File}   imageFile - Input image (PNG, JPG, WebP, GIF, etc.)
 * @param {number} quality   - JPEG quality 1–100. Default: 75
 * @returns {Promise<Object>} Result with compressedBlob, size metrics, PSNR, SSIM
 */
async function compressImageJPEG(imageFile, quality = 75) {
    quality = Math.max(1, Math.min(100, Math.round(quality)));

    const originalSize = imageFile.size;

    // Step 1 — Decode the input image to RGBA pixels via canvas
    const { data: originalPixels, width, height, canvas } = await decodeImageToRGBA(imageFile);

    // Step 2 — Re-draw onto a fresh canvas (strips alpha, which JPEG doesn't support)
    //           A white background is composited first so transparent areas go white
    const encodeCanvas    = document.createElement("canvas");
    encodeCanvas.width    = width;
    encodeCanvas.height   = height;
    const encodeContext   = encodeCanvas.getContext("2d");
    encodeContext.fillStyle = "#ffffff";
    encodeContext.fillRect(0, 0, width, height);
    encodeContext.drawImage(canvas, 0, 0);

    // Step 3 — Encode to JPEG blob using the native browser encoder
    //           quality is converted from 1–100 scale to 0.0–1.0 for toBlob
    const compressedBlob = await canvasToJPEGBlob(encodeCanvas, quality / 100);
    const compressedSize = compressedBlob.size;

    // Step 4 — Decode the JPEG blob back to pixels to measure quality loss
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
        originalPixels,   // saved in session state for decompressJPEG()
        quality,
        width,
        height,
    };
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — PNG LOSSLESS COMPRESSION  (UPNG.js)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Compresses an image to PNG using UPNG.js with DEFLATE lossless compression.
 *
 * UPNG.js was chosen because it:
 *   - Applies genuine DEFLATE compression to reduce PNG file size
 *   - Guarantees lossless output (colorDepth = 0 preserves full RGBA)
 *   - Gives compression control that the Canvas API does not expose
 *
 * @param {File} imageFile - Input image (any browser-supported format)
 * @returns {Promise<Object>} Result with compressedBlob, metrics, SHA-256 hashes
 */
async function compressImagePNG(imageFile) {
    if (typeof UPNG === "undefined") {
        throw new Error("UPNG.js is not loaded. Add <script src='lib/upng.js'> before imageCompression.js.");
    }

    const originalBuffer = await readFileAsArrayBuffer(imageFile);
    const originalSize   = imageFile.size;
    const originalHash   = await computeSHA256(originalBuffer);

    const { data: originalPixels, width, height } = await decodeImageToRGBA(imageFile);

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
   SECTION 5 — REBUILD VERIFICATION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Verifies a PNG rebuild by comparing the SHA-256 of the re-uploaded file
 * against the hash stored during compression (PDF Section 6.4).
 *
 * @param {File}   reuploadedFile - The compressed PNG uploaded back by the user
 * @param {string} storedHash     - SHA-256 hash returned by compressImagePNG()
 * @returns {Promise<Object>} Verification result with match status and download blob
 */
async function verifyPNGRebuild(reuploadedFile, storedHash) {
    const fileBuffer  = await readFileAsArrayBuffer(reuploadedFile);
    const rebuiltHash = await computeSHA256(fileBuffer);
    const isMatch     = rebuiltHash === storedHash;

    return {
        rebuiltHash,
        storedHash,
        isMatch,
        status: isMatch
            ? "✅ Perfect rebuild — SHA-256 hashes match"
            : "❌ Hash mismatch — file may have been modified",
        downloadBlob: new Blob([fileBuffer], { type: "image/png" }),
    };
}

/**
 * Verifies a JPEG rebuild by computing PSNR and SSIM between the original
 * pixel data and the re-decoded JPEG (PDF Section 8.1).
 *
 * Uses Canvas API to decode the JPEG — no jpeg-js required.
 *
 * @param {File}              reuploadedFile   - The compressed JPEG uploaded back
 * @param {Uint8ClampedArray} originalPixels   - Pixel data saved from compressImageJPEG()
 * @param {number}            originalSize     - Original file size in bytes
 * @returns {Promise<Object>} Quality metrics and download blob
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
 * Triggers a file download in the browser for a given Blob.
 *
 * @param {Blob}   blob     - The file data to download
 * @param {string} filename - The filename shown in the save dialog
 * @returns {void}
 */
function downloadBlob(blob, filename) {
    const objectURL = URL.createObjectURL(blob);
    const anchor    = document.createElement("a");
    anchor.href     = objectURL;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}