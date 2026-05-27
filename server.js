const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const Tesseract = require('tesseract.js');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const DOCS_DIR = path.join(__dirname, 'data', 'docs');

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR);

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const init = {
      threads: [
        { id: 'thread_1', name: '○○塾 2026年度 コース案内', slug: '2026-course', active: true, createdAt: new Date().toISOString() }
      ],
      docs: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

async function extractPdfText(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const parsed = await pdfParse(buf);
    const text = parsed.text.replace(/\s+\n/g, '\n').trim();
    if (text.length > 100) {
      console.log(`テキストPDF解析完了: ${parsed.numpages}ページ, ${text.length}文字`);
      return { text, pageCount: parsed.numpages, method: 'text' };
    }
    console.log('テキスト抽出が少ない、OCRを試みます...');
  } catch(e) {
    console.log('通常解析失敗、OCRを試みます:', e.message);
  }
  return await ocrPdfWithTesseractJs(filePath);
}

async function ocrPdfWithTesseractJs(filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studybase-ocr-'));
  const outBase = path.join(tmpDir, 'page');

  try {
    // pdftoppmが使えるか確認
    let hasPdftoppm = false;
    try {
      execSync('which pdftoppm', { timeout: 5000 });
      hasPdftoppm = true;
    } catch(e) {}

    let pages = [];

    if (hasPdftoppm) {
      execSync(`pdftoppm -r 150 -png "${filePath}" "${outBase}"`, { timeout: 120000 });
      pages = fs.readdirSync(tmpDir).filter(f => f.endsWith('.png')).sort();
    } else {
      // pdftoppmがない場合はpdf-parseで再試行（テキストが少なくても返す）
      const buf = fs.readFileSync(filePath);
      const parsed = await pdfParse(buf);
      const text = parsed.text.trim();
      if (text.length > 0) {
        return { text, pageCount: parsed.numpages, method: 'text-fallback' };
      }
      throw new Error('PDFからテキストを抽出できませんでした。テキスト登録をお試しください。');
    }

    if (!pages.length) throw new Error('PDFを画像に変換できませんでした');

    console.log(`tesseract.js OCR開始: ${pages.length}ページ`);
    let fullText = '';

    for (const page of pages) {
      const imgPath = path.join(tmpDir, page);
      try {
        const result = await Tesseract.recognize(imgPath, 'jpn+eng', {
          logger: m => { if (m.status === 'recognizing text') console.log(`OCR進捗: ${Math.round(m.progress * 100)}%`); }
        });
        fullText += result.data.text + '\n';
      } catch(e) {
        console.log(`ページOCR失敗 (${page}):`, e.message);
      }
    }

    return { text: fullText.trim(), pageCount: pages.length, method: 'ocr' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
  }
}

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
    if (['.pdf', '.txt', '.text'].includes(ext) || file.mimetype === 'application/pdf' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('PDF または TXT ファイルのみアップロードできます'));
    }
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/api/threads', (req, res) => {
  const db = loadDB();
  const threads = db.threads.map(t => {
    const docs = db.docs.filter(d => d.threadId === t.id);
    return { ...t, docCount: docs.length, activeDocs: docs.filter(d => d.status === 'active').length };
  });
  res.json(threads);
});

app.post('/api/threads', (req, res) => {
  const { name, slug } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const db = loadDB();
  const thread = {
    id: 'thread_' + Date.now(),
    name,
    slug: slug || name.toLowerCase().replace(/\s+/g, '-'),
    active: true,
    createdAt: new Date().toISOString()
  };
  db.threads.push(thread);
  saveDB(db);
  res.json(thread);
});

app.patch('/api/threads/:id', (req, res) => {
  const db = loadDB();
  const t = db.threads.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  Object.assign(t, req.body);
  saveDB(db);
  res.json(t);
});

