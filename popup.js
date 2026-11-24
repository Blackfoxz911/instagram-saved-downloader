'use strict';

const POST_PREFIX = 'p:';
const DEFAULT_SETTINGS = { autoSync: false, baseFolder: 'Instagram Saved', username: '' };
const $ = (id) => document.getElementById(id);

const STATE_TITLES = {
  running: 'Syncing…',
  done: 'Up to date',
  error: 'Needs attention',
  cancelled: 'Stopped',
};

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, reason: String(e.message || e) }));
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleString();
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function render() {
  const all = await chrome.storage.local.get(null);
  const status = all.status || {};
  const meta = all.meta || {};
  const { running } = await send({ type: 'isRunning' });
  const state = running ? 'running' : (status.state === 'running' ? 'error' : status.state);

  $('statusDot').className = 'dot ' + (state || '');
  $('statusTitle').textContent = STATE_TITLES[state] || 'Ready';
  $('statusMessage').textContent = status.message || 'Press Sync to download your saved posts.';

  const run = status.run;
  if (run && (state === 'running' || run.newPosts || run.moved || run.failed)) {
    const bits = [`${run.newPosts || 0} new`, `${run.newFiles || 0} files`];
    if (run.moved) bits.push(`${run.moved} moved`);
    if (run.failed) bits.push(`${run.failed} failed`);
    $('runCounts').textContent = (state === 'running' ? 'This sync: ' : 'Last sync: ') + bits.join(' · ');
    $('runCounts').title = run.lastFailure ? `Last failure: ${run.lastFailure}` : '';
    $('runCounts').hidden = false;
  } else {
    $('runCounts').hidden = true;
  }
  $('lastSync').textContent = `Last successful sync: ${timeAgo(meta.lastSuccessAt)}`;

  $('syncBtn').disabled = !!running;
  $('syncBtn').textContent = running ? 'Syncing…' : 'Sync now';
  $('stopBtn').hidden = !running;
  $('fullScanBtn').disabled = !!running;

  // Folder counts
  const counts = new Map();
  let total = 0;
  for (const [key, rec] of Object.entries(all)) {
    if (!key.startsWith(POST_PREFIX)) continue;
    total++;
    const folder = (rec && rec.folder) || 'Unsorted';
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  const list = $('folderList');
  list.textContent = '';
  if (!total) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Nothing downloaded yet.';
    list.append(li);
  } else {
    const rows = [...counts.entries()].sort((a, b) => {
      if (a[0] === 'Unsorted') return 1;
      if (b[0] === 'Unsorted') return -1;
      return a[0].localeCompare(b[0]);
    });
    for (const [name, n] of rows) {
      const li = document.createElement('li');
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      nameEl.title = name;
      const numEl = document.createElement('span');
      numEl.className = 'num';
      numEl.textContent = `${n} post${n === 1 ? '' : 's'}`;
      li.append(nameEl, numEl);
      list.append(li);
    }
  }
  $('totalCount').textContent = total ? `(${total})` : '';
}

let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

async function init() {
  try { await chrome.action.setBadgeText({ text: '' }); } catch { /* ignore */ }

  const settings = await getSettings();
  $('autoSync').checked = settings.autoSync;
  $('baseFolder').value = settings.baseFolder;
  $('username').value = settings.username || '';

  $('syncBtn').addEventListener('click', async () => {
    $('syncBtn').disabled = true;
    const res = await send({ type: 'sync' });
    if (!res.started && res.reason) $('statusMessage').textContent = res.reason;
    scheduleRender();
  });

  $('stopBtn').addEventListener('click', async () => {
    $('stopBtn').disabled = true;
    $('statusMessage').textContent = 'Stopping after the current post…';
    await send({ type: 'cancel' });
    $('stopBtn').disabled = false;
  });

  $('fullScanBtn').addEventListener('click', async () => {
    const res = await send({ type: 'sync', fullScan: true });
    $('settingsNote').textContent = res.started
      ? 'Full re-check started. Already-downloaded posts are still skipped.'
      : (res.reason || 'Could not start.');
    scheduleRender();
  });

  $('autoSync').addEventListener('change', async (e) => {
    await saveSettings({ autoSync: e.target.checked });
  });

  $('username').addEventListener('change', async (e) => {
    const value = e.target.value.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');
    e.target.value = value;
    await saveSettings({ username: value });
    $('settingsNote').textContent = value ? `Using instagram.com/${value}/saved/` : 'Username will be detected on the next sync.';
  });

  $('baseFolder').addEventListener('change', async (e) => {
    const value = e.target.value.trim() || DEFAULT_SETTINGS.baseFolder;
    e.target.value = value;
    await saveSettings({ baseFolder: value });
    $('settingsNote').textContent = `New downloads will go to Downloads/${value}/…`;
  });

  $('exportBtn').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    const posts = {};
    for (const [k, v] of Object.entries(all)) if (k.startsWith(POST_PREFIX)) posts[k.slice(POST_PREFIX.length)] = v;
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), meta: all.meta || {}, posts }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `instagram-saved-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('settingsNote').textContent = `Exported ${Object.keys(posts).length} posts.`;
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await send({ type: 'importHistory', data });
      $('settingsNote').textContent = res.ok ? `Imported ${res.count} posts. They won't be downloaded again.` : res.reason;
    } catch {
      $('settingsNote').textContent = 'That file could not be read.';
    }
    e.target.value = '';
    scheduleRender();
  });

  let resetArmed = null;
  $('resetBtn').addEventListener('click', async () => {
    const btn = $('resetBtn');
    if (!resetArmed) {
      btn.classList.add('confirming');
      btn.textContent = 'Click again to confirm';
      resetArmed = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = 'Reset history';
        resetArmed = null;
      }, 4000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    btn.classList.remove('confirming');
    btn.textContent = 'Reset history';
    const res = await send({ type: 'resetHistory' });
    $('settingsNote').textContent = res.ok
      ? 'History cleared. The next sync will download everything again (existing files are overwritten, not duplicated).'
      : res.reason;
    scheduleRender();
  });

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') scheduleRender();
  });

  await render();
  setInterval(render, 5000); // keep "x min ago" and running state fresh
}

init();
