/**
 * script.js with Exif reader, PNG, JPEG and WebP integration for metadata extraction.
 * (c) otacoo / otakudude / doublerunes, GPLv3
 */

// --- DOM element references ---
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
    return str.replace(/^(Prompt:|Workflow:)/, '').trim();
}

// --- Helper: Determine if a key should go to model-info-list ---
function isModelInfoKey(key, value) {
    if (!key) return false;
    // Skip if value is missing, empty, or 'none'
    if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim().toLowerCase() === 'none') ||
        (typeof value === 'string' && value.trim() === '')
    ) {
        return false;
    }
    const normalized = key.trim().toLowerCase();
    const modelKeys = [
        'ckpt', 'ckpt_name', 'checkpoint', 'model', 'modelname', 'lora', 'lora_name', 'lora hashes'
    ];
    return (
        modelKeys.includes(normalized) ||
        // lora_* or lora-* pattern (case-insensitive)
        /^lora[_\-].+/i.test(normalized) ||
        // "lora hashes" with any whitespace
        normalized.replace(/\s+/g, '') === 'lorahashes' ||
        /^model[_]?name$/.test(normalized)
    );
}

// --- CivitAI metadata: parameters chunk with extraMetadata (ComfyUI Civitai format) ---
function extractCivitAIMetadata(parsed) {
    try {
        const em = parsed.extraMetadata;
        if (em == null) return null;
        const md = typeof em === 'string' ? safeJsonParse(em) : em;
        if (!md || typeof md !== 'object') return null;
        const prompt = md.prompt != null ? String(md.prompt) : '';
        const negative = md.negativePrompt != null ? String(md.negativePrompt) : '';
        const extra = [];
        if (md.steps != null) extra.push('Steps: ' + md.steps);
        if (md.sampler) extra.push('Sampler: ' + md.sampler);
        if (md.cfgScale != null) extra.push('CFG scale: ' + md.cfgScale);
        if (md.seed != null) extra.push('Seed: ' + md.seed);
        if (md.resources) extra.push('Civitai resources: ' + JSON.stringify(md.resources));
        return { prompt, negative, extra: extra.join(', ') };
    } catch (e) {
        return null;
    }
}

// --- ComfyUI: prompt graph (class_type nodes) or generation_data ---
function extractComfyUIMetadata(parsed) {
    const negativeKeywords = /bad quality|worst quality|low quality|bad anatomy|lowres/i;
    const positiveKeywords = /masterpiece|absurdres|best quality|very aesthetic|1girl|2girls|3girls/i;
    function getNodesValues(graph, classTypeRegex, fields, excludeNegative) {
        if (!graph || typeof graph !== 'object') return [];
        const out = [];
        for (const key in graph) {
            if (!graph.hasOwnProperty(key)) continue;
            const node = graph[key];
            if (!node || !classTypeRegex.test((node.class_type || '').toLowerCase())) continue;
            const inputs = node.inputs;
            if (!inputs) continue;
            const vals = fields.map(function (f) { return inputs[f]; }).filter(function (v) { return typeof v === 'string' || typeof v === 'number'; });
            vals.forEach(function (val) {
                const str = String(val).replace(/_/g, ' ');
                if (excludeNegative && negativeKeywords.test(str)) return;
                if (!excludeNegative) {
                    if (!negativeKeywords.test(str)) return;
                    if (positiveKeywords.test(str)) return;
                }
                out.push(typeof val === 'number' ? String(val) : val);
            });
        }
        return out;
    }
    function getFirst(graph, classTypeRegex, fields) {
        const arr = getNodesValues(graph, classTypeRegex, fields, true);
        return arr.length ? arr[0] : undefined;
    }
    try {
        if (parsed.generation_data && typeof parsed.generation_data === 'string') {
            const s = parsed.generation_data;
            const end = s.lastIndexOf('}') + 1;
            const md = end > 0 ? safeJsonParse(s.slice(0, end)) : null;
            if (md && typeof md === 'object') {
                const prompt = md.prompt != null ? String(md.prompt) : '';
                const negative = (md.negativePrompt != null ? String(md.negativePrompt) : '') || (md.negative ? String(md.negative) : '');
                const extra = [];
                if (md.steps != null) extra.push('Steps: ' + md.steps);
                if (md.samplerName) extra.push('Sampler: ' + md.samplerName);
                if (md.cfgScale != null) extra.push('CFG scale: ' + md.cfgScale);
                if (md.seed != null) extra.push('Seed: ' + md.seed);
                if (md.width != null && md.height != null) extra.push('Size: ' + md.width + 'x' + md.height);
                if (md.baseModel && (md.baseModel.modelFileName || md.baseModel.hash)) {
                    if (md.baseModel.hash) extra.push('Model hash: ' + md.baseModel.hash);
                    if (md.baseModel.modelFileName) extra.push('Model: ' + md.baseModel.modelFileName);
                }
                return { prompt, negative, extra: extra.join(', ') };
            }
        }
        const p = parsed.prompt;
        if (p && typeof p === 'object' && !Array.isArray(p)) {
            const hasClassType = Object.keys(p).some(function (k) {
                const n = p[k];
                return n && typeof n === 'object' && n.class_type;
            });
            if (hasClassType) {
                const re = /cliptextencode|wildcard|textboxmira|eff\. loader|ttn text/i;
                const posFields = ['text', 'positive', 'wildcard_text', 'clip_l', 't5xxl', 'string_a', 'string_b'];
                const negFields = ['text', 'negative', 'wildcard_text'];
                const positiveArr = getNodesValues(p, re, posFields, true);
                const negativeArr = getNodesValues(p, re, negFields, false);
                const prompt = positiveArr.join('\n');
                const negative = negativeArr.join('\n');
                const extra = [];
                const steps = getFirst(p, /scheduler|sampler/i, ['steps']);
                const sampler = getFirst(p, /scheduler|sampler/i, ['sampler_name']);
                const cfg = getFirst(p, /guidance|sampler|cliptextencode/i, ['guidance', 'cfg']);
                const seed = getFirst(p, /randomnoise|sampler|seed/i, ['noise_seed', 'seed']);
                const w = getFirst(p, /latentimage|loader/i, ['width', 'empty_latent_width']);
                const h = getFirst(p, /latentimage|loader/i, ['height', 'empty_latent_height']);
                const model = getFirst(p, /checkpoint|loader/i, ['ckpt_name', 'base_ckpt_name', 'unet_name']);
                if (steps != null) extra.push('Steps: ' + steps);
                if (sampler) extra.push('Sampler: ' + sampler);
                if (cfg != null) extra.push('CFG scale: ' + cfg);
                if (seed != null) extra.push('Seed: ' + seed);
                if (w != null && h != null) extra.push('Size: ' + w + 'x' + h);
                if (model) extra.push('Model: ' + model);
                return { prompt, negative, extra: extra.join(', ') };
            }
        }
    } catch (e) {
        console.warn('ComfyUI extraction failed:', e);
    }
    return null;
}

