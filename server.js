require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse  = require('pdf-parse');

const app  = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const PERSIST_DIR = path.join(__dirname, 'data');
const DATA_FILE   = path.join(PERSIST_DIR, 'db.json');
const DOCS_DIR    = path.join(PERSIST_DIR, 'docs');
const IMAGES_DIR  = path.join(PERSIST_DIR, 'page-images');
const PUBLIC_DIR  = path.join(__dirname, 'public');

[DOCS_DIR, IMAGES_DIR, PUBLIC_DIR, path.dirname(DATA_FILE)].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) return { threads: [], docs: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

app.use(cors());
app.use(express.json());
app.use('/page-images', express.static(IMAGES_DIR));
app.use(express.static(PUBLIC_DIR));
app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: DOCS_DIR,
  filename: (req, file, cb) => {
    const name = Date.now() + '_' + Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(Buffer.from(file.originalname, 'latin1').toString('utf8')).toLowerCase();
    if (ext === '.pdf' || ext === '.txt') cb(null, true);
    else cb(new Error('PDF または TXT のみアップロードできます'));
  }
});

// ----------------------------------------
// ファイル名からコース・学年を抽出
// ファイル名例: 中学受験コース小4.pdf / 中学受験コース小4αクラス.pdf
// ----------------------------------------
function parseDocName(name) {
  const base = name.replace(/\.pdf$/i, '');
  const isAlpha = base.includes('α') || base.includes('α');
  // 学年を抽出（小1〜小6、中1〜中3など）
  const gradeMatch = base.match(/(小[1-6]|中[1-3])/);
  const grade = gradeMatch ? gradeMatch[1] : null;
  // コース名：学年以降を末尾から除去
  // 例: 「高校受験コース小4」→「高校受験コース」
  // αクラス単体ファイル例: 「中学受験コース_αクラス」→course=「中学受験コース」, grade=null, isAlpha=true
  let course = base;
  if (grade) {
    const gradeIdx = base.indexOf(grade);
    course = base.slice(0, gradeIdx).trim();
  } else {
    // 学年なし（αクラス単体ファイルなど）
    course = base.replace(/_?αクラス|_?αクラス/g, '').trim();
  }
  return { course, grade, isAlpha };
}

