// ─── Hebrew ordinal → number ──────────────────────────────────────────────────
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
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
let speedIndex = 1;

// ─── Bookmarks ────────────────────────────────────────────────────────────────
function markPlayed(fileId) {
  localStorage.setItem('done_' + fileId, '1');
  document.querySelectorAll(`.episode-item[data-id="${fileId}"]`).forEach(el => el.classList.add('played'));
}
function isPlayed(fileId) {
  return !!localStorage.getItem('done_' + fileId);
}
function saveBookmark(fileId, position) {
  if (!fileId || position < 5) return;
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
    if (!audio.paused && audio.currentTime > 0) saveBookmark(fileId, audio.currentTime);
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

// ─── Player open / close ──────────────────────────────────────────────────────
function openPlayer() {
  document.getElementById('screen-player').classList.add('open');
  document.getElementById('mini-player').classList.remove('visible');
}

function closePlayer() {
  document.getElementById('screen-player').classList.remove('open');
  if (currentFileId) document.getElementById('mini-player').classList.add('visible');
}

// ─── Drive API ────────────────────────────────────────────────────────────────
async function driveListFiles(folderId, pageToken) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,createdTime,mimeType),nextPageToken');
  let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 401) {
    accessToken = null;
    showScreen('signin');
    throw new Error('session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Drive API ${res.status}: ${body?.error?.message || res.status}`);
  }
  return res.json();
}

async function getAllVideosInFolder(folderId) {
  const children = await listAllItems(folderId);
  const subfolders = children.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  const directVideos = children.filter(f => f.mimeType?.startsWith('video/'));
  const subResults = await Promise.all(subfolders.map(sf => listAllItems(sf.id)));
  const subVideos = subResults.flat().filter(f => f.mimeType?.startsWith('video/'));
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
    if (e.message !== 'session expired') setStatus('שגיאה בטעינה: ' + e.message, true);
  } finally {
    setLoading(false);
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
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
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Render episode list ──────────────────────────────────────────────────────
function renderFiles(files) {
  const list = document.getElementById('file-list');
  list.innerHTML = '';

  if (files.length === 0) {
    list.innerHTML = '<div class="empty-state"><div>📭</div><p>אין שיעורים</p></div>';
    return;
  }

  filesList = files;

  files.forEach((file, index) => {
    const played = isPlayed(file.id);
    const isActive = file.id === currentFileId;
    const bookmark = loadBookmark(file.id);

    const item = document.createElement('div');
    item.className = 'episode-item' + (played ? ' played' : '') + (isActive ? ' active' : '');
    item.dataset.id = file.id;

    let metaHtml = `<span>${formatDate(file.createdTime)}</span>`;
    if (bookmark > 0 && !played) {
      metaHtml += `<span class="meta-sep">·</span><span class="meta-resume">↩ ${fmtTime(bookmark)}</span>`;
    }
    if (played) {
      metaHtml += `<span class="meta-sep">·</span><span class="meta-done">הושמע ✓</span>`;
    }

    item.innerHTML = `
      <div class="episode-num-col">
        <span class="episode-num">${index + 1}</span>
        <svg class="episode-play-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 3 20 12 6 21 6 3"/>
        </svg>
      </div>
      <div class="episode-text">
        <div class="episode-name">${cleanName(file.name)}</div>
        <div class="episode-meta">${metaHtml}</div>
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

  // Highlight active episode in list
  document.querySelectorAll('.episode-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === fileId);
  });

  const cleanTitle = cleanName(name);

  // Update full player
  document.getElementById('player-title').textContent = cleanTitle;

  // Update mini player
  document.getElementById('mini-title').textContent = cleanTitle;

  // Open full player
  openPlayer();

  // Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: cleanTitle, artist: 'ידידיה' });
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
    navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
    navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
  }

  audio.pause();

  const seekEl = document.getElementById('player-seek');
  seekEl.value = 0;
  seekEl.style.setProperty('--pct', '0%');
  document.getElementById('player-pos').textContent = '0:00';
  document.getElementById('player-dur').textContent = '0:00';
  document.getElementById('mini-progress').style.width = '0%';
  audio.playbackRate = SPEEDS[speedIndex];

  try {
    await navigator.serviceWorker.ready;

    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true&auth_token=${encodeURIComponent(accessToken)}`;
    audio.src = url;
    audio.load();

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
  if (audio.paused) audio.play();
  else audio.pause();
}

function playNext() {
  if (!filesList.length) return;
  const f = filesList[(currentFileIndex + 1) % filesList.length];
  playFile(f.id, f.name, f.createdTime);
}

function playPrev() {
  if (!filesList.length) return;
  const f = filesList[(currentFileIndex - 1 + filesList.length) % filesList.length];
  playFile(f.id, f.name, f.createdTime);
}

// ─── Audio event listeners ────────────────────────────────────────────────────
function syncPlayPauseIcons(playing) {
  document.getElementById('icon-play').classList.toggle('hidden', playing);
  document.getElementById('icon-pause').classList.toggle('hidden', !playing);
  document.getElementById('mini-icon-play').classList.toggle('hidden', playing);
  document.getElementById('mini-icon-pause').classList.toggle('hidden', !playing);
  document.getElementById('player-artwork').classList.toggle('playing', playing);
}

audio.addEventListener('play', () => syncPlayPauseIcons(true));

audio.addEventListener('pause', () => {
  syncPlayPauseIcons(false);
  if (currentFileId) saveBookmark(currentFileId, audio.currentTime);
});

audio.addEventListener('ended', () => {
  syncPlayPauseIcons(false);
  if (currentFileId) { clearBookmark(currentFileId); markPlayed(currentFileId); }
  stopBookmarkTimer();
  playNext();
});

audio.addEventListener('timeupdate', () => {
  if (seekingByUser || !audio.duration) return;

  const pct = (audio.currentTime / audio.duration) * 100;

  // Full player seek bar
  const seekEl = document.getElementById('player-seek');
  seekEl.value = pct;
  seekEl.style.setProperty('--pct', pct + '%');

  document.getElementById('player-pos').textContent = fmtTime(audio.currentTime);
  document.getElementById('player-dur').textContent = fmtTime(audio.duration);

  // Mini player progress bar
  document.getElementById('mini-progress').style.width = pct + '%';

  // Media session position
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: audio.currentTime,
      playbackRate: audio.playbackRate,
    });
  }
});

