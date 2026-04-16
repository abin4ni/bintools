const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const app = express();

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(__dirname));

const usersDb = new Map();

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function getUserData(uid) {
  const today = getTodayKey();

  if (!usersDb.has(uid)) {
    usersDb.set(uid, { plan: 'free', downloadsToday: 0, lastReset: today });
  }

  const user = usersDb.get(uid);

  if (user.lastReset !== today) {
    user.downloadsToday = 0;
    user.lastReset = today;
  }

  return user;
}

function buildUid(req) {
  const headerUid = req.headers['x-user-uid'];
  if (typeof headerUid === 'string' && headerUid.trim()) {
    return headerUid.trim();
  }
  return 'guest_' + req.ip;
}

function checkUsageLimit(req, res, next) {
  const uid = buildUid(req);
  const user = getUserData(uid);

  if (user.plan === 'free' && user.downloadsToday >= 3) {
    return res.status(403).json({
      message: '今日免費額度已用完，請稍後再試。'
    });
  }

  req.user = { uid, plan: user.plan };
  return next();
}

function sanitizeImageFormat(format) {
  return format === 'jpeg' ? 'jpeg' : 'png';
}

function sanitizeVideoFormat(format) {
  return format === 'mp4' ? 'mp4' : 'webm';
}

function applyFreeWatermark(html) {
  const watermark =
    '<div style="position:absolute;bottom:20px;right:30px;font-family:sans-serif;font-size:24px;font-weight:bold;color:rgba(255,255,255,0.72);z-index:9999;text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools</div>';
  if (typeof html !== 'string') return '';
  if (html.includes('</body>')) return html.replace('</body>', watermark + '</body>');
  return html + watermark;
}

async function writeTempHtml(html) {
  const tempPath = path.join(
    os.tmpdir(),
    'bintools-render-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html'
  );
  await fs.promises.writeFile(tempPath, html, 'utf8');
  return tempPath;
}

async function safeRemove(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {}
}

