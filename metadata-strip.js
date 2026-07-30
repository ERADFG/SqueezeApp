/**
 * metadata-strip.js
 *
 * Strips identifying metadata from file types that the existing
 * image/video re-encode pipeline (prepareImageForUpload / prepareVideoForUpload)
 * doesn't already cover: PDFs, Office documents, MP3 audio, and generic files.
 *
 * All of this happens entirely client-side, before the file ever reaches
 * Supabase Storage — nothing is sent anywhere to do the stripping. Every
 * function is best-effort: if a file can't be parsed (corrupt, encrypted,
 * unsupported format) it's returned unchanged rather than blocking the post,
 * matching the "never blocks a post" philosophy used elsewhere in this file.
 *
 * Requires (loaded via CDN in interactink.html):
 *   - https://cdn.jsdelivr.net/npm/pdf-lib
 *   - https://cdn.jsdelivr.net/npm/jszip
 */

/** Generates a short random token for anonymized filenames. */
function randomFileToken(len = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    const bytes = new Uint8Array(len);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
    return out;
}

/**
 * Replaces a filename with a random one, keeping only the extension.
 * Original filenames can themselves carry identifying info (a person's
 * name, a device's auto-generated pattern, a location name, etc.) even
 * once the file's internal metadata is clean.
 */
function anonymizeFileName(originalName) {
    const dot = originalName.lastIndexOf('.');
    const ext = dot !== -1 ? originalName.slice(dot) : '';
    return randomFileToken() + ext;
}

/** Strips document-info metadata (author, producer, creation/mod dates, etc.) from a PDF using pdf-lib. */
async function stripPdfMetadata(file) {
    if (typeof PDFLib === 'undefined') return file; // library failed to load — fail open, don't block the post
    try {
        const bytes = await file.arrayBuffer();
        const pdfDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });

        pdfDoc.setTitle('');
        pdfDoc.setAuthor('');
        pdfDoc.setSubject('');
        pdfDoc.setKeywords([]);
        pdfDoc.setProducer('');
        pdfDoc.setCreator('');
        // Neutral, non-identifying timestamps rather than leaving the originals.
        const epoch = new Date(0);
        pdfDoc.setCreationDate(epoch);
        pdfDoc.setModificationDate(epoch);

        // updateMetadata: false belongs here, not in load() — without it,
        // pdf-lib's save() silently re-stamps Producer/ModDate on its own,
        // undoing the stripping above.
        const cleaned = await pdfDoc.save({ updateMetadata: false });
        return new File([cleaned], anonymizeFileName(file.name), { type: 'application/pdf' });
    } catch (e) {
        return file; // encrypted/malformed PDF — pass through rather than block the post
    }
}

/**
 * Strips author/company/timestamps from Office Open XML documents
 * (.docx, .xlsx, .pptx — all zip containers) by clearing docProps/core.xml
 * and docProps/app.xml, which is where that metadata lives.
 */
async function stripOfficeMetadata(file) {
    if (typeof JSZip === 'undefined') return file;
    const OOXML_MIME_BY_EXT = {
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const extMatch = /\.(docx|xlsx|pptx)$/i.exec(file.name || '');
    const resolvedType = file.type || (extMatch ? OOXML_MIME_BY_EXT[extMatch[1].toLowerCase()] : '') || 'application/octet-stream';
    try {
        const zip = await JSZip.loadAsync(file);
        const blankCore = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"></cp:coreProperties>`;
        const blankApp = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"></Properties>`;
        if (zip.file('docProps/core.xml')) zip.file('docProps/core.xml', blankCore);
        if (zip.file('docProps/app.xml')) zip.file('docProps/app.xml', blankApp);

        const cleaned = await zip.generateAsync({ type: 'blob', mimeType: resolvedType });
        return new File([cleaned], anonymizeFileName(file.name), { type: resolvedType });
    } catch (e) {
        return file; // not a valid OOXML zip — pass through
    }
}

/**
 * Strips ID3v1 (last 128 bytes) and ID3v2 (header at the start) tags from
 * MP3 audio, which is where uploader/device info commonly ends up.
 * Other audio containers (WAV/FLAC/OGG/M4A) carry metadata in different,
 * more involved formats and are currently passed through unchanged —
 * a known gap, flagged rather than silently skipped.
 */
async function stripMp3Metadata(file) {
    try {
        const buf = new Uint8Array(await file.arrayBuffer());
        let start = 0;
        let end = buf.length;

        // ID3v2 header: "ID3" + 2 version bytes + 1 flags byte + 4 synchsafe size bytes
        if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
            const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
            start = 10 + size;
        }
        // ID3v1 tag: last 128 bytes, starts with "TAG"
        if (buf.length > 128 && buf[end - 128] === 0x54 && buf[end - 127] === 0x41 && buf[end - 126] === 0x47) {
            end -= 128;
        }
        if (start === 0 && end === buf.length) return file; // nothing found to strip
        if (start >= end || start > buf.length) return file; // corrupt/implausible tag size — don't risk truncating real audio data

        const cleaned = buf.slice(start, end);
        return new File([cleaned], anonymizeFileName(file.name), { type: file.type || 'audio/mpeg' });
    } catch (e) {
        return file;
    }
}

/**
 * Entry point: routes a non-image/video file through the right stripper
 * based on type, and anonymizes the filename for every type that doesn't
 * already get one from a more specific stripper above.
 */
async function stripFileMetadata(file) {
    const name = (file.name || '').toLowerCase();
    const type = file.type || '';

    if (type === 'application/pdf' || name.endsWith('.pdf')) {
        return stripPdfMetadata(file);
    }
    if (
        type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        /\.(docx|xlsx|pptx)$/.test(name)
    ) {
        return stripOfficeMetadata(file);
    }
    if (type === 'audio/mpeg' || type === 'audio/mp3' || name.endsWith('.mp3')) {
        return stripMp3Metadata(file);
    }

    // Everything else (zip, txt, csv, json, code files, wav/flac/ogg/m4a
    // audio, legacy .doc/.xls, etc.): no reliable in-browser way to strip
    // internal metadata for these formats yet, but the filename itself
    // is still anonymized so it can't leak identifying info on its own.
    return new File([file], anonymizeFileName(file.name), { type: file.type });
}

window.stripFileMetadata = stripFileMetadata;
