// ─── Hebrew ordinal → number (חלק א=1, חלק ב=2, …) ──────────────────────────
const HEBREW_ORDINAL = {
  'א':1,'ב':2,'ג':3,'ד':4,'ה':5,'ו':6,'ז':7,'ח':8,'ט':9,'י':10,
  'יא':11,'יב':12,'יג':13,'יד':14,'טו':15,'טז':16,'יז':17,'יח':18,'יט':19,'כ':20,
};
function partNum(name) {
  const m = name.match(/חלק\s+([א-ת]+|\d+)/);
  if (!m) return 0;
  return /\d/.test(m[1]) ? parseInt(m[1], 10) : (HEBREW_ORDINAL[m[1]] ?? 999);
}

// ─── State ────────────────────────────────────────────────────────────────────
let accessToken = null;
let currentFileId = null;
let currentFileIndex = -1;
let filesList = [];
let seekingByUser = false;
let bookmarkInterval = null;

// ─── Bookmarks ────────────────────────────────────────────────────────────────
function saveBookmark(fileId, position) {
  if (!fileId || position < 5) return; // don't save if < 5 sec in
  localStorage.setItem('bm_' + fileId, Math.floor(position));
}

function loadBookmark(fileId) {
  return parseInt(localStorage.getItem('bm_' + fileId) || '0', 10);
}

function clearBookmark(fileId) {
  localStorage.removeItem('bm_' + fileId);
}

function startBookmarkTimer(fileId) {
  stopBookmarkTimer();
  bookmarkInterval = setInterval(() => {
    if (!audio.paused && audio.currentTime > 0) {
      saveBookmark(fileId, audio.currentTime);
    }
  }, 30000);
}

function stopBookmarkTimer() {
  if (bookmarkInterval) { clearInterval(bookmarkInterval); bookmarkInterval = null; }
}

const audio = document.getElementById('audio');

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSession(token) {
  localStorage.setItem('goog_token', token);
  localStorage.setItem('goog_token_expiry', Date.now() + 55 * 60 * 1000);
  localStorage.setItem('goog_authed', '1');
}

function clearSession() {
  localStorage.removeItem('goog_token');
  localStorage.removeItem('goog_token_expiry');
  localStorage.removeItem('goog_authed');
}

function getStoredToken() {
  const token = localStorage.getItem('goog_token');
  const expiry = parseInt(localStorage.getItem('goog_token_expiry') || '0');
  return token && expiry > Date.now() ? token : null;
}

// ─── Google Identity Services ─────────────────────────────────────────────────
function loadGoogleAuth() {
  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.onload = initTokenClient;
  document.head.appendChild(script);
}

let tokenClient;
function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    callback: onTokenReceived,
  });

  const stored = getStoredToken();
  if (stored) {
    accessToken = stored;
    showScreen('list');
    loadAllFiles();
  } else if (localStorage.getItem('goog_authed')) {
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

function onTokenReceived(response) {
  if (response.error) {
    if (!accessToken) showSignInError('כניסה נכשלה: ' + response.error);
    return;
  }
  accessToken = response.access_token;
  saveSession(accessToken);
  showScreen('list');
  loadAllFiles();
}

function requestToken() {
  if (!tokenClient) { showSignInError('שגיאה בטעינת Google Auth'); return; }
  tokenClient.requestAccessToken({ prompt: 'select_account' });
}

// ─── Screen management ────────────────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('screen-signin').classList.toggle('hidden', name !== 'signin');
  document.getElementById('screen-list').classList.toggle('hidden', name !== 'list');
}

function showSignInError(msg) {
  const el = document.getElementById('signin-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ─── Drive API ────────────────────────────────────────────────────────────────
async function driveListFiles(folderId, pageToken) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,createdTime,mimeType),nextPageToken');
  let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    accessToken = null;
    showScreen('signin');
    throw new Error('session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || res.status;
    throw new Error(`Drive API ${res.status}: ${msg}`);
  }
  return res.json();
}

async function getAllVideosInFolder(folderId) {
  // Get all direct children of the month folder
  const children = await listAllItems(folderId);

  const subfolders = children.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  const directVideos = children.filter(f => f.mimeType && f.mimeType.startsWith('video/'));

  // Get all files from each subfolder, filter for videos client-side
  const subResults = await Promise.all(subfolders.map(sf => listAllItems(sf.id)));
  const subVideos = subResults.flat().filter(f => f.mimeType && f.mimeType.startsWith('video/'));

  return [...directVideos, ...subVideos];
}

