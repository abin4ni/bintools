require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
// 提高接收前端 HTML 檔案大小的限制
app.use(express.json({ limit: '200mb' }));

// 【任務 2】確保包含靜態檔案伺服器
app.use(express.static(__dirname));

// ==========================================
// ★ 頁面路由分離 (Landing Page vs App) ★
// ==========================================
// 首頁 (展示與行銷)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 工具頁 (實際應用區)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// ==========================================
// 簡易權限管控 (每日免費 3 次)
// ==========================================
const usersDb = new Map();
function getUserData(uid) {
  const today = new Date().toISOString().split('T')[0];
  if (!usersDb.has(uid)) usersDb.set(uid, { plan: 'free', downloadsToday: 0, lastReset: today });
  const user = usersDb.get(uid);
  if (user.lastReset !== today) { user.downloadsToday = 0; user.lastReset = today; }
  return user;
}

function checkUsageLimit(req, res, next) {
  const uid = req.headers['x-user-uid'] || 'guest_' + req.ip; 
  const user = getUserData(uid);
  if (user.plan === 'free' && user.downloadsToday >= 3) {
    return res.status(403).json({ error: 'LIMIT_REACHED', message: '今日免費下載額度 (3次) 已用盡，請升級 Pro！' });
  }
  req.user = { uid, plan: user.plan };
  next();
}

app.get('/api/user-status', (req, res) => {
  const uid = req.headers['x-user-uid'] || 'guest_' + req.ip;
  res.json(getUserData(uid));
});

// ==========================================
// 後端渲染引擎 API (確保畫質與毛玻璃完美)
// ==========================================

// --- API: 圖片渲染 ---
app.post('/api/render-image', checkUsageLimit, async (req, res) => {
  let { html, format, isTransparent, targetId } = req.body;
  const isPro = req.user.plan === 'pro';

  // 【任務 5】免費版自動加上文字浮水印
  if (!isPro) {
    const watermark = `<div style="position:absolute; bottom:20px; right:30px; font-family:sans-serif; font-size:24px; font-weight:bold; color:rgba(255,255,255,0.7); z-index:9999; text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools Free</div>`;
    html = html.replace('</body>', watermark + '</body>');
  }

  let browser;
  try {
    // 【任務 3】Puppeteer 穩定性優化
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000 
    });
    
    const page = await browser.newPage();
    
    // 【權限控制】Pro: 1080p (scale:2), Free: 720p (scale:1.5)
    const scale = isPro ? 2 : 1.5;
    const width = isPro ? 1920 : 1280;
    const height = isPro ? 1080 : 720;
    
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const element = await page.$(`#${targetId}`);
    if (!element) throw new Error("Target element not found");
    const buffer = await element.screenshot({ type: format === 'jpeg' ? 'jpeg' : 'png', omitBackground: isTransparent });

    // 扣除免費額度
    if (!isPro) getUserData(req.user.uid).downloadsToday += 1;
    
    res.set('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('[Image Render Error]:', err); res.status(500).send('Render failed');
  } finally {
    if (browser) await browser.close();
  }
});

// --- API: 影片渲染 ---
app.post('/api/render-video', checkUsageLimit, async (req, res) => {
  let { html, format, isTransparent, targetId } = req.body;
  const isPro = req.user.plan === 'pro';
  
  // 建立當次專屬暫存區，防止檔案覆蓋錯亂
  const reqId = Date.now();
  const framesDir = path.join(__dirname, `frames_${reqId}`);
  const outFile = path.join(__dirname, `output_${reqId}.${format}`);

  // 【任務 5】免費版自動加上文字浮水印
  if (!isPro) {
    const watermark = `<div style="position:absolute; bottom:20px; right:30px; font-family:sans-serif; font-size:24px; font-weight:bold; color:rgba(255,255,255,0.7); z-index:9999; text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools Free</div>`;
    html = html.replace('</body>', watermark + '</body>');
  }

  let browser;
  try {
    if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

    // 【任務 3】Puppeteer 穩定性優化
    browser = await puppeteer.launch({ 
      headless: "new", 
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 60000
    });
    
    const page = await browser.newPage();
    
    // 【權限控制】Pro: 1080p 60fps, Free: 720p 30fps
    const scale = isPro ? 2 : 1;
    const width = isPro ? 1920 : 1280;
    const height = isPro ? 1080 : 720;
    const fps = isPro ? 60 : 30; 
    const duration = 2.5;
    const totalFrames = fps * duration;

    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const element = await page.$(`#${targetId}`);
    if (!element) throw new Error("Target element not found");

    // 逐格截圖
    for (let i = 0; i < totalFrames; i++) {
      await page.evaluate((timeMs) => { document.getAnimations().forEach(anim => anim.currentTime = timeMs); }, i * (1000 / fps));
      const framePath = path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`);
      await element.screenshot({ path: framePath, omitBackground: isTransparent });
    }

    await browser.close(); browser = null;

    // FFmpeg 影片合成
    let ffmpegCmd = format === 'mp4' 
      ? `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libx264 -pix_fmt yuv420p "${outFile}"`
      : `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p "${outFile}"`;
    
    execSync(ffmpegCmd);
    
    // 扣除免費額度
    if (!isPro) getUserData(req.user.uid).downloadsToday += 1;

    res.download(outFile, () => {
      // 確保傳輸完畢後刪除暫存檔
      try { fs.rmSync(framesDir, { recursive: true, force: true }); if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch(e) {}
    });

  } catch (err) {
    console.error('[Video Render Error]:', err); res.status(500).send('Render failed');
    try { fs.rmSync(framesDir, { recursive: true, force: true }); if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch(e) {}
  } finally {
    if (browser) await browser.close();
  }
});

// 捕捉所有未定義的路由導向首頁
app.get('*', (req, res) => res.redirect('/'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[BinTools SaaS] Server running on port ${PORT}`));
