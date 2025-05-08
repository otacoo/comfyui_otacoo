/**
 * script.js with Exif reader and PNGMetadata integration for PNG metadata extraction.
 */

const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('image-input');
const imagePreview = document.getElementById('image-preview');
const metadataList = document.getElementById('metadata-list');
const positivePrompt = document.getElementById('positive-prompt');
const negativePrompt = document.getElementById('negative-prompt');
const promptInfoList = document.getElementById('prompt-info-list');
const warningSpan = document.getElementById('warning');

// --- EXIF parser ---
function getExifData(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const view = new DataView(e.target.result);
        let offset = 2; // Skip SOI marker
        let exifData = null;

        while (offset < view.byteLength) {
            if (view.getUint8(offset) !== 0xFF) break;
            const marker = view.getUint8(offset + 1);
            const length = view.getUint16(offset + 2, false);
            // APP1 marker (EXIF)
            if (marker === 0xE1) {
                // Check for "Exif" header
                if (
                    view.getUint8(offset + 4) === 0x45 && // 'E'
                    view.getUint8(offset + 5) === 0x78 && // 'x'
                    view.getUint8(offset + 6) === 0x69 && // 'i'
                    view.getUint8(offset + 7) === 0x66 && // 'f'
                    view.getUint8(offset + 8) === 0x00 &&
                    view.getUint8(offset + 9) === 0x00
                ) {
                    exifData = parseExif(view, offset + 10);
                    break;
                }
            }
            offset += 2 + length;
        }
        callback(exifData || {});
    };
    reader.readAsArrayBuffer(file);
}

// Scan for TIFF header (0x4949 or 0x4d4d)
function findTiffHeader(view) {
    for (let i = 0; i < view.byteLength - 1; i++) {
        const marker = view.getUint16(i, false);
        if (marker === 0x4949 || marker === 0x4d4d) {
            return i;
        }
    }
    return -1;
}

// Parse EXIF data from DataView starting at offset
function parseExif(view, start) {
    const tiffOffset = start;
    const tiffMarker = view.getUint16(tiffOffset, false);
    console.log('TIFF marker at offset', tiffOffset, ':', tiffMarker.toString(16));
    const littleEndian = tiffMarker === 0x4949;
    const getUint16 = (o) => view.getUint16(o, littleEndian);
    const getUint32 = (o) => view.getUint32(o, littleEndian);

    if (tiffMarker !== 0x4949 && tiffMarker !== 0x4D4D) return {};

    const firstIFDOffset = getUint32(tiffOffset + 4);
    let tags = {};
    readIFD(tiffOffset + firstIFDOffset, tags);

    if (tags[0x8769]) {
        readIFD(tiffOffset + tags[0x8769], tags);
    }

    const tagNames = {
        0x9286: "UserComment",
        0x010E: "ImageDescription",
        0x010F: "Make",
        0x271: "Prompt",
        0x270: "Workflow"
        // ... add more if needed
    };
    let namedTags = {};
    for (const tag in tags) {
        const name = tagNames[tag] || tag;
        namedTags[name] = tags[tag];
    }
    return namedTags;

    function readIFD(dirStart, outTags) {
        const entries = getUint16(dirStart);
        for (let i = 0; i < entries; i++) {
            const entryOffset = dirStart + 2 + i * 12;
            const tag = getUint16(entryOffset);
            const type = getUint16(entryOffset + 2);
            const numValues = getUint32(entryOffset + 4);
            let valueOffset = entryOffset + 8;
            let value;
            if (type === 2) { // ASCII string
                const offset = numValues > 4 ? getUint32(valueOffset) + tiffOffset : valueOffset;
                value = '';
                for (let n = 0; n < numValues - 1; n++) {
                    value += String.fromCharCode(view.getUint8(offset + n));
                }
            } else if (type === 7) { // UNDEFINED (UserComment)
                const offset = numValues > 4 ? getUint32(valueOffset) + tiffOffset : valueOffset;
                // Check for encoding prefix
                let prefix = '';
                for (let n = 0; n < 8; n++) {
                    prefix += String.fromCharCode(view.getUint8(offset + n));
                }
                let text = '';
                if (prefix.startsWith('ASCII')) {
                    for (let n = 8; n < numValues; n++) {
                        text += String.fromCharCode(view.getUint8(offset + n));
                    }
                } else if (prefix.startsWith('UNICODE')) {
                    // Unicode (UTF-16), skip prefix, read as 2-byte chars
                    for (let n = 8; n + 1 < numValues; n += 2) {
                        const code = (view.getUint8(offset + n) << 8) | view.getUint8(offset + n + 1);
                        text += String.fromCharCode(code);
                    }
                } else {
                    // Unknown encoding, fallback to ASCII
                    for (let n = 8; n < numValues; n++) {
                        text += String.fromCharCode(view.getUint8(offset + n));
                    }
                }
                value = text.replace(/\0+$/, ''); // Remove trailing nulls
            } else {
                value = getUint32(valueOffset);
            }
            outTags[tag] = value;
        }
    }
}

