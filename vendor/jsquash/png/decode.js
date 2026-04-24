/**
 * Copyright 2020 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import initPngModule, { decode as pngDecodeWasm, decode_rgba16 as pngDecodeRgba16Wasm, } from './codec/pkg/squoosh_png.js';
let pngModule;
export async function init(moduleOrPath) {
    if (!pngModule) {
        pngModule = initPngModule(moduleOrPath);
    }
    return pngModule;
}
export async function decode(data, options = {}) {
    await init();
    const { bitDepth = 8 } = options;
    if (bitDepth === 16) {
        const imageData = await pngDecodeRgba16Wasm(new Uint8Array(data));
        if (!imageData)
            throw new Error('Encoding error.');
        return imageData;
    }
    const imageData = await pngDecodeWasm(new Uint8Array(data));
    if (!imageData)
        throw new Error('Encoding error.');
    return imageData;
}
export default decode;
