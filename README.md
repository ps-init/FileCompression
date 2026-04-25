# MACS JC Project 2: File Compression Extension

**Team Name:** [SMG]  
**Project Status:** Submitted for MACS JC Project 2  

---

## 1. Project Context
This project aims to implement a functional Chrome extension capable of compressing and decompressing multiple file types: text, images, audio, and video. The objective is to optimize file storage and transmission while providing clear, data-driven feedback on compression performance.

---

## 2. System Architecture
The extension follows a modular, browser-native architecture. All operations (compression, decompression, hash verification) are performed client-side, eliminating server dependencies and ensuring user data privacy.

* **UI Layer**: Built using `popup.html` and `popup.css` for a clean, responsive interface.
* **Controller**: `popup.js` handles file type detection and routes files to the appropriate compression modules.
* **Engine**: Dedicated modules for different data types (e.g., GZIP for text, DCT-based encoders for images).
* **Validation**: Uses the Web Crypto API (`SubtleCrypto`) to perform SHA-256 hash checks.

---

## 3. Implementation Summary

| File Type | Category |Library | Key Metric |
| :--- | :--- | :--- | :--- |
| **Text (.txt/.csv)** | Lossless |pako| SHA-256 Hash Match |
| **Image (.jpg)** | Lossy |UPNG.js| PSNR / SSIM |
| **Audio (.mp3/.wav)** | Lossy |none| Bit-rate Comparison |
| **Video (.mp4)** | Lossy |none| Bit-rate Comparison |

---

## 4. Performance Results
*The table below represents the efficiency achieved during testing.*

| File Category | Original Size | Compressed Size | Ratio | Space Savings (%) |
| :--- | :--- | :--- | :--- | :--- |
| Text (.txt) |5.80 MB | 3.19 MB | 1.82:1| 45.0%|
| JPEG Image | 24.4 MB | 12.5 MB | 1.95:1 | 48.8% |
| Audio (WAV) | 48.6 MB | 25.9 MB | 1.88:1 | 46.7% |
| Video (MP4) | 820 MB | 426 MB | 1.92:1 | 48% |
![alt text](image-2.png)
<img width="637" height="797" alt="image" src="https://github.com/user-attachments/assets/cf968b0a-afad-4af6-ad98-9d66397ac6ce" />

---

## 5. Deployment & Usage
1. **Developer Mode**: Navigate to `chrome://extensions/` and enable "Developer mode".
2. **Load Extension**: Click "Load unpacked" and select the root directory of this repository.
3. **Usage**: Click the extension icon, upload your file, and view the metrics in the popup UI.

---

## 6. Team Contributions
| Name || Contribution (%) |
| [Vidit Maheshwari] |16.66% |
| [Govind Upadhyay] |16.66% |
| [Shashwat Gupta] |16.66% |
| [Rajat Khandelwal] |16.66% |
| [Dheer ] |16.66% |
| [Prerit Sharma] |16.66% |

---

## 7. References
 **UPNG.js** — https://github.com/nickyout/UPNG.js
 **fflate** — https://github.com/101arrowz/fflate
 **jpeg-js** — https://github.com/jpeg-js/jpeg-js
 **pako** — https://github.com/nickyout/pako
 **lamejs** — https://github.com/nickyout/lamejs
