'use strict';
/*
 * Instagram Saved Downloader: background service worker.
 *
 * How a sync works:
 *   1. Quietly open a background instagram.com tab (closed again at the end).
 *      All Instagram API calls run inside it, so they use your logged-in session.
 *   2. Read your collections from your Saved page (instagram.com/<you>/saved/),
 *      then page through each collection's posts, newest first.
 *   3. Page through "All posts" to catch saved posts that are in no collection.
 *   4. Every post that has never been downloaded is saved to
 *      Downloads/<base folder>/<collection>/ and recorded in chrome.storage.
 *
 * How it avoids re-downloading:
 *   - Each downloaded post is stored under the key "p:<post id>". A recorded
 *     post is never downloaded again, whichever collection it shows up in.
 *   - Feeds are ordered newest first. Once a feed has been fully read at least
 *     once, a sync stops reading it as soon as it hits a whole page with nothing
 *     new. A daily run usually needs only a few requests.
 *   - A post that was in "Unsorted" and later gets added to a collection is
 *     moved: it is downloaded into the collection folder and the old Unsorted
 *     copy is deleted (if Chrome still knows where that file is).
 */

const IG_ORIGIN = 'https://www.instagram.com';
const IG_APP_ID = '936619743392459';
const DEFAULT_SETTINGS = { autoSync: false, baseFolder: 'Instagram Saved', username: '' };
const UNSORTED_FOLDER = 'Unsorted';
const POST_PREFIX = 'p:';
const HOUR_MS = 60 * 60 * 1000;
const ALARM_NAME = 'autoSyncCheck';
const AUTO_SYNC_EVERY_MS = 23 * HOUR_MS;      // "daily", with a little slack
const AUTO_RETRY_AFTER_FAIL_MS = 6 * HOUR_MS; // don't hammer when logged out
const TIMING = {
  apiDelayMin: 1500,
  apiDelayMax: 3500,
  backoffBase: 30000,
  downloadPoll: 1000,
  downloadTimeout: 10 * 60 * 1000,
  tabLoadTimeout: 45000,
};

let running = false;
let cancelRequested = false;

class LoginError extends Error {}
class CancelError extends Error {}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (a, b) => a + Math.floor(Math.random() * (b - a));

/* ------------------------------------------------------------------ storage */

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getMeta() {
  const { meta } = await chrome.storage.local.get('meta');
  return { collections: {}, savedFeedFullyScanned: false, ...(meta || {}) };
}

async function saveMeta(meta) {
  await chrome.storage.local.set({ meta });
}

async function setStatus(patch) {
  const { status } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...(status || {}), ...patch, updatedAt: Date.now() } });
}

async function loadPosts() {
  const all = await chrome.storage.local.get(null);
  const posts = new Map();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(POST_PREFIX)) posts.set(key.slice(POST_PREFIX.length), value);
  }
  return posts;
}

async function savePost(record) {
  await chrome.storage.local.set({ [POST_PREFIX + record.id]: record });
}

/* ---------------------------------------------------------- instagram tab */

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Instagram took too long to load.'));
    }, TIMING.tabLoadTimeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') listener(tabId, { status: 'complete' });
    }).catch(() => {});
  });
}

// The extension works in its own background tab (never one of yours) and
// closes it when the sync ends.
async function openWorkerTab(ctx, path) {
  const tab = await chrome.tabs.create({ url: IG_ORIGIN + path, active: false });
  ctx.openedTabs.push(tab.id);
  await waitForTabComplete(tab.id);
  ctx.tab = { tabId: tab.id };
  return ctx.tab;
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Instagram took too long to load.')); }, TIMING.tabLoadTimeout);
    function listener(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) { cleanup(); resolve(); }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((e) => { cleanup(); reject(e); });
  });
}

async function runInTab(ctx, func, args = []) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: ctx.tab.tabId }, func, args });
      return injection && injection.result;
    } catch (e) {
      lastError = e; // page still switching documents; try again shortly
      await sleep(1500);
    }
  }
  throw lastError;
}

// Runs inside the instagram.com tab. Finds the logged-in username from the
// single profile-picture link on the Account settings page.
async function pageFindUsername() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    if (/\/accounts\/login/.test(location.pathname) || document.querySelector('input[name="password"]')) return { login: true };
    const users = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!/^\/[A-Za-z0-9._]+\/$/.test(href)) continue;
      if ([...a.querySelectorAll('img[alt]')].some((img) => /profile picture/i.test(img.alt))) users.add(href.slice(1, -1));
    }
    if (users.size === 1) return { username: [...users][0] };
    await sleep(500);
  }
  return { username: null };
}