// Minimal getTag: get a tag by name from the exifData object
function getExifTag(exifData, tagName) {
    return exifData[tagName] || null;
}
// --- EXIF parser END ---

// --- WEBP Parser ---
function getWebpExifData(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const bytes = new Uint8Array(e.target.result);
        // Check RIFF header
        if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
            callback(null); return;
        }
        let offset = 12; // Skip RIFF header and "WEBP"
        while (offset + 8 < bytes.length) {
            const chunkType = String.fromCharCode(
                bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
            );
            const chunkSize = bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
            console.log('Found chunk:', chunkType, 'at offset', offset, 'size', chunkSize);
            console.log('Checking chunk:', chunkType, 'at offset', offset);
            if (chunkType === "EXIF") {
                const exifStart = offset + 8;
                // Always create a DataView for the EXIF chunk (do NOT require "Exif\0\0")
                const view = new DataView(bytes.buffer, exifStart, chunkSize);
                console.log('EXIF chunk found at', exifStart, 'first 16 bytes:', Array.from({length: 16}, (_,i) => bytes[exifStart + i]));
                console.log('First 16 bytes of EXIF chunk (DataView):', Array.from({length: 16}, (_,i) => view.getUint8(i)));
                // Scan for TIFF header (0x4949 or 0x4d4d)
                let tiffOffset = findTiffHeader(view);
                if (tiffOffset === -1) {
                    console.log('TIFF header not found in EXIF chunk');
                    callback(null);
                    return;
                }
                const exifData = parseExif(view, tiffOffset);
                console.log('TIFF header found at offset', tiffOffset);
                callback(exifData || {});
                return;
            }
            offset += 8 + chunkSize + (chunkSize % 2); // Chunks are padded to even sizes
        }
        callback(null);
    };
    reader.readAsArrayBuffer(file);
}

function getWebpExifTag(exifData, tagName) {
    return exifData && exifData[tagName] ? exifData[tagName] : null;
}
// --- WEBP Parser END ---

// --- PNGMetadata class for extracting tEXt/iTXt/zTXt chunks from PNGs ---
class PNGMetadata {
    constructor(data, mode = 'byte') {
        // data: binary string or Uint8Array
        if (mode === 'byte' && typeof data === 'string') {
            this.bytes = new Uint8Array(data.length);
            for (let i = 0; i < data.length; i++) {
                this.bytes[i] = data.charCodeAt(i) & 0xff;
            }
        } else if (data instanceof Uint8Array) {
            this.bytes = data;
        } else {
            throw new Error('PNGMetadata: data must be a binary string or Uint8Array');
        }
        this.chunks = this._parseChunks();
    }

