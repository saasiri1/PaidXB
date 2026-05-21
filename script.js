let allQuestions = [];
let filteredQ    = [];
let currentPage  = 1;
const PAGE_SIZE  = 25;


window.onload = () => { setupDrop(); };

function setupDrop() {
  const dz = document.getElementById('dropZone');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  });
}

function handleFileInput(e) {
  if (e.target.files[0]) processFile(e.target.files[0]);
}


function processFile(file) {
  clearStatus();
  showProgress(true, 0, 'جاري فتح الملف…');

  const reader = new FileReader();
  reader.onload = async e => {
    try {
      allQuestions = await parseQtiZip(new Uint8Array(e.target.result));
      onLoaded();
    } catch (err) {
      showProgress(false);
      showStatus(err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}


async function parseQtiZip(data) {
  const zip = await JSZip.loadAsync(data);

  // Collect all assessmentItem XML files (QTI 2.1 format)
  const xmlFiles = [];
  zip.forEach((path, file) => {
    if (/assessmentItem\d+\.xml$/i.test(path) && !file.dir) {
      xmlFiles.push({ path, file });
    }
  });

  if (xmlFiles.length === 0) {
    let datEntry = null;
    zip.forEach((path, file) => {
      if (/\.dat$/i.test(path) && !file.dir) datEntry = file;
    });
    if (datEntry) {
      const datText = await datEntry.async('text');
      if (datText.includes('<POOL>')) {
        showProgress(true, 50, 'جاري معالجة ملف بنك الأسئلة…');
        const questions = parsePoolDat(datText);
        showProgress(false);
        if (questions.length === 0)
          throw new Error('لم يتم التعرف على أي أسئلة في الملف.');
        return questions;
      }
    }
    throw new Error('لم يتم العثور على ملفات أسئلة داخل الـ ZIP. تأكد من أن الملف مُصدَّر من Blackboard.');
  }


  xmlFiles.sort((a, b) => a.path.localeCompare(b.path));

  const questions = [];
  const total = xmlFiles.length;

  for (let i = 0; i < total; i++) {
    showProgress(true, Math.round(((i + 1) / total) * 100), `جاري معالجة السؤال ${i + 1} من ${total}…`);
    const xmlText = await xmlFiles[i].file.async('text');
    const q = parseQtiItem(xmlText);
    if (q) questions.push(q);
  }

  showProgress(false);

  if (questions.length === 0)
    throw new Error('لم يتم التعرف على أي أسئلة في الملفات.');

  return questions;
}

function parseQtiItem(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, 'application/xml');

  if (doc.documentElement.nodeName === 'parsererror') return null;

  const byTag = (root, name) => [...root.getElementsByTagNameNS('*', name)];

  const crEls = byTag(doc, 'correctResponse');
  if (!crEls.length) return null;
  const valEls = byTag(crEls[0], 'value');
  if (!valEls.length) return null;
  const correctIdentifier = valEls[0].textContent.trim();

  const ibEls = byTag(doc, 'itemBody');
  if (!ibEls.length) return null;
  const itemBody = ibEls[0];

  const allDivs = byTag(itemBody, 'div');
  const rawText = allDivs.length >= 2
    ? allDivs[1].textContent
    : allDivs.length === 1
      ? allDivs[0].textContent
      : itemBody.textContent;
  const questionText = cleanQuestionText(rawText);
  if (!questionText) return null;

  const choices = byTag(itemBody, 'simpleChoice');
  if (!choices.length) return null;

  const options = choices.map(c => {
    const inner = byTag(c, 'div');
    const rawOpt = inner.length ? inner[0].textContent : c.textContent;
    return cleanOptionText(rawOpt) || null;
  });
  while (options.length < 4) options.push(null);

  let correctAnswer = null;
  let isTF = false;

  if (/_true$/i.test(correctIdentifier)) {
    isTF = true;
    correctAnswer = 'A';
  } else if (/_false$/i.test(correctIdentifier)) {
    isTF = true;
    correctAnswer = 'B';
  } else {
    let idx = choices.findIndex(c => c.getAttribute('identifier') === correctIdentifier);
    if (idx < 0) {
      const m = correctIdentifier.match(/(\d+)$/);
      if (m) idx = parseInt(m[1], 10) - 1;
    }
    correctAnswer = idx >= 0 ? String.fromCharCode(65 + idx) : null;
  }

  if (choices.length === 2) isTF = true;

  const type = isTF ? 'True_or_False' : 'Multiple_Choice_Single_Answer';
  return { text: questionText, type, options: options.slice(0, 4), correctAnswer };
}


function parsePoolDat(datText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(datText, 'application/xml');
  if (doc.documentElement.nodeName === 'parsererror')
    throw new Error('تعذّر قراءة ملف الأسئلة (.dat).');

  const questions = [];

  const parsePoolEl = (el, isTF) => {
    const id = el.getAttribute('id') || '';

    const bodyEl = el.getElementsByTagName('BODY')[0];
    if (!bodyEl) return null;
    const textEl = bodyEl.getElementsByTagName('TEXT')[0];
    if (!textEl) return null;
    const questionText = textEl.textContent.trim();
    if (!questionText) return null;

    const answerEls = [...el.getElementsByTagName('ANSWER')].sort((a, b) =>
      parseInt(a.getAttribute('position') || '0') - parseInt(b.getAttribute('position') || '0')
    );

    const idToIdx = {};
    answerEls.forEach((a, i) => { idToIdx[a.getAttribute('id')] = i; });

    const options = answerEls.map(a => {
      const t = a.getElementsByTagName('TEXT')[0];
      return t ? (t.textContent.trim() || null) : null;
    });
    while (options.length < 4) options.push(null);

    const gradable = el.getElementsByTagName('GRADABLE')[0];
    let correctAnswer = null;
    if (gradable) {
      const ca = gradable.getElementsByTagName('CORRECTANSWER')[0];
      if (ca) {
        const idx = idToIdx[ca.getAttribute('answer_id')];
        if (idx !== undefined) correctAnswer = String.fromCharCode(65 + idx);
      }
    }

    return {
      _sortId: parseInt(id.replace(/\D/g, ''), 10) || 0,
      text: questionText,
      type: isTF ? 'True_or_False' : 'Multiple_Choice_Single_Answer',
      options: options.slice(0, 4),
      correctAnswer,
    };
  };

  [...doc.getElementsByTagName('QUESTION_MULTIPLECHOICE')].forEach(el => {
    const q = parsePoolEl(el, false);
    if (q) questions.push(q);
  });
  [...doc.getElementsByTagName('QUESTION_TRUEFALSE')].forEach(el => {
    const q = parsePoolEl(el, true);
    if (q) questions.push(q);
  });

  questions.sort((a, b) => a._sortId - b._sortId);
  questions.forEach(q => delete q._sortId);
  return questions;
}


function cleanQuestionText(raw) {
  return raw
    .replace(/^\s*\d+[\.\)]\s*/, '')
    .replace(/^\s*[\(\d]+[\)\.]?\s*/, '')
    .trim();
}


function cleanOptionText(raw) {
  return raw
    .replace(/^\s*[\(\[]*[a-zA-Zأ-ي][\)\]\.]\s*/, '')
    .replace(/^\s*[\(\[]*\d+[\)\]\.]\s*/, '')
    .trim();
}


function onLoaded() {
  const n = allQuestions.length;
  showStatus(`تم تحميل ${n} سؤال بنجاح`, 'success');

  document.getElementById('previewCard').style.display = 'block';
  document.getElementById('totalBadge').textContent = `${n} سؤال`;

  const mc = allQuestions.filter(q => q.type === 'Multiple_Choice_Single_Answer').length;
  const tf = allQuestions.filter(q => q.type === 'True_or_False').length;

  document.getElementById('statsBar').innerHTML =
    `<span class="stat-chip">الإجمالي: ${n}</span>
     <span class="stat-chip">اختيار متعدد (MC): ${mc}</span>
     <span class="stat-chip">صح وخطأ (T/F): ${tf}</span>`;

  applyFilters();
}


function applyFilters() {
  const term = (document.getElementById('searchInput').value || '').toLowerCase();
  const type = document.getElementById('typeFilter').value;

  filteredQ = allQuestions.filter(q => {
    const matchType = !type || q.type === type;
    const matchText = !term || q.text.toLowerCase().includes(term) ||
      q.options.some(o => o && o.toLowerCase().includes(term));
    return matchType && matchText;
  });

  currentPage = 1;
  renderPage();
}

function renderPage() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageQ = filteredQ.slice(start, start + PAGE_SIZE);
  const list  = document.getElementById('questionsList');

  if (filteredQ.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>لا توجد أسئلة تطابق البحث</p></div>`;
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  list.innerHTML = pageQ.map((q, i) => renderQuestion(q, start + i + 1)).join('');
  renderPagination();
}

function renderQuestion(q, num) {
  const isTF      = q.type === 'True_or_False';
  const badgeCls  = isTF ? 'badge-tf' : 'badge-mc';
  const badgeTxt  = isTF ? 'صح / خطأ' : 'اختيار متعدد';
  const labels    = ['A', 'B', 'C', 'D'];

  const optHtml = q.options.map((opt, i) => {
    if (!opt) return '';
    const ok = q.correctAnswer === labels[i];
    return `<div class="q-opt ${ok ? 'correct' : 'wrong'}">
      <span class="opt-lbl">${labels[i]}.</span>
      <span>${esc(opt)}</span>
      ${ok ? '<span class="check-mark">✓</span>' : ''}
    </div>`;
  }).join('');

  return `<div class="q-card">
    <div class="q-head">
      <span class="q-num">س ${num}</span>
      <span class="q-text">${esc(q.text)}</span>
      <span class="q-badge ${badgeCls}">${badgeTxt}</span>
    </div>
    <div class="q-options">${optHtml}</div>
  </div>`;
}

function renderPagination() {
  const total = Math.ceil(filteredQ.length / PAGE_SIZE);
  if (total <= 1) { document.getElementById('pagination').innerHTML = ''; return; }

  const pages = buildPageRange(currentPage, total);
  let html = '', prev = 0;
  for (const p of pages) {
    if (prev && p - prev > 1) html += `<span style="padding:6px 4px;color:#999">…</span>`;
    html += `<button class="pg-btn ${p === currentPage ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
    prev = p;
  }
  document.getElementById('pagination').innerHTML = html;
}

