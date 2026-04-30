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
// Phase 3 — image-worker pool(orchestrator 端的 client）
// 把 buildPreservePdfMultiProbe 的 image loop 從序列改並行。
// 每個 image-worker 是輕量 worker(載 codecs 不載 pdf-lib),orchestrator
// 派任務(plain bytes + 預先算好的 scalars)、收 encode 結果。
// ============================================================================
let _imagePool = null;        // [{ worker, busy, ready }, ...]
let _imagePoolPromise = null; // 初始化中的 promise(避免 race)
const POOL_SIZE = (() => {
  try {
    const hc = self.navigator?.hardwareConcurrency || 4;
    // v1.5.3:上限 4 → 8。M5 / M3 Pro / Threadripper 之類有 12+ 核的機器,
    // 4 個 worker 完全沒榨出來。每 worker ~50-100MB heap,8 worker ≈ 600MB,
    // 對 16GB+ 的機器可接受。低階機(2-4 核)還是只給 hc-1,不會炸記憶體
    return Math.max(2, Math.min(8, hc - 1));
  } catch (_) { return 2; }
})();

async function ensureImagePool() {
  if (_imagePool) return _imagePool;
  if (_imagePoolPromise) return _imagePoolPromise;
  _imagePoolPromise = (async () => {
    const workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker('image-worker.js' + qs);
      const ready = new Promise((resolve, reject) => {
        const onReady = (e) => {
          if (e.data?.type === 'ready') {
            w.removeEventListener('message', onReady);
            const allOk = e.data.deps && Object.values(e.data.deps).every(Boolean);
            if (e.data.error || !allOk) reject(new Error(e.data.error || 'image-worker deps incomplete'));
            else resolve();
          }
        };
        w.addEventListener('message', onReady);
        setTimeout(() => reject(new Error('image-worker init timeout')), 10000);
      });
      workers.push({ worker: w, busy: false, ready });
    }
    // 全部 ready 才算初始化完成(任一失敗→reject,fallback inline)
    await Promise.all(workers.map(x => x.ready));

    // v1.5.2 D:JPX 預熱 — 對每個 worker 同步觸發 getJpxModule(WASM 編譯)
    // 不預熱的話,第一輪 N 張圖每個 worker 都會卡 ~500ms WASM compile
    await Promise.all(workers.map(slot => new Promise(resolve => {
      const onMsg = e => {
        if (e.data?.type === 'warmedUp') {
          slot.worker.removeEventListener('message', onMsg);
          resolve();
        }
      };
      slot.worker.addEventListener('message', onMsg);
      slot.worker.postMessage({ type: 'warmup' });
      // warmup 失敗也別卡死池子,5 秒兜底
      setTimeout(resolve, 5000);
    })));

    _imagePool = workers;
    self.__imagePool = workers; // 暴露給 devtools 診斷(切到 worker context 用)
    return workers;
  })();
  return _imagePoolPromise;
}