// Runs inside the instagram.com tab on /<username>/saved/. Reads the
// collection tiles (links like /<username>/saved/<slug>/<collection id>/).
async function pageReadCollections() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Instagram drops tiles from the page as you scroll past them, so collect
  // them as we go instead of reading the page once at the end.
  const found = new Map();
  const collect = () => {
    for (const a of document.querySelectorAll('a[href*="/saved/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/saved\/([^/]+)\/(\d+)\/?$/);
      if (!m || found.has(m[2])) continue;
      const firstLine = (a.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean)[0];
      let slug = m[1];
      try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
      found.set(m[2], { id: m[2], name: firstLine || a.getAttribute('aria-label') || slug.replace(/-/g, ' ') });
    }
  };
  const hasAllPosts = () => !!document.querySelector('a[href*="/saved/all-posts"]');
  const loginWall = () => /\/accounts\/login/.test(location.pathname) || !!document.querySelector('input[name="password"]');
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;

  // Wait for the page to render (up to ~20 s).
  for (let i = 0; i < 40 && !found.size && !hasAllPosts(); i++) {
    if (loginWall()) return { login: true };
    collect();
    if (!found.size && !hasAllPosts()) await sleep(500);
  }
  collect();
  if (!found.size && !hasAllPosts()) return { ready: false, collections: [] };

  // Scroll down step by step until the bottom stops growing and nothing new appears.
  window.scrollTo(0, 0);
  await sleep(400);
  let quiet = 0;
  for (let i = 0; i < 400 && quiet < 6; i++) {
    const before = found.size;
    const height = document.documentElement.scrollHeight;
    window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.6)));
    await sleep(350);
    collect();
    quiet = atBottom() && found.size === before && document.documentElement.scrollHeight === height ? quiet + 1 : 0;
  }
  window.scrollTo(0, 0);
  return { ready: true, collections: [...found.values()] };
}

// Runs inside the instagram.com tab. Must be fully self-contained.
async function pageFetch(path, appId) {
  try {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    const res = await fetch(path, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-IG-App-ID': appId,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': m ? decodeURIComponent(m[1]) : '',
      },
    });
    return { status: res.status, url: res.url, text: await res.text() };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

function checkCancel() {
  if (cancelRequested) throw new CancelError('Sync stopped.');
}

async function igGet(ctx, path) {
  let lastProblem = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    checkCancel();
    let result;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: ctx.tab.tabId },
        func: pageFetch,
        args: [path, IG_APP_ID],
      });
      result = injection && injection.result;
    } catch (e) {
      // The tab was closed or navigated somewhere we can't run in. Open a new one.
      lastProblem = String(e.message || e);
      await openWorkerTab(ctx, '/');
      continue;
    }

    if (!result || result.error) {
      lastProblem = (result && result.error) || 'no response';
      await sleep(TIMING.backoffBase / 6 * (attempt + 1));
      continue;
    }

    const { status, text, url } = result;
    if (status === 429 || status >= 500) {
      lastProblem = `Instagram returned ${status}`;
      await setStatus({ message: `Instagram asked us to slow down. Waiting before retrying (${attempt + 1}/5)…` });
      await sleep(TIMING.backoffBase * (attempt + 1));
      continue;
    }

    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }

    if (status === 401 || status === 403 || (url && /\/accounts\/login/.test(url)) ||
        (json && (json.require_login || json.message === 'login_required'))) {
      throw new LoginError('You are not logged in to Instagram in this Chrome profile. Open instagram.com, log in, then sync again.');
    }
    if (json && (json.message === 'checkpoint_required' || json.message === 'challenge_required')) {
      throw new LoginError('Instagram wants you to confirm your account. Open instagram.com, complete the check, then sync again.');
    }
    if (status === 404) throw new HttpError(404, 'Not found');
    if (!json) {
      lastProblem = `unexpected response (${status})`;
      await sleep(TIMING.backoffBase / 3);
      continue;
    }
    if (status >= 400 || json.status === 'fail') {
      throw new HttpError(status, `Instagram error: ${json.message || status}`);
    }

    await sleep(randomBetween(TIMING.apiDelayMin, TIMING.apiDelayMax));
    return json;
  }
  throw new Error(`Instagram kept refusing requests (${lastProblem}). Progress is saved, so try again later.`);
}

/* ----------------------------------------------------------- media helpers */

