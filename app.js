'use strict';
/* CleanMeta – client-side image metadata remover. No network access needed. */

const AI_TERMS = /midjourney|dall[-·\s]?e|stable[\s-]?diffusion|firefly|openai|chatgpt|gemini|imagen|synthid|algorithmicmedia|c2pa|contentcredentials|comfyui|automatic1111|invokeai|novelai|leonardo\.ai|ideogram|sdxl|generative\s?ai|ai[-\s]generated/gi;
const latin1 = new TextDecoder('windows-1252');
const ascii = (u, a, b) => String.fromCharCode(...u.subarray(a, b));

function aiHints(text) {
  const found = new Set();
  for (const m of text.slice(0, 400000).matchAll(AI_TERMS)) found.add(m[0].toLowerCase());
  return [...found];
}

/* ---------- format detection ---------- */
function detect(u) {
  if (u[0] === 0xFF && u[1] === 0xD8) return 'jpeg';
  if (u.length > 8 && ascii(u, 1, 4) === 'PNG') return 'png';
  if (u.length > 12 && ascii(u, 0, 4) === 'RIFF' && ascii(u, 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* ---------- JPEG ---------- */
function exifOrientation(seg) { // seg = APP1 payload starting at "Exif\0\0"
  try {
    const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
    const le = dv.getUint16(6) === 0x4949;
    const ifd = dv.getUint32(10, le) + 6;
    const n = dv.getUint16(ifd, le);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le);
    }
  } catch (_) {}
  return 1;
}

function minimalExif(o) {
  return new Uint8Array([
    0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0,        // APP1 "Exif"
    0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8,                          // TIFF header (big endian)
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, o, 0, 0,  // 1 entry: Orientation
    0, 0, 0, 0                                                   // no next IFD
  ]);
}

function labelApp(m, data) {
  const head = ascii(data, 0, Math.min(40, data.length));
  if (m === 0xFE) return { label: 'JPEG comment' };
  if (m === 0xE1) {
    if (head.startsWith('Exif')) return { label: 'EXIF' };
    if (head.startsWith('http://ns.adobe.com/xap/1.0/')) return { label: 'XMP' };
    if (head.startsWith('http://ns.adobe.com/xmp/extension')) return { label: 'XMP (extended)' };
    return { label: 'APP1 data' };
  }
  if (m === 0xEB) return { label: 'C2PA / Content Credentials', c2pa: true };
  if (m === 0xED) return { label: 'Photoshop / IPTC' };
  if (m === 0xE2) return { label: 'Multi-picture data' };
  return { label: 'APP' + (m - 0xE0) + ' data' };
}

function cleanJpeg(buf, keepOrientation) {
  const u = new Uint8Array(buf);
  const out = [u.subarray(0, 2)];
  const removed = [];
  let orientation = 1, i = 2;

  while (i + 1 < u.length) {
    if (u[i] !== 0xFF) { i++; continue; }
    let m = u[i + 1];
    if (m === 0xFF) { i++; continue; }                          // fill byte
    if (m === 0xD9) { out.push(u.subarray(i, i + 2)); i += 2; break; } // EOI
    if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(u.subarray(i, i + 2)); i += 2; continue; }

    const len = (u[i + 2] << 8) | u[i + 3];
    const end = Math.min(i + 2 + len, u.length);
    const seg = u.subarray(i, end);
    const data = u.subarray(i + 4, end);

    if (m === 0xDA) {                                            // SOS: copy header + entropy data
      let j = end;
      while (j + 1 < u.length && !(u[j] === 0xFF && u[j + 1] !== 0x00 && !(u[j + 1] >= 0xD0 && u[j + 1] <= 0xD7))) j++;
      out.push(u.subarray(i, j));
      i = j;
      continue;
    }

    let drop = false;
    if (m === 0xFE || (m >= 0xE1 && m <= 0xEF)) {
      drop = true;
      if (m === 0xE2 && ascii(data, 0, 11) === 'ICC_PROFILE') drop = false;
      if (m === 0xEE && ascii(data, 0, 5) === 'Adobe') drop = false;
    }
    if (drop) {
      if (m === 0xE1 && ascii(data, 0, 4) === 'Exif') orientation = exifOrientation(data);
      const info = labelApp(m, data);
      const txt = latin1.decode(data);
      if (/c2pa|jumb/i.test(txt.slice(0, 4000))) { info.label = 'C2PA / Content Credentials'; info.c2pa = true; }
      removed.push({ label: info.label, bytes: seg.length, hints: aiHints(txt), c2pa: !!info.c2pa });
    } else out.push(seg);
    i = end;
  }
  if (i < u.length) {
    const rest = u.subarray(i);
    if (rest.length > 16) removed.push({ label: 'Trailing data', bytes: rest.length, hints: aiHints(latin1.decode(rest)) });
  }
  if (keepOrientation && orientation > 1 && orientation <= 8) out.splice(1, 0, minimalExif(orientation));
  return { blob: new Blob(out, { type: 'image/jpeg' }), removed };
}

