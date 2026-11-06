const DOC_EXTENSIONS = {
  pdf: { label: 'PDF', badge: 'badge-pdf' },
  doc: { label: 'DOC', badge: 'badge-doc' },
  docx: { label: 'DOCX', badge: 'badge-doc' },
  xls: { label: 'XLS', badge: 'badge-xls' },
  xlsx: { label: 'XLSX', badge: 'badge-xls' },
  csv: { label: 'CSV', badge: 'badge-xls' },
  ppt: { label: 'PPT', badge: 'badge-doc' },
  pptx: { label: 'PPTX', badge: 'badge-doc' },
  txt: { label: 'TXT', badge: 'badge-other' },
  rtf: { label: 'RTF', badge: 'badge-doc' },
  odt: { label: 'ODT', badge: 'badge-doc' },
  ods: { label: 'ODS', badge: 'badge-xls' },
  odp: { label: 'ODP', badge: 'badge-doc' },
  zip: { label: 'ZIP', badge: 'badge-zip' },
  rar: { label: 'RAR', badge: 'badge-zip' },
  '7z': { label: '7Z', badge: 'badge-zip' },
  tar: { label: 'TAR', badge: 'badge-zip' },
  gz: { label: 'GZ', badge: 'badge-zip' },
  png: { label: 'PNG', badge: 'badge-img' },
  jpg: { label: 'JPG', badge: 'badge-img' },
  jpeg: { label: 'JPEG', badge: 'badge-img' },
  gif: { label: 'GIF', badge: 'badge-img' },
  svg: { label: 'SVG', badge: 'badge-img' },
  webp: { label: 'WEBP', badge: 'badge-img' },
  mp3: { label: 'MP3', badge: 'badge-other' },
  mp4: { label: 'MP4', badge: 'badge-other' },
  wav: { label: 'WAV', badge: 'badge-other' },
  json: { label: 'JSON', badge: 'badge-other' },
  xml: { label: 'XML', badge: 'badge-other' },
  md: { label: 'MD', badge: 'badge-other' },
  epub: { label: 'EPUB', badge: 'badge-doc' },
};

// Files whose type we can't tell until the server answers use this key.
const UNKNOWN = 'file';

let files = [];

document.getElementById('scanBtn').addEventListener('click', scanPage);
document.getElementById('selectAll').addEventListener('click', () => toggleAll(true));
document.getElementById('deselectAll').addEventListener('click', () => toggleAll(false));
document.getElementById('downloadBtn').addEventListener('click', downloadSelected);

// Progress updates from the background worker (only arrive while the popup is open).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'jobProgress') showJob(msg.job);
});

// If a batch is still running from earlier, show its progress on open.
chrome.runtime.sendMessage({ action: 'jobStatus' }).then((job) => {
  if (job && !job.finished) showJob(job);
}).catch(() => {});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function scanPage() {
  const scanBtn = document.getElementById('scanBtn');
  scanBtn.textContent = '⏳ Scanning...';
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Scan every frame we're allowed into (pages often show files inside iframes).
    // Some cross-origin frames refuse injection, so fall back to just the main frame.
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: findDocuments,
      });
    } catch {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: findDocuments,
      });
    }

    const seen = new Set();
    files = [];
    for (const r of results) {
      for (const f of r?.result || []) {
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        files.push(f);
      }
    }

    if (files.length === 0) {
      document.getElementById('fileList').innerHTML = `
        <div class="empty-state">
          <div class="big-icon">📭</div>
          <p>No downloadable files found</p>
          <p class="hint">Files behind JavaScript-only buttons can't be detected</p>
        </div>`;
      document.getElementById('statusBar').style.display = 'none';
      document.getElementById('filterRow').style.display = 'none';
    } else {
      const folderInput = document.getElementById('folderName');
      if (!folderInput.value) {
        const sanitized = (tab.title || '')
          .replace(/[^a-zA-Z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .substring(0, 40);
        folderInput.value = sanitized || 'Batch-Downloads';
      }

      renderFilters();
      renderFiles();
    }
  } catch (err) {
    document.getElementById('fileList').innerHTML = `
      <div class="empty-state">
        <div class="big-icon">⚠️</div>
        <p>Can't scan this page</p>
        <p class="hint">${escapeHtml(err.message || 'Try a different page')}</p>
      </div>`;
  }

  scanBtn.textContent = '🔍 Scan This Page';
  scanBtn.disabled = false;
}

