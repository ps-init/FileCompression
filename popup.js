/**
 * popup.js
 *
 * Orchestration + UI layer for MACS JC Project 2 Chrome Extension.
 * Handles compression, decompression, and all DOM display logic.
 *
 * Expected HTML element IDs (index.html):
 *   #compress-input       <input type="file">
 *   #compress-btn         <button>
 *   #decompress-input     <input type="file">
 *   #decompress-btn       <button>
 *   #jpeg-quality         <input type="range"> (shown for JPEG files only)
 *   #jpeg-quality-val     <span> showing current quality number
 *   #fileInfoSection      section shown after file pick
 *   #fileName, #fileType, #originalSize
 *   #metricsSection       shown after compression
 *   #metricOriginal, #metricCompressed, #metricRatio, #metricSavings
 *   #metricExtras         extra metrics (PSNR/SSIM or hash)
 *   #downloadCompressed   download button
 *   #reuploadBtn          reveals decompressSection
 *   #decompressSection
 *   #reuploadArea / #decompress-input
 *   #decompress-btn
 *   #verificationSection
 *   #resultsBox
 *   #errorMessage
 *   #loadingSpinner / #loadingText
 */

"use strict";

/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 1 — SESSION STATE
   ───────────────────────────────────────────────────────────────────────────── */

/** Persists data between compress and decompress steps. @type {Object|null} */
let compressionSession = null;


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 2 — FILE TYPE DETECTION
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a category string based on file MIME type / extension.
 * @param {File} file
 * @returns {string|null}
 */