    _parseChunks() {
        const bytes = this.bytes;
        let offset = 8; // skip PNG signature
        const chunks = {};
        while (offset < bytes.length) {
            if (offset + 8 > bytes.length) break;
            const length = this._readUint32(bytes, offset);
            const type = this._readString(bytes, offset + 4, 4);
            const dataStart = offset + 8;
            const dataEnd = dataStart + length;
            if (dataEnd > bytes.length) break;
            const chunkData = bytes.slice(dataStart, dataEnd);
            if (!chunks[type]) {
                chunks[type] = { data_raw: [] };
            }
            // For tEXt/iTXt/zTXt, decode as ISO-8859-1 string
            if (['tEXt', 'iTXt', 'zTXt'].includes(type)) {
                let text = '';
                for (let i = 0; i < chunkData.length; i++) {
                    text += String.fromCharCode(chunkData[i]);
                }
                chunks[type].data_raw.push(text);
            } else {
                chunks[type].data_raw.push(chunkData);
            }
            offset = dataEnd + 4; // skip CRC
        }
        return chunks;
    }

    _readUint32(bytes, offset) {
        return (
            (bytes[offset] << 24) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3]
        ) >>> 0;
    }

    _readString(bytes, offset, length) {
        let s = '';
        for (let i = 0; i < length; i++) {
            s += String.fromCharCode(bytes[offset + i]);
        }
        return s;
    }

    getChunks() {
        return this.chunks;
    }
}
// --- End PNGMetadata class ---

document.addEventListener('DOMContentLoaded', () => {
    clearPromptFields();
    clearWarning();
});

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});

['dragenter', 'dragover'].forEach(event => {
    uploadArea.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.add('dragover');
    });
});
['dragleave', 'drop'].forEach(event => {
    uploadArea.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');
    });
});

uploadArea.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files[0]) {
        fileInput.files = files;
        fileInput.dispatchEvent(new Event('change'));
    }
});

fileInput.addEventListener('change', (e) => {
    clearPromptFields(); // Clear before processing new image
    clearWarning();
    const file = fileInput.files[0];
    if (file && isSupportedImage(file)) {
        displayImagePreview(file);
        extractAndDisplayMetadata(file);
        if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
            extractUserCommentFromJPEG(file);
        } else if (file.type === 'image/png') {
            extractPngMetadata(file);
        } else if (file.type === 'image/webp') {
            extractUserCommentFromWebp(file);
        } else {
            showWarning('❌ No metadata found');
        }
    } else {
        clearPreviewAndMetadata();
        showWarning('❌ No metadata found');
        alert('Please select a JPG, PNG or WEBP image.');
    }
});

function clearPromptFields() {
    if (positivePrompt) {
        positivePrompt.value = '';
        autoResizeTextarea(positivePrompt);
    }
    if (negativePrompt) {
        negativePrompt.value = '';
        autoResizeTextarea(negativePrompt);
    }
    if (promptInfoList) promptInfoList.innerHTML = '';
    // Clear the additional-prompts textarea as well
    const additionalPromptsTextarea = document.getElementById('additional-prompts');
    if (additionalPromptsTextarea) {
        additionalPromptsTextarea.value = '';
        autoResizeTextarea(additionalPromptsTextarea);
    }
}

function isSupportedImage(file) {
    return (
        file.type === 'image/png' ||
        file.type === 'image/jpeg' ||
        file.type === 'image/jpg' ||
        file.type === 'image/webp'
    );
}

function displayImagePreview(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        imagePreview.src = e.target.result;
        imagePreview.style.display = 'block';
    };
    reader.readAsDataURL(file);
}

function clearPreviewAndMetadata() {
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    metadataList.innerHTML = '';
}

