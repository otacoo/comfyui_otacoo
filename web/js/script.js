/**
 * script.js with Exif reader, PNG, JPEG and WebP integration for metadata extraction.
 * (c) otacoo / otakudude / doublerunes, GPLv3
 */
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('image-input');
const imagePreview = document.getElementById('image-preview');
const metadataList = document.getElementById('metadata-list');
const positivePrompt = document.getElementById('positive-prompt');
const negativePrompt = document.getElementById('negative-prompt');
const promptInfoList = document.getElementById('prompt-info-list');
const modelInfoList = document.getElementById('model-info-list');
const warningSpan = document.getElementById('warning');

// --- Helper: Set textarea value and auto-resize ---
function setAndResize(textarea, value) {
    if (textarea) {
        textarea.value = value;
        autoResizeTextarea(textarea);
    }
}

// --- Helper: Strip "Prompt:" or "Workflow:" prefix ---
function stripPromptPrefix(str) {
    if (typeof str !== 'string') return str;
    if (str.startsWith("Prompt:")) return str.substring("Prompt:".length).trim();
    if (str.startsWith("Workflow:")) return str.substring("Workflow:".length).trim();
    return str;
}

// --- Helper: Determine if a key should go to model-info-list ---
function isModelInfoKey(key) {
    if (!key) return false;
    const normalized = key.trim().toLowerCase();
    // Exact matches (case-insensitive)
    const modelKeys = [
        'ckpt', 'ckpt_name', 'checkpoint', 'model', 'lora', 'lora_name', 'lora hashes'
    ];
    if (modelKeys.includes(normalized)) return true;
    // lora_* or lora-* pattern (case-insensitive)
    if (/^lora[_\-].+/i.test(normalized)) return true;
    // "lora hashes" with any whitespace
    if (normalized.replace(/\s+/g, '') === 'lorahashes') return true;
    return false;
}

// --- Centralized prompt data distribution ---
function distributePromptData(parsed, comment, sourceTag) {
    let found = false;
    if (parsed && typeof parsed === 'object') {
        // 1. Collect all "text" values (recursively) for positive and negative prompts
        const positiveTexts = [];
        const negativeTexts = [];
        collectTextValuesWithNegatives(parsed, positiveTexts, negativeTexts);

        setAndResize(positivePrompt, positiveTexts.map(unescapePromptString).join('\n'));
        setAndResize(negativePrompt, negativeTexts.map(unescapePromptString).join('\n'));

        // 2. Find all "wildcard_text" and "extraMetadata" (prompt only) values for #additional-prompts
        const wildcardTexts = [];
        collectAllKeyValues(parsed, 'wildcard_text', wildcardTexts);
        const extraMetadataPrompts = [];
        collectExtraMetadataPromptOnly(parsed, extraMetadataPrompts);

        const additionalPromptsTextarea = document.getElementById('additional-prompts');
        if (additionalPromptsTextarea) {
            let combined = [];
            if (wildcardTexts.length) combined = combined.concat(wildcardTexts);
            if (extraMetadataPrompts.length) combined = combined.concat(extraMetadataPrompts);
            setAndResize(additionalPromptsTextarea, combined.join('\n'));
        }

        // 3. Collect allowed keys for prompt-info-list and model-info-list
        if (promptInfoList) promptInfoList.innerHTML = '';
        if (modelInfoList) modelInfoList.innerHTML = '';
        collectPromptInfo(
            parsed,
            (key, value) => {
                if (!isModelInfoKey(key)) {
                    addMetadataItem(key, value, promptInfoList);
                }
            },
            (key, value) => {
                if (isModelInfoKey(key)) {
                    addMetadataItem(key, value, modelInfoList);
                }
            }
        );
        clearWarning();
        found = true;
    }
    if (!found && comment && comment.trim()) {
        clearWarning();
        parseAndDisplayUserComment(comment);
    } else if (!found) {
        showWarning('❌ No metadata found');
    }
}

