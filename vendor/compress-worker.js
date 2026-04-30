// ChompPDF compress-worker.js
// 把整個壓縮 pipeline 從主執行緒卸載到 Web Worker。
// Phase 1:scaffolding — 載入所有 deps、ping/pong 自我檢查
// Phase 2:接 shrinkAuto / shrinkPreserve 主流程
// Phase 3:升級成 worker pool 並行 image processing
//
// 訊息協議:
//   Main → Worker:{ type: 'ping' } | { type: 'compress', file: ArrayBuffer, options }
//   Worker → Main:{ type: 'ready', deps } | { type: 'progress', pct } |
//                  { type: 'log', msg } | { type: 'done', bytes } | { type: 'error', msg }

'use strict';

// 載 vendor libs(順序:獨立的先載,JsCodecs 最後)
// ?v= 是 cache-busting,主程式啟動 worker 時可傳 version 進來
const V = (() => {
  try {
    const u = new URL(self.location.href);
    return u.searchParams.get('v') || '';
  } catch (_) { return ''; }
})();
const qs = V ? '?v=' + V : '';
try {
  importScripts(
    'pdf-lib.min.js' + qs,           // → self.PDFLib
    'pdf.min.js' + qs,                // → self.pdfjsLib
    'pako.min.js' + qs,               // → self.pako
    'openjpegwasm.js' + qs,           // → self.OpenJPEGWASM
    'jsquash/codecs-bundle.js' + qs   // → self.JsCodecs(lazy init MozJPEG / OxiPNG)
  );
} catch (e) {
  self.postMessage({ type: 'error', stage: 'importScripts', msg: e.message, stack: e.stack });
  throw e;
}

// 自我檢查:每個 dep 是否成功暴露到 self
function depStatus() {
  return {
    PDFLib: typeof self.PDFLib === 'object' && typeof self.PDFLib.PDFDocument === 'function',
    pdfjsLib: typeof self.pdfjsLib === 'object' && typeof self.pdfjsLib.getDocument === 'function',
    pako: typeof self.pako === 'object' && typeof self.pako.deflate === 'function',
    OpenJPEGWASM: typeof self.OpenJPEGWASM === 'function',
    JsCodecs: typeof self.JsCodecs === 'object'
      && typeof self.JsCodecs.encodeMozJpeg === 'function'
      && typeof self.JsCodecs.optimisePng === 'function',
    OffscreenCanvas: typeof self.OffscreenCanvas === 'function',
    createImageBitmap: typeof self.createImageBitmap === 'function',
  };
}


// ============================================================================
// Phase 2.1 — Image processing utilities ported from main thread.
// 完全從 index.html main IIFE 抽出,適配 OffscreenCanvas:
//   document.createElement('canvas') → _newCanvas() (內部 new OffscreenCanvas)
//   canvas.toBlob → canvas.convertToBlob({ type, quality })
//   window.JsCodecs → globalThis.JsCodecs
// 其他 API(getContext('2d'), getImageData, drawImage, createImageBitmap,
// pako, PDFLib, OpenJPEGWASM)在 Worker 全相容,無需改動。
// ============================================================================

function _newCanvas() {
  // 初始 1×1,呼叫端會 set .width / .height(OffscreenCanvas 跟 canvas 行為一致)
  return new OffscreenCanvas(1, 1);
}

