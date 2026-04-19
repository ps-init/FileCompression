// ═══════════════════════════════════════════════════════════════════
// FILE COMPRESSOR EXTENSION - popup.js
// ═══════════════════════════════════════════════════════════════════
// This handles all the UI logic and file interactions
// Teammates will plug their compression functions into the placeholders

// State management - store the current file and its data
let appState = {
    originalFile: null,
    originalData: null,
    compressedData: null,
    compressedFileName: null,
    originalHash: null,
    isCompressed: false
};

// ═══════════════════════════════════════════════════════════════════
// DOM ELEMENTS - Cache all HTML elements we need
// ═══════════════════════════════════════════════════════════════════

const elements = {
    uploadArea: document.getElementById('uploadArea'),
    fileInput: document.getElementById('fileInput'),
    errorMessage: document.getElementById('errorMessage'),
    loadingSpinner: document.getElementById('loadingSpinner'),
    
    // File info section
    fileInfoSection: document.getElementById('fileInfoSection'),
    fileName: document.getElementById('fileName'),
    fileType: document.getElementById('fileType'),
    originalSize: document.getElementById('originalSize'),
    
    // Metrics section
    metricsSection: document.getElementById('metricsSection'),
    metricOriginal: document.getElementById('metricOriginal'),
    metricCompressed: document.getElementById('metricCompressed'),
    metricRatio: document.getElementById('metricRatio'),
    metricSavings: document.getElementById('metricSavings'),
    downloadCompressed: document.getElementById('downloadCompressed'),
    reuploadBtn: document.getElementById('reuploadBtn'),
    
    // Decompression section
    decompressSection: document.getElementById('decompressSection'),
    reuploadArea: document.getElementById('reuploadArea'),
    reuploadInput: document.getElementById('reuploadInput'),
    
    // Verification section
    verificationSection: document.getElementById('verificationSection'),
    resultsBox: document.getElementById('resultsBox')
};

// ═══════════════════════════════════════════════════════════════════
// EVENT LISTENERS - Attach all event handlers
// ═══════════════════════════════════════════════════════════════════

// Upload area - click to upload
elements.uploadArea.addEventListener('click', () => {
    elements.fileInput.click();
});

// Upload area - drag and drop
elements.uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.uploadArea.classList.add('drag-over');
});

elements.uploadArea.addEventListener('dragleave', () => {
    elements.uploadArea.classList.remove('drag-over');
});

elements.uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.uploadArea.classList.remove('drag-over');
    handleFileSelect(e.dataTransfer.files[0]);
});

// File input change
elements.fileInput.addEventListener('change', (e) => {
    handleFileSelect(e.target.files[0]);
});

// Download compressed file button
elements.downloadCompressed.addEventListener('click', () => {
    downloadFile(appState.compressedData, appState.compressedFileName);
});

// Re-upload button (to verify decompression)
elements.reuploadBtn.addEventListener('click', () => {
    elements.decompressSection.style.display = 'block';
    elements.reuploadInput.click();
});

// Re-upload area - click
elements.reuploadArea.addEventListener('click', () => {
    elements.reuploadInput.click();
});

// Re-upload area - drag and drop
elements.reuploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.reuploadArea.classList.add('drag-over');
});

elements.reuploadArea.addEventListener('dragleave', () => {
    elements.reuploadArea.classList.remove('drag-over');
});

elements.reuploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.reuploadArea.classList.remove('drag-over');
    handleReupload(e.dataTransfer.files[0]);
});

// Re-upload input change
elements.reuploadInput.addEventListener('change', (e) => {
    handleReupload(e.target.files[0]);
});

// ═══════════════════════════════════════════════════════════════════
// MAIN LOGIC
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle initial file upload
 */