// --- EXIF parser ---
function getExifData(file, callback) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const view = new DataView(e.target.result);
        let offset = 2; // Skip SOI marker
        let exifData = null;
        let found = false;

        try {
            while (offset + 4 < view.byteLength) { // Ensure we can read marker + length
                if (view.getUint8(offset) !== 0xFF) break;
                const marker = view.getUint8(offset + 1);

                // Make sure we can read the length
                if (offset + 4 > view.byteLength) break;
                const length = view.getUint16(offset + 2, false);

                // Validate length to avoid invalid offsets
                if (length < 2 || offset + 2 + length > view.byteLength) {
                    offset += 2;
                    continue;
                }

                if (marker === 0xE1) {
                    // Make sure we have enough bytes to check for "Exif" header
                    if (offset + 10 > view.byteLength) break;
                    // Check for "Exif" header
                    if (
                        view.getUint8(offset + 4) === 0x45 && // 'E'
                        view.getUint8(offset + 5) === 0x78 && // 'x'
                        view.getUint8(offset + 6) === 0x69 && // 'i'
                        view.getUint8(offset + 7) === 0x66 && // 'f'
                        view.getUint8(offset + 8) === 0x00 &&
                        view.getUint8(offset + 9) === 0x00
                    ) {
                        // Try TIFF at offset 0 (standard), else scan for TIFF marker
                        let exifStart = offset + 10;
                        let exifLength = length - 8;
                        // Validate exifLength to avoid creating an invalid DataView
                        if (exifLength <= 0 || exifStart + exifLength > view.byteLength) {
                            offset += 2 + length;
                            continue;
                        }
                        let viewExif = new DataView(view.buffer, exifStart, exifLength);
                        let tiffOffset = 0;
                        // Make sure we can read the TIFF marker
                        if (viewExif.byteLength < 2) {
                            offset += 2 + length;
                            continue;
                        }
                        let tiffMarker = viewExif.getUint16(0, false);
                        if (tiffMarker !== 0x4949 && tiffMarker !== 0x4D4D) {
                            // Scan for TIFF marker in EXIF segment
                            tiffOffset = findTiffHeader(viewExif);
                            if (tiffOffset === -1) {
                                offset += 2 + length;
                                continue;
                            }
                        }
                        try {
                            exifData = parseExif(viewExif, tiffOffset);
                            found = true;
                            break;
                        } catch (parseErr) {
                            console.warn('Error parsing EXIF data:', parseErr);
                        }
                    }
                }
                offset += 2 + length;
            }
        } catch (err) {
            console.error('Error reading EXIF data:', err);
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
            if (chunkType === "EXIF") {
                const exifStart = offset + 8;
                // Always create a DataView for the EXIF chunk (do NOT require "Exif\0\0")
                const view = new DataView(bytes.buffer, exifStart, chunkSize);
                console.log('EXIF chunk found at', exifStart, 'first 16 bytes:', Array.from({ length: 16 }, (_, i) => bytes[exifStart + i]));
                console.log('First 16 bytes of EXIF chunk (DataView):', Array.from({ length: 16 }, (_, i) => view.getUint8(i)));
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
        // Accepts either a binary string or Uint8Array
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
        let offset = 8;
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
            } else if (type === 'eXIf') {
                // Store raw EXIF bytes for eXIf chunk
                chunks[type].data_raw.push(chunkData);
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

// --- Page events and UI logic ---
// --- Page events and UI logic ---
document.addEventListener('DOMContentLoaded', () => {
    clearPromptFields();
    clearWarning();

    // --- DOM element references ---
    const toggleText = document.getElementById('additional-info-toggle-text');
    const chevrons = document.querySelectorAll('.expand-toggle-row .chevron');
    const additionalContainer = document.querySelector('.additional-container');
    const toggleRow = document.getElementById('additional-info-toggle-row');
    const fileInput = document.getElementById('image-input');
    const stripMetadataBtn = document.getElementById('strip-metadata-btn');

    let expanded = false;

    // --- Helper: Show/hide the toggle row and strip metadata button ---
    function setToggleRowVisible(visible) {
        if (toggleRow) toggleRow.style.display = visible ? 'flex' : 'none';
    }
    function setStripMetadataBtnVisible(visible) {
        if (stripMetadataBtn) stripMetadataBtn.style.display = visible ? 'block' : 'none';
    }

    // --- Helper: Set expanded/collapsed state for additional info ---
    function setExpanded(state) {
        expanded = !!state;
        additionalContainer.classList.toggle('expanded', expanded);
        additionalContainer.classList.toggle('collapsed', !expanded);
        toggleText.textContent = expanded ? 'Hide additional info' : 'Show additional info';
        toggleText.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        chevrons.forEach(chev => chev.classList.toggle('rotate', expanded));
    }

    // --- Expose for programmatic use if needed ---
    window.showExpandedInfo = function () { setExpanded(true); };
    window.hideExpandedInfo = function () { setExpanded(false); };

    // --- Expose for prompt metadata control ---
    window.setPromptInfoAvailable = function(hasPromptInfo) {
        setToggleRowVisible(!!hasPromptInfo);
        setStripMetadataBtnVisible(!!hasPromptInfo);
        if (!hasPromptInfo) setExpanded(false);
    };

    setExpanded(false);
    setToggleRowVisible(false); // Hide toggle row on page load
    setStripMetadataBtnVisible(false); // Hide strip metadata button on page load

    // --- Toggle expand/collapse on click or keyboard ---
    if (toggleRow) {
        toggleRow.addEventListener('click', (e) => {
            if (
                e.target === toggleText ||
                e.target.classList.contains('chevron')
            ) {
                setExpanded(!expanded);
            }
        });
        toggleText.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                setExpanded(!expanded);
                e.preventDefault();
            }
        });
    }

    // --- Hide both toggle row and strip metadata button on file input change ---
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            // --- Clear prompt fields and warning on new image selection ---
            clearPromptFields();
            clearWarning();

            // --- Hide both until prompt metadata is found ---
            setToggleRowVisible(false);
            setStripMetadataBtnVisible(false);

            setExpanded(false); // Optionally collapse when new image is selected
        });
    }

    // --- Strip Metadata Button Logic ---
    if (stripMetadataBtn) {
        stripMetadataBtn.addEventListener('click', async function () {
            clearWarning();
            if (!fileInput.files || !fileInput.files[0]) {
                showWarning('No image loaded.');
                return;
            }
            const file = fileInput.files[0];
            const confirmed = window.confirm('Are you sure you want to strip all metadata from this image? This will create a new copy without metadata.');
            if (!confirmed) return;

            try {
                const cleanBlob = await stripImageMetadata(file);
                if (!cleanBlob) {
                    showWarning('Failed to strip metadata.');
                    return;
                }
                // Offer download of the clean image
                const url = URL.createObjectURL(cleanBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = getStrippedFilename(file.name);
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    URL.revokeObjectURL(url);
                    a.remove();
                }, 1000);
            } catch (err) {
                showWarning('Error stripping metadata: ' + err.message);
            }
        });
    }
});

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
    }
});