// --- Centralized prompt data distribution ---
function distributePromptData(parsed, comment, sourceTag) {
    let found = false;
    if (parsed && typeof parsed === 'object') {
        // --- CivitAI (parameters with extraMetadata, e.g. ComfyUI Civitai) ---
        if (parsed.extraMetadata != null) {
            const civit = extractCivitAIMetadata(parsed);
            if (civit) {
                setAndResize(positivePrompt, unescapePromptString(civit.prompt));
                setAndResize(negativePrompt, unescapePromptString(civit.negative));
                const additionalPromptsTextarea = document.getElementById('additional-prompts');
                if (additionalPromptsTextarea) setAndResize(additionalPromptsTextarea, '');
                if (promptInfoList) promptInfoList.innerHTML = '';
                if (modelInfoList) modelInfoList.innerHTML = '';
                if (civit.extra) addMetadataItem('Parameters', civit.extra, promptInfoList);
                collectPromptInfo(parsed, function (key, value) {
                    if (!isModelInfoKey(key, value)) addMetadataItem(key, value, promptInfoList);
                }, function (key, value) {
                    if (isModelInfoKey(key, value)) addMetadataItem(key, value, modelInfoList);
                });
                walkForModelInfo(parsed, function (k, v) { addMetadataItem(k, v, modelInfoList); });
                setGenerationMetadataType('CivitAI');
                clearWarning();
                found = true;
            }
        }
        // --- ComfyUI (prompt graph or generation_data) ---
        if (!found && (parsed.generation_data || (parsed.prompt && typeof parsed.prompt === 'object' && Object.keys(parsed.prompt).some(function (k) {
            const n = parsed.prompt[k];
            return n && typeof n === 'object' && n.class_type;
        })))) {
            const comfy = extractComfyUIMetadata(parsed);
            if (comfy) {
                setAndResize(positivePrompt, unescapePromptString(comfy.prompt));
                setAndResize(negativePrompt, unescapePromptString(comfy.negative));
                const additionalPromptsTextarea = document.getElementById('additional-prompts');
                if (additionalPromptsTextarea) setAndResize(additionalPromptsTextarea, '');
                if (promptInfoList) promptInfoList.innerHTML = '';
                if (modelInfoList) modelInfoList.innerHTML = '';
                if (comfy.extra) addMetadataItem('Parameters', comfy.extra, promptInfoList);
                addMetadataAsJsonBlock(parsed, promptInfoList, sourceTag);
                walkForModelInfo(parsed, function (k, v) { addMetadataItem(k, v, modelInfoList); });
                setGenerationMetadataType('ComfyUI');
                clearWarning();
                found = true;
            }
        }
        // --- NovelAI v4/v5 JSON Handler ---
        if (!found && parsed.hasOwnProperty('signed_hash') && parsed.hasOwnProperty('sampler')) {
            const positiveTexts = [];
            if (parsed.prompt && typeof parsed.prompt === 'string') {
                positiveTexts.push(parsed.prompt);
            }
            if (parsed.v4_prompt && parsed.v4_prompt.caption && Array.isArray(parsed.v4_prompt.caption.char_captions)) {
                parsed.v4_prompt.caption.char_captions.forEach(charCap => {
                    if (charCap.char_caption && charCap.char_caption.trim()) {
                        positiveTexts.push(charCap.char_caption);
                    }
                });
            }

            let negativeText = '';
            if (parsed.uc && typeof parsed.uc === 'string') {
                negativeText = parsed.uc;
            } else if (parsed.v4_negative_prompt && parsed.v4_negative_prompt.caption && parsed.v4_negative_prompt.caption.base_caption) {
                negativeText = parsed.v4_negative_prompt.caption.base_caption;
            }

            setAndResize(positivePrompt, positiveTexts.map(unescapePromptString).join('\n\n'));
            setAndResize(negativePrompt, unescapePromptString(negativeText));

            const additionalPromptsTextarea = document.getElementById('additional-prompts');
            if (additionalPromptsTextarea) {
                setAndResize(additionalPromptsTextarea, ''); // Clear as it's handled above
            }

            if (promptInfoList) promptInfoList.innerHTML = '';
            if (modelInfoList) modelInfoList.innerHTML = '';

            const infoData = { ...parsed };
            delete infoData.prompt;
            delete infoData.uc;
            delete infoData.v4_prompt;
            delete infoData.v4_negative_prompt;

            collectPromptInfo(
                infoData,
                (key, value) => {
                    if (!isModelInfoKey(key, value)) { addMetadataItem(key, value, promptInfoList); }
                },
                (key, value) => {
                    if (isModelInfoKey(key, value)) { addMetadataItem(key, value, modelInfoList); }
                }
            );

            walkForModelInfo(parsed, (k, v) => addMetadataItem(k, v, modelInfoList));
            setGenerationMetadataType('NovelAI');
            clearWarning();
            found = true;
        } else if (parsed.generation_mode !== undefined && (parsed.positive_prompt !== undefined || parsed.negative_prompt !== undefined || parsed.value !== undefined || parsed.Value !== undefined)) {
            // --- InvokeAI metadata (Invokeai_metadata chunk / WebP EXIF) ---
            const positiveParts = [];
            if (typeof parsed.positive_prompt === 'string' && parsed.positive_prompt.trim()) {
                positiveParts.push(parsed.positive_prompt);
            }
            // "value" / "Value" holds the positive prompt (e.g. in graph or WebP)
            const valueStr = parsed.value ?? parsed.Value;
            if (typeof valueStr === 'string' && valueStr.trim()) {
                positiveParts.push(valueStr);
            }
            const positiveText = positiveParts.map(unescapePromptString).join('\n\n');
            const negativeText = typeof parsed.negative_prompt === 'string' ? parsed.negative_prompt : '';
            setAndResize(positivePrompt, positiveText);
            setAndResize(negativePrompt, unescapePromptString(negativeText));

            const additionalPromptsTextarea = document.getElementById('additional-prompts');
            if (additionalPromptsTextarea) {
                setAndResize(additionalPromptsTextarea, '');
            }

            if (promptInfoList) promptInfoList.innerHTML = '';
            if (modelInfoList) modelInfoList.innerHTML = '';

            addMetadataAsJsonBlock(parsed, promptInfoList, sourceTag);
            walkForModelInfo(parsed, (k, v) => addMetadataItem(k, v, modelInfoList));
            setGenerationMetadataType('InvokeAI');
            clearWarning();
            found = true;
        } else {
            // --- ComfyUI (generic JSON handler) ---
            // 1. Collect all "text" values (recursively) for positive and negative prompts
            const positiveTexts = [];
            const negativeTexts = [];
            collectTextValuesWithNegatives(parsed, positiveTexts, negativeTexts);

            // 2. Find all "wildcard_text" and "extraMetadata" (prompt only) values for #additional-prompts
            const wildcardTexts = [];
            collectAllKeyValues(parsed, 'wildcard_text', wildcardTexts);
            const extraMetadataPrompts = [];
            collectExtraMetadataPromptOnly(parsed, extraMetadataPrompts);

            // Process extraMetadataPrompts to separate positive and negative prompts
            for (let i = 0; i < extraMetadataPrompts.length; i++) {
                const prompt = extraMetadataPrompts[i];
                if (typeof prompt === 'string' && prompt.startsWith('__NEGATIVE__')) {
                    // This is a negative prompt from extraMetadata
                    negativeTexts.push(prompt.substring('__NEGATIVE__'.length));
                    // Remove from extraMetadataPrompts
                    extraMetadataPrompts.splice(i, 1);
                    i--; // Adjust index since we removed an item
                }
            }

            setAndResize(positivePrompt, positiveTexts.map(unescapePromptString).join('\n'));
            setAndResize(negativePrompt, negativeTexts.map(unescapePromptString).join('\n'));

            const additionalPromptsTextarea = document.getElementById('additional-prompts');
            if (additionalPromptsTextarea) {
                let combined = [...wildcardTexts, ...extraMetadataPrompts];
                setAndResize(additionalPromptsTextarea, combined.join('\n'));
            }

            // 3. Additional Info as JSON block; Models list from model keys only
            if (promptInfoList) promptInfoList.innerHTML = '';
            if (modelInfoList) modelInfoList.innerHTML = '';
            addMetadataAsJsonBlock(parsed, promptInfoList, sourceTag);
            walkForModelInfo(parsed, (k, v) => addMetadataItem(k, v, modelInfoList));
            setGenerationMetadataType('ComfyUI');
            clearWarning();
            found = true;
        }
    }
    if (!found && comment && comment.trim()) {
        clearWarning();
        setGenerationMetadataType('A1111');
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
            // For tEXt/iTXt, decode as ISO-8859-1 string; zTXt stores compressed data (decompressed in extractPngMetadata)
            if (['tEXt', 'iTXt'].includes(type)) {
                let text = '';
                for (let i = 0; i < chunkData.length; i++) {
                    text += String.fromCharCode(chunkData[i]);
                }
                chunks[type].data_raw.push(text);
            } else if (type === 'zTXt') {
                chunks[type].data_raw.push(chunkData);
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
    const themeToggle = document.getElementById('theme-toggle');
    const sunIcon = document.querySelector('.sun-icon');
    const moonIcon = document.querySelector('.moon-icon');

    // --- Theme toggle functionality ---
    if (themeToggle) {
        // Check for saved theme preference or use default
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
            if (sunIcon) sunIcon.style.display = 'none';
            if (moonIcon) moonIcon.style.display = 'block';
        }

        // Toggle theme when button is clicked
        themeToggle.addEventListener('click', function () {
            document.body.classList.toggle('light-mode');

            // Toggle icons
            if (document.body.classList.contains('light-mode')) {
                if (sunIcon) sunIcon.style.display = 'none';
                if (moonIcon) moonIcon.style.display = 'block';
                localStorage.setItem('theme', 'light');
            } else {
                if (sunIcon) sunIcon.style.display = 'block';
                if (moonIcon) moonIcon.style.display = 'none';
                localStorage.setItem('theme', 'dark');
            }
        });
    }

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
        if (additionalContainer) {
            additionalContainer.classList.toggle('expanded', expanded);
            additionalContainer.classList.toggle('collapsed', !expanded);
        }
        if (toggleText) {
            toggleText.textContent = expanded ? 'Hide additional info' : 'Show additional info';
            toggleText.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
        chevrons.forEach(chev => chev.classList.toggle('rotate', expanded));
    }

    // --- Expose for programmatic use if needed ---
    window.showExpandedInfo = function () { setExpanded(true); };
    window.hideExpandedInfo = function () { setExpanded(false); };

    // --- Expose for prompt metadata control ---
    window.setPromptInfoAvailable = function (hasPromptInfo) {
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
        if (toggleText) {
            toggleText.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    setExpanded(!expanded);
                    e.preventDefault();
                }
            });
        }
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
    // Only try to parse if it looks like JSON
    if (!(fixed.startsWith('{') || fixed.startsWith('['))) {
        return null;
    }
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
    // Replace double-backslash n (\\n) and single-backslash n (\n) with real newline
    return str
        .replace(/\\\\n/g, "\n")   // double-backslash n
        .replace(/\\n/g, "\n")     // single-backslash n
        .replace(/\\\\/g, "\\");   // unescape any remaining double backslashes
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
        if (
            comment &&
            typeof comment === 'string' &&
            comment.trim().startsWith('UNICODE')
        ) {
            setExpanded(true);
        }
        if (comment) {
            window.setPromptInfoAvailable(true);
            let jsonStr = stripPromptPrefix(comment.trim());
            let parsed = safeJsonParse(jsonStr);
            distributePromptData(parsed, comment, sourceTag);

            // Auto-expand the additional info section for JPEGs with metadata
            if (typeof window.showExpandedInfo === 'function') {
                window.showExpandedInfo();
            } else if (typeof setExpanded === 'function') {
                setExpanded(true);
            }
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
                // Try JSON first (e.g. InvokeAI metadata in WebP UserComment)
                let jsonStr = stripPromptPrefix(comment.trim());
                let parsed = safeJsonParse(jsonStr);
                if (parsed && typeof parsed === 'object') {
                    distributePromptData(parsed, comment, 'UserComment');
                } else {
                    parseAndDisplayUserComment(comment);
                }
            } else {
                window.setPromptInfoAvailable(false);
                showWarning('❌ No metadata found');
            }
        }
    });
}

