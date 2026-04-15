// ==========================================
// ★ 頁面路由分離 (Landing Page vs App vs Blog) ★
// ==========================================
// 首頁 (展示與行銷)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 工具頁 (實際應用區)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// 教學文章頁 (SEO 獨立頁面)
// 【修正】確保 /blog 路由正確指向根目錄下的 blog.html
app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'blog.html'));
});

// 捕捉舊版路由，全部導向首頁，保護 SEO
app.get('/pricing', (req, res) => res.redirect('/#pricing'));
app.get('/privacy', (req, res) => res.redirect('/#privacy'));
app.get('/terms', (req, res) => res.redirect('/#terms'));
app.get('/contact', (req, res) => res.redirect('/#contact'));