// 對單一 image-worker 派一個 probe 任務,等回傳
function dispatchProbe(slot, payload) {
  return new Promise((resolve, reject) => {
    const w = slot.worker;
    const onMsg = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'probeDone' && m.result?.idx === payload.idx) {
        w.removeEventListener('message', onMsg);
        resolve(m.result);
      } else if (m.type === 'probeError' && m.idx === payload.idx) {
        w.removeEventListener('message', onMsg);
        reject(new Error(m.msg));
      }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type: 'probe', payload });
  });
}

  // ===== yieldToMain (index.html L2018-2020) =====
  function yieldToMain(ms = 60) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ===== fmtMB (index.html L2045-2045) =====
  const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

  // ===== _newCanvas (worker-only helper:OffscreenCanvas wrapper)
  // 主執行緒原本用 document.createElement('canvas'),inject 時改成 _newCanvas()。
  // OffscreenCanvas 構造要 w/h(隨後 .width/.height 可改),所以給 1x1 placeholder。
  function _newCanvas(w = 1, h = 1) {
    return new OffscreenCanvas(w, h);
  }

  // ===== canvasToImageData (index.html L687-690) =====
  function canvasToImageData(canvas) {
    const c = canvas.getContext('2d');
    return c.getImageData(0, 0, canvas.width, canvas.height);
  }

  // ===== crc32 (index.html L694-706) =====
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

  // ===== makePngChunk (index.html L708-717) =====
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

  // ===== encodeRgbPng (index.html L721-758) =====
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

  // ===== extractPngIDAT (index.html L762-796) =====
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

  // ===== paeth (index.html L858-864) =====
  function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  // ===== applyPngPredictor (index.html L866-896) =====
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

  // ===== applyTiffPredictor (index.html L900-913) =====
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

  // ===== unpackBits (index.html L915-937) =====
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

  // ===== downTo8bit (index.html L940-946) =====
  function downTo8bit(raw, totalSamples) {
    const out = new Uint8Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      out[i] = raw[i * 2]; // 高 byte 即 8-bit 值
    }
    return out;
  }

  // ===== parseColorSpace (index.html L949-1004) =====
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

  // ===== decodeFlateImage (index.html L1006-1104) =====
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

    return { width, height, imgData: new ImageData(rgba, width, height) };
  }

  // ===== getJpxModule (index.html L650-657) =====
  async function getJpxModule() {
    if (_jpxModule) return _jpxModule;
    if (typeof OpenJPEGWASM !== 'function') throw new Error('openjpegwasm.js 未載入');
    _jpxModule = await OpenJPEGWASM({
      locateFile: (f) => f.endsWith('.wasm') ? 'vendor/openjpegwasm.wasm' : f
    });
    return _jpxModule;
  }

  // ===== encodeCanvasToJpx (index.html L659-683) =====
  async function encodeCanvasToJpx(canvas, compressionRatio) {
    const mod = await getJpxModule();
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const encoder = new mod.J2KEncoder();
    const buf = encoder.getDecodedBuffer({ width: w, height: h, bitsPerSample: 8, componentCount: 3, isSigned: false });
    const plane = w * h;
    // Interleaved RGBA → interleaved RGB (chafey/openjpegjs C++ encode() 用
    // decoded_[i * componentCount + compno] 讀,期待 RGB RGB RGB...
    // 之前寫成 planar 是 root cause:R 通道讀的全是 R-plane 相鄰值 → R≈G≈B 變
    // 灰階,跨 plane 邊界 → 橫向 3x 重複 strip)
    for (let i = 0; i < plane; i++) {
      buf[i * 3]     = imgData.data[i * 4];
      buf[i * 3 + 1] = imgData.data[i * 4 + 1];
      buf[i * 3 + 2] = imgData.data[i * 4 + 2];
    }
    encoder.setQuality(false, 1);
    encoder.setCompressionRatio(0, compressionRatio);
    encoder.encode();
    const view = encoder.getEncodedBuffer();
    const out = new Uint8Array(view);
    encoder.delete();
    return out;
  }

  // ===== encodeCanvas (index.html L802-855) =====
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

  // ===== MAX_CANVAS_DIM (index.html L2370-2370) =====
  const MAX_CANVAS_DIM = 8192; // 保守 cap,避免瀏覽器 OOM

  // ===== imageToCanvas (index.html L2373-2414) =====
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

  // ===== isPlateImage (index.html L2417-2436) =====
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

  // ===== isTextImage (index.html L2444-2482) =====
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

  // ===== getFilterNames (index.html L2557-2563) =====
  function getFilterNames(filter) {
    if (!filter) return [];
    const names = [];
    if (filter.array) filter.array.forEach(n => names.push(n.encodedName || n.toString()));
    else names.push(filter.encodedName || filter.toString());
    return names.map(n => n && n.replace(/^\//, ''));
  }

  // ===== imageFilterType (index.html L2565-2572) =====
  function imageFilterType(filter) {
    const names = getFilterNames(filter);
    if (!names.length) return null;
    const last = names[names.length - 1];
    if (last === 'DCTDecode' || last === 'DCT') return 'DCTDecode';
    if (last === 'FlateDecode' || last === 'Fl') return 'FlateDecode';
    return null;
  }

  // ===== recompressImage (index.html L2486-2555) =====
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

  // ===== refKey (index.html L1123-1123) =====
  function refKey(ref) { return `${ref.objectNumber},${ref.generationNumber}`; }

  // ===== sha1Hex (index.html L1126-1132) =====
  async function sha1Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    const arr = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, '0');
    return hex;
  }

  // ===== sha1HexBatch (index.html L1135-1151) =====
  async function sha1HexBatch(items, getBytes, onProgress) {
    const BATCH = 32;
    const results = new Array(items.length);
    for (let i = 0; i < items.length; i += BATCH) {
      checkCancelled();
      if (onProgress) onProgress(i, items.length);
      await new Promise(r => setTimeout(r, 0));
      const slice = items.slice(i, i + BATCH);
      const hashes = await Promise.all(slice.map(async (item, j) => {
        const bytes = getBytes(item);
        if (!bytes || bytes.length < 200) return null;
        return await sha1Hex(bytes);
      }));
      for (let j = 0; j < hashes.length; j++) results[i + j] = hashes[j];
    }
    return results;
  }

  // ===== dedupImages (index.html L1153-1260) =====
  async function dedupImages(pdfDoc, onProgress) {
    const ctx = pdfDoc.context;
    const { PDFName, PDFRawStream } = PDFLib;
    // 收所有 Image XObject
    const items = [];
    ctx.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      const subStr = subtype && (subtype.encodedName || subtype.toString());
      if (subStr !== '/Image') return;
      items.push({ ref, obj });
    });
    if (items.length < 2) return { count: 0, saved: 0 };

    // 蒐集被當 SMask/Mask target 的 ref,同時做成 list 用 batch hash
    const maskRefsToHash = new Set();
    ctx.enumerateIndirectObjects().forEach(([_r, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      for (const k of ['SMask', 'Mask']) {
        const v = obj.dict.get(PDFName.of(k));
        if (v instanceof PDFLib.PDFRef) maskRefsToHash.add(refKey(v));
      }
    });
    const maskTargets = [];
    ctx.enumerateIndirectObjects().forEach(([r, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      if (!maskRefsToHash.has(refKey(r))) return;
      maskTargets.push({ ref: r, obj });
    });

    const totalForProgress = maskTargets.length + items.length;
    // Batch SHA-1 所有 mask target
    const maskContentHash = new Map();
    const maskHashes = await sha1HexBatch(maskTargets, (it) => it.obj.contents,
      (done) => { if (onProgress) onProgress(done, totalForProgress); });
    for (let i = 0; i < maskTargets.length; i++) {
      if (maskHashes[i]) maskContentHash.set(refKey(maskTargets[i].ref), maskHashes[i]);
    }

    // Batch SHA-1 所有 image
    const imageHashes = await sha1HexBatch(items, (it) => it.obj.contents,
      (done) => { if (onProgress) onProgress(maskTargets.length + done, totalForProgress); });

    const byHash = new Map();
    const remap = new Map();
    for (let i = 0; i < items.length; i++) {
      const hex = imageHashes[i];
      if (!hex) continue;
      const { ref, obj } = items[i];
      const sm = obj.dict.get(PDFName.of('SMask'));
      const mk = obj.dict.get(PDFName.of('Mask'));
      const smKey = sm instanceof PDFLib.PDFRef ? (maskContentHash.get(refKey(sm)) || refKey(sm)) : 'none';
      const mkKey = mk instanceof PDFLib.PDFRef ? (maskContentHash.get(refKey(mk)) || refKey(mk)) : 'none';
      const fullKey = `${hex}|${smKey}|${mkKey}`;
      if (byHash.has(fullKey)) remap.set(refKey(ref), byHash.get(fullKey));
      else byHash.set(fullKey, ref);
    }
    if (remap.size === 0) return { count: 0, saved: 0 };

    // 遍歷 context 所有 indirect objects,把任何 XObject dict 的 refs 改向
    // 這涵蓋 Page.Resources.XObject + Form.Resources.XObject + Pattern.Resources.XObject 等所有位置
    const N = (n) => PDFLib.PDFName.of(n);
    const patchXObjDict = (xobj) => {
      if (!xobj || typeof xobj.entries !== 'function') return;
      const entries = Array.from(xobj.entries());
      for (const [name, val] of entries) {
        if (!(val instanceof PDFLib.PDFRef)) continue;
        const k = refKey(val);
        if (remap.has(k)) xobj.set(name, remap.get(k));
      }
    };
    ctx.enumerateIndirectObjects().forEach(([_r, indirectObj]) => {
      let dict = null;
      if (indirectObj instanceof PDFLib.PDFDict) {
        dict = indirectObj;
      } else if (indirectObj && indirectObj.dict && indirectObj.dict instanceof PDFLib.PDFDict) {
        dict = indirectObj.dict;
      }
      if (!dict) return;
      // Resources.XObject
      try {
        const res = dict.get(N('Resources'));
        if (res && typeof res.get === 'function') patchXObjDict(res.get(N('XObject')));
      } catch (_) {}
      // 直接 XObject dict(Resources 本身當 XObject 引用)
      try { patchXObjDict(dict.get(N('XObject'))); } catch (_) {}
      // Image XObject dict 的 /SMask /Mask 引用(重要!如果 SMask 被 dedup,此處沒改會懸空)
      for (const k of ['SMask', 'Mask']) {
        try {
          const v = dict.get(N(k));
          if (v instanceof PDFLib.PDFRef && remap.has(refKey(v))) {
            dict.set(N(k), remap.get(refKey(v)));
          }
        } catch (_) {}
      }
    });

    // 刪重複 indirect objects
    let saved = 0;
    for (const [dupKey] of remap) {
      const [on, gn] = dupKey.split(',').map(Number);
      const dupRef = PDFLib.PDFRef.of(on, gn);
      const dup = ctx.lookup(dupRef);
      if (dup && dup.contents) saved += dup.contents.length;
      try { ctx.delete(dupRef); } catch (_) {}
    }
    return { count: remap.size, saved };
  }

  // ===== downscaleSMasks (index.html L1263-1378) =====
  async function downscaleSMasks(pdfDoc, scaleFactor, onProgress) {
    if (typeof pako === 'undefined') return { count: 0, saved: 0 };
    const ctx = pdfDoc.context;
    const { PDFName, PDFRawStream } = PDFLib;
    const N = (n) => PDFName.of(n);

    // 收所有被當 SMask 的 ref
    const smaskRefs = new Set();
    ctx.enumerateIndirectObjects().forEach(([_r, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const v = obj.dict.get(N('SMask'));
      if (v instanceof PDFLib.PDFRef) smaskRefs.add(refKey(v));
    });

    const targets = [];
    ctx.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      if (!smaskRefs.has(refKey(ref))) return;
      const dict = obj.dict;
      const filter = dict.get(N('Filter'));
      const names = getFilterNames(filter);
      if (names.length !== 1 || (names[0] !== 'FlateDecode' && names[0] !== 'Fl')) return;
      const bpc = dict.get(N('BitsPerComponent'))?.asNumber?.() || 8;
      if (bpc !== 8) return; // 非 8-bit alpha 太特殊,略
      const cs = dict.get(N('ColorSpace'));
      const csName = cs?.encodedName;
      if (csName !== '/DeviceGray' && csName !== '/G') return;
      // skip 帶 /Matte 的(pre-multiplied alpha,降解析度會破色補償)
      if (dict.get(N('Matte'))) return;
      targets.push({ ref, obj, dict });
    });

    let count = 0, saved = 0, textMaskSharpened = 0;
    for (let i = 0; i < targets.length; i++) {
      // v1.5.2:worker 內 yield 從 20 拉回 100(主執行緒已釋放)
      if (i % 100 === 0) {
        checkCancelled();
        if (onProgress) onProgress(i, targets.length);
        await new Promise(r => setTimeout(r, 0));
      }
      const { ref, obj, dict } = targets[i];
      const decoded = decodeFlateImage(obj.contents, dict, ctx);
      if (!decoded) continue;
      const { width, height, imgData } = decoded;

      // 文字 mask 偵測:文字通常是「純黑背景 + 純白字」(或反之),雙峰直方圖 + 高邊緣密度
      // 命中後 → 仍允許 downscale 省檔,但縮完後做二值化(snap 回 0/255),恢復銳利
      // 字邊。binary 資料 deflate 壓縮率特別高,反而比保持原尺寸更省。
      let isTextMask = false;
      if (width >= 200 && height >= 80 && width * height >= 60000) {
        const data = imgData.data;
        const total = width * height;
        let darkCount = 0, lightCount = 0;
        const step = Math.max(1, Math.floor(total / 8000));
        let sampled = 0;
        for (let p = 0; p < total; p += step) {
          const v = data[p * 4];
          if (v < 30) darkCount++;
          else if (v > 225) lightCount++;
          sampled++;
        }
        const darkPct = darkCount / sampled;
        const lightPct = lightCount / sampled;
        // 抽樣密度:從 height/40(41 行)改 height/200(密 5x),
        // 之前太稀標題字密集區會被空白行稀釋導致 edgePct 假性低
        let edges = 0, edgeChecks = 0;
        const rowStep = Math.max(1, Math.floor(height / 200));
        for (let y = 0; y < height; y += rowStep) {
          let prev = data[y * width * 4];
          for (let x = 1; x < width; x++) {
            const v = data[(y * width + x) * 4];
            if (Math.abs(v - prev) > 100) edges++;
            prev = v;
            edgeChecks++;
          }
        }
        const edgePct = edges / Math.max(1, edgeChecks);
        // (雙峰強 OR 邊緣多):雙峰 60% 像素卡兩端是強訊號,edge ≥ 0.01 也單獨命中
        isTextMask = (darkPct >= 0.3 && lightPct >= 0.3) || edgePct >= 0.01;
      }

      // 文字 mask:**完全 skip 不縮**。試過「縮+二值化」小字仍會糊,而 SMask 全部
      // 加總對檔案佔比不到 3%(50 張 ×6KB = 300KB,15MB 檔案的 2%),
      // 不值得為了這 3% 把字壓糊。
      if (isTextMask) {
        textMaskSharpened++; // 變數名沿用,實際是 skip 的計數
        continue;
      }

      const newW = Math.max(1, Math.floor(width * scaleFactor));
      const newH = Math.max(1, Math.floor(height * scaleFactor));
      if (newW >= width || newH >= height) continue;

      const srcC = _newCanvas(); srcC.width = width; srcC.height = height;
      srcC.getContext('2d').putImageData(imgData, 0, 0);
      const dstC = _newCanvas(); dstC.width = newW; dstC.height = newH;
      dstC.getContext('2d').drawImage(srcC, 0, 0, newW, newH);
      const dData = dstC.getContext('2d').getImageData(0, 0, newW, newH).data;
      const gray = new Uint8Array(newW * newH);
      for (let p = 0; p < newW * newH; p++) gray[p] = dData[p * 4];
      srcC.width = srcC.height = 0; dstC.width = dstC.height = 0;

      const compressed = pako.deflate(gray, { level: 9 });
      if (compressed.length < obj.contents.length) {
        const newDict = dict.clone();
        newDict.set(N('Width'), PDFLib.PDFNumber.of(newW));
        newDict.set(N('Height'), PDFLib.PDFNumber.of(newH));
        newDict.set(N('ColorSpace'), N('DeviceGray'));
        newDict.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(8));
        try { newDict.delete(N('DecodeParms')); } catch (_) {}
        ctx.assign(ref, PDFRawStream.of(newDict, compressed));
        saved += obj.contents.length - compressed.length;
        count++;
      }
    }
    return { count, saved, textMaskSharpened };
  }

  // ===== recompressFlateLossless (index.html L1381-1416) =====
  async function recompressFlateLossless(pdfDoc, skipRefs, onProgress) {
    if (typeof pako === 'undefined') return { count: 0, saved: 0 };
    const ctx = pdfDoc.context;
    const { PDFName, PDFRawStream } = PDFLib;
    let count = 0, saved = 0;
    const targets = [];
    ctx.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      if (skipRefs && skipRefs.has(refKey(ref))) return;
      const dict = obj.dict;
      const filter = dict.get(PDFName.of('Filter'));
      const names = getFilterNames(filter);
      if (names.length !== 1 || (names[0] !== 'FlateDecode' && names[0] !== 'Fl')) return;
      targets.push({ ref, obj, dict });
    });
    for (let i = 0; i < targets.length; i++) {
      // v1.5.2:worker 內 yield 從 20 拉回 100(主執行緒已釋放)
      if (i % 100 === 0) {
        checkCancelled();
        if (onProgress) onProgress(i, targets.length);
        await new Promise(r => setTimeout(r, 0));
      }
      const { ref, obj, dict } = targets[i];
      const orig = obj.contents;
      if (orig.length < 200) continue;
      try {
        const raw = pako.inflate(orig);
        const recompressed = pako.deflate(raw, { level: 9 });
        if (recompressed.length < orig.length) {
          ctx.assign(ref, PDFRawStream.of(dict, recompressed));
          saved += orig.length - recompressed.length;
          count++;
        }
      } catch (_) {}
    }
    return { count, saved };
  }

  // ===== dedupFormXObjects (index.html L1419-1507) =====
  async function dedupFormXObjects(pdfDoc) {
    const ctx = pdfDoc.context;
    const { PDFRawStream, PDFName, PDFRef } = PDFLib;
    const items = [];
    ctx.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      const subStr = subtype && (subtype.encodedName || subtype.toString());
      if (subStr !== '/Form') return;
      items.push({ ref, obj });
    });
    if (items.length < 2) return { count: 0, saved: 0 };

    // Batch SHA-1 所有 Form content
    const contentHashes = await sha1HexBatch(items, (it) => it.obj.contents.length >= 100 ? it.obj.contents : null);

    const byKey = new Map();
    const remap = new Map();
    for (let idx = 0; idx < items.length; idx++) {
      const contentHash = contentHashes[idx];
      if (!contentHash) continue;
      const { ref, obj } = items[idx];
      let resSig = '';
      try {
        const res = obj.dict.get(PDFName.of('Resources'));
        if (res && res.entries) {
          const parts = [];
          for (const [name, val] of Array.from(res.entries())) {
            let sub = (name.encodedName || '?') + '=';
            if (val && val.entries) {
              const subEntries = Array.from(val.entries()).map(([k, v]) => {
                const vk = v instanceof PDFLib.PDFRef ? refKey(v) : '?';
                return (k.encodedName || '?') + ':' + vk;
              });
              subEntries.sort();
              sub += subEntries.join(',');
            } else if (val instanceof PDFLib.PDFRef) {
              sub += refKey(val);
            }
            parts.push(sub);
          }
          parts.sort();
          resSig = parts.join('|');
        }
      } catch (_) {}
      let bbox = '';
      try {
        const b_ = obj.dict.get(PDFName.of('BBox'));
        if (b_ && b_.array) {
          bbox = b_.array.map(x => (x && x.value !== undefined) ? x.value : (x && x.asNumber ? x.asNumber() : '?')).join(',');
        }
      } catch (_) {}
      const fullKey = contentHash + '|' + resSig + '|' + bbox;
      if (byKey.has(fullKey)) remap.set(refKey(ref), byKey.get(fullKey));
      else byKey.set(fullKey, ref);
    }
    if (remap.size === 0) return { count: 0, saved: 0 };

    const patchXObj = (xobj) => {
      if (!xobj || typeof xobj.entries !== 'function') return;
      for (const [name, val] of Array.from(xobj.entries())) {
        if (!(val instanceof PDFLib.PDFRef)) continue;
        const k = refKey(val);
        if (remap.has(k)) xobj.set(name, remap.get(k));
      }
    };
    ctx.enumerateIndirectObjects().forEach(([_, obj]) => {
      const d = obj instanceof PDFLib.PDFDict ? obj : (obj && obj.dict);
      if (!d || !d.get) return;
      try {
        const res = d.get(PDFName.of('Resources'));
        if (res && res.get) patchXObj(res.get(PDFName.of('XObject')));
      } catch (_) {}
      try { patchXObj(d.get(PDFName.of('XObject'))); } catch (_) {}
    });

    let count = 0, saved = 0;
    for (const [dupKey] of remap) {
      const [on, gn] = dupKey.split(',').map(Number);
      const dupRef = PDFRef.of(on, gn);
      try {
        const obj = ctx.lookup(dupRef);
        if (obj && obj.contents) saved += obj.contents.length;
        ctx.delete(dupRef);
        count++;
      } catch (_) {}
    }
    return { count, saved };
  }

  // ===== dedupICCProfiles (index.html L1510-1608) =====
  async function dedupICCProfiles(pdfDoc) {
    const ctx = pdfDoc.context;
    const { PDFRawStream, PDFName, PDFRef } = PDFLib;

    const isICCArray = (v) => {
      if (!(v instanceof PDFLib.PDFArray) || v.size() < 2) return null;
      const first = v.get(0);
      const fname = first && first.encodedName;
      if (fname !== '/ICCBased') return null;
      const iccRef = v.get(1);
      if (!(iccRef instanceof PDFLib.PDFRef)) return null;
      return iccRef;
    };

    // 收所有被 /ICCBased 引用的 ref
    const iccRefsToHash = new Set();
    const walkContainer = (container) => {
      if (!container || !container.get) return;
      const scan = (v) => {
        const iccRef = isICCArray(v);
        if (iccRef) iccRefsToHash.add(refKey(iccRef));
      };
      try { scan(container.get(PDFName.of('ColorSpace'))); } catch (_) {}
      try {
        const res = container.get(PDFName.of('Resources'));
        if (res && res.get) {
          const csMap = res.get(PDFName.of('ColorSpace'));
          if (csMap && csMap.entries) {
            for (const [_k, val] of csMap.entries()) scan(val);
          }
        }
      } catch (_) {}
    };
    ctx.enumerateIndirectObjects().forEach(([_, obj]) => {
      const d = obj instanceof PDFLib.PDFDict ? obj : (obj && obj.dict);
      walkContainer(d);
    });

    if (iccRefsToHash.size < 2) return { count: 0, saved: 0 };

    // 收成 list 做 batch hash
    const iccItems = [];
    for (const rk of iccRefsToHash) {
      const [on, gn] = rk.split(',').map(Number);
      const iccRef = PDFRef.of(on, gn);
      let obj;
      try { obj = ctx.lookup(iccRef); } catch (_) { continue; }
      if (!(obj instanceof PDFRawStream)) continue;
      iccItems.push({ rk, iccRef, obj });
    }
    const iccHashes = await sha1HexBatch(iccItems, (it) => it.obj.contents);

    const byHash = new Map();
    const remap = new Map();
    for (let i = 0; i < iccItems.length; i++) {
      const hex = iccHashes[i];
      if (!hex) continue;
      const { rk, iccRef } = iccItems[i];
      if (byHash.has(hex)) remap.set(rk, byHash.get(hex));
      else byHash.set(hex, iccRef);
    }
    if (remap.size === 0) return { count: 0, saved: 0 };

    // patch 所有 ColorSpace Array 的 ICC ref
    const patchArr = (arr) => {
      const iccRef = isICCArray(arr);
      if (!iccRef) return;
      const k = refKey(iccRef);
      if (remap.has(k)) arr.set(1, remap.get(k));
    };
    ctx.enumerateIndirectObjects().forEach(([_, obj]) => {
      const d = obj instanceof PDFLib.PDFDict ? obj : (obj && obj.dict);
      if (!d || !d.get) return;
      try { patchArr(d.get(PDFName.of('ColorSpace'))); } catch (_) {}
      try {
        const res = d.get(PDFName.of('Resources'));
        if (res && res.get) {
          const csMap = res.get(PDFName.of('ColorSpace'));
          if (csMap && csMap.entries) {
            for (const [_k, val] of csMap.entries()) patchArr(val);
          }
        }
      } catch (_) {}
    });

    // 刪 dup ICC streams
    let count = 0, saved = 0;
    for (const [dupKey] of remap) {
      const [on, gn] = dupKey.split(',').map(Number);
      const dupRef = PDFRef.of(on, gn);
      try {
        const obj = ctx.lookup(dupRef);
        if (obj && obj.contents) saved += obj.contents.length;
        ctx.delete(dupRef);
        count++;
      } catch (_) {}
    }
    return { count, saved };
  }

  // ===== validateMaskRefs (index.html L1612-1630) =====
  function validateMaskRefs(pdfDoc) {
    const ctx = pdfDoc.context;
    const { PDFName, PDFRawStream } = PDFLib;
    let problems = 0;
    ctx.enumerateIndirectObjects().forEach(([_, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const d = obj.dict;
      for (const k of ['SMask', 'Mask']) {
        const v = d.get(PDFName.of(k));
        if (v instanceof PDFLib.PDFRef) {
          try {
            const t = ctx.lookup(v);
            if (!t) problems++;
          } catch (_) { problems++; }
        }
      }
    });
    return problems;
  }

  // ===== garbageCollect (index.html L1632-1698) =====
  async function garbageCollect(pdfDoc, onProgress) {
    const ctx = pdfDoc.context;
    const reachable = new Set();
    const queue = [];

    const ti = ctx.trailerInfo;
    if (ti && ti.Root) queue.push(ti.Root);
    if (ti && ti.Info) queue.push(ti.Info);

    // 掃描期分配 GC 階段 0-50%,用 asymptotic fake progress
    // v1.5.2:在 worker 內 yield 從 300 拉回 5000(主執行緒已釋放,只剩 cancel 響應 + 進度上報用)
    let yieldCounter = 0;
    while (queue.length > 0) {
      yieldCounter++;
      if (yieldCounter % 5000 === 0) {
        checkCancelled();
        if (onProgress) {
          const fakeI = 50 * (1 - Math.exp(-yieldCounter / 2000));
          onProgress(fakeI, 100);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      const item = queue.pop();
      if (!item) continue;
      if (item instanceof PDFLib.PDFRef) {
        const k = refKey(item);
        if (reachable.has(k)) continue;
        reachable.add(k);
        try { queue.push(ctx.lookup(item)); } catch (_) {}
      } else if (item instanceof PDFLib.PDFDict) {
        try {
          for (const [_, v] of item.entries()) queue.push(v);
        } catch (_) {}
      } else if (item instanceof PDFLib.PDFArray) {
        try {
          for (let i = 0; i < item.size(); i++) queue.push(item.get(i));
        } catch (_) {}
      } else if (item && item.dict) {
        queue.push(item.dict);
      }
    }

    // enumerate 也可能慢 — 給一個 50% mark
    if (onProgress) onProgress(50, 100);
    await new Promise(r => setTimeout(r, 0));

    let count = 0, saved = 0;
    const toDelete = [];
    ctx.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (reachable.has(refKey(ref))) return;
      const sz = (obj && obj.contents) ? obj.contents.length : 64;
      saved += sz;
      count++;
      toDelete.push(ref);
    });
    // Delete 期 50-100%
    // v1.5.2:在 worker 內 yield 從 200 拉回 2000
    for (let i = 0; i < toDelete.length; i++) {
      if (i % 2000 === 0) {
        checkCancelled();
        if (onProgress) onProgress(50 + (i / Math.max(1, toDelete.length)) * 50, 100);
        await new Promise(r => setTimeout(r, 0));
      }
      try { ctx.delete(toDelete[i]); } catch (_) {}
    }
    return { count, saved };
  }

  // ===== stripMetadata (index.html L1701-1753) =====
  function stripMetadata(pdfDoc) {
    const ctx = pdfDoc.context;
    const N = (n) => PDFLib.PDFName.of(n);
    // Catalog-level clean
    try {
      const catalog = pdfDoc.catalog;
      const toClean = ['Metadata', 'Names', 'AcroForm', 'StructTreeRoot', 'Outlines', 'PieceInfo', 'MarkInfo', 'OpenAction', 'AA', 'PageLabels', 'Threads'];
      for (const k of toClean) {
        try {
          const v = catalog.get(N(k));
          if (v instanceof PDFLib.PDFRef) {
            ctx.delete(v);
          }
          catalog.delete(N(k));
        } catch (_) {}
      }
    } catch (_) {}
    // Page-level clean: /Annots /AA /Thumb /B(article beads)
    try {
      const pages = pdfDoc.getPages();
      const pageKeysToClean = ['Annots', 'AA', 'Thumb', 'B', 'Tabs', 'PieceInfo'];
      for (const page of pages) {
        const pageDict = page.node;
        for (const k of pageKeysToClean) {
          try {
            const v = pageDict.get(N(k));
            if (v instanceof PDFLib.PDFRef) ctx.delete(v);
            // /Annots 是 array,裡面每個 ref 也要刪
            if (k === 'Annots' && v && typeof v.asArray === 'function') {
              for (const a of v.asArray()) {
                if (a instanceof PDFLib.PDFRef) {
                  try { ctx.delete(a); } catch (_) {}
                }
              }
            }
            pageDict.delete(N(k));
          } catch (_) {}
        }
      }
    } catch (_) {}
    // 清 trailer Info
    try {
      if (ctx.trailerInfo && ctx.trailerInfo.Info) {
        const infoRef = ctx.trailerInfo.Info;
        try { ctx.delete(infoRef); } catch (_) {}
        ctx.trailerInfo.Info = undefined;
      }
    } catch (_) {}
    // 清 ID(可選)
    try {
      if (ctx.trailerInfo && ctx.trailerInfo.ID) ctx.trailerInfo.ID = undefined;
    } catch (_) {}
  }

  // ===== stripImageMetadata (index.html L1756-1774) =====
  function stripImageMetadata(pdfDoc) {
    const N = (n) => PDFLib.PDFName.of(n);
    const SAFE_DELETE = ['Metadata', 'PieceInfo', 'LastModified', 'StructParent', 'StructParents'];
    let count = 0;
    pdfDoc.context.enumerateIndirectObjects().forEach(([_r, obj]) => {
      if (!(obj instanceof PDFLib.PDFRawStream)) return;
      const subtype = obj.dict.get(N('Subtype'));
      if (!(subtype && subtype.encodedName === '/Image')) return;
      for (const k of SAFE_DELETE) {
        try {
          if (obj.dict.get(N(k))) {
            obj.dict.delete(N(k));
            count++;
          }
        } catch (_) {}
      }
    });
    return { count };
  }

  // ===== collectImageStreams (index.html L2574-2628) =====
  async function collectImageStreams(pdfDoc) {
    const { PDFName, PDFRawStream } = PDFLib;
    // 先蒐集所有被當作 SMask/Mask 的 refs — 這些不能壓(會毀透明)
    const maskTargetRefs = new Set();
    pdfDoc.context.enumerateIndirectObjects().forEach(([_r, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const d = obj.dict;
      const sm = d.get(PDFName.of('SMask'));
      const m = d.get(PDFName.of('Mask'));
      // 用 instanceof 而非 constructor.name — pdf-lib.min.js 把 class 名稱 mangle 成單字母,
      // .constructor.name === 'PDFRef' 永遠 false → maskTargetRefs 永遠空 → SMask 被當主圖
      // 重壓 → 寫成 DeviceRGB DCT JPEG → 違反 PDF spec § 11.6.5.3 → macOS Preview 拒渲染
      for (const v of [sm, m]) {
        if (v instanceof PDFLib.PDFRef) {
          maskTargetRefs.add(refKey(v));
        }
      }
    });

    const items = [];
    pdfDoc.context.enumerateIndirectObjects().forEach(([ref, obj]) => {
      if (!(obj instanceof PDFRawStream)) return;
      const dict = obj.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      const subStr = subtype && (subtype.encodedName || subtype.toString());
      if (subStr !== '/Image') return;
      const type = dict.get(PDFName.of('Type'));
      const typeStr = type && (type.encodedName || type.toString());
      if (typeStr && typeStr !== '/XObject') return;
      const filter = dict.get(PDFName.of('Filter'));
      const filterType = imageFilterType(filter);
      if (!filterType) return;
      // skip 被當 alpha 用的(是別人 SMask/Mask 的 target)
      if (maskTargetRefs.has(refKey(ref))) return;
      // skip ImageMask stencil mask
      const imgMask = dict.get(PDFName.of('ImageMask'));
      if (imgMask && (imgMask.value === true || imgMask.encodedName === '/true')) return;
      // skip 有 Mask 是 Array(color key)— re-encode RGB 會讓 key 錯位
      const mask = dict.get(PDFName.of('Mask'));
      if (mask && mask.array) return;
      // 有 SMask/Mask 的主圖:標記 hasMask,讓 recompressImage 走 plate 偵測分支
      const smRef = dict.get(PDFName.of('SMask'));
      const mkRef = dict.get(PDFName.of('Mask'));
      const hasMask = (smRef instanceof PDFLib.PDFRef) || (mkRef instanceof PDFLib.PDFRef);
      // SMask 帶 Matte 仍 skip(pre-multiplied alpha 不能重壓)
      if (smRef instanceof PDFLib.PDFRef) {
        try {
          const smObj = pdfDoc.context.lookup(smRef);
          if (smObj && smObj.dict && smObj.dict.get(PDFName.of('Matte'))) return;
        } catch (_) {}
      }
      items.push({ ref, obj, dict, filterType, hasMask });
    });
    return items;
  }

  // ===== applyImageReplacement (index.html L2630-2660) =====
  function applyImageReplacement(pdfDoc, ref, dict, origW, origH, scale, result) {
    const N = (n) => PDFLib.PDFName.of(n);
    const actualScale = result.plateScale || scale;
    // OxiPNG 路徑:用 PNG 解析出來的真實尺寸,FlateDecode + Predictor 15
    if (result.filter === 'FlateDecode-PNG' && result.pngMeta) {
      const m = result.pngMeta;
      dict.set(N('Width'), PDFLib.PDFNumber.of(m.width));
      dict.set(N('Height'), PDFLib.PDFNumber.of(m.height));
      dict.set(N('Filter'), N('FlateDecode'));
      dict.set(N('ColorSpace'), N(m.colorspace));
      dict.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(m.bitDepth));
      // DecodeParms 含 Predictor 15(自動選 PNG 五種 predictor)
      const dp = pdfDoc.context.obj({
        Predictor: 15,
        Columns: m.width,
        Colors: m.colors,
        BitsPerComponent: m.bitDepth,
      });
      dict.set(N('DecodeParms'), dp);
      pdfDoc.context.assign(ref, PDFLib.PDFRawStream.of(dict, result.bytes));
      return;
    }
    // JPEG / JP2 路徑(原本邏輯)
    if (origW > 0) dict.set(N('Width'), PDFLib.PDFNumber.of(Math.max(1, Math.floor(origW * actualScale))));
    if (origH > 0) dict.set(N('Height'), PDFLib.PDFNumber.of(Math.max(1, Math.floor(origH * actualScale))));
    dict.set(N('Filter'), N(result.filter));
    try { dict.delete(N('DecodeParms')); } catch (_) {}
    dict.set(N('ColorSpace'), N('DeviceRGB'));
    dict.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(8));
    pdfDoc.context.assign(ref, PDFLib.PDFRawStream.of(dict, result.bytes));
  }

  // ===== skipReasonOf (index.html L2662-2678) =====
  function skipReasonOf(dict, filterType, hasMask) {
    const N = (n) => PDFLib.PDFName.of(n);
    const cs = dict.get(N('ColorSpace'));
    const bpc = dict.get(N('BitsPerComponent'))?.asNumber?.() || 8;
    let csKey = 'Unknown';
    if (cs) {
      if (cs.encodedName) csKey = cs.encodedName.replace(/^\//, '');
      else if (cs.array) csKey = 'Array(' + (cs.get(0)?.encodedName?.replace(/^\//, '') || '?') + ')';
    }
    // 有 SMask 且 decode 不是 plate 型 → 保守不壓(避免毀透明)
    if (hasMask) return '帶 SMask 非 plate 型(保守不壓)';
    if (bpc !== 8) return `${bpc}-bit`;
    if (csKey === 'Array(Indexed)') return 'Indexed 調色盤';
    if (csKey === 'Array(ICCBased)') return 'ICCBased 色彩描述';
    if (csKey.startsWith('Array')) return csKey;
    return filterType === 'FlateDecode' ? `Flate+${csKey}` : csKey;
  }

  // ===== embedJpxImage (index.html L1107-1120) =====
  function embedJpxImage(pdfDoc, jpxBytes, width, height) {
    const ctx = pdfDoc.context;
    const N = (n) => PDFLib.PDFName.of(n);
    const imgDict = PDFLib.PDFDict.withContext(ctx);
    imgDict.set(N('Type'), N('XObject'));
    imgDict.set(N('Subtype'), N('Image'));
    imgDict.set(N('Width'), PDFLib.PDFNumber.of(width));
    imgDict.set(N('Height'), PDFLib.PDFNumber.of(height));
    imgDict.set(N('ColorSpace'), N('DeviceRGB'));
    imgDict.set(N('BitsPerComponent'), PDFLib.PDFNumber.of(8));
    imgDict.set(N('Filter'), N('JPXDecode'));
    const stream = PDFLib.PDFRawStream.of(imgDict, jpxBytes);
    return ctx.register(stream);
  }

  // ===== drawJpxOnPage (index.html L1777-1785) =====
  function drawJpxOnPage(page, imgRef, width, height, keyName) {
    page.node.setXObject(PDFLib.PDFName.of(keyName), imgRef);
    page.pushOperators(
      PDFLib.pushGraphicsState(),
      PDFLib.concatTransformationMatrix(width, 0, 0, height, 0, 0),
      PDFLib.drawObject(keyName),
      PDFLib.popGraphicsState()
    );
  }

  // ===== roundToFriendlyMB (index.html L2115-2121) =====
  function roundToFriendlyMB(mb) {
    if (mb < 4.5) return Math.max(1, Math.round(mb));         // 1, 2, 3, 4
    if (mb < 9.5) return 5;                                    // 5
    if (mb < 95) return Math.ceil(mb / 10) * 10;               // 10, 20, 30, ... 90
    if (mb < 480) return Math.ceil(mb / 50) * 50;              // 100, 150, 200, ...
    return Math.ceil(mb / 100) * 100;                          // 500, 600, ...
  }

  // ===== estimatePreserveTargetMB (index.html L2124-2135) =====
  function estimatePreserveTargetMB(a) {
    // A(JPEG/Flate 可壓):賽馬 + MozJPEG 高品質 q≈0.82,平均壓到 30-40% 原大小
    // B(無損 Flate 重壓):pako 9,壓到 ~75%
    // C(不支援):原樣
    // 文字/字體/其他:原樣 — 但 dedup + GC + Object Stream 能再省 5-15%
    const aEst = a.aBytes * 0.35;
    const bEst = a.bBytes * 0.75;
    const cEst = a.cBytes;
    const textEst = a.textOtherBytes * 0.88; // 結構優化省一點
    const totalBytes = aEst + bEst + cEst + textEst;
    return totalBytes / 1024 / 1024;
  }

  // ===== CANDIDATES_RASTER (index.html L2209-2213) =====
  const CANDIDATES_RASTER = [
    [2.0, 0.90], [1.5, 0.85], [1.2, 0.80], [1.0, 0.75],
    [0.85, 0.70], [0.7, 0.60], [0.55, 0.50], [0.4, 0.40],
    [0.3, 0.30], [0.22, 0.25]
  ];

  // ===== CANDIDATES_PRESERVE (index.html L2215-2219) =====
  const CANDIDATES_PRESERVE = [
    [1.0, 0.90], [1.0, 0.80], [1.0, 0.70],
    [0.85, 0.75], [0.75, 0.70], [0.6, 0.60],
    [0.5, 0.50], [0.4, 0.45], [0.3, 0.35], [0.22, 0.30]
  ];

  // ===== renderPageEncoded (index.html L2221-2234) =====
  async function renderPageEncoded(page, scale, quality, codec) {
    const viewport = page.getViewport({ scale });
    const canvas = _newCanvas();
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const encoded = await encodeCanvas(canvas, quality, codec);
    const pxW = canvas.width, pxH = canvas.height;
    canvas.width = canvas.height = 0;
    return { ...encoded, width: viewport.width, height: viewport.height, pxW, pxH };
  }

  // ===== buildPdf (index.html L2236-2271) =====
  async function buildPdf(pages, scale, quality, onProgress, codec = 'jpeg') {
    const outDoc = await PDFLib.PDFDocument.create();
    // Phase 0-82%: 頁面渲染
    setProgressPhase(0, 82);
    const codecWins = new Map();
    for (let i = 0; i < pages.length; i++) {
      checkCancelled();
      const enc = await renderPageEncoded(pages[i], scale, quality, codec);
      const newPage = outDoc.addPage([enc.width, enc.height]);
      if (enc.filter === 'JPXDecode') {
        const imgRef = embedJpxImage(outDoc, enc.bytes, enc.pxW, enc.pxH);
        drawJpxOnPage(newPage, imgRef, enc.width, enc.height, `Im${i}`);
      } else {
        const img = await outDoc.embedJpg(enc.bytes);
        newPage.drawImage(img, { x: 0, y: 0, width: enc.width, height: enc.height });
      }
      const lbl = enc.label || (enc.filter === 'JPXDecode' ? 'jp2' : 'jpeg');
      codecWins.set(lbl, (codecWins.get(lbl) || 0) + 1);
      setProgress(((i + 1) / pages.length) * 100);
      if (onProgress) onProgress(i + 1, pages.length);
    }
    if (codecWins.size > 0) {
      const codecStats = Array.from(codecWins.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}(${v})`).join(', ');
      log(`壓縮引擎使用次數:${codecStats}`);
    }
    // save() 是 CPU-bound,用 CSS transition 讓動物在 compositor 繼續爬
    log('  正在輸出 PDF(大檔可能要幾十秒)...');
    creepToFinish();
    await waitForCompositorCommit();
    await yieldToMain();
    const out = await outDoc.save({ useObjectStreams: true });
    await yieldToMain();
    return out;
  }

  // ===== pickStart (index.html L2274-2281) =====
  function pickStart(ratio) {
    if (ratio >= 0.75) return [1.0, 0.88];
    if (ratio >= 0.5)  return [0.95, 0.78];
    if (ratio >= 0.3)  return [0.8, 0.65];
    if (ratio >= 0.15) return [0.6, 0.5];
    if (ratio >= 0.08) return [0.45, 0.4];
    return [0.3, 0.32];
  }

  // ===== pickStartRaster (index.html L2284-2292) =====
  function pickStartRaster(ratio, maxScale) {
    let s, q;
    if (ratio >= 0.5)       { s = maxScale;       q = 0.85; }
    else if (ratio >= 0.25) { s = maxScale * 0.8; q = 0.75; }
    else if (ratio >= 0.12) { s = maxScale * 0.6; q = 0.65; }
    else if (ratio >= 0.06) { s = maxScale * 0.45; q = 0.55; }
    else                    { s = maxScale * 0.3; q = 0.45; }
    return [Math.max(0.5, s), q];
  }

  // ===== pickStartPreserve (index.html L2295-2302) =====
  function pickStartPreserve(ratio) {
    if (ratio >= 0.85) return [0.95, 0.72];
    if (ratio >= 0.65) return [0.85, 0.62];
    if (ratio >= 0.4)  return [0.7, 0.55];
    if (ratio >= 0.2)  return [0.5, 0.45];
    if (ratio >= 0.1)  return [0.38, 0.38];
    return [0.25, 0.3];
  }

  // ===== refineParams (index.html L2305-2315) =====
  function refineParams(scale, quality, actualBytes, targetBytes, maxScale = 1.0, maxQuality = 0.95) {
    let factor = Math.sqrt((targetBytes * 0.93) / actualBytes);
    // 高 quality 域(>=0.75)JPEG 量化非線性,溫和一點避免過縮;
    // 低 quality 域加大步幅讓收斂更快
    if (quality >= 0.75) factor = factor * 0.95 + 0.05;
    else factor = factor * 1.05 - 0.05;
    return [
      Math.max(0.18, Math.min(maxScale, scale * factor)),
      Math.max(0.22, Math.min(maxQuality, quality * factor))
    ];
  }

  // ===== shrinkRaster (index.html L2317-2368) =====
  async function shrinkRaster(file, targetBytes, codec) {
    log(`模式:整頁轉圖片`);
    log(`讀取 PDF ...`);
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    log(`頁數:${doc.numPages}`);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));

    // 算出合理的 MAX scale:1080p(1920px 寬)基準,cap 在 3.5
    let pageMaxPt = 0;
    for (const p of pages) {
      const vp = p.getViewport({ scale: 1 });
      pageMaxPt = Math.max(pageMaxPt, vp.width, vp.height);
    }
    const MAX_SCALE = pageMaxPt > 0 ? Math.min(3.5, 1920 / pageMaxPt) : 3.0;
    log(`\n頁面最長邊 ${Math.round(pageMaxPt)}pt · 最高渲染倍率 ${MAX_SCALE.toFixed(2)}×(1080p 為基準)`);

    const ratio = targetBytes / file.size;
    let [scale, quality] = pickStartRaster(ratio, MAX_SCALE);
    log(`目標比例 ${(ratio * 100).toFixed(1)}% · 起點:縮放 ${Math.round(scale * 100)}% · 畫質 ${Math.round(quality * 100)}%`);

    const MAX_TRIES = 5;
    const history = [];
    let lastBytes = null;
    let smallestBytes = null; // 記錄探索過程中最小的版本(達不到目標時 fallback)
    const rasterBuildFn = (s, q) => buildPdf(pages, s, q, (n, total) => {
      const lines = $log.textContent.split('\n');
      lines[lines.length - 1] = `  渲染 ${n}/${total}`;
      $log.textContent = lines.join('\n');
      $log.scrollTop = $log.scrollHeight;
    }, codec);

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      log(`\n[第 ${attempt} 次](縮放 ${Math.round(scale * 100)}% · 畫質 ${Math.round(quality * 100)}%)`);
      startRace();
      const bytes = await rasterBuildFn(scale, quality);
      log(`  → ${fmtMB(bytes.length)}`);
      if (!smallestBytes || bytes.length < smallestBytes.length) smallestBytes = bytes;
      if (bytes.length <= targetBytes) {
        let best = { scale, quality, r: compressRatioOf(scale, quality), bytes };
        best = await tryUpQuality(rasterBuildFn, best, targetBytes, history[history.length - 1], MAX_SCALE, 0.95);
        log(`\n✓ 達標!最終 ${fmtMB(best.bytes.length)}(縮放 ${Math.round(best.scale * 100)}% · 畫質 ${Math.round(best.quality * 100)}%)`);
        return best.bytes;
      }
      lastBytes = bytes;
      history.push({ scale, quality, r: compressRatioOf(scale, quality), bytes: bytes.length });
      [scale, quality] = refineParams(scale, quality, bytes.length, targetBytes, MAX_SCALE, 0.95);
    }
    log(`\n⚠ 達不到目標 ${fmtMB(targetBytes)},已壓到極限 ${fmtMB(smallestBytes.length)},仍輸出最小版本給你`);
    return smallestBytes;
  }

  // ===== prepareDocumentBytes (index.html L2684-2739) =====
  async function prepareDocumentBytes(origBuf, onLog, opts = {}) {
    const log2 = (msg) => { if (onLog) onLog(msg); };
    const origSize = origBuf.byteLength || origBuf.length || 0;
    // 大檔(>200MB)模式:跳過 Form/ICC dedup(對大圖多的 PDF 省的有限,但 enumerateIndirectObjects
    // 全 walk 一次就要好幾秒)— 換來明顯減少卡頓時間
    const bigFile = origSize > 200 * 1024 * 1024;
    const pdfDoc = await PDFLib.PDFDocument.load(origBuf, { updateMetadata: false });
    stripMetadata(pdfDoc);
    const imgMeta = stripImageMetadata(pdfDoc);
    if (imgMeta.count > 0) log2(`  圖片冗餘 metadata 清掉:${imgMeta.count} 個欄位`);

    setProgressPhase(0, 8);
    log2('  影像去重中...');
    const dup = await dedupImages(pdfDoc, (i, t) => setProgress((i / t) * 100));
    log2(`  影像去重:合併 ${dup.count} 個重複,省 ${fmtMB(dup.saved)}`);

    setProgressPhase(8, 4);
    if (bigFile) {
      log2(`  大檔模式:跳過元件 / 色彩描述去重(省幾秒卡頓)`);
    } else {
      const formDup = await dedupFormXObjects(pdfDoc);
      if (formDup.count > 0) log2(`  重複元件合併:${formDup.count} 個,省 ${fmtMB(formDup.saved)}`);
      const icc = await dedupICCProfiles(pdfDoc);
      if (icc.count > 0) log2(`  重複色彩描述合併:${icc.count} 個,省 ${fmtMB(icc.saved)}`);
    }

    setProgressPhase(12, 8);
    log2('  清理未引用物件中...');
    const gc = await garbageCollect(pdfDoc, (i, t) => setProgress((i / t) * 100));
    log2(`  清理未引用物件:${gc.count} 個,省 ${fmtMB(gc.saved)}`);

    // 收 image refs(用於 skipRefs)
    const items = await collectImageStreams(pdfDoc);
    const skipRefs = new Set(items.map(x => refKey(x.ref)));

    setProgressPhase(20, 12);
    log2('  無損再壓縮中...');
    const flateRe = await recompressFlateLossless(pdfDoc, skipRefs, (i, t) => setProgress((i / t) * 100));
    log2(`  無損再壓縮:${flateRe.count} 個,省 ${fmtMB(flateRe.saved)}`);

    // opts.smaskScale:在這裡內聯 SMask 降階,省一次 save
    if (opts.smaskScale) {
      setProgressPhase(32, 4);
      log2(`  遮色片瘦身(×${opts.smaskScale})...`);
      const smRes = await downscaleSMasks(pdfDoc, opts.smaskScale, (i, t) => setProgress((i / t) * 100));
      if (smRes.textMaskSharpened > 0) log2(`  其中 ${smRes.textMaskSharpened} 個是文字遮色片(保留銳利不縮)`);
    }

    setProgressPhase(opts.smaskScale ? 36 : 32, 5);
    log2('  保存預處理結果...');
    await yieldToMain();
    const prepBytes = await pdfDoc.save({ useObjectStreams: true });
    await yieldToMain();
    log2(`  預處理完成:${fmtMB(origBuf.byteLength || origBuf.length)} → ${fmtMB(prepBytes.length)}`);
    return prepBytes;
  }

  // ===== buildPreservePdf (index.html L2741-2891) =====
  async function buildPreservePdf(prepBytes, scale, quality, codec, verboseLog = false) {
    const updateLogLine = (prefix) => {
      const had = $log.textContent.endsWith('\n');
      const lines = $log.textContent.split('\n');
      if (had) lines.pop();
      if (lines.length > 0) lines[lines.length - 1] = prefix;
      else lines.push(prefix);
      $log.textContent = lines.join('\n') + (had ? '\n' : '');
      $log.scrollTop = $log.scrollHeight;
    };
    // 從預處理結果接續,跳過 dedup/GC/ICC/Flate(quality 無關)
    const pdfDoc = await PDFLib.PDFDocument.load(prepBytes, { updateMetadata: false });
    const items = await collectImageStreams(pdfDoc);
    const skipRefs = new Set(items.map(x => refKey(x.ref)));

    // Phase 0-12%: SMask downscale(quality-dependent)
    setProgressPhase(0, 12);
    const smaskScale = quality < 0.5 ? 0.45 : quality < 0.75 ? 0.6 : 0.75;
    if (verboseLog) log(`  遮色片瘦身中(×${smaskScale})...`);
    const sm = await downscaleSMasks(pdfDoc, smaskScale, (i, t) => {
      if (verboseLog) updateLogLine(`  遮色片瘦身中... ${i}/${t}`);
      setProgress((i / t) * 100);
    });
    if (verboseLog) updateLogLine(`  遮色片瘦身(×${smaskScale}):${sm.count} 個,省 ${fmtMB(sm.saved)}`);

    if (verboseLog) log(`  實際處理 ${items.length} 張(去重後 unique)`);

    // 智慧分配:依像素數排名,boost 1.25(最大)→ 0.75(最小)
    const itemDims = items.map((it, idx) => {
      const w = it.dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      const h = it.dict.get(PDFLib.PDFName.of('Height'))?.asNumber?.() || 0;
      return { idx, pixels: w * h, w, h };
    });
    const ranked = itemDims.slice().sort((a, b) => b.pixels - a.pixels);
    const rankByIdx = new Map();
    for (let r = 0; r < ranked.length; r++) {
      rankByIdx.set(ranked[r].idx, ranked.length === 1 ? 0 : r / (ranked.length - 1));
    }

    // Fovea 近似 #1:頁面 aspect ratio 用於偵測「跨頁背景圖」
    // 圖的 AR 跟某頁 AR 相近 + 圖很大 → 多半是背景,可降畫質
    const pages = pdfDoc.getPages();
    const pageARs = pages.map(p => {
      const w = p.getWidth(), h = p.getHeight();
      return h > 0 ? w / h : 1;
    });
    const isPageBgLike = (w, h, rank) => {
      if (rank > 0.1) return false; // 收嚴:背景圖通常在 top 10%,過去 0.3 太寬會誤判前景大圖
      if (h <= 0) return false;
      const imgAR = w / h;
      return pageARs.some(par => Math.abs(par - imgAR) / par < 0.15);
    };

    if (verboseLog && ranked.length > 1) {
      const big = ranked[0], small = ranked[ranked.length - 1];
      const bigQ = Math.max(0.3, Math.min(0.95, quality * 1.25));
      const smallQ = Math.max(0.3, Math.min(0.95, quality * 0.75));
      log(`  智慧分配:大圖 ${big.w}×${big.h} 畫質 ${Math.round(bigQ * 100)}% → 小圖 ${small.w}×${small.h} 畫質 ${Math.round(smallQ * 100)}%`);
    }

    // Phase 12-78%: recompress image main loop(大頭)
    setProgressPhase(12, 66);
    let shrunk = 0, skipped = 0;
    let bgImageCount = 0;     // Fovea #1: 跨頁背景圖
    let plateImageCount = 0;  // Fovea #2: 均勻色塊圖
    let textImageCount = 0;   // Fovea #3: 文字圖(整頁信息圖 / 表格 / 文字海報)
    const skipReasons = new Map();
    const codecWins = new Map(); // codec winner stats
    for (let i = 0; i < items.length; i++) {
      if (i % 5 === 0) checkCancelled();
      const { ref, obj, dict, filterType, hasMask } = items[i];
      const orig = obj.contents;
      const dim = itemDims[i];
      const shortDim = Math.min(dim.w, dim.h);
      // 小圖保護:< 300px 短邊 OR < 90000 像素 → 不套 rank 降權、不再縮尺寸
      const isSmallImage = shortDim < 300 || dim.pixels < 90000;
      const rank = rankByIdx.get(i) ?? 0.5;
      // 大圖才套智慧分配,小圖維持原品質
      const boost = isSmallImage ? 1.0 : (1.25 - rank * 0.5);
      // Fovea #1:跨頁背景圖額外 0.85x(只在大圖判定)
      const bgPenalty = (!isSmallImage && isPageBgLike(dim.w, dim.h, rank)) ? 0.9 : 1.0;
      if (bgPenalty < 1) bgImageCount++;
      let perScale = Math.max(0.2, Math.min(1.0, scale * boost * bgPenalty));
      // 小圖不再縮尺寸(避免馬賽克),也不讓任何圖縮到短邊 < 200px
      if (isSmallImage) perScale = 1.0;
      else if (shortDim * perScale < 200 && shortDim >= 200) perScale = 200 / shortDim;
      // 小圖用較高品質下限(避免 JPEG 區塊感)
      const qFloor = isSmallImage ? 0.75 : 0.3;
      const perQuality = Math.max(qFloor, Math.min(0.95, quality * boost * bgPenalty));
      // Fovea #2:plate-like 偵測由 recompressImage 內部處理,給個 hint
      const result = await recompressImage(orig, perScale, perQuality, codec, filterType, dict, pdfDoc.context, !!hasMask);
      if (!result) {
        skipped++;
        const reason = skipReasonOf(dict, filterType, hasMask);
        skipReasons.set(reason, (skipReasons.get(reason) || 0) + 1);
      }
      else if (result.bytes.length < orig.length) {
        const widthObj = dict.get(PDFLib.PDFName.of('Width'));
        const heightObj = dict.get(PDFLib.PDFName.of('Height'));
        const origW = widthObj && widthObj.asNumber ? widthObj.asNumber() : 0;
        const origH = heightObj && heightObj.asNumber ? heightObj.asNumber() : 0;
        applyImageReplacement(pdfDoc, ref, dict, origW, origH, perScale, result);
        shrunk++;
        const lbl = result.label || 'unknown';
        codecWins.set(lbl, (codecWins.get(lbl) || 0) + 1);
        if (result.plateLike) plateImageCount++;
        if (result.textImage) textImageCount++;
      }
      setProgress(((i + 1) / items.length) * 100);
      if ((i + 1) % 20 === 0 || i === items.length - 1) {
        const lines = $log.textContent.split('\n');
        lines[lines.length - 1] = `  處理影像 ${i + 1}/${items.length}(縮 ${shrunk}、略 ${skipped})`;
        $log.textContent = lines.join('\n');
        $log.scrollTop = $log.scrollHeight;
      }
      // 每張圖讓事件迴圈呼吸 → 避免 N 個 WASM 編碼連環跑導致網頁未回應
      await new Promise(r => setTimeout(r, 0));
    }
    // Codec 統計每次都印(包含上探迭代),用簡短一行格式
    {
      const labelMap = { jp2: 'JP2', mozjpeg: 'Moz', oxipng: 'Oxi', 'canvas-jpg': 'cvs' };
      const allLabels = ['jp2', 'mozjpeg', 'oxipng', 'canvas-jpg'];
      const parts = allLabels.map(k => `${labelMap[k]}=${codecWins.get(k) || 0}`).filter((_, i) => (codecWins.get(allLabels[i]) || 0) > 0);
      const totalWins = Array.from(codecWins.values()).reduce((a, b) => a + b, 0);
      log(`  壓縮引擎:${parts.join(' · ')} | 動 ${totalWins}、未動 ${skipped}`);
      // Fovea 統計
      if (bgImageCount > 0 || plateImageCount > 0 || textImageCount > 0) {
        const parts = [];
        if (bgImageCount > 0) parts.push(`背景底圖 ${bgImageCount} 張`);
        if (plateImageCount > 0) parts.push(`大色塊圖 ${plateImageCount} 張(額外壓一點)`);
        if (textImageCount > 0) parts.push(`文字圖 ${textImageCount} 張(保留高畫質)`);
        log(`  偵測重點:${parts.join('、')}`);
      }
    }
    if (verboseLog && skipped > 0) {
      const top = Array.from(skipReasons.entries()).sort((a,b) => b[1]-a[1]).slice(0, 6);
      log(`  未動分類:${top.map(([k,v]) => `${k}(${v})`).join(', ')}`);
    }
    if (verboseLog) {
      const dangling = validateMaskRefs(pdfDoc);
      if (dangling > 0) log(`  ⚠ 提醒:${dangling} 張遮色片連結異常(少數圖可能出現灰底)`);
    }
    // save() 是 CPU-bound,用 CSS transition 讓動物在 compositor 繼續爬
    if (verboseLog) log('  正在輸出 PDF(大檔可能要幾十秒)...');
    creepToFinish();
    await waitForCompositorCommit();
    await yieldToMain();
    const out = await pdfDoc.save({ useObjectStreams: true });
    await yieldToMain();
    return out;
  }

  // ===== buildPreservePdfProbe (index.html L2895-2985) =====
  async function buildPreservePdfProbe(prepBytes, scale, quality, codec, verboseLog, skipSmaskDownscale = false) {
    const updateLogLine = (prefix) => {
      const had = $log.textContent.endsWith('\n');
      const lines = $log.textContent.split('\n');
      if (had) lines.pop();
      if (lines.length > 0) lines[lines.length - 1] = prefix;
      else lines.push(prefix);
      $log.textContent = lines.join('\n') + (had ? '\n' : '');
      $log.scrollTop = $log.scrollHeight;
    };
    const pdfDoc = await PDFLib.PDFDocument.load(prepBytes, { updateMetadata: false });
    const items = await collectImageStreams(pdfDoc);

    let smaskScale = 0.65; // skip 時 caller 自己已經套過 0.65
    if (!skipSmaskDownscale) {
      setProgressPhase(0, 8);
      smaskScale = quality < 0.5 ? 0.45 : quality < 0.75 ? 0.6 : 0.75;
      if (verboseLog) log(`  遮色片瘦身(×${smaskScale})`);
      await downscaleSMasks(pdfDoc, smaskScale, (i, t) => setProgress((i / t) * 100));
    }

    // 分配 / Fovea 計算
    const itemDims = items.map((it, idx) => {
      const w = it.dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      const h = it.dict.get(PDFLib.PDFName.of('Height'))?.asNumber?.() || 0;
      return { idx, pixels: w * h, w, h };
    });
    const ranked = itemDims.slice().sort((a, b) => b.pixels - a.pixels);
    const rankByIdx = new Map();
    for (let r = 0; r < ranked.length; r++) {
      rankByIdx.set(ranked[r].idx, ranked.length === 1 ? 0 : r / (ranked.length - 1));
    }
    const pages = pdfDoc.getPages();
    const pageARs = pages.map(p => { const w = p.getWidth(), h = p.getHeight(); return h > 0 ? w / h : 1; });
    const isPageBgLike = (w, h, rank) => {
      if (rank > 0.1 || h <= 0) return false;
      return pageARs.some(par => Math.abs(par - w/h) / par < 0.15);
    };

    setProgressPhase(8, 80);
    const candidates = new Array(items.length).fill(null);
    const codecWins = new Map();
    let bgCount = 0, plateCount = 0, textCount = 0;
    for (let i = 0; i < items.length; i++) {
      if (i % 5 === 0) checkCancelled();
      const { obj, dict, filterType, hasMask } = items[i];
      const orig = obj.contents;
      const dim = itemDims[i];
      const shortDim = Math.min(dim.w, dim.h);
      // 小圖保護:< 300 短邊 / < 90000 像素 → 不套 rank、不縮尺寸
      const isSmallImage = shortDim < 300 || dim.pixels < 90000;
      const rank = rankByIdx.get(i) ?? 0.5;
      const boost = isSmallImage ? 1.0 : (1.25 - rank * 0.5);
      const bgPenalty = (!isSmallImage && isPageBgLike(dim.w, dim.h, rank)) ? 0.9 : 1.0;
      if (bgPenalty < 1) bgCount++;
      let perScale = Math.max(0.2, Math.min(1.0, scale * boost * bgPenalty));
      if (isSmallImage) perScale = 1.0;
      else if (shortDim * perScale < 200 && shortDim >= 200) perScale = 200 / shortDim;
      const qFloor = isSmallImage ? 0.75 : 0.3;
      const perQuality = Math.max(qFloor, Math.min(0.95, quality * boost * bgPenalty));
      const result = await recompressImage(orig, perScale, perQuality, codec, filterType, dict, pdfDoc.context, !!hasMask);
      if (result && result.bytes.length < orig.length) {
        // text-image 走 recompressImage 內部會 override perScale 為 1.0 → 用 result.plateScale
        const actualScale = result.plateScale || perScale;
        candidates[i] = { ...result, perScale: actualScale, origLen: orig.length };
        codecWins.set(result.label || '?', (codecWins.get(result.label || '?') || 0) + 1);
        if (result.plateLike) plateCount++;
        if (result.textImage) textCount++;
      }
      setProgress(((i + 1) / items.length) * 100);
      if ((i + 1) % 20 === 0 || i === items.length - 1) {
        updateLogLine(`  探測 ${i + 1}/${items.length}`);
      }
      await new Promise(r => setTimeout(r, 0));
    }
    if (verboseLog) {
      const labelMap = { jp2: 'JP2', mozjpeg: 'Moz', oxipng: 'Oxi', 'canvas-jpg': 'cvs' };
      const parts = ['jp2', 'mozjpeg', 'oxipng', 'canvas-jpg'].map(k => `${labelMap[k]}=${codecWins.get(k) || 0}`).filter((_, i) => (codecWins.get(['jp2','mozjpeg','oxipng','canvas-jpg'][i]) || 0) > 0);
      const wins = candidates.filter(c => c).length;
      const sumBytes = candidates.reduce((s, c) => s + (c ? c.bytes.length : 0), 0);
      log(`  壓縮引擎:${parts.join(' · ')} | 圖片總 ${fmtMB(sumBytes)}、可動 ${wins}/${items.length}`);
      if (bgCount || plateCount || textCount) {
        const parts = [];
        if (bgCount) parts.push(`背景底圖 ${bgCount}`);
        if (plateCount) parts.push(`大色塊圖 ${plateCount}`);
        if (textCount) parts.push(`文字圖 ${textCount}(保留高畫質)`);
        log(`  偵測重點:${parts.join('、')}`);
      }
    }
    return { items, candidates, itemDims, rankByIdx, isPageBgLike, smaskScale };
  }

  // ===== buildPreservePdfMultiProbe (index.html L2990-3135) =====
  async function buildPreservePdfMultiProbe(prepBytes, setpoints, codec, verboseLog, skipSmaskDownscale = false) {
    const updateLogLine = (prefix) => {
      const had = $log.textContent.endsWith('\n');
      const lines = $log.textContent.split('\n');
      if (had) lines.pop();
      if (lines.length > 0) lines[lines.length - 1] = prefix;
      else lines.push(prefix);
      $log.textContent = lines.join('\n') + (had ? '\n' : '');
      $log.scrollTop = $log.scrollHeight;
    };
    const pdfDoc = await PDFLib.PDFDocument.load(prepBytes, { updateMetadata: false });
    const items = await collectImageStreams(pdfDoc);

    let smaskScale = 0.65;
    if (!skipSmaskDownscale) {
      setProgressPhase(0, 8);
      // 用最高 quality 判 smaskScale(無從預知 setpoint 細節時的折衷)
      const maxQ = Math.max(...setpoints.map(sp => sp.quality));
      smaskScale = maxQ < 0.5 ? 0.45 : maxQ < 0.75 ? 0.6 : 0.75;
      if (verboseLog) log(`  遮色片瘦身(×${smaskScale})`);
      await downscaleSMasks(pdfDoc, smaskScale, (i, t) => setProgress((i / t) * 100));
    }

    // 智慧分配計算
    const itemDims = items.map((it, idx) => {
      const w = it.dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      const h = it.dict.get(PDFLib.PDFName.of('Height'))?.asNumber?.() || 0;
      return { idx, pixels: w * h, w, h };
    });
    const ranked = itemDims.slice().sort((a, b) => b.pixels - a.pixels);
    const rankByIdx = new Map();
    for (let r = 0; r < ranked.length; r++) {
      rankByIdx.set(ranked[r].idx, ranked.length === 1 ? 0 : r / (ranked.length - 1));
    }
    const pages = pdfDoc.getPages();
    const pageARs = pages.map(p => { const w = p.getWidth(), h = p.getHeight(); return h > 0 ? w / h : 1; });
    const isPageBgLike = (w, h, rank) => {
      if (rank > 0.1 || h <= 0) return false;
      return pageARs.some(par => Math.abs(par - w/h) / par < 0.15);
    };

    setProgressPhase(8, 80);
    const numSp = setpoints.length;
    const candidates = setpoints.map(() => new Array(items.length).fill(null));
    const codecWins = new Map();
    let bgCount = 0, plateCount = 0, textCount = 0;
    let progressDone = 0;
    const updateProgress = () => {
      progressDone++;
      setProgress((progressDone / items.length) * 100);
      if (verboseLog && (progressDone % 20 === 0 || progressDone === items.length)) {
        updateLogLine(`  探測 ${progressDone}/${items.length}(${numSp} 版本一次跑)`);
      }
    };

    // ====== Phase 3:把 DCTDecode 圖派給 image-worker pool 平行處理 ======
    // Flate 圖留 inline(dict 解碼需 pdf-lib,沒搬進 image-worker)
    // v1.5.2:pool 啟動結果一律 log(不靠 verboseLog),用戶能看到自己有沒有跑在快路徑
    let pool = null;
    try {
      pool = await ensureImagePool();
      log(`  並行池啟用(${pool.length} workers)`);
    } catch (e) {
      log(`  並行池啟用失敗,單線程處理:${e.message}`);
      if (e.stack) log(`    stack: ${e.stack.split('\n')[0]}`);
    }

    // ----- 取出每個 image 的 per-image scalar(無論 inline 或 pool 都用) -----
    function preCalcPerImage(i) {
      const { hasMask } = items[i];
      const dim = itemDims[i];
      const shortDim = Math.min(dim.w, dim.h);
      const isSmallImage = shortDim < 300 || dim.pixels < 90000;
      const rank = rankByIdx.get(i) ?? 0.5;
      const boost = isSmallImage ? 1.0 : (1.25 - rank * 0.5);
      const bgPenalty = (!isSmallImage && isPageBgLike(dim.w, dim.h, rank)) ? 0.9 : 1.0;
      return { hasMask, shortDim, isSmallImage, boost, bgPenalty };
    }

    // ----- inline 處理(原邏輯,保留給 Flate 圖 + pool 失敗 fallback) -----
    async function processInline(i) {
      const { obj, dict, filterType, hasMask } = items[i];
      const orig = obj.contents;
      const { shortDim, isSmallImage, boost, bgPenalty } = preCalcPerImage(i);
      if (bgPenalty < 1) bgCount++;

      const fullCanvas = await imageToCanvas(orig, dict, filterType, 1.0, pdfDoc.context);
      if (!fullCanvas) { updateProgress(); return; }
      const fcW = fullCanvas.width, fcH = fullCanvas.height;
      let isPlate = false, isText = false;
      if (fcW >= 300 && fcH >= 300) isPlate = isPlateImage(fullCanvas);
      if (!isPlate && fcW * fcH >= 60000 && fcW >= 200 && fcH >= 80) isText = isTextImage(fullCanvas);

      for (let s = 0; s < numSp; s++) {
        const sp = setpoints[s];
        let perScale = Math.max(0.2, Math.min(1.0, sp.scale * boost * bgPenalty));
        if (isSmallImage) perScale = 1.0;
        else if (shortDim * perScale < 200 && shortDim >= 200) perScale = 200 / shortDim;
        const qFloor = isSmallImage ? 0.75 : 0.3;
        let perQuality = Math.max(qFloor, Math.min(0.95, sp.quality * boost * bgPenalty));

        if (isText) { perScale = 1.0; perQuality = Math.max(0.92, perQuality); }
        else if (isPlate && hasMask) { perScale = Math.max(0.25, perScale * 0.6); perQuality = Math.max(0.3, perQuality * 0.7); }
        else if (isPlate) { perQuality = Math.max(0.3, perQuality * 0.7); }
        else if (hasMask) { perScale = Math.max(0.5, perScale); perQuality = Math.max(0.85, perQuality * 1.3); }

        const newW = Math.max(1, Math.floor(fcW * perScale));
        const newH = Math.max(1, Math.floor(fcH * perScale));
        let scaled;
        if (newW === fcW && newH === fcH) {
          scaled = fullCanvas;
        } else {
          scaled = _newCanvas();
          scaled.width = newW; scaled.height = newH;
          scaled.getContext('2d').drawImage(fullCanvas, 0, 0, newW, newH);
        }
        const enc = await encodeCanvas(scaled, perQuality, codec);
        if (scaled !== fullCanvas) { scaled.width = scaled.height = 0; }
        if (enc && enc.bytes && enc.bytes.length < orig.length) {
          candidates[s][i] = { ...enc, perScale, origLen: orig.length };
          codecWins.set(enc.label || '?', (codecWins.get(enc.label || '?') || 0) + 1);
        }
      }
      if (isPlate) plateCount++;
      if (isText) textCount++;
      fullCanvas.width = fullCanvas.height = 0;
      updateProgress();
      await new Promise(r => setTimeout(r, 0));
    }

    // ----- 路由:DCT → pool(if pool ready);其他 / pool 失敗 → inline -----
    const dctIdx = [];
    const inlineIdx = [];
    for (let i = 0; i < items.length; i++) {
      if (pool && items[i].filterType === 'DCTDecode') dctIdx.push(i);
      else inlineIdx.push(i);
    }
    // v1.5.2:讓用戶看到分流比例(理解為何沒明顯加速 — 可能是 Flate 太多)
    if (pool) {
      log(`  分流:JPEG ${dctIdx.length} 張(平行)、其他 ${inlineIdx.length} 張(序列)`);
    }

    // 先派 inline(序列、佔 orchestrator),再派 pool(平行、各 image-worker 上)
    // 兩者並行跑 — orchestrator inline 處理小批 Flate 時,pool 同時在跑 DCT
    const inlinePromise = (async () => {
      for (const i of inlineIdx) {
        if (i % 5 === 0) checkCancelled();
        await processInline(i);
      }
    })();

    const poolPromise = (async () => {
      if (!pool || dctIdx.length === 0) return;
      let nextOff = 0;
      async function workerLoop(slot) {
        while (true) {
          checkCancelled();
          const off = nextOff++;
          if (off >= dctIdx.length) return;
          const i = dctIdx[off];
          const { obj, filterType } = items[i];
          const pre = preCalcPerImage(i);
          if (pre.bgPenalty < 1) bgCount++;
          try {
            const result = await dispatchProbe(slot, {
              idx: i,
              origBytes: obj.contents,
              filterType,
              hasMask: pre.hasMask,
              shortDim: pre.shortDim,
              isSmallImage: pre.isSmallImage,
              boost: pre.boost,
              bgPenalty: pre.bgPenalty,
              setpoints,
              codec,
            });
            if (result.candidates) {
              for (let s = 0; s < numSp; s++) {
                const cand = result.candidates[s];
                if (cand) {
                  candidates[s][i] = cand;
                  codecWins.set(cand.label || '?', (codecWins.get(cand.label || '?') || 0) + 1);
                }
              }
            }
            if (result.isPlate) plateCount++;
            if (result.isText) textCount++;
            updateProgress();
          } catch (err) {
            // worker 失敗 → 退到 inline 處理這張(不丟整批)
            if (verboseLog) log(`  pool image ${i} failed (${err.message}),退單線程`);
            await processInline(i);
          }
        }
      }
      await Promise.all(pool.map(slot => workerLoop(slot)));
    })();

    await Promise.all([inlinePromise, poolPromise]);
    if (verboseLog) {
      const labelMap = { jp2: 'JP2', mozjpeg: 'Moz', oxipng: 'Oxi', 'canvas-jpg': 'cvs' };
      const parts = ['jp2', 'mozjpeg', 'oxipng', 'canvas-jpg']
        .filter(k => (codecWins.get(k) || 0) > 0)
        .map(k => `${labelMap[k]}=${codecWins.get(k)}`);
      const wins = candidates[0].filter(c => c).length;
      const sumBytes = candidates[0].reduce((s, c) => s + (c ? c.bytes.length : 0), 0);
      log(`  壓縮引擎:${parts.join(' · ')} | 第 1 版總 ${fmtMB(sumBytes)}、可動 ${wins}/${items.length}`);
      if (bgCount || plateCount || textCount) {
        const detParts = [];
        if (bgCount) detParts.push(`背景底圖 ${bgCount}`);
        if (plateCount) detParts.push(`大色塊圖 ${plateCount}`);
        if (textCount) detParts.push(`文字圖 ${textCount}(保留高畫質)`);
        log(`  偵測重點:${detParts.join('、')}`);
      }
    }
    return { items, candidates, itemDims, rankByIdx, isPageBgLike, smaskScale };
  }

  // ===== knapsackPickChoices (index.html L3138-3233) =====
  function knapsackPickChoices(setpoints, probeResults, items, prepBytesLen, targetBytes, log2) {
    const N = items.length;
    const numV = setpoints.length;
    // 估 PDF overhead = prepBytes - sum(原 image bytes)
    const origImageBytes = items.reduce((s, it) => s + it.obj.contents.length, 0);
    const overhead = Math.max(0, prepBytesLen - origImageBytes) + 20 * 1024; // +20K 緩衝
    const budget = targetBytes - overhead;

    // choices[i] = setpoint index(0..numV-1)| -1 表示維持原圖
    const choices = new Array(N).fill(-1);
    let used = 0;

    // 初始化:每張圖選「最便宜的可用版本」(通常是 setpoint 0 LOW)
    for (let i = 0; i < N; i++) {
      let cheapest = -1, cheapestSize = items[i].obj.contents.length;
      for (let v = 0; v < numV; v++) {
        const cand = probeResults[v].candidates[i];
        if (cand && cand.bytes.length < cheapestSize) {
          cheapest = v;
          cheapestSize = cand.bytes.length;
        }
      }
      if (cheapest >= 0) {
        choices[i] = cheapest;
        used += cheapestSize;
      } else {
        used += items[i].obj.contents.length; // 維持原圖
      }
    }

    if (log2) log2(`  初始拼合(全選最小):${fmtMB(used)} / 預算 ${fmtMB(budget)}`);

    // Greedy 升級:重複找「品質單位/byte 比最高」的升級,套上去直到爆預算
    const dimRanked = items.map((_, i) => i).sort((a, b) => {
      const da = items[a].dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      const db = items[b].dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      return db - da;
    });
    const rankMap = new Map();
    for (let r = 0; r < dimRanked.length; r++) rankMap.set(dimRanked[r], r / Math.max(1, dimRanked.length - 1));

    const importanceOf = (i) => {
      const rank = rankMap.get(i) ?? 0.5;
      return 1.5 - rank; // 1.5(最大圖)→ 0.5(最小圖)
    };

    let upgradeRounds = 0;
    while (true) {
      upgradeRounds++;
      let bestIdx = -1, bestRatio = 0, bestCost = 0, bestNext = -1;
      for (let i = 0; i < N; i++) {
        const cur = choices[i];
        if (cur === numV - 1) continue;
        // 找下一個更高品質的可用版本(setpoint 0 = LOW、1 = HIGH、2 = MID — 順序在 setpoints 定義)
        let nextV = -1, nextSize = Infinity;
        const curSize = cur >= 0 ? probeResults[cur].candidates[i].bytes.length : items[i].obj.contents.length;
        const curQ = cur >= 0 ? setpoints[cur].quality : 0;
        for (let v = 0; v < numV; v++) {
          if (v === cur) continue;
          const cand = probeResults[v].candidates[i];
          if (!cand) continue;
          const candQ = setpoints[v].quality;
          if (candQ <= curQ) continue; // 不算升級
          if (cand.bytes.length <= nextSize) {
            // 同 quality 下選較小;quality 高優先
            if (cand.bytes.length < nextSize || candQ > (nextV >= 0 ? setpoints[nextV].quality : 0)) {
              nextV = v;
              nextSize = cand.bytes.length;
            }
          }
        }
        if (nextV < 0) continue;
        const cost = nextSize - curSize;
        if (cost <= 0) {
          // 免費升級(高品質還比較小)→ 立刻取
          choices[i] = nextV;
          used += cost;
          continue;
        }
        if (used + cost > budget) continue;
        const qDiff = setpoints[nextV].quality - curQ;
        const score = qDiff * importanceOf(i);
        const ratio = score / cost;
        if (ratio > bestRatio) {
          bestRatio = ratio; bestIdx = i; bestCost = cost; bestNext = nextV;
        }
      }
      if (bestIdx < 0) break;
      choices[bestIdx] = bestNext;
      used += bestCost;
      if (upgradeRounds > 5000) break; // safety
    }
    if (log2) log2(`  逐步升級 ${upgradeRounds} 輪 → 最終拼合 ${fmtMB(used)}`);

    return { choices, estimatedTotal: used };
  }

  // ===== assembleFinalPdf (index.html L3236-3286) =====
  async function assembleFinalPdf(prepBytes, setpoints, probeResults, choices, verboseLog, skipSmaskDownscale = false) {
    const pdfDoc = await PDFLib.PDFDocument.load(prepBytes, { updateMetadata: false });
    const items = await collectImageStreams(pdfDoc);
    if (!skipSmaskDownscale) {
      // SMask:用 MID setpoint(中間值)的 smaskScale,當作折衷
      const midSp = setpoints.reduce((acc, sp) => acc.quality < sp.quality ? acc : sp); // 找最低 quality
      // 其實取「中間」更好,但簡單先用最高 quality 的 smaskScale(細緻)
      const highSp = setpoints.reduce((acc, sp) => acc.quality > sp.quality ? acc : sp);
      const useQ = highSp.quality;
      const smaskScale = useQ < 0.5 ? 0.45 : useQ < 0.75 ? 0.6 : 0.75;
      if (verboseLog) log(`  遮色片瘦身(使用最高畫質設定)...`);
      setProgressPhase(0, 10);
      await downscaleSMasks(pdfDoc, smaskScale, (i, t) => setProgress((i / t) * 100));
    } else {
      setProgressPhase(0, 5);
    }

    setProgressPhase(10, 70);
    let applied = 0;
    const pickedSetpoints = new Array(setpoints.length).fill(0);
    for (let i = 0; i < items.length; i++) {
      if (i % 10 === 0) checkCancelled();
      const ch = choices[i];
      if (ch < 0) continue;
      const cand = probeResults[ch].candidates[i];
      if (!cand) continue;
      const { ref, dict } = items[i];
      const widthObj = dict.get(PDFLib.PDFName.of('Width'));
      const heightObj = dict.get(PDFLib.PDFName.of('Height'));
      const origW = widthObj?.asNumber?.() || 0;
      const origH = heightObj?.asNumber?.() || 0;
      applyImageReplacement(pdfDoc, ref, dict, origW, origH, cand.perScale || setpoints[ch].scale, cand);
      applied++;
      pickedSetpoints[ch]++;
      setProgress(((i + 1) / items.length) * 100);
    }
    if (verboseLog) {
      const dist = setpoints.map((sp, i) => {
        const lbl = sp.label === 'L' ? '低' : sp.label === 'H' ? '高' : '中';
        return `${lbl}畫質 ${pickedSetpoints[i]} 張`;
      }).join(' · ');
      log(`  拼合完成:共套 ${applied} 張 → ${dist}`);
    }
    log('  正在輸出 PDF(大檔可能要幾十秒)...');
    creepToFinish();
    await waitForCompositorCommit();
    await yieldToMain();
    const out = await pdfDoc.save({ useObjectStreams: true });
    await yieldToMain();
    return out;
  }

  // ===== compressRatioOf (index.html L3289-3291) =====
  function compressRatioOf(scale, quality) {
    return scale * scale * Math.pow(quality, 1.5);
  }

  // ===== tryUpQuality (index.html L3321-3371) =====
  async function tryUpQuality(buildFn, currentBest, targetBytes, historyOver, maxScale = 1.0, maxQuality = 0.95) {
    const MAX_S = maxScale, MAX_Q = maxQuality;
    if (currentBest.scale >= MAX_S - 0.005 && currentBest.quality >= MAX_Q - 0.005) return currentBest;

    let best = currentBest;
    let lowR = compressRatioOf(best.scale, best.quality);
    let lowScale = best.scale, lowQuality = best.quality;
    let highR, highScale, highQuality;

    if (historyOver) {
      highR = historyOver.r;
      highScale = historyOver.scale;
      highQuality = historyOver.quality;
    } else {
      // 先試 MAX:若 MAX 達標直接收工,否則 MAX 作為 high bound
      log(`\n[試最大畫質](縮放 ${Math.round(MAX_S * 100)}% · 畫質 ${Math.round(MAX_Q * 100)}%)`);
      checkCancelled();
      const maxBytes = await buildFn(MAX_S, MAX_Q);
      log(`  → ${fmtMB(maxBytes.length)}`);
      if (maxBytes.length <= targetBytes) {
        return { scale: MAX_S, quality: MAX_Q, r: compressRatioOf(MAX_S, MAX_Q), bytes: maxBytes };
      }
      highR = compressRatioOf(MAX_S, MAX_Q);
      highScale = MAX_S;
      highQuality = MAX_Q;
    }

    // 3 輪 binary search(幾何中點)
    for (let i = 0; i < 3; i++) {
      const midR = Math.sqrt(lowR * highR);
      const factor = Math.pow(midR / lowR, 1 / 3.5);
      const ts = Math.min(MAX_S, lowScale * factor);
      const tq = Math.min(MAX_Q, lowQuality * factor);
      if (Math.abs(ts - lowScale) < 0.005) break;
      log(`\n[試提升畫質 ${i + 1}](縮放 ${Math.round(ts * 100)}% · 畫質 ${Math.round(tq * 100)}%)`);
      checkCancelled();
      const tb = await buildFn(ts, tq);
      log(`  → ${fmtMB(tb.length)}`);
      if (tb.length <= targetBytes) {
        best = { scale: ts, quality: tq, r: midR, bytes: tb };
        lowR = midR;
        lowScale = ts; lowQuality = tq;
        // 貼近 target 92%+ 就停
        if (tb.length > targetBytes * 0.92) break;
      } else {
        highR = midR;
        highScale = ts; highQuality = tq;
      }
    }
    return best;
  }

  // ===== shrinkPreserve (index.html L3373-3494) =====
  async function shrinkPreserve(file, targetBytes, codec) {
    log(`模式:保留文字(只壓圖片)`);
    log(`讀取 PDF ...`);
    const origBuf = await file.arrayBuffer();

    const probeDoc = await PDFLib.PDFDocument.load(origBuf, { updateMetadata: false });
    const probeImages = await collectImageStreams(probeDoc);
    log(`可壓縮的圖片:${probeImages.length} 張`);
    if (probeImages.length === 0) {
      throw new Error('這個 PDF 裡沒有可壓縮的圖片(可能是純文字 PDF)。「保留文字」模式沒東西可壓,請改用「整頁轉圖片」模式。');
    }

    const ratio = targetBytes / file.size;
    let [scale, quality] = pickStartPreserve(ratio);
    log(`\n目標比例 ${(ratio * 100).toFixed(1)}% · 起點:縮放 ${Math.round(scale * 100)}% · 畫質 ${Math.round(quality * 100)}%`);

    // 預處理(只跑一次)— 跟 quality 無關的步驟全做完
    log('\n[預處理] 整理重複資料、釋放空間(只做一次)');
    startRace();
    const prepBytes = await prepareDocumentBytes(origBuf, log);

    const MAX_TRIES = 5;
    const history = []; // [{scale, quality, r, bytes}]
    let lastBytes = null;
    let smallestBytes = null; // 達不到目標時 fallback 到最小版本

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      log(`\n[第 ${attempt} 次](縮放 ${Math.round(scale * 100)}% · 畫質 ${Math.round(quality * 100)}%)`);
      startRace();
      const bytes = await buildPreservePdf(prepBytes, scale, quality, codec, true);
      log(`  → ${fmtMB(bytes.length)}`);
      if (!smallestBytes || bytes.length < smallestBytes.length) smallestBytes = bytes;
      if (bytes.length <= targetBytes) {
        // 達標 → 啟動「多版本探測 + 智慧拼合」(取代盲目 upProbe)
        log(`\n[達標!] 開始微調,找最佳畫質組合`);
        const setpointsHigh = { scale: 1.0, quality: 0.95, label: 'H' };
        const setpointsMid = { scale: Math.min(1.0, (scale + 1.0) / 2), quality: Math.min(0.95, (quality + 0.95) / 2), label: 'M' };
        const setpointsLow = { scale, quality, label: 'L' };
        const setpoints = [setpointsLow, setpointsHigh, setpointsMid];

        // 探測 LOW(就是剛才那輪的設定 — 重跑一次拿 candidates,不浪費,因為要捕捉 per-image)
        const probeResults = [];
        for (let s = 0; s < setpoints.length; s++) {
          const sp = setpoints[s];
          const spLabel = sp.label === 'L' ? '低' : sp.label === 'H' ? '高' : '中';
          log(`\n[第 ${attempt + 1 + s} 次:${spLabel}畫質測試](縮放 ${Math.round(sp.scale * 100)}% · 畫質 ${Math.round(sp.quality * 100)}%)`);
          startRace();
          const probe = await buildPreservePdfProbe(prepBytes, sp.scale, sp.quality, codec, true);
          probeResults.push(probe);
        }

        // Knapsack 拼合
        log(`\n[智慧拼合] 每張圖挑最佳版本`);
        const items = probeResults[0].items;
        const { choices, estimatedTotal } = knapsackPickChoices(setpoints, probeResults, items, prepBytes.length, targetBytes, log);

        // 拼合 + save
        startRace();
        const finalBytes = await assembleFinalPdf(prepBytes, setpoints, probeResults, choices, true);
        log(`\n✓ 達標!最終 ${fmtMB(finalBytes.length)}(預估 ${fmtMB(estimatedTotal)})`);
        return finalBytes;
      }
      lastBytes = bytes;
      history.push({ scale, quality, r: compressRatioOf(scale, quality), bytes: bytes.length });

      // 邊際效益檢查(第 2 次以後):再縮也省不了多少 → 直接給用戶最小版本
      if (history.length >= 2) {
        const prev = history[history.length - 2];
        const curr = history[history.length - 1];
        const marginal = (prev.bytes - curr.bytes) / prev.bytes;
        if (marginal < 0.03 && curr.bytes > targetBytes * 1.05) {
          log(`\n⚠ 已經壓到這個模式的極限(${fmtMB(smallestBytes.length)},未達目標 ${fmtMB(targetBytes)})`);
          log(`  文字、字體、向量圖本身就佔這麼多空間,無法再壓`);
          log(`  → 想更小請改「轉圖片」模式(缺點:文字不能再複製)`);
          log(`✓ 仍輸出最小版本給你`);
          return smallestBytes;
        }
      }

      // 找 r 差異最大、bytes 差異有意義的兩點估 C, J
      let est = null;
      for (let i = 0; i < history.length; i++) {
        for (let j = i + 1; j < history.length; j++) {
          const a = history[i], b = history[j];
          const dr = Math.abs(a.r - b.r);
          const db = Math.abs(a.bytes - b.bytes);
          if (dr < 0.05 || db < 300 * 1024) continue;
          const J = (a.bytes - b.bytes) / (a.r - b.r);
          const C = b.bytes - J * b.r;
          if (J <= 0 || C <= 0) continue;
          if (!est || dr > est.dr) est = { J, C, dr };
        }
      }

      if (est) {
        log(`  估算:文字字體向量 ≈ ${fmtMB(est.C)}、可壓縮圖 ≈ ${fmtMB(est.J)}`);
        if (est.C >= targetBytes * 0.95) {
          // 文字 / 字體 / 向量本身就超目標 → 此模式絕對不可能達標,直接給最小版本
          log(`\n⚠ 文字、字體、向量圖本身就佔 ${fmtMB(est.C)},超過目標 ${fmtMB(targetBytes)}`);
          log(`  「文字可複製」模式無論怎麼壓圖都下不去,已壓到極限 ${fmtMB(smallestBytes.length)}`);
          log(`  → 想真正達到 ${fmtMB(targetBytes)} 請改「轉圖片」模式(缺點:文字不能再複製)`);
          log(`✓ 仍輸出最小版本給你`);
          return smallestBytes;
        }
        const curr = history[history.length - 1];
        const rTarget = (targetBytes * 0.93 - est.C) / est.J;
        if (rTarget > 0 && rTarget < curr.r) {
          const factor = Math.pow(rTarget / curr.r, 1 / 3.5);
          scale = Math.max(0.18, Math.min(1.0, curr.scale * factor));
          quality = Math.max(0.22, Math.min(0.95, curr.quality * factor));
          continue;
        }
      }

      // fallback:估不出來時用舊公式
      [scale, quality] = refineParams(scale, quality, bytes.length, targetBytes);
    }
    log(`\n⚠ 試 ${MAX_TRIES} 次仍達不到 ${fmtMB(targetBytes)},已壓到極限 ${fmtMB(smallestBytes.length)}`);
    log(`  → 想更小請改「轉圖片」模式(缺點:文字不能再複製)`);
    log(`✓ 仍輸出最小版本給你`);
    return smallestBytes;
  }

  // ===== shrinkViewPreserve (index.html L3496-3630) =====
  async function shrinkViewPreserve(file, maxPx, label, codec, quality = 0.85, qLabel = '標準') {
    log(`模式:保留文字 · 裝置:${label} · 畫質:${qLabel}`);
    log(`目標像素上限:${maxPx}px(最長邊)· 畫質 ${Math.round(quality * 100)}%`);
    const origBuf = await file.arrayBuffer();
    const pdfDoc = await PDFLib.PDFDocument.load(origBuf, { updateMetadata: false });
    startRace();
    // Phase 0-6%: dedup
    setProgressPhase(0, 6);
    const dup = await dedupImages(pdfDoc);
    if (dup.count > 0) log(`影像去重:合併 ${dup.count} 個重複,省 ${fmtMB(dup.saved)}`);
    stripMetadata(pdfDoc);
    const items = await collectImageStreams(pdfDoc);
    log(`可處理影像:${items.length} 張(JPEG + 含透明圖)`);
    if (items.length === 0) {
      throw new Error('這個 PDF 裡沒有可壓縮的圖片(可能是純文字 PDF)。請改用「整頁轉圖片」模式。');
    }

    // SMask 降解析度(grayscale alpha 降邊長 → bytes 變平方比例減少)
    setProgressPhase(6, 6);
    const smaskScale = quality < 0.5 ? 0.45 : quality < 0.75 ? 0.6 : 0.75;
    const sm = await downscaleSMasks(pdfDoc, smaskScale, (i, t) => {
      setProgress((i / t) * 100);
    });
    if (sm.count > 0) log(`遮色片瘦身(×${smaskScale}):${sm.count} 個,省 ${fmtMB(sm.saved)}`);

    // 智慧分配:依像素數排名,大圖品質加權、小圖降權
    const itemDims = items.map((it, idx) => {
      const w = it.dict.get(PDFLib.PDFName.of('Width'))?.asNumber?.() || 0;
      const h = it.dict.get(PDFLib.PDFName.of('Height'))?.asNumber?.() || 0;
      return { idx, pixels: w * h, w, h };
    });
    const ranked = itemDims.slice().sort((a, b) => b.pixels - a.pixels);
    const rankByIdx = new Map();
    for (let r = 0; r < ranked.length; r++) {
      rankByIdx.set(ranked[r].idx, ranked.length === 1 ? 0 : r / (ranked.length - 1));
    }
    // 頁面 aspect ratio — 偵測跨頁背景圖
    const pages = pdfDoc.getPages();
    const pageARs = pages.map(p => {
      const w = p.getWidth(), h = p.getHeight();
      return h > 0 ? w / h : 1;
    });
    const isPageBgLike = (w, h, rank) => {
      if (rank > 0.1) return false;
      if (h <= 0) return false;
      const imgAR = w / h;
      return pageARs.some(par => Math.abs(par - imgAR) / par < 0.15);
    };
    // Top 3 biggest images → multi-probe(兩個品質,挑提升明顯不爆 size 的)
    const topBigIdx = new Set(ranked.slice(0, Math.min(3, ranked.length)).map(x => x.idx));
    if (ranked.length > 1) {
      const big = ranked[0], small = ranked[ranked.length - 1];
      const bigQ = Math.max(0.5, Math.min(0.98, quality * 1.18));
      const smallQ = Math.max(0.5, Math.min(0.98, quality * 0.88));
      log(`智慧分配:大圖 ${big.w}×${big.h} 畫質 ${Math.round(bigQ * 100)}% → 小圖 ${small.w}×${small.h} 畫質 ${Math.round(smallQ * 100)}%`);
      log(`最大的 ${topBigIdx.size} 張會試更清晰版本,划算才升級`);
    }

    let downscaled = 0, reencoded = 0, unchanged = 0;
    let bgImageCount = 0, plateImageCount = 0, probeUpgradeCount = 0;
    const codecWins = new Map();
    log('');
    // Phase 12-85%: 主迴圈
    setProgressPhase(12, 73);
    for (let i = 0; i < items.length; i++) {
      if (i % 5 === 0) checkCancelled();
      const { ref, obj, dict, filterType, hasMask } = items[i];
      const widthObj = dict.get(PDFLib.PDFName.of('Width'));
      const heightObj = dict.get(PDFLib.PDFName.of('Height'));
      const origW = widthObj && widthObj.asNumber ? widthObj.asNumber() : 0;
      const origH = heightObj && heightObj.asNumber ? heightObj.asNumber() : 0;
      if (origW === 0 || origH === 0) { unchanged++; }
      else {
        const longest = Math.max(origW, origH);
        const shortDim = Math.min(origW, origH);
        const totalPixels = origW * origH;
        let scale = Math.min(1.0, maxPx / longest);
        // 小圖保護:< 300 短邊 / < 90000 像素 → 不縮、不降權
        const isSmallImage = shortDim < 300 || totalPixels < 90000;
        if (isSmallImage) scale = 1.0;
        const rank = rankByIdx.get(i) ?? 0.5;
        const boost = isSmallImage ? 1.0 : (1.18 - rank * 0.30);
        const bgPenalty = (!isSmallImage && isPageBgLike(origW, origH, rank)) ? 0.9 : 1.0;
        if (bgPenalty < 1) bgImageCount++;
        const qFloor = isSmallImage ? 0.78 : 0.5;
        const perQuality = Math.max(qFloor, Math.min(0.98, quality * boost * bgPenalty));
        let result = await recompressImage(obj.contents, scale, perQuality, codec, filterType, dict, pdfDoc.context, !!hasMask);
        // Multi-probe:top 3 最大圖再試一個更高品質,如果 size 沒爆 >1.4x 就升級
        if (result && topBigIdx.has(i)) {
          const probeQuality = Math.max(0.5, Math.min(0.98, perQuality * 1.18));
          if (probeQuality > perQuality + 0.02) {
            const probeRes = await recompressImage(obj.contents, scale, probeQuality, codec, filterType, dict, pdfDoc.context, !!hasMask);
            if (probeRes && probeRes.bytes.length <= result.bytes.length * 1.4 && probeRes.bytes.length < obj.contents.length) {
              result = probeRes;
              probeUpgradeCount++;
            }
          }
        }
        if (result && result.bytes.length < obj.contents.length) {
          applyImageReplacement(pdfDoc, ref, dict, origW, origH, scale, result);
          if (scale < 1.0) downscaled++; else reencoded++;
          const lbl = result.label || 'unknown';
          codecWins.set(lbl, (codecWins.get(lbl) || 0) + 1);
          if (result.plateLike) plateImageCount++;
        } else {
          unchanged++;
        }
      }
      setProgress(((i + 1) / items.length) * 100);
      if ((i + 1) % 20 === 0 || i === items.length - 1) {
        const lines = $log.textContent.split('\n');
        lines[lines.length - 1] = `  處理影像 ${i + 1}/${items.length}(縮尺寸 ${downscaled}、只重壓 ${reencoded}、不動 ${unchanged})`;
        $log.textContent = lines.join('\n');
        $log.scrollTop = $log.scrollHeight;
      }
    }
    if (codecWins.size > 0) {
      const codecStats = Array.from(codecWins.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}(${v})`).join(', ');
      log(`壓縮引擎使用次數:${codecStats}`);
    }
    if (bgImageCount > 0) log(`偵測到背景底圖 ${bgImageCount} 張,額外壓一點`);
    if (plateImageCount > 0) log(`偵測到大色塊圖 ${plateImageCount} 張,額外壓一點`);
    if (probeUpgradeCount > 0) log(`${probeUpgradeCount} 張大圖找到更清晰的版本`);
    // save() 是 CPU-bound,用 CSS transition 讓動物在 compositor 繼續爬
    log('正在輸出 PDF(大檔可能要幾十秒)...');
    creepToFinish();
    await waitForCompositorCommit();
    await yieldToMain();
    const bytes = await pdfDoc.save({ useObjectStreams: true });
    await yieldToMain();
    log(`\n✓ 輸出 ${fmtMB(bytes.length)}`);
    return bytes;
  }

  // ===== shrinkViewRaster (index.html L3632-3658) =====
  async function shrinkViewRaster(file, maxPx, label, codec, quality = 0.85, qLabel = '標準') {
    log(`模式:整頁轉圖片 · 裝置:${label} · 畫質:${qLabel}`);
    log(`每頁最長邊上限:${maxPx}px,quality=${quality}`);
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    log(`頁數:${doc.numPages}`);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));

    let maxDim = 0;
    for (const p of pages) {
      const vp = p.getViewport({ scale: 1 });
      maxDim = Math.max(maxDim, vp.width, vp.height);
    }
    const scale = Math.min(4.0, maxPx / maxDim);
    log(`\n頁面最長邊 ${Math.round(maxDim)}pt → render scale=${scale.toFixed(2)}(canvas 最長邊 ≈ ${Math.round(maxDim * scale)}px)`);

    startRace();
    const bytes = await buildPdf(pages, scale, quality, (n, total) => {
      const lines = $log.textContent.split('\n');
      lines[lines.length - 1] = `  渲染 ${n}/${total}`;
      $log.textContent = lines.join('\n');
      $log.scrollTop = $log.scrollHeight;
    }, codec);
    log(`\n✓ 輸出 ${fmtMB(bytes.length)}`);
    return bytes;
  }

  // ===== shrinkAuto (index.html L3661-3750) =====
  async function shrinkAuto(file, mode, codec) {
    if (mode === 'raster') {
      log(`模式:整頁轉圖片 · 自動最佳化(壓一次)`);
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      log(`頁數:${doc.numPages}`);
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));
      let maxDim = 0;
      for (const p of pages) {
        const vp = p.getViewport({ scale: 1 });
        maxDim = Math.max(maxDim, vp.width, vp.height);
      }
      // 1080p 為基準 + 高品質,單次跑完
      const MAX_PX = 1920;
      const scale = Math.min(2.5, Math.max(1.5, MAX_PX / maxDim));
      const quality = 0.82;
      log(`\n渲染倍率 ${scale.toFixed(2)}× · 畫質 ${Math.round(quality * 100)}%`);
      startRace();
      const bytes = await buildPdf(pages, scale, quality, (n, total) => {
        const lines = $log.textContent.split('\n');
        lines[lines.length - 1] = `  渲染 ${n}/${total}`;
        $log.textContent = lines.join('\n');
        $log.scrollTop = $log.scrollHeight;
      }, codec);
      // 保險:auto 模式如果壓出來反而比較大,退回原檔
      if (bytes.length >= file.size) {
        log(`\n⚠ 壓縮後反而較大,自動退回原檔`);
        return new Uint8Array(await file.arrayBuffer());
      }
      log(`\n✓ 輸出 ${fmtMB(bytes.length)}`);
      return bytes;
    }
    // preserve 模式:預處理 + 雙版本探測 + 智慧拼合(per-image 挑最佳)
    // 單次壓縮等於放棄智慧分配,所以至少跑兩個 setpoint(高 / 低畫質)再合
    log(`模式:保留文字 · 自動最佳化(雙版本探測 + 智慧拼合)`);
    const origBuf = await file.arrayBuffer();
    log(`讀取 PDF ...`);
    // SMask 內聯到 prepareDocumentBytes,省一次 PDF load + save(大檔節省 30-60s)
    setProgressPhase(0, 28);
    const prepBytes = await prepareDocumentBytes(origBuf, log, { smaskScale: 0.65 });

    const setpoints = [
      { scale: 1.0, quality: 0.85, label: 'H' },  // 高畫質:1:1 解析度 + 85%
      { scale: 0.7, quality: 0.62, label: 'L' },  // 低畫質:縮 70% + 62%
    ];

    setProgressPhase(28, 57);
    log(`\n[一次 decode、雙版本同時編碼]`);
    startRace();
    const multi = await buildPreservePdfMultiProbe(prepBytes, setpoints, codec, true, true);
    // 重組成原本 probeResults 的格式(讓後續 knapsack 邏輯不變)
    const probeResults = setpoints.map((_, i) => ({
      items: multi.items,
      candidates: multi.candidates[i],
      itemDims: multi.itemDims,
      rankByIdx: multi.rankByIdx,
      isPageBgLike: multi.isPageBgLike,
      smaskScale: multi.smaskScale,
    }));

    // 每張圖 per-image 規則:LOW 體積 ≤ HIGH × 0.6 才換 LOW(明顯省才割捨畫質),
    // 否則保 HIGH(差不多大就保畫質)
    const items = probeResults[0].items;
    const choices = new Array(items.length).fill(0); // 預設 HIGH
    let usedHigh = 0, usedLow = 0, usedOrig = 0;
    for (let i = 0; i < items.length; i++) {
      const high = probeResults[0].candidates[i];
      const low = probeResults[1].candidates[i];
      if (!high && !low) { choices[i] = -1; usedOrig++; continue; }
      if (!high) { choices[i] = 1; usedLow++; continue; }
      if (!low) { choices[i] = 0; usedHigh++; continue; }
      if (low.bytes.length <= high.bytes.length * 0.6) {
        choices[i] = 1; usedLow++;
      } else {
        choices[i] = 0; usedHigh++;
      }
    }
    log(`\n[智慧拼合] 保畫質 ${usedHigh} 張、改用低畫質 ${usedLow} 張${usedOrig > 0 ? ` · 維持原圖 ${usedOrig} 張` : ''}`);

    setProgressPhase(85, 15);
    startRace();
    const finalBytes = await assembleFinalPdf(prepBytes, setpoints, probeResults, choices, true, true);
    if (finalBytes.length >= file.size) {
      log(`\n⚠ 壓縮後反而較大,自動退回原檔`);
      return new Uint8Array(origBuf);
    }
    log(`\n✓ 輸出 ${fmtMB(finalBytes.length)}`);
    return finalBytes;
  }

