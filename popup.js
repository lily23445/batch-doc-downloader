// ---------- File types ----------
const TYPE_STYLE = {
  pdf: 't-pdf',
  doc: 't-doc', docx: 't-doc', rtf: 't-doc', odt: 't-doc', txt: 't-doc', md: 't-doc', epub: 't-doc',
  xls: 't-xls', xlsx: 't-xls', csv: 't-xls', ods: 't-xls', json: 't-xls', xml: 't-xls',
  ppt: 't-ppt', pptx: 't-ppt', odp: 't-ppt',
  png: 't-img', jpg: 't-img', jpeg: 't-img', gif: 't-img', svg: 't-img', webp: 't-img',
  zip: 't-zip', rar: 't-zip', '7z': 't-zip', tar: 't-zip', gz: 't-zip',
  mp3: 't-media', mp4: 't-media', wav: 't-media',
};

// Files whose type we can't tell until the server answers use this key.
const UNKNOWN = 'file';

// ---------- State ----------
let files = [];               // everything the scan found
const selected = new Set();   // indices into files[] — kept across filters and searches
let activeType = 'all';
let query = '';
let lastJobShown = null;

const $ = (id) => document.getElementById(id);

const ICONS = {
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17h.01"/></svg>',
  empty: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9.5 13.5h5"/></svg>',
  blocked: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
  search: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Wiring ----------
$('rescanBtn').addEventListener('click', scanPage);
$('downloadBtn').addEventListener('click', downloadSelected);
$('showFolderBtn').addEventListener('click', showFolder);
$('search').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); renderFiles(); });
$('checkAll').addEventListener('change', (e) => {
  for (const i of visibleIndices()) e.target.checked ? selected.add(i) : selected.delete(i);
  renderFiles();
});
$('fileList').addEventListener('change', (e) => {
  const i = Number(e.target.dataset.index);
  if (Number.isNaN(i)) return;
  e.target.checked ? selected.add(i) : selected.delete(i);
  e.target.closest('.row').classList.toggle('off', !e.target.checked);
  updateSelectionUi();
});

// Progress updates from the background worker (only arrive while the popup is open).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'jobProgress') showJob(msg.job);
});

// Show a batch that's still running (or just finished) from earlier.
chrome.runtime.sendMessage({ action: 'jobStatus' }).then((job) => {
  if (job) showJob(job, { quiet: true });
}).catch(() => {});

// Scan straight away — one less click.
scanPage();

// ---------- Scanning ----------
function showState(icon, title, text) {
  $('toolbar').hidden = true;
  $('listHead').hidden = true;
  $('fileList').innerHTML = `
    <div class="state">
      <div class="big">${icon}</div>
      <h2>${escapeHtml(title)}</h2>
      ${text ? `<p>${escapeHtml(text)}</p>` : ''}
    </div>`;
  updateSelectionUi();
}

function showSkeleton() {
  $('toolbar').hidden = true;
  $('listHead').hidden = true;
  const widths = [72, 55, 80, 48, 64, 58];
  $('fileList').innerHTML = widths.map((w) => `
    <div class="skeleton">
      <i style="width:38px;height:38px;border-radius:8px"></i>
      <div style="flex:1;display:flex;flex-direction:column;gap:6px">
        <i style="width:${w}%;height:11px"></i>
        <i style="width:${w / 2}%;height:9px"></i>
      </div>
    </div>`).join('');
}

async function scanPage() {
  const btn = $('rescanBtn');
  btn.disabled = true;
  btn.classList.add('spinning');
  showSkeleton();

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      $('pageHost').textContent = new URL(tab.url).hostname.replace(/^www\./, '') || 'This page';
    } catch {
      $('pageHost').textContent = 'This page';
    }

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
    selected.clear();
    files.forEach((_, i) => selected.add(i));
    activeType = 'all';
    query = '';
    $('search').value = '';

    const folderInput = $('folderName');
    if (!folderInput.value) {
      folderInput.value = (tab.title || '')
        .replace(/\s+-\s+Google (Drive|Docs|Sheets|Slides)\s*$/i, '')
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .substring(0, 40) || 'Batch-Downloads';
    }

    if (files.length === 0) {
      showState(ICONS.empty, 'No files found on this page',
        'Files behind buttons that only run JavaScript can\'t be detected.');
    } else {
      renderFilters();
      renderFiles();
    }
  } catch (err) {
    const url = tab?.url || '';
    const blocked = /^(chrome|edge|about|chrome-extension|devtools):/i.test(url) || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(url);
    showState(ICONS.blocked, 'Can\'t scan this page',
      blocked ? 'Chrome doesn\'t let extensions read its own pages or the Web Store. Open a normal website and try again.'
              : (err.message || 'Try reloading the page, then scan again.'));
  }

  btn.disabled = false;
  btn.classList.remove('spinning');
}