// Drag and drop events
// Highlight uploadArea when dragging files over the page
['dragenter', 'dragover'].forEach(event => {
    document.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.add('dragover');
    });
});

// Remove highlight when leaving the page or dropping
['dragleave', 'drop'].forEach(event => {
    document.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadArea.classList.remove('dragover');
    });
});

// Handle file drop anywhere on the page
document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only process if files are present
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

// --- UI clearing ---
function clearPromptFields() {
    setAndResize(positivePrompt, '');
    setAndResize(negativePrompt, '');
    if (promptInfoList) promptInfoList.innerHTML = '';
    if (modelInfoList) modelInfoList.innerHTML = '';
    const additionalPromptsTextarea = document.getElementById('additional-prompts');
    setAndResize(additionalPromptsTextarea, '');
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
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// --- "Strip Metadata" Functionality ---
function getStrippedFilename(originalName) {
    const dotIdx = originalName.lastIndexOf('.');
    if (dotIdx === -1) return originalName + '_stripped';
    return originalName.slice(0, dotIdx) + '_stripped' + originalName.slice(dotIdx);
}

async function stripImageMetadata(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = function () {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                let mimeType = file.type;
                let quality = 0.92;
                if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
                    canvas.toBlob(resolve, 'image/jpeg', quality);
                } else if (mimeType === 'image/png') {
                    canvas.toBlob(resolve, 'image/png');
                } else if (mimeType === 'image/webp' && canvas.toBlob) {
                    canvas.toBlob(resolve, 'image/webp', quality);
                } else {
                    canvas.toBlob(resolve, 'image/png');
                }
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = function () {
            reject(new Error('Failed to load image for metadata stripping.'));
        };
        const reader = new FileReader();
        reader.onload = function (e) {
            img.src = e.target.result;
        };
        reader.onerror = function () {
            reject(new Error('Failed to read image file.'));
        };
        reader.readAsDataURL(file);
    });
}
/////////////////////////////////////////////////////////////////////////////////

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
                if (view.getUint16(offset + 2, false) === 0x4578) {
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
            addMetadataItem('EXIF', 'EXIF metadata found');
        }
    };
    reader.readAsArrayBuffer(file);
}