app.delete('/api/threads/:id', (req, res) => {
  const db = loadDB();
  db.threads = db.threads.filter(x => x.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/docs', (req, res) => {
  const db = loadDB();
  const { threadId } = req.query;
  const docs = threadId ? db.docs.filter(d => d.threadId === threadId) : db.docs;
  res.json(docs);
});

app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  const { threadId } = req.body;
  if (!req.file || !threadId) return res.status(400).json({ error: 'file and threadId required' });

  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(originalName).toLowerCase();

  let content = '';
  let pageCount = null;
  let ocrUsed = false;

  try {
    if (ext === '.pdf' || req.file.mimetype === 'application/pdf') {
      const result = await extractPdfText(filePath);
      content = result.text;
      pageCount = result.pageCount;
      ocrUsed = result.method === 'ocr';
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
  } catch(e) {
    console.error('解析エラー:', e.message);
    return res.status(500).json({ error: 'ファイル解析失敗: ' + e.message });
  }

  if (!content || content.length < 10) {
    return res.status(400).json({ error: 'テキストを抽出できませんでした。テキスト登録をお試しください。' });
  }

  const db = loadDB();
  const doc = {
    id: 'doc_' + Date.now(),
    threadId,
    name: originalName,
    filename: req.file.filename,
    size: (req.file.size / 1024).toFixed(0) + ' KB',
    pageCount,
    ocrUsed,
    status: 'active',
    content,
    uploadedAt: new Date().toISOString()
  };
  db.docs.push(doc);
  saveDB(db);
  res.json(doc);
});

app.post('/api/docs/text', (req, res) => {
  const { threadId, name, content } = req.body;
  if (!threadId || !name || !content) return res.status(400).json({ error: 'threadId, name, content required' });
  const db = loadDB();
  const doc = {
    id: 'doc_' + Date.now(),
    threadId, name,
    filename: null,
    size: (Buffer.byteLength(content, 'utf8') / 1024).toFixed(0) + ' KB',
    pageCount: null,
    ocrUsed: false,
    status: 'active',
    content,
    uploadedAt: new Date().toISOString()
  };
  db.docs.push(doc);
  saveDB(db);
  res.json(doc);
});

app.patch('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const d = db.docs.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  Object.assign(d, req.body);
  saveDB(db);
  res.json(d);
});

app.delete('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const d = db.docs.find(x => x.id === req.params.id);
  if (d && d.filename) {
    const fp = path.join(DOCS_DIR, d.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.docs = db.docs.filter(x => x.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const { threadId, message, history } = req.body;
  if (!message || !threadId) return res.status(400).json({ error: 'threadId and message required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEYが設定されていません。' });

  const db = loadDB();
  const thread = db.threads.find(t => t.id === threadId);
  if (!thread) return res.status(404).json({ error: 'thread not found' });

  const activeDocs = db.docs.filter(d => d.threadId === threadId && d.status === 'active' && d.content);

  let systemPrompt = `あなたは「${thread.name}」専用のサポートAIです。
以下のルールに従って、保護者・生徒からの質問に日本語で丁寧に、会話形式で答えてください。

【回答ルール】
1. 質問に学年・校舎・コースなど必要な情報が不足している場合は、不足している情報だけを質問してください。その際、回答の内容は一切出さないでください。情報が揃ってから初めて回答してください。
2. 回答はMarkdownの記号（#、**、- など）を使わず、自然な会話文で書いてください。
3. 資料に記載のある内容について回答した場合は、回答の最後に必ず【出典: 資料名・〇ページ】の形式で出典を示してください。ページ数が不明な場合は資料名のみ記載してください。
4. 資料に記載のない内容については「資料には記載がないため、直接お問い合わせください」と答えてください。
5. 回答は簡潔にまとめ、読みやすい文章にしてください。\n\n`;

  if (activeDocs.length > 0) {
    systemPrompt += '【登録資料】\n';
    activeDocs.forEach(doc => {
      systemPrompt += `\n--- ${doc.name} ---\n${doc.content}\n`;
    });
  } else {
    systemPrompt += '現在、有効な資料が登録されていません。一般的な案内のみ対応してください。';
  }

  const messages = (history || []).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text
  }));
  messages.push({ role: 'user', content: message });

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });
    const text = response.content[0].text;
    const sourceMatch = text.match(/【出典[:：]\s*(.+?)】/);
    const source = sourceMatch ? sourceMatch[1].trim() : null;
    const cleanText = text.replace(/【出典[:：].+?】/g, '').trim();
    res.json({ text: cleanText, source, threadName: thread.name });
  } catch(err) {
    console.error('Anthropic API error:', err.message);
    res.status(500).json({ error: 'AI APIエラー: ' + err.message });
  }
});

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