// Runs inside the web page (each frame). Must be self-contained: no outside references.
async function findDocuments() {
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
  const moodleUrlLinks = [];

  // Open a Moodle URL activity's info page (same site, your login) and read the
  // external link it points to. forceview=1 shows the page instead of redirecting.
  async function resolveMoodleUrl(href) {
    const u = new URL(href);
    u.searchParams.set('forceview', '1');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(u.href, { credentials: 'include', signal: ctrl.signal });
      if (!res.ok) return null;
      // Moodle may already have redirected us to a same-site file
      if (res.url && !/\/mod\/url\/view\.php/i.test(new URL(res.url).pathname)) return res.url;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const main = doc.querySelector('#region-main, [role="main"]') || doc;
      const direct = main.querySelector('.urlworkaround a[href], object[data], embed[src], iframe[src]');
      const pick = direct && (direct.getAttribute('href') || direct.getAttribute('data') || direct.getAttribute('src'));
      if (pick) return new URL(pick, u).href;
      // Fallback: first link in the main area that leaves this site
      for (const a of main.querySelectorAll('a[href]')) {
        try {
          const target = new URL(a.getAttribute('href'), u);
          if (/^https?:$/.test(target.protocol) && target.origin !== location.origin) return target.href;
        } catch {}
      }
    } catch {
      // timeout / network error: skip this one
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

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

    // Moodle "URL" activities are just pointers to another site (often Google Drive).
    // Look them up after the scan to find where they really go.
    if (url.origin === location.origin && /\/mod\/url\/view\.php$/i.test(url.pathname)) {
      moodleUrlLinks.push({ href, linkText });
      return;
    }

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

  // Resolve Moodle URL activities a few at a time, then treat the real link like any other
  for (let i = 0; i < moodleUrlLinks.length; i += 6) {
    const batch = moodleUrlLinks.slice(i, i + 6);
    const targets = await Promise.all(batch.map((m) => resolveMoodleUrl(m.href)));
    targets.forEach((target, j) => {
      if (target) considerUrl(target, null, batch[j].linkText, null);
    });
  }

  // The tab itself is a Google Drive / Docs file you're viewing
  {
    const g = googleDownload(new URL(location.href));
    if (g) {
      const title = (document.title || '')
        .replace(/\s+-\s+Google (Drive|Docs|Sheets|Slides)\s*$/i, '')
        .trim();
      let name = cleanName(title);
      if (name && g.ext && !name.toLowerCase().endsWith('.' + g.ext)) name = `${name}.${g.ext}`;
      const titleExt = (name.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
      const ext = g.ext || (titleExt && extensions.has(titleExt.toLowerCase()) ? titleExt.toLowerCase() : '');
      add(g.href, name, ext, title, true, { google: true });
    }
  }

  // The tab itself is a file (e.g. you're viewing a PDF directly)
  if (document.contentType && !/html|xml/i.test(document.contentType)) {
    const url = new URL(location.href);
    add(url.href, url.pathname.split('/').pop(), extFromUrl(url) || '', document.title || '', true);
  }

  return found;
}

// ---------- List rendering ----------
function typeKey(file) {
  return file.ext || UNKNOWN;
}

function sourceLabel(file) {
  if (file.google) return 'Google Drive';
  try { return new URL(file.url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function visibleIndices() {
  const out = [];
  files.forEach((f, i) => {
    if (activeType !== 'all' && typeKey(f) !== activeType) return;
    if (query && !`${f.filename} ${f.text}`.toLowerCase().includes(query)) return;
    out.push(i);
  });
  return out;
}

function renderFilters() {
  const counts = {};
  for (const f of files) counts[typeKey(f)] = (counts[typeKey(f)] || 0) + 1;
  const types = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));

  $('toolbar').hidden = false;
  const row = $('filterRow');
  row.hidden = types.length <= 1;
  row.innerHTML = [['all', files.length], ...types.map((t) => [t, counts[t]])]
    .map(([t, n]) => `<button class="chip${t === activeType ? ' active' : ''}" data-filter="${escapeHtml(t)}">
        ${t === 'all' ? 'All' : escapeHtml(t.toUpperCase())}<span class="n">${n}</span></button>`)
    .join('');

  row.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      activeType = chip.dataset.filter;
      row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderFiles();
    });
  });
}