function buildPageRange(cur, total) {
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1);
  const near = new Set([1, total, cur, cur - 1, cur + 1].filter(p => p >= 1 && p <= total));
  return [...near].sort((a, b) => a - b);
}

function goPage(p) {
  currentPage = p;
  renderPage();
  document.getElementById('previewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}


function downloadExcel() {
  if (!allQuestions.length) return;

  const wb = XLSX.utils.book_new();
  const headers = [
    'Question Text', 'Question Type',
    'Empty_1', 'Empty_2', 'Empty_3', 'Empty_4',
    'Option A', 'Option B', 'Option C', 'Option D',
    'Correct Answer'
  ];
  const rows = [headers, ...allQuestions.map(q => [
    q.text, q.type,
    '', '', '', '',
    q.options[0] || '', q.options[1] || '',
    q.options[2] || '', q.options[3] || '',
    q.correctAnswer || ''
  ])];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 80 }, { wch: 35 },
    { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 4 },
    { wch: 35 }, { wch: 35 }, { wch: 35 }, { wch: 35 },
    { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, 'converted_questions.xlsx');
}


function showProgress(visible, pct = 0, label = '') {
  const wrap = document.getElementById('progressWrap');
  wrap.style.display = visible ? 'block' : 'none';
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

function showStatus(msg, type = 'success') {
  document.getElementById('statusMsg').innerHTML =
    `<div class="alert alert-${type}">${msg}</div>`;
}

function clearStatus() {
  document.getElementById('statusMsg').innerHTML = '';
}

function resetAll() {
  allQuestions = []; filteredQ = []; currentPage = 1;
  document.getElementById('previewCard').style.display = 'none';
  clearStatus();
  showProgress(false);
  document.getElementById('fileInput').value = '';
  document.getElementById('searchInput').value = '';
  document.getElementById('typeFilter').value = '';
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