// --- NovelAI Alpha Channel Metadata Extraction ---
function extractNovelAIAlphaMetadata(file, callback) {
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const pixels = imageData.data;
                
                // Extract LSB from alpha channel
                let binaryString = '';
                for (let i = 3; i < pixels.length; i += 4) {
                    // Get the least significant bit of the alpha channel
                    binaryString += (pixels[i] & 1).toString();
                }
                
                // Convert binary string to text
                const metadata = binaryStringToText(binaryString);
                
                if (metadata) {
                    console.log('NovelAI alpha channel metadata found:', metadata);
                    callback(metadata);
                } else {
                    callback(null);
                }
            } catch (err) {
                console.error('Error extracting NovelAI alpha metadata:', err);
                callback(null);
            }
        };
        img.onerror = function() {
            console.error('Failed to load image for alpha channel extraction');
            callback(null);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * Convert binary string to text, stopping at null terminator or invalid data
 */
function binaryStringToText(binaryString) {
    let text = '';
    let foundStart = false;
    
    // Process in 8-bit chunks
    for (let i = 0; i < binaryString.length - 7; i += 8) {
        const byte = binaryString.substr(i, 8);
        const charCode = parseInt(byte, 2);
        
        // Stop at null terminator
        if (charCode === 0) {
            if (foundStart) break;
            continue;
        }
        
        // Look for JSON start
        if (charCode === 123) { // '{'
            foundStart = true;
        }
        
        if (foundStart) {
            text += String.fromCharCode(charCode);
        }
        
        // Stop if we've found a complete JSON object
        if (foundStart && charCode === 125) { // '}'
            // Try to parse to see if it's valid
            try {
                JSON.parse(text);
                break; // Valid JSON found, stop here
            } catch (e) {
                // Continue, might be nested JSON
            }
        }
    }
    
    // Validate that we have JSON-like content
    if (text.trim().startsWith('{') && text.includes('"')) {
        return text.trim();
    }
    
    return null;
}

// --- Decompress zTXt chunk (zlib); same approach as ai-image-metadata-editor: Blob stream + 'deflate' ---
function decompressZlibToStr(zlibBytes) {
    if (!zlibBytes.length || typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    const stream = new Blob([zlibBytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    return (function read() {
        return reader.read().then(function (result) {
            if (result.done) {
                const dec = new Uint8Array(total);
                let off = 0;
                for (let c = 0; c < chunks.length; c++) {
                    dec.set(chunks[c], off);
                    off += chunks[c].length;
                }
                let s = '';
                for (let i = 0; i < dec.length; i++) s += String.fromCharCode(dec[i]);
                return s;
            }
            if (result.value) {
                chunks.push(result.value);
                total += result.value.byteLength;
            }
            return read();
        });
    })();
}

function decompressZtxt(rawBytes) {
    if (!(rawBytes instanceof Uint8Array) || rawBytes.length < 3) {
        return Promise.resolve({ text: '', fallback: '' });
    }
    const sepIdx = rawBytes.indexOf(0);
    if (sepIdx === -1) return Promise.resolve({ text: '', fallback: '' });
    const zlibStream = rawBytes.slice(sepIdx + 2);
    if (zlibStream.length < 6) return Promise.resolve({ text: '', fallback: '' });

    // Fallback: raw bytes as Latin-1 (so we can still show keyword and try to display)
    let fallbackStr = '';
    for (let j = 0; j < rawBytes.length; j++) fallbackStr += String.fromCharCode(rawBytes[j]);

    if (typeof DecompressionStream === 'undefined') {
        return Promise.resolve({ text: fallbackStr, fallback: fallbackStr });
    }

    return decompressZlibToStr(zlibStream)
        .then(function (text) {
            return text ? { text: text, fallback: fallbackStr } : { text: '', fallback: fallbackStr };
        })
        .catch(function (err) {
            console.warn('zTXt decompression failed:', err);
            return { text: '', fallback: fallbackStr };
        });
}

// --- PNG metadata extraction with prompt distribution ---
function extractPngMetadata(file) {
    const reader = new FileReader();
    reader.onload = async function (e) {
        const arrayBuffer = e.target.result;
        const bytes = new Uint8Array(arrayBuffer);
        try {
            const pngMeta = new PNGMetadata(bytes, 'byte');
            const chunks = pngMeta.getChunks();
            let found = false;
            // 1. Try tEXt, zTXt, iTXt chunks first
            for (const chunkType of ['tEXt', 'zTXt', 'iTXt']) {
                if (!chunks[chunkType] || chunks[chunkType].data_raw.length === 0) continue;
                for (let i = 0; i < chunks[chunkType].data_raw.length; i++) {
                    let raw = chunks[chunkType].data_raw[i];
                    let keyword = '';
                    let text = '';
                    if (chunkType === 'zTXt' && raw instanceof Uint8Array) {
                        const nul = raw.indexOf(0);
                        if (nul <= 0) continue;
                        keyword = String.fromCharCode.apply(null, raw.subarray(0, nul));
                        const decompressed = await decompressZtxt(raw);
                        const rawStr = (decompressed && decompressed.text) ? decompressed.text : (decompressed && decompressed.fallback) ? decompressed.fallback : '';
                        if (!rawStr) continue;
                        const sepIdx = rawStr.indexOf('\0');
                        if (sepIdx >= 0) {
                            keyword = rawStr.substring(0, sepIdx);
                            text = rawStr.substring(sepIdx + 1);
                        } else {
                            text = rawStr;
                        }
                    } else {
                        const sepIdx = raw.indexOf('\0');
                        if (sepIdx === -1) continue;
                        keyword = raw.substring(0, sepIdx);
                        text = raw.substring(sepIdx + 1);
                    }
                    if (!keyword) continue;
                    console.log('PNG chunk:', chunkType, 'keyword:', keyword);
                    if (["prompt", "parameters", "usercomment", "comment", "description", "result", "invokeai_metadata", "invokeai_graph"].includes(keyword.toLowerCase())) {
                        let promptText = text;
                        console.log('Found PNG metadata with keyword:', keyword);
                        window.setPromptInfoAvailable(true);

                        // Trim leading text before JSON starts if it looks like NovelAI metadata
                        let textToParse = promptText;
                        if (promptText.includes('"sampler"') && promptText.includes('"signed_hash"')) {
                            const jsonStartIndex = promptText.indexOf('{');
                            if (jsonStartIndex > -1) {
                                textToParse = promptText.substring(jsonStartIndex);
                            }
                        }
                        
                        let parsed = safeJsonParse(textToParse);
                        distributePromptData(parsed, promptText, keyword);
                        found = true;
                        // --- Auto-expand the additional info section for PNGs with metadata
                        if (typeof window.showExpandedInfo === 'function') {
                            window.showExpandedInfo();
                        } else if (typeof setExpanded === 'function') {
                            setExpanded(true);
                        }
                    }
                }
            }
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
                    // --- Auto-expand the additional info section for PNGs with metadata
                    if (typeof window.showExpandedInfo === 'function') {
                        window.showExpandedInfo();
                    } else if (typeof setExpanded === 'function') {
                        setExpanded(true);
                    }
                }
            }
            // 3. If still not found, try NovelAI alpha channel extraction
            if (!found) {
                console.log('PNG: No metadata in text/EXIF chunks, trying NovelAI alpha channel extraction');
                extractNovelAIAlphaMetadata(file, function(alphaMetadata) {
                    if (alphaMetadata) {
                        console.log('NovelAI alpha metadata extracted:', alphaMetadata);
                        window.setPromptInfoAvailable(true);
                        let parsed = safeJsonParse(alphaMetadata);
                        distributePromptData(parsed, alphaMetadata, 'NovelAI Alpha Channel');
                        // Auto-expand the additional info section
                        if (typeof window.showExpandedInfo === 'function') {
                            window.showExpandedInfo();
                        } else if (typeof setExpanded === 'function') {
                            setExpanded(true);
                        }
                    } else {
                        console.warn('No prompt metadata found in PNG (including alpha channel)');
                        window.setPromptInfoAvailable(false);
                        showWarning('❌ No prompt metadata found');
                    }
                });
                return; // Exit early since alpha extraction is async
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

// --- Helper: Collect all values for a key in a nested object ---
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

// --- Helper: Collect only the "prompt" property from any "extraMetadata" object in a nested structure ---
function collectExtraMetadataPromptOnly(obj, resultArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        obj.forEach(item => collectExtraMetadataPromptOnly(item, resultArr));
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === 'extraMetadata') {
            // Handle both string and object formats
            if (typeof obj[key] === 'string') {
                try {
                    // Parse the escaped JSON string
                    const extraMetaObj = JSON.parse(obj[key]);
                    if (typeof extraMetaObj.prompt === 'string') {
                        resultArr.push(extraMetaObj.prompt);
                    }
                    // Also check for negativePrompt
                    if (typeof extraMetaObj.negativePrompt === 'string') {
                        // Store negative prompts with a special marker
                        resultArr.push('__NEGATIVE__' + extraMetaObj.negativePrompt);
                    }
                } catch (e) {
                    console.warn('Failed to parse extraMetadata string:', e);
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                if (typeof obj[key].prompt === 'string') {
                    resultArr.push(obj[key].prompt);
                }
                // Also check for negativePrompt
                if (typeof obj[key].negativePrompt === 'string') {
                    // Store negative prompts with a special marker
                    resultArr.push('__NEGATIVE__' + obj[key].negativePrompt);
                }
            }
        } else if (typeof obj[key] === 'object') {
            collectExtraMetadataPromptOnly(obj[key], resultArr);
        }
    }
}

// --- Helper: Pretty-print as JSON for display ---
function safeStringifyForDisplay(obj) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(obj, function (key, value) {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) return '[Circular]';
                seen.add(value);
            }
            return value;
        }, 2);
    } catch (e) {
        return String(obj);
    }
}
var preBlockStyle = 'margin:0.5em 0;white-space:pre-wrap;font-size:0.9em;max-height:30em;overflow:auto;';
function addJsonBlockWithLabel(label, value, listElement) {
    if (!listElement) return;
    const jsonStr = safeStringifyForDisplay(value);
    const escaped = jsonStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    addMetadataItem(label, '<pre style="' + preBlockStyle + '">' + escaped + '</pre>', listElement);
}
// --- Helper: Get object property by key (case-insensitive) ---
function getValueIgnoreCase(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    const k = (key || '').toString().toLowerCase();
    for (const name in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, name) && name.toLowerCase() === k) return obj[name];
    }
    return undefined;
}
// --- Helper: Add metadata as JSON code block(s). If both Prompt and Workflow exist, show a separate block for each. ---
function addMetadataAsJsonBlock(parsed, listElement, sourceLabel) {
    if (!listElement || !parsed) return;
    const promptVal = getValueIgnoreCase(parsed, 'prompt');
    let workflowVal = getValueIgnoreCase(parsed, 'workflow');
    if (workflowVal === undefined || workflowVal === null) {
        const workflowKey = Object.keys(parsed).find(function (k) { return /workflow/.test((k || '').toLowerCase()); });
        if (workflowKey) workflowVal = parsed[workflowKey];
    }
    const hasPrompt = promptVal !== undefined && promptVal !== null;
    const hasWorkflow = workflowVal !== undefined && workflowVal !== null;
    if (hasPrompt && hasWorkflow) {
        addJsonBlockWithLabel('Prompt', promptVal, listElement);
        addJsonBlockWithLabel('Workflow', workflowVal, listElement);
    } else if (hasWorkflow && !hasPrompt) {
        addJsonBlockWithLabel('Workflow', workflowVal, listElement);
    } else {
        const jsonStr = safeStringifyForDisplay(parsed);
        const escaped = jsonStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        addMetadataItem(sourceLabel || 'Metadata', '<pre style="' + preBlockStyle + '">' + escaped + '</pre>', listElement);
    }
}