// Runs inside the web page (each frame). Must be self-contained: no outside references.
function findDocuments() {
  const EXTS = [
    'pdf','doc','docx','xls','xlsx','csv','ppt','pptx','txt','rtf',
    'odt','ods','odp','zip','rar','7z','tar','gz',
    'png','jpg','jpeg','gif','svg','webp',
    'mp3','mp4','wav','json','xml','md','epub'
  ];
  const extensions = new Set(EXTS);
  // One regex for "a known extension appears as its own word".
  const extWordRe = new RegExp(`(?:^|[^a-z0-9])(${EXTS.join('|')})(?:[^a-z0-9]|$)`, 'i');
  // Words that show up in link text next to a file, e.g. "Annual report (PDF, 2 MB)".
  const textTypeRe = /(?:^|[^a-z])(pdf|docx?|xlsx?|pptx?|csv|zip|epub)(?:[^a-z]|$)/i;
  const textDownloadRe = /\bdownload\b/i;

  // URL shapes that usually serve a file even without an extension.
  const downloadPathRe = /\/(download|downloads|dl|attachment|attachments|getfile|get_file|file_download|export|pluginfile\.php|mod\/resource\/view\.php|uc)(?:\/|$|\?)/i;
  const downloadParams = ['download', 'dl', 'attachment', 'forcedownload', 'export'];
  const formatParamRe = /^(pdf|docx?|xlsx?|pptx?|csv|zip|txt)$/i;
  // Extensions that are web pages, not files.
  const pageExts = new Set(['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'cfm', 'shtml']);

  // Moodle and similar icon names → extension
  const iconToExt = {
    pdf: 'pdf',
    document: 'docx', writer: 'docx', text: 'txt',
    spreadsheet: 'xlsx', calc: 'xlsx',
    powerpoint: 'pptx', impress: 'pptx',
    archive: 'zip', 'archive-extract': 'zip',
    image: 'jpg', audio: 'mp3', video: 'mp4',
  };

  function detectExtFromImg(el) {
    for (const img of el.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const m1 = src.match(/\/f\/([a-z0-9-]+?)(?:-\d+)?(?:\.(?:png|svg|gif|jpg))?(?:[?&]|$)/i);
      if (m1) {
        const key = m1[1].toLowerCase().replace(/-\d+$/, '');
        if (extensions.has(key)) return key;
        if (iconToExt[key]) return iconToExt[key];
      }
      const alt = `${img.alt || ''} ${img.title || ''}`;
      const m2 = alt.match(extWordRe);
      if (m2) return m2[1].toLowerCase();
    }
    return null;
  }

  function cleanName(text) {
    return text
      .replace(/\s+/g, ' ')
      // "Budget (PDF, 2 MB)" -> "Budget"
      .replace(/\s*[([][^)\]]*\b(pdf|docx?|xlsx?|pptx?|csv|zip|kb|mb|gb)\b[^)\]]*[)\]]\s*$/i, '')
      .replace(/\s*(File|URL|Folder|Page|Document)\s*$/i, '')
      .trim()
      .substring(0, 120);
  }

  function extFromUrl(url) {
    const m = url.pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (m) return m[1].toLowerCase();
    return null;
  }

  // e.g. /viewer?file=report.pdf or ?filename=data.xlsx
  function extFromQuery(url) {
    for (const [, value] of url.searchParams) {
      const m = value.match(/\.([a-zA-Z0-9]{2,5})$/);
      if (m && extensions.has(m[1].toLowerCase())) return { ext: m[1].toLowerCase(), name: value.split('/').pop() };
    }
    const format = url.searchParams.get('format');
    if (format && formatParamRe.test(format)) return { ext: format.toLowerCase(), name: null };
    return null;
  }

  // Walk the DOM including open shadow roots (many modern sites use web components).
  function collect(root, selector, out) {
    root.querySelectorAll(selector).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) collect(el.shadowRoot, selector, out);
    });
    return out;
  }

  const found = [];
  const seen = new Set();

  // drive.google.com/file/d/ID/view  -> direct download (uses your Google sign-in in Chrome)
  // docs.google.com/document|spreadsheets|presentation/d/ID/edit -> export as PDF / XLSX / PDF
  function googleDownload(url) {
    const host = url.hostname;
    const userMatch = url.pathname.match(/\/u\/(\d+)\//);
    const authuser = url.searchParams.get('authuser') || (userMatch && userMatch[1]);
    const withUser = (u) => (authuser ? `${u}${u.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(authuser)}` : u);

    if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
      const m = url.pathname.match(/\/file(?:\/u\/\d+)?\/d\/([\w-]{10,})/);
      const id = m ? m[1] : (/^\/(open|uc|download)$/.test(url.pathname) ? url.searchParams.get('id') : null);
      if (!id) return null; // folders etc. aren't single files
      return {
        href: withUser(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`),
        ext: '',
      };
    }

    if (host === 'docs.google.com') {
      const m = url.pathname.match(/^\/(document|spreadsheets|presentation)(?:\/u\/\d+)?\/d\/([\w-]{10,})/);
      if (!m) return null;
      const [, kind, id] = m;
      const base = `https://docs.google.com/${kind}/d/${id}`;
      if (kind === 'document') return { href: withUser(`${base}/export?format=pdf`), ext: 'pdf' };
      if (kind === 'spreadsheets') return { href: withUser(`${base}/export?format=xlsx`), ext: 'xlsx' };
      return { href: withUser(`${base}/export/pdf`), ext: 'pdf' };
    }
    return null;
  }

  function add(href, filename, ext, text, nameFromServer, extra = {}) {
    if (seen.has(href)) return;
    seen.add(href);
    if (filename) {
      try { filename = decodeURIComponent(filename); } catch {}
      filename = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    }
    found.push({ url: href, filename: filename || '', ext: ext || '', text, nameFromServer, ...extra });
  }

  function considerUrl(href, el, linkText, downloadAttr) {
    if (!href) return;
    let url;
    try { url = new URL(href, document.baseURI); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;

    // Plain in-page anchors (#section) on the current page aren't files.
    if (url.hash && url.href.split('#')[0] === location.href.split('#')[0]) return;
    href = url.href;

    const pathExt = extFromUrl(url);
    // Link text that's just the URL makes a useless file name
    const base = /^(https?:\/\/|www\.)/i.test(linkText) ? '' : cleanName(linkText);

    // 0. Google Drive / Docs viewer links → their direct download URL
    const g = googleDownload(url);
    if (g) {
      const name = base && g.ext ? `${base}.${g.ext}` : base;
      add(g.href, name, g.ext, linkText, true, { google: true });
      return;
    }

    // 1. URL path ends in a known file extension — most reliable.
    if (pathExt && extensions.has(pathExt)) {
      const name = url.pathname.split('/').pop();
      add(href, name, pathExt, linkText, false);
      return;
    }

    // 2. File named in the query string (?file=report.pdf, ?format=csv).
    const q = extFromQuery(url);
    if (q) {
      const name = q.name || (base ? `${base}.${q.ext}` : '');
      add(href, name, q.ext, linkText, true);
      return;
    }

    const isPage = pathExt && pageExts.has(pathExt);
    const hasDownloadAttr = downloadAttr !== null && downloadAttr !== undefined;
    const looksLikeDownload =
      downloadPathRe.test(url.pathname) ||
      downloadParams.some((p) => url.searchParams.has(p));
    const iconExt = el ? detectExtFromImg(el) : null;
    const textExt = (linkText.match(textTypeRe) || [])[1];
    const saysDownload = textDownloadRe.test(linkText) ||
      (el && textDownloadRe.test(el.getAttribute('aria-label') || el.title || ''));

    // 3. Strong signals: <a download>, download-style URL, or a file-type icon.
    // 4. Weaker: link text mentions a file type or "download" (and it's not obviously a page).
    const strong = hasDownloadAttr || looksLikeDownload || iconExt;
    const weak = !isPage && (textExt || saysDownload);
    if (!strong && !weak) return;

    const ext = (iconExt || textExt || '').toLowerCase();
    let name = (hasDownloadAttr && downloadAttr) || base;
    if (name && ext && !name.toLowerCase().endsWith('.' + ext)) name = `${name}.${ext}`;
    // Type and name are guesses here — let the server's real filename win if it sends one.
    add(href, name, extensions.has(ext) ? ext : '', linkText, true);
  }

  // Links (including inside shadow DOM)
  for (const a of collect(document, 'a[href], area[href]', [])) {
    const text = (a.textContent || a.getAttribute('aria-label') || a.title || '')
      .trim().replace(/\s+/g, ' ').substring(0, 100);
    considerUrl(a.getAttribute('href'), a, text, a.getAttribute('download'));
  }

  // Embedded files: PDF viewers, media players
  for (const el of collect(document, 'iframe[src], embed[src], object[data], video[src], audio[src], source[src]', [])) {
    const src = el.getAttribute('src') || el.getAttribute('data');
    let url;
    try { url = new URL(src, document.baseURI); } catch { continue; }
    const g = googleDownload(url);
    if (g) {
      add(g.href, el.title ? cleanName(el.title) + (g.ext ? `.${g.ext}` : '') : '', g.ext, el.title || '', true, { google: true });
      continue;
    }
    const ext = extFromUrl(url);
    if (ext && extensions.has(ext) && /^https?:$/.test(url.protocol)) {
      add(url.href, url.pathname.split('/').pop(), ext, el.title || '', false);
    }
  }

  // The tab itself is a file (e.g. you're viewing a PDF directly)
  if (document.contentType && !/html|xml/i.test(document.contentType)) {
    const url = new URL(location.href);
    add(url.href, url.pathname.split('/').pop(), extFromUrl(url) || '', document.title || '', true);
  }

  return found;
}

function typeKey(file) {
  return file.ext || UNKNOWN;
}

function renderFilters() {
  const types = [...new Set(files.map(typeKey))].sort();
  const filterRow = document.getElementById('filterRow');

  if (types.length <= 1) {
    filterRow.style.display = 'none';
    return;
  }

  filterRow.style.display = 'flex';
  filterRow.innerHTML = `<button class="filter-chip active" data-filter="all">All</button>` +
    types.map(t => `<button class="filter-chip" data-filter="${escapeHtml(t)}">${escapeHtml(t.toUpperCase())}</button>`).join('');

  filterRow.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      filterRow.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderFiles(chip.dataset.filter);
    });
  });
}

