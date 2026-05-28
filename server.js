const express = require('express');
const initSqlJs = require('sql.js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 图片存储 ==========
const PHOTO_DIR = path.join(__dirname, 'public', 'photos');
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, 0o755);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4().slice(0,12)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});

// ========== 数据库初始化（使用 sql.js） ==========
const DB_PATH = path.join(__dirname, 'data', 'baby.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();
  
  // 确保 data 目录存在
  const dbDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, 0o755);

  // 尝试加载已有数据库
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '我家宝宝',
      birth_date TEXT,
      remind_days INTEGER NOT NULL DEFAULT 7,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id),
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id),
      member_id TEXT NOT NULL REFERENCES members(id),
      date TEXT NOT NULL,
      height REAL,
      weight REAL,
      head REAL,
      note TEXT,
      photo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // 兼容旧表：加 photo 列（如果不存在）
  try { db.run(`ALTER TABLE records ADD COLUMN photo TEXT`); } catch(e) {}
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_family ON records(family_id, date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)`);

  // 保存初始数据库
  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ========== 中间件 ==========
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== API - 家庭 ==========

app.post('/api/family', (req, res) => {
  const { name, birthDate, memberName } = req.body;
  const familyId = uuidv4().slice(0, 8);
  const memberId = uuidv4().slice(0, 8);

  db.run(`INSERT INTO families (id, name, birth_date) VALUES (?, ?, ?)`, 
    [familyId, name || '我家宝宝', birthDate || null]);
  
  db.run(`INSERT INTO members (id, family_id, name, is_admin) VALUES (?, ?, ?, 1)`,
    [memberId, familyId, memberName || '妈妈']);

  saveDb();
  res.json({ familyId, memberId, shareCode: familyId, memberName: memberName || '妈妈' });
});

app.post('/api/family/join', (req, res) => {
  const { shareCode, memberName } = req.body;
  const family = db.exec(`SELECT * FROM families WHERE id = ?`, [shareCode]);
  
  if (!family.length || !family[0].values.length) {
    return res.status(404).json({ error: '家庭码无效，请检查后重试' });
  }

  const memberId = uuidv4().slice(0, 8);
  db.run(`INSERT INTO members (id, family_id, name) VALUES (?, ?, ?)`,
    [memberId, shareCode, memberName || '家人']);

  saveDb();
  res.json({ familyId: shareCode, memberId, shareCode });
});

app.get('/api/family/:familyId', (req, res) => {
  const { familyId } = req.params;
  
  const familyRows = db.exec(`SELECT id, name, birth_date, remind_days, created_at FROM families WHERE id = ?`, [familyId]);
  if (!familyRows.length || !familyRows[0].values.length) {
    return res.status(404).json({ error: '家庭不存在' });
  }

  const f = familyRows[0];
  const cols = f.columns;
  const vals = f.values[0];
  const family = {};
  cols.forEach((col, i) => family[col] = vals[i]);

  const memberRows = db.exec(`SELECT id, name, is_admin FROM members WHERE family_id = ?`, [familyId]);
  const members = memberRows.length ? memberRows[0].values.map(v => {
    const m = {};
    memberRows[0].columns.forEach((col, i) => m[col] = v[i]);
    return m;
  }) : [];

  res.json({ ...family, members });
});

app.patch('/api/family/:familyId', (req, res) => {
  const { name, birthDate, remindDays } = req.body;
  const params = [];
  const sets = [];

  if (name !== undefined) { sets.push('name = ?'); params.push(name); }
  if (birthDate !== undefined) { sets.push('birth_date = ?'); params.push(birthDate); }
  if (remindDays !== undefined) { sets.push('remind_days = ?'); params.push(remindDays); }

  if (sets.length) {
    params.push(req.params.familyId);
    db.run(`UPDATE families SET ${sets.join(', ')} WHERE id = ?`, params);
    saveDb();
  }
  res.json({ ok: true });
});

// ========== API - 记录 ==========

// ========== 图片上传 ==========
app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
  res.json({ url: '/photos/' + req.file.filename });
});

// ========== API - 记录 ==========

app.post('/api/records', (req, res) => {
  const { familyId, memberId, date, height, weight, head, note, photo } = req.body;
  if (!familyId || !memberId) return res.status(400).json({ error: '缺少必要参数' });

  const id = uuidv4().slice(0, 8);
  const recordDate = date || new Date().toISOString().split('T')[0];

  db.run(`INSERT INTO records (id, family_id, member_id, date, height, weight, head, note, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, familyId, memberId, recordDate, height || null, weight || null, head || null, note || null, photo || null]);

  saveDb();
  res.json({ id });
});