// --- Helper: Collect prompt info for prompt-info-list and model-info-list ---
function collectPromptInfo(obj, cbPrompt, cbModel) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        obj.forEach(item => collectPromptInfo(item, cbPrompt, cbModel));
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        const value = obj[key];
        if (isModelInfoKey(key, value)) {
            // If value is primitive, add directly
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                cbModel(key, value);
            }
            // If value is an array of objects, display as a sub-list
            else if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'object')) {
                // Build a sub-list as HTML
                let html = '<ul style="margin:0 0 0 1.5em;padding:0;">';
                value.forEach(item => {
                    if (typeof item === 'object' && item !== null) {
                        html += '<li style="margin-bottom:0.5em;"><ul style="margin:0 0 0 1.5em;padding:0;">';
                        for (const subKey in item) {
                            if (!item.hasOwnProperty(subKey)) continue;
                            html += `<li><strong>${subKey}:</strong> ${item[subKey]}</li>`;
                        }
                        html += '</ul></li>';
                    } else {
                        html += `<li>${item}</li>`;
                    }
                });
                html += '</ul>';
                cbModel(key, html);
            }
            // If value is an object, pretty-print as key-value pairs
            else if (typeof value === 'object' && value !== null) {
                let html = '<ul style="margin:0 0 0 1.5em;padding:0;">';
                for (const subKey in value) {
                    if (!value.hasOwnProperty(subKey)) continue;
                    html += `<li><strong>${subKey}:</strong> ${value[subKey]}</li>`;
                }
                html += '</ul>';
                cbModel(key, html);
            }
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            cbPrompt(key, value);
        } else if (typeof value === 'object' && value !== null) {
            collectPromptInfo(value, cbPrompt, cbModel);
        }
    }
}