function sanitize(name, fallback = 'Untitled') {
  const cleaned = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*~]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function bestUrl(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return sorted[0] && sorted[0].url;
}

function mediaFiles(media) {
  const nodes = Array.isArray(media.carousel_media) && media.carousel_media.length ? media.carousel_media : [media];
  const files = [];
  for (const node of nodes) {
    const video = bestUrl(node.video_versions);
    if (video) { files.push({ url: video, kind: 'video' }); continue; }
    const image = bestUrl(node.image_versions2 && node.image_versions2.candidates);
    if (image) files.push({ url: image, kind: 'image' });
  }
  return files;
}

function extensionFor(url, kind) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  } catch { /* fall through */ }
  return kind === 'video' ? 'mp4' : 'jpg';
}

function postId(media) {
  return String(media.pk != null ? media.pk : media.id).split('_')[0];
}

function baseName(media) {
  const date = media.taken_at ? new Date(media.taken_at * 1000).toISOString().slice(0, 10) : 'undated';
  const user = sanitize(media.user && media.user.username, 'unknown');
  const code = sanitize(media.code || postId(media));
  return `${date}_${user}_${code}`;
}

/* --------------------------------------------------------------- downloads */

async function downloadAndWait(url, filename) {
  const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  if (id === undefined) throw new Error('Chrome refused to start the download.');
  const started = Date.now();
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (!item) throw new Error('Download disappeared.');
    if (item.state === 'complete') return id;
    if (item.state === 'interrupted') throw new Error(`Download failed (${item.error || 'interrupted'}).`);
    if (Date.now() - started > TIMING.downloadTimeout) {
      try { await chrome.downloads.cancel(id); } catch { /* ignore */ }
      throw new Error('Download timed out.');
    }
    await sleep(TIMING.downloadPoll);
  }
}

async function downloadPost(media, folderName, settings) {
  const files = mediaFiles(media);
  if (!files.length) throw new Error('No photo or video found in this post.');
  const dir = `${sanitize(settings.baseFolder, DEFAULT_SETTINGS.baseFolder)}/${sanitize(folderName)}`;
  const base = baseName(media);
  return Promise.all(files.map(async (file, i) => {
    const suffix = files.length > 1 ? `_${String(i + 1).padStart(2, '0')}` : '';
    const filename = `${dir}/${base}${suffix}.${extensionFor(file.url, file.kind)}`;
    const downloadId = await downloadAndWait(file.url, filename);
    return { filename, downloadId };
  }));
}

async function removeOldFiles(record) {
  for (const f of record.files || []) {
    if (f.downloadId == null) continue;
    try { await chrome.downloads.removeFile(f.downloadId); } catch { /* moved or already gone */ }
    try { await chrome.downloads.erase({ id: f.downloadId }); } catch { /* ignore */ }
  }
}

/* -------------------------------------------------------------------- sync */

const LOGIN_MESSAGE = 'You are not logged in to Instagram in this Chrome profile. Open instagram.com, log in, then sync again.';
const COLLECTION_LIST_MAX_AGE_MS = 7 * 24 * HOUR_MS;