// ─── Seek slider ──────────────────────────────────────────────────────────────
const seekSlider = document.getElementById('player-seek');

seekSlider.addEventListener('mousedown', () => { seekingByUser = true; });
seekSlider.addEventListener('touchstart', () => { seekingByUser = true; }, { passive: true });

seekSlider.addEventListener('input', () => {
  if (audio.duration) {
    document.getElementById('player-pos').textContent = fmtTime((seekSlider.value / 100) * audio.duration);
    seekSlider.style.setProperty('--pct', seekSlider.value + '%');
  }
});

seekSlider.addEventListener('change', () => {
  if (audio.duration) audio.currentTime = (seekSlider.value / 100) * audio.duration;
  seekingByUser = false;
  if (currentFileId) saveBookmark(currentFileId, audio.currentTime);
});

// ─── Button wiring ────────────────────────────────────────────────────────────
document.getElementById('btn-signin').addEventListener('click', requestToken);

document.getElementById('btn-play').addEventListener('click', togglePlayPause);
document.getElementById('btn-prev').addEventListener('click', playPrev);
document.getElementById('btn-next').addEventListener('click', playNext);

document.getElementById('btn-skip-back').addEventListener('click', () => {
  audio.currentTime = Math.max(0, audio.currentTime - 15);
});
document.getElementById('btn-skip-fwd').addEventListener('click', () => {
  audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30);
});

document.getElementById('btn-speed').addEventListener('click', () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  audio.playbackRate = SPEEDS[speedIndex];
  document.getElementById('btn-speed').textContent = SPEEDS[speedIndex] + '×';
});

document.getElementById('btn-player-close').addEventListener('click', closePlayer);

// Mini player
document.getElementById('mini-player-tap').addEventListener('click', openPlayer);
document.getElementById('mini-play').addEventListener('click', togglePlayPause);
document.getElementById('mini-next').addEventListener('click', playNext);

document.getElementById('btn-signout').addEventListener('click', () => {
  clearSession();
  accessToken = null;
  audio.pause();
  audio.src = '';
  currentFileId = null;
  document.getElementById('screen-player').classList.remove('open');
  document.getElementById('mini-player').classList.remove('visible');
  showScreen('signin');
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW:', e));
}
loadGoogleAuth();