// --- Helper: Collect all "text" values and separate negative and positives ---
function collectTextValuesWithNegatives(obj, positiveArr, negativeArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        obj.forEach(item => collectTextValuesWithNegatives(item, positiveArr, negativeArr));
        return;
    }
    // Define keys to check for prompt text (case-insensitive, ignore trailing colon/whitespace)
    const promptKeys = ['text', 'text_l', 'text_a', 'text_b', 'negative', 'positive', 'result', 'tags', 'string', 'string_field', 'string_a', 'string_b', 'prompt', 'populated_text', 'value'];
    // Negative/positive regex
    const negativeRegex = /low quality|censored|lowres|watermark|jpeg artifacts|worst quality|bad quality/i;
    const positiveRegex = /masterpiece|absurdres|best quality|very aesthetic|1girl|2girls|3girls/i;

    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        const value = obj[key];
        if (typeof value === 'string') {
            // Normalize key: lowercase, remove trailing colon/whitespace
            const normKey = key.trim().replace(/:$/, '').toLowerCase();
            if (normKey === 'value' || normKey === 'string_a' || normKey === 'string_b') {
                // "value", "string_a", "string_b" treated as positive prompt (InvokeAI, ComfyUI)
                positiveArr.push(value);
            } else if (promptKeys.includes(normKey)) {
                // Text containing positive indicators (e.g. "masterpiece") must never go to negative prompt
                if (positiveRegex.test(value)) {
                    positiveArr.push(value);
                } else if (negativeRegex.test(value)) {
                    negativeArr.push(value);
                }
                // If it doesn't match either, don't add it
            }
        } else if (typeof value === 'object') {
            collectTextValuesWithNegatives(value, positiveArr, negativeArr);
        }
    }
}

