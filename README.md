# 🦖 ChompPDF 🦈

> 把 PDF 變小的小工具。檔案不離開你的電腦，安心用。

## 馬上用

**線上版**（點開就能用）：[https://ahlung.github.io/chomp-pdf](https://ahlung.github.io/chomp-pdf)

或者下載整個資料夾，雙擊裡面的 `index.html`，在瀏覽器打開就好 —— 不用安裝、不用帳號、不用網路。

## 適合什麼情況

- Gmail / LINE 說「檔案太大」寄不出去
- 履歷 / 提案 / 報告要上傳系統但卡大小限制
- 手機存一堆 PDF 想瘦身
- 掃描文件、相片 PDF 動輒幾十 MB 想壓小

## 怎麼壓

1. 把 PDF 拖進網頁（或點一下選檔）
2. 工具會自動幫你算出「建議縮到多少 MB」
3. 按一下**壓縮**，等一下就好
4. 下載結果

想自己設定大小、或整頁變圖片讓檔案更小，也可以調整。

## 為什麼可以「離線用」

整個工具就是一個 HTML 檔，所有壓縮功能（JPEG / PNG 引擎）都包在裡面。打開後完全在你瀏覽器跑，**檔案不會上傳到任何地方**。

## 更新記錄

### v1.3.1（2026-04-30）
- 關閉 JPEG 2000 編碼（這次有證據）：sub-agent 用 opj_dump 拆檔證實 OpenJPEG WASM 對含 SMask 的彩色照片會輸出量化參數壞掉的 raw J2K，解碼後色彩通道幾乎抹除 — Page 9 台灣地圖渲染破碎的真正原因
- 探測加速：auto 模式把遮色片瘦身搬到 probe 外面跑一次（兩個 probe + 拼合共用），省 1/3 時間；搭配少一個 codec 整體探測快 40-50%

### v1.3.0（2026-04-30）
- 修正 macOS Preview 圖片消失的真正原因 — pdf-lib minify 後 class 名被縮寫，SMask 偵測失效讓 SMask 被當主圖重壓成 RGB JPEG，違反 PDF 規範
- 重新啟用 JPEG 2000 編碼（上一版錯誤關掉了，事實上跟相容性問題無關）
- 「自動最佳化」改成跑兩次（高畫質 / 低畫質）+ per-image 拼合 — 之前單次壓等於放棄智慧分配

### v1.2.0（2026-04-30）
- 新增「自動最佳化」模式 — 不勾「限制檔案大小」就自動找畫質與大小的平衡點
- 小圖保護：短邊 < 300px 的圖不再縮，避免馬賽克
- 修正 macOS Preview 開啟壓縮後 PDF 部分圖片消失的問題（關閉 JPEG 2000 輸出）
- 主畫面文字全面去技術術語
- 緩解大檔壓縮時瀏覽器「未回應」
- 「依裝置挑畫質」選項暫時隱藏

### v1.1.0（2026-04-29）
- 觀看解析度模式補齊智慧分配：SMask 瘦身、大圖品質加權、Top 3 大圖多版本探測

### v1.0.0（2026-04-24）
- 首次上線
- 智慧拼合（多版本探測 + Knapsack）、注視點壓縮、影像去重、SMask 瘦身
- WASM 內嵌 base64，雙擊 index.html 即可離線使用

## 授權與來源

- 壓縮引擎：[MozJPEG](https://github.com/mozilla/mozjpeg)、[OxiPNG](https://github.com/shssoichiro/oxipng)（Apache-2.0）
- PDF 處理：[pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0）、[pdf-lib](https://github.com/Hopding/pdf-lib)（MIT）

作者：[AhLung](https://portaly.cc/AhLung)
