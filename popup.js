/**
 * popup.js
 *
 * Orchestration and UI layer for the MACS JC Project 2 Chrome Extension.
 * Wires DOM events from index.html to the compression/decompression modules,
 * stores session state between steps, and renders results into the popup.
 *
 * Element IDs used (must match index.html exactly):
 *   #fileInput           - <input type="file"> for the original file
 *   #uploadArea          - clickable upload zone
 *   #fileInfoSection     - section shown after file is picked
 *   #fileName            - span displaying file name
 *   #fileType            - span displaying file type
 *   #originalSize        - span displaying original size
 *   #metricsSection      - section shown after compression
 *   #metricOriginal      - compression result: original size
 *   #metricCompressed    - compression result: compressed size
 *   #metricRatio         - compression result: ratio
 *   #metricSavings       - compression result: space saved
 *   #downloadCompressed  - button to download compressed file
 *   #reuploadBtn         - button to reveal decompression section
 *   #decompressSection   - section for re-uploading compressed file
 *   #reuploadArea        - clickable re-upload zone
 *   #reuploadInput       - <input type="file"> for compressed file
 *   #verificationSection - section showing rebuild/verify results
 *   #resultsBox          - container for verification result cards
 *   #errorMessage        - error display div
 *   #loadingSpinner      - loading overlay
 */

"use strict";


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SESSION STATE
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Holds data from the most recent compression step.
 * Required for decompression verification — stores original pixels,
 * hashes, and metadata depending on file type.
 * Reset to null whenever a new file is uploaded.
 *
 * @type {Object|null}
 */
let compressionSession = null;

/**
 * Holds the Blob of the most recently compressed file.
 * Used by the download button.
 *
 * @type {Blob|null}
 */
let compressedFileBlob = null;

/**
 * Holds the suggested download filename for the compressed file.
 *
 * @type {string}
 */
let compressedFileName = "compressed_file";


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — FILE TYPE DETECTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Detects the compression category of a file from its MIME type or extension.
 * Returns null for unsupported types.
 *
 * @param {File} file - The file uploaded by the user
 * @returns {string|null} One of: "image-jpeg", "image-png", "video", "text", "audio", or null
 */