// --- Helper: JSON-like string parsers ---
function safeJsonParse(str) {
    if (!str || typeof str !== 'string') {
        console.warn('safeJsonParse: Input is not a string', str);
        return null;
    }
    // Trim the string
    let fixed = str.trim();
    // Unescape double-backslash newlines
    fixed = fixed.replace(/\\\\n/g, "\\n");
    // Replace NaN with null (JSON does not support NaN)
    fixed = fixed.replace(/\bNaN\b/g, 'null');
    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    try {
        return JSON.parse(fixed);
    } catch (err) {
        // Try one more approach - replace single quotes with double quotes
        try {
            const singleQuotesFixed = fixed.replace(/'/g, '"');
            return JSON.parse(singleQuotesFixed);
        } catch (err2) {
            // Only log if both attempts failed
            console.warn('safeJsonParse failed:', err2, fixed);
            try {
                // Last resort: try eval (with safety precautions)
                // This is risky but might work for some non-standard JSON
                if (fixed.match(/^[\s\n]*[\[\{].*[\}\]][\s\n]*$/)) {
                    const result = (new Function('return ' + fixed))();
                    if (typeof result === 'object' && result !== null) {
                        console.warn('Used Function constructor as fallback for JSON parsing');
                        return result;
                    }
                }
            } catch (err3) {
                // Cut my life into pieces, this is my last resort
                console.warn('All JSON parse attempts failed:', err3, fixed);
            }
            return null;
        }
    }
}

// Replace double-backslash n with real newline
function unescapePromptString(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/\\\\n/g, "\n")
        .replace(/\\\\/g, "\\"); // Unescape any remaining double backslashes
}

// --- JPEG and WEBP metadata extraction with prompt distribution ---
function extractUserCommentFromJPEG(file) {
    getExifData(file, function (exifData) {
        console.log('EXIF DATA:', exifData);
        let userComment = getExifTag(exifData, "UserComment");
        let makeComment = getExifTag(exifData, "Make");
        let imageDescription = getExifTag(exifData, "ImageDescription") || exifData[0x010E] || exifData[270];
        let comment = null;
        let sourceTag = null;
        if (userComment && typeof userComment === 'string' && userComment.trim() !== '') {
            comment = userComment;
            sourceTag = 'UserComment';
        } else if (makeComment && typeof makeComment === 'string' && makeComment.trim() !== '') {
            comment = makeComment;
            sourceTag = 'Make';
        } else if (imageDescription && typeof imageDescription === 'string' && imageDescription.trim() !== '') {
            comment = imageDescription;
            sourceTag = 'ImageDescription';
        }
        console.log('Selected comment source:', sourceTag, 'Value:', comment);
        if (comment) {
            window.setPromptInfoAvailable(true);
            let jsonStr = stripPromptPrefix(comment.trim());
            let parsed = safeJsonParse(jsonStr);
            distributePromptData(parsed, comment, sourceTag);
        } else {
            showWarning('❌ No metadata found');
            window.setPromptInfoAvailable(false);
        }
    });
}

// --- Read WEBP metadata for UserComment with parsing and negative prompt detection ---
function extractUserCommentFromWebp(file) {
    getWebpExifData(file, function (exifData) {
        console.log('WEBP EXIF DATA:', exifData);
        // Only consider "Make" (EXIF tag 271) for JSON parsing, skip ImageDescription (EXIF tag 270)
        let candidate = null;
        let sourceTag = null;
        if (exifData) {
            // Try string key first
            if (typeof exifData["Make"] === 'string' && exifData["Make"].trim()) {
                candidate = exifData["Make"];
                sourceTag = 'Make';
                // Fallback: try numeric key 271
            } else if (typeof exifData[271] === 'string' && exifData[271].trim()) {
                candidate = exifData[271];
                sourceTag = '271';
            }
            window.setPromptInfoAvailable(true);
        }
        console.log('Selected WebP comment source:', sourceTag, 'Value:', candidate);
        if (candidate) {
            let jsonStr = stripPromptPrefix(candidate.trim());
            let parsed = safeJsonParse(jsonStr);
            distributePromptData(parsed, candidate, sourceTag);
        } else {
            let comment = getWebpExifTag(exifData, "UserComment");
            if (comment && comment.trim()) {
                console.log('Using WebP UserComment fallback:', comment);
                clearWarning();
                parseAndDisplayUserComment(comment);
            } else {
                window.setPromptInfoAvailable(false);
                showWarning('❌ No metadata found');
            }
        }
    });
}