async function listAllItems(folderId) {
  const items = [];
  let pageToken = null;
  do {
    const data = await driveListFiles(folderId, pageToken);
    items.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return items;
}

async function loadAllFiles() {
  setLoading(true);
  setStatus('');

  try {
    if (!DRIVE_FOLDER_IDS || DRIVE_FOLDER_IDS.length === 0) {
      setStatus('הוסף folder IDs לקובץ config.js', true);
      setLoading(false);
      return;
    }

    const results = await Promise.all(DRIVE_FOLDER_IDS.map(getAllVideosInFolder));
    const all = results.flat();

    if (all.length === 0) {
      setStatus('לא נמצאו קבצי וידאו');
      setLoading(false);
      renderFiles([]);
      return;
    }

    // Sort: date ascending → part number (חלק א/ב/…) → name
    const filtered = all.filter(f => !f.name.includes('המלצה'));
    filtered.sort((a, b) => {
      const dateDiff = a.createdTime.localeCompare(b.createdTime);
      if (dateDiff !== 0) return dateDiff;
      const partDiff = partNum(a.name) - partNum(b.name);
      if (partDiff !== 0) return partDiff;
      return a.name.localeCompare(b.name, 'he', { numeric: true });
    });
    renderFiles(filtered);
    setStatus(`${filtered.length} שיעורים`);
  } catch (e) {
    if (e.message !== 'session expired') {
      setStatus('שגיאה בטעינה: ' + e.message, true);
    }
  } finally {
    setLoading(false);
  }
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('loading').classList.toggle('hidden', !on);
  document.getElementById('file-list').classList.toggle('hidden', on);
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('list-status');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden', 'error-bar');
  if (isError) el.classList.add('error-bar');
}

function cleanName(name) {
  return name.replace(/\.(mp4|mov|avi|mkv|webm)$/i, '');
}

function formatDate(iso) {
  return iso.slice(0, 10); // "YYYY-MM-DD"
}

function renderFiles(files) {
  const list = document.getElementById('file-list');
  list.innerHTML = '';

  if (files.length === 0) {
    list.innerHTML = '<div class="empty-state"><div>📭</div><p>אין שיעורים</p></div>';
    return;
  }

  filesList = files;

  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.id = file.id;
    item.dataset.name = file.name;
    item.dataset.date = file.createdTime;
    item.innerHTML = `
      <div class="file-item-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="file-item-text">
        <div class="file-item-name">${cleanName(file.name)}</div>
        <div class="file-item-date">${formatDate(file.createdTime)}${loadBookmark(file.id) > 0 ? ` · ↩ ${fmtTime(loadBookmark(file.id))}` : ''}</div>
      </div>
    `;
    item.addEventListener('click', () => playFile(file.id, file.name, file.createdTime));
    list.appendChild(item);
  });
}

// ─── Player ───────────────────────────────────────────────────────────────────
async function playFile(fileId, name, date) {
  currentFileId = fileId;
  currentFileIndex = filesList.findIndex(f => f.id === fileId);

  document.querySelectorAll('.file-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === fileId);
  });

  document.getElementById('player-title').textContent = cleanName(name);
  document.getElementById('player-bar').classList.remove('hidden');

  audio.pause();

  document.getElementById('player-seek').value = 0;
  document.getElementById('player-pos').textContent = '0:00';
  document.getElementById('player-dur').textContent = '0:00';

  try {
    // Wait for service worker to be ready (handles auth header injection)
    await navigator.serviceWorker.ready;

    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true&auth_token=${encodeURIComponent(accessToken)}`;
    audio.src = url;
    audio.load();

    // Resume from bookmark once metadata is loaded
    const saved = loadBookmark(fileId);
    if (saved > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration && saved < audio.duration - 10) {
          audio.currentTime = saved;
          setStatus(`ממשיך מ־${fmtTime(saved)}`);
          setTimeout(() => setStatus(''), 3000);
        }
      }, { once: true });
    }

    await audio.play();
    startBookmarkTimer(fileId);
    if (!saved) setStatus('');
  } catch (e) {
    console.error('Play failed:', e);
    setStatus('שגיאה: ' + e.message, true);
  }
}

function togglePlayPause() {
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
}

function playNext() {
  if (!filesList.length) return;
  const idx = (currentFileIndex + 1) % filesList.length;
  const f = filesList[idx];
  playFile(f.id, f.name, f.createdTime);
}

function playPrev() {
  if (!filesList.length) return;
  const idx = (currentFileIndex - 1 + filesList.length) % filesList.length;
  const f = filesList[idx];
  playFile(f.id, f.name, f.createdTime);
}

// ─── Audio event listeners ────────────────────────────────────────────────────
audio.addEventListener('play', () => {
  document.getElementById('icon-play').classList.add('hidden');
  document.getElementById('icon-pause').classList.remove('hidden');
});
audio.addEventListener('pause', () => {
  document.getElementById('icon-play').classList.remove('hidden');
  document.getElementById('icon-pause').classList.add('hidden');
});
audio.addEventListener('pause', () => {
  if (currentFileId) saveBookmark(currentFileId, audio.currentTime);
});
audio.addEventListener('ended', () => {
  document.getElementById('icon-play').classList.remove('hidden');
  document.getElementById('icon-pause').classList.add('hidden');
  if (currentFileId) clearBookmark(currentFileId);
  stopBookmarkTimer();
  playNext();
});
audio.addEventListener('timeupdate', () => {
  if (seekingByUser || !audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('player-seek').value = pct;
  document.getElementById('player-pos').textContent = fmtTime(audio.currentTime);
  document.getElementById('player-dur').textContent = fmtTime(audio.duration);
});

const seekSlider = document.getElementById('player-seek');
seekSlider.addEventListener('mousedown', () => { seekingByUser = true; });
seekSlider.addEventListener('touchstart', () => { seekingByUser = true; });
seekSlider.addEventListener('input', () => {
  if (audio.duration) {
    document.getElementById('player-pos').textContent = fmtTime((seekSlider.value / 100) * audio.duration);
  }
});
seekSlider.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (seekSlider.value / 100) * audio.duration;
  seekingByUser = false;
  if (currentFileId) saveBookmark(currentFileId, audio.currentTime);
});

function fmtTime(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Button wiring ────────────────────────────────────────────────────────────
document.getElementById('btn-signin').addEventListener('click', requestToken);
document.getElementById('btn-play').addEventListener('click', togglePlayPause);
document.getElementById('btn-prev').addEventListener('click', playPrev);
document.getElementById('btn-next').addEventListener('click', playNext);
document.getElementById('btn-signout').addEventListener('click', () => {
  clearSession();
  accessToken = null;
  audio.pause();
  audio.src = '';
  currentFileId = null;
  document.getElementById('player-bar').classList.add('hidden');
  showScreen('signin');
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW:', e));
}
loadGoogleAuth();
