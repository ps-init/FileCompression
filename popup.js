/**
 * popup.js
 *
 * Orchestration layer for the MACS JC Project 2 Chrome Extension.
 *
 * This file is responsible for:
 *   1. Listening to UI events (file uploads, button clicks) from popup.html
 *   2. Calling the correct compression / decompression function based on file type
 *   3. Storing state (originalPixels, storedHash, etc.) between compress and
 *      decompress steps — this is critical for JPEG and lossless video verification
 *   4. Passing results back to the UI display functions
 *
 * What this file does NOT do (UI teammate's responsibility):
 *   - Defining HTML structure (popup.html)
 *   - CSS styling (popup.css)
 *   - The displayResults() and showError() functions called below are stubs —
 *     the UI teammate must implement them in popup.html / popup.css
 *
 * Required script load order in popup.html:
 *   1. lib/jpeg-js.js
 *   2. lib/upng.js
 *   3. https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js  (CDN)
 *   4. imageCompression.js
 *   5. imageDecompression.js
 *   6. videoCompression.js
 *   7. videoDecompression.js
 *   8. textCompression.js       (team member responsible for text)
 *   9. audioCompression.js      (team member responsible for audio)
 *  10. popup.js                 (this file — always last)
 *
 * PDF references: Section 8.1, 10.1, 10.2
 */

"use strict";


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SESSION STATE
   ─────────────────────────────────────────────────────────────────────────────
   State must persist between the compression step and the decompression/verify
   step. These variables live for the duration of the popup session.

   IMPORTANT: Chrome extension popups are destroyed when closed. If the user
   closes and reopens the popup, state is lost and they must re-compress.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Holds all data captured during the most recent compression operation.
 * Reset to null whenever a new file is uploaded for compression.
 *
 * Shape varies by file type — see each compress handler for exact fields.
 * @type {Object|null}
 */
let compressionSession = null;


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — FILE TYPE DETECTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Detects the compression category of a file based on its MIME type.
 * Used to route the file to the correct compression handler.
 *
 * Supported categories: "image-jpeg", "image-png", "video", "text", "audio"
 * Returns null for unsupported file types.
 *
 * @param {File} file - The file uploaded by the user
 * @returns {string|null} Category string or null if unsupported
 */
