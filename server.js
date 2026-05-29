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

// ----------------------------------------
// ディレクトリ設定
// ----------------------------------------
const DATA_FILE   = path.join(__dirname, 'data', 'db.json');
const DOCS_DIR    = path.join(__dirname, 'docs');
const IMAGES_DIR  = path.join(__dirname, 'page-images');
const PUBLIC_DIR  = path.join(__dirname, 'public');

[DOCS_DIR, IMAGES_DIR, PUBLIC_DIR, path.dirname(DATA_FILE)].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ----------------------------------------
// DB（JSON）
// ----------------------------------------
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) return { threads: [], docs: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

// ----------------------------------------
// Middleware
// ----------------------------------------
app.use(cors());
app.use(express.json());
// ページ画像を静的配信
app.use('/page-images', express.static(IMAGES_DIR));
app.use(express.static(PUBLIC_DIR));
app.use(express.static(__dirname));

// ----------------------------------------
// multer
// ----------------------------------------
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
// PDFからページ画像を生成する関数
// ----------------------------------------
async function generatePageImages(filePath, docId) {
  const outDir = path.join(IMAGES_DIR, docId);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  try {
    // pdftoppm でPDFを各ページPNGに変換（150dpi）
    execSync(`pdftoppm -r 150 -png "${filePath}" "${path.join(outDir, 'page')}"`, {
      timeout: 120000
    });

    // 生成されたファイル一覧を取得
    let files = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    // 見開き（横長）ページを左右に分割する
    const sharp = require('sharp');
    const splitFiles = [];
    for (const file of files) {
      const imgPath = path.join(outDir, file);
      const meta = await sharp(imgPath).metadata();
      // 横幅が縦の1.4倍以上なら見開きと判断して左右分割
      if (meta.width > meta.height * 1.4) {
        const half = Math.floor(meta.width / 2);
        const baseName = file.replace('.png', '');
        const leftFile  = baseName + '_L.png';
        const rightFile = baseName + '_R.png';
        await sharp(imgPath)
          .extract({ left: 0, top: 0, width: half, height: meta.height })
          .toFile(path.join(outDir, leftFile));
        await sharp(imgPath)
          .extract({ left: half, top: 0, width: meta.width - half, height: meta.height })
          .toFile(path.join(outDir, rightFile));
        fs.unlinkSync(imgPath);
        splitFiles.push(leftFile, rightFile);
      } else {
        splitFiles.push(file);
      }
    }
    files = splitFiles.sort();

    console.log(`ページ画像生成完了: ${files.length}枚 (docId: ${docId})`);
    return files.length;
  } catch (e) {
    console.error('ページ画像生成エラー:', e.message);
    return 0;
  }
}

// ----------------------------------------
// PDFテキスト抽出（ページマーカー付き）
// ----------------------------------------
async function extractTextWithPages(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const parsed = await pdfParse(dataBuffer, {
    // ページごとにコールバックでテキストを取得
    pagerender: function(pageData) {
      return pageData.getTextContent().then(function(textContent) {
        return textContent.items.map(item => item.str).join(' ');
      });
    }
  });

  // pdfParseのtextはページ区切りが\fになる場合がある
  // ページを分割してマーカーを付与
  const rawText = parsed.text;
  const pageCount = parsed.numpages;

  // \fで分割（PDFのページ区切り文字）
  const pages = rawText.split(/\f/);

  let markedText = '';
  pages.forEach((pageText, i) => {
    const pageNum = i + 1;
    if (pageNum > pageCount) return;
    const cleaned = pageText.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      markedText += `\n<!-- PAGE ${pageNum} -->\n${cleaned}\n`;
    }
  });

  return { text: markedText.trim(), pageCount };
}

// ----------------------------------------
// API: スレッド一覧
// ----------------------------------------
app.get('/api/threads', (req, res) => {
  const db = loadDB();
  res.json(db.threads);
});

app.post('/api/threads', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const db = loadDB();
  const thread = { id: 'th_' + Date.now(), name, createdAt: new Date().toISOString() };
  db.threads.push(thread);
  saveDB(db);
  res.json(thread);
});