function detectFileCategory(file) {
    const mimeType = file.type.toLowerCase();
    const fileName = file.name.toLowerCase();

    if (mimeType === "image/jpeg" || fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image-jpeg";
    if (mimeType === "image/png"  || fileName.endsWith(".png"))                               return "image-png";
    if (mimeType.startsWith("video/") || fileName.endsWith(".mp4") || fileName.endsWith(".mov") ||
        fileName.endsWith(".avi")     || fileName.endsWith(".mkv") || fileName.endsWith(".webm")) return "video";
    if (mimeType === "text/plain" || mimeType === "text/csv" ||
        fileName.endsWith(".txt") || fileName.endsWith(".csv"))                               return "text";
    if (mimeType.startsWith("audio/") || fileName.endsWith(".mp3") || fileName.endsWith(".wav")) return "audio";

    return null;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION HANDLER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main compression entry point. Called when the user selects a file.
 * Routes to the correct module, stores session state, and updates the UI.
 *
 * @param {File} file - The file selected by the user
 * @returns {Promise<void>}
 */
async function handleCompress(file) {
    compressionSession = null;
    compressedFileBlob = null;

    const category = detectFileCategory(file);

    if (!category) {
        showError(
            "Unsupported file type: \"" + file.name + "\". " +
            "Please upload a .txt, .csv, .png, .jpg, .mp3, .wav, or .mp4 file."
        );
        return;
    }

    showSpinner();

    try {
        let result;

        switch (category) {

            // ── JPEG lossy ────────────────────────────────────────────────
            case "image-jpeg": {
                result = await compressImageJPEG(file, 75);

                compressionSession = {
                    category:       "image-jpeg",
                    originalPixels: result.originalPixels,
                    originalSize:   result.originalSize,
                    originalWidth:  result.width,
                    originalHeight: result.height,
                    originalName:   file.name,
                };

                compressedFileBlob = result.compressedBlob;
                compressedFileName = file.name.replace(/\.[^.]+$/, "") + "_compressed.jpg";

                displayCompressionResult({
                    type:           "Lossy — JPEG",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    extraLines:     [
                        "PSNR: " + result.psnr,
                        "SSIM: " + result.ssim,
                    ],
                });
                break;
            }

            // ── PNG lossless ──────────────────────────────────────────────
            case "image-png": {
                result = await compressImagePNG(file);

                compressionSession = {
                    category:       "image-png",
                    storedHash:     result.compressedHash,
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                };

                compressedFileBlob = result.compressedBlob;
                compressedFileName = file.name.replace(/\.[^.]+$/, "") + "_compressed.png";

                displayCompressionResult({
                    type:           "Lossless — PNG",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    extraLines:     [
                        "SHA-256: " + result.compressedHash.slice(0, 20) + "…",
                    ],
                });
                break;
            }

            // ── Video ─────────────────────────────────────────────────────
            case "video": {
                result = await compressVideoLossy(
                    file, 23, "medium",
                    (msg)      => appendLog(msg),
                    (progress) => updateSpinnerText("Encoding… " + Math.round(progress * 100) + "%")
                );

                compressionSession = {
                    category:            "video-lossy",
                    originalSize:        result.originalSize,
                    originalDurationRaw: result.originalDurationRaw,
                    crfUsed:             result.crfUsed,
                    originalName:        file.name,
                };

                compressedFileBlob = result.compressedBlob;
                compressedFileName = file.name.replace(/\.[^.]+$/, "") + "_crf23.mp4";

                displayCompressionResult({
                    type:           "Lossy — H.264 CRF 23",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    extraLines:     [
                        "Original bitrate: "    + result.originalBitrate,
                        "Compressed bitrate: "  + result.compressedBitrate,
                        "Duration: "            + result.compressedDuration,
                        "Dimensions: "          + result.compressedDimensions,
                    ],
                });
                break;
            }

            // ── Text ──────────────────────────────────────────────────────
            case "text": {
                if (typeof compressText !== "function") {
                    showError("Text compression module not loaded. Check that textcompression.js is included.");
                    hideSpinner();
                    return;
                }
                result = await compressText(file);

                compressionSession = {
                    category:       "text",
                    storedHash:     result.compressedHash,
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                };

                compressedFileBlob = result.compressedBlob;
                compressedFileName = file.name + ".gz";

                displayCompressionResult({
                    type:           "Lossless — " + (result.format || "GZIP"),
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    extraLines:     [
                        "SHA-256: " + (result.compressedHash || "").slice(0, 20) + "…",
                    ],
                });
                break;
            }

            // ── Audio ─────────────────────────────────────────────────────
            case "audio": {
                if (typeof compressAudio !== "function") {
                    showError("Audio compression module not loaded. Check that audiocompression.js is included.");
                    hideSpinner();
                    return;
                }
                result = await compressAudio(file);

                compressionSession = {
                    category:       "audio",
                    originalSize:   result.originalSize,
                    storedHash:     result.compressedHash || null,
                    originalName:   file.name,
                };

                compressedFileBlob = result.compressedBlob;
                compressedFileName = file.name.replace(/\.[^.]+$/, "") + (result.type === "lossless" ? ".flac" : ".mp3");

                displayCompressionResult({
                    type:           result.type === "lossless" ? "Lossless — FLAC" : "Lossy — MP3",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    extraLines:     [],
                });
                break;
            }
        }

    } catch (error) {
        showError("Compression failed: " + error.message);
    }

    hideSpinner();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — DECOMPRESSION / VERIFICATION HANDLER
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main decompression entry point. Called when the user re-uploads the compressed file.
 * Requires compressionSession to be set from a previous handleCompress() call.
 *
 * @param {File} file - The compressed file re-uploaded by the user
 * @returns {Promise<void>}
 */
async function handleDecompress(file) {
    if (!compressionSession) {
        showError(
            "No compression session found. Please compress a file first. " +
            "If you closed and reopened the extension, you will need to re-compress."
        );
        return;
    }

    showSpinner();

    try {
        let result;
        const session = compressionSession;

        switch (session.category) {

            // ── PNG lossless rebuild ──────────────────────────────────────
            case "image-png": {
                result = await decompressPNG(file, session.storedHash, session.originalName);

                displayVerificationResult({
                    type:    "PNG — Lossless Rebuild",
                    lines:   [
                        result.status,
                        "Stored hash:  " + session.storedHash.slice(0, 20) + "…",
                        "Rebuilt hash: " + result.rebuiltHash.slice(0, 20) + "…",
                    ],
                    success:     result.isMatch,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            // ── JPEG lossy quality check ──────────────────────────────────
            case "image-jpeg": {
                result = await decompressJPEG(
                    file,
                    session.originalPixels,
                    session.originalSize,
                    session.originalWidth,
                    session.originalHeight,
                    session.originalName
                );

                displayVerificationResult({
                    type:  "JPEG — Lossy Quality Verification",
                    lines: [
                        "PSNR: "          + result.psnr,
                        "SSIM: "          + result.ssim,
                        "Space saved: "   + result.savings,
                        "Ratio: "         + result.ratio,
                    ],
                    success:      true,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            // ── Video lossy bitrate check ─────────────────────────────────
            case "video-lossy": {
                result = await decompressVideoLossy(
                    file,
                    session.originalSize,
                    session.originalDurationRaw,
                    session.crfUsed,
                    session.originalName
                );

                displayVerificationResult({
                    type:  "Video — Bitrate Comparison (CRF " + session.crfUsed + ")",
                    lines: [
                        "Original bitrate:  " + result.originalBitrate,
                        "Rebuilt bitrate:   " + result.rebuiltBitrate,
                        "Bitrate reduction: " + result.bitrateReduction,
                        "Space saved: "       + result.savings,
                    ],
                    success:      true,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            // ── Video lossless hash check ─────────────────────────────────
            case "video-lossless": {
                result = await decompressVideoLossless(
                    file,
                    session.storedHash,
                    session.originalMetadata,
                    session.originalSize,
                    session.originalName
                );

                displayVerificationResult({
                    type:  "Video — Lossless Rebuild (CRF 0)",
                    lines: [
                        result.status,
                        "Duration match: "    + (result.durationMatch    ? "✅ Yes" : "❌ No"),
                        "Dimensions match: "  + (result.dimensionsMatch  ? "✅ Yes" : "❌ No"),
                        "Hash match: "        + (result.hashMatch        ? "✅ Yes" : "❌ No"),
                    ],
                    success:      result.fullyVerified,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            // ── Text lossless rebuild ─────────────────────────────────────
            case "text": {
                if (typeof decompressText !== "function") {
                    showError("Text decompression module not loaded.");
                    hideSpinner();
                    return;
                }
                result = await decompressText(file, session.storedHash, session.originalName);

                displayVerificationResult({
                    type:  "Text — Lossless Rebuild",
                    lines: [
                        result.status,
                        "Stored hash:  " + (session.storedHash || "").slice(0, 20) + "…",
                        "Rebuilt hash: " + (result.rebuiltHash || "").slice(0, 20) + "…",
                    ],
                    success:      result.isMatch,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            // ── Audio rebuild ─────────────────────────────────────────────
            case "audio": {
                if (typeof decompressAudio !== "function") {
                    showError("Audio decompression module not loaded.");
                    hideSpinner();
                    return;
                }
                result = await decompressAudio(file, session, session.originalName);

                displayVerificationResult({
                    type:         result.type || "Audio — Rebuild",
                    lines:        [result.status || ""],
                    success:      true,
                    downloadBlob: result.downloadBlob,
                    downloadName: result.downloadName,
                });
                break;
            }

            default:
                showError("Unknown session type. Please re-compress the file.");
        }

    } catch (error) {
        showError("Verification failed: " + error.message);
    }

    hideSpinner();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — DOM DISPLAY FUNCTIONS
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Populates the file info section with the selected file's details.
 *
 * @param {File} file - The file selected by the user
 * @returns {void}
 */
function displayFileInfo(file) {
    document.getElementById("fileName").textContent    = file.name;
    document.getElementById("fileType").textContent    = file.type || "Unknown";
    document.getElementById("originalSize").textContent = formatFileSizeDisplay(file.size);
    document.getElementById("fileInfoSection").style.display = "block";
}

/**
 * Populates the compression metrics section with results.
 *
 * @param {Object} data
 * @param {string} data.type           - e.g. "Lossy — JPEG"
 * @param {string} data.originalSize   - Human-readable original size
 * @param {string} data.compressedSize - Human-readable compressed size
 * @param {string} data.ratio          - e.g. "3.21:1"
 * @param {string} data.savings        - e.g. "68.84%"
 * @param {string[]} data.extraLines   - Additional lines shown in the results box
 * @returns {void}
 */
function displayCompressionResult(data) {
    document.getElementById("metricOriginal").textContent   = data.originalSize;
    document.getElementById("metricCompressed").textContent = data.compressedSize;
    document.getElementById("metricRatio").textContent      = data.ratio;
    document.getElementById("metricSavings").textContent    = data.savings;

    // Show extra info (PSNR/SSIM, bitrate, hash preview) in the results box
    const resultsBox = document.getElementById("resultsBox");
    let extraHTML = `<div class="result-item result-success">
        <span class="result-icon">✅</span>
        <span class="result-text"><strong>${data.type}</strong> — compression complete</span>
    </div>`;

    if (data.extraLines && data.extraLines.length > 0) {
        data.extraLines.forEach(line => {
            extraHTML += `<div class="result-item">
                <span class="result-icon">📊</span>
                <span class="result-text">${line}</span>
            </div>`;
        });
    }

    resultsBox.innerHTML = extraHTML;

    document.getElementById("metricsSection").style.display      = "block";
    document.getElementById("verificationSection").style.display = "block";
    hideError();
}

/**
 * Populates the verification results section after decompression/rebuild.
 * Also provides a download button for the rebuilt file.
 *
 * @param {Object} data
 * @param {string}   data.type         - Verification type label
 * @param {string[]} data.lines        - Lines to display in the results box
 * @param {boolean}  data.success      - Whether verification passed
 * @param {Blob}     data.downloadBlob - File to offer for download
 * @param {string}   data.downloadName - Filename for download
 * @returns {void}
 */
function displayVerificationResult(data) {
    const resultsBox  = document.getElementById("resultsBox");
    const statusClass = data.success ? "result-success" : "result-error";
    const statusIcon  = data.success ? "✅" : "❌";

    let html = `<div class="result-item ${statusClass}">
        <span class="result-icon">${statusIcon}</span>
        <span class="result-text"><strong>${data.type}</strong></span>
    </div>`;

    data.lines.forEach(line => {
        if (line) {
            html += `<div class="result-item">
                <span class="result-icon">📋</span>
                <span class="result-text">${line}</span>
            </div>`;
        }
    });

    if (data.downloadBlob && data.downloadName) {
        html += `<div style="margin-top:12px;">
            <button class="btn btn-primary" id="downloadRebuilt">⬇️ Download Rebuilt File</button>
        </div>`;
    }

    resultsBox.innerHTML = html;
    document.getElementById("verificationSection").style.display = "block";

    if (data.downloadBlob && data.downloadName) {
        document.getElementById("downloadRebuilt").addEventListener("click", () => {
            triggerDownload(data.downloadBlob, data.downloadName);
        });
    }
}

/**
 * Shows a user-facing error message in the popup (PDF Section 10.2).
 * Error is shown in the UI, not just the console.
 *
 * @param {string} message - Human-readable error description
 * @returns {void}
 */
function showError(message) {
    const errorEl = document.getElementById("errorMessage");
    errorEl.textContent    = "⚠️ " + message;
    errorEl.style.display  = "block";
    hideSpinner();
}

/**
 * Hides the error message banner.
 *
 * @returns {void}
 */
function hideError() {
    const errorEl = document.getElementById("errorMessage");
    errorEl.style.display = "none";
    errorEl.textContent   = "";
}

/**
 * Shows the loading spinner with an optional message.
 *
 * @param {string} [message] - Optional text to show under the spinner
 * @returns {void}
 */
function showSpinner(message = "Processing file...") {
    const spinner = document.getElementById("loadingSpinner");
    const textEl  = spinner.querySelector("p");
    if (textEl) textEl.textContent = message;
    spinner.style.display = "flex";
}

/**
 * Updates the spinner's status text during long operations like video encoding.
 *
 * @param {string} message - Progress message e.g. "Encoding… 42%"
 * @returns {void}
 */
function updateSpinnerText(message) {
    const spinner = document.getElementById("loadingSpinner");
    const textEl  = spinner.querySelector("p");
    if (textEl) textEl.textContent = message;
}

/**
 * Hides the loading spinner.
 *
 * @returns {void}
 */
function hideSpinner() {
    document.getElementById("loadingSpinner").style.display = "none";
}

/**
 * Appends an ffmpeg log line to the browser console.
 * Not shown in the popup UI to keep it clean.
 *
 * @param {string} message - Log message from ffmpeg.wasm
 * @returns {void}
 */
function appendLog(message) {
    console.log("[ffmpeg]", message);
}

/**
 * Returns a human-readable file size string from raw bytes.
 * Used for the file info section before compression.
 *
 * @param {number} bytes - File size in bytes
 * @returns {string} e.g. "2.31 MB"
 */
function formatFileSizeDisplay(bytes) {
    if (bytes < 1024)                  return bytes + " B";
    if (bytes < 1024 * 1024)           return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

/**
 * Triggers a file download in the browser for a given Blob.
 *
 * @param {Blob} blob       - The file data to download
 * @param {string} filename - Filename shown in the save dialog
 * @returns {void}
 */
function triggerDownload(blob, filename) {
    const objectURL = URL.createObjectURL(blob);
    const anchor    = document.createElement("a");
    anchor.href     = objectURL;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — EVENT LISTENER WIRING
   ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {

    const fileInput    = document.getElementById("fileInput");
    const uploadArea   = document.getElementById("uploadArea");
    const reuploadArea = document.getElementById("reuploadArea");
    const reuploadInput= document.getElementById("reuploadInput");
    const downloadBtn  = document.getElementById("downloadCompressed");
    const reuploadBtn  = document.getElementById("reuploadBtn");

    // ── Click on upload area opens file picker ────────────────────────────
    uploadArea.addEventListener("click", () => fileInput.click());

    // ── Drag and drop support ─────────────────────────────────────────────
    uploadArea.addEventListener("dragover", (event) => {
        event.preventDefault();
        uploadArea.classList.add("drag-over");
    });

    uploadArea.addEventListener("dragleave", () => {
        uploadArea.classList.remove("drag-over");
    });

    uploadArea.addEventListener("drop", (event) => {
        event.preventDefault();
        uploadArea.classList.remove("drag-over");
        const droppedFile = event.dataTransfer.files[0];
        if (droppedFile) processSelectedFile(droppedFile);
    });

    // ── File picker change ────────────────────────────────────────────────
    fileInput.addEventListener("change", () => {
        if (fileInput.files && fileInput.files[0]) {
            processSelectedFile(fileInput.files[0]);
        }
    });

    // ── Download compressed file ──────────────────────────────────────────
    downloadBtn.addEventListener("click", () => {
        if (compressedFileBlob) {
            triggerDownload(compressedFileBlob, compressedFileName);
        } else {
            showError("No compressed file available. Please compress a file first.");
        }
    });

    // ── Show decompression section ────────────────────────────────────────
    reuploadBtn.addEventListener("click", () => {
        document.getElementById("decompressSection").style.display = "block";
    });

    // ── Click on re-upload area opens file picker ─────────────────────────
    reuploadArea.addEventListener("click", () => reuploadInput.click());

    // ── Re-upload file selected → run verification ────────────────────────
    reuploadInput.addEventListener("change", () => {
        if (reuploadInput.files && reuploadInput.files[0]) {
            handleDecompress(reuploadInput.files[0]);
        }
    });
});

/**
 * Processes a file selected by the user — shows info and runs compression.
 * Called from both the file picker and drag-and-drop handlers.
 *
 * @param {File} file - The file to process
 * @returns {void}
 */
function processSelectedFile(file) {
    hideError();

    // Reset UI sections from any previous session
    document.getElementById("metricsSection").style.display      = "none";
    document.getElementById("decompressSection").style.display   = "none";
    document.getElementById("verificationSection").style.display = "none";
    document.getElementById("resultsBox").innerHTML              = "";

    displayFileInfo(file);
    handleCompress(file);
}