require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const app = express();

// ============================================================
// STRIPE 初始化
// ============================================================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('[Stripe] initialized');
} else {
  console.warn('[Stripe] STRIPE_SECRET_KEY not set — payment endpoints disabled');
}

// ============================================================
// FIREBASE ADMIN 初始化
// ============================================================
let adminDb = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const credential = process.env.FIREBASE_PRIVATE_KEY
      ? admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
      : admin.credential.applicationDefault();

    admin.initializeApp({ credential });
  }
  adminDb = admin.firestore();
  console.log('[Firebase Admin] initialized');
} catch (err) {
  console.warn('[Firebase Admin] not available:', err.message);
}

// ============================================================
// 工具函式
// ============================================================
function apiOk(data = null) {
  return { success: true, data, error: null };
}

function apiFail(error, data = null) {
  return { success: false, data, error: error || '生成失敗，請稍後再試' };
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function buildUid(req) {
  const headerUid = req.headers['x-user-uid'];
  if (typeof headerUid === 'string' && headerUid.trim()) {
    return headerUid.trim();
  }
  return 'guest_' + req.ip;
}

// 記憶體 fallback（重啟即清空）
const usersDb = new Map();

async function getUserData(uid) {
  const today = getTodayKey();

  // 優先從 Firestore 讀取
  if (adminDb) {
    try {
      const doc = await adminDb.collection('users').doc(uid).get();
      const data = doc.exists ? doc.data() : {};
      const downloadsToday = (data.lastReset === today) ? (data.downloadsToday || 0) : 0;
      return {
        plan: data.plan || 'free',
        downloadsToday,
        lastReset: today,
        email: data.email || ''
      };
    } catch (err) {
      console.error('[getUserData] Firestore error:', err.message);
    }
  }

  // Fallback：記憶體 Map
  if (!usersDb.has(uid)) {
    usersDb.set(uid, { plan: 'free', downloadsToday: 0, lastReset: today });
  }
  const user = usersDb.get(uid);
  if (user.lastReset !== today) {
    user.lastReset = today;
    user.downloadsToday = 0;
  }
  return user;
}

async function incrementDownloads(uid) {
  const today = getTodayKey();

  if (adminDb) {
    try {
      const ref = adminDb.collection('users').doc(uid);
      const doc = await ref.get();
      const data = doc.exists ? doc.data() : {};
      const current = (data.lastReset === today) ? (data.downloadsToday || 0) : 0;
      await ref.set({ downloadsToday: current + 1, lastReset: today }, { merge: true });
      return current + 1;
    } catch (err) {
      console.error('[incrementDownloads] Firestore error:', err.message);
    }
  }

  // Fallback Map
  const user = usersDb.get(uid) || { plan: 'free', downloadsToday: 0, lastReset: today };
  if (user.lastReset !== today) { user.lastReset = today; user.downloadsToday = 0; }
  user.downloadsToday++;
  usersDb.set(uid, user);
  return user.downloadsToday;
}

async function setUserPro(uid, email, stripeCustomerId, stripeSubscriptionId) {
  if (adminDb) {
    await adminDb.collection('users').doc(uid).set({
      plan: 'pro',
      email: email || '',
      stripeCustomerId: stripeCustomerId || '',
      stripeSubscriptionId: stripeSubscriptionId || '',
      upgradedAt: new Date().toISOString()
    }, { merge: true });
    console.log('[setUserPro] Firestore updated uid:', uid);
    return;
  }
  // Fallback Map
  const user = usersDb.get(uid) || { plan: 'free', downloadsToday: 0, lastReset: getTodayKey() };
  user.plan = 'pro';
  usersDb.set(uid, user);
}

async function setUserFree(uid) {
  if (adminDb) {
    await adminDb.collection('users').doc(uid).set({
      plan: 'free',
      stripeSubscriptionId: '',
      canceledAt: new Date().toISOString()
    }, { merge: true });
    return;
  }
  const user = usersDb.get(uid) || { plan: 'free', downloadsToday: 0, lastReset: getTodayKey() };
  user.plan = 'free';
  usersDb.set(uid, user);
}

function checkUsageLimit(user) {
  if (user.plan === 'pro') return true;
  return user.downloadsToday < 3;
}

function sanitizeImageFormat(format) {
  return format === 'jpeg' ? 'jpeg' : 'png';
}

function sanitizeVideoFormat(format) {
  return format === 'mp4' ? 'mp4' : 'webm';
}

function sanitizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => Array.isArray(row)).map((row) => row.map((cell) => String(cell ?? '')));
}

function applyFreeWatermark(html) {
  const watermark = '<div style="position:absolute;bottom:20px;right:30px;font-family:sans-serif;font-size:24px;font-weight:bold;color:rgba(255,255,255,0.72);z-index:9999;text-shadow:0 2px 10px rgba(0,0,0,0.5);">BinTools</div>';
  if (typeof html !== 'string') return '';
  if (html.includes('</body>')) return html.replace('</body>', watermark + '</body>');
  return html + watermark;
}

