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
