/**
 * script.js with Exif reader for PNG, JPEG and WebP, with Civitai integration for metadata extraction.
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

// When false, skip Civitai API lookups
var civitaiCheckingEnabled = true;

// --- Decode byte array as UTF-8 (Latin-1 fallback) ---
function decodeBytesToUtf8String(bytes) {
    if (!bytes || !bytes.length) return '';
    try {
        if (typeof TextDecoder !== 'undefined') {
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        }
    } catch (e) { /* fall through */ }
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
    return s;
}

// --- PNG keywords to look for in tEXt/zTXt/iTXt chunks ---
function getPngKeywordsFromFormats() {
    return [
        'parameters', 
        'davant__batch_parameters', 
        'description', 
        'creation time', 
        'author', 
        'usercomment', 
        'creatortool', 
        'fooocus_scheme', 
        'invokeai_metadata', 
        'invokeai_graph', 
        'comment', 
        'title', 
        'software', 
        'source', 
        'result', 
        'prompt', 
        'workflow', 
        'generation_data', 
        'generation_time', 
        'camera_manufacturer', 
        'image_description'
    ];
}

// --- Get format field names ---
function getFormatFieldNames(formatName) {
    var map = {
        CivitAI: ['parameters'],
        ComfyUI: ['prompt', 'workflow', 'generation_data'],
        InvokeAI: ['invokeai_metadata', 'invokeai_graph'],
        Midjourney: ['description']
    };
    return map[formatName] || [];
}

// --- Format field display label ---
function formatFieldDisplayLabel(fieldKey) {
    var known = { prompt: 'Prompt', workflow: 'Workflow', generation_data: 'Generation data', invokeai_graph: 'InvokeAI graph', invokeai_metadata: 'InvokeAI metadata', parameters: 'Parameters', user_comment: 'User comment', comment: 'Comment', description: 'Description', title: 'Title', software: 'Software', source: 'Source', fooocus_scheme: 'Fooocus scheme', davant__batch_parameters: 'DAVANT batch parameters', creatortool: 'Creator tool', camera_manufacturer: 'Camera manufacturer', image_description: 'Image description' };
    var lower = (fieldKey || '').toString().toLowerCase();
    return known[lower] || (fieldKey + '').replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
}

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