function handleFileSelect(file) {
    if (!file) return;

    // Reset state
    appState = {
        originalFile: file,
        originalData: null,
        compressedData: null,
        compressedFileName: null,
        originalHash: null,
        isCompressed: false
    };

    // Reset UI
    hideError();
    elements.metricsSection.style.display = 'none';
    elements.decompressSection.style.display = 'none';
    elements.verificationSection.style.display = 'none';

    // Check if file type is supported
    const fileType = getFileType(file.name);
    if (!fileType) {
        showError(`❌ Unsupported file type: ${getFileExtension(file.name)}\nSupported: .txt, .csv, .png, .jpg, .wav, .mp3, .mp4`);
        return;
    }

    // Show loading
    showLoading(true);

    // Read the file
    const reader = new FileReader();
    reader.readAsArrayBuffer(file);

    reader.onload = async (e) => {
        try {
            appState.originalData = e.target.result;
            
            // Calculate hash for lossless verification
            if (['text', 'image-png'].includes(fileType)) {
                appState.originalHash = await calculateHash(appState.originalData);
            }

            // Show file info
            showFileInfo(file, fileType);

            // Compress the file
            const compressed = await compressFile(appState.originalData, fileType);
            
            if (!compressed) {
                throw new Error('Compression failed');
            }

            appState.compressedData = compressed;
            appState.compressedFileName = file.name.split('.')[0] + '.compressed';
            appState.isCompressed = true;

            // Show metrics
            showMetrics(appState.originalData, appState.compressedData);
            
            showLoading(false);

        } catch (error) {
            showLoading(false);
            showError(`❌ Error: ${error.message}`);
        }
    };

    reader.onerror = () => {
        showLoading(false);
        showError('❌ Failed to read file');
    };
}

/**
 * Handle re-upload of compressed file for decompression
 */
async function handleReupload(file) {
    if (!file) return;

    showLoading(true);
    elements.verificationSection.style.display = 'none';

    const reader = new FileReader();
    reader.readAsArrayBuffer(file);

    reader.onload = async (e) => {
        try {
            const compressedData = e.target.result;
            const fileType = getFileType(appState.originalFile.name);

            // Decompress
            const decompressed = await decompressFile(compressedData, fileType);
            
            if (!decompressed) {
                throw new Error('Decompression failed');
            }

            // Verify
            let verificationResult = {
                success: false,
                message: '',
                details: []
            };

            if (appState.originalHash) {
                // For lossless files, check hash
                const decompressedHash = await calculateHash(decompressed);
                const hashMatch = decompressedHash === appState.originalHash;
                
                verificationResult.success = hashMatch;
                verificationResult.message = hashMatch 
                    ? '✅ Perfect Match! File decompressed perfectly.' 
                    : '❌ Hash mismatch - file may be corrupted';
                
                verificationResult.details = [
                    { type: 'info', label: 'File Type', value: getFileType(appState.originalFile.name) },
                    { type: 'info', label: 'Original Size', value: formatBytes(appState.originalData.byteLength) },
                    { type: 'info', label: 'Decompressed Size', value: formatBytes(decompressed.byteLength) },
                    { type: 'success', label: 'Hash Verification', value: hashMatch ? 'PASSED ✅' : 'FAILED ❌' }
                ];
            } else {
                // For lossy files, just show size comparison
                verificationResult.success = true;
                verificationResult.message = '✅ Decompression successful (Lossy format - quality may differ)';
                verificationResult.details = [
                    { type: 'info', label: 'File Type', value: getFileType(appState.originalFile.name) },
                    { type: 'info', label: 'Original Size', value: formatBytes(appState.originalData.byteLength) },
                    { type: 'info', label: 'Decompressed Size', value: formatBytes(decompressed.byteLength) }
                ];
            }

            showVerificationResults(verificationResult);
            showLoading(false);

        } catch (error) {
            showLoading(false);
            showError(`❌ Decompression Error: ${error.message}`);
        }
    };

    reader.onerror = () => {
        showLoading(false);
        showError('❌ Failed to read file');
    };
}

// ═══════════════════════════════════════════════════════════════════
// COMPRESSION/DECOMPRESSION FUNCTIONS - Placeholder for teammates
// ═══════════════════════════════════════════════════════════════════

/**
 * Compress file based on type
 * Person 2 (text), Person 3 (image), Person 4 (audio) will implement these
 */