async function safeRemoveDir(dirPath) {
  if (!dirPath) return;
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

function hasFfmpeg() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function getLaunchOptions() {
  const options = {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return options;
}

async function openRenderPage(browser, htmlPath, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(pathToFileURL(htmlPath).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  return page;
}

async function getTargetOrBody(page, targetId) {
  let element = null;

  if (typeof targetId === 'string' && targetId.trim()) {
    const handle = await page.evaluateHandle((id) => document.getElementById(id), targetId.trim());
    element = handle.asElement();
  }

  if (!element) element = await page.$('body');
  if (!element) throw new Error('Render target not found');

  return element;
}

// 必要三路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'blog.html'));
});

app.get('/api/user-status', (req, res) => {
  const uid = buildUid(req);
  return res.json(getUserData(uid));
});

app.post('/api/render-image', checkUsageLimit, async (req, res) => {
  const htmlInput = typeof req.body.html === 'string' ? req.body.html : '';
  const targetId = typeof req.body.targetId === 'string' ? req.body.targetId : 'captureArea';
  const format = sanitizeImageFormat(req.body.format);
  const isTransparent = Boolean(req.body.isTransparent);
  const isPro = req.user.plan === 'pro';

  if (!htmlInput.trim()) {
    return res.status(400).json({ message: '生成失敗，請重試。' });
  }

  const html = isPro ? htmlInput : applyFreeWatermark(htmlInput);
  const viewport = isPro
    ? { width: 1920, height: 1080, deviceScaleFactor: 2 }
    : { width: 1280, height: 720, deviceScaleFactor: 1.5 };

  let browser = null;
  let tempHtmlPath = '';

  try {
    tempHtmlPath = await writeTempHtml(html);
    browser = await puppeteer.launch(getLaunchOptions());

    const page = await openRenderPage(browser, tempHtmlPath, viewport);
    const element = await getTargetOrBody(page, targetId);

    let buffer;
    try {
      buffer = await element.screenshot({
        type: format,
        omitBackground: isTransparent
      });
    } catch (_) {
      buffer = await page.screenshot({
        type: format,
        omitBackground: isTransparent,
        fullPage: false
      });
    }

    if (!isPro) getUserData(req.user.uid).downloadsToday += 1;

    res.setHeader('Content-Type', format === 'jpeg' ? 'image/jpeg' : 'image/png');
    return res.send(buffer);
  } catch (err) {
    console.error('[render-image] failed:', err.message);
    return res.status(500).json({ message: '生成失敗，請重試。' });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    await safeRemove(tempHtmlPath);
  }
});

app.post('/api/render-video', checkUsageLimit, async (req, res) => {
  if (!hasFfmpeg()) {
    return res.status(503).json({ message: '影片服務暫時忙碌，請稍後再試。' });
  }

  const htmlInput = typeof req.body.html === 'string' ? req.body.html : '';
  const targetId = typeof req.body.targetId === 'string' ? req.body.targetId : 'captureAreaAnim';
  const format = sanitizeVideoFormat(req.body.format);
  const isTransparent = Boolean(req.body.isTransparent);
  const isPro = req.user.plan === 'pro';

  if (!htmlInput.trim()) {
    return res.status(400).json({ message: '生成失敗，請重試。' });
  }

  const html = isPro ? htmlInput : applyFreeWatermark(htmlInput);
  const viewport = isPro
    ? { width: 1920, height: 1080, deviceScaleFactor: 2 }
    : { width: 1280, height: 720, deviceScaleFactor: 1 };

  const fps = isPro ? 60 : 30;
  const durationSec = 2;
  const totalFrames = Math.max(1, Math.floor(fps * durationSec));

  let browser = null;
  let tempHtmlPath = '';
  let workDir = '';

  try {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bintools-video-'));
    const framesDir = path.join(workDir, 'frames');
    const outFile = path.join(workDir, 'output.' + format);

    await fs.promises.mkdir(framesDir);
    tempHtmlPath = await writeTempHtml(html);

    browser = await puppeteer.launch(getLaunchOptions());
    const page = await openRenderPage(browser, tempHtmlPath, viewport);
    const element = await getTargetOrBody(page, targetId);

    for (let i = 0; i < totalFrames; i += 1) {
      const nowMs = i * (1000 / fps);
      await page.evaluate((timeMs) => {
        document.getAnimations().forEach((anim) => {
          anim.currentTime = timeMs;
        });
      }, nowMs);

      const framePath = path.join(framesDir, 'frame_' + String(i).padStart(4, '0') + '.png');
      await element.screenshot({ path: framePath, omitBackground: isTransparent });
    }

    await browser.close();
    browser = null;

    const ffmpegArgs =
      format === 'mp4'
        ? ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outFile]
        : ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', outFile];

    const ffmpegResult = spawnSync('ffmpeg', ffmpegArgs, {
      encoding: 'utf8',
      timeout: 240000
    });

    if (ffmpegResult.status !== 0 || !fs.existsSync(outFile)) {
      throw new Error('ffmpeg-failed');
    }

    const videoBuffer = await fs.promises.readFile(outFile);

    if (!isPro) getUserData(req.user.uid).downloadsToday += 1;

    res.setHeader('Content-Type', format === 'mp4' ? 'video/mp4' : 'video/webm');
    res.setHeader('Content-Disposition', 'attachment; filename="BinTools_Export_' + Date.now() + '.' + format + '"');
    return res.send(videoBuffer);
  } catch (err) {
    console.error('[render-video] failed:', err.message);
    return res.status(500).json({ message: '影片生成失敗，請重試。' });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
    await safeRemove(tempHtmlPath);
    await safeRemoveDir(workDir);
  }
});

app.use((err, req, res, next) => {
  console.error('[server] unhandled:', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ message: '系統暫時忙碌，請稍後再試。' });
});

app.get('*', (req, res) => {
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('[BinTools] Server running on port ' + PORT);
});