app.delete('/api/threads/:id', (req, res) => {
  const db = loadDB();
  db.threads = db.threads.filter(t => t.id !== req.params.id);
  // 関連する資料も削除
  const docsToDelete = db.docs.filter(d => d.threadId === req.params.id);
  docsToDelete.forEach(doc => {
    const fp = path.join(DOCS_DIR, doc.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    // ページ画像も削除
    const imgDir = path.join(IMAGES_DIR, doc.id);
    if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true });
  });
  db.docs = db.docs.filter(d => d.threadId !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ----------------------------------------
// API: 資料一覧
// ----------------------------------------
app.get('/api/docs', (req, res) => {
  const { threadId } = req.query;
  const db = loadDB();
  const docs = threadId ? db.docs.filter(d => d.threadId === threadId) : db.docs;
  res.json(docs.map(d => ({
    id: d.id, threadId: d.threadId, name: d.name,
    size: d.size, pageCount: d.pageCount, status: d.status,
    uploadedAt: d.uploadedAt, hasImages: d.hasImages
  })));
});

// ----------------------------------------
// API: 資料アップロード（PDF画像化対応）
// ----------------------------------------
app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  const { threadId } = req.body;
  if (!req.file || !threadId) return res.status(400).json({ error: 'file and threadId required' });

  const filePath = req.file.path;
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(originalName).toLowerCase();

  let content = '';
  let pageCount = null;
  let hasImages = false;

  try {
    if (ext === '.pdf') {
      console.log(`PDF解析開始: ${originalName}`);
      const result = await extractTextWithPages(filePath);
      content = result.text;
      pageCount = result.pageCount;
      console.log(`テキスト抽出完了: ${pageCount}ページ, ${content.length}文字`);
    } else {
      content = fs.readFileSync(filePath, 'utf8');
      pageCount = null;
    }
  } catch (e) {
    console.error('テキスト抽出エラー:', e.message);
    return res.status(500).json({ error: 'ファイルの解析に失敗しました: ' + e.message });
  }

  // DocIDを先に確定
  const docId = 'doc_' + Date.now();

  // PDFならページ画像を生成
  if (ext === '.pdf') {
    console.log(`ページ画像生成開始: ${originalName}`);
    const imgCount = await generatePageImages(filePath, docId);
    hasImages = imgCount > 0;
    console.log(`ページ画像: ${imgCount}枚`);
  }

  const db = loadDB();
  const doc = {
    id: docId,
    threadId,
    name: originalName,
    filename: req.file.filename,
    size: (req.file.size / 1024).toFixed(0) + ' KB',
    pageCount,
    hasImages,
    status: 'active',
    content,
    uploadedAt: new Date().toISOString()
  };
  db.docs.push(doc);
  saveDB(db);

  res.json({
    id: doc.id, name: doc.name, size: doc.size,
    pageCount: doc.pageCount, hasImages: doc.hasImages,
    status: doc.status, uploadedAt: doc.uploadedAt
  });
});

// ----------------------------------------
// API: 資料ステータス変更（有効/旧版）
// ----------------------------------------
app.patch('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const doc = db.docs.find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'not found' });
  if (req.body.status) doc.status = req.body.status;
  saveDB(db);
  res.json({ ok: true });
});