async function compressFile(data, fileType) {
    try {
        switch (fileType) {
            case 'text':
                return compressText(data);
            case 'image-png':
                return compressImagePNG(data);
            case 'image-jpg':
                return compressImageJPEG(data);
            case 'audio-wav':
                return compressAudioWAV(data);
            case 'audio-mp3':
                return compressAudioMP3(data);
            case 'video':
                return compressVideo(data);
            default:
                throw new Error('Unsupported file type for compression');
        }
    } catch (error) {
        throw new Error(`Compression error: ${error.message}`);
    }
}

/**
 * Decompress file based on type
 */
async function decompressFile(data, fileType) {
    try {
        switch (fileType) {
            case 'text':
                return decompressText(data);
            case 'image-png':
                return decompressImagePNG(data);
            case 'image-jpg':
                return decompressImageJPEG(data);
            case 'audio-wav':
                return decompressAudioWAV(data);
            case 'audio-mp3':
                return decompressAudioMP3(data);
            case 'video':
                return decompressVideo(data);
            default:
                throw new Error('Unsupported file type for decompression');
        }
    } catch (error) {
        throw new Error(`Decompression error: ${error.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────
// TEXT COMPRESSION (Person 2 will implement using pako)
// ─────────────────────────────────────────────────────────────────────
function compressText(arrayBuffer) {
    // PLACEHOLDER - Person 2 replaces this
    // Should use: pako.gzip(arrayBuffer) 
    
    if (typeof pako === 'undefined') {
        throw new Error('pako library not loaded');
    }
    
    return pako.gzip(arrayBuffer);
}

function decompressText(arrayBuffer) {
    // PLACEHOLDER - Person 2 replaces this
    // Should use: pako.ungzip(arrayBuffer)
    
    if (typeof pako === 'undefined') {
        throw new Error('pako library not loaded');
    }
    
    return pako.ungzip(arrayBuffer);
}

// ─────────────────────────────────────────────────────────────────────
// IMAGE COMPRESSION (Person 3 will implement using UPNG.js and jpeg-js)
// ─────────────────────────────────────────────────────────────────────
function compressImagePNG(arrayBuffer) {
    // PLACEHOLDER - Person 3 replaces this
    // Should use: UPNG.js library
    
    if (typeof UPNG === 'undefined') {
        throw new Error('UPNG.js library not loaded');
    }
    
    // For now, just return a smaller version as placeholder
    return new Uint8Array(arrayBuffer.slice(0, Math.floor(arrayBuffer.byteLength * 0.7)));
}

function decompressImagePNG(arrayBuffer) {
    // PLACEHOLDER - Person 3 replaces this
    return new Uint8Array(arrayBuffer);
}

function compressImageJPEG(arrayBuffer) {
    // PLACEHOLDER - Person 3 replaces this
    // Should use: jpeg-js library
    
    if (typeof jpegjs === 'undefined') {
        throw new Error('jpeg-js library not loaded');
    }
    
    return new Uint8Array(arrayBuffer.slice(0, Math.floor(arrayBuffer.byteLength * 0.6)));
}

function decompressImageJPEG(arrayBuffer) {
    // PLACEHOLDER - Person 3 replaces this
    return new Uint8Array(arrayBuffer);
}

// ─────────────────────────────────────────────────────────────────────
// AUDIO COMPRESSION (Person 4 will implement using lamejs)
// ─────────────────────────────────────────────────────────────────────
function compressAudioWAV(arrayBuffer) {
    // PLACEHOLDER - Person 4 replaces this
    // Should use: lamejs library to convert WAV → MP3
    
    if (typeof lamejs === 'undefined') {
        throw new Error('lamejs library not loaded');
    }
    
    return new Uint8Array(arrayBuffer.slice(0, Math.floor(arrayBuffer.byteLength * 0.3)));
}

function decompressAudioWAV(arrayBuffer) {
    // PLACEHOLDER - Person 4 replaces this
    return new Uint8Array(arrayBuffer);
}

function compressAudioMP3(arrayBuffer) {
    // MP3 is already compressed, return as-is
    return new Uint8Array(arrayBuffer);
}

function decompressAudioMP3(arrayBuffer) {
    // MP3 doesn't need decompression
    return new Uint8Array(arrayBuffer);
}

// ─────────────────────────────────────────────────────────────────────
// VIDEO COMPRESSION (Person 4 will implement using ffmpeg.wasm)
// ─────────────────────────────────────────────────────────────────────
function compressVideo(arrayBuffer) {
    // PLACEHOLDER - Person 4 replaces this
    // Should use: ffmpeg.wasm library (heavy, ~30MB)
    
    throw new Error('Video compression requires ffmpeg.wasm - implement with caution');
}

function decompressVideo(arrayBuffer) {
    // PLACEHOLDER - Person 4 replaces this
    return new Uint8Array(arrayBuffer);
}

// ═══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS - Hash, File type detection, formatting
// ═══════════════════════════════════════════════════════════════════

/**
 * Calculate SHA-256 hash of data (for verification)
 * Uses browser's built-in SubtleCrypto API
 */
async function calculateHash(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Detect file type from file extension
 */
function getFileType(filename) {
    const ext = getFileExtension(filename).toLowerCase();
    
    const typeMap = {
        'txt': 'text',
        'csv': 'text',
        'png': 'image-png',
        'jpg': 'image-jpg',
        'jpeg': 'image-jpg',
        'wav': 'audio-wav',
        'mp3': 'audio-mp3',
        'mp4': 'video'
    };
    
    return typeMap[ext] || null;
}

/**
 * Get file extension from filename
 */
function getFileExtension(filename) {
    return filename.split('.').pop();
}

/**
 * Format bytes to human readable size
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Calculate compression ratio
 */
function getCompressionRatio(originalSize, compressedSize) {
    if (compressedSize === 0) return '∞';
    return (originalSize / compressedSize).toFixed(2);
}

/**
 * Calculate space saved percentage
 */
function getSpaceSaved(originalSize, compressedSize) {
    if (originalSize === 0) return '0';
    return (((originalSize - compressedSize) / originalSize) * 100).toFixed(1);
}

// ═══════════════════════════════════════════════════════════════════
// UI DISPLAY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Show file information
 */
function showFileInfo(file, fileType) {
    elements.fileName.textContent = file.name;
    elements.fileType.textContent = fileType;
    elements.originalSize.textContent = formatBytes(file.size);
    elements.fileInfoSection.style.display = 'block';
}

/**
 * Show compression metrics
 */
function showMetrics(originalData, compressedData) {
    const originalSize = originalData.byteLength;
    const compressedSize = compressedData.byteLength;
    const ratio = getCompressionRatio(originalSize, compressedSize);
    const savings = getSpaceSaved(originalSize, compressedSize);

    elements.metricOriginal.textContent = formatBytes(originalSize);
    elements.metricCompressed.textContent = formatBytes(compressedSize);
    elements.metricRatio.textContent = ratio + ':1';
    elements.metricSavings.textContent = savings + '%';
    
    elements.metricsSection.style.display = 'block';
}

/**
 * Show verification results after decompression
 */
function showVerificationResults(result) {
    let html = '';
    
    // Main message
    html += `<div class="result-item ${result.success ? 'result-success' : 'result-error'}">`;
    html += `<span class="result-icon">${result.success ? '✅' : '❌'}</span>`;
    html += `<span class="result-text"><strong>${result.message}</strong></span>`;
    html += '</div>';
    
    // Details
    result.details.forEach(detail => {
        const icon = detail.type === 'success' ? '✅' : 'ℹ️';
        html += `<div class="result-item">`;
        html += `<span class="result-icon">${icon}</span>`;
        html += `<span class="result-text"><strong>${detail.label}:</strong> ${detail.value}</span>`;
        html += '</div>';
    });
    
    elements.resultsBox.innerHTML = html;
    elements.verificationSection.style.display = 'block';
}

/**
 * Show error message
 */
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.style.display = 'block';
}

/**
 * Hide error message
 */
function hideError() {
    elements.errorMessage.style.display = 'none';
}

/**
 * Show/hide loading spinner
 */
function showLoading(show) {
    elements.loadingSpinner.style.display = show ? 'flex' : 'none';
}

/**
 * Download file
 */
function downloadFile(data, filename) {
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

console.log('📦 File Compressor Extension loaded');