/* ---------- PNG ---------- */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'acTL', 'fcTL', 'fdAT']);

function cleanPng(buf) {
  const u = new Uint8Array(buf), dv = new DataView(buf);
  const out = [u.subarray(0, 8)], removed = [];
  let i = 8;
  while (i + 12 <= u.length) {
    const len = dv.getUint32(i), type = ascii(u, i + 4, i + 8);
    const end = Math.min(i + 12 + len, u.length);
    const chunk = u.subarray(i, end), data = u.subarray(i + 8, end - 4);
    if (PNG_KEEP.has(type)) out.push(chunk);
    else {
      let label = type + ' chunk', c2pa = false, keyword = '';
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        keyword = latin1.decode(data.subarray(0, Math.max(0, data.indexOf(0))));
        label = 'Text: ' + (keyword || type);
      } else if (type === 'eXIf') label = 'EXIF';
      else if (type === 'caBX') { label = 'C2PA / Content Credentials'; c2pa = true; }
      else if (type === 'tIME') label = 'Modification time';
      const hints = type === 'zTXt' ? [] : aiHints(latin1.decode(data));
      const genParam = /^(parameters|prompt|workflow|invokeai|sd-metadata|dream|comment)$/i.test(keyword);
      if (genParam && !hints.length) hints.push('generation parameters');
      removed.push({ label, bytes: chunk.length, hints, c2pa });
    }
    i = end;
    if (type === 'IEND') break;
  }
  return { blob: new Blob(out, { type: 'image/png' }), removed };
}

/* ---------- WebP ---------- */
function cleanWebp(buf) {
  const u = new Uint8Array(buf), dv = new DataView(buf);
  const parts = [], removed = [];
  let i = 12;
  while (i + 8 <= u.length) {
    const cc = ascii(u, i, i + 4), size = dv.getUint32(i + 4, true);
    const end = Math.min(i + 8 + size + (size & 1), u.length);
    const chunk = u.slice(i, end);
    if (cc === 'EXIF' || cc === 'XMP ' || cc === 'C2PA') {
      const txt = latin1.decode(chunk.subarray(8));
      removed.push({ label: cc === 'EXIF' ? 'EXIF' : cc === 'XMP ' ? 'XMP' : 'C2PA / Content Credentials',
        bytes: chunk.length, hints: aiHints(txt), c2pa: cc === 'C2PA' || /c2pa|jumb/i.test(txt.slice(0, 4000)) });
    } else {
      if (cc === 'VP8X') chunk[8] &= ~(0x08 | 0x04);            // clear EXIF + XMP flags
      parts.push(chunk);
    }
    i = end;
  }
  const total = 4 + parts.reduce((s, p) => s + p.length, 0);
  const head = new Uint8Array(12);
  head.set(u.subarray(0, 4)); head.set(u.subarray(8, 12), 8);
  new DataView(head.buffer).setUint32(4, total, true);
  return { blob: new Blob([head, ...parts], { type: 'image/webp' }), removed };
}

/* ---------- canvas re-encode (any browser-decodable format) ---------- */
async function reencode(file, fmt) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  const type = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'webp' ? 'image/webp' : 'image/png';
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  const blob = await new Promise(r => c.toBlob(r, type, 0.95));
  if (!blob) throw new Error('This browser could not encode the image');
  return { blob, type };
}

/* ---------- pipeline ---------- */
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