function extractAndDisplayMetadata(file) {
    // Clear previous metadata
    metadataList.innerHTML = '';

    // Basic metadata
    const basicMetadata = [
        { label: 'File Name', value: file.name },
        { label: 'File Type', value: file.type },
        { label: 'File Size', value: formatBytes(file.size) }
    ];

    // Get image dimensions
    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            basicMetadata.push({ label: 'Width', value: img.width + ' px' });
            basicMetadata.push({ label: 'Height', value: img.height + ' px' });

            // Display basic metadata
            for (const item of basicMetadata) {
                addMetadataItem(item.label, item.value);
            }

            // Try to extract EXIF for JPEG/WEBP
            if (file.type === 'image/jpeg' || file.type === 'image/webp') {
                extractExifMetadata(file);
            }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);

    // For PNG, no EXIF, so just display basic metadata
    if (file.type === 'image/png') {
        // No additional metadata for PNG here
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Minimal EXIF extraction for JPEG/WEBP (only a few fields, no library) ---
function extractExifMetadata(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const view = new DataView(e.target.result);

        // Check for JPEG EXIF header (0xFFD8)
        if (view.getUint16(0, false) === 0xFFD8) {
            let offset = 2;
            const length = view.byteLength;
            while (offset < length) {
                if (view.getUint16(offset + 2, false) === 0x4578) { // 'Ex'
                    // Found EXIF
                    addMetadataItem('EXIF', 'EXIF data present');
                    return;
                }
                if (view.getUint16(offset, false) === 0xFFE1) {
                    addMetadataItem('EXIF', 'EXIF segment found');
                    return;
                }
                offset += 2;
            }
            addMetadataItem('EXIF', 'No EXIF data found');
        } else if (file.type === 'image/webp') {
            // WebP EXIF is rare, just note presence
            addMetadataItem('EXIF', 'EXIF extraction for WebP not supported');
        }
    };
    reader.readAsArrayBuffer(file);
}

// --- Read JPEG and WEBP metadata for UserComment with parsing ---
function extractUserCommentFromJPEG(file) {
    getExifData(file, function (exifData) {
        let userComment = getExifTag(exifData, "UserComment");
        let makeComment = getExifTag(exifData, "Make");
        let comment = null;

        if (userComment && typeof userComment === 'string' && userComment.trim() !== '') {
            comment = userComment;
        } else if (makeComment && typeof makeComment === 'string' && makeComment.trim() !== '') {
            comment = makeComment;
        }

        if (comment) {
            clearWarning();
            parseAndDisplayUserComment(comment);
        } else {
            showWarning('❌ No metadata found');
        }
    });
}

function extractUserCommentFromWebp(file) {
    getWebpExifData(file, function (exifData) {
        // Only consider "Make" (EXIF tag 271) for JSON parsing, skip ImageDescription (EXIF tag 270)
        let candidate = null;
        if (exifData) {
            // Try string key first
            if (typeof exifData["Make"] === 'string' && exifData["Make"].trim()) {
                candidate = exifData["Make"];
            }
            // Fallback: try numeric key 271
            else if (typeof exifData[271] === 'string' && exifData[271].trim()) {
                candidate = exifData[271];
            }
        }
        let found = false;
        if (candidate) {
            let jsonStr = candidate.trim();
            // If the string starts with "Prompt:" or "Workflow:", strip that prefix
            if (jsonStr.startsWith("Prompt:")) {
                jsonStr = jsonStr.substring("Prompt:".length).trim();
            } else if (jsonStr.startsWith("Workflow:")) {
                jsonStr = jsonStr.substring("Workflow:".length).trim();
            }
            let parsed = null;
            try {
                parsed = JSON.parse(jsonStr);
            } catch (err) { }
            if (parsed && typeof parsed === 'object') {
                // 1. Find first "populated_text" value for positive prompt
                const populatedText = findFirstKeyValue(parsed, 'populated_text');
                if (positivePrompt) {
                    positivePrompt.value = populatedText || '';
                    autoResizeTextarea(positivePrompt);
                }
                // 2. Find all "wildcard_text" values for #additional-prompts
                const wildcardTexts = [];
                collectAllKeyValues(parsed, 'wildcard_text', wildcardTexts);
                const additionalPromptsTextarea = document.getElementById('additional-prompts');
                if (additionalPromptsTextarea) {
                    additionalPromptsTextarea.value = wildcardTexts.join('\n');
                    autoResizeTextarea(additionalPromptsTextarea);
                }
                // 3. Collect allowed keys for prompt-info-list (also handle nested "inputs" and primitives)
                if (promptInfoList) {
                    promptInfoList.innerHTML = '';
                    collectPromptInfo(parsed, (key, value) => {
                        addMetadataItem(key, value, promptInfoList);
                    });
                }
                clearWarning();
                found = true;
            }
        }
        if (!found) {
            // Fallback: treat UserComment as prompt string
            let comment = getWebpExifTag(exifData, "UserComment");
            if (comment && comment.trim()) {
                clearWarning();
                parseAndDisplayUserComment(comment);
            } else {
                showWarning('❌ No metadata found');
            }
        }
    });
}