// pdf-lib 的 save() 跟 sync ops 在 worker 也是 CPU bound,留 yieldToMain 維持
// 跟主 thread 相同 cancel-safe 介面

  // ===== image utils (index.html line 685-1099) =====
  function canvasToImageData(canvas) {
    const c = canvas.getContext('2d');
    return c.getImageData(0, 0, canvas.width, canvas.height);
  }

  // CRC32(PNG IEEE polynomial)— 編 PNG chunk 用
  let _crcTable = null;
  function crc32(bytes) {
    if (!_crcTable) {
      _crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
        _crcTable[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makePngChunk(type, data) {
    const len = data.length;
    const chunk = new Uint8Array(12 + len);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, len);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    dv.setUint32(8 + len, crc32(chunk.subarray(4, 8 + len)));
    return chunk;
  }

  // 把 ImageData(RGBA)編成 RGB PNG(丟掉 alpha)— 給 OxiPNG 喂食
  // 用 pako level 1 快速,後面 OxiPNG 會重新最佳化
  function encodeRgbPng(imgData) {
    if (typeof pako === 'undefined') return null;
    const { data, width, height } = imgData;
    const rowStride = width * 3 + 1;
    const raw = new Uint8Array(rowStride * height);
    for (let y = 0; y < height; y++) {
      raw[y * rowStride] = 0; // PNG filter type 0 (None)
      const dstRow = y * rowStride + 1;
      const srcRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        raw[dstRow + x * 3]     = data[srcRow + x * 4];
        raw[dstRow + x * 3 + 1] = data[srcRow + x * 4 + 1];
        raw[dstRow + x * 3 + 2] = data[srcRow + x * 4 + 2];
      }
    }
    const idatRaw = pako.deflate(raw, { level: 1 });
    const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = new Uint8Array(13);
    const dv = new DataView(ihdrData.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 2;  // color type RGB
    ihdrData[10] = 0; // compression deflate
    ihdrData[11] = 0; // filter standard
    ihdrData[12] = 0; // no interlace
    const ihdrChunk = makePngChunk('IHDR', ihdrData);
    const idatChunk = makePngChunk('IDAT', idatRaw);
    const iendChunk = makePngChunk('IEND', new Uint8Array(0));
    const total = sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
    const out = new Uint8Array(total);
    let off = 0;
    out.set(sig, off); off += sig.length;
    out.set(ihdrChunk, off); off += ihdrChunk.length;
    out.set(idatChunk, off); off += idatChunk.length;
    out.set(iendChunk, off);
    return out;
  }

  // 解析 PNG 拿 IHDR + 串接所有 IDAT(IDAT 內含 deflate-compressed scanlines + PNG predictor 標頭)
  // 直接餵 PDF FlateDecode + Predictor 15 完美匹配
  function extractPngIDAT(pngBytes) {
    if (!pngBytes || pngBytes.length < 16) return null;
    // PNG signature check
    if (pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50) return null;
    let off = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatChunks = [];
    while (off + 8 <= pngBytes.length) {
      const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + off);
      const len = dv.getUint32(0);
      const type = String.fromCharCode(pngBytes[off+4], pngBytes[off+5], pngBytes[off+6], pngBytes[off+7]);
      const dataOff = off + 8;
      if (dataOff + len > pngBytes.length) break;
      if (type === 'IHDR') {
        const dv2 = new DataView(pngBytes.buffer, pngBytes.byteOffset + dataOff);
        width = dv2.getUint32(0);
        height = dv2.getUint32(4);
        bitDepth = pngBytes[dataOff + 8];
        colorType = pngBytes[dataOff + 9];
      } else if (type === 'IDAT') {
        idatChunks.push(pngBytes.subarray(dataOff, dataOff + len));
      } else if (type === 'IEND') break;
      off = dataOff + len + 4; // +4 CRC
    }
    if (!width || !height || !idatChunks.length) return null;
    let colors, colorspace;
    if (colorType === 2) { colors = 3; colorspace = 'DeviceRGB'; }
    else if (colorType === 0) { colors = 1; colorspace = 'DeviceGray'; }
    else return null; // RGBA / palette / Gray+A 暫不支援
    const total = idatChunks.reduce((a, c) => a + c.length, 0);
    const idat = new Uint8Array(total);
    let p = 0;
    for (const c of idatChunks) { idat.set(c, p); p += c.length; }
    return { idat, width, height, bitDepth, colors, colorspace };
  }

  // 編碼策略:序列跑 JP2 + MozJPEG +(小圖 OxiPNG),取最小
  // JPX root cause 已修(encodeCanvasToJpx 內部 buffer 從 planar 改 interleaved,
  // 對應 chafey/openjpegjs 的 i*compCount+compno 讀法)— 之前色彩塌陷+橫向 3x
  // 重複的破碎結果就是這條漏餵的鍋。修完賽馬重新有 3 個 codec。
  async function encodeCanvas(canvas, quality, codec) {
    const W = canvas.width, H = canvas.height;
    const isSmall = (W * H <= 240 * 240);
    let imgData = null;
    const getImgData = () => imgData || (imgData = canvasToImageData(canvas));
    const results = [];

    // JP2(JPEG 2000)— 大圖才跑,小圖 MozJPEG 通常更小;低品質 JPX 對含 SMask
    // 圖反而容易出問題(quantization 過度),設品質下限 0.55 才開
    if (!isSmall && quality >= 0.55) {
      try {
        const ratio = Math.max(5, Math.min(80, 12 / Math.max(0.1, quality)));
        const bytes = await encodeCanvasToJpx(canvas, ratio);
        // size sanity:JPX 編碼有時崩潰會輸出空 / 過小 codestream
        if (bytes && bytes.length > 200) {
          results.push({ bytes, filter: 'JPXDecode', label: 'jp2' });
        }
      } catch (_) {}
    }

    // MozJPEG(WASM fallback to canvas JPEG)
    if (globalThis.JsCodecs && globalThis.JsCodecs.encodeMozJpeg) {
      try {
        const bytes = await globalThis.JsCodecs.encodeMozJpeg(getImgData(), quality);
        results.push({ bytes, filter: 'DCTDecode', label: 'mozjpeg' });
      } catch (e) { console.warn('MozJPEG fail:', e); }
    } else {
      try {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        results.push({ bytes: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode', label: 'canvas-jpg' });
      } catch (_) {}
    }

    // OxiPNG 小圖賽馬
    if (isSmall && globalThis.JsCodecs && globalThis.JsCodecs.optimisePng) {
      try {
        const pngRaw = encodeRgbPng(getImgData());
        if (pngRaw) {
          // 高 quality 用 level 3(快),低 quality 用 level 6(多省 15-20%,小圖才跑速度可接受)
          const oxiLevel = quality >= 0.8 ? 3 : 6;
          const optimized = await globalThis.JsCodecs.optimisePng(pngRaw, oxiLevel);
          const parsed = extractPngIDAT(optimized);
          if (parsed) results.push({ bytes: parsed.idat, filter: 'FlateDecode-PNG', pngMeta: parsed, label: 'oxipng' });
        }
      } catch (_) {}
    }

    if (results.length === 0) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      return { bytes: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode', label: 'canvas-jpg' };
    }
    results.sort((a, b) => a.bytes.length - b.bytes.length);
    return results[0];
  }

  // FlateDecode 影像解碼:Flate inflate → PNG/TIFF predictor → ImageData
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  function applyPngPredictor(raw, columns, colors, bits) {
    if (bits !== 8) return null;
    const bpp = colors;
    const rowBytes = columns * bpp;
    const rowStride = rowBytes + 1;
    const numRows = Math.floor(raw.length / rowStride);
    const out = new Uint8Array(numRows * rowBytes);
    let prevRow = new Uint8Array(rowBytes);
    for (let y = 0; y < numRows; y++) {
      const ft = raw[y * rowStride];
      const rowOff = y * rowStride + 1;
      const outOff = y * rowBytes;
      for (let x = 0; x < rowBytes; x++) {
        const a = x >= bpp ? out[outOff + x - bpp] : 0;
        const b = prevRow[x];
        const c = x >= bpp ? prevRow[x - bpp] : 0;
        let pred = 0;
        switch (ft) {
          case 0: pred = 0; break;
          case 1: pred = a; break;
          case 2: pred = b; break;
          case 3: pred = (a + b) >> 1; break;
          case 4: pred = paeth(a, b, c); break;
          default: return null;
        }
        out[outOff + x] = (raw[rowOff + x] + pred) & 0xFF;
      }
      prevRow = out.subarray(outOff, outOff + rowBytes);
    }
    return out;
  }

  // TIFF predictor 2:sample-by-sample 差分(同一 row 內)
  function applyTiffPredictor(raw, columns, colors, bits) {
    if (bits !== 8) return null;
    const rowBytes = columns * colors;
    const numRows = Math.floor(raw.length / rowBytes);
    const out = new Uint8Array(numRows * rowBytes);
    for (let y = 0; y < numRows; y++) {
      const off = y * rowBytes;
      for (let x = 0; x < rowBytes; x++) {
        const prev = x >= colors ? out[off + x - colors] : 0;
        out[off + x] = (raw[off + x] + prev) & 0xFF;
      }
    }
    return out;
  }

  // 把「每 pixel bits 位元」的封裝資料拆成「每 sample 1 byte」
  function unpackBits(raw, columns, rows, colors, bits) {
    if (bits === 8) return raw;
    const out = new Uint8Array(columns * rows * colors);
    const maxVal = (1 << bits) - 1;
    const scale = 255 / maxVal;
    let bitPos = 0;
    const rowBitStride = Math.ceil(columns * colors * bits / 8) * 8; // row byte-aligned
    for (let y = 0; y < rows; y++) {
      bitPos = y * rowBitStride;
      for (let x = 0; x < columns * colors; x++) {
        let v = 0;
        for (let b = 0; b < bits; b++) {
          const byte = raw[(bitPos + b) >> 3];
          if (byte === undefined) return null;
          const bit = (byte >> (7 - ((bitPos + b) & 7))) & 1;
          v = (v << 1) | bit;
        }
        out[y * columns * colors + x] = Math.round(v * scale);
        bitPos += bits;
      }
    }
    return out;
  }

  // 取 16-bit(big-endian)降為 8-bit
  function downTo8bit(raw, totalSamples) {
    const out = new Uint8Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      out[i] = raw[i * 2]; // 高 byte 即 8-bit 值
    }
    return out;
  }

  // 取 ColorSpace 資訊:返 {kind, colors, palette?}
  function parseColorSpace(csObj, ctx) {
    if (!csObj) return { kind: 'DeviceRGB', colors: 3 };
    const name = csObj.encodedName;
    if (name === '/DeviceGray' || name === '/G') return { kind: 'DeviceGray', colors: 1 };
    if (name === '/DeviceRGB' || name === '/RGB') return { kind: 'DeviceRGB', colors: 3 };
    if (name === '/DeviceCMYK' || name === '/CMYK') return { kind: 'DeviceCMYK', colors: 4 };
    if (csObj.array) {
      const first = csObj.get(0);
      const firstName = first?.encodedName;
      if (firstName === '/Indexed') {
        // [/Indexed base hival lookup]
        const base = csObj.get(1);
        const hival = csObj.get(2)?.asNumber?.() || 255;
        const lookup = csObj.get(3);
        let paletteBytes = null;
        try {
          if (lookup instanceof PDFLib.PDFRef) {
            const s = ctx.lookup(lookup);
            if (s && s.contents) {
              // stream,可能 Flate 壓縮
              const filter = s.dict?.get?.(PDFLib.PDFName.of('Filter'));
              const fn = filter && (filter.encodedName || filter.toString());
              if (fn === '/FlateDecode' || fn === '/Fl') {
                try { paletteBytes = pako.inflate(s.contents); } catch (e) { paletteBytes = null; }
              } else {
                paletteBytes = s.contents;
              }
            }
          } else if (lookup && lookup.asBytes) {
            paletteBytes = lookup.asBytes();
          } else if (lookup && lookup.value !== undefined) {
            const str = lookup.value;
            paletteBytes = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) paletteBytes[i] = str.charCodeAt(i) & 0xFF;
          }
        } catch (_) { paletteBytes = null; }
        const baseInfo = parseColorSpace(base, ctx);
        return { kind: 'Indexed', colors: 1, base: baseInfo, hival, palette: paletteBytes };
      }
      if (firstName === '/ICCBased') {
        // [/ICCBased stream] — fallback 到 stream dict 裡 /N 欄位 (1/3/4)
        const streamRef = csObj.get(1);
        try {
          const s = ctx.lookup(streamRef);
          const n = s?.dict?.get?.(PDFLib.PDFName.of('N'))?.asNumber?.();
          if (n === 1) return { kind: 'DeviceGray', colors: 1 };
          if (n === 3) return { kind: 'DeviceRGB', colors: 3 };
          if (n === 4) return { kind: 'DeviceCMYK', colors: 4 };
        } catch (_) {}
        return { kind: 'DeviceRGB', colors: 3 };
      }
      if (firstName === '/CalGray') return { kind: 'DeviceGray', colors: 1 };
      if (firstName === '/CalRGB') return { kind: 'DeviceRGB', colors: 3 };
    }
    return null;
  }

  function decodeFlateImage(bytes, dict, ctx) {
    if (typeof pako === 'undefined') return null;
    const N = (n) => PDFLib.PDFName.of(n);
    const width = dict.get(N('Width'))?.asNumber?.() || 0;
    const height = dict.get(N('Height'))?.asNumber?.() || 0;
    const bits = dict.get(N('BitsPerComponent'))?.asNumber?.() || 8;
    if (width === 0 || height === 0) return null;
    if (![1, 2, 4, 8, 16].includes(bits)) return null;

    const cs = parseColorSpace(dict.get(N('ColorSpace')), ctx);
    if (!cs) return null;

    // Flate inflate
    let raw;
    try { raw = pako.inflate(bytes); } catch (e) { return null; }

    // Predictor
    const dp = dict.get(N('DecodeParms'));
    const predictor = dp?.get?.(N('Predictor'))?.asNumber?.() || 1;
    const dpCols = dp?.get?.(N('Columns'))?.asNumber?.() || width;
    const dpColors = dp?.get?.(N('Colors'))?.asNumber?.() || cs.colors;
    const dpBits = dp?.get?.(N('BitsPerComponent'))?.asNumber?.() || bits;

    let unpredicted;
    if (predictor >= 10) {
      // PNG predictor — 先做於 packed bytes(bits/8 對齊),再拆 bit
      if (dpBits === 8) {
        unpredicted = applyPngPredictor(raw, dpCols, dpColors, 8);
        if (!unpredicted) return null;
      } else {
        // non-8bit predictor 複雜,略做簡化:如果 raw 長度剛好 = numRows × (rowBytes+1),跑 PNG predictor after unpack
        // 多數 PDF PNG predictor + non-8bit 實務少見,先 skip
        return null;
      }
    } else if (predictor === 2) {
      unpredicted = applyTiffPredictor(raw, dpCols, dpColors, 8);
      if (!unpredicted) return null;
    } else {
      unpredicted = raw;
    }

    // Bit unpack
    let pixels = unpredicted;
    if (bits !== 8) {
      if (bits === 16) {
        pixels = downTo8bit(unpredicted, width * height * cs.colors);
      } else {
        pixels = unpackBits(unpredicted, width, height, cs.colors, bits);
        if (!pixels) return null;
      }
    }

    const expected = width * height * cs.colors;
    if (pixels.length < expected) return null;

    // 轉 RGBA
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (cs.kind === 'DeviceRGB') {
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        rgba[i*4] = pixels[j]; rgba[i*4+1] = pixels[j+1]; rgba[i*4+2] = pixels[j+2]; rgba[i*4+3] = 255;
      }
    } else if (cs.kind === 'DeviceGray') {
      for (let i = 0; i < width * height; i++) {
        const g = pixels[i];
        rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g; rgba[i*4+3] = 255;
      }
    } else if (cs.kind === 'DeviceCMYK') {
      for (let i = 0, j = 0; i < width * height; i++, j += 4) {
        const c = pixels[j], m = pixels[j+1], y = pixels[j+2], k = pixels[j+3];
        rgba[i*4]   = 255 - Math.min(255, c + k);
        rgba[i*4+1] = 255 - Math.min(255, m + k);
        rgba[i*4+2] = 255 - Math.min(255, y + k);
        rgba[i*4+3] = 255;
      }
    } else if (cs.kind === 'Indexed') {
      if (!cs.palette || !cs.base) return null;
      const baseColors = cs.base.colors;
      for (let i = 0; i < width * height; i++) {
        const idx = pixels[i] * baseColors;
        if (idx + baseColors - 1 >= cs.palette.length) { rgba[i*4+3] = 255; continue; }
        if (cs.base.kind === 'DeviceRGB') {
          rgba[i*4]   = cs.palette[idx];
          rgba[i*4+1] = cs.palette[idx+1];
          rgba[i*4+2] = cs.palette[idx+2];
        } else if (cs.base.kind === 'DeviceGray') {
          const g = cs.palette[idx];
          rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g;
        } else if (cs.base.kind === 'DeviceCMYK') {
          const c = cs.palette[idx], m = cs.palette[idx+1], y = cs.palette[idx+2], k = cs.palette[idx+3];
          rgba[i*4]   = 255 - Math.min(255, c + k);
          rgba[i*4+1] = 255 - Math.min(255, m + k);
          rgba[i*4+2] = 255 - Math.min(255, y + k);
        }
        rgba[i*4+3] = 255;
      }
    } else return null;


  // ===== yieldToMain (index.html line 2014-2018) =====
  // pdf-lib 的 save() 是 CPU-bound,中間沒辦法 yield;但 save() 前後 yield 能讓
  // 事件迴圈處理使用者輸入、避免瀏覽器把整個 tab 標記為 hung
  function yieldToMain(ms = 60) {
    return new Promise(r => setTimeout(r, ms));
  }


  // ===== fmtMB (index.html line 2042-2043) =====
  }
  const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';


  // ===== image proc + filter helpers (index.html line 2368-2571) =====
  const MAX_CANVAS_DIM = 8192; // 保守 cap,避免瀏覽器 OOM

  // 把原始 bytes + dict 解出 canvas(支援 JPEG / Flate / 降級)
  async function imageToCanvas(origBytes, dict, filterType, targetScale, pdfCtx) {
    let width = 0, height = 0, srcCanvas = null;

    if (filterType === 'DCTDecode') {
      const blob = new Blob([origBytes], { type: 'image/jpeg' });
      const img = await createImageBitmap(blob).catch(() => null);
      if (!img) return null;
      width = img.width; height = img.height;
      srcCanvas = img;
    } else if (filterType === 'FlateDecode') {
      const decoded = decodeFlateImage(origBytes, dict, pdfCtx);
      if (!decoded) return null;
      width = decoded.width; height = decoded.height;
      const c = _newCanvas();
      c.width = width; c.height = height;
      c.getContext('2d').putImageData(decoded.imgData, 0, 0);
      srcCanvas = c;
    } else {
      return null;
    }

    // 計算目標尺寸 + Canvas 上限保護
    let newW = Math.max(1, Math.floor(width * targetScale));
    let newH = Math.max(1, Math.floor(height * targetScale));
    if (newW > MAX_CANVAS_DIM || newH > MAX_CANVAS_DIM) {
      const cap = MAX_CANVAS_DIM / Math.max(newW, newH);
      newW = Math.max(1, Math.floor(newW * cap));
      newH = Math.max(1, Math.floor(newH * cap));
    }

    const canvas = _newCanvas();
    canvas.width = newW; canvas.height = newH;
    const canvasCtx = canvas.getContext('2d');
    canvasCtx.fillStyle = 'white';
    canvasCtx.fillRect(0, 0, newW, newH);
    canvasCtx.drawImage(srcCanvas, 0, 0, newW, newH);

    if (srcCanvas.close) srcCanvas.close();
    else if (srcCanvas.width !== undefined) { srcCanvas.width = 0; srcCanvas.height = 0; }

    return canvas;
  }

  // Plate 偵測:抽樣算 RGB variance,低表示「均勻色塊」靠 SMask 切形狀
  function isPlateImage(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w * h === 0) return false;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;
    const step = Math.max(1, Math.floor(w * h / 500));
    let sR=0, sG=0, sB=0, s2R=0, s2G=0, s2B=0, n=0;
    for (let i = 0; i < w*h; i += step) {
      const r=data[i*4], g=data[i*4+1], b=data[i*4+2];
      sR+=r; sG+=g; sB+=b;
      s2R+=r*r; s2G+=g*g; s2B+=b*b;
      n++;
    }
    if (n === 0) return false;
    const vR = s2R/n - (sR/n)**2, vG = s2G/n - (sG/n)**2, vB = s2B/n - (sB/n)**2;
    // 自適應門檻:小圖容忍多一點雜訊(800)、大圖嚴格篩出純色背景(450)
    // 之前一刀切 600 對掃描文件偏寬,紙張紋理 + 微弱雜訊容易誤判 plate → 字邊毛邊
    const sizeFactor = (w * h < 500 * 500) ? 800 : 450;
    return Math.max(vR, vG, vB) < sizeFactor;
  }

  // 文字圖偵測:整頁信息圖 / 表格 / 文字海報這類「主要內容是文字的圖」
  // 演算法:切 16×16 block,計每塊灰階 max-min。
  //   flat block(< 8):大面積純色背景 — text-image 比例高
  //   sharp block(> 200):銳利字邊 / 分隔線 — text-image 比例顯著
  // 門檻 flat ≥ 35% AND sharp ≥ 5% 對 9 張樣本 100% 準確
  // 命中時 recompressImage 強制 scale=1.0 + quality ≥ 0.9 確保文字清楚
  function isTextImage(canvas) {
    const w = canvas.width, h = canvas.height;
    // 用面積 + 短邊判斷,讓寬扁 banner 也能進(例如 1500×150 的標題列)
    if (w * h < 60000) return false;
    if (w < 200 || h < 80) return false;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, w, h).data;
    const BS = 16;
    const blocksX = Math.floor(w / BS);
    const blocksY = Math.floor(h / BS);
    if (blocksX < 8 || blocksY < 4) return false;
    // 大圖抽樣:每 step 個 block 取一次
    const step = Math.max(1, Math.floor(Math.sqrt(blocksX * blocksY / 1500)));
    let flatBlocks = 0, sharpBlocks = 0, total = 0;
    for (let by = 0; by < blocksY; by += step) {
      for (let bx = 0; bx < blocksX; bx += step) {
        let mn = 255, mx = 0;
        for (let dy = 0; dy < BS; dy++) {
          const y = by * BS + dy;
          const rowBase = y * w * 4;
          for (let dx = 0; dx < BS; dx++) {
            const i = rowBase + (bx * BS + dx) * 4;
            // ITU-R BT.601 luminance
            const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) >> 10;
            if (g < mn) mn = g;
            if (g > mx) mx = g;
          }
        }
        const range = mx - mn;
        if (range < 8) flatBlocks++;
        else if (range > 200) sharpBlocks++;
        total++;
      }
    }
    if (total === 0) return false;
    const flatPct = flatBlocks / total;
    const sharpPct = sharpBlocks / total;
    return flatPct >= 0.35 && sharpPct >= 0.05;
  }

  // codec: 'jpeg' | 'jpx' | 'smart'(實際永遠走 encodeCanvas 賽馬)
  // returns { bytes, filter, label, plateScale? } | null
  async function recompressImage(origBytes, scale, quality, codec, filterType = 'DCTDecode', dict = null, pdfCtx = null, hasMask = false) {
    if (hasMask) {
      // 有 SMask/Mask 的主圖:先 decode 全尺寸偵測 plate / text-image
      const fullCanvas = await imageToCanvas(origBytes, dict, filterType, 1.0, pdfCtx);
      if (!fullCanvas) return null;
      const isPlate = isPlateImage(fullCanvas);
      const isText = !isPlate && isTextImage(fullCanvas);
      const w = fullCanvas.width, h = fullCanvas.height;
      // text-image:文字務必清楚 → 不縮 + quality 0.92 floor
      // plate:激進壓 quality * 0.7、scale * 0.6
      // non-plate / non-text:降尺寸 + 高 quality(避免 alpha 邊緣 fringing)
      const pScale = isText ? 1.0
        : isPlate ? Math.max(0.25, scale * 0.6)
        : Math.max(0.5, scale);
      const pQuality = isText ? Math.max(0.92, quality)
        : isPlate ? Math.max(0.3, quality * 0.7)
        : Math.max(0.85, quality * 1.3);
      const newW = Math.max(1, Math.floor(w * pScale));
      const newH = Math.max(1, Math.floor(h * pScale));
      const sc = _newCanvas();
      sc.width = newW; sc.height = newH;
      sc.getContext('2d').drawImage(fullCanvas, 0, 0, newW, newH);
      const encResult = await encodeCanvas(sc, pQuality, codec);
      fullCanvas.width = fullCanvas.height = 0;
      sc.width = sc.height = 0;
      if (!encResult || !encResult.bytes) return null;
      const out = { ...encResult, plateScale: pScale };
      if (isText) out.textImage = true;
      else if (isPlate) out.plateLike = true;
      return out;
    }

    let canvas = await imageToCanvas(origBytes, dict, filterType, scale, pdfCtx);
    if (!canvas) return null;
    let finalScale = scale;
    let finalQuality = quality;
    let plateDetected = false;
    let textDetected = false;
    // Fovea #2:plate-like 偵測(均勻色塊 = 背景/裝飾,可激進壓)— 中大圖才跑
    if (canvas.width >= 300 && canvas.height >= 300 && isPlateImage(canvas)) {
      finalQuality = Math.max(0.3, quality * 0.7);
      plateDetected = true;
    }
    // 文字圖偵測(整頁信息圖、表格、文字海報、寬扁標題 banner):
    // scale 拉回 1.0、quality 拉到 0.92 floor。size guard 放寬到面積 60K 像素 +
    // 短邊 ≥ 80,讓標題 banner 這類寬扁圖也能進
    else if (canvas.width * canvas.height >= 60000 && isTextImage(canvas)) {
      textDetected = true;
      finalQuality = Math.max(0.92, quality);
      // 如果 caller 給的 scale < 1.0 就重 decode 全尺寸,不然字會糊
      if (scale < 0.98) {
        const fullCanvas = await imageToCanvas(origBytes, dict, filterType, 1.0, pdfCtx);
        if (fullCanvas) {
          canvas.width = canvas.height = 0;
          canvas = fullCanvas;
          finalScale = 1.0;
        }
      }
    }
    const result = await encodeCanvas(canvas, finalQuality, codec);
    canvas.width = 0; canvas.height = 0;
    if (result) {
      if (plateDetected) result.plateLike = true;
      if (textDetected) {
        result.textImage = true;
        if (finalScale !== scale) result.plateScale = finalScale; // 重用 plateScale field 表示「實際用的 scale」
      }
    }
    return result;
  }

  function getFilterNames(filter) {
    if (!filter) return [];
    const names = [];
    if (filter.array) filter.array.forEach(n => names.push(n.encodedName || n.toString()));
    else names.push(filter.encodedName || filter.toString());
    return names.map(n => n && n.replace(/^\//, ''));
  }

  function imageFilterType(filter) {
    const names = getFilterNames(filter);
    if (!names.length) return null;
    const last = names[names.length - 1];
    if (last === 'DCTDecode' || last === 'DCT') return 'DCTDecode';
    if (last === 'FlateDecode' || last === 'Fl') return 'FlateDecode';
    return null;
  }


  // 收訊息
self.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'ping': {
        // ping/pong 自我檢查
        self.postMessage({ type: 'pong', deps: depStatus() });
        break;
      }
      case 'compress': {
        // Phase 2 才實作。現在先回 not-implemented 確認訊息協議能跑
        self.postMessage({ type: 'error', msg: 'compress not yet implemented in worker (Phase 2)' });
        break;
      }
      default:
        self.postMessage({ type: 'error', msg: `unknown message type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message, stack: err.stack });
  }
});

// 啟動完成
self.postMessage({ type: 'ready', deps: depStatus() });