function detectFileCategory(file) {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();

    if (type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image-jpeg";
    if (type === "image/png"  || name.endsWith(".png"))                           return "image-png";
    if (type.startsWith("video/") || name.endsWith(".mp4") || name.endsWith(".mov") ||
        name.endsWith(".avi")     || name.endsWith(".mkv") || name.endsWith(".webm")) return "video";
    if (type === "text/plain" || type === "text/csv" ||
        name.endsWith(".txt") || name.endsWith(".csv"))                            return "text";
    if (type.startsWith("audio/") || name.endsWith(".mp3") || name.endsWith(".wav")) return "audio";

    return null;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main compression handler. Called when the user selects a file and clicks
 * "Compress" in the popup UI.
 *
 * Routes to the correct compression function, stores session state, and
 * passes results to the UI display layer.
 *
 * @param {File}   file    - The file selected by the user
 * @param {Object} options - Optional settings: { jpegQuality, videoCrf, videoPreset }
 * @returns {Promise<void>}
 */
async function handleCompress(file, options = {}) {
    // Reset previous session whenever a new compression starts
    compressionSession = null;

    const category = detectFileCategory(file);

    if (!category) {
        showError(
            "Unsupported file type: " + file.type + " (" + file.name + "). " +
            "Supported types: .txt, .csv, .png, .jpg, .mp3, .wav, .mp4, .mov, .avi, .mkv, .webm"
        );
        return;
    }

    showProgress("Compressing " + file.name + "…");

    try {
        let result;

        switch (category) {

            // ── JPEG lossy ────────────────────────────────────────────────
            case "image-jpeg": {
                const quality = Number(options.jpegQuality) || 75;
                result = await compressImageJPEG(file, quality);

                // Store everything needed for JPEG decompression verification
                compressionSession = {
                    category:       "image-jpeg",
                    originalPixels: result.originalPixels,   // Uint8ClampedArray — needed by decompressJPEG()
                    originalSize:   result.originalSize,
                    originalWidth:  result.width,
                    originalHeight: result.height,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                };

                displayCompressionResult({
                    type:             "Lossy — JPEG",
                    originalSize:     result.originalSizeHR,
                    compressedSize:   result.compressedSizeHR,
                    ratio:            result.ratio,
                    savings:          result.savings,
                    qualityMetrics:   { psnr: result.psnr, ssim: result.ssim },
                    compressedBlob:   result.compressedBlob,
                    downloadName:     file.name.replace(/\.[^.]+$/, "") + "_compressed.jpg",
                });
                break;
            }

            // ── PNG lossless ──────────────────────────────────────────────
            case "image-png": {
                result = await compressImagePNG(file);

                // Store hash for PNG rebuild verification
                compressionSession = {
                    category:       "image-png",
                    storedHash:     result.compressedHash,   // SHA-256 of compressed PNG
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                };

                displayCompressionResult({
                    type:           "Lossless — PNG",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    hashInfo:       { label: "Compressed SHA-256", hash: result.compressedHash },
                    compressedBlob: result.compressedBlob,
                    downloadName:   file.name.replace(/\.[^.]+$/, "") + "_compressed.png",
                });
                break;
            }

            // ── Video (lossy + lossless offered as options) ───────────────
            case "video": {
                const crf    = Number(options.videoCrf)    || 23;
                const preset = options.videoPreset         || "medium";

                if (crf === 0) {
                    // Lossless path
                    result = await compressVideoLossless(
                        file,
                        (msg)   => showLog(msg),
                        (ratio) => showProgress("Encoding… " + Math.round(ratio * 100) + "%")
                    );

                    compressionSession = {
                        category:        "video-lossless",
                        storedHash:      result.compressedHash,
                        originalMetadata:result.originalMetadata,
                        originalSize:    result.originalSize,
                        originalName:    file.name,
                        compressedBlob:  result.compressedBlob,
                    };

                    displayCompressionResult({
                        type:             "Lossless — H.264 CRF 0",
                        originalSize:     result.originalSizeHR,
                        compressedSize:   result.compressedSizeHR,
                        ratio:            result.ratio,
                        savings:          result.savings,
                        videoInfo:        {
                            originalBitrate:     result.originalBitrate,
                            compressedBitrate:   result.compressedBitrate,
                            originalDuration:    result.originalDuration,
                            originalDimensions:  result.originalDimensions,
                        },
                        hashInfo:         { label: "Compressed SHA-256", hash: result.compressedHash },
                        integrityStatus:  result.integrityStatus,
                        compressedBlob:   result.compressedBlob,
                        downloadName:     file.name.replace(/\.[^.]+$/, "") + "_lossless.mp4",
                    });

                } else {
                    // Lossy path
                    result = await compressVideoLossy(
                        file, crf, preset,
                        (msg)      => showLog(msg),
                        (progress) => showProgress("Encoding… " + Math.round(progress * 100) + "%")
                    );

                    compressionSession = {
                        category:           "video-lossy",
                        originalSize:       result.originalSize,
                        originalDurationRaw:result.originalDurationRaw,
                        crfUsed:            result.crfUsed,
                        originalName:       file.name,
                        compressedBlob:     result.compressedBlob,
                    };

                    displayCompressionResult({
                        type:           "Lossy — H.264 CRF " + result.crfUsed,
                        originalSize:   result.originalSizeHR,
                        compressedSize: result.compressedSizeHR,
                        ratio:          result.ratio,
                        savings:        result.savings,
                        videoInfo:      {
                            originalBitrate:    result.originalBitrate,
                            compressedBitrate:  result.compressedBitrate,
                            originalDuration:   result.originalDuration,
                            originalDimensions: result.originalDimensions,
                        },
                        compressedBlob: result.compressedBlob,
                        downloadName:   file.name.replace(/\.[^.]+$/, "") + "_crf" + result.crfUsed + ".mp4",
                    });
                }
                break;
            }

            // ── Text (handled by textCompression.js — teammate's file) ────
            case "text": {
                if (typeof compressText !== "function") {
                    showError("Text compression module is not loaded. Ensure textCompression.js is included.");
                    return;
                }
                result = await compressText(file);

                compressionSession = {
                    category:       "text",
                    storedHash:     result.compressedHash,
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                };

                displayCompressionResult({
                    type:           "Lossless — " + (result.format || "GZIP"),
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    hashInfo:       { label: "Compressed SHA-256", hash: result.compressedHash },
                    compressedBlob: result.compressedBlob,
                    downloadName:   file.name + ".gz",
                });
                break;
            }

            // ── Audio (handled by audioCompression.js — teammate's file) ──
            case "audio": {
                if (typeof compressAudio !== "function") {
                    showError("Audio compression module is not loaded. Ensure audioCompression.js is included.");
                    return;
                }
                result = await compressAudio(file);

                compressionSession = {
                    category:       "audio",
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                    storedHash:     result.compressedHash || null,
                };

                displayCompressionResult({
                    type:           result.type === "lossless" ? "Lossless — FLAC" : "Lossy — MP3",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    compressedBlob: result.compressedBlob,
                    downloadName:   file.name.replace(/\.[^.]+$/, "") + (result.type === "lossless" ? ".flac" : ".mp3"),
                });
                break;
            }
        }

    } catch (error) {
        showError("Compression failed: " + error.message);
        console.error("Compression error:", error);
    }

    hideProgress();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — DECOMPRESSION / REBUILD VERIFICATION ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main decompression handler. Called when the user re-uploads a compressed
 * file and clicks "Verify / Decompress" in the popup UI.
 *
 * Requires compressionSession to be populated — i.e., the user must have
 * compressed a file in this session before attempting to decompress.
 *
 * @param {File} file - The compressed file re-uploaded by the user
 * @returns {Promise<void>}
 */
async function handleDecompress(file) {
    if (!compressionSession) {
        showError(
            "No compression session found. Please compress a file first before verifying. " +
            "If you closed and reopened the extension, you will need to re-compress."
        );
        return;
    }

    showProgress("Verifying and decompressing " + file.name + "…");

    try {
        let result;
        const session = compressionSession;

        switch (session.category) {

            // ── PNG lossless verification ─────────────────────────────────
            case "image-png": {
                result = await decompressPNG(file, session.storedHash, session.originalName);

                displayDecompressionResult({
                    type:           "PNG — Lossless Rebuild",
                    isLossless:     true,
                    hashCheck:      {
                        stored:  session.storedHash,
                        rebuilt: result.rebuiltHash,
                        match:   result.isMatch,
                    },
                    status:         result.status,
                    fileSizeHR:     result.fileSizeHR,
                    downloadBlob:   result.downloadBlob,
                    downloadName:   result.downloadName,
                });
                break;
            }

            // ── JPEG lossy quality verification ──────────────────────────
            case "image-jpeg": {
                result = await decompressJPEG(
                    file,
                    session.originalPixels,
                    session.originalSize,
                    session.originalWidth,
                    session.originalHeight,
                    session.originalName
                );

                displayDecompressionResult({
                    type:           "JPEG — Lossy Quality Verification",
                    isLossless:     false,
                    qualityMetrics: {
                        psnr:       result.psnr,
                        ssim:       result.ssim,
                        psnrRating: result.psnrRating,
                    },
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    downloadBlob:   result.downloadBlob,
                    downloadName:   result.downloadName,
                });
                break;
            }

            // ── Lossless video verification ───────────────────────────────
            case "video-lossless": {
                result = await decompressVideoLossless(
                    file,
                    session.storedHash,
                    session.originalMetadata,
                    session.originalSize,
                    session.originalName
                );

                displayDecompressionResult({
                    type:           "Video — Lossless Rebuild (CRF 0)",
                    isLossless:     true,
                    hashCheck:      {
                        stored:  session.storedHash,
                        rebuilt: result.rebuiltHash,
                        match:   result.hashMatch,
                    },
                    checks:         result.checks,
                    status:         result.status,
                    originalSize:   result.originalSizeHR,
                    rebuiltSize:    result.rebuiltSizeHR,
                    originalDuration:   result.originalDuration,
                    rebuiltDuration:    result.rebuiltDuration,
                    originalDimensions: result.originalDimensions,
                    rebuiltDimensions:  result.rebuiltDimensions,
                    downloadBlob:   result.downloadBlob,
                    downloadName:   result.downloadName,
                });
                break;
            }

            // ── Lossy video bitrate comparison ────────────────────────────
            case "video-lossy": {
                result = await decompressVideoLossy(
                    file,
                    session.originalSize,
                    session.originalDurationRaw,
                    session.crfUsed,
                    session.originalName
                );

                displayDecompressionResult({
                    type:           "Video — Lossy Quality Verification (CRF " + session.crfUsed + ")",
                    isLossless:     false,
                    bitrateInfo:    {
                        original:         result.originalBitrate,
                        rebuilt:          result.rebuiltBitrate,
                        reduction:        result.bitrateReduction,
                        rating:           result.bitrateRating,
                    },
                    originalSize:   result.originalSizeHR,
                    rebuiltSize:    result.rebuiltSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    downloadBlob:   result.downloadBlob,
                    downloadName:   result.downloadName,
                });
                break;
            }

            // ── Text lossless verification ────────────────────────────────
            case "text": {
                if (typeof decompressText !== "function") {
                    showError("Text decompression module is not loaded.");
                    return;
                }
                result = await decompressText(file, session.storedHash, session.originalName);

                displayDecompressionResult({
                    type:       "Text — Lossless Rebuild",
                    isLossless: true,
                    hashCheck:  {
                        stored:  session.storedHash,
                        rebuilt: result.rebuiltHash,
                        match:   result.isMatch,
                    },
                    status:      result.status,
                    downloadBlob:result.downloadBlob,
                    downloadName:result.downloadName,
                });
                break;
            }

            // ── Audio verification ────────────────────────────────────────
            case "audio": {
                if (typeof decompressAudio !== "function") {
                    showError("Audio decompression module is not loaded.");
                    return;
                }
                result = await decompressAudio(file, session, session.originalName);

                displayDecompressionResult({
                    type:        result.type || "Audio — Rebuild",
                    isLossless:  result.isLossless || false,
                    status:      result.status,
                    downloadBlob:result.downloadBlob,
                    downloadName:result.downloadName,
                });
                break;
            }

            default:
                showError("Unknown session category: " + session.category + ". Please re-compress the file.");
        }

    } catch (error) {
        showError("Decompression failed: " + error.message);
        console.error("Decompression error:", error);
    }

    hideProgress();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — UI INTERFACE STUBS
   ─────────────────────────────────────────────────────────────────────────────
   These functions are called by the orchestration logic above.
   The UI teammate MUST implement these in popup.html / popup.css.
   They are defined here as stubs so this file does not crash if the UI
   teammate's implementation is not yet ready during development.

   Each stub logs to console so you can test orchestration logic independently.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Displays compression results in the popup UI.
 * UI teammate: replace this stub with real DOM manipulation.
 *
 * @param {Object} data - Result object from handleCompress()
 */
function displayCompressionResult(data) {
    // STUB — UI teammate implements this
    console.log("[displayCompressionResult]", data);
}

/**
 * Displays decompression / rebuild verification results in the popup UI.
 * UI teammate: replace this stub with real DOM manipulation.
 *
 * @param {Object} data - Result object from handleDecompress()
 */
function displayDecompressionResult(data) {
    // STUB — UI teammate implements this
    console.log("[displayDecompressionResult]", data);
}

/**
 * Shows a user-facing error message in the popup UI (NOT just console).
 * PDF Section 10.2: "Error messages must be shown in the popup UI itself."
 * UI teammate: replace this stub with real DOM manipulation.
 *
 * @param {string} message - Human-readable error description
 */
function showError(message) {
    // STUB — UI teammate implements this
    console.error("[showError]", message);
    alert("Error: " + message); // fallback for development only — remove in final build
}

/**
 * Shows a progress message or percentage during long operations (e.g. video encoding).
 * UI teammate: replace this stub.
 *
 * @param {string} message - e.g. "Encoding… 42%"
 */
function showProgress(message) {
    // STUB — UI teammate implements this
    console.log("[showProgress]", message);
}

/** Hides the progress indicator after an operation completes. */
function hideProgress() {
    // STUB — UI teammate implements this
    console.log("[hideProgress]");
}

/**
 * Logs an ffmpeg or processing message (optional — for developer visibility).
 * UI teammate: can display this in a collapsible log panel if desired.
 *
 * @param {string} message - Log line from ffmpeg.wasm or other libraries
 */
function showLog(message) {
    // STUB — UI teammate may implement this
    console.log("[ffmpeg log]", message);
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — EVENT LISTENER WIRING
   ─────────────────────────────────────────────────────────────────────────────
   Wires DOM elements from popup.html to the orchestration functions above.

   Expected element IDs in popup.html (UI teammate must match these exactly):
     #compress-input       <input type="file"> for the file to compress
     #compress-btn         <button> to trigger compression
     #decompress-input     <input type="file"> for the file to verify/decompress
     #decompress-btn       <button> to trigger decompression
     #jpeg-quality         <input type="range" min="1" max="100"> (images only)
     #video-crf            <input type="range" min="0" max="51"> (video only)
     #video-preset         <select> with preset options (video only)
   ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {

    const compressInput   = document.getElementById("compress-input");
    const compressBtn     = document.getElementById("compress-btn");
    const decompressInput = document.getElementById("decompress-input");
    const decompressBtn   = document.getElementById("decompress-btn");

    // ── Compress button ───────────────────────────────────────────────────
    if (compressBtn) {
        compressBtn.addEventListener("click", () => {
            if (!compressInput || !compressInput.files || compressInput.files.length === 0) {
                showError("Please select a file to compress first.");
                return;
            }

            const file    = compressInput.files[0];
            const options = {
                jpegQuality:  document.getElementById("jpeg-quality")  ? Number(document.getElementById("jpeg-quality").value)  : 75,
                videoCrf:     document.getElementById("video-crf")     ? Number(document.getElementById("video-crf").value)     : 23,
                videoPreset:  document.getElementById("video-preset")  ? document.getElementById("video-preset").value          : "medium",
            };

            handleCompress(file, options);
        });
    }

    // ── Decompress / verify button ────────────────────────────────────────
    if (decompressBtn) {
        decompressBtn.addEventListener("click", () => {
            if (!decompressInput || !decompressInput.files || decompressInput.files.length === 0) {
                showError("Please select the compressed file to verify/decompress.");
                return;
            }

            handleDecompress(decompressInput.files[0]);
        });
    }
});