// --- Helper: Recursively walk object/array for model info keys and call cbModel for each found. ---
function walkForModelInfo(obj, cbModel) {
    if (Array.isArray(obj)) {
        obj.forEach(item => walkForModelInfo(item, cbModel));
    } else if (typeof obj === 'object' && obj !== null) {
        for (const k in obj) {
            if (!obj.hasOwnProperty(k)) continue;
            const v = obj[k];
            if (isModelInfoKey(k, v) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
                cbModel(k, v);
            }
            if (typeof v === 'object' && v !== null) {
                walkForModelInfo(v, cbModel);
            }
        }
    }
}

// --- Helper: Extract JSON value from a string using bracket matching ---
function extractJsonValue(str, startIdx) {
    // str: the full string
    // startIdx: index of the first '[' or '{'
    let open = str[startIdx];
    let close = open === '[' ? ']' : '}';
    let depth = 0;
    for (let i = startIdx; i < str.length; i++) {
        if (str[i] === open) depth++;
        if (str[i] === close) depth--;
        if (depth === 0) {
            return str.slice(startIdx, i + 1);
        }
    }
    return null; // Not found
}

/**
 * Parse the UserComment string and distribute to UI elements.
 * - All text until "Negative prompt:" (excluded) -> #positive-prompt
 * - "Negative prompt:" until "Steps:" (excluded) -> #negative-prompt
 * - "Steps:" and everything after -> #prompt-info-list (as <li>s)
 * - Remove initial "UNICODE" if present
 * - Remove Template: "..." and any text within the double quotes (including the quotes)
 * - Enhanced: Recursively extract model info keys from JSON-like values in additional info.
 */
