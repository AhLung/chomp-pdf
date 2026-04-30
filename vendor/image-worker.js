/* ChompPDF image-worker — Phase 3
 * 輕量 worker:只做圖的 decode + plate/text 偵測 + 多 setpoint encode。
 * 不載 pdf-lib(省 4-5MB heap),只載 codecs-bundle + openjpegwasm + pako。
 *
 * Orchestrator(compress-worker.js)派任務進來,每個 task = 一張 DCTDecode 圖
 * 的 N 個 setpoint encode。Flate 圖留給 orchestrator inline 處理(dict 解析
 * 需要 pdf-lib)。
 *
 * 訊息協議:
 *  in  { type:'probe', payload:{ idx, origBytes, filterType, hasMask,
 *        shortDim, isSmallImage, boost, bgPenalty, setpoints:[{scale,quality}], codec } }
 *  out { type:'probeDone', result:{ idx, candidates:[..|null], isPlate, isText } }
 *      { type:'probeError', idx, msg }
 *  ping/pong + 起始 ready 訊息
 */

(function() {
  // Cache-busting:跟 orchestrator 同 version,從 self.location 抓
  const _q = self.location.search; // e.g. "?v=v150h5"
  function qv(p) { return p + _q; }

  // Emscripten 的 mozjpeg_enc.js 在 worker 環境會 window.X = Y
  // 主執行緒已存在 window;worker 沒,要 alias 上去
  if (typeof window === 'undefined') self.window = self;

  let _depError = null;
  try {
    importScripts(
      qv('pako.min.js'),
      qv('openjpegwasm.js'),
      qv('jsquash/codecs-bundle.js')
    );
  } catch (e) {
    _depError = e.message || String(e);
  }

  // ===== Helpers (從 compress-worker.js 對等抽出,純圖處理,無 pdf-lib) =====

  function _newCanvas(w = 1, h = 1) {
    return new OffscreenCanvas(w, h);
  }

  function canvasToImageData(canvas) {
    const c = canvas.getContext('2d', { willReadFrequently: true });
    return c.getImageData(0, 0, canvas.width, canvas.height);
  }

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

  function encodeRgbPng(imgData) {
    if (typeof pako === 'undefined') return null;
    const { data, width, height } = imgData;
    const rowStride = width * 3 + 1;
    const raw = new Uint8Array(rowStride * height);
    for (let y = 0; y < height; y++) {
      raw[y * rowStride] = 0;
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
    ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
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

  function extractPngIDAT(pngBytes) {
    if (!pngBytes || pngBytes.length < 16) return null;
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
      off = dataOff + len + 4;
    }
    if (!width || !height || !idatChunks.length) return null;
    let colors, colorspace;
    if (colorType === 2) { colors = 3; colorspace = 'DeviceRGB'; }
    else if (colorType === 0) { colors = 1; colorspace = 'DeviceGray'; }
    else return null;
    const total = idatChunks.reduce((a, c) => a + c.length, 0);
    const idat = new Uint8Array(total);
    let p = 0;
    for (const c of idatChunks) { idat.set(c, p); p += c.length; }
    return { idat, width, height, bitDepth, colors, colorspace };
  }

  function isPlateImage(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w * h === 0) return false;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
    const sizeFactor = (w * h < 500 * 500) ? 800 : 450;
    return Math.max(vR, vG, vB) < sizeFactor;
  }

  function isTextImage(canvas) {
    const w = canvas.width, h = canvas.height;
    if (w * h < 60000) return false;
    if (w < 200 || h < 80) return false;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, w, h).data;
    const BS = 16;
    const blocksX = Math.floor(w / BS);
    const blocksY = Math.floor(h / BS);
    if (blocksX < 8 || blocksY < 4) return false;
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

  // ===== JPX encoder =====
  let _jpxModule = null;
  async function getJpxModule() {
    if (_jpxModule) return _jpxModule;
    if (typeof OpenJPEGWASM !== 'function') throw new Error('openjpegwasm not loaded');
    _jpxModule = await OpenJPEGWASM({
      locateFile: (f) => f.endsWith('.wasm') ? qv('openjpegwasm.wasm') : f
    });
    return _jpxModule;
  }

  async function encodeCanvasToJpx(canvas, compressionRatio) {
    const mod = await getJpxModule();
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, w, h);
    const encoder = new mod.J2KEncoder();
    const buf = encoder.getDecodedBuffer({ width: w, height: h, bitsPerSample: 8, componentCount: 3, isSigned: false });
    const plane = w * h;
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

  // ===== encodeCanvas (race JPX / MozJPEG / OxiPNG) =====
  async function encodeCanvas(canvas, quality, codec) {
    const W = canvas.width, H = canvas.height;
    const isSmall = (W * H <= 240 * 240);
    let imgData = null;
    const getImgData = () => imgData || (imgData = canvasToImageData(canvas));
    const results = [];

    if (!isSmall && quality >= 0.55) {
      try {
        const ratio = Math.max(5, Math.min(80, 12 / Math.max(0.1, quality)));
        const bytes = await encodeCanvasToJpx(canvas, ratio);
        if (bytes && bytes.length > 200) {
          results.push({ bytes, filter: 'JPXDecode', label: 'jp2' });
        }
      } catch (_) {}
    }

    if (self.JsCodecs && self.JsCodecs.encodeMozJpeg) {
      try {
        const bytes = await self.JsCodecs.encodeMozJpeg(getImgData(), quality);
        results.push({ bytes, filter: 'DCTDecode', label: 'mozjpeg' });
      } catch (e) { /* swallow */ }
    } else {
      try {
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        results.push({ bytes: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode', label: 'canvas-jpg' });
      } catch (_) {}
    }

    if (isSmall && self.JsCodecs && self.JsCodecs.optimisePng) {
      try {
        const pngRaw = encodeRgbPng(getImgData());
        if (pngRaw) {
          const oxiLevel = quality >= 0.8 ? 3 : 6;
          const optimized = await self.JsCodecs.optimisePng(pngRaw, oxiLevel);
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

  // ===== Probe runner =====
  async function runProbe(p) {
    const { idx, origBytes, filterType, hasMask, shortDim, isSmallImage,
            boost, bgPenalty, setpoints, codec } = p;

    // 只處理 DCTDecode;Flate 留給 orchestrator inline(需 pdf-lib 解 dict)
    if (filterType !== 'DCTDecode') {
      return { idx, skipReason: 'flate', candidates: null, isPlate: false, isText: false };
    }

    // 解碼 + drawImage 到 canvas(後續 plate/text 偵測 + 縮放都要 canvas)
    const blob = new Blob([origBytes], { type: 'image/jpeg' });
    const img = await createImageBitmap(blob).catch(() => null);
    if (!img) return { idx, skipReason: 'decodeFail', candidates: null, isPlate: false, isText: false };

    const fcW = img.width, fcH = img.height;
    const fullCanvas = _newCanvas(fcW, fcH);
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });
    fullCtx.fillStyle = 'white';
    fullCtx.fillRect(0, 0, fcW, fcH);
    fullCtx.drawImage(img, 0, 0);
    if (img.close) img.close();

    // plate / text 偵測一次,所有 setpoint 共用
    let isPlate = false, isText = false;
    if (fcW >= 300 && fcH >= 300) isPlate = isPlateImage(fullCanvas);
    if (!isPlate && fcW * fcH >= 60000 && fcW >= 200 && fcH >= 80) isText = isTextImage(fullCanvas);

    const candidates = new Array(setpoints.length).fill(null);
    for (let s = 0; s < setpoints.length; s++) {
      const sp = setpoints[s];
      // 完整 smart-allocation 計算(對齊 compress-worker.js L2080-2099)
      let perScale = Math.max(0.2, Math.min(1.0, sp.scale * boost * bgPenalty));
      if (isSmallImage) perScale = 1.0;
      else if (shortDim * perScale < 200 && shortDim >= 200) perScale = 200 / shortDim;
      const qFloor = isSmallImage ? 0.75 : 0.3;
      let perQuality = Math.max(qFloor, Math.min(0.95, sp.quality * boost * bgPenalty));

      if (isText) {
        perScale = 1.0;
        perQuality = Math.max(0.92, perQuality);
      } else if (isPlate && hasMask) {
        perScale = Math.max(0.25, perScale * 0.6);
        perQuality = Math.max(0.3, perQuality * 0.7);
      } else if (isPlate) {
        perQuality = Math.max(0.3, perQuality * 0.7);
      } else if (hasMask) {
        perScale = Math.max(0.5, perScale);
        perQuality = Math.max(0.85, perQuality * 1.3);
      }

      const newW = Math.max(1, Math.floor(fcW * perScale));
      const newH = Math.max(1, Math.floor(fcH * perScale));
      let scaled;
      if (newW === fcW && newH === fcH) {
        scaled = fullCanvas;
      } else {
        scaled = _newCanvas(newW, newH);
        scaled.getContext('2d', { willReadFrequently: true }).drawImage(fullCanvas, 0, 0, newW, newH);
      }
      const enc = await encodeCanvas(scaled, perQuality, codec);
      if (scaled !== fullCanvas) { scaled.width = scaled.height = 0; }

      if (enc && enc.bytes && enc.bytes.length < origBytes.length) {
        candidates[s] = { ...enc, perScale, origLen: origBytes.length };
      }
    }

    fullCanvas.width = fullCanvas.height = 0;
    return { idx, candidates, isPlate, isText };
  }

  // ===== Message handler =====
  self.addEventListener('message', async (e) => {
    const m = e.data;
    if (m.type === 'ping') {
      self.postMessage({ type: 'pong' });
      return;
    }
    if (m.type === 'warmup') {
      // v1.5.2:預熱 openjpegwasm,避免第一張 probe 卡 WASM 編譯
      // 也順便初始化 MozJPEG / OxiPNG(JsCodecs 兩個 codec 各自 lazy)
      try { await getJpxModule(); } catch (_) {}
      try {
        if (self.JsCodecs?.encodeMozJpeg) {
          // 給一張 1×1 dummy ImageData 觸發 MozJPEG WASM init
          const dummy = new ImageData(new Uint8ClampedArray([0,0,0,255]), 1, 1);
          await self.JsCodecs.encodeMozJpeg(dummy, 0.8);
        }
      } catch (_) {}
      self.postMessage({ type: 'warmedUp' });
      return;
    }
    if (m.type === 'probe') {
      try {
        const result = await runProbe(m.payload);
        const transfers = [];
        if (result.candidates) {
          for (const c of result.candidates) {
            if (c && c.bytes && c.bytes.buffer) transfers.push(c.bytes.buffer);
          }
        }
        self.postMessage({ type: 'probeDone', result }, transfers);
      } catch (err) {
        self.postMessage({ type: 'probeError', idx: m.payload?.idx, msg: err.message || String(err) });
      }
    }
  });

  // 起始 ready 廣播(orchestrator 等這個確認 dep 都載齊)
  self.postMessage({
    type: 'ready',
    error: _depError,
    deps: {
      pako: typeof self.pako === 'object' && typeof self.pako.deflate === 'function',
      OpenJPEGWASM: typeof self.OpenJPEGWASM === 'function',
      JsCodecs: typeof self.JsCodecs === 'object'
        && typeof self.JsCodecs.encodeMozJpeg === 'function'
        && typeof self.JsCodecs.optimisePng === 'function',
      OffscreenCanvas: typeof self.OffscreenCanvas === 'function',
      createImageBitmap: typeof self.createImageBitmap === 'function',
    }
  });
})();
