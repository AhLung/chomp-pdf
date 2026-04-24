#!/usr/bin/env node
// 把 mozjpeg_enc.js + squoosh_oxipng.js + 兩個 .wasm 打成 single non-module file
// 用 base64 內嵌 WASM,避開 file:// 的 fetch 限制

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function readWasmBase64(p) {
  return fs.readFileSync(p).toString('base64');
}

// MozJPEG: mozjpeg_enc.js 是 Emscripten 模組,用 import.meta.url + export default
let mozjpegJs = fs.readFileSync(path.join(ROOT, 'jpeg/codec/enc/mozjpeg_enc.js'), 'utf8');
// 先處理寫入 import.meta.url(賦值側),整段拿掉,避免語法錯
mozjpegJs = mozjpegJs.replace(/if\s*\(\s*import\.meta\.url\s*===\s*undefined\s*\)\s*\{[^}]*\}/g, '');
// 再處理讀取 import.meta.url
mozjpegJs = mozjpegJs.replace(/import\.meta\.url/g, "''");
mozjpegJs = mozjpegJs.replace(/export\s+default\s+Module\s*;?/g, '');
mozjpegJs = mozjpegJs.replace(/^var\s+Module\s*=\s*\(/m, 'window.__mozjpegFactory = (');

const mozjpegWasmB64 = readWasmBase64(path.join(ROOT, 'jpeg/codec/enc/mozjpeg_enc.wasm'));

// OxiPNG: squoosh_oxipng.js 是 wasm-pack ESM
let oxiJs = fs.readFileSync(path.join(ROOT, 'oxipng/codec/pkg/squoosh_oxipng.js'), 'utf8');
// 先處理 import.meta.url 賦值(整個 if block 拿掉)
oxiJs = oxiJs.replace(/if\s*\(\s*import\.meta\.url\s*===\s*undefined\s*\)\s*\{[^}]*\}/g, '');
// 再處理讀取 import.meta.url
oxiJs = oxiJs.replace(/import\.meta\.url/g, "''");
// 移除 export 語句(包括 export function ...)
oxiJs = oxiJs.replace(/^export\s+\{\s*initSync\s*\}\s*;?\s*$/gm, '');
oxiJs = oxiJs.replace(/^export\s+default\s+__wbg_init\s*;?\s*$/gm, '');
oxiJs = oxiJs.replace(/^export\s+function\s+/gm, 'function ');
// 包成 IIFE 並導出
oxiJs = `window.__oxipngModule = (function() {
${oxiJs}
return { initSync, init: __wbg_init, optimise: () => optimise, optimise_raw: () => optimise_raw };
})();`;
// 修一下:initSync 後 wasm 變數設定後,optimise 才綁定。要動態取
oxiJs = oxiJs.replace(
  'return { initSync, init: __wbg_init, optimise: () => optimise, optimise_raw: () => optimise_raw };',
  `
  // 動態解析 optimise / optimise_raw(它們是 wasm.exports 的屬性,wasm-bindgen 包裝)
  function callOptimise(...args) {
    if (typeof optimise !== 'function') throw new Error('OxiPNG optimise not bound');
    return optimise(...args);
  }
  return { initSync, init: __wbg_init, optimise: callOptimise };
  `
);

const oxiWasmB64 = readWasmBase64(path.join(ROOT, 'oxipng/codec/pkg/squoosh_oxipng_bg.wasm'));

// 組 bundle
const bundle = `/* ChompPDF codec bundle: MozJPEG (Emscripten) + OxiPNG (wasm-bindgen)
 * 內嵌 WASM 為 base64,避開 file:// 的 fetch 限制
 * Apache-2.0 — Squoosh / jSquash / Mozilla / OxiPNG
 */
(function() {
  // === Base64 decode helper ===
  function b64ToUint8(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  const MOZJPEG_WASM_B64 = "${mozjpegWasmB64}";
  const OXIPNG_WASM_B64 = "${oxiWasmB64}";

  // === MozJPEG factory ===
  ${mozjpegJs}

  // === OxiPNG bindings (IIFE-wrapped) ===
  ${oxiJs}

  // === Initialise both modules + expose window.JsCodecs ===
  let mozModuleP = null;
  let oxiInited = false;

  async function ensureMozJpeg() {
    if (!mozModuleP) {
      const wasmBinary = b64ToUint8(MOZJPEG_WASM_B64);
      mozModuleP = window.__mozjpegFactory({
        wasmBinary,
        noInitialRun: true,
        locateFile: () => '', // 不用,wasmBinary 已提供
      });
    }
    return mozModuleP;
  }

  async function encodeMozJpeg(imageData, quality) {
    const mod = await ensureMozJpeg();
    const opts = {
      quality: Math.round(Math.max(1, Math.min(100, quality * 100))),
      baseline: false,
      arithmetic: false,
      progressive: true,
      optimize_coding: true,
      smoothing: 0,
      color_space: 3,
      quant_table: 3,
      trellis_multipass: false,
      trellis_opt_zero: false,
      trellis_opt_table: false,
      trellis_loops: 1,
      auto_subsample: true,
      chroma_subsample: 2,
      separate_chroma_quality: false,
      chroma_quality: Math.round(Math.max(1, Math.min(100, quality * 100))),
    };
    const result = mod.encode(imageData.data, imageData.width, imageData.height, opts);
    return new Uint8Array(result);
  }

  function ensureOxi() {
    if (!oxiInited) {
      const wasmBytes = b64ToUint8(OXIPNG_WASM_B64);
      window.__oxipngModule.initSync(wasmBytes);
      oxiInited = true;
    }
  }

  async function optimisePng(pngBytes, level) {
    ensureOxi();
    const result = window.__oxipngModule.optimise(pngBytes, level || 4, false);
    return new Uint8Array(result);
  }

  window.JsCodecs = { encodeMozJpeg, optimisePng };
  console.log('[ChompPDF] JsCodecs ready (bundle): MozJPEG + OxiPNG');
})();
`;

fs.writeFileSync(path.join(ROOT, 'codecs-bundle.js'), bundle);
console.log('Wrote codecs-bundle.js (' + (bundle.length / 1024).toFixed(0) + ' KB)');