// Instagram only draws the collection grid in a tab you can see, so the
// collection list is read in a small window that closes itself after a few
// seconds. The list is then remembered, so most syncs never open it.
async function readCollectionsInWindow(settings) {
  await setStatus({ message: 'Reading your collections (a small Instagram window opens for a few seconds)…' });
  let username = settings.username;
  if (!username) {
    try {
      for (const t of await chrome.tabs.query({ url: IG_ORIGIN + '/*' })) {
        const m = (t.url || '').match(/^https:\/\/www\.instagram\.com\/([A-Za-z0-9._]+)\/saved\//);
        if (m) { username = m[1]; break; }
      }
    } catch { /* ignore */ }
  }
  const savedUrl = (u) => `${IG_ORIGIN}/${encodeURIComponent(u)}/saved/`;
  const win = await chrome.windows.create({
    url: username ? savedUrl(username) : IG_ORIGIN + '/accounts/edit/',
    type: 'popup', width: 520, height: 860, focused: true,
  });
  const vctx = { tab: { tabId: win.tabs[0].id } };
  const findUsername = async () => {
    await navigateTab(vctx.tab.tabId, IG_ORIGIN + '/accounts/edit/');
    const res = await runInTab(vctx, pageFindUsername);
    if (res && res.login) throw new LoginError(LOGIN_MESSAGE);
    return (res && res.username) || null;
  };
  try {
    await waitForTabComplete(vctx.tab.tabId);
    let fromSettings = !!username;
    if (!username) {
      const res = await runInTab(vctx, pageFindUsername);
      if (res && res.login) throw new LoginError(LOGIN_MESSAGE);
      username = res && res.username;
      if (!username) throw new Error("Couldn't work out your Instagram username. Enter it under Settings in this popup, then sync again.");
      await navigateTab(vctx.tab.tabId, savedUrl(username));
    }
    let page = (await runInTab(vctx, pageReadCollections)) || { ready: false };
    if (page.login) throw new LoginError(LOGIN_MESSAGE);
    if (!page.ready && fromSettings) {
      // The stored username may be stale (for example, you switched accounts).
      const fresh = await findUsername();
      if (fresh && fresh !== username) {
        username = fresh;
        await navigateTab(vctx.tab.tabId, savedUrl(username));
        page = (await runInTab(vctx, pageReadCollections)) || { ready: false };
      }
    }
    if (!page.ready) {
      throw new Error(`Couldn't read your collections at instagram.com/${username}/saved/. Check the username under Settings.`);
    }
    if (username !== settings.username) {
      settings.username = username;
      await chrome.storage.local.set({ settings: { ...(await getSettings()), username } });
    }
    return page.collections.map((c) => ({ id: String(c.id), name: c.name || `Collection ${String(c.id).slice(-4)}` }));
  } finally {
    try { await chrome.windows.remove(win.id); } catch { /* already closed */ }
  }
}

function withFolders(list) {
  // Two collections with the same name would share a folder. Keep them apart.
  const counts = new Map();
  for (const c of list) counts.set(c.name.toLowerCase(), (counts.get(c.name.toLowerCase()) || 0) + 1);
  return list.map((c) => ({ ...c, folder: counts.get(c.name.toLowerCase()) > 1 ? `${c.name} (${c.id.slice(-4)})` : c.name }));
}

async function getCollections(state, { force = false } = {}) {
  const cached = state.meta.collectionList;
  const fresh = Array.isArray(cached) && Date.now() - (state.meta.collectionsReadAt || 0) < COLLECTION_LIST_MAX_AGE_MS;
  if (fresh && !force) return withFolders(cached);
  const list = await readCollectionsInWindow(state.settings);
  state.meta.collectionList = list;
  state.meta.collectionsReadAt = Date.now();
  for (const c of list) {
    state.meta.collections[c.id] = { ...(state.meta.collections[c.id] || { fullyScanned: false }), name: c.name };
  }
  await saveMeta(state.meta);
  return withFolders(list);
}

async function feedPage(ctx, source, maxId) {
  const q = `?max_id=${encodeURIComponent(maxId)}`;
  if (source.kind === 'saved') return igGet(ctx, `/api/v1/feed/saved/posts/${q}`);
  try {
    return await igGet(ctx, `/api/v1/feed/collection/${source.id}/posts/${q}`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return igGet(ctx, `/api/v1/feed/collection/${source.id}/${q}`);
    throw e;
  }
}

async function handleMedia(media, source, state) {
  const id = postId(media);
  const existing = state.posts.get(id);
  let folder;
  let collectionId;

  if (source.kind === 'collection') {
    if (existing && existing.collectionId) return 'known';
    folder = source.folder;
    collectionId = source.id;
  } else {
    if (existing) return 'known';
    const ids = (media.saved_collection_ids || []).map(String);
    const match = state.collections.find((c) => ids.includes(c.id));
    const ignored = new Set(state.meta.ignoredCollectionIds || []);
    const unknownIds = ids.filter((x) => !ignored.has(x) && !state.collections.some((c) => c.id === x));
    if (!match && unknownIds.length) {
      unknownIds.forEach((x) => state.unknownIds.add(x));
      if (!state.collectionsRefreshed) {
        // It's in a collection we haven't seen yet (a new one). Re-read the
        // collection list after this pass instead of filing it under Unsorted.
        state.unknownCollectionSeen = true;
        return 'deferred';
      }
    }
    folder = match ? match.folder : UNSORTED_FOLDER;
    collectionId = match ? match.id : null;
  }

  try {
    const files = await downloadPost(media, folder, state.settings);
    const record = {
      id,
      code: media.code || null,
      username: (media.user && media.user.username) || null,
      takenAt: media.taken_at || null,
      folder,
      collectionId,
      files,
      downloadedAt: Date.now(),
    };
    await savePost(record);
    state.posts.set(id, record);
    if (state.failedIds.delete(id)) state.run.failed = state.failedIds.size;
    if (existing) {
      await removeOldFiles(existing);
      state.run.moved++;
      return 'moved';
    }
    state.run.newPosts++;
    state.run.newFiles += files.length;
    return 'new';
  } catch (e) {
    if (e instanceof CancelError) throw e;
    state.failedIds.add(id);
    state.run.failed = state.failedIds.size;
    state.run.lastFailure = `${media.code || id}: ${e.message || e}`;
    return 'failed';
  }
}

async function scanFeed(ctx, source, state) {
  const label = source.kind === 'saved' ? 'All posts (for Unsorted)' : `“${source.name}”`;
  const metaEntry = source.kind === 'saved' ? null : (state.meta.collections[source.id] ||= { name: source.name, fullyScanned: false });
  const fullyScannedBefore = source.kind === 'saved' ? state.meta.savedFeedFullyScanned : metaEntry.fullyScanned;
  // A feed where something failed last time is read in full, so old posts that
  // failed (which sit on later pages) get retried instead of skipped by the early stop.
  const feedKey = source.kind === 'saved' ? 'saved' : source.id;
  const retryFeeds = new Set(state.meta.retryFeeds || []);
  const canStopEarly = fullyScannedBefore && !state.fullScan && !retryFeeds.has(feedKey);
  const failedHere = new Set();
  const finish = async () => {
    const stillFailed = [...failedHere].some((id) => !state.posts.has(id));
    if (stillFailed) retryFeeds.add(feedKey); else retryFeeds.delete(feedKey);
    state.meta.retryFeeds = [...retryFeeds];
    await saveMeta(state.meta);
  };

  let maxId = '';
  for (let page = 1; ; page++) {
    checkCancel();
    await setStatus({ message: `Checking ${label}, page ${page}…`, run: state.run });
    const data = await feedPage(ctx, source, maxId);
    const items = (data.items || []).map((it) => it.media || it).filter((m) => m && (m.pk != null || m.id));

    let pageHadWork = false;
    for (const media of items) {
      checkCancel();
      const outcome = await handleMedia(media, source, state);
      if (outcome === 'failed') failedHere.add(postId(media));
      if (outcome !== 'known') {
        pageHadWork = true;
        await setStatus({ run: state.run });
      }
    }

    if (!data.more_available || !data.next_max_id) {
      if (source.kind === 'saved') state.meta.savedFeedFullyScanned = true;
      else metaEntry.fullyScanned = true;
      return finish();
    }
    if (canStopEarly && items.length && !pageHadWork) return finish(); // caught up with last sync
    maxId = data.next_max_id;
  }
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* ignore */ }
}

async function runSync({ auto = false, fullScan = false } = {}) {
  if (running) return { started: false, reason: 'A sync is already running.' };
  running = true;
  cancelRequested = false;
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);

  const meta = await getMeta();
  if (auto) { meta.lastAutoAttemptAt = Date.now(); await saveMeta(meta); }

  const state = {
    settings: await getSettings(),
    meta,
    posts: await loadPosts(),
    collections: [],
    failedIds: new Set(),
    unknownIds: new Set(),
    fullScan,
    run: { startedAt: Date.now(), auto, fullScan, newPosts: 0, newFiles: 0, moved: 0, failed: 0 },
  };
  const ctx = { tab: null, openedTabs: [] };

  await setStatus({ state: 'running', message: 'Connecting to Instagram…', error: null, run: state.run });
  await setBadge('…', '#6b7280');

  try {
    // A full re-check also refreshes the collection list.
    state.collections = await getCollections(state, { force: fullScan });
    state.collectionsRefreshed = fullScan || state.meta.collectionsReadAt >= state.run.startedAt;
    await openWorkerTab(ctx, '/accounts/edit/');

    for (const c of state.collections) {
      await scanFeed(ctx, { kind: 'collection', id: c.id, name: c.name, folder: c.folder }, state);
    }
    await scanFeed(ctx, { kind: 'saved' }, state);

    if (state.unknownCollectionSeen) {
      // A post sits in a collection we don't know yet: re-read the list, scan
      // the new collections, then finish the posts we held back.
      const known = new Set(state.collections.map((c) => c.id));
      state.collections = await getCollections(state, { force: true });
      state.collectionsRefreshed = true;
      for (const c of state.collections.filter((x) => !known.has(x.id))) {
        await scanFeed(ctx, { kind: 'collection', id: c.id, name: c.name, folder: c.folder }, state);
      }
      await scanFeed(ctx, { kind: 'saved' }, state);
    }

    // Collection IDs still unknown after a fresh read of the Saved page aren't
    // real visible collections; stop re-reading the list because of them.
    if (state.collectionsRefreshed) {
      const known = new Set(state.collections.map((c) => c.id));
      const stillUnknown = [...state.unknownIds].filter((x) => !known.has(x));
      state.meta.ignoredCollectionIds = [...new Set([...(state.meta.ignoredCollectionIds || []), ...stillUnknown])];
    }

    state.run.finishedAt = Date.now();
    state.meta.lastSuccessAt = state.run.finishedAt;
    state.meta.lastRun = state.run;
    await saveMeta(state.meta);

    const { newPosts, moved, failed } = state.run;
    const parts = [newPosts ? `${newPosts} new post${newPosts === 1 ? '' : 's'} downloaded` : 'No new posts. Everything is up to date'];
    if (moved) parts.push(`${moved} moved from Unsorted into a collection`);
    if (failed) parts.push(`${failed} failed and will be retried next sync`);
    await setStatus({ state: 'done', message: parts.join(' · ') + '.', run: state.run });
    await setBadge(failed ? '!' : newPosts ? String(Math.min(newPosts, 999)) : '', failed ? '#d97706' : '#16a34a');
  } catch (e) {
    state.run.finishedAt = Date.now();
    state.meta.lastRun = state.run;
    await saveMeta(state.meta);
    const cancelled = e instanceof CancelError;
    await setStatus({
      state: cancelled ? 'cancelled' : 'error',
      message: cancelled ? 'Sync stopped. Everything downloaded so far is saved. Press Sync to continue.' : (e.message || String(e)),
      error: cancelled ? null : (e.message || String(e)),
      run: state.run,
    });
    await setBadge(cancelled ? '' : '!', '#dc2626');
  } finally {
    clearInterval(keepAlive);
    for (const tabId of ctx.openedTabs) {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
    running = false;
    cancelRequested = false;
  }
  return { started: true };
}

/* ---------------------------------------------------------- auto + events */

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: 60 });
}

