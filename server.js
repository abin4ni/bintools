require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app = express();
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '200mb' }));

// 確保靜態檔案可以正常載入 (如 CSS, JS, 圖片)
app.use(express.static(__dirname));

// 首頁 (Landing Page)
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// 實際工具頁 (獨立為 /app)
app.get('/app', (req, res) => {
  res.sendFile(__dirname + '/app.html');
});

// 3. 捕捉舊版路由，全部導向首頁，保護 SEO
app.get('/pricing', (req, res) => res.redirect('/#pricing'));
app.get('/privacy', (req, res) => res.redirect('/#privacy'));
app.get('/terms', (req, res) => res.redirect('/#terms'));
app.get('/contact', (req, res) => res.redirect('/#contact'));


// ==========================================
// 簡易資料庫與權限管控
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

// ==========================================
// API 路由 (渲染與金流)
// ==========================================
app.get('/api/user-status', (req, res) => {
  const uid = req.headers['x-user-uid'] || 'guest_' + req.ip;
  res.json(getUserData(uid));
});

app.post('/api/create-checkout', async (req, res) => {
  const { uid } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'], mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID || 'price_placeholder', quantity: 1 }],
      client_reference_id: uid,
      success_url: `${req.headers.origin}/app?upgrade=success`,
      cancel_url: `${req.headers.origin}/app?upgrade=canceled`,
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- API: 圖片渲染 ---
app.post('/api/render-image', checkUsageLimit, async (req, res) => {
  let { html, format, isTransparent, targetId } = req.body;
  const isPro = req.user.plan === 'pro';

  if (!isPro) {
    const watermark = `<div style="position:absolute; bottom:20px; right:30px; font-family:sans-serif; font-size:24px; font-weight:bold; color:rgba(255,255,255,0.7); z-index:9999; text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools</div>`;
    html = html.replace('</body>', watermark + '</body>');
  }

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    
    const scale = isPro ? 2 : 1.5;
    const width = isPro ? 1920 : 1280;
    const height = isPro ? 1080 : 720;
    
    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const element = await page.$(`#${targetId}`);
    const buffer = await element.screenshot({ type: format === 'jpeg' ? 'jpeg' : 'png', omitBackground: isTransparent });

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
  const reqId = Date.now();
  const framesDir = path.join(__dirname, `frames_${reqId}`);
  const outFile = path.join(__dirname, `output_${reqId}.${format}`);

  if (!isPro) {
    const watermark = `<div style="position:absolute; bottom:20px; right:30px; font-family:sans-serif; font-size:24px; font-weight:bold; color:rgba(255,255,255,0.7); z-index:9999; text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools</div>`;
    html = html.replace('</body>', watermark + '</body>');
  }

  let browser;
  try {
    if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);

    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    
    const scale = isPro ? 2 : 1;
    const width = isPro ? 1920 : 1280;
    const height = isPro ? 1080 : 720;
    const fps = isPro ? 60 : 30; 
    const duration = 2.5;
    const totalFrames = fps * duration;

    await page.setViewport({ width, height, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const element = await page.$(`#${targetId}`);

    for (let i = 0; i < totalFrames; i++) {
      await page.evaluate((timeMs) => { document.getAnimations().forEach(anim => anim.currentTime = timeMs); }, i * (1000 / fps));
      const framePath = path.join(framesDir, `frame_${String(i).padStart(3, '0')}.png`);
      await element.screenshot({ path: framePath, omitBackground: isTransparent });
    }

    await browser.close(); browser = null;

    let ffmpegCmd = format === 'mp4' 
      ? `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libx264 -pix_fmt yuv420p "${outFile}"`
      : `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p "${outFile}"`;
    
    execSync(ffmpegCmd);
    if (!isPro) getUserData(req.user.uid).downloadsToday += 1;

    res.download(outFile, () => {
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