// ============================================================================
// Phase 2.4 stubs — UI 訊息回 main thread
// ============================================================================
let _workerCancelled = false;
function checkCancelled() {
  if (_workerCancelled) throw new Error('使用者取消');
}
let _progressBase = 0, _progressRange = 100;
function setProgressPhase(base, range, _ceil) {
  _progressBase = base || 0;
  _progressRange = range || 100;
}
let _lastProgressMsg = -1;
function setProgress(localPct) {
  const lp = Math.max(0, Math.min(100, localPct));
  const finalPct = _progressBase + lp * _progressRange / 100;
  const rounded = Math.round(finalPct);
  if (rounded !== _lastProgressMsg) {
    _lastProgressMsg = rounded;
    self.postMessage({ type: 'progress', pct: finalPct });
  }
}
let _logBuffer = '';
let _logFlushPending = false;
function _scheduleLogFlush() {
  if (_logFlushPending) return;
  _logFlushPending = true;
  Promise.resolve().then(() => {
    _logFlushPending = false;
    self.postMessage({ type: 'log-replace', text: _logBuffer });
  });
}
const $log = {
  get textContent() { return _logBuffer; },
  set textContent(v) { _logBuffer = String(v); _scheduleLogFlush(); },
  scrollTop: 0,
  scrollHeight: 0,
};
function log(msg) {
  if (_logBuffer && !_logBuffer.endsWith('\n')) _logBuffer += '\n';
  _logBuffer += String(msg) + '\n';
  _scheduleLogFlush();
}
function updateLogLine(prefix) {
  const idx = _logBuffer.lastIndexOf('\n', _logBuffer.length - 2);
  _logBuffer = (idx >= 0 ? _logBuffer.slice(0, idx + 1) : '') + String(prefix) + '\n';
  _scheduleLogFlush();
}
function clearLog() { _logBuffer = ''; _scheduleLogFlush(); }
function startRace() {}
function stopHeartbeat() {}
function declareWinner() {}
function creepToFinish() {}
function waitForCompositorCommit() { return Promise.resolve(); }


// ============================================================================
// Phase 2.3 entry — 收 'compress' message → 跑全流程 → 回 bytes
// ============================================================================
async function runCompress(file, options = {}) {
  const fileLike = {
    name: options.fileName || 'input.pdf',
    size: file.byteLength,
    type: 'application/pdf',
    arrayBuffer: async () => file,
  };
  const codec = 'smart';
  const mode = options.mode || 'preserve';
  if (options.useTargetSize && options.targetMB) {
    const targetBytes = options.targetMB * 1024 * 1024;
    return mode === 'preserve'
      ? await shrinkPreserve(fileLike, targetBytes, codec)
      : await shrinkRaster(fileLike, targetBytes, codec);
  }
  return await shrinkAuto(fileLike, mode, codec);
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
        _workerCancelled = false;
        const { file, options } = msg;
        const bytes = await runCompress(file, options || {});
        const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        self.postMessage({ type: 'done', bytes: out }, [out.buffer]);
        break;
      }
      case 'cancel': {
        _workerCancelled = true;
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