// ----------------------------------------
// PDFページ画像生成
// ----------------------------------------
async function generatePageImages(filePath, docId) {
  const outDir = path.join(IMAGES_DIR, docId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  try {
    execSync(`pdftoppm -r 150 -png "${filePath}" "${path.join(outDir, 'page')}"`, {
      timeout: 120000
    });

    const rawFiles = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    const sharp = require('sharp');
    const pageMap = {};

    for (let i = 0; i < rawFiles.length; i++) {
      const pageNum = i + 1;
      const oldPath = path.join(outDir, rawFiles[i]);
      const newName = 'p' + String(pageNum).padStart(3, '0') + '.png';
      const newPath = path.join(outDir, newName);
      await sharp(oldPath).toFile(newPath);
      if (rawFiles[i] !== newName) fs.unlinkSync(oldPath);
      pageMap[pageNum] = newName;
    }

    fs.writeFileSync(path.join(outDir, 'pagemap.json'), JSON.stringify(pageMap, null, 2));
    console.log(`ページ画像生成完了: ${rawFiles.length}ページ (docId: ${docId})`);
    return rawFiles.length;
  } catch (e) {
    console.error('ページ画像生成エラー:', e.message);
    return 0;
  }
}

// ----------------------------------------
// PDFテキスト抽出
// ----------------------------------------
async function extractTextWithPages(filePath) {
  let pageCount = 0;
  try {
    const pdfInfo = execSync(`pdfinfo "${filePath}"`, { encoding: 'utf8' });
    const match = pdfInfo.match(/Pages:\s*(\d+)/);
    if (match) pageCount = parseInt(match[1]);
  } catch(e) {
    const dataBuffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(dataBuffer);
    pageCount = parsed.numpages;
  }

  let markedText = '';
  for (let page = 1; page <= pageCount; page++) {
    try {
      const pageText = execSync(
        `pdftotext -f ${page} -l ${page} "${filePath}" -`,
        { timeout: 30000, encoding: 'utf8' }
      );
      const cleaned = pageText.replace(/\s+/g, ' ').trim();
      if (cleaned) {
        markedText += `\n<!-- PAGE ${page} -->\n${cleaned}\n`;
      }
    } catch (e) {
      console.error(`ページ${page}のテキスト抽出エラー:`, e.message);
    }
  }

  console.log(`テキスト抽出完了: ${pageCount}ページ, ${markedText.length}文字`);
  return { text: markedText.trim(), pageCount };
}

// ----------------------------------------
// スレッドAPI
// ----------------------------------------
app.get('/api/threads', (req, res) => {
  res.json(loadDB().threads);
});

app.post('/api/threads', (req, res) => {
  const db = loadDB();
  const thread = { id: 'thread_' + Date.now(), name: req.body.name, createdAt: new Date().toISOString() };
  db.threads.push(thread);
  saveDB(db);
  res.json(thread);
});

app.delete('/api/threads/:id', (req, res) => {
  const db = loadDB();
  db.docs.filter(d => d.threadId === req.params.id).forEach(doc => {
    const fp = path.join(DOCS_DIR, doc.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const imgDir = path.join(IMAGES_DIR, doc.id);
    if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true });
  });
  db.docs = db.docs.filter(d => d.threadId !== req.params.id);
  db.threads = db.threads.filter(t => t.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ----------------------------------------
// 資料API
// ----------------------------------------
app.get('/api/docs', (req, res) => {
  const db = loadDB();
  const docs = db.docs.filter(d => d.threadId === req.query.threadId);
  res.json(docs.map(d => ({ ...d, content: undefined })));
});

app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  try {
    const { threadId } = req.body;
    if (!threadId) return res.status(400).json({ error: 'threadId required' });

    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const ext  = path.extname(originalName).toLowerCase();
    const isPdf = ext === '.pdf';
    const docId = 'doc_' + Date.now();
    const filePath = req.file.path;
    const stat = fs.statSync(filePath);
    const sizeKB = Math.round(stat.size / 1024) + ' KB';

    let content = '';
    let pageCount = 0;
    let hasImages = false;

    console.log(`PDF解析開始: ${originalName}`);

    if (isPdf) {
      const result = await extractTextWithPages(filePath);
      content = result.text;
      pageCount = result.pageCount;
      const imgCount = await generatePageImages(filePath, docId);
      hasImages = imgCount > 0;
      console.log(`ページ画像: ${imgCount}枚`);
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }

    const doc = {
      id: docId,
      threadId,
      name: originalName,
      filename: path.basename(filePath),
      size: sizeKB,
      pageCount: pageCount || undefined,
      hasImages,
      status: 'active',
      uploadedAt: new Date().toISOString(),
      content
    };

    const db = loadDB();
    db.docs.push(doc);
    saveDB(db);

    res.json({ ...doc, content: undefined });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const doc = db.docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (req.body.status) doc.status = req.body.status;
  saveDB(db);
  res.json({ ok: true });
});

app.delete('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const doc = db.docs.find(d => d.id === req.params.id);
  if (doc) {
    const fp = path.join(DOCS_DIR, doc.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const imgDir = path.join(IMAGES_DIR, doc.id);
    if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true });
  }
  db.docs = db.docs.filter(x => x.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ----------------------------------------
// API: コース・学年一覧（ファイル名から生成）
// ----------------------------------------
app.get('/api/options', (req, res) => {
  const { threadId } = req.query;
  const db = loadDB();
  const activeDocs = db.docs.filter(d => d.threadId === threadId && d.status === 'active');

  // コース一覧
  const courses = [...new Set(activeDocs.map(d => parseDocName(d.name).course).filter(Boolean))];

  // コースごとの学年一覧（αあり・なし両方）
  const gradesByCourse = {};
  for (const course of courses) {
    const docs = activeDocs.filter(d => parseDocName(d.name).course === course);
    const grades = [];
    const seen = new Set();

    // 通常ファイル（学年あり）
    for (const doc of docs) {
      const { grade, isAlpha } = parseDocName(doc.name);
      if (!grade) continue;
      const label = isAlpha ? `${grade}α` : grade;
      if (!seen.has(label)) {
        seen.add(label);
        grades.push(label);
      }
    }

    // αクラス単体ファイル（grade=null, isAlpha=true）があれば
    // 小3α〜小6αを追加（通常ファイルの学年に合わせてα版を生成）
    const hasAlphaFile = docs.some(d => {
      const p = parseDocName(d.name);
      return p.isAlpha && !p.grade;
    });
    if (hasAlphaFile) {
      // 通常ファイルの学年からα版を生成
      const normalGrades = docs
        .map(d => parseDocName(d.name))
        .filter(p => p.grade && !p.isAlpha)
        .map(p => p.grade);
      for (const g of normalGrades) {
        const alphaLabel = `${g}α`;
        if (!seen.has(alphaLabel)) {
          seen.add(alphaLabel);
          grades.push(alphaLabel);
        }
      }
    }

    // 学年順にソート
    grades.sort((a, b) => {
      const numA = parseInt(a.replace(/[^0-9]/g, ''));
      const numB = parseInt(b.replace(/[^0-9]/g, ''));
      if (numA !== numB) return numA - numB;
      return a.includes('α') ? 1 : -1; // 同学年ならノーマル先
    });

    gradesByCourse[course] = grades;
  }

  res.json({ courses, gradesByCourse });
});

// ----------------------------------------
// API: 資料検索（コース+学年でdocIdを返す）
// ----------------------------------------
app.get('/api/find-doc', (req, res) => {
  const { threadId, course, grade } = req.query;
  const db = loadDB();
  const activeDocs = db.docs.filter(d => d.threadId === threadId && d.status === 'active');

  const isAlpha = grade && grade.includes('α');
  const gradeBase = grade ? grade.replace('α', '').trim() : '';

  let matched = null;
  if (isAlpha) {
    // α選択時：まず「コース_αクラス.pdf」のような単体αファイルを探す
    matched = activeDocs.find(d => {
      const parsed = parseDocName(d.name);
      return parsed.course === course && parsed.isAlpha && !parsed.grade;
    });
    // なければ学年付きαファイルを探す
    if (!matched) {
      matched = activeDocs.find(d => {
        const parsed = parseDocName(d.name);
        return parsed.course === course && parsed.grade === gradeBase && parsed.isAlpha;
      });
    }
  } else {
    matched = activeDocs.find(d => {
      const parsed = parseDocName(d.name);
      return parsed.course === course && parsed.grade === gradeBase && !parsed.isAlpha;
    });
  }

  if (!matched) return res.status(404).json({ error: 'doc not found' });
  res.json({ docId: matched.id, docName: matched.name, hasImages: matched.hasImages, pageCount: matched.pageCount });
});

// ----------------------------------------
// API: 全ページ画像URL取得
// ----------------------------------------
app.get('/api/all-page-images/:docId', (req, res) => {
  const { docId } = req.params;
  const imgDir = path.join(IMAGES_DIR, docId);

  if (!fs.existsSync(imgDir)) {
    return res.status(404).json({ error: 'images not found' });
  }

  const pagemapPath = path.join(imgDir, 'pagemap.json');
  let urls = [];

  if (fs.existsSync(pagemapPath)) {
    const pageMap = JSON.parse(fs.readFileSync(pagemapPath, 'utf8'));
    const pages = Object.keys(pageMap).map(Number).sort((a, b) => a - b);
    urls = pages.map(p => `/page-images/${docId}/${pageMap[p]}`);
  } else {
    const files = fs.readdirSync(imgDir).filter(f => f.endsWith('.png')).sort();
    urls = files.map(f => `/page-images/${docId}/${f}`);
  }

  res.json({ urls });
});

// ----------------------------------------
// API: フリーテキストからコース・学年を判定
// ----------------------------------------
app.post('/api/identify', async (req, res) => {
  const { threadId, message } = req.body;
  if (!message || !threadId) return res.status(400).json({ error: 'required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not set' });

  const db = loadDB();
  const activeDocs = db.docs.filter(d => d.threadId === threadId && d.status === 'active');
  const courses = [...new Set(activeDocs.map(d => parseDocName(d.name).course).filter(Boolean))];

  // 全コース・学年リストをAIに渡してユーザーの入力から判定させる
  const gradesByCourse = {};
  for (const course of courses) {
    const docs = activeDocs.filter(d => parseDocName(d.name).course === course);
    const grades = new Set();
    docs.forEach(d => {
      const p = parseDocName(d.name);
      if (p.grade) grades.add(p.grade);
    });
    gradesByCourse[course] = [...grades];
  }

  const prompt = `以下のコース・学年の一覧があります：
${JSON.stringify(gradesByCourse, null, 2)}

ユーザーの入力：「${message}」

この入力から、コース名と学年を特定してください。
以下のJSON形式のみで回答してください（説明不要）：
{"course": "コース名またはnull", "grade": "学年またはnull"}

特定できない場合はnullを返してください。学年はαなしのみ返してください（αの判定はシステムが行います）。`;

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = response.content[0].text.trim();
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json({
      course: json.course || null,
      grade: json.grade || null
    });
  } catch(e) {
    console.error('identify error:', e.message);
    res.json({ course: null, grade: null });
  }
});

// ----------------------------------------
// API: チャット（新方式：AIは使わずファイル名で直接検索）
// ----------------------------------------
app.post('/api/chat', async (req, res) => {
  const { threadId, message, history } = req.body;
  if (!message || !threadId) return res.status(400).json({ error: 'threadId and message required' });

  // この新方式ではchatエンドポイントはAI応答は不要
  // フロントエンドがボタン選択でfind-docを直接呼ぶため
  // 既存互換のため残す
  res.json({ text: '', source: null, threadName: '' });
});

// ----------------------------------------
// API: ページ画像URL取得（単ページ・互換用）
// ----------------------------------------
app.get('/api/page-image/:docId/:pageNum', (req, res) => {
  const { docId, pageNum } = req.params;
  const imgDir = path.join(IMAGES_DIR, docId);

  if (!fs.existsSync(imgDir)) {
    return res.status(404).json({ error: 'images not found' });
  }

  const num = parseInt(pageNum);
  let found = null;

  const pagemapPath = path.join(imgDir, 'pagemap.json');
  if (fs.existsSync(pagemapPath)) {
    const pageMap = JSON.parse(fs.readFileSync(pagemapPath, 'utf8'));
    found = pageMap[num] || null;
    if (!found) {
      const keys = Object.keys(pageMap).map(Number).sort((a, b) => a - b);
      const closest = keys.reduce((prev, cur) =>
        Math.abs(cur - num) < Math.abs(prev - num) ? cur : prev
      );
      found = pageMap[closest] || null;
    }
  } else {
    const files = fs.readdirSync(imgDir).filter(f => f.endsWith('.png')).sort();
    const target = 'p' + String(num).padStart(3, '0') + '.png';
    found = files.includes(target) ? target : (files[num - 1] || null);
  }

  if (!found) return res.status(404).json({ error: 'page not found' });
  res.json({ url: `/page-images/${docId}/${found}`, filename: found });
});

// ----------------------------------------
// 起動
// ----------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ StudyBase サーバー起動中');
  console.log(`  📋 管理画面: http://localhost:${PORT}/admin.html`);
  console.log(`  💬 チャット: http://localhost:${PORT}/chat.html`);
  console.log('');
  if (!ANTHROPIC_API_KEY) {
    console.log('  ⚠️  ANTHROPIC_API_KEY が未設定です。');
  }
});