async function writeTempHtml(html) {
  const tempPath = path.join(os.tmpdir(), 'bintools-render-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html');
  await fs.promises.writeFile(tempPath, html, 'utf8');
  return tempPath;
}

async function safeRemove(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch (_) {}
}

async function safeRemoveDir(dirPath) {
  if (!dirPath) return;
  try { await fs.promises.rm(dirPath, { recursive: true, force: true }); } catch (_) {}
}

function hasFfmpeg() {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
}

function getLaunchOptions() {
  const options = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  return options;
}

async function openRenderPage(browser, htmlPath, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

// ============================================================
// MIDDLEWARE
// ============================================================
// Stripe Webhook 必須在 express.json() 之前，使用 raw body
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '35mb' }));
app.use(express.static(__dirname));

// ============================================================
// 頁面路由
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'blog.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'terms.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname, 'contact.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'about.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'success.html')));
app.get('/cancel', (req, res) => res.redirect('/app?upgrade=canceled'));

// ============================================================
// API — 用戶狀態
// ============================================================
app.get('/api/user-status', async (req, res) => {
  const uid = buildUid(req);
  const user = await getUserData(uid);
  return res.json(apiOk(user));
});

// ============================================================
// API — STRIPE 建立結帳 Session
// ============================================================
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(503).json(apiFail('付款服務尚未設定，請聯絡管理員'));
  if (!process.env.STRIPE_PRICE_ID) return res.status(503).json(apiFail('付款方案尚未設定'));

  const uid = buildUid(req);
  const email = typeof req.body?.email === 'string' ? req.body.email : undefined;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  try {
    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: frontendUrl + '/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: frontendUrl + '/cancel',
      metadata: { uid },
      allow_promotion_codes: true,
    };

    if (email) sessionParams.customer_email = email;

    const session = await stripe.checkout.sessions.create(sessionParams);
    console.log('[Stripe] checkout session created:', session.id, 'uid:', uid);
    return res.json(apiOk({ url: session.url, sessionId: session.id }));
  } catch (err) {
    console.error('[Stripe] create session failed:', err.message);
    return res.status(500).json(apiFail('建立付款頁面失敗，請稍後再試'));
  }
});

// ============================================================
// API — STRIPE WEBHOOK（付款成功/取消訂閱）
// ============================================================
app.post('/api/stripe-webhook', async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Webhook] signature verification failed:', err.message);
    return res.status(400).send('Webhook signature verification failed');
  }

  console.log('[Webhook] event received:', event.type);

  try {
    switch (event.type) {

      // ── 付款成功（首次訂閱完成）──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata?.uid;
        const email = session.customer_details?.email || '';
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        if (uid) {
          await setUserPro(uid, email, customerId, subscriptionId);
          console.log('[Webhook] Pro granted → uid:', uid, 'email:', email);
        }
        break;
      }

      // ── 訂閱續費成功 ──
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const uid = sub.metadata?.uid;
          if (uid) {
            await setUserPro(uid, invoice.customer_email || '', invoice.customer, invoice.subscription);
            console.log('[Webhook] Pro renewed → uid:', uid);
          }
        }
        break;
      }

      // ── 付款失敗 ──
      case 'invoice.payment_failed': {
        console.warn('[Webhook] payment failed for customer:', event.data.object.customer);
        // 可以在這裡發送提醒 email 或標記帳號
        break;
      }

      // ── 訂閱取消 ──
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const uid = sub.metadata?.uid;
        if (uid) {
          await setUserFree(uid);
          console.log('[Webhook] Pro canceled → uid:', uid);
        }
        break;
      }

      default:
        console.log('[Webhook] unhandled event type:', event.type);
    }
  } catch (err) {
    console.error('[Webhook] handler error:', err.message);
    return res.status(500).send('Webhook handler error');
  }

  return res.json({ received: true });
});

// ============================================================
// API — 生成表格
// ============================================================
app.post('/api/generate-table', async (req, res) => {
  try {
    const rows = sanitizeRows(req.body && req.body.rows);
    if (!rows.length) return res.status(400).json(apiFail('請提供有效表格資料'));
    return res.json(apiOk({ rows, columns: rows[0].length, rowCount: rows.length }));
  } catch (err) {
    console.error('[generate-table] failed:', err.message);
    return res.status(500).json(apiFail('生成失敗，請稍後再試'));
  }
});

