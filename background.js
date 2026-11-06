// Background service worker — runs the whole download batch, so it keeps going
// even after the popup closes.

// url -> { folder, filename, ext, nameFromServer } for downloads we've started
// but Chrome hasn't named yet.
const pendingNames = new Map();
// Google downloads that came back as a sign-in page instead of a file.
const loginNeededIds = new Set();

// Names servers often send that say nothing about the file.
const GENERIC_STEMS = /^(view|download|downloads|file|files|index|get|getfile|export|attachment|uc|document|dl)$/i;
const PAGE_EXT = /\.(php|aspx?|jsp|cfm)$/i;

const MIME_EXT = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/json': 'json',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
  'application/epub+zip': 'epub',
};

function sanitizePart(name, fallback) {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 150) {
    const m = s.match(/(\.[a-z0-9]{1,5})$/i);
    s = s.slice(0, 150 - (m ? m[1].length : 0)) + (m ? m[1] : '');
  }
  return s || fallback;
}

function splitExt(name) {
  const m = name.match(/^(.*)\.([a-z0-9]{1,5})$/i);
  return m ? { stem: m[1], ext: m[2].toLowerCase() } : { stem: name, ext: '' };
}

// Decide the final filename: ours when the URL told us the real name,
// otherwise the server's name unless it's a useless one like "view.php".
function chooseName(entry, item) {
  const serverName = (item.filename || '').split(/[\\/]/).pop();
  const server = splitExt(serverName);
  const serverExt = (server.ext && !PAGE_EXT.test(serverName)) ? server.ext : (MIME_EXT[item.mime] || '');

  if (!entry.nameFromServer && entry.filename) return entry.filename;

  const serverUseful = serverName && server.ext && !PAGE_EXT.test(serverName) && !GENERIC_STEMS.test(server.stem);
  if (serverUseful) return serverName;

  if (entry.filename) {
    const ours = splitExt(entry.filename);
    // Trust the server's type over our guess from the link text
    const ext = serverExt || ours.ext;
    return ext ? `${ours.stem}.${ext}` : entry.filename;
  }
  if (serverName) {
    return serverExt && serverExt !== server.ext ? `${server.stem}.${serverExt}` : serverName;
  }
  return serverExt ? `download.${serverExt}` : 'download';
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const entry = pendingNames.get(item.url);
  if (!entry) {
    suggest(); // not ours — leave Chrome's choice alone
    return;
  }
  pendingNames.delete(item.url);

  // Google sends its sign-in / "no access" page as HTML instead of the file.
  // Don't save that page — cancel and report it.
  if (entry.google && /^text\/html/i.test(item.mime || '')) {
    suggest();
    loginNeededIds.add(item.id);
    chrome.downloads.cancel(item.id);
    return;
  }

  const folder = sanitizePart(entry.folder, 'Batch-Downloads');
  const name = sanitizePart(chooseName(entry, item), 'download');
  suggest({ filename: `${folder}/${name}`, conflictAction: 'uniquify' });
});

// ---- Job tracking (kept in session storage so it survives the worker sleeping) ----

async function loadState() {
  const { state } = await chrome.storage.session.get('state');
  return state || { job: null, ids: {} };
}

async function saveState(state) {
  await chrome.storage.session.set({ state });
}

function updateBadge(job) {
  if (!job) return;
  const done = job.completed + job.failed;
  if (!job.finished) {
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    chrome.action.setBadgeText({ text: `${done}/${job.total}`.slice(0, 5) });
  } else if (job.failed) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    chrome.action.setBadgeText({ text: `!${job.failed}` });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  }
}

function broadcast(job) {
  updateBadge(job);
  // Popup may be closed; that's fine.
  chrome.runtime.sendMessage({ type: 'jobProgress', job }).catch(() => {});
}

// Serialize state updates so concurrent events don't overwrite each other.
let queue = Promise.resolve();
function withState(fn) {
  queue = queue.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await saveState(state);
    return result;
  }).catch((err) => console.error(err));
  return queue;
}

function settle(state, outcome) {
  const job = state.job;
  if (!job) return;
  if (outcome === 'complete') job.completed++;
  else job.failed++;
  job.finished = job.completed + job.failed >= job.total;
  broadcast(job);
}

chrome.downloads.onChanged.addListener((delta) => {
  const s = delta.state?.current;
  if (s !== 'complete' && s !== 'interrupted') return;
  withState((state) => {
    if (!state.ids[delta.id]) return;
    delete state.ids[delta.id];
    if (loginNeededIds.delete(delta.id)) state.job.loginNeeded = (state.job.loginNeeded || 0) + 1;
    settle(state, s);
  });
});

async function startBatch(folder, items) {
  const job = await withState((state) => {
    // A new batch while one is running just extends it.
    if (!state.job || state.job.finished) {
      state.job = { total: 0, completed: 0, failed: 0, loginNeeded: 0, finished: false };
      state.ids = {};
    }
    state.job.total += items.length;
    broadcast(state.job);
    return { ...state.job };
  });

  // Reply to the popup right away; downloads continue in the background.
  runItems(folder, items);
  return job;
}

async function runItems(folder, items) {
  for (const item of items) {
    pendingNames.set(item.url, { folder, ...item });
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({ url: item.url, saveAs: false });
    } catch (err) {
      console.error('Download failed to start:', item.url, err);
    }
    await withState((state) => {
      if (downloadId == null) {
        pendingNames.delete(item.url);
        settle(state, 'interrupted');
      } else {
        state.ids[downloadId] = true;
      }
    });
    // Chrome may have already finished/failed it before we recorded the id
    if (downloadId != null) {
      const [d] = await chrome.downloads.search({ id: downloadId });
      if (d && (d.state === 'complete' || d.state === 'interrupted')) {
        await withState((state) => {
          if (!state.ids[downloadId]) return;
          delete state.ids[downloadId];
          settle(state, d.state);
        });
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadBatch') {
    startBatch(message.folder, message.items).then(sendResponse);
    return true;
  }
  if (message.action === 'jobStatus') {
    loadState().then((state) => sendResponse(state.job));
    return true;
  }
});