// --- PNG metadata extraction ---
function extractPngMetadata(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        // Convert ArrayBuffer to binary string for PNGMetadata
        let binary = '';
        const bytes = new Uint8Array(arrayBuffer);
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        try {
            const pngMeta = new PNGMetadata(binary, 'byte');
            const chunks = pngMeta.getChunks();
            let found = false;
            // Look for tEXt, zTXt, iTXt chunks
            ['tEXt', 'zTXt', 'iTXt'].forEach(chunkType => {
                if (chunks[chunkType] && chunks[chunkType].data_raw.length > 0) {
                    for (let i = 0; i < chunks[chunkType].data_raw.length; i++) {
                        const raw = chunks[chunkType].data_raw[i];
                        // tEXt chunk: keyword\0text
                        const sepIdx = raw.indexOf('\0');
                        if (sepIdx !== -1) {
                            const keyword = raw.substring(0, sepIdx);
                            const text = raw.substring(sepIdx + 1);

                            // Process if keyword is "prompt", "parameters", or "UserComment"
                            if (
                                ["prompt", "parameters", "usercomment"].includes(keyword.toLowerCase())
                            ) {
                                let promptText = text;

                                // Try to parse as JSON
                                let parsed = null;
                                try {
                                    parsed = JSON.parse(promptText);
                                } catch (err) {
                                    // Not JSON, treat as plain text
                                }

                                if (parsed && typeof parsed === 'object') {
                                    // 1. Find first "populated_text" value for positive prompt
                                    const populatedText = findFirstKeyValue(parsed, 'populated_text');
                                    if (positivePrompt) {
                                        positivePrompt.value = populatedText || '';
                                        autoResizeTextarea(positivePrompt);
                                    }

                                    // 2. Find all "wildcard_text" values for #additional-prompts
                                    const wildcardTexts = [];
                                    collectAllKeyValues(parsed, 'wildcard_text', wildcardTexts);
                                    const additionalPromptsTextarea = document.getElementById('additional-prompts');
                                    if (additionalPromptsTextarea) {
                                        additionalPromptsTextarea.value = wildcardTexts.join('\n');
                                        autoResizeTextarea(additionalPromptsTextarea);
                                    }

                                    // 3. Collect allowed keys for prompt-info-list (robust: handle nested "inputs" and only primitives)
                                    if (promptInfoList) {
                                        promptInfoList.innerHTML = '';
                                        collectPromptInfo(parsed, (key, value) => {
                                            addMetadataItem(key, value, promptInfoList);
                                        });
                                    }

                                    clearWarning();
                                    found = true;
                                } else {
                                    // Fallback: treat as prompt string
                                    clearWarning();
                                    parseAndDisplayUserComment(promptText);
                                    found = true;
                                }
                            }
                        }
                    }
                }
            });
            if (!found) {
                showWarning('❌ No prompt metadata found');
            }
        } catch (err) {
            showWarning('❌ Failed to parse PNG metadata');
        }
    };
    reader.readAsArrayBuffer(file);
}

// Helper: Find the first occurrence of a key in a nested object
function findFirstKeyValue(obj, targetKey) {
    if (typeof obj !== 'object' || obj === null) return null;
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === targetKey && typeof obj[key] === 'string') {
            return obj[key];
        } else if (typeof obj[key] === 'object') {
            const result = findFirstKeyValue(obj[key], targetKey);
            if (result !== null) return result;
        }
    }
    return null;
}

// Helper: Collect all values for a key in a nested object
function collectAllKeyValues(obj, targetKey, resultArr) {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === targetKey && typeof obj[key] === 'string') {
            resultArr.push(obj[key]);
        } else if (typeof obj[key] === 'object') {
            collectAllKeyValues(obj[key], targetKey, resultArr);
        }
    }
}