function detectFileCategory(file) {
    const type = file.type.toLowerCase();
    const name = file.name.toLowerCase();
    if (type === "image/jpeg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image-jpeg";
    if (type === "image/png"  || name.endsWith(".png"))                           return "image-png";
    if (type.startsWith("video/") || [".mp4",".mov",".avi",".mkv",".webm"].some(e => name.endsWith(e))) return "video";
    if (type === "text/plain" || type === "text/csv" || name.endsWith(".txt") || name.endsWith(".csv")) return "text";
    if (type.startsWith("audio/") || [".mp3",".wav",".ogg",".aac",".flac"].some(e => name.endsWith(e))) return "audio";
    return null;
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 3 — COMPRESSION ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main compression handler — routes to the correct function by file type,
 * stores session state, and calls displayCompressionResult().
 *
 * @param {File}   file
 * @param {Object} options - { jpegQuality, videoCrf, videoPreset }
 */
// File size limits per type (bytes)
const FILE_SIZE_LIMITS = {
    "image-jpeg": 50  * 1024 * 1024,   // 50 MB
    "image-png":  50  * 1024 * 1024,   // 50 MB
    "text":       10  * 1024 * 1024,   // 10 MB
    "audio":      100 * 1024 * 1024,   // 100 MB
    "video":      500 * 1024 * 1024,   // 500 MB
};

const FILE_SIZE_LABELS = {
    "image-jpeg": "50 MB", "image-png": "50 MB",
    "text": "10 MB", "audio": "100 MB", "video": "500 MB",
};

async function handleCompress(file, options = {}) {
    compressionSession = null;
    hideError();

    // Check 1: Unsupported file type
    const category = detectFileCategory(file);
    if (!category) {
        showError("Unsupported file type: " + file.name + ". Supported: .txt .csv .png .jpg .jpeg .wav .mp3 .mp4");
        return;
    }

    // Check 2: File too large
    const sizeLimit = FILE_SIZE_LIMITS[category];
    if (file.size > sizeLimit) {
        showError(
            "File too large: " + formatBytes(file.size) + ". " +
            "Maximum allowed for " + category + " is " + FILE_SIZE_LABELS[category] + "."
        );
        return;
    }

    // Check 3: Empty file
    if (file.size === 0) {
        showError("File is empty: " + file.name + ". Please select a valid file.");
        return;
    }

    showProgress("Compressing " + file.name + "…");

    try {
        let result;

        switch (category) {

            /* ── JPEG lossy ──────────────────────────────────────────── */
            case "image-jpeg": {
                const quality = Number(options.jpegQuality) || 75;
                result = await compressImageJPEG(file, quality);

                compressionSession = {
                    category:       "image-jpeg",
                    originalPixels: result.originalPixels,
                    originalSize:   result.originalSize,
                    originalWidth:  result.width,
                    originalHeight: result.height,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                };

                displayCompressionResult({
                    type:           "Lossy — JPEG (quality " + result.quality + "/100)",
                    originalSize:   result.originalSizeHR,
                    compressedSize: result.compressedSizeHR,
                    ratio:          result.ratio,
                    savings:        result.savings,
                    qualityMetrics: { psnr: result.psnr, ssim: result.ssim },
                    compressedBlob: result.compressedBlob,
                    downloadName:   file.name.replace(/\.[^.]+$/, "") + "_compressed.jpg",
                });
                break;
            }

            /* ── PNG lossless ────────────────────────────────────────── */
            case "image-png": {
                result = await compressImagePNG(file);

                compressionSession = {
                    category:       "image-png",
                    storedHash:     result.compressedHash,
                    originalSize:   result.originalSize,
                    originalName:   file.name,
                    compressedBlob: result.compressedBlob,
                };

                displayCompressionResult({
                    type:           "Lossless — PNG (DEFLATE via UPNG.js)",
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

            /* ── Video ───────────────────────────────────────────────── */
            case "video": {
                const crf    = Number(options.videoCrf) || 23;
                const preset = options.videoPreset      || "medium";

                if (crf === 0) {
                    // LOSSLESS: GZIP via pako — output is .mp4.gz
                    result = await compressVideoLossless(file, (m) => showLog(m), (r) => showProgress("Compressing… " + Math.round(r*100) + "%"));
                    compressionSession = { category: "video-lossless", storedHash: result.compressedHash, originalMetadata: result.originalMetadata, originalSize: result.originalSize, originalName: file.name, compressedBlob: result.compressedBlob };
                    displayCompressionResult({ type: "Lossless — GZIP via pako", originalSize: result.originalSizeHR, compressedSize: result.compressedSizeHR, ratio: result.ratio, savings: result.savings, hashInfo: { label: "Original SHA-256 (verify rebuild)", hash: result.compressedHash }, compressedBlob: result.compressedBlob, downloadName: file.name.replace(/\.[^.]+$/, "") + "_lossless.mp4.gz" });
                } else {
                    // LOSSY: MediaRecorder → VP9/WebM — output is .webm
                    result = await compressVideoLossy(file, crf, preset, (m) => showLog(m), (r) => showProgress("Encoding… " + Math.round(r*100) + "%"));
                    compressionSession = { category: "video-lossy", originalSize: result.originalSize, originalDurationRaw: result.originalDurationRaw, crfUsed: result.crfUsed, originalName: file.name, compressedBlob: result.compressedBlob };
                    displayCompressionResult({ type: "Lossy — VP9/WebM (MediaRecorder, CRF " + result.crfUsed + ")", originalSize: result.originalSizeHR, compressedSize: result.compressedSizeHR, ratio: result.ratio, savings: result.savings, compressedBlob: result.compressedBlob, downloadName: file.name.replace(/\.[^.]+$/, "") + "_crf" + result.crfUsed + ".webm" });
                }
                break;
            }

            /* ── Text ────────────────────────────────────────────────── */
            case "text": {
                if (typeof compressText !== "function") { showError("Text compression module not loaded."); return; }
                result = await compressText(file);
                compressionSession = { category: "text", storedHash: result.compressedHash, originalSize: result.originalSize, originalName: file.name, compressedBlob: result.compressedBlob };
                displayCompressionResult({ type: "Lossless — " + (result.format || "GZIP"), originalSize: result.originalSizeHR, compressedSize: result.compressedSizeHR, ratio: result.ratio, savings: result.savings, hashInfo: { label: "Compressed SHA-256", hash: result.compressedHash }, compressedBlob: result.compressedBlob, downloadName: file.name + ".gz" });
                break;
            }

            /* ── Audio ───────────────────────────────────────────────── */
            case "audio": {
                if (typeof compressAudio !== "function") { showError("Audio compression module not loaded."); return; }
                result = await compressAudio(file);
                compressionSession = { category: "audio", originalSize: result.originalSize, originalName: file.name, compressedBlob: result.compressedBlob, compressedHash: result.compressedHash || null, audioType: result.type, extension: result.extension };
                const audioLabel = result.type === "lossless" ? "Lossless — WAV compressed with GZIP (pako)" : "Lossy — MP3 compressed with GZIP (pako)";
                const audioExtra = result.type === "lossless"
                    ? { hashInfo: { label: "Original SHA-256 (verify rebuild)", hash: result.compressedHash } }
                    : { bitrateInfo: { original: result.bitrateOriginal, rebuilt: result.bitrateGzipped, reduction: "N/A — GZIP wrapper is lossless", rating: "Quality set at original MP3 encoding" } };
                displayCompressionResult({ type: audioLabel, originalSize: result.originalSizeHR, compressedSize: result.compressedSizeHR, ratio: result.ratio, savings: result.savings, compressedBlob: result.compressedBlob, downloadName: result.outputName, ...audioExtra });
                break;
            }
        }

    } catch (err) {
        showError("Compression failed: " + err.message);
        console.error(err);
    }

    hideProgress();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 4 — DECOMPRESSION ENTRY POINT
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Main decompression/verify handler.
 * @param {File} file - The re-uploaded compressed file
 */
async function handleDecompress(file) {
    if (!compressionSession) {
        showError("No compression session. Please compress a file first.");
        return;
    }

    hideError();
    showProgress("Verifying " + file.name + "…");

    try {
        let result;
        const s = compressionSession;

        switch (s.category) {

            case "image-png": {
                result = await decompressPNG(file, s.storedHash, s.originalName);
                displayDecompressionResult({
                    type:             "PNG — Lossless Rebuild (DEFLATE Verified)",
                    isLossless:       true,
                    hashCheck:        { stored: s.storedHash, rebuilt: result.rebuiltHash, match: result.isMatch },
                    status:           result.status,
                    compressedSize:   result.compressedSizeHR,
                    decompressedSize: result.decompressedSizeHR,
                    dimensions:       result.width + " × " + result.height + " px (" + result.totalPixels.toLocaleString() + " pixels)",
                    fileSizeHR:       result.fileSizeHR,
                    downloadBlob:     result.downloadBlob,
                    downloadName:     result.downloadName,
                });
                break;
            }

            case "image-jpeg": {
                result = await decompressJPEG(file, s.originalPixels, s.originalSize, s.originalWidth, s.originalHeight, s.originalName);
                displayDecompressionResult({
                    type:             "JPEG — Quality Verification (PSNR/SSIM)",
                    isLossless:       false,
                    qualityMetrics:   { psnr: result.psnr, ssim: result.ssim, psnrRating: result.psnrRating },
                    originalSize:     result.originalSizeHR,
                    compressedSize:   result.compressedSizeHR,
                    decompressedSize: result.decompressedSizeHR,
                    dimensions:       result.width + " × " + result.height + " px (" + result.totalPixels.toLocaleString() + " pixels)",
                    ratio:            result.ratio,
                    savings:          result.savings,
                    residualInfo:     result.residualInfo,
                    downloadBlob:     result.downloadBlob,
                    downloadName:     result.downloadName,
                });
                break;
            }

            case "video-lossless": {
                result = await decompressVideoLossless(file, s.storedHash, s.originalMetadata, s.originalSize, s.originalName);
                displayDecompressionResult({ type: "Video — Lossless Rebuild (CRF 0)", isLossless: true, hashCheck: { stored: s.storedHash, rebuilt: result.rebuiltHash, match: result.hashMatch }, checks: result.checks, status: result.status, downloadBlob: result.downloadBlob, downloadName: result.downloadName });
                break;
            }

            case "video-lossy": {
                result = await decompressVideoLossy(file, s.originalSize, s.originalDurationRaw, s.crfUsed, s.originalName);
                displayDecompressionResult({ type: "Video — Lossy (CRF " + s.crfUsed + ")", isLossless: false, bitrateInfo: { original: result.originalBitrate, rebuilt: result.rebuiltBitrate, reduction: result.bitrateReduction, rating: result.bitrateRating }, ratio: result.ratio, savings: result.savings, downloadBlob: result.downloadBlob, downloadName: result.downloadName });
                break;
            }

            case "text": {
                if (typeof decompressText !== "function") { showError("Text decompression module not loaded."); return; }
                result = await decompressText(file, s.storedHash, s.originalName);
                displayDecompressionResult({ type: "Text — Lossless Rebuild", isLossless: true, hashCheck: { stored: s.storedHash, rebuilt: result.rebuiltHash, match: result.isMatch }, status: result.status, downloadBlob: result.downloadBlob, downloadName: result.downloadName });
                break;
            }

            case "audio": {
                if (typeof decompressAudio !== "function") { showError("Audio decompression module not loaded."); return; }
                result = await decompressAudio(file, s, s.originalName);
                displayDecompressionResult({ type: result.type || "Audio Rebuild", isLossless: result.isLossless || false, status: result.status, hashCheck: result.hashCheck || null, downloadBlob: result.downloadBlob, downloadName: result.downloadName });
                break;
            }

            default:
                showError("Unknown session type. Please re-compress.");
        }

    } catch (err) {
        showError("Decompression failed: " + err.message);
        console.error(err);
    }

    hideProgress();
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 5 — UI DISPLAY FUNCTIONS  (real DOM implementations)
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Displays compression metrics in the popup after a successful compression.
 * Populates #metricsSection and wires the download button.
 *
 * @param {Object} data - Result from handleCompress()
 */
function displayCompressionResult(data) {
    // Populate metrics grid
    const el = (id) => document.getElementById(id);

    el("metricOriginal").textContent   = data.originalSize   || "—";
    el("metricCompressed").textContent = data.compressedSize || "—";
    el("metricRatio").textContent      = data.ratio          || "—";
    el("metricSavings").textContent    = data.savings        || "—";

    // Extra metrics — PSNR/SSIM for JPEG, SHA-256 for PNG/text
    const extras = el("metricExtras");
    extras.innerHTML = "";

    if (data.qualityMetrics) {
        extras.innerHTML =
            `<div class="quality-metrics">` +
            `<p><strong>PSNR:</strong> ${data.qualityMetrics.psnr} &nbsp;|&nbsp; ` +
            `<strong>SSIM:</strong> ${data.qualityMetrics.ssim}</p>` +
            `<p class="quality-note">PSNR &gt;40 dB = excellent quality. SSIM closer to 1.0 = better.</p>` +
            `</div>`;
    }

    if (data.hashInfo) {
        extras.innerHTML =
            `<div class="hash-display">` +
            `<p><strong>${data.hashInfo.label}:</strong></p>` +
            `<code class="hash-code">${data.hashInfo.hash}</code>` +
            `</div>`;
    }

    // Wire download button
    const dlBtn = el("downloadCompressed");
    if (dlBtn && data.compressedBlob) {
        dlBtn.onclick = () => downloadBlob(data.compressedBlob, data.downloadName);
        dlBtn.textContent = "⬇️ Download " + data.downloadName;
    }

    // Show metrics section, hide others
    el("metricsSection").style.display    = "block";
    el("decompressSection").style.display = "none";
    el("verificationSection").style.display = "none";
}

/**
 * Displays decompression / rebuild verification results.
 * Populates #verificationSection.
 *
 * @param {Object} data - Result from handleDecompress()
 */
function displayDecompressionResult(data) {
    const resultsBox = document.getElementById("resultsBox");
    if (!resultsBox) return;

    let html = `<h3>${data.type}</h3>`;

    // Hash check (lossless files)
    if (data.hashCheck) {
        const icon = data.hashCheck.match ? "✅" : "❌";
        html += `<div class="verify-status ${data.hashCheck.match ? "pass" : "fail"}">
                    ${icon} ${data.status || (data.hashCheck.match ? "Hashes match — perfect rebuild." : "Hash mismatch.")}
                 </div>`;
        html += `<div class="hash-display">
                    <p><strong>Stored&nbsp;&nbsp;:</strong> <code>${data.hashCheck.stored}</code></p>
                    <p><strong>Rebuilt&nbsp;:</strong> <code>${data.hashCheck.rebuilt}</code></p>
                 </div>`;
    }

    // Quality metrics (lossy images)
    if (data.qualityMetrics) {
        html += `<div class="quality-metrics">
                    <p><strong>PSNR:</strong> ${data.qualityMetrics.psnr} — ${data.qualityMetrics.psnrRating}</p>
                    <p><strong>SSIM:</strong> ${data.qualityMetrics.ssim}</p>
                    ${data.dimensions ? `<p><strong>Dimensions:</strong> ${data.dimensions}</p>` : ""}
                    <hr style="border:none;border-top:1px solid #bbf7d0;margin:6px 0;">
                    <p><strong>📷 Original size:</strong> ${data.originalSize}</p>
                    <p><strong>📦 Compressed (JPEG):</strong> ${data.compressedSize} &nbsp;<span style="color:#dc2626;">↓ ${data.savings} smaller</span></p>
                    <p><strong>📂 Decompressed (raw PNG pixels):</strong> ${data.decompressedSize || "—"} &nbsp;<span style="color:#16a34a;font-weight:700;">↑ full pixel data restored</span></p>
                    <p><strong>Compression Ratio:</strong> ${data.ratio}</p>
                 </div>`;
    }

    // Size comparison for lossless (shows compressed → decompressed size increase)
    if (data.isLossless && data.decompressedSize) {
        html += `<div class="quality-metrics">
                    ${data.dimensions ? `<p><strong>Dimensions:</strong> ${data.dimensions}</p>` : ""}
                    <p><strong>📦 Compressed:</strong> ${data.compressedSize || data.fileSizeHR || "—"}</p>
                    <p><strong>📂 Decompressed (raw pixels):</strong> ${data.decompressedSize} &nbsp;<span style="color:#16a34a;font-weight:700;">↑ larger — full pixel data restored</span></p>
                 </div>`;
    }

    // Residual/delta info (lossy images)
    if (data.residualInfo) {
        html += `<div class="quality-metrics" style="background:#fff8f0;border-color:#fed7aa;">
                    <p><strong>🔬 Residual Analysis (data lost in compression):</strong></p>
                    <p><strong>Max pixel delta:</strong> ${data.residualInfo.maxDelta}</p>
                    <p><strong>Avg pixel delta:</strong> ${data.residualInfo.avgDelta}</p>
                    <p><strong>Affected pixels:</strong> ${data.residualInfo.affectedPixels}</p>
                 </div>`;
    }

    // Bitrate info (lossy video)
    if (data.bitrateInfo) {
        html += `<div class="quality-metrics">
                    <p><strong>Original bitrate:</strong> ${data.bitrateInfo.original}</p>
                    <p><strong>Compressed bitrate:</strong> ${data.bitrateInfo.rebuilt}</p>
                    <p><strong>Bitrate reduction:</strong> ${data.bitrateInfo.reduction}</p>
                    <p><strong>Rating:</strong> ${data.bitrateInfo.rating}</p>
                 </div>`;
    }

    // Multi-check list (lossless video)
    if (data.checks) {
        html += `<ul class="check-list">${data.checks.map(c => `<li>${c}</li>`).join("")}</ul>`;
    }

    // Download button for decompressed file
    if (data.downloadBlob) {
        html += `<button class="btn btn-primary" id="downloadDecompressed" style="margin-top:12px">
                    ⬇️ Download ${data.downloadName}
                 </button>`;
    }

    resultsBox.innerHTML = html;

    // Wire download after HTML is set
    const dlBtn = document.getElementById("downloadDecompressed");
    if (dlBtn && data.downloadBlob) {
        dlBtn.addEventListener("click", () => downloadBlob(data.downloadBlob, data.downloadName));
    }

    document.getElementById("verificationSection").style.display = "block";
}

/**
 * Shows an error message in #errorMessage (in popup, not just console).
 * PDF Section 10.2: errors must appear in the UI.
 *
 * @param {string} message
 */
function showError(message) {
    const el = document.getElementById("errorMessage");
    if (el) {
        el.textContent    = "⚠ " + message;
        el.style.display  = "block";
    }
    console.error("[Error]", message);
}

/** Hides the error message box. */
function hideError() {
    const el = document.getElementById("errorMessage");
    if (el) el.style.display = "none";
}

/**
 * Shows the loading spinner with a status message.
 * @param {string} message
 */
function showProgress(message) {
    const spinner = document.getElementById("loadingSpinner");
    const text    = document.getElementById("loadingText");
    if (spinner) spinner.style.display = "flex";
    if (text)    text.textContent      = message;
}

/** Hides the loading spinner. */
function hideProgress() {
    const spinner = document.getElementById("loadingSpinner");
    if (spinner) spinner.style.display = "none";
}

/**
 * Logs an ffmpeg processing message (optional developer panel).
 * @param {string} message
 */
function showLog(message) {
    console.log("[ffmpeg]", message);
}


/* ─────────────────────────────────────────────────────────────────────────────
   SECTION 6 — EVENT LISTENER WIRING
   ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener("DOMContentLoaded", () => {

    const compressInput   = document.getElementById("compress-input");
    const compressBtn     = document.getElementById("compress-btn");
    const decompressInput = document.getElementById("decompress-input");
    const decompressBtn   = document.getElementById("decompress-btn");
    const reuploadBtn     = document.getElementById("reuploadBtn");
    const uploadArea      = document.getElementById("uploadArea");
    const reuploadArea    = document.getElementById("reuploadArea");
    const qualitySlider   = document.getElementById("jpeg-quality");
    const qualityVal      = document.getElementById("jpeg-quality-val");
    const qualityRow      = document.getElementById("jpeg-quality-row");

    /* ── Click upload area to open file picker ─────────────────────── */
    if (uploadArea && compressInput) {
        uploadArea.addEventListener("click", () => compressInput.click());
    }

    if (reuploadArea && decompressInput) {
        reuploadArea.addEventListener("click", () => decompressInput.click());
    }

    /* ── Show file info when file is selected ──────────────────────── */
    if (compressInput) {
        compressInput.addEventListener("change", () => {
            const file = compressInput.files[0];
            if (!file) return;

            // ── Reset all result sections for new file ──────────────
            const metricsSection      = document.getElementById("metricsSection");
            const decompressSection   = document.getElementById("decompressSection");
            const verificationSection = document.getElementById("verificationSection");
            if (metricsSection)      metricsSection.style.display      = "none";
            if (decompressSection)   decompressSection.style.display   = "none";
            if (verificationSection) verificationSection.style.display = "none";
            compressionSession = null;

            const infoSection = document.getElementById("fileInfoSection");
            if (infoSection) infoSection.style.display = "block";

            const fnEl = document.getElementById("fileName");
            const ftEl = document.getElementById("fileType");
            const fsEl = document.getElementById("originalSize");
            if (fnEl) fnEl.textContent = file.name;
            if (ftEl) ftEl.textContent = file.type || "unknown";
            if (fsEl) fsEl.textContent = formatBytes(file.size);

            // Show correct slider based on file type
            const category = detectFileCategory(file);
            if (qualityRow) qualityRow.style.display = (category === "image-jpeg") ? "block" : "none";
            const crfRow = document.getElementById("video-crf-row");
            if (crfRow) crfRow.style.display = (category === "video") ? "block" : "none";

            hideError();
        });
    }

    /* ── JPEG quality slider live update ───────────────────────────── */
    if (qualitySlider && qualityVal) {
        qualitySlider.addEventListener("input", () => {
            qualityVal.textContent = qualitySlider.value;
        });
    }

    /* ── Video CRF slider live update ──────────────────────────────── */
    const crfSlider = document.getElementById("video-crf");
    const crfVal    = document.getElementById("video-crf-val");
    if (crfSlider && crfVal) {
        crfSlider.addEventListener("input", () => {
            crfVal.textContent = crfSlider.value;
        });
    }

    /* ── Compress button ───────────────────────────────────────────── */
    if (compressBtn) {
        compressBtn.addEventListener("click", () => {
            if (!compressInput || !compressInput.files || compressInput.files.length === 0) {
                showError("Please select a file first.");
                return;
            }
            const file    = compressInput.files[0];
            const options = {
                jpegQuality: qualitySlider ? Number(qualitySlider.value) : 75,
                videoCrf:    document.getElementById("video-crf")    ? Number(document.getElementById("video-crf").value)    : 23,
                videoPreset: document.getElementById("video-preset") ? document.getElementById("video-preset").value         : "medium",
            };
            handleCompress(file, options);
        });
    }

    /* ── Re-upload button (reveal decompression section) ───────────── */
    if (reuploadBtn) {
        reuploadBtn.addEventListener("click", () => {
            const decompressSection = document.getElementById("decompressSection");
            if (decompressSection) decompressSection.style.display = "block";
            decompressSection.scrollIntoView({ behavior: "smooth" });
        });
    }

    /* ── Decompress/verify button ──────────────────────────────────── */
    if (decompressBtn) {
        decompressBtn.addEventListener("click", () => {
            if (!decompressInput || !decompressInput.files || decompressInput.files.length === 0) {
                showError("Please select the compressed file to verify.");
                return;
            }
            handleDecompress(decompressInput.files[0]);
        });
    }

    /* ── Drag and drop support ─────────────────────────────────────── */
    if (uploadArea && compressInput) {
        uploadArea.addEventListener("dragover", (e) => {
            e.preventDefault();
            uploadArea.classList.add("drag-over");
        });
        uploadArea.addEventListener("dragleave", () => {
            uploadArea.classList.remove("drag-over");
        });
        uploadArea.addEventListener("drop", (e) => {
            e.preventDefault();
            uploadArea.classList.remove("drag-over");
            if (e.dataTransfer.files.length > 0) {
                // Assign dropped file to the input
                const dt   = new DataTransfer();
                dt.items.add(e.dataTransfer.files[0]);
                compressInput.files = dt.files;
                compressInput.dispatchEvent(new Event("change"));
            }
        });
    }
});