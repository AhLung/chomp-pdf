# 🦖 ChompPDF 🦈

> 離線 PDF 壓縮工具 — 直接雙擊 `index.html` 即可使用，無需安裝、無需網路。

## 功能

- **智慧壓縮**：MozJPEG + OxiPNG 雙引擎賽馬，自動選最小
- **多版本探測 + Knapsack 拼合**：對每張圖分別算出最佳品質，整體達標又最清晰
- **注視點技術**：背景底圖低品質壓縮，前景主體保留細節
- **完全離線**：WASM 內嵌為 base64，不依賴網路或伺服器
- **兩種模式**：「最小化」求容量極限 / 「保留畫質」在目標 MB 內保留最佳品質

## 使用方式

直接下載後雙擊 `index.html` 在瀏覽器打開即可。

或透過 GitHub Pages 線上使用：[https://ahlung.github.io/chomp-pdf](https://ahlung.github.io/chomp-pdf)

## 授權

- 壓縮核心：[MozJPEG](https://github.com/mozilla/mozjpeg)（Apache-2.0）、[OxiPNG via jSquash](https://github.com/nicolo-ribaudo/squoosh)（Apache-2.0）
- PDF 解析：[pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）、[pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）