// Helper: Collect prompt info for prompt-info-list (robust: handle nested "inputs" and only primitives)
function collectPromptInfo(obj, cb) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectPromptInfo(item, cb);
        }
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === 'inputs' && typeof obj[key] === 'object' && obj[key] !== null) {
            for (const subKey in obj[key]) {
                if (obj[key].hasOwnProperty(subKey)) {
                    const value = obj[key][subKey];
                    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                        cb(subKey, value);
                    }
                }
            }
        } else if (typeof obj[key] === 'string' || typeof obj[key] === 'number' || typeof obj[key] === 'boolean') {
            // Only show primitive values, skip objects/arrays
            if (key !== 'populated_text' && key !== 'wildcard_text') {
                cb(key, obj[key]);
            }
        } else if (typeof obj[key] === 'object') {
            collectPromptInfo(obj[key], cb);
        }
    }
}

/**
 * Parse the UserComment string and distribute to UI elements.
 * - All text until "Negative prompt:" (excluded) -> #positive-prompt
 * - "Negative prompt:" until "Steps:" (excluded) -> #negative-prompt
 * - "Steps:" and everything after -> #prompt-info-list (as <li>s)
 * - Remove initial "UNICODE" if present
 * - Remove Template: "..." and any text within the double quotes (including the quotes)
 */
function parseAndDisplayUserComment(comment) {
    // Remove "UNICODE" at the start if present
    comment = comment.trim();
    if (comment.startsWith('UNICODE')) {
        comment = comment.substring('UNICODE'.length).trim();
    }
    // Find "Negative prompt:" and "Steps:"
    const negPromptIdx = comment.indexOf('Negative prompt:');
    const stepsIdx = comment.indexOf('Steps:');
    let positive = '';
    let negative = '';
    let additional = '';
    if (negPromptIdx !== -1) {
        positive = comment.substring(0, negPromptIdx).trim();
        if (stepsIdx !== -1 && stepsIdx > negPromptIdx) {
            negative = comment.substring(negPromptIdx + 'Negative prompt:'.length, stepsIdx).trim();
            additional = comment.substring(stepsIdx).trim();
        } else {
            negative = comment.substring(negPromptIdx + 'Negative prompt:'.length).trim();
        }
    } else {
        // If no negative prompt, treat all as positive
        if (stepsIdx !== -1) {
            positive = comment.substring(0, stepsIdx).trim();
            additional = comment.substring(stepsIdx).trim();
        } else {
            positive = comment.trim();
        }
    }
    // Remove Template: "..." and Hires prompt: "..." and any text within the double quotes (including the quotes)
    if (additional) {
        // This regex matches: Template: " ... " or Hires prompt: " ... " (including any content inside the quotes, non-greedy)
        // and also removes any leading/trailing commas and whitespace left behind
        additional = additional.replace(/,?\s*(Template|Hires prompt):\s*"[^"]*"\s*,?/g, ', ');
        // Remove any accidental double commas or leading/trailing commas/spaces
        additional = additional.replace(/,{2,}/g, ',').replace(/^[,\s]+|[,\s]+$/g, '');
    }
    // Set textareas and auto-resize after setting value
    if (positivePrompt) {
        positivePrompt.value = positive;
        autoResizeTextarea(positivePrompt);
    }
    if (negativePrompt) {
        negativePrompt.value = negative;
        autoResizeTextarea(negativePrompt);
    }
    // Fill prompt info list using addMetadataItem for consistent formatting
    if (promptInfoList) {
        promptInfoList.innerHTML = '';
        if (additional) {
            const items = splitPromptInfo(additional);
            for (const item of items) {
                // Try to split into label and value at the first colon
                const colonIdx = item.indexOf(':');
                if (colonIdx !== -1) {
                    const label = item.slice(0, colonIdx).trim();
                    const value = item.slice(colonIdx + 1).trim();
                    addMetadataItem(label, value, promptInfoList);
                } else {
                    // If no colon, just display as value with empty label
                    addMetadataItem('', item.trim(), promptInfoList);
                }
            }
        }
    }
}

/**
 * Split the additional prompt info into items, respecting commas inside parentheses.
 * E.g. "Steps: 30, Sampler: DPM++ 2M, Model: foo (bar, baz), Seed: 123"
 * Should split into ["Steps: 30", "Sampler: DPM++ 2M", "Model: foo (bar, baz)", "Seed: 123"]
 */