function renderFiles(filter = 'all') {
  const list = document.getElementById('fileList');

  list.innerHTML = files.map((file, index) => {
    if (filter !== 'all' && typeKey(file) !== filter) return '';
    const info = DOC_EXTENSIONS[file.ext] || { label: file.ext ? file.ext.toUpperCase() : 'FILE', badge: 'badge-other' };
    const displayName = file.filename || file.text || file.url;
    let subtitle = file.text && file.text !== file.filename ? file.text : '';
    const note = file.google ? 'Google Drive · uses your Google sign-in' : (file.nameFromServer ? 'name from site' : '');
    if (note) subtitle = subtitle ? `${subtitle} · ${note}` : note;
    return `
      <div class="file-item">
        <input type="checkbox" data-index="${index}" checked />
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(file.url)}">${escapeHtml(displayName)}</div>
          <div class="file-type">${escapeHtml(subtitle)}</div>
        </div>
        <span class="file-badge ${info.badge}">${escapeHtml(info.label)}</span>
      </div>`;
  }).join('');

  list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateCount);
  });

  document.getElementById('statusBar').style.display = 'flex';
  document.getElementById('totalCount').textContent = `${files.length} found`;
  updateCount();
}

function toggleAll(state) {
  document.querySelectorAll('#fileList input[type="checkbox"]').forEach(cb => {
    cb.checked = state;
  });
  updateCount();
}