// ============================================================
// API — 渲染圖片
// ============================================================
app.post('/api/render-image', async (req, res) => {
  const uid = buildUid(req);
  const user = await getUserData(uid);

  if (!checkUsageLimit(user)) {
    return res.status(403).json(apiFail('今日免費額度已用完，請升級 Pro'));
  }

  const htmlInput = typeof req.body?.html === 'string' ? req.body.html : '';
  const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId : 'captureArea';
  const format = sanitizeImageFormat(req.body?.format);
  const isTransparent = Boolean(req.body?.isTransparent);
  const isPro = user.plan === 'pro';

  if (!htmlInput.trim()) return res.status(400).json(apiFail('生成失敗，請稍後再試'));

  const html = isPro ? htmlInput : applyFreeWatermark(htmlInput);
  const viewport = isPro
    ? { width: 1920, height: 1080, deviceScaleFactor: 2 }
    : { width: 1280, height: 720, deviceScaleFactor: 1.5 };

  let browser = null, tempHtmlPath = '';
  try {
    tempHtmlPath = await writeTempHtml(html);
    browser = await puppeteer.launch(getLaunchOptions());
    const page = await openRenderPage(browser, tempHtmlPath, viewport);
    const element = await getTargetOrBody(page, targetId);

    let buffer;
    try {
      buffer = await element.screenshot({ type: format, omitBackground: isTransparent });
    } catch (_) {
      buffer = await page.screenshot({ type: format, omitBackground: isTransparent, fullPage: false });
    }

    if (!isPro) await incrementDownloads(uid);

    return res.json(apiOk({
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      extension: format,
      base64: buffer.toString('base64')
    }));
  } catch (err) {
    console.error('[render-image] failed:', err.message);
    return res.status(500).json(apiFail('生成失敗，請稍後再試'));
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    await safeRemove(tempHtmlPath);
  }
});

// ============================================================
// API — 渲染影片
// ============================================================
app.post('/api/render-video', async (req, res) => {
  if (!hasFfmpeg()) return res.status(503).json(apiFail('影片服務暫時無法使用，請稍後再試'));

  const uid = buildUid(req);
  const user = await getUserData(uid);

  if (!checkUsageLimit(user)) {
    return res.status(403).json(apiFail('今日免費額度已用完，請升級 Pro'));
  }

  const htmlInput = typeof req.body?.html === 'string' ? req.body.html : '';
  const targetId = typeof req.body?.targetId === 'string' ? req.body.targetId : 'captureAreaAnim';
  const format = sanitizeVideoFormat(req.body?.format);
  const isTransparent = Boolean(req.body?.isTransparent);
  const isPro = user.plan === 'pro';

  if (!htmlInput.trim()) return res.status(400).json(apiFail('生成失敗，請稍後再試'));

  const html = isPro ? htmlInput : applyFreeWatermark(htmlInput);
  const viewport = isPro
    ? { width: 1920, height: 1080, deviceScaleFactor: 2 }
    : { width: 1280, height: 720, deviceScaleFactor: 1 };
  const fps = isPro ? 60 : 30;
  const totalFrames = Math.max(1, Math.floor(fps * 2));

  let browser = null, tempHtmlPath = '', workDir = '';
  try {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bintools-video-'));
    const framesDir = path.join(workDir, 'frames');
    const outFile = path.join(workDir, 'output.' + format);
    await fs.promises.mkdir(framesDir);
    tempHtmlPath = await writeTempHtml(html);
    browser = await puppeteer.launch(getLaunchOptions());
    const page = await openRenderPage(browser, tempHtmlPath, viewport);
    const element = await getTargetOrBody(page, targetId);

    for (let i = 0; i < totalFrames; i++) {
      const nowMs = i * (1000 / fps);
      await page.evaluate((t) => { document.getAnimations().forEach((a) => { a.currentTime = t; }); }, nowMs);
      const framePath = path.join(framesDir, 'frame_' + String(i).padStart(4, '0') + '.png');
      await element.screenshot({ path: framePath, omitBackground: isTransparent });
    }

    await browser.close();
    browser = null;

    const ffmpegArgs = format === 'mp4'
      ? ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outFile]
      : ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', outFile];

    const ffmpegResult = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8', timeout: 240000 });
    if (ffmpegResult.status !== 0 || !fs.existsSync(outFile)) throw new Error('ffmpeg-failed');

    const videoBuffer = await fs.promises.readFile(outFile);
    if (!isPro) await incrementDownloads(uid);

    return res.json(apiOk({
      mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
      extension: format,
      base64: videoBuffer.toString('base64')
    }));
  } catch (err) {
    console.error('[render-video] failed:', err.message);
    return res.status(500).json(apiFail('生成失敗，請稍後再試'));
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
    await safeRemove(tempHtmlPath);
    await safeRemoveDir(workDir);
  }
});

// ============================================================
// 錯誤處理 & Catch-all
// ============================================================
app.use((err, req, res, next) => {
  console.error('[server] unhandled:', err?.message || err);
  if (res.headersSent) return next(err);
  return res.status(500).json(apiFail('系統暫時忙碌，請稍後再試'));
});

app.get('*', (req, res) => res.redirect('/'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[BinTools] Server running on port ' + PORT));