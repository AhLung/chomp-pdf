// ChompPDF codec loader — exposes MozJPEG encoder + OxiPNG optimizer to window.JsCodecs
// Loaded as <script type="module"> before main IIFE. Main script awaits window.JsCodecsReady promise.
import mozjpegEncodeFactory from './jpeg/codec/enc/mozjpeg_enc.js';
import { initEmscriptenModule } from './jpeg/utils.js';
import { defaultOptions as jpegDefaults } from './jpeg/meta.js';

let mozjpegModule = null;

async function ensureMozJpeg() {
  if (!mozjpegModule) {
    mozjpegModule = await initEmscriptenModule(mozjpegEncodeFactory, undefined, {
      locateFile: (path) => new URL('./jpeg/codec/enc/' + path, import.meta.url).href,
    });
  }
  return mozjpegModule;
}

// imageData = { data: Uint8ClampedArray (RGBA), width, height }
// quality 0-1
async function encodeMozJpeg(imageData, quality) {
  const m = await ensureMozJpeg();
  const opts = { ...jpegDefaults, quality: Math.round(Math.max(1, Math.min(100, quality * 100))) };
  const result = m.encode(imageData.data, imageData.width, imageData.height, opts);
  return new Uint8Array(result);
}

// OxiPNG —單執行緒 path,避免 wasm-feature-detect 依賴
import oxiInit from './oxipng/codec/pkg/squoosh_oxipng.js';
let oxiReady = null;

async function ensureOxi() {
  if (!oxiReady) {
    const wasmUrl = new URL('./oxipng/codec/pkg/squoosh_oxipng_bg.wasm', import.meta.url).href;
    oxiReady = oxiInit(wasmUrl);
  }
  await oxiReady;
}

// pngBytes Uint8Array;level 1-6(6 = 最大壓縮但慢)
async function optimisePng(pngBytes, level = 4) {
  await ensureOxi();
  const mod = await import('./oxipng/codec/pkg/squoosh_oxipng.js');
  return new Uint8Array(mod.optimise(pngBytes, level, false));
}

window.JsCodecs = { encodeMozJpeg, optimisePng };
window.JsCodecsReady = Promise.resolve('ready');
console.log('[ChompPDF] JsCodecs ready: MozJPEG + OxiPNG');