function splitPromptInfo(str) {
    const result = [];
    let current = '';
    let parenDepth = 0;
    for (let i = 0; i < str.length; ++i) {
        const c = str[i];
        if (c === '(') parenDepth++;
        if (c === ')') parenDepth--;
        if (c === ',' && parenDepth === 0) {
            result.push(current);
            current = '';
            // Skip the space after comma if present
            if (str[i + 1] === ' ') i++;
        } else {
            current += c;
        }
    }
    if (current.trim().length > 0) result.push(current);
    return result;
}

/**
 * Add a metadata item to a given list element, formatting with <strong> for label.
 * If no list element is provided, defaults to metadataList.
 */
function addMetadataItem(label, value, listElement) {
    const li = document.createElement('li');
    if (label) {
        li.innerHTML = `<strong class="unselectable-label">${label}:</strong> ${value}`;
    } else {
        li.textContent = value;
    }
    (listElement || metadataList).appendChild(li);
}

// Auto-resize a textarea to fit its content.
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto'; // Reset height
    textarea.style.height = (textarea.scrollHeight + 2) + 'px'; // Add 2px for border
}

// Show a warning message in #warning span.
function showWarning(msg) {
    if (warningSpan) {
        warningSpan.textContent = msg;
        warningSpan.style.display = 'inline';
    }
}

//Clear the warning message in #warning span.
function clearWarning() {
    if (warningSpan) {
        warningSpan.textContent = '';
        warningSpan.style.display = 'none';
    }
}

// Copy textarea text using the modern clipboard API and show feedback in the .btn-label.
document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async function () {
        const targetId = btn.getAttribute('data-target');
        const textarea = document.getElementById(targetId);
        const label = btn.parentElement.querySelector('.btn-label');
        if (textarea) {
            if (!textarea.value.trim()) {
                // If textarea is empty, show 'Nothing to copy...'
                if (label) {
                    label.textContent = 'Nothing to copy...';
                    label.style.opacity = '1';
                    label.style.transition = 'opacity 0.5s';
                    void label.offsetWidth;

                    setTimeout(() => {
                        label.style.opacity = '0';
                        setTimeout(() => {
                            label.textContent = '';
                        }, 500);
                    }, 2000);
                }
                return;
            }
            try {
                await navigator.clipboard.writeText(textarea.value);
                if (label) {
                    label.textContent = 'Copied!';
                    label.style.opacity = '1';
                    label.style.transition = 'opacity 0.5s';
                    // Force reflow for transition restart if needed
                    void label.offsetWidth;

                    setTimeout(() => {
                        label.style.opacity = '0';
                        // Optionally clear the text after fade out
                        setTimeout(() => {
                            label.textContent = '';
                        }, 500);
                    }, 2000);
                }
            } catch (err) {
                if (label) {
                    label.textContent = 'Copy failed';
                    label.style.opacity = '1';
                    setTimeout(() => {
                        label.style.opacity = '0';
                        setTimeout(() => { label.textContent = ''; }, 500);
                    }, 2000);
                }
            }
        }
    });
});

// Scroll-to-top arrow logic
(function scrollArrow() {
    if (document.getElementById("scroll-to-top")) {
        return;
    }
    const upBtn = document.createElement("button");
    upBtn.id = "scroll-to-top";
    upBtn.className = "scroll-arrow-btn";
    upBtn.title = "Scroll to top";
    upBtn.innerHTML = "▲";
    upBtn.style.display = "none"; // Hide initially

    upBtn.addEventListener("click", () => {
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.body.appendChild(upBtn);

    // Show/hide on scroll
    window.addEventListener("scroll", function () {
        if (window.scrollY > 500) {
            upBtn.style.display = "block";
            upBtn.classList.add("show");
        } else {
            upBtn.classList.remove("show");
            // Wait for transition before hiding
            setTimeout(() => {
                if (!upBtn.classList.contains("show")) {
                    upBtn.style.display = "none";
                }
            }, 300);
        }
    });
})();