// ----------------------------------------
// API: 資料削除
// ----------------------------------------
app.delete('/api/docs/:id', (req, res) => {
  const db = loadDB();
  const doc = db.docs.find(d => d.id === req.params.id);
  if (doc) {
    const fp = path.join(DOCS_DIR, doc.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    // ページ画像ディレクトリも削除
    const imgDir = path.join(IMAGES_DIR, doc.id);
    if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true });
  }
  db.docs = db.docs.filter(x => x.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ----------------------------------------
// API: チャット（RAG＋ページ番号付き出典）
// ----------------------------------------
app.post('/api/chat', async (req, res) => {
  const { threadId, message, history } = req.body;
  if (!message || !threadId) return res.status(400).json({ error: 'threadId and message required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEYが設定されていません。' });

  const db = loadDB();
  const thread = db.threads.find(t => t.id === threadId);
  if (!thread) return res.status(404).json({ error: 'thread not found' });

  const activeDocs = db.docs.filter(d => d.threadId === threadId && d.status === 'active' && d.content);

  let systemPrompt = `あなたは「${thread.name}」専用のサポートAIです。
以下のルールを必ず守って、顧客からの質問に日本語で丁寧に答えてください。

【最優先ルール：コース・学年の確認】
資料に複数のコースや学年・校舎などが含まれている場合、質問に対してどのコース・学年・校舎が対象か明確でないときは、絶対に回答内容を出さず、必ず先に「どのコース（または学年・校舎）についてのご質問でしょうか？」と確認してください。確認が取れてから初めて回答してください。

【回答ルール】
1. 登録された資料の内容をもとに回答してください。
2. 回答はMarkdownの記号（#、**、- など）を使わず、自然な会話文で書いてください。
3. 資料に記載のある内容について回答した場合は、回答の最後に必ず以下の形式で出典を示してください：
   【出典: 資料名・Xページ】
   ※ページ番号は資料内の <!-- PAGE X --> マーカーを参照して特定してください。複数ページにまたがる場合は「X〜Yページ」としてください。
4. 資料に記載のない内容については「資料には記載がないため、直接お問い合わせください」と答えてください。
5. 質問が曖昧な場合は「〇〇を教えていただけますか？」と聞き返してください。

`;

  if (activeDocs.length > 0) {
    systemPrompt += '【登録資料】\n';
    activeDocs.forEach(doc => {
      systemPrompt += `\n=== ${doc.name} ===\n${doc.content}\n`;
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

    const rawText = response.content[0].text;
    console.log('=== AI RAW OUTPUT ===');
    console.log(rawText.slice(-300));
    console.log('=== END ===');

    // 出典パース（柔軟に対応）: 【出典: 資料名・Xページ】【出典: 資料名（Xページ）】など
    const sourceMatch = rawText.match(/【出典[:：]\s*(.+?)[・・（(]\s*(\d+(?:[〜~]\d+)?\s*ページ?)[）)]?\s*】/);
    let source = null;
    let pageNum = null;
    let docId = null;

    if (sourceMatch) {
      const sourceDocName = sourceMatch[1].trim();
      const pageStr = sourceMatch[2].replace(/ページ/g, '').trim();
      pageNum = parseInt(pageStr.split(/[〜~]/)[0]);

      const matchedDoc = activeDocs.find(d =>
        d.name === sourceDocName ||
        d.name.includes(sourceDocName) ||
        sourceDocName.includes(d.name) ||
        d.name.replace(/\.pdf$/i, '') === sourceDocName ||
        sourceDocName.includes(d.name.replace(/\.pdf$/i, ''))
      );
      if (matchedDoc) {
        docId = matchedDoc.id;
        source = {
          docName: matchedDoc.name,
          pageLabel: sourceMatch[2].trim(),
          pageNum,
          docId,
          hasImages: matchedDoc.hasImages
        };
      }
    }

    // 出典タグを本文から除去 + Markdown記号を除去
    let cleanText = rawText.replace(/【出典[:：].+?】/g, '').trim();
    cleanText = cleanText
      .replace(/\*\*(.+?)\*\*/g, '$1')   // **太字** → 太字
      .replace(/#{1,6}\s+/g, '')             // ## 見出し → 除去
      .replace(/^[-*]\s+/gm, '・')           // - リスト → ・
      .trim();

    res.json({ text: cleanText, source, threadName: thread.name });
  } catch (err) {
    console.error('Anthropic API error:', err.message);
    res.status(500).json({ error: 'AI APIエラー: ' + err.message });
  }
});

// ----------------------------------------
// API: ページ画像URL取得
// ----------------------------------------
app.get('/api/page-image/:docId/:pageNum', (req, res) => {
  const { docId, pageNum } = req.params;
  const imgDir = path.join(IMAGES_DIR, docId);

  if (!fs.existsSync(imgDir)) {
    return res.status(404).json({ error: 'images not found' });
  }

  // pdftoppmが生成するファイル名パターン: page-01.png, page-001.png など
  const files = fs.readdirSync(imgDir).filter(f => f.endsWith('.png')).sort();
  const targetIdx = parseInt(pageNum) - 1;

  if (targetIdx < 0 || targetIdx >= files.length) {
    return res.status(404).json({ error: 'page not found' });
  }

  const imageUrl = `/page-images/${docId}/${files[targetIdx]}`;
  res.json({ url: imageUrl, filename: files[targetIdx] });
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
    console.log('     .env ファイルに ANTHROPIC_API_KEY=sk-ant-... を追加してください。');
  }
});
