const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
// 提高 payload 限制，因為圖片 base64 可能非常大
app.use(express.json({ limit: '100mb' }));

// ==========================================
// 1. 圖片渲染 API (/render-image)
// ==========================================
app.post('/render-image', async (req, res) => {
  const { html, format, isTransparent, targetId } = req.body;

  let browser;
  try {
    // 產品級 Puppeteer 啟動參數
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    // deviceScaleFactor: 2 保證輸出超高畫質
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const element = await page.$(`#${targetId}`);
    if (!element) throw new Error(`Element #${targetId} not found`);

    const buffer = await element.screenshot({
      type: format === 'jpeg' ? 'jpeg' : 'png',
      omitBackground: isTransparent
    });

    res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('[Render Image Error]:', err);
    res.status(500).send('Render failed');
  } finally {
    if (browser) await browser.close();
  }
});

// ==========================================
// 2. 影片渲染 API (/render-video)
// ==========================================
app.post('/render-video', async (req, res) => {
  const { html, format, isTransparent, targetId } = req.body;
  const reqId = Date.now();
  
  // 建立當次請求專屬的暫存資料夾與輸出路徑，避免併發錯亂
  const framesDir = path.join(__dirname, `frames_${reqId}`);
  const outFile = path.join(__dirname, `output_${reqId}.${format}`);

  let browser;
  try {
    // 安全建立 frames 資料夾
    if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

    // 啟動瀏覽器
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const element = await page.$(`#${targetId}`);
    if (!element) throw new Error(`Element #${targetId} not found`);

    const fps = 60;
    const duration = 2.5;
    const totalFrames = fps * duration;

    // 逐幀透過 Web Animations API 操作時間軸並截圖
    for (let i = 0; i < totalFrames; i++) {
      await page.evaluate((timeMs) => {
        document.getAnimations().forEach(anim => {
          anim.currentTime = timeMs;
        });
      }, i * (1000 / fps));

      const framePath = path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`);
      await element.screenshot({ path: framePath, omitBackground: isTransparent });
    }

    // 關閉瀏覽器釋放記憶體
    await browser.close();
    browser = null;

    // FFmpeg 執行影片合成
    let ffmpegCmd = '';
    if (format === 'mp4') {
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libx264 -pix_fmt yuv420p "${outFile}"`;
    } else { // WebM (支援透明)
      ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p "${outFile}"`;
    }
    execSync(ffmpegCmd);

    // 回傳生成的影片檔給前端
    res.download(outFile, (err) => {
      // 下載完成後徹底清理暫存檔
      try {
        fs.rmSync(framesDir, { recursive: true, force: true });
        if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch(e) { console.error("Cleanup error:", e); }
    });

  } catch (err) {
    console.error('[Render Video Error]:', err);
    res.status(500).send('Render failed');
    // 發生錯誤也必須清理暫存檔
    try {
      if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch(e) {}
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`[BinTools Backend] Server is running on http://localhost:${PORT}`);
});