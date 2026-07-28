const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/tv', express.static(path.join(__dirname, 'public', 'tv')));

// 数据库
const DB_PATH = path.join(__dirname, 'data', 'store.db');
let db;

// 数据库操作辅助函数
function dbRun(sql, params = []) {
  db.run(sql, params);
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// 保存数据库到文件
function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// 启动
async function start() {
  const SQL = await initSqlJs();

  // 尝试从文件加载数据库
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // 创建表
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT DEFAULT '📱',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      package_name TEXT NOT NULL UNIQUE,
      version TEXT DEFAULT '1.0.0',
      category_id INTEGER,
      icon TEXT DEFAULT '',
      description TEXT DEFAULT '',
      developer TEXT DEFAULT '',
      size TEXT DEFAULT '0 MB',
      rating REAL DEFAULT 0,
      download_count INTEGER DEFAULT 0,
      apk_url TEXT DEFAULT '',
      download_url TEXT DEFAULT '',
      screenshots TEXT DEFAULT '[]',
      is_featured INTEGER DEFAULT 0,
      is_recommended INTEGER DEFAULT 0,
      status INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )
  `);

  // 迁移：旧数据库可能没有 download_url 列
  try {
    db.run('ALTER TABLE apps ADD COLUMN download_url TEXT DEFAULT \'\'');
  } catch (e) {
    // 列已存在，忽略
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 插入默认分类
  const defaultCategories = [
    ['影音娱乐', '🎬', 1],
    ['系统工具', '🔧', 2],
    ['学习教育', '📚', 3],
    ['生活服务', '🏠', 4],
    ['运动健康', '💪', 5],
    ['新闻资讯', '📰', 6],
    ['游戏', '🎮', 7],
  ];

  for (const [name, icon, sort] of defaultCategories) {
    const existing = dbGet('SELECT id FROM categories WHERE name = ?', [name]);
    if (!existing) {
      dbRun('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)', [name, icon, sort]);
    }
  }

  saveDb();

  // 文件上传配置
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, uuidv4() + ext);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowed = ['.apk', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.includes(ext)) cb(null, true);
      else cb(new Error('不支持的文件格式'));
    }
  });

  // ==================== 分类 API ====================

  app.get('/api/categories', (req, res) => {
    const categories = dbAll('SELECT * FROM categories ORDER BY sort_order ASC');
    res.json({ success: true, data: categories });
  });

  app.post('/api/categories', (req, res) => {
    const { name, icon, sort_order } = req.body;
    if (!name) return res.status(400).json({ success: false, message: '分类名称不能为空' });
    try {
      dbRun('INSERT INTO categories (name, icon, sort_order) VALUES (?, ?, ?)', [name, icon || '📱', sort_order || 0]);
      saveDb();
      const idRow = dbGet('SELECT last_insert_rowid() as id');
      res.json({ success: true, data: { id: idRow ? idRow.id : 0 } });
    } catch (e) {
      res.status(400).json({ success: false, message: '分类已存在' });
    }
  });

  app.put('/api/categories/:id', (req, res) => {
    const { name, icon, sort_order } = req.body;
    dbRun('UPDATE categories SET name = ?, icon = ?, sort_order = ? WHERE id = ?', [name, icon, sort_order, req.params.id]);
    saveDb();
    res.json({ success: true });
  });

  app.delete('/api/categories/:id', (req, res) => {
    dbRun('UPDATE apps SET category_id = NULL WHERE category_id = ?', [req.params.id]);
    dbRun('DELETE FROM categories WHERE id = ?', [req.params.id]);
    saveDb();
    res.json({ success: true });
  });

  // ==================== 应用 API ====================

  app.get('/api/apps', (req, res) => {
    const { category_id, keyword, featured, recommended, page = 1, pageSize = 20 } = req.query;
    let sql = 'SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.status = 1';
    const params = [];

    if (category_id) { sql += ' AND a.category_id = ?'; params.push(Number(category_id)); }
    if (keyword) { sql += ' AND (a.name LIKE ? OR a.description LIKE ? OR a.developer LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
    if (featured === '1') { sql += ' AND a.is_featured = 1'; }
    if (recommended === '1') { sql += ' AND a.is_recommended = 1'; }

    const allApps = dbAll(sql, params);
    const total = allApps.length;

    const offset = (Number(page) - 1) * Number(pageSize);
    const pagedApps = allApps.slice(offset, offset + Number(pageSize));
    const parsed = pagedApps.map(a => ({ ...a, screenshots: JSON.parse(a.screenshots || '[]') }));

    res.json({ success: true, data: parsed, total, page: Number(page), pageSize: Number(pageSize) });
  });

  app.get('/api/apps/all', (req, res) => {
    const apps = dbAll('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id ORDER BY a.updated_at DESC');
    const parsed = apps.map(a => ({ ...a, screenshots: JSON.parse(a.screenshots || '[]') }));
    res.json({ success: true, data: parsed });
  });

  app.get('/api/apps/:id', (req, res) => {
    const app = dbGet('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.id = ?', [req.params.id]);
    if (!app) return res.status(404).json({ success: false, message: '应用不存在' });
    app.screenshots = JSON.parse(app.screenshots || '[]');
    res.json({ success: true, data: app });
  });

  app.post('/api/apps', upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'apk', maxCount: 1 },
    { name: 'screenshots', maxCount: 10 }
  ]), (req, res) => {
    const { name, package_name, version, category_id, description, developer, size, is_featured, is_recommended, status, download_url } = req.body;
    if (!name || !package_name) return res.status(400).json({ success: false, message: '应用名称和包名不能为空' });

    const icon = req.files?.icon?.[0] ? '/uploads/' + req.files.icon[0].filename : '';
    const apk_url = req.files?.apk?.[0] ? '/uploads/' + req.files.apk[0].filename : '';
    const durl = download_url || '';
    const screenshots = req.files?.screenshots ? JSON.stringify(req.files.screenshots.map(f => '/uploads/' + f.filename)) : '[]';

    try {
      dbRun(`INSERT INTO apps (name, package_name, version, category_id, icon, description, developer, size, apk_url, download_url, screenshots, is_featured, is_recommended, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, package_name, version || '1.0.0', category_id || null, icon, description || '', developer || '', size || '0 MB', apk_url, durl, screenshots, is_featured ? 1 : 0, is_recommended ? 1 : 0, status !== undefined ? Number(status) : 1]);
      saveDb();
      const idRow = dbGet('SELECT last_insert_rowid() as id');
      res.json({ success: true, data: { id: idRow ? idRow.id : 0 } });
    } catch (e) {
      res.status(400).json({ success: false, message: '包名已存在或数据错误: ' + e.message });
    }
  });

  app.put('/api/apps/:id', upload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'apk', maxCount: 1 },
    { name: 'screenshots', maxCount: 10 }
  ]), (req, res) => {
    const existing = dbGet('SELECT * FROM apps WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, message: '应用不存在' });

    const { name, package_name, version, category_id, description, developer, size, is_featured, is_recommended, status, download_url } = req.body;

    const icon = req.files?.icon?.[0] ? '/uploads/' + req.files.icon[0].filename : existing.icon;
    const apk_url = req.files?.apk?.[0] ? '/uploads/' + req.files.apk[0].filename : existing.apk_url;
    const durl = download_url !== undefined ? download_url : (existing.download_url || '');

    let screenshots = existing.screenshots;
    if (req.files?.screenshots?.length) {
      screenshots = JSON.stringify(req.files.screenshots.map(f => '/uploads/' + f.filename));
    } else if (req.body.screenshots) {
      screenshots = req.body.screenshots;
    }

    dbRun(`UPDATE apps SET name=?, package_name=?, version=?, category_id=?, icon=?, description=?, developer=?, size=?, apk_url=?, download_url=?, screenshots=?, is_featured=?, is_recommended=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [name || existing.name, package_name || existing.package_name, version || existing.version, category_id || existing.category_id, icon, description || existing.description, developer || existing.developer, size || existing.size, apk_url, durl, screenshots, is_featured !== undefined ? Number(is_featured) : existing.is_featured, is_recommended !== undefined ? Number(is_recommended) : existing.is_recommended, status !== undefined ? Number(status) : existing.status, req.params.id]);
    saveDb();
    res.json({ success: true });
  });

  app.delete('/api/apps/:id', (req, res) => {
    dbRun('DELETE FROM apps WHERE id = ?', [req.params.id]);
    saveDb();
    res.json({ success: true });
  });

  app.post('/api/apps/:id/download', (req, res) => {
    dbRun('UPDATE apps SET download_count = download_count + 1 WHERE id = ?', [req.params.id]);
    saveDb();
    res.json({ success: true });
  });

  // ==================== 首页数据 ====================

  app.get('/api/home', (req, res) => {
    const parse = (apps) => apps.map(a => ({ ...a, screenshots: JSON.parse(a.screenshots || '[]') }));
    const featured = dbAll('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_featured = 1 AND a.status = 1 ORDER BY a.updated_at DESC LIMIT 10');
    const recommended = dbAll('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.is_recommended = 1 AND a.status = 1 ORDER BY a.download_count DESC LIMIT 10');
    const newest = dbAll('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.status = 1 ORDER BY a.created_at DESC LIMIT 10');
    const popular = dbAll('SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.status = 1 ORDER BY a.download_count DESC LIMIT 10');
    const categories = dbAll('SELECT * FROM categories ORDER BY sort_order ASC');

    res.json({ success: true, data: { featured: parse(featured), recommended: parse(recommended), newest: parse(newest), popular: parse(popular), categories } });
  });

  // ==================== 搜索 ====================

  app.get('/api/search', (req, res) => {
    const { q } = req.query;
    if (!q) return res.json({ success: true, data: [] });
    const apps = dbAll(`SELECT a.*, c.name as category_name FROM apps a LEFT JOIN categories c ON a.category_id = c.id WHERE a.status = 1 AND (a.name LIKE ? OR a.description LIKE ? OR a.developer LIKE ? OR a.package_name LIKE ?) ORDER BY a.download_count DESC LIMIT 30`,
      [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
    const parsed = apps.map(a => ({ ...a, screenshots: JSON.parse(a.screenshots || '[]') }));
    res.json({ success: true, data: parsed });
  });

  // ==================== 设置 ====================

  app.get('/api/settings', (req, res) => {
    const settings = dbAll('SELECT * FROM settings');
    const map = {}; settings.forEach(s => map[s.key] = s.value);
    res.json({ success: true, data: map });
  });

  app.put('/api/settings', (req, res) => {
    for (const [key, value] of Object.entries(req.body)) {
      dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
    }
    saveDb();
    res.json({ success: true });
  });

  // ==================== 统计 ====================

  app.get('/api/stats', (req, res) => {
    const totalApps = dbGet('SELECT COUNT(*) as count FROM apps').count;
    const activeApps = dbGet('SELECT COUNT(*) as count FROM apps WHERE status = 1').count;
    const totalCategories = dbGet('SELECT COUNT(*) as count FROM categories').count;
    const downloadRow = dbGet('SELECT SUM(download_count) as total FROM apps');
    const totalDownloads = downloadRow?.total || 0;

    res.json({ success: true, data: { totalApps, activeApps, totalCategories, totalDownloads } });
  });

  // ==================== 管理员登录 ====================
  const ADMIN_PASSWORD = '135';
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      res.json({ success: true, message: '登录成功' });
    } else {
      res.status(401).json({ success: false, message: '密码错误' });
    }
  });

  // ==================== 页面路由 ====================

  app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')); });
  app.get('/tv', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'tv', 'index.html')); });
  app.get('/', (req, res) => { res.redirect('/tv'); });

  app.listen(PORT, () => {
    console.log(`=== TV 应用商店已启动 ===`);
    console.log(`  📺 TV 商店:   http://localhost:${PORT}/tv`);
    console.log(`  ⚙️  管理后台: http://localhost:${PORT}/admin`);
    console.log(`  🔌 API:       http://localhost:${PORT}/api`);
  });
}

start().catch(e => {
  console.error('启动失败:', e);
  process.exit(1);
});
