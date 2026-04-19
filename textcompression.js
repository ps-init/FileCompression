// textcompression.js
// Handles text file (.txt, .csv) compression and decompression
// Uses fflate (GZIP) for lossless compression
// Uses SubtleCrypto (built into Chrome) for SHA-256 hash verification

// Stores the uploaded file's raw data so all functions can access it
let originalFileData = null;
let originalFileName = "";

/**
 * Runs when the user picks a .txt or .csv file.
 * Reads the file into memory as raw bytes.
 */
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  originalFileName = file.name;

  const reader = new FileReader();

  reader.onload = function(e) {
    originalFileData = new Uint8Array(e.target.result);
    document.getElementById("status").textContent = "File loaded: " + originalFileName;
  };

  reader.readAsArrayBuffer(file);
}

/**
 * Runs when the user clicks the Compress button.
 * Compresses the file using GZIP and triggers a download.
 */
function compressFile() {
  if (!originalFileData) {
    document.getElementById("status").textContent = "Error: Please upload a file first.";
    return;
  }

  // fflate.gzipSync does the compression — level 9 = maximum compression
  const compressed = fflate.gzipSync(originalFileData, { level: 9 });

  const originalSize   = originalFileData.length;
  const compressedSize = compressed.length;
  const ratio          = (originalSize / compressedSize).toFixed(2);
  const saving         = (((originalSize - compressedSize) / originalSize) * 100).toFixed(1);

  // Display stats in the popup UI
  document.getElementById("originalSize").textContent   = originalSize + " bytes";
  document.getElementById("compressedSize").textContent = compressedSize + " bytes";
  document.getElementById("ratio").textContent          = ratio + ":1";
  document.getElementById("saving").textContent         = saving + "%";
  document.getElementById("status").textContent         = "Compression complete!";

  // Download the compressed file — .gz is added to signal it's compressed
  downloadFile(compressed, originalFileName + ".gz");
}

/**
 * Runs when the user uploads a .gz file to decompress.
 * Restores the original file and verifies it using SHA-256 hash comparison.
 */
async function handleDecompressUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();

  reader.onload = async function(e) {
    const compressedData = new Uint8Array(e.target.result);

    // fflate.decompressSync reverses the compression
    const decompressed = fflate.decompressSync(compressedData);

    // Compute SHA-256 fingerprint of both files
    const originalHash = await computeHash(originalFileData);
    const rebuiltHash  = await computeHash(decompressed);

    // Show both hashes in the UI
    document.getElementById("originalHash").textContent = originalHash;
    document.getElementById("rebuiltHash").textContent  = rebuiltHash;

    // Compare — identical hashes = perfect lossless rebuild
    if (originalHash === rebuiltHash) {
      document.getElementById("verifyResult").textContent = "✓ Perfect match — lossless rebuild confirmed";
      document.getElementById("verifyResult").style.color = "green";
    } else {
      document.getElementById("verifyResult").textContent = "✗ Mismatch — something went wrong";
      document.getElementById("verifyResult").style.color = "red";
    }

    // Download the restored file with its original name
    const restoredName = file.name.replace(".gz", "");
    downloadFile(decompressed, restoredName);
  };

  reader.readAsArrayBuffer(file);
}

/**
 * Computes a SHA-256 hash of any file data.
 * Returns a readable hex string like "a3f2bc..."
 * SubtleCrypto is built into Chrome — no library needed.
 */
async function computeHash(data) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray  = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates a temporary download link and clicks it automatically.
 * Used by both compress and decompress to deliver the output file.
 */
function downloadFile(data, filename) {
  const blob = new Blob([data]);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}