// --- Helper: Determine if a key should go to model-info-list, skip ComfyUI noise ---
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
    const normalized = key.trim().toLowerCase().replace(/\s+/g, '');
    const nWithSpaces = key.trim().toLowerCase();

    // Exclude ComfyUI / ComfyUI-like noise (weights, count, strength, etc.)
    if (
        /^lora(wt|weight|weights?|count|modelstrength|strength|clipstrength)/i.test(normalized) ||
        /^lora\s*(wt|weight|count|model\s*strength|strength)/i.test(nWithSpaces) ||
        /strength_model|strength_clip|loracount|lorawt/i.test(normalized)
    ) {
        return false;
    }

    // Only allow: lora name, lora hashes, model/checkpoint name, model/ckpt hash, vae name, vae hash
    const modelKeys = [
        'ckpt', 'ckpt_name', 'checkpoint', 'model', 'modelname', 'lora', 'lora_name', 'loraname',
        'lorahashes', 'modelhash', 'model_hash', 'ckpt_hash', 'hash', 'vae', 'vae_name', 'vaename', 'vae_hash', 'vaehash'
    ];
    return (
        modelKeys.includes(normalized) ||
        /^model[_]?name$/.test(normalized) ||
        /^vae[_]?name$/.test(normalized) ||
        /^vae[_]?hash$/.test(normalized) ||
        // lora_name or lora-name (but not lora_wt, lora_count, etc.)
        /^lora[_\-]name$/i.test(normalized)
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

// --- ComfyUI: true if parsed has generation_data or a prompt graph (nodes with class_type) ---
function isComfyUIGraph(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.generation_data) return true;
    var p = parsed.prompt;
    return !!(p && typeof p === 'object' && Object.keys(p).some(function (k) {
        var n = p[k];
        return n && typeof n === 'object' && n.class_type;
    }));
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
        if (p && typeof p === 'object') {
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

// --- InvokeAI: keyword "invokeai_metadata" or "invokeai_graph" ---
function isInvokeAIKeyword(tag) {
    if (tag == null || typeof tag !== 'string') return false;
    var n = tag.toLowerCase().replace(/-/g, '_').trim();
    return n === 'invokeai_metadata' || n === 'invokeai_graph';
}

// --- Midjourney: keyword "Description" with plain text only ---
function isMidjourneyKeyword(tag) {
    if (tag == null || typeof tag !== 'string') return false;
    return tag.trim().toLowerCase() === 'description';
}

// --- NovelAI: signed_hash+sampler or Software contains "NovelAI" ---
function isNovelAIMetadata(parsed) {
    return parsed && typeof parsed === 'object' && parsed.hasOwnProperty('signed_hash') && parsed.hasOwnProperty('sampler');
}

function isNovelAISoftware(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    var sw = parsed.software || parsed.Software;
    return typeof sw === 'string' && sw.toLowerCase().indexOf('novelai') !== -1;
}

function isNovelAI(parsed) {
    return isNovelAIMetadata(parsed) || isNovelAISoftware(parsed);
}

// --- Centralized prompt data distribution ---
function distributePromptData(parsed, comment, sourceTag) {
    let found = false;
    // Midjourney: keyword "Description" with plain text. 
    // NovelAI uses Description/Comment as JSON or has Software: "NovelAI".
    if (isMidjourneyKeyword(sourceTag) && !isNovelAI(parsed)) {
        var descText = (comment && typeof comment === 'string') ? comment : (parsed && typeof parsed === 'string') ? parsed : '';
        setAndResize(positivePrompt, unescapePromptString(descText));
        setAndResize(negativePrompt, '');
        var additionalPromptsTextarea = document.getElementById('additional-prompts');
        if (additionalPromptsTextarea) setAndResize(additionalPromptsTextarea, '');
        if (promptInfoList) promptInfoList.innerHTML = '';
        if (modelInfoList) modelInfoList.innerHTML = '';
        if (descText.trim()) addMetadataItem('Description', descText, promptInfoList);
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            addMetadataAsJsonBlock(parsed, promptInfoList, 'Midjourney', sourceTag);
        }
        setGenerationMetadataType('Midjourney');
        clearWarning();
        found = true;
    }
    if (!found && parsed && typeof parsed === 'object') {
        // --- ComfyUI (prompt/graph or generation_data) ---
        if (isComfyUIGraph(parsed)) {
            var comfy = extractComfyUIMetadata(parsed);
            if (comfy) {
                setAndResize(positivePrompt, unescapePromptString(comfy.prompt));
                setAndResize(negativePrompt, unescapePromptString(comfy.negative));
                var additionalPromptsTextarea = document.getElementById('additional-prompts');
                if (additionalPromptsTextarea) setAndResize(additionalPromptsTextarea, '');
                if (promptInfoList) promptInfoList.innerHTML = '';
                if (modelInfoList) modelInfoList.innerHTML = '';
                if (comfy.extra) addMetadataItem('Parameters', comfy.extra, promptInfoList);
                addMetadataAsJsonBlock(parsed, promptInfoList, 'ComfyUI', sourceTag);
                walkForModelInfo(parsed, function (k, v) { addModelInfoItem(k, v); });
                var extraMetadataResources = [];
                collectExtraMetadataResources(parsed, extraMetadataResources);
                addCivitaiResourcesToModelInfo(extraMetadataResources);
                setGenerationMetadataType('ComfyUI');
                clearWarning();
                found = true;
            }
        }
        // --- NovelAI v4/v5 JSON Handler (signed_hash+sampler or Software contains "NovelAI") ---
        if (!found && isNovelAI(parsed)) {
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

            collectPromptInfo(infoData, function (key, value) {
                if (!isModelInfoKey(key, value)) addMetadataItem(key, value, promptInfoList);
            }, function (key, value) {
                if (isModelInfoKey(key, value)) addModelInfoItem(key, value);
            });
            walkForModelInfo(parsed, addModelInfoItem);
            setGenerationMetadataType('NovelAI');
            clearWarning();
            found = true;
        } else if (isInvokeAIKeyword(sourceTag)) {
            // --- InvokeAI (detected by PNG/WebP chunk keyword invokeai_metadata or invokeai_graph) ---
            var meta = getValueIgnoreCase(parsed, 'invokeai_metadata');
            if (meta == null || typeof meta !== 'object') meta = parsed;
            var positiveParts = [];
            if (typeof meta.positive_prompt === 'string' && meta.positive_prompt.trim()) {
                positiveParts.push(meta.positive_prompt);
            }
            var valueStr = meta.value !== undefined ? meta.value : meta.Value;
            if (typeof valueStr === 'string' && valueStr.trim()) {
                positiveParts.push(valueStr);
            }
            var positiveText = positiveParts.map(unescapePromptString).join('\n\n');
            var negativeText = typeof meta.negative_prompt === 'string' ? meta.negative_prompt : '';
            setAndResize(positivePrompt, positiveText);
            setAndResize(negativePrompt, unescapePromptString(negativeText));
            var additionalPromptsTextarea = document.getElementById('additional-prompts');
            if (additionalPromptsTextarea) setAndResize(additionalPromptsTextarea, '');
            if (promptInfoList) promptInfoList.innerHTML = '';
            if (modelInfoList) modelInfoList.innerHTML = '';
            addMetadataAsJsonBlock(parsed, promptInfoList, 'InvokeAI', sourceTag);
            walkForModelInfo(meta, function (k, v) { addModelInfoItem(k, v); });
            setGenerationMetadataType('InvokeAI');
            clearWarning();
            found = true;
        } else {
            // --- ComfyUI (generic JSON handler) ---
            // 1. Collect all "text" values (recursively) for positive and negative prompts
            const positiveTexts = [];
            const negativeTexts = [];
            collectTextValuesWithNegatives(parsed, positiveTexts, negativeTexts);

            // 2. Find wildcard_text, extraMetadata (prompt only), and extraMetadata.resources for Models
            const wildcardTexts = [];
            collectAllKeyValues(parsed, 'wildcard_text', wildcardTexts);
            const extraMetadataPrompts = [];
            const extraMetadataResources = [];
            collectExtraMetadataPromptOnly(parsed, extraMetadataPrompts);
            collectExtraMetadataResources(parsed, extraMetadataResources);

            // Process extraMetadataPrompts: negative -> negativeTexts, prompt -> positive prompt (not additional)
            for (let i = 0; i < extraMetadataPrompts.length; i++) {
                const prompt = extraMetadataPrompts[i];
                if (typeof prompt === 'string' && prompt.startsWith('__NEGATIVE__')) {
                    negativeTexts.push(prompt.substring('__NEGATIVE__'.length));
                    extraMetadataPrompts.splice(i, 1);
                    i--;
                }
            }
            // extraMetadata "prompt" goes to positive prompt (e.g. JPEG UserComment / CivitAI)
            extraMetadataPrompts.forEach(function (p) {
                if (typeof p === 'string' && p.trim()) positiveTexts.push(p);
            });

            setAndResize(positivePrompt, positiveTexts.map(unescapePromptString).join('\n'));
            setAndResize(negativePrompt, negativeTexts.map(unescapePromptString).join('\n'));

            const additionalPromptsTextarea = document.getElementById('additional-prompts');
            if (additionalPromptsTextarea) {
                setAndResize(additionalPromptsTextarea, wildcardTexts.join('\n'));
            }

            // 3. Additional Info as JSON block; Models from walkForModelInfo + extraMetadata.resources (Civitai version IDs)
            if (promptInfoList) promptInfoList.innerHTML = '';
            if (modelInfoList) modelInfoList.innerHTML = '';
            addMetadataAsJsonBlock(parsed, promptInfoList, 'ComfyUI', sourceTag);
            walkForModelInfo(parsed, function (k, v) { addModelInfoItem(k, v); });
            addCivitaiResourcesToModelInfo(extraMetadataResources);
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
            if (type === 2) { // ASCII / often UTF-8 in practice (e.g. ImageDescription with CJK)
                const offset = numValues > 4 ? getUint32(valueOffset) + tiffOffset : valueOffset;
                const arr = new Uint8Array(numValues - 1);
                for (let n = 0; n < numValues - 1; n++) arr[n] = view.getUint8(offset + n);
                value = decodeBytesToUtf8String(arr);
            } else if (type === 7) { // UNDEFINED (UserComment) — plain text, often JSON-like
                const offset = numValues > 4 ? getUint32(valueOffset) + tiffOffset : valueOffset;
                const payloadLen = Math.max(0, numValues - 8);
                const payload = new Uint8Array(payloadLen);
                for (let n = 0; n < payloadLen; n++) payload[n] = view.getUint8(offset + 8 + n);
                // Many writers store JSON as UTF-8 regardless of prefix; try UTF-8 first when it looks like JSON
                const utf8Text = decodeBytesToUtf8String(payload).replace(/\0+$/, '').replace(/^\uFEFF/, '');
                if ((utf8Text.trim().startsWith('{') || utf8Text.trim().startsWith('[')) && utf8Text.trim().length > 1) {
                    value = utf8Text;
                } else {
                    const prefixBytes = [];
                    for (let n = 0; n < 8 && n < numValues; n++) {
                        prefixBytes.push(view.getUint8(offset + n));
                    }
                    const prefix = String.fromCharCode.apply(null, prefixBytes);
                    let text = '';
                    if (prefix.startsWith('ASCII')) {
                        for (let n = 8; n < numValues; n++) {
                            text += String.fromCharCode(view.getUint8(offset + n));
                        }
                    } else if (prefix.startsWith('UNICODE')) {
                        for (let n = 8; n + 1 < numValues; n += 2) {
                            const code = (view.getUint8(offset + n) << 8) | view.getUint8(offset + n + 1);
                            text += String.fromCharCode(code);
                        }
                    } else if (prefix.startsWith('UTF-8') || prefix.startsWith('UTF8')) {
                        text = decodeBytesToUtf8String(payload);
                    } else {
                        text = decodeBytesToUtf8String(payload);
                    }
                    value = text.replace(/\0+$/, '').replace(/^\uFEFF/, '');
                }
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
            // For tEXt/iTXt, decode as UTF-8 so CJK and other Unicode in metadata parse correctly; zTXt stores compressed data (decompressed in extractPngMetadata)
            if (['tEXt', 'iTXt'].includes(type)) {
                chunks[type].data_raw.push(decodeBytesToUtf8String(chunkData));
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

    // --- Civitai toggle: enable/disable model lookup and linkification ---
    const civitaiToggle = document.getElementById('civitai-toggle');
    if (civitaiToggle) {
        const civitaiIconOn = civitaiToggle.querySelector('.civitai-icon-on');
        const civitaiIconOff = civitaiToggle.querySelector('.civitai-icon-off');
        var saved = localStorage.getItem('civitaiCheckingEnabled');
        if (saved === 'false') civitaiCheckingEnabled = false;
        civitaiToggle.setAttribute('aria-pressed', civitaiCheckingEnabled ? 'true' : 'false');
        if (civitaiIconOn) civitaiIconOn.style.display = civitaiCheckingEnabled ? '' : 'none';
        if (civitaiIconOff) civitaiIconOff.style.display = civitaiCheckingEnabled ? 'none' : 'block';
        civitaiToggle.addEventListener('click', function () {
            civitaiCheckingEnabled = !civitaiCheckingEnabled;
            localStorage.setItem('civitaiCheckingEnabled', civitaiCheckingEnabled ? 'true' : 'false');
            civitaiToggle.setAttribute('aria-pressed', civitaiCheckingEnabled ? 'true' : 'false');
            if (civitaiIconOn) civitaiIconOn.style.display = civitaiCheckingEnabled ? '' : 'none';
            if (civitaiIconOff) civitaiIconOff.style.display = civitaiCheckingEnabled ? 'none' : 'block';
            if (fileInput && fileInput.files && fileInput.files[0]) {
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
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

    // --- Helper: Set expanded/collapsed state for additional info & code blocks ---
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

// --- Helper: Escape control characters inside JSON string literals (so JSON.parse can succeed) ---
function escapeControlCharsInJsonString(str) {
    if (typeof str !== 'string') return str;
    let result = '';
    let inString = false;
    let escapeNext = false;
    let i = 0;
    while (i < str.length) {
        const c = str[i];
        const code = c.charCodeAt(0);
        if (escapeNext) {
            result += c;
            escapeNext = false;
            i++;
            continue;
        }
        if (inString) {
            if (c === '\\') {
                result += c;
                escapeNext = true;
                i++;
                continue;
            }
            if (c === '"') {
                result += c;
                inString = false;
                i++;
                continue;
            }
            if (code < 32 || code === 127) {
                if (code === 9) result += '\\t';
                else if (code === 10) result += '\\n';
                else if (code === 13) result += '\\r';
                else result += '\\u' + ('0000' + code.toString(16)).slice(-4);
                i++;
                continue;
            }
            result += c;
            i++;
            continue;
        }
        if (c === '"') {
            result += c;
            inString = true;
            i++;
            continue;
        }
        result += c;
        i++;
    }
    return result;
}

// --- Helper: JSON-like string parsers ---
function safeJsonParse(str) {
    if (!str || typeof str !== 'string') {
        console.warn('safeJsonParse: Input is not a string', str);
        return null;
    }
    // Trim and strip BOM / zero-width chars (can cause "expected property name or '}'" at column 2)
    let fixed = str.trim().replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
    // Strip U+0000: EXIF UserComment is often UTF-16LE; if decoded as UTF-8 we get char+NUL between every char
    fixed = fixed.replace(/\u0000/g, '');
    // Strip control chars immediately after { or [ (e.g. from EXIF encoding)
    fixed = fixed.replace(/^(\{|\[)[\x00-\x1f]+/g, '$1');
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
    // Escape control chars inside string literals (e.g. in nested extraMetadata values)
    fixed = escapeControlCharsInJsonString(fixed);
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
                return decodeBytesToUtf8String(dec);
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

    // Fallback: decode raw bytes as UTF-8 so CJK in metadata is preserved
    let fallbackStr = decodeBytesToUtf8String(rawBytes);

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
            var found = false;
            var pngKeywords = getPngKeywordsFromFormats();
            var collectedByKeyword = {};
            // 1. Collect all tEXt/zTXt/iTXt chunks with relevant keywords
            for (var chunkTypeIdx = 0; chunkTypeIdx < 3; chunkTypeIdx++) {
                var chunkType = ['tEXt', 'zTXt', 'iTXt'][chunkTypeIdx];
                if (!chunks[chunkType] || chunks[chunkType].data_raw.length === 0) continue;
                for (var i = 0; i < chunks[chunkType].data_raw.length; i++) {
                    var raw = chunks[chunkType].data_raw[i];
                    var keyword = '';
                    var text = '';
                    if (chunkType === 'zTXt' && raw instanceof Uint8Array) {
                        var nul = raw.indexOf(0);
                        if (nul <= 0) continue;
                        keyword = decodeBytesToUtf8String(raw.subarray(0, nul)).replace(/\0/g, '');
                        var decompressed = await decompressZtxt(raw);
                        var rawStr = (decompressed && decompressed.text) ? decompressed.text : (decompressed && decompressed.fallback) ? decompressed.fallback : '';
                        if (!rawStr) continue;
                        var sepIdx = rawStr.indexOf('\0');
                        if (sepIdx >= 0) {
                            keyword = rawStr.substring(0, sepIdx);
                            text = rawStr.substring(sepIdx + 1);
                        } else {
                            text = rawStr;
                        }
                    } else {
                        var sepIdx = raw.indexOf('\0');
                        if (sepIdx === -1) continue;
                        keyword = raw.substring(0, sepIdx);
                        text = raw.substring(sepIdx + 1);
                    }
                    if (!keyword) continue;
                    var keyLower = keyword.toLowerCase();
                    if (pngKeywords.indexOf(keyLower) === -1) continue;
                    window.setPromptInfoAvailable(true);
                    var parsed = null;
                    if (keyLower === 'parameters') {
                        // Always treat parameters as plain text (A1111)
                    } else {
                        var textToParse = text;
                        if (text.includes('"sampler"') && text.includes('"signed_hash"')) {
                            var jsonStartIndex = text.indexOf('{');
                            if (jsonStartIndex > -1) textToParse = text.substring(jsonStartIndex);
                        }
                        parsed = safeJsonParse(textToParse);
                        if (keyLower === 'prompt' && (parsed === null || parsed === undefined)) {
                            var startObj = text.indexOf('{');
                            var startArr = text.indexOf('[');
                            var start = (startObj >= 0 && (startArr < 0 || startObj < startArr)) ? startObj : startArr;
                            if (start >= 0) {
                                var fromStart = text.substring(start);
                                var retry = safeJsonParse(fromStart);
                                if (retry !== null && typeof retry === 'object') parsed = retry;
                            }
                        }
                    }
                    if (!collectedByKeyword[keyLower]) collectedByKeyword[keyLower] = [];
                    collectedByKeyword[keyLower].push({ keyword: keyword, text: text, parsed: parsed });
                }
            }
            // 2a. InvokeAI: if invokeai_metadata and/or invokeai_graph chunks exist, merge and distribute once (before ComfyUI so it takes precedence)
            var metaEntries = null;
            var graphEntries = null;
            for (var kw in collectedByKeyword) {
                var norm = kw.toLowerCase().replace(/-/g, '_').trim();
                if (norm === 'invokeai_metadata') metaEntries = collectedByKeyword[kw];
                if (norm === 'invokeai_graph') graphEntries = collectedByKeyword[kw];
            }
            if ((metaEntries && metaEntries.length > 0) || (graphEntries && graphEntries.length > 0)) {
                var invokeMerged = {};
                if (metaEntries && metaEntries.length > 0) {
                    var metaEntry = metaEntries[0];
                    invokeMerged.invokeai_metadata = (metaEntry.parsed !== undefined && metaEntry.parsed !== null && typeof metaEntry.parsed === 'object') ? metaEntry.parsed : metaEntry.text;
                }
                if (graphEntries && graphEntries.length > 0) {
                    var graphEntry = graphEntries[0];
                    invokeMerged.invokeai_graph = (graphEntry.parsed !== undefined && graphEntry.parsed !== null && typeof graphEntry.parsed === 'object') ? graphEntry.parsed : graphEntry.text;
                }
                var firstEntry = (metaEntries && metaEntries[0]) || graphEntries[0];
                distributePromptData(invokeMerged, firstEntry.text, firstEntry.keyword);
                found = true;
            }
            // 2a.5 NovelAI: if any chunk has Software "NovelAI" or signed_hash+sampler, use it and add Title/Source/Generation time to Image Info
            if (!found) {
                var novelAIEntry = null;
                for (var nKw in collectedByKeyword) {
                    var entries = collectedByKeyword[nKw];
                    for (var ne = 0; ne < entries.length; ne++) {
                        if (isNovelAI(entries[ne].parsed)) {
                            novelAIEntry = entries[ne];
                            break;
                        }
                    }
                    if (novelAIEntry) break;
                }
                if (novelAIEntry) {
                    distributePromptData(novelAIEntry.parsed, novelAIEntry.text, novelAIEntry.keyword);
                    found = true;
                    if (collectedByKeyword['title'] && collectedByKeyword['title'].length > 0) {
                        addMetadataItem('Title', collectedByKeyword['title'][0].text, metadataList);
                    }
                    if (collectedByKeyword['source'] && collectedByKeyword['source'].length > 0) {
                        addMetadataItem('Source', collectedByKeyword['source'][0].text, metadataList);
                    }
                    if (collectedByKeyword['generation_time'] && collectedByKeyword['generation_time'].length > 0) {
                        addMetadataItem('Generation Time', collectedByKeyword['generation_time'][0].text, metadataList);
                    }
                }
            }
            // 2b. Midjourney: "Description" chunk with plain text only (NovelAI uses Description/Comment as JSON or Software key)
            if (!found && collectedByKeyword['description'] && collectedByKeyword['description'].length > 0) {
                var descEntry = collectedByKeyword['description'][0];
                if (!isNovelAI(descEntry.parsed)) {
                    distributePromptData(descEntry.parsed, descEntry.text, descEntry.keyword);
                    found = true;
                    // Add Creation Time and Author to Image Info when present
                    if (collectedByKeyword['creation time'] && collectedByKeyword['creation time'].length > 0) {
                        addMetadataItem('Creation Time', collectedByKeyword['creation time'][0].text, metadataList);
                    }
                    if (collectedByKeyword['author'] && collectedByKeyword['author'].length > 0) {
                        addMetadataItem('Author', collectedByKeyword['author'][0].text, metadataList);
                    }
                }
            }
            // 2c. PNG "parameters" = always plain text → parse as A1111. Optionally add workflow block.
            if (!found && collectedByKeyword['parameters'] && collectedByKeyword['parameters'].length > 0) {
                var paramsEntry = collectedByKeyword['parameters'][0];
                var paramsText = typeof paramsEntry.text === 'string' ? stripSurroundingQuotes(paramsEntry.text.trim()) : '';
                if (paramsText) {
                    parseAndDisplayUserComment(paramsText);
                    setGenerationMetadataType('A1111');
                    var workflowEntries = collectedByKeyword['workflow'];
                    if (workflowEntries && workflowEntries.length > 0 && workflowEntries[0].parsed != null && typeof workflowEntries[0].parsed === 'object') {
                        addMetadataAsJsonBlock({ workflow: workflowEntries[0].parsed }, promptInfoList, 'ComfyUI', 'workflow');
                    }
                    found = true;
                }
            }
            // 2c continued. ComfyUI JSON "prompt" chunk + workflow — merge and distribute.
            if (!found && collectedByKeyword['prompt'] && collectedByKeyword['prompt'].length > 0 && collectedByKeyword['workflow'] && collectedByKeyword['workflow'].length > 0) {
                var promptEntry = collectedByKeyword['prompt'][0];
                var workflowEntry = collectedByKeyword['workflow'][0];
                var promptObj = promptEntry.parsed;
                var workflowObj = workflowEntry.parsed;
                if (promptObj && typeof promptObj === 'object' && workflowObj != null && typeof workflowObj === 'object') {
                    distributePromptData({ prompt: promptObj, workflow: workflowObj }, promptEntry.text, promptEntry.keyword);
                    found = true;
                }
            }
            if (!found) {
                for (var kw in collectedByKeyword) {
                    var normKw = kw.toLowerCase().replace(/-/g, '_').trim();
                    if (normKw === 'invokeai_metadata' || normKw === 'invokeai_graph') continue;
                    var entries = collectedByKeyword[kw];
                    for (var e = 0; e < entries.length; e++) {
                        distributePromptData(entries[e].parsed, entries[e].text, entries[e].keyword);
                        found = true;
                    }
                }
            }
            if (found && (typeof window.showExpandedInfo === 'function' || typeof setExpanded === 'function')) {
                if (typeof window.showExpandedInfo === 'function') window.showExpandedInfo();
                else if (typeof setExpanded === 'function') setExpanded(true);
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

// --- Helper: Collect "resources" (modelVersionId + strength) from any "extraMetadata" in a nested structure ---
function collectExtraMetadataResources(obj, resultArr) {
    if (typeof obj !== 'object' || obj === null) return;
    if (Array.isArray(obj)) {
        obj.forEach(item => collectExtraMetadataResources(item, resultArr));
        return;
    }
    for (const key in obj) {
        if (!obj.hasOwnProperty(key)) continue;
        if (key === 'extraMetadata') {
            var em = obj[key];
            var parsed = null;
            if (typeof em === 'string') {
                try {
                    var sanitized = escapeControlCharsInJsonString(em);
                    parsed = JSON.parse(sanitized);
                } catch (e) { /* ignore */ }
            } else if (typeof em === 'object' && em !== null) {
                parsed = em;
            }
            if (parsed && Array.isArray(parsed.resources)) {
                parsed.resources.forEach(function (r) {
                    if (r && (r.modelVersionId != null || r.id != null)) {
                        resultArr.push({
                            modelVersionId: r.modelVersionId != null ? r.modelVersionId : r.id,
                            strength: r.strength != null ? r.strength : r.weight
                        });
                    }
                });
            }
        } else if (typeof obj[key] === 'object') {
            collectExtraMetadataResources(obj[key], resultArr);
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
                    // Sanitize: escape control chars inside string literals so JSON.parse succeeds
                    const sanitized = escapeControlCharsInJsonString(obj[key]);
                    const extraMetaObj = JSON.parse(sanitized);
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

function addCollapsibleCodeBlock(label, value, listElement) {
    if (!listElement) return;
    var template = document.getElementById('metadata-code-block-template');
    if (!template || !template.content) {
        return;
    }
    var jsonStr = safeStringifyForDisplay(value);
    var li = template.content.cloneNode(true);
    var labelTextEl = li.querySelector('.metadata-code-block-label-text');
    var toggle = li.querySelector('.metadata-code-block-toggle');
    var preEl = li.querySelector('.metadata-code-block-content pre');
    if (labelTextEl) labelTextEl.textContent = label;
    if (preEl) {
        preEl.setAttribute('style', preBlockStyle);
        preEl.textContent = jsonStr;
    }
    toggle.addEventListener('click', function (e) {
        var row = e.currentTarget;
        var contentBlock = row.nextElementSibling;
        var chevronEl = row.querySelector('.metadata-code-block-label .chevron');
        if (contentBlock) contentBlock.classList.toggle('collapsed');
        var isNowCollapsed = contentBlock && contentBlock.classList.contains('collapsed');
        if (chevronEl) chevronEl.classList.toggle('rotate', !isNowCollapsed);
        row.setAttribute('aria-expanded', !isNowCollapsed ? 'true' : 'false');
    });
    toggle.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            toggle.click();
            e.preventDefault();
        }
    });
    listElement.appendChild(li);
}

function addJsonBlockWithLabel(label, value, listElement) {
    addCollapsibleCodeBlock(label, value, listElement);
}
// --- Helper: Get object property by key (case-insensitive) ---
function getValueIgnoreCase(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    var k = (key || '').toString().toLowerCase();
    for (var name in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, name) && name.toLowerCase() === k) return obj[name];
    }
    return undefined;
}

// --- Additional Info: one code block per format field present ---
function addMetadataAsJsonBlock(parsed, listElement, formatName, sourceLabel) {
    if (!listElement || !parsed) return;
    var fieldNames = formatName ? getFormatFieldNames(formatName) : [];
    var added = 0;
    if (fieldNames.length > 0 && typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
        for (var i = 0; i < fieldNames.length; i++) {
            var val = getValueIgnoreCase(parsed, fieldNames[i]);
            if (val !== undefined && val !== null) {
                if (typeof val === 'string' && (fieldNames[i] === 'prompt' || fieldNames[i] === 'parameters')) {
                    val = stripSurroundingQuotes(val.trim());
                }
                addJsonBlockWithLabel(formatFieldDisplayLabel(fieldNames[i]), val, listElement);
                added++;
            }
        }
    }
    if (added === 0) {
        addCollapsibleCodeBlock(sourceLabel || 'Metadata', parsed, listElement);
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
 * Strip leading/trailing double quotes (ASCII or Unicode), single quotes, and unescape \" inside.
 * Strips even if only one end has a quote.
 * Handles multiple consecutive quotes at start/end.
 */
function stripSurroundingQuotes(str) {
    if (typeof str !== 'string' || str.length === 0) return str;
    var isQuote = function (c) {
        return c === '"' || c === "'" || c === '\u201C' || c === '\u201D' || c === '\u201E' || c === '\u2018' || c === '\u2019';
    };
    while (str.length > 0 && isQuote(str.charAt(0))) str = str.slice(1);
    while (str.length > 0 && isQuote(str.charAt(str.length - 1))) str = str.slice(0, -1);
    str = str.replace(/\\"/g, '"');
    return str;
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
    comment = comment.trim();
    comment = stripSurroundingQuotes(comment);
    comment = unescapePromptString(comment);
    if (comment.startsWith('UNICODE')) {
        comment = comment.substring('UNICODE'.length).trim();
    }
    // Find "Negative prompt:" and "Steps:" (case-insensitive, allow optional spaces)
    const negPromptIdx = comment.search(/\bnegative\s+prompt\s*:/i);
    const stepsIdx = comment.search(/\bsteps\s*:/i);
    let positive = '', negative = '', additional = '';
    if (negPromptIdx !== -1) {
        positive = comment.substring(0, negPromptIdx).trim();
        var negColonIdx = comment.indexOf(':', negPromptIdx);
        var negEnd = (stepsIdx !== -1 && stepsIdx > negPromptIdx) ? stepsIdx : comment.length;
        negative = negColonIdx !== -1 ? comment.substring(negColonIdx + 1, negEnd).trim() : '';
        if (stepsIdx !== -1 && stepsIdx > negPromptIdx) additional = comment.substring(stepsIdx).trim();
    } else {
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

// Split additional prompt info into items, respecting commas inside parentheses/brackets/braces and double-quoted strings.
function splitPromptInfo(str) {
    const result = [];
    let current = '';
    let parenDepth = 0, bracketDepth = 0, braceDepth = 0;
    let inDoubleQuote = false;
    for (let i = 0; i < str.length; ++i) {
        const c = str[i];
        if (c === '"') {
            inDoubleQuote = !inDoubleQuote;
            current += c;
            continue;
        }
        if (c === '(' && !inDoubleQuote) parenDepth++;
        if (c === ')' && !inDoubleQuote) parenDepth--;
        if (c === '[' && !inDoubleQuote) bracketDepth++;
        if (c === ']' && !inDoubleQuote) bracketDepth--;
        if (c === '{' && !inDoubleQuote) braceDepth++;
        if (c === '}' && !inDoubleQuote) braceDepth--;
        if (c === ',' && !inDoubleQuote && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
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

// --- Civitai: resolve hash or modelVersionId to model page URL ---
var CIVITAI_API_BASE = 'https://civitai.com/api/v1';
function fetchCivitaiModelByVersionId(modelVersionId, callback) {
    var id = modelVersionId != null ? Number(modelVersionId) : NaN;
    if (id <= 0 || !isFinite(id)) {
        callback(new Error('Invalid modelVersionId'));
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', CIVITAI_API_BASE + '/model-versions/' + id, true);
    xhr.onload = function () {
        if (xhr.status !== 200) {
            callback(new Error('Civitai API returned ' + xhr.status));
            return;
        }
        try {
            var data = JSON.parse(xhr.responseText);
            var modelId = data.modelId || (data.model && data.model.id);
            var versionId = data.id;
            var modelName = (data.model && data.model.name) ? data.model.name : '';
            var versionName = data.name || '';
            var displayName = modelName || versionName || ('v' + versionId);
            if (modelId != null && versionId != null) {
                callback(null, { modelId: modelId, modelVersionId: versionId, modelName: modelName, versionName: versionName, displayName: displayName });
            } else {
                callback(new Error('Missing modelId or version id'));
            }
        } catch (e) {
            callback(e);
        }
    };
    xhr.onerror = function () { callback(new Error('Network error')); };
    xhr.send();
}
function fetchCivitaiModelByHash(hash, callback) {
    if (!hash || typeof hash !== 'string') {
        callback(new Error('Invalid hash'));
        return;
    }
    hash = hash.trim();
    if (!hash) {
        callback(new Error('Empty hash'));
        return;
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', CIVITAI_API_BASE + '/model-versions/by-hash/' + encodeURIComponent(hash), true);
    xhr.onload = function () {
        if (xhr.status !== 200) {
            callback(new Error('Civitai API returned ' + xhr.status));
            return;
        }
        try {
            var data = JSON.parse(xhr.responseText);
            var modelId = data.modelId || (data.model && data.model.id);
            var modelVersionId = data.id;
            if (modelId != null && modelVersionId != null) {
                callback(null, { modelId: modelId, modelVersionId: modelVersionId });
            } else {
                callback(new Error('Missing modelId or version id'));
            }
        } catch (e) {
            callback(e);
        }
    };
    xhr.onerror = function () { callback(new Error('Network error')); };
    xhr.send();
}

function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

/** Strip surrounding double quotes and trim. */
function stripQuotes(s) {
    if (s == null) return '';
    s = String(s).trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
        s = s.slice(1, -1).trim();
    }
    return s;
}

/** Parse "Model hash" / "Lora hashes" value into list of { name, hash } for linkification. */
function parseHashesForCivitai(label, value) {
    var out = [];
    if (value == null) return out;
    var str = typeof value === 'string' ? value.trim() : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    str = stripQuotes(str);
    if (!str) return out;
    // JSON object like {"lora1":"hash1","lora2":"hash2"}
    if (str.startsWith('{')) {
        try {
            var obj = JSON.parse(str);
            for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { out.push({ name: stripQuotes(k), hash: stripQuotes(String(obj[k])) }); } }
            return out;
        } catch (e) { /* fall through */ }
    }
    // "name: hash" or "name1: hash1, name2: hash2"
    var parts = str.split(',').map(function (p) { return p.trim(); });
    parts.forEach(function (part) {
        part = stripQuotes(part);
        var colon = part.indexOf(':');
        if (colon !== -1) {
            var name = stripQuotes(part.slice(0, colon).trim());
            var hash = stripQuotes(part.slice(colon + 1).trim());
            if (hash) out.push({ name: name, hash: hash });
        } else if (/^[a-zA-Z0-9]{6,64}$/i.test(part)) {
            out.push({ name: '', hash: part });
        }
    });
    // Single hash only (e.g. Model hash)
    if (out.length === 0 && /^[a-zA-Z0-9]{6,64}$/i.test(str)) {
        out.push({ name: '', hash: str });
    }
    return out;
}

// Parse value for Civitai URNs (e.g. urn:air:sdxl:checkpoint:civitai:1689192@1911770)
// Model version ID is the number after @. Returns [{ versionId, strength }]
function parseCivitaiUrnsInValue(value) {
    var out = [];
    if (value == null) return out;
    var str = typeof value === 'string' ? value.trim() : String(value);
    if (!str) return out;
    var re = /civitai:(\d+)(?:@(\d+))?/g;
    var m;
    while ((m = re.exec(str)) !== null) {
        var versionId = m[2] != null ? parseInt(m[2], 10) : parseInt(m[1], 10);
        if (!isNaN(versionId)) out.push({ versionId: versionId, strength: null });
    }
    return out;
}

// Normalize model-related keys to consistent display labels for the Models section
function normalizeModelLabel(key) {
    if (!key || typeof key !== 'string') return key;
    var k = key.trim().toLowerCase().replace(/\s+/g, ' ');
    if (/^ckpt_name$|^checkpoint$|^model$|^ckpt$|^modelname$|^model_name$/.test(k)) return 'Model';
    if (/^base_ckpt_name$|^base model$/.test(k)) return 'Base model';
    if (/^model_hash$|^ckpt_hash$|^hash$/.test(k)) return 'Model hash';
    if (k === 'lora' || k === 'lora_name') return 'Lora';
    if (/^lora hashes$|^lorahashes$/.test(k.replace(/\s/g, ''))) return 'Lora hashes';
    if (/^lora[_\-]?\d*$/.test(k)) {
        var num = k.replace(/^lora[_\-]?/, '');
        return num ? 'Lora ' + num : 'Lora';
    }
    return key.replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
}

// Add a model info row with normalized label to model-info-list.
function addModelInfoItem(key, value) {
    if (!modelInfoList) return;
    var label = normalizeModelLabel(key);
    if (civitaiCheckingEnabled && (label === 'Model hash' || label === 'Lora hashes')) {
        var entries = parseHashesForCivitai(label, value);
        if (entries.length === 0) {
            addMetadataItem(label, value, modelInfoList);
            return;
        }
        var li = document.createElement('li');
        li.innerHTML = '<strong class="unselectable-label">' + escapeHtml(label) + ':</strong> ';
        var valueContainer = document.createElement('span');
        valueContainer.className = 'civitai-hash-links';
        if (entries.length === 1) {
            var span = document.createElement('span');
            span.textContent = entries[0].name ? entries[0].name + ': ' + entries[0].hash : entries[0].hash;
            span.setAttribute('data-hash', entries[0].hash);
            valueContainer.appendChild(span);
            resolveCivitaiHashSpan(span, entries[0].hash, entries[0].name);
        } else {
            var ul = document.createElement('ul');
            ul.style.cssText = 'margin:0 0 0 1em;padding:0;list-style:none;';
            entries.forEach(function (entry) {
                var itemLi = document.createElement('li');
                var span = document.createElement('span');
                span.textContent = entry.name ? entry.name + ': ' + entry.hash : entry.hash;
                span.setAttribute('data-hash', entry.hash);
                itemLi.appendChild(span);
                ul.appendChild(itemLi);
                resolveCivitaiHashSpan(span, entry.hash, entry.name);
            });
            valueContainer.appendChild(ul);
        }
        li.appendChild(valueContainer);
        modelInfoList.appendChild(li);
        return;
    }
    if (civitaiCheckingEnabled) {
        var civitaiEntries = parseCivitaiUrnsInValue(value);
        if (civitaiEntries.length > 0) {
            var li = document.createElement('li');
            li.innerHTML = '<strong class="unselectable-label">' + escapeHtml(label) + ':</strong> ';
            var valueContainer = document.createElement('span');
            valueContainer.className = 'civitai-hash-links';
            civitaiEntries.forEach(function (entry, idx) {
                if (idx > 0) valueContainer.appendChild(document.createTextNode(', '));
                var span = document.createElement('span');
                span.setAttribute('data-version-id', String(entry.versionId));
                valueContainer.appendChild(span);
                resolveCivitaiVersionSpan(span, entry.versionId, entry.strength);
            });
            li.appendChild(valueContainer);
            modelInfoList.appendChild(li);
            return;
        }
    }
    addMetadataItem(label, value, modelInfoList);
}

function resolveCivitaiHashSpan(span, hash, name) {
    fetchCivitaiModelByHash(hash, function (err, result) {
        if (err || !result) {
            return;
        }
        var url = 'https://civitai.com/models/' + result.modelId + '?modelVersionId=' + result.modelVersionId;
        var display = name ? name + ': ' + hash : hash;
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = display;
        span.textContent = '';
        span.appendChild(a);
    });
}

function resolveCivitaiVersionSpan(span, modelVersionId, strength) {
    span.textContent = '…';
    fetchCivitaiModelByVersionId(modelVersionId, function (err, result) {
        if (err || !result) {
            span.textContent = 'v' + modelVersionId + (strength != null ? ' (' + strength + ')' : '');
            return;
        }
        var url = 'https://civitai.com/models/' + result.modelId + '?modelVersionId=' + result.modelVersionId;
        var display = result.displayName + (strength != null && strength !== '' ? ' (' + strength + ')' : '');
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = display;
        span.textContent = '';
        span.appendChild(a);
    });
}

function addCivitaiResourcesToModelInfo(resources) {
    if (!modelInfoList || !resources || resources.length === 0 || !civitaiCheckingEnabled) return;
    var li = document.createElement('li');
    li.innerHTML = '<strong class="unselectable-label">Civitai resources:</strong> ';
    var ul = document.createElement('ul');
    ul.style.cssText = 'margin:0 0 0 1em;padding:0;list-style:none;';
    resources.forEach(function (r) {
        var strength = r.strength != null ? r.strength : r.weight;
        var vid = r.modelVersionId != null ? r.modelVersionId : r.id;
        if (vid == null) return;
        var itemLi = document.createElement('li');
        var span = document.createElement('span');
        span.className = 'civitai-hash-links';
        span.setAttribute('data-version-id', String(vid));
        itemLi.appendChild(span);
        ul.appendChild(itemLi);
        resolveCivitaiVersionSpan(span, vid, strength);
    });
    li.appendChild(ul);
    modelInfoList.appendChild(li);
}

/**
 * Add a metadata item to a given list element, formatting with <strong> for label.
 * If no list element is provided, defaults to metadataList.
 * When listElement is modelInfoList and label is "Model hash" or "Lora hashes", value is linkified to Civitai.
 */
function addMetadataItem(label, value, listElement) {
    var targetList = listElement || metadataList;
    if (targetList === modelInfoList && civitaiCheckingEnabled && (label === 'Model hash' || label === 'Lora hashes')) {
        var entries = parseHashesForCivitai(label, value);
        if (entries.length > 0) {
            var li = document.createElement('li');
            li.innerHTML = '<strong class="unselectable-label">' + escapeHtml(label) + ':</strong> ';
            var valueContainer = document.createElement('span');
            valueContainer.className = 'civitai-hash-links';
            if (entries.length === 1) {
                var span = document.createElement('span');
                span.textContent = entries[0].name ? entries[0].name + ': ' + entries[0].hash : entries[0].hash;
                span.setAttribute('data-hash', entries[0].hash);
                valueContainer.appendChild(span);
                resolveCivitaiHashSpan(span, entries[0].hash, entries[0].name);
            } else {
                var ul = document.createElement('ul');
                ul.style.cssText = 'margin:0 0 0 1em;padding:0;list-style:none;';
                entries.forEach(function (entry) {
                    var itemLi = document.createElement('li');
                    var span = document.createElement('span');
                    span.textContent = entry.name ? entry.name + ': ' + entry.hash : entry.hash;
                    span.setAttribute('data-hash', entry.hash);
                    itemLi.appendChild(span);
                    ul.appendChild(itemLi);
                    resolveCivitaiHashSpan(span, entry.hash, entry.name);
                });
                valueContainer.appendChild(ul);
            }
            li.appendChild(valueContainer);
            targetList.appendChild(li);
            return;
        }
    }
    if (targetList === modelInfoList && civitaiCheckingEnabled && value != null) {
        var civitaiEntries = parseCivitaiUrnsInValue(value);
        if (civitaiEntries.length > 0) {
            var li = document.createElement('li');
            li.innerHTML = '<strong class="unselectable-label">' + escapeHtml(label) + ':</strong> ';
            var valueContainer = document.createElement('span');
            valueContainer.className = 'civitai-hash-links';
            civitaiEntries.forEach(function (entry, idx) {
                if (idx > 0) valueContainer.appendChild(document.createTextNode(', '));
                var span = document.createElement('span');
                span.setAttribute('data-version-id', String(entry.versionId));
                valueContainer.appendChild(span);
                resolveCivitaiVersionSpan(span, entry.versionId, entry.strength);
            });
            li.appendChild(valueContainer);
            targetList.appendChild(li);
            return;
        }
    }
    var li = document.createElement('li');
    if (label) {
        li.innerHTML = '<strong class="unselectable-label">' + escapeHtml(label) + ':</strong> ' + escapeHtml(value);
    } else {
        li.textContent = value;
    }
    targetList.appendChild(li);
}

// Show the detected generation metadata type in Image Info
function setGenerationMetadataType(type) {
    if (!metadataList || !type) return;
    var children = metadataList.children;
    for (var i = children.length - 1; i >= 0; i--) {
        var li = children[i];
        if (li.querySelector && li.querySelector('strong') && li.querySelector('strong').textContent === 'Metadata type:') {
            metadataList.removeChild(li);
            break;
        }
    }
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