function renderFiles() {
  const list = $('fileList');
  const indices = visibleIndices();
  $('listHead').hidden = false;

  if (indices.length === 0) {
    list.innerHTML = `<div class="state"><div class="big">${ICONS.search}</div><h2>No matches</h2><p>Try a different search or filter.</p></div>`;
  } else {
    list.innerHTML = indices.map((i) => {
      const file = files[i];
      const on = selected.has(i);
      const label = file.ext ? file.ext.toUpperCase().slice(0, 4) : 'FILE';
      const style = TYPE_STYLE[file.ext] || 't-other';
      const name = file.filename || file.text || file.url;
      const meta = [escapeHtml(sourceLabel(file))];
      // Only show the link text if it says something the name doesn't
      const stem = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]/g, '');
      if (file.text && stem(file.text) !== stem(name) && !/^https?:/i.test(file.text)) meta.push(escapeHtml(file.text));
      if (file.nameFromServer && !file.google) meta.push('<span class="tag">name from site</span>');
      return `
        <label class="row${on ? '' : ' off'}" title="${escapeHtml(file.url)}">
          <input type="checkbox" data-index="${i}"${on ? ' checked' : ''} />
          <span class="type ${style}">${escapeHtml(label)}</span>
          <span class="info">
            <span class="name" style="display:block">${escapeHtml(name)}</span>
            <span class="meta" style="display:block">${meta.join(' · ')}</span>
          </span>
        </label>`;
    }).join('');
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  const total = files.length;
  const count = selected.size;
  const visible = visibleIndices();
  const visibleOn = visible.filter((i) => selected.has(i)).length;

  const all = $('checkAll');
  all.checked = visible.length > 0 && visibleOn === visible.length;
  all.indeterminate = visibleOn > 0 && visibleOn < visible.length;

  $('selectionText').innerHTML = `<strong>${count}</strong> of ${total} selected`;
  $('visibleText').textContent = visible.length !== total ? `showing ${visible.length}` : '';

  const btn = $('downloadBtn');
  if (!btn.dataset.busy) {
    btn.disabled = count === 0;
    $('downloadLabel').textContent = count === 0 ? 'Download' : `Download ${count} file${count === 1 ? '' : 's'}`;
  }
}

// ---------- Downloading ----------
async function downloadSelected() {
  const folderName = $('folderName').value.trim() || 'Batch-Downloads';
  // Every ticked file, whatever filter or search is showing
  const items = [...selected].sort((a, b) => a - b).map((i) => files[i]).map((file) => {
    let url = file.url;
    try {
      const u = new URL(url);
      if (/\/mod\/resource\/view\.php/i.test(u.pathname)) {
        // redirect=1 makes Moodle send the file itself, even for resources set to
        // show in a viewer page (images, embedded PDFs) instead of downloading.
        u.searchParams.set('redirect', '1');
        u.searchParams.delete('forceview');
        if (!u.searchParams.has('forcedownload')) u.searchParams.set('forcedownload', '1');
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

function showJob(job, { quiet = false } = {}) {
  lastJobShown = job;
  const btn = $('downloadBtn');
  const done = job.completed + job.failed;

  if (!job.finished) {
    $('result').hidden = true;
    $('progress').hidden = false;
    const pct = job.total ? Math.round((done / job.total) * 100) : 0;
    $('progressText').textContent = `Downloading ${done} of ${job.total}…`;
    $('progressPct').textContent = `${pct}%`;
    $('progressFill').style.width = `${pct}%`;
    btn.dataset.busy = '1';
    btn.disabled = true;
    $('downloadLabel').textContent = 'Downloading…';
    return;
  }

  $('progress').hidden = true;
  delete btn.dataset.busy;
  updateSelectionUi();

  // When reopening the popup, only show the last result for a little while
  if (quiet && job.finishedAt && Date.now() - job.finishedAt > 5 * 60 * 1000) return;

  const problems = job.failed > 0;
  const details = [];
  if (job.failed) details.push(`${job.failed} failed`);
  if (job.loginNeeded) details.push(`${job.loginNeeded} need Google sign-in`);
  if (job.skipped) details.push(`${job.skipped} skipped (web page${job.skipped === 1 ? '' : 's'})`);

  $('result').hidden = false;
  $('result').className = `result ${problems ? 'warn' : 'ok'}`;
  $('resultIcon').innerHTML = problems ? ICONS.warn : ICONS.check;
  $('resultTitle').textContent = `${job.completed} file${job.completed === 1 ? '' : 's'} saved`;
  $('resultDetail').textContent = details.join(' · ') || `in Downloads/${job.folder || ''}`;
  $('showFolderBtn').hidden = !job.completed;
}

function showFolder() {
  if (lastJobShown?.lastId != null) {
    chrome.downloads.show(lastJobShown.lastId);
  } else {
    chrome.downloads.showDefaultFolder();
  }
}