function parseAndDisplayUserComment(comment) {
    window.setPromptInfoAvailable(true);
    // Remove "UNICODE" at the start if present
    comment = comment.trim();
    comment = unescapePromptString(comment);
    if (comment.startsWith('UNICODE')) {
        comment = comment.substring('UNICODE'.length).trim();
    }
    // Find "Negative prompt:" and "Steps:"
    const negPromptIdx = comment.indexOf('Negative prompt:');
    const stepsIdx = comment.indexOf('Steps:');
    let positive = '', negative = '', additional = '';
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
    setAndResize(positivePrompt, positive);
    setAndResize(negativePrompt, negative);

    // --- Split additional into items, route model keys to model-info-list ---
    if (promptInfoList) promptInfoList.innerHTML = '';
    if (modelInfoList) modelInfoList.innerHTML = '';
    if (additional) {
        const items = splitPromptInfo(additional);
        for (const item of items) {
            const colonIdx = item.indexOf(':');
            if (colonIdx !== -1) {
                const label = item.slice(0, colonIdx).trim();
                let value = item.slice(colonIdx + 1).trim();
                // If value starts with [ or { but does not end with ] or }, try to extract the full JSON value from the original string
                if ((value.startsWith('[') && !value.endsWith(']')) || (value.startsWith('{') && !value.endsWith('}'))) {
                    // Find the position of value in the original string
                    let startIdx = additional.indexOf(value);
                    let fullJson = extractJsonValue(additional, startIdx);
                    if (fullJson) value = fullJson;
                }
                let parsedValue = value;
                let parsedSuccessfully = false;
                if (typeof value === 'string' && (value.trim().startsWith('[') || value.trim().startsWith('{'))) {
                    try {
                        console.log('Trying to parse as JSON:', value);
                        parsedValue = JSON.parse(value);
                        parsedSuccessfully = true;
                        console.log('Parsed JSON:', parsedValue);
                    } catch (e) {
                        console.warn('Failed to parse JSON:', value, e);
                    }
                }
                if (parsedSuccessfully && (Array.isArray(parsedValue) || typeof parsedValue === 'object')) {
                    walkForModelInfo(parsedValue, (k, v) => addMetadataItem(k, v, modelInfoList));
                } else if (isModelInfoKey(label, value)) {
                    addMetadataItem(label, value, modelInfoList);
                } else {
                    addMetadataItem(label, value, promptInfoList);
                }
            }
        }
    }
}

