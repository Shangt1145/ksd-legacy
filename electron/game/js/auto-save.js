/* Native player storage survives release folders and web origin changes.
 * Plain browsers keep their existing storage. Android and Electron also keep
 * a complete, versioned native snapshot, including the original image bytes.
 */
(function (g) {
  'use strict';
  let bridge = g.KG_PLAYER_STORAGE;
  if (!bridge && g.Capacitor && g.Capacitor.isNativePlatform()) {
    const native = g.Capacitor.registerPlugin('PlayerStorage');
    bridge = { read: async () => (await native.read()).snapshot || null,
      write: snapshot => native.write({ snapshot }) };
  }
  const owns = k => /^kg[._]/.test(k);
  function storage() {
    const out = {};
    Object.keys(localStorage).filter(owns).sort().forEach(k => { out[k] = localStorage.getItem(k); });
    return out;
  }
  function dbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('kg-cards', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function images() {
    const db = await dbOpen(), blobs = {};
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readonly'), req = tx.objectStore('images').openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { blobs[c.key] = c.value; c.continue(); } };
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('卡图读取失败'));
      });
    } finally { db.close(); }
    const out = {};
    await Promise.all(Object.entries(blobs).map(async ([id, blob]) => {
      out[id] = await new Promise((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob);
      });
    }));
    return out;
  }
  function validate(s) {
    if (!s || s.format !== 'kards-player-data' || s.version !== 1 || !s.storage || !s.images ||
        Array.isArray(s.storage) || Array.isArray(s.images)) throw new Error('玩家存档格式不受支持');
    for (const [k, v] of Object.entries(s.storage)) if (!owns(k) || typeof v !== 'string') throw new Error('玩家存档字段无效');
    for (const [k, v] of Object.entries(s.images)) if (!k || typeof v !== 'string' || !/^data:[^,]*;base64,[A-Za-z0-9+/=]*$/.test(v)) throw new Error('玩家卡图无效');
  }
  async function putImages(values) {
    const entries = Object.entries(values).map(([k, url]) => {
      const [head, base64] = url.split(','), bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      return [k, new Blob([bytes], { type: head.slice(5).split(';')[0] })];
    });
    const db = await dbOpen();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('images', 'readwrite'), store = tx.objectStore('images');
        store.clear(); entries.forEach(([k, blob]) => store.put(blob, k));
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('卡图恢复失败'));
      });
    } finally { db.close(); }
  }
  function putStorage(values) {
    Object.keys(localStorage).filter(owns).forEach(k => { if (!(k in values)) localStorage.removeItem(k); });
    Object.entries(values).forEach(([k, v]) => localStorage.setItem(k, v));
  }
  let ready = false, blocked = false, dirty = 0, imageDirty = true, cacheImages = {}, timer, task = null, last = '';
  function fail(e) {
    console.error('[自动存档]', e);
    g.KG_AUTO_SAVE.error = e.message || String(e);
    g.dispatchEvent(new CustomEvent('kg-save-error', { detail: g.KG_AUTO_SAVE.error }));
  }
  async function flush() {
    clearTimeout(timer);
    if (!bridge || !ready || blocked) return;
    if (task) { await task; return flush(); }
    task = (async () => {
      do {
        const revision = dirty, raw = storage(), signature = JSON.stringify(raw);
        if (imageDirty) {
          imageDirty = false;
          try { cacheImages = await images(); } catch (e) { imageDirty = true; throw e; }
        } else if (signature === last && !dirty) return;
        await bridge.write({ format: 'kards-player-data', version: 1, savedAt: new Date().toISOString(),
          origin: location.origin, storage: raw, images: cacheImages });
        last = signature;
        if (revision === dirty) dirty = 0;
      } while (dirty || imageDirty);
      g.KG_AUTO_SAVE.error = null;
    })();
    try { await task; } catch (e) { fail(e); throw e; } finally { task = null; }
  }
  function changed(image) {
    if (!bridge || !ready || blocked) return;
    dirty++; if (image) imageDirty = true;
    clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 120);
  }
  let initTask;
  function init() { return initTask || (initTask = initialize()); }
  // Finish the native snapshot before a page change restores it in the next page.
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || a.target === '_blank') return;
    const next = new URL(a.href, location.href);
    if (next.origin !== location.origin || !/\/game\/(?:index|inspector)\.html$/.test(next.pathname)) return;
    e.preventDefault();
    if (g.KG_BEFORE_NAVIGATE && !(await g.KG_BEFORE_NAVIGATE())) return;
    try { await init(); await flush(); g.KG_NAV_APPROVED = true; location.assign(next.href); }
    catch(e) { fail(e); let notice=document.getElementById('kg-save-notice');if(!notice){notice=document.createElement('div');notice.id='kg-save-notice';notice.setAttribute('role','alert');notice.style.cssText='position:fixed;bottom:12px;left:12px;right:12px;padding:16px;background:#732d26;color:white;z-index:10000';document.body.append(notice);}notice.textContent='自动存档失败，已保留当前页面：'+e.message; }
  });
  async function initialize() {
    if (!bridge || ready) return;
    try {
      const saved = await bridge.read();
      g.KG_AUTO_SAVE.restored = !!saved;
      if (saved) {
        validate(saved);
        const before = storage(), oldImages = await images();
        try { await putImages(saved.images); putStorage(saved.storage); }
        catch (e) { putStorage(before); await putImages(oldImages); throw e; }
        cacheImages = saved.images; imageDirty = false;
      }
      ready = true;
      await flush(); // Adopt old web saves before any game initialization writes.
      const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
      Storage.prototype.setItem = function (k, v) { const r = set.call(this, k, v); if (this === localStorage && owns(k)) changed(); return r; };
      Storage.prototype.removeItem = function (k) { const r = remove.call(this, k); if (this === localStorage && owns(k)) changed(); return r; };
      Storage.prototype.clear = function () { const r = clear.call(this); if (this === localStorage) changed(); return r; };
      document.addEventListener('visibilitychange', () => { if (document.hidden) flush().catch(() => {}); });
      g.addEventListener('pagehide', () => flush().catch(() => {}));
    } catch (e) { blocked = true; fail(e); throw e; }
  }
  g.KG_AUTO_SAVE = { init, flush, imagesChanged: () => changed(true), error: null, restored: false };
})(window);