// --- PNG metadata extraction with prompt distribution ---
function extractPngMetadata(file) {
    const reader = new FileReader();
    reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        try {
            const pngMeta = new PNGMetadata(bytes, 'byte');
            const chunks = pngMeta.getChunks();
            let found = false;
            // 1. Try tEXt, zTXt, iTXt chunks first
            ['tEXt', 'zTXt', 'iTXt'].forEach(chunkType => {
                if (chunks[chunkType] && chunks[chunkType].data_raw.length > 0) {
                    for (let i = 0; i < chunks[chunkType].data_raw.length; i++) {
                        const raw = chunks[chunkType].data_raw[i];
                        const sepIdx = raw.indexOf('\0');
                        if (sepIdx !== -1) {
                            const keyword = raw.substring(0, sepIdx);
                            const text = raw.substring(sepIdx + 1);
                            console.log('PNG chunk:', chunkType, 'keyword:', keyword);
                            if (["prompt", "parameters", "usercomment"].includes(keyword.toLowerCase())) {
                                let promptText = text;
                                console.log('Found PNG metadata with keyword:', keyword);
                                window.setPromptInfoAvailable(true);
                                let parsed = safeJsonParse(promptText);
                                distributePromptData(parsed, promptText, keyword);
                                found = true;
                            }
                        }
                    }
                }
            });
            // 2. If not found, try eXIf chunk
            if (!found && chunks['eXIf'] && chunks['eXIf'].data_raw.length > 0) {
                console.log('PNG: No metadata in text chunks, trying eXIf chunk');
                let exifBytes = [];
                for (const part of chunks['eXIf'].data_raw) {
                    exifBytes = exifBytes.concat(Array.from(part));
                }
                const exifArray = new Uint8Array(exifBytes);
                const exifView = new DataView(exifArray.buffer);

                // Find TIFF header
                let tiffOffset = 0;
                let tiffMarker = exifView.getUint16(0, false);
                if (tiffMarker !== 0x4949 && tiffMarker !== 0x4D4D) {
                    console.log('PNG eXIf: TIFF marker not at offset 0, scanning...');
                    tiffOffset = findTiffHeader(exifView);
                    if (tiffOffset === -1) {
                        console.warn('PNG eXIf: No TIFF header found');
                        showWarning('❌ No EXIF TIFF header found in PNG eXIf chunk');
                        return;
                    }
                    console.log('PNG eXIf: TIFF header found at offset', tiffOffset);
                }
                const exifData = parseExif(exifView, tiffOffset);
                console.log('Parsed EXIF from PNG eXIf:', exifData);

                // Try to extract UserComment or other prompt data from exifData
                let userComment = exifData["UserComment"] || exifData[0x9286];
                let makeComment = exifData["Make"];
                let imageDescription = exifData["ImageDescription"] || exifData[0x010E] || exifData[270];
                let comment = null;
                let sourceTag = null;
                // Try to decode UserComment if it's not a string (e.g., array of char codes)
                if (userComment && typeof userComment !== 'string' && Array.isArray(userComment)) {
                    userComment = String.fromCharCode.apply(null, userComment);
                }
                if (userComment && typeof userComment === 'string' && userComment.trim() !== '') {
                    comment = userComment;
                    sourceTag = 'UserComment';
                } else if (makeComment && typeof makeComment === 'string' && makeComment.trim() !== '') {
                    comment = makeComment;
                    sourceTag = 'Make';
                } else if (imageDescription && typeof imageDescription === 'string' && imageDescription.trim() !== '') {
                    comment = imageDescription;
                    sourceTag = 'ImageDescription';
                }
                console.log('Selected comment source from PNG EXIF:', sourceTag, 'Value:', comment);
                if (comment) {
                    let jsonStr = stripPromptPrefix(comment.trim());
                    let parsed = safeJsonParse(jsonStr);
                    distributePromptData(parsed, comment, sourceTag);
                    found = true;
                }
            }
            if (!found) {
                console.warn('No prompt metadata found in PNG');
                window.setPromptInfoAvailable(false);
                showWarning('❌ No prompt metadata found');
            }
        } catch (err) {
            console.error('Failed to parse PNG metadata:', err);
            showWarning('❌ Failed to parse PNG metadata');
        }
    };
    reader.readAsArrayBuffer(file);
}
// --- PNG Metadata extractor END ---