app.get('/api/records/:familyId', (req, res) => {
  const rows = db.exec(`
    SELECT r.id, r.family_id, r.member_id, r.date, r.height, r.weight, r.head, r.note, r.photo, r.created_at, m.name as member_name
    FROM records r
    LEFT JOIN members m ON r.member_id = m.id
    WHERE r.family_id = ?
    ORDER BY r.date DESC
  `, [req.params.familyId]);

  if (!rows.length) return res.json([]);
  
  const result = rows[0].values.map(v => {
    const obj = {};
    rows[0].columns.forEach((col, i) => obj[col] = v[i]);
    return obj;
  });
  res.json(result);
});

app.delete('/api/records/:id', (req, res) => {
  db.run(`DELETE FROM records WHERE id = ?`, [req.params.id]);
  saveDb();
  res.json({ ok: true });
});

// ========== API - 提醒检查 ==========

app.get('/api/reminder/:familyId', (req, res) => {
  const rows = db.exec(`SELECT id, name, remind_days FROM families WHERE id = ?`, [req.params.familyId]);
  if (!rows.length || !rows[0].values.length) {
    return res.status(404).json({ error: '家庭不存在' });
  }

  const family = {};
  rows[0].columns.forEach((col, i) => family[col] = rows[0].values[0][i]);

  const lastRows = db.exec(`SELECT date FROM records WHERE family_id = ? ORDER BY date DESC LIMIT 1`, [req.params.familyId]);

  if (!lastRows.length || !lastRows[0].values.length) {
    return res.json({ needRemind: true, message: '还没有记录过数据' });
  }

  const last = new Date(lastRows[0].values[0][0]);
  const now = new Date();
  const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));

  res.json({
    needRemind: diffDays >= family.remind_days,
    diffDays,
    remindDays: family.remind_days,
    lastDate: lastRows[0].values[0][0],
    message: diffDays >= family.remind_days
      ? `已经 ${diffDays} 天没有记录啦！`
      : `上次记录是 ${diffDays} 天前`
  });
});

// ========== API - 导出 ==========

app.get('/api/export/:familyId', (req, res) => {
  const famRows = db.exec(`SELECT * FROM families WHERE id = ?`, [req.params.familyId]);
  if (!famRows.length || !famRows[0].values.length) return res.status(404).json({ error: '家庭不存在' });

  const family = {};
  famRows[0].columns.forEach((col, i) => family[col] = famRows[0].values[0][i]);

  const memRows = db.exec(`SELECT id, name, is_admin FROM members WHERE family_id = ?`, [req.params.familyId]);
  const members = memRows.length ? memRows[0].values.map(v => {
    const m = {};
    memRows[0].columns.forEach((col, i) => m[col] = v[i]);
    return m;
  }) : [];

  const recRows = db.exec(`SELECT * FROM records WHERE family_id = ? ORDER BY date ASC`, [req.params.familyId]);
  const records = recRows.length ? recRows[0].values.map(v => {
    const r = {};
    recRows[0].columns.forEach((col, i) => r[col] = v[i]);
    return r;
  }) : [];

  res.json({ family, members, records });
});

// ========== 启动 ==========
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Baby Growth Server running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
});