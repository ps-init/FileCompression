# File Compression

A lightweight browser-based tool for compressing and decompressing files without leaving your computer. Supports images, video, and text files with real-time compression metrics.

## What it does

Upload any file and get instant compression stats. The tool handles different file types intelligently:

- **Images**: JPEG (lossy) and PNG (lossless) compression with quality measurements
- **Video**: Custom compression pipelines for MP4 and WAV formats  
- **Text**: Efficient deflate-based compression for documents and data files

No upload to servers, no tracking—everything stays local.

## Features

- **Real-time metrics**: See original size, compressed size, and space saved before downloading
- **Quality verification**: For lossy compression, PSNR and SSIM metrics show how much quality is retained
- **Integrity checks**: PNG files include SHA-256 verification; reupload to confirm decompression worked
- **Drag-and-drop UI**: Simple, no-nonsense interface
- **Multiple formats**: Compress images, video, audio, and text in one place

## How it works

1. Drag a file onto the upload area or click to browse
2. View compression results and metrics
3. Download the compressed file
4. Optionally reupload to verify decompression integrity

## Technical details

The compression pipeline uses proven libraries:

- **PNG**: UPNG.js for DEFLATE compression with full lossless control
- **JPEG**: Browser's native Canvas API—faster and smaller output than JS alternatives
- **Video/Audio**: Native codecs via format-specific handlers
- **Hashing**: Web Crypto API for SHA-256 verification

Supported formats: `.txt`, `.csv`, `.png`, `.jpg`, `.jpeg`, `.wav`, `.mp3`, `.mp4`

## Installation

Clone the repo and open `index.html` in a modern browser. No build step, no dependencies to install.

```bash
git clone https://github.com/ps-init/FileCompression.git
cd FileCompression
# Open index.html in your browser