function updateCount() {
  const checked = document.querySelectorAll('#fileList input[type="checkbox"]:checked');
  document.getElementById('selectedCount').textContent = checked.length;
  document.getElementById('downloadBtn').disabled = checked.length === 0;
}

async function downloadSelected() {
  const folderName = document.getElementById('folderName').value.trim() || 'Batch-Downloads';
  const checked = document.querySelectorAll('#fileList input[type="checkbox"]:checked');
  const items = [...checked].map(cb => files[parseInt(cb.dataset.index, 10)]).map((file) => {
    // Moodle resource pages: ask for the file itself rather than the viewer page
    let url = file.url;
    try {
      const u = new URL(url);
      if (/\/mod\/resource\/view\.php/i.test(u.pathname) && !u.searchParams.has('forcedownload')) {
        u.searchParams.set('forcedownload', '1');
        url = u.toString();
      }
    } catch {}
    return { url, filename: file.filename, ext: file.ext, nameFromServer: file.nameFromServer, google: !!file.google };
  });

  if (items.length === 0) return;

  // The background worker does the downloading, so closing this popup doesn't stop it.
  const job = await chrome.runtime.sendMessage({ action: 'downloadBatch', folder: folderName, items });
  if (job) showJob(job);
}

function showJob(job) {
  const btn = document.getElementById('downloadBtn');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');

  const done = job.completed + job.failed;
  progressBar.style.display = 'block';
  progressFill.style.width = `${job.total ? (done / job.total) * 100 : 0}%`;

  if (!job.finished) {
    btn.disabled = true;
    btn.innerHTML = `<span>⏳</span> Downloading ${done}/${job.total}...`;
    return;
  }

  const login = job.loginNeeded ? ` (${job.loginNeeded} need Google sign-in)` : '';
  btn.innerHTML = job.failed
    ? `<span>⚠️</span> ${job.completed} saved, ${job.failed} failed${login}`
    : `<span>✅</span> ${job.completed} saved`;
  setTimeout(() => {
    btn.innerHTML = '<span>⬇</span> Download Selected';
    progressBar.style.display = 'none';
    progressFill.style.width = '0%';
    updateCount();
  }, 3000);
}