/**
 * Split the additional prompt info into items, respecting commas inside parentheses/brackets/braces.
 */
function splitPromptInfo(str) {
    const result = [];
    let current = '';
    let parenDepth = 0, bracketDepth = 0, braceDepth = 0;
    for (let i = 0; i < str.length; ++i) {
        const c = str[i];
        if (c === '(') parenDepth++;
        if (c === ')') parenDepth--;
        if (c === '[') bracketDepth++;
        if (c === ']') bracketDepth--;
        if (c === '{') braceDepth++;
        if (c === '}') braceDepth--;
        if (c === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
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

/**
 * Show the detected generation metadata type in Image Info
 */
function setGenerationMetadataType(type) {
    if (!metadataList || !type) return;
    addMetadataItem('Metadata type', type);
}

// --- UI clearing ---
function clearPromptFields() {
    setAndResize(positivePrompt, '');
    setAndResize(negativePrompt, '');
    if (promptInfoList) promptInfoList.innerHTML = '';
    if (modelInfoList) modelInfoList.innerHTML = '';
    const additionalPromptsTextarea = document.getElementById('additional-prompts');
    setAndResize(additionalPromptsTextarea, '');
}

// --- Show/clear warning ---
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

// --- Auto-resize a textarea to fit its content. ---
function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight + 2) + 'px';
}

// --- Copy textarea text using the modern clipboard API ---
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
            } catch {
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

// --- Scroll-to-top arrow ---
(function scrollArrow() {
    if (document.getElementById("scroll-to-top")) return;
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