// --- Extractor Helpers ----
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

/* Helper: Collect all values for a key in a nested object
*  Usage: collectAllKeyValues(obj, 'text', arr)
*/
function collectAllKeyValues(obj, targetKey, resultArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectAllKeyValues(item, targetKey, resultArr);
        }
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === targetKey && typeof obj[key] === 'string') {
            resultArr.push(obj[key]);
        } else if (typeof obj[key] === 'object') {
            collectAllKeyValues(obj[key], targetKey, resultArr);
        }
    }
}

// Helper: Collect only the "prompt" property from any "extraMetadata" object in a nested structure ---
function collectExtraMetadataPromptOnly(obj, resultArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectExtraMetadataPromptOnly(item, resultArr);
        }
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === 'extraMetadata' && typeof obj[key] === 'object' && obj[key] !== null) {
            if (typeof obj[key].prompt === 'string') {
                resultArr.push(obj[key].prompt);
            }
        } else if (typeof obj[key] === 'object') {
            collectExtraMetadataPromptOnly(obj[key], resultArr);
        }
    }
}

// Helper: Collect prompt info for prompt-info-list
function collectPromptInfo(obj, cbPrompt, cbModel) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectPromptInfo(item, cbPrompt, cbModel);
        }
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        const value = obj[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            if (key !== 'populated_text' && key !== 'wildcard_text') {
                if (isModelInfoKey(key)) {
                    cbModel(key, value);
                } else {
                    cbPrompt(key, value);
                }
            }
        } else if (typeof value === 'object' && value !== null) {
            collectPromptInfo(value, cbPrompt, cbModel);
        }
    }
}

// --- Helper: Collect all "text" values and separate negative ones ---
function collectTextValuesWithNegatives(obj, positiveArr, negativeArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            collectTextValuesWithNegatives(item, positiveArr, negativeArr);
        }
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        // Handle text key with negative detection
        if (key === 'text' && typeof obj[key] === 'string') {
            const val = obj[key];
            if (/low quality|lowres|watermark|jpeg artifacts|worst quality/i.test(val)) {
                negativeArr.push(val);
            } else {
                positiveArr.push(val);
            }
            // Handle tags key (always positive)
        } else if (key === 'tags' && typeof obj[key] === 'string') {
            positiveArr.push(obj[key]);
            // Handle explicit positive key
        } else if ((key === 'positive' || key === 'positive_prompt') && typeof obj[key] === 'string') {
            positiveArr.push(obj[key]);
            // Handle explicit negative key
        } else if ((key === 'negative' || key === 'negative_prompt') && typeof obj[key] === 'string') {
            negativeArr.push(obj[key]);
            // Handle generic prompt key (always positive unless contains negative keywords)
        } else if (key === 'prompt' && typeof obj[key] === 'string') {
            const val = obj[key];
            if (/low quality|lowres|watermark|jpeg artifacts|worst quality/i.test(val)) {
                negativeArr.push(val);
            } else {
                positiveArr.push(val);
            }
        } else if (typeof obj[key] === 'object') {
            collectTextValuesWithNegatives(obj[key], positiveArr, negativeArr);
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
    setAndResize(positivePrompt, positive);
    setAndResize(negativePrompt, negative);

    // --- Enhanced: Split additional into items, route model keys to model-info-list ---
    if (promptInfoList) promptInfoList.innerHTML = '';
    if (modelInfoList) modelInfoList.innerHTML = '';
    if (additional) {
        const items = splitPromptInfo(additional);
        for (const item of items) {
            // Try to split into label and value at the first colon
            const colonIdx = item.indexOf(':');
            if (colonIdx !== -1) {
                const label = item.slice(0, colonIdx).trim();
                const value = item.slice(colonIdx + 1).trim();
                if (isModelInfoKey(label)) {
                    addMetadataItem(label, value, modelInfoList);
                } else {
                    addMetadataItem(label, value, promptInfoList);
                }
            } else {
                // If no colon, just display as value with empty label
                addMetadataItem('', item.trim(), promptInfoList);
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

// Copy textarea text using the modern clipboard API
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
                    void label.offsetWidth;
                    setTimeout(() => {
                        label.style.opacity = '0';
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

// Scroll-to-top arrow
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