async function processFile(file, mode, keepOrient) {
  const buf = await file.arrayBuffer();
  const fmt = detect(new Uint8Array(buf));
  let res, outFmt = fmt;

  if (mode === 'lossless' && fmt) {
    res = fmt === 'jpeg' ? cleanJpeg(buf, keepOrient) : fmt === 'png' ? cleanPng(buf) : cleanWebp(buf);
    res.note = null;
  } else {
    outFmt = fmt || 'png';
    const r = await reencode(file, outFmt);
    res = { blob: r.blob, removed: [{ label: 'All metadata (re-encoded)', bytes: Math.max(0, file.size - r.blob.size), hints: [] }] };
    // still report what the original carried, when we can parse it
    if (fmt) {
      const probe = fmt === 'jpeg' ? cleanJpeg(buf, false) : fmt === 'png' ? cleanPng(buf) : cleanWebp(buf);
      res.removed = probe.removed.length ? probe.removed : res.removed;
    }
    res.note = fmt ? null : 'Format not supported for lossless mode – re-encoded as PNG.';
  }
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return { ...res, name: `${base}-clean.${EXT[outFmt]}`, orig: file.size };
}

/* ---------- ZIP (store only) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = ~0; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };

async function makeZip(files) { // [{name, blob}]
  const enc = new TextEncoder(), chunks = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const f of files) {
    let name = f.name, n = 1;
    while (used.has(name)) name = f.name.replace(/(\.[^.]+)$/, `-${++n}$1`);
    used.add(name);
    const data = new Uint8Array(await f.blob.arrayBuffer()), nm = enc.encode(name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    chunks.push(new Uint8Array(lh.buffer), nm, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* ---------- UI ---------- */
const $ = s => document.querySelector(s);
const drop = $('#drop'), input = $('#file'), list = $('#list'), actions = $('#actions');
const results = []; // {name, blob}

const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function download(blob, name) {
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function addFile(file) {
  const card = el('div', 'card');
  const img = el('img', 'thumb'); img.alt = '';
  const meta = el('div', 'meta');
  meta.append(el('h4', null, file.name), el('div', 'sizes', 'Processing…'));
  card.append(img, meta);
  list.prepend(card);
  const thumbUrl = URL.createObjectURL(file); img.src = thumbUrl; img.onload = () => URL.revokeObjectURL(thumbUrl);

  try {
    const mode = document.querySelector('input[name=mode]:checked').value;
    const r = await processFile(file, mode, $('#keepOrient').checked);
    results.push({ name: r.name, blob: r.blob });

    const saved = r.orig - r.blob.size;
    const sizes = meta.querySelector('.sizes');
    sizes.textContent = `${fmtSize(r.orig)} → ${fmtSize(r.blob.size)} `;
    if (saved > 0) sizes.append(el('span', 'saved', `(−${fmtSize(saved)})`));

    const tags = el('ul', 'tags');
    if (!r.removed.length) tags.append(el('li', 'none', 'No metadata found – file was already clean'));
    const allHints = new Set();
    for (const x of r.removed) {
      const li = el('li', x.c2pa || x.hints.length ? 'ai' : '', `${x.label} · ${fmtSize(x.bytes)}`);
      tags.append(li);
      x.hints.forEach(h => allHints.add(h));
    }
    meta.append(tags);
    if (allHints.size) meta.append(el('div', 'hint', 'AI-related markers found & removed: ' + [...allHints].join(', ')));
    if (r.note) meta.append(el('div', 'hint', r.note));

    const act = el('div', 'cardact');
    const b = el('button', 'btn primary', 'Download'); b.onclick = () => download(r.blob, r.name);
    act.append(b); card.append(act);
    actions.hidden = false;
  } catch (e) {
    meta.querySelector('.sizes').replaceWith(el('div', 'err', 'Failed: ' + e.message));
  }
}

function handle(files) {
  [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name)).forEach(addFile);
}

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => { handle(input.files); input.value = ''; });
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handle(e.dataTransfer.files));
document.addEventListener('paste', e => handle(e.clipboardData.files));

$('#zipBtn').onclick = async () => { if (results.length) download(await makeZip(results), 'cleaned-images.zip'); };
$('#clearBtn').onclick = () => { list.replaceChildren(); results.length = 0; actions.hidden = true; };