async function maybeAutoSync() {
  const settings = await getSettings();
  if (!settings.autoSync || running) return;
  const meta = await getMeta();
  const now = Date.now();
  const dueBySuccess = now - (meta.lastSuccessAt || 0) >= AUTO_SYNC_EVERY_MS;
  const allowedByRetry = now - (meta.lastAutoAttemptAt || 0) >= AUTO_RETRY_AFTER_FAIL_MS;
  if (dueBySuccess && allowedByRetry) runSync({ auto: true });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) maybeAutoSync();
});
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); maybeAutoSync(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'sync':
        if (running) return { started: false, reason: 'A sync is already running.' };
        runSync({ fullScan: !!msg.fullScan });
        return { started: true };
      case 'cancel':
        if (running) cancelRequested = true;
        return { ok: true };
      case 'isRunning':
        return { running };
      case 'resetHistory': {
        if (running) return { ok: false, reason: 'Stop the sync first.' };
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter((k) => k.startsWith(POST_PREFIX) || k === 'meta' || k === 'status');
        await chrome.storage.local.remove(keys);
        await setBadge('');
        return { ok: true };
      }
      case 'importHistory': {
        if (running) return { ok: false, reason: 'Stop the sync first.' };
        const data = msg.data || {};
        if (!data.posts || typeof data.posts !== 'object') return { ok: false, reason: 'That file is not a history export.' };
        const toSet = {};
        for (const [id, rec] of Object.entries(data.posts)) {
          if (rec && typeof rec === 'object') toSet[POST_PREFIX + id] = { ...rec, id };
        }
        if (data.meta && typeof data.meta === 'object') toSet.meta = { ...(await getMeta()), ...data.meta };
        await chrome.storage.local.set(toSet);
        return { ok: true, count: Object.keys(data.posts).length };
      }
      default:
        return { ok: false, reason: 'unknown message' };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e.message || e) }));
  return true;
});

// A fresh service worker never has a sync in progress. A "running" status left
// in storage means the last sync was cut off (Chrome closed, worker killed…).
(async () => {
  await ensureAlarm();
  const { status } = await chrome.storage.local.get('status');
  if (status && status.state === 'running' && !running) {
    await setStatus({
      state: 'error',
      message: 'The last sync was interrupted. Press Sync to continue. Posts already downloaded will be skipped.',
    });
  }
})();
