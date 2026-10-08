'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const MARKER_COLORS = ['#ffd84d', '#4dabff', '#ff6b9a', '#5fd38d', '#b18cff', '#ff9f43'];
const INK_COLORS = ['#e5484d', '#1f6feb', '#2da44e', '#111111', '#f5b301', '#a855f7'];
const DEFAULT_SETTINGS = {
  rowDir: 'up',      // 'up' = charts (bottom → top), 'down' = written (top → bottom)
  stDir: 'rtl',      // current stitch direction: 'rtl' or 'ltr'
  flip: false,       // flip stitch direction on every row change (flat knitting)
  dim: true,         // shade already-worked rows
  rowColor: '#ffd84d',
  colColor: '#4dabff',
  opacity: 0.35,
};

/* =========================================================
   Storage (IndexedDB) — projects and their PDF files
   ========================================================= */
const db = {
  _p: null,
  open() {
    this._p ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('stitch-tracker', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('projects', { keyPath: 'id' });
        req.result.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._p;
  },
  async run(store, mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  getAll: (store) => db.run(store, 'readonly', (s) => s.getAll()),
  get: (store, id) => db.run(store, 'readonly', (s) => s.get(id)),
  put: (store, value) => db.run(store, 'readwrite', (s) => s.put(value)),
  del: (store, id) => db.run(store, 'readwrite', (s) => s.delete(id)),
};

/* =========================================================
   App state
   ========================================================= */
let project = null;     // currently open project
let pdfDoc = null;      // pdf.js document for it
let pageBase = null;    // { w, h } of current page at scale 1
let mode = 'track';     // 'track' | 'draw'
const pen = { tool: 'pen', color: INK_COLORS[0], size: 4 };
const undoStacks = {};  // page number -> array of stroke snapshots

const stage = $('#stage');
const pageWrap = $('#pageWrap');
const pdfCanvas = $('#pdfCanvas');
const inkCanvas = $('#inkCanvas');
const rowBar = $('#rowBar');
const colBar = $('#colBar');

function defaultPageState() {
  return {
    row: { y: 0.5, h: 0.03, visible: true },
    col: { x: 0.5, w: 0.025, visible: true, start: {} },
    strokes: [],
  };
}
function pageState(n = project.currentPage) {
  project.pageState[n] ??= defaultPageState();
  return project.pageState[n];
}

let saveTimer;
function save() {
  if (!project) return;
  project.updated = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.put('projects', project), 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  return project ? db.put('projects', project) : Promise.resolve();
}

function show(viewId) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== viewId;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

async function renderToCanvas(pageNum, width) {
  const page = await pdfDoc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c;
}

/* =========================================================
   Library
   ========================================================= */
async function showLibrary() {
  await saveNow();
  project = null;
  pdfDoc?.destroy();
  pdfDoc = null;
  releaseWakeLock();
  $('#notesPanel').hidden = true;
  show('library');

  const list = (await db.getAll('projects')).sort((a, b) => b.updated - a.updated);
  const grid = $('#projectGrid');
  grid.innerHTML = '';
  $('#emptyMsg').hidden = list.length > 0;

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="thumb">${p.thumb ? `<img alt="">` : '🧶'}</div>
      <div class="info"><strong class="ellipsis"></strong><small class="muted"></small></div>
      <div class="actions">
        <button class="btn" data-act="rename">Rename</button>
        <button class="btn" data-act="delete">Delete</button>
      </div>`;
    if (p.thumb) card.querySelector('img').src = p.thumb;
    card.querySelector('strong').textContent = p.name;
    card.querySelector('small').textContent =
      `Row ${p.counters.row} · page ${p.currentPage} · ${new Date(p.updated).toLocaleDateString()}`;
    card.onclick = () => openProject(p.id);
    card.querySelector('[data-act=rename]').onclick = async (e) => {
      e.stopPropagation();
      const name = prompt('Pattern name', p.name);
      if (name?.trim()) {
        p.name = name.trim();
        await db.put('projects', p);
        showLibrary();
      }
    };
    card.querySelector('[data-act=delete]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name}" and all its progress and notes?`)) return;
      await db.del('projects', p.id);
      await db.del('files', p.id);
      showLibrary();
    };
    grid.appendChild(card);
  }
}

$('#fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const buf = await file.arrayBuffer();
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
  } catch (err) {
    console.error(err);
    alert('Sorry, that PDF could not be opened.');
    return;
  }
  const id = uid();
  await db.put('files', { id, data: buf });
  pdfDoc = doc;
  project = {
    id,
    name: file.name.replace(/\.pdf$/i, ''),
    created: Date.now(),
    updated: Date.now(),
    numPages: doc.numPages,
    pages: Array.from({ length: doc.numPages }, (_, i) => i + 1),
    patternPage: 1,
    currentPage: 1,
    zoom: 1,
    notes: '',
    pageState: {},
    counters: { row: 1, stitch: 1 },
    settings: { ...DEFAULT_SETTINGS },
    thumb: null,
  };
  await saveNow();
  showPicker(true);
};

/* ---------- backup & restore (to move patterns between devices) ---------- */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

$('#backupBtn').onclick = async () => {
  const projects = await db.getAll('projects');
  if (!projects.length) return toast('Nothing to back up yet');
  toast('Preparing backup…');
  for (const p of projects) {
    const f = await db.get('files', p.id);
    p.pdf = await blobToDataURL(new Blob([f.data], { type: 'application/pdf' }));
  }
  const json = JSON.stringify({ app: 'stitch-tracker', version: 1, exported: Date.now(), projects });
  const name = `stitch-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });

  // On phones the share sheet is the reliable way to save/send a file
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Stitch Tracker backup' });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

$('#restoreInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
    if (backup.app !== 'stitch-tracker' || !Array.isArray(backup.projects)) throw new Error('not a backup');
  } catch {
    return alert("That file isn't a Stitch Tracker backup.");
  }
  const existing = new Set((await db.getAll('projects')).map((p) => p.id));
  const overlap = backup.projects.filter((p) => existing.has(p.id)).length;
  const msg = `Restore ${backup.projects.length} pattern(s)?` +
    (overlap ? `\n\n${overlap} already exist here and will be replaced by the backup version.` : '');
  if (!confirm(msg)) return;
  for (const { pdf, ...p } of backup.projects) {
    const data = await (await fetch(pdf)).arrayBuffer();
    await db.put('files', { id: p.id, data });
    await db.put('projects', p);
  }
  toast('Backup restored');
  showLibrary();
};

async function openProject(id) {
  project = await db.get('projects', id);
  const file = await db.get('files', id);
  if (!project || !file) {
    alert('This pattern could not be loaded.');
    return showLibrary();
  }
  project.settings = { ...DEFAULT_SETTINGS, ...project.settings };
  pdfDoc = await pdfjsLib.getDocument({ data: file.data }).promise;
  openViewer();
}

/* =========================================================
   Page picker
   ========================================================= */
let pickerSeq = 0;
function showPicker(isNew) {
  show('picker');
  $('#pickerTitle').textContent = project.name;
  const selected = new Set(project.pages);
  let star = project.patternPage;
  const grid = $('#pickerGrid');
  grid.innerHTML = '';
  const cards = [];

  const refresh = () => {
    cards.forEach((card, i) => {
      const n = i + 1;
      card.classList.toggle('included', selected.has(n));
      card.querySelector('.star').classList.toggle('on', n === star);
    });
  };

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const card = document.createElement('div');
    card.className = 'pg';
    card.innerHTML = `<span class="num">${n}</span><button class="star" title="Pattern page">★</button>`;
    card.onclick = () => {
      if (selected.has(n)) selected.delete(n);
      else selected.add(n);
      refresh();
    };
    card.querySelector('.star').onclick = (e) => {
      e.stopPropagation();
      star = n;
      selected.add(n);
      refresh();
    };
    cards.push(card);
    grid.appendChild(card);
  }
  refresh();

  // Render thumbnails one by one, abandoning if the user leaves the picker
  const seq = ++pickerSeq;
  (async () => {
    const w = Math.round(220 * (window.devicePixelRatio || 1));
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      if (seq !== pickerSeq || !pdfDoc) return;
      try {
        const c = await renderToCanvas(n, w);
        if (seq !== pickerSeq) return;
        cards[n - 1].prepend(c);
      } catch (err) {
        console.warn('Thumbnail failed for page', n, err);
      }
    }
  })();

  $('#selAll').onclick = () => {
    for (let n = 1; n <= pdfDoc.numPages; n++) selected.add(n);
    refresh();
  };
  $('#selNone').onclick = () => {
    selected.clear();
    selected.add(star);
    refresh();
  };
  $('#pickerBack').onclick = () => {
    pickerSeq++;
    isNew ? showLibrary() : openViewer();
  };
  $('#pickerDone').onclick = async () => {
    if (selected.size === 0) return alert('Select at least one page.');
    pickerSeq++;
    project.pages = [...selected].sort((a, b) => a - b);
    if (!selected.has(star)) star = project.pages[0];
    project.patternPage = star;
    if (isNew || !project.pages.includes(project.currentPage)) project.currentPage = star;
    try {
      project.thumb = (await renderToCanvas(star, 300)).toDataURL('image/jpeg', 0.8);
    } catch { /* thumbnail is optional */ }
    await saveNow();
    openViewer();
  };
}

/* =========================================================
   Viewer
   ========================================================= */
function openViewer() {
  show('viewer');
  $('#projName').textContent = project.name;
  $('#notesText').value = project.notes || '';
  fillPageSelect();
  setMode('track');
  updateCounters();
  requestWakeLock();
  pageBase = null;
  renderPage().then(() => scrollToMarkers(false));
}

function fillPageSelect() {
  const sel = $('#pageSelect');
  sel.innerHTML = '';
  for (const n of project.pages) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = `Page ${n}${n === project.patternPage ? ' ★' : ''}`;
    sel.appendChild(o);
  }
  sel.value = project.currentPage;
  const i = project.pages.indexOf(project.currentPage);
  $('#pagePrev').disabled = i <= 0;
  $('#pageNext').disabled = i >= project.pages.length - 1;
}

async function goToPage(n) {
  if (n === project.currentPage) return;
  project.currentPage = n;
  save();
  fillPageSelect();
  pageBase = null;
  await renderPage();
  scrollToMarkers(false);
}

$('#pageSelect').onchange = (e) => goToPage(Number(e.target.value));
$('#pagePrev').onclick = () => {
  const i = project.pages.indexOf(project.currentPage);
  if (i > 0) goToPage(project.pages[i - 1]);
};
$('#pageNext').onclick = () => {
  const i = project.pages.indexOf(project.currentPage);
  if (i < project.pages.length - 1) goToPage(project.pages[i + 1]);
};
$('#backBtn').onclick = () => showLibrary();
$('#pagesBtn').onclick = async () => {
  await saveNow();
  showPicker(false);
};

/* ---------- rendering & zoom ---------- */
function applyLayout() {
  if (!pageBase) return;
  const availW = Math.max(200, stage.clientWidth - 32);
  const cssW = availW * project.zoom;
  pageWrap.style.width = cssW + 'px';
  pageWrap.style.height = (cssW * pageBase.h) / pageBase.w + 'px';
  layoutMarkers();
}

let renderSeq = 0;
let renderTask = null;
async function renderPage() {
  const seq = ++renderSeq;
  const page = await pdfDoc.getPage(project.currentPage);
  if (seq !== renderSeq) return;
  const base = page.getViewport({ scale: 1 });
  pageBase = { w: base.width, h: base.height };
  applyLayout();

  // Render at device resolution, capped so huge zooms don't exhaust canvas memory
  let scale = (pageWrap.clientWidth / base.width) * (window.devicePixelRatio || 1);
  const maxPixels = 16e6;
  const area = base.width * base.height * scale * scale;
  if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);
  const vp = page.getViewport({ scale });

  const tmp = document.createElement('canvas');
  tmp.width = Math.floor(vp.width);
  tmp.height = Math.floor(vp.height);
  renderTask?.cancel();
  renderTask = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return;
    throw err;
  }
  if (seq !== renderSeq) return;
  pdfCanvas.width = tmp.width;
  pdfCanvas.height = tmp.height;
  pdfCanvas.getContext('2d').drawImage(tmp, 0, 0);
  inkCanvas.width = tmp.width;
  inkCanvas.height = tmp.height;
  redrawInk();
}

let rerenderTimer;
function scheduleRender(delay = 180) {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(renderPage, delay);
}

// Zoom while keeping the point under (clientX, clientY) fixed on screen
function setZoom(z, clientX, clientY) {
  if (!pageBase) return;
  z = clamp(z, 0.3, 6);
  const sr = stage.getBoundingClientRect();
  const cx = (clientX ?? sr.left + sr.width / 2) - sr.left;
  const cy = (clientY ?? sr.top + sr.height / 2) - sr.top;
  const fx = (stage.scrollLeft + cx - pageWrap.offsetLeft) / pageWrap.offsetWidth;
  const fy = (stage.scrollTop + cy - pageWrap.offsetTop) / pageWrap.offsetHeight;
  project.zoom = z;
  applyLayout();
  stage.scrollLeft = fx * pageWrap.offsetWidth + pageWrap.offsetLeft - cx;
  stage.scrollTop = fy * pageWrap.offsetHeight + pageWrap.offsetTop - cy;
  save();
  scheduleRender();
}

$('#zoomIn').onclick = () => setZoom(project.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(project.zoom / 1.25);
$('#zoomFit').onclick = () => setZoom(1);

stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(project.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
}, { passive: false });

// Pinch-to-zoom on touch screens
let pinch = null;
const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
stage.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || mode === 'draw') return;
  const t = e.touches;
  const mx = (t[0].clientX + t[1].clientX) / 2;
  const my = (t[0].clientY + t[1].clientY) / 2;
  const wr = pageWrap.getBoundingClientRect();
  pageWrap.style.transformOrigin = `${mx - wr.left}px ${my - wr.top}px`;
  pinch = { d0: touchDist(t), mx, my, r: 1 };
}, { passive: true });
stage.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  pinch.r = clamp(touchDist(e.touches) / pinch.d0, 0.3 / project.zoom, 6 / project.zoom);
  pageWrap.style.transform = `scale(${pinch.r})`;
}, { passive: false });
stage.addEventListener('touchend', (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const { r, mx, my } = pinch;
  pinch = null;
  pageWrap.style.transform = '';
  setZoom(project.zoom * r, mx, my);
});

window.addEventListener('resize', () => {
  if (!project || $('#viewer').hidden) return;
  applyLayout();
  scheduleRender(250);
});

/* ---------- markers ---------- */
function layoutMarkers() {
  const ps = pageState();
  const s = project.settings;

  pageWrap.style.setProperty('--row-fill', rgba(s.rowColor, s.opacity));
  pageWrap.style.setProperty('--row-line', s.rowColor);
  pageWrap.style.setProperty('--col-fill', rgba(s.colColor, s.opacity));
  pageWrap.style.setProperty('--col-line', s.colColor);

  rowBar.hidden = !ps.row.visible;
  colBar.hidden = !ps.col.visible;
  rowBar.style.top = ps.row.y * 100 + '%';
  rowBar.style.height = ps.row.h * 100 + '%';
  colBar.style.left = ps.col.x * 100 + '%';
  colBar.style.width = ps.col.w * 100 + '%';
  // stitch-marker resize grip sits level with the current row
  $('#colGrip').style.top = clamp(ps.row.y + ps.row.h / 2, 0.02, 0.98) * 100 + '%';

  const dim = $('#dim');
  if (s.dim && ps.row.visible) {
    dim.hidden = false;
    if (s.rowDir === 'up') {
      dim.style.top = (ps.row.y + ps.row.h) * 100 + '%';
      dim.style.height = (1 - ps.row.y - ps.row.h) * 100 + '%';
    } else {
      dim.style.top = '0';
      dim.style.height = ps.row.y * 100 + '%';
    }
  } else {
    dim.hidden = true;
  }

  $('#rowVis').classList.toggle('off', !ps.row.visible);
  $('#colVis').classList.toggle('off', !ps.col.visible);
  $('#stDir').textContent = s.stDir === 'rtl' ? '←' : '→';
}

function updateCounters() {
  $('#rowNum').textContent = project.counters.row;
  $('#stNum').textContent = project.counters.stitch;
}

function dragHandler(el, onStart, onMove) {
  el.addEventListener('pointerdown', (e) => {
    if (mode !== 'track' || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const ctx = onStart(e);
    const move = (ev) => {
      onMove(ev, pageWrap.getBoundingClientRect(), ctx);
      layoutMarkers();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

// Move row marker
dragHandler(rowBar,
  (e) => ({ y0: pageState().row.y, p0: e.clientY }),
  (e, rect, c) => {
    const r = pageState().row;
    r.y = clamp(c.y0 + (e.clientY - c.p0) / rect.height, 0, 1 - r.h);
  });
// Resize row marker
dragHandler($('#rowGrip'),
  (e) => ({ h0: pageState().row.h, p0: e.clientY }),
  (e, rect, c) => {
    const r = pageState().row;
    r.h = clamp(c.h0 + (e.clientY - c.p0) / rect.height, 0.004, Math.min(0.4, 1 - r.y));
  });
// Move stitch marker
dragHandler(colBar,
  (e) => ({ x0: pageState().col.x, p0: e.clientX }),
  (e, rect, c) => {
    const col = pageState().col;
    col.x = clamp(c.x0 + (e.clientX - c.p0) / rect.width, 0, 1 - col.w);
  });
// Resize stitch marker
dragHandler($('#colGrip'),
  (e) => ({ w0: pageState().col.w, p0: e.clientX }),
  (e, rect, c) => {
    const col = pageState().col;
    col.w = clamp(c.w0 + (e.clientX - c.p0) / rect.width, 0.004, Math.min(0.4, 1 - col.x));
  });

function stepRow(d) {
  const ps = pageState();
  const s = project.settings;
  const sign = s.rowDir === 'up' ? -1 : 1;
  ps.row.y = clamp(ps.row.y + d * sign * ps.row.h, 0, 1 - ps.row.h);
  project.counters.row = Math.max(0, project.counters.row + d);
  if (s.flip) s.stDir = s.stDir === 'rtl' ? 'ltr' : 'rtl';
  const start = ps.col.start?.[s.stDir];
  if (start != null) ps.col.x = start;
  project.counters.stitch = 1;
  layoutMarkers();
  updateCounters();
  scrollToMarkers(true);
  save();
}

function stepStitch(d) {
  const ps = pageState();
  const sign = project.settings.stDir === 'rtl' ? -1 : 1;
  ps.col.x = clamp(ps.col.x + d * sign * ps.col.w, 0, 1 - ps.col.w);
  project.counters.stitch = Math.max(0, project.counters.stitch + d);
  layoutMarkers();
  updateCounters();
  scrollToMarkers(true);
  save();
}

// Scroll so the current row (and stitch) marker is comfortably in view
function scrollToMarkers(smooth) {
  const ps = pageState();
  const opts = { behavior: smooth ? 'smooth' : 'auto' };
  if (ps.row.visible) {
    const top = pageWrap.offsetTop + ps.row.y * pageWrap.offsetHeight;
    const h = ps.row.h * pageWrap.offsetHeight;
    const vh = stage.clientHeight;
    if (top < stage.scrollTop + vh * 0.2 || top + h > stage.scrollTop + vh * 0.8) {
      opts.top = top + h / 2 - vh / 2;
    }
  }
  if (ps.col.visible) {
    const left = pageWrap.offsetLeft + ps.col.x * pageWrap.offsetWidth;
    const w = ps.col.w * pageWrap.offsetWidth;
    const vw = stage.clientWidth;
    if (left < stage.scrollLeft + vw * 0.1 || left + w > stage.scrollLeft + vw * 0.9) {
      opts.left = left + w / 2 - vw / 2;
    }
  }
  if (opts.top != null || opts.left != null) stage.scrollTo(opts);
}

$('#rowNext').onclick = () => stepRow(1);
$('#rowPrev').onclick = () => stepRow(-1);
$('#stNext').onclick = () => stepStitch(1);
$('#stPrev').onclick = () => stepStitch(-1);

function editCounter(key, label) {
  const v = prompt(`Set ${label} number`, project.counters[key]);
  if (v == null) return;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 0) return;
  project.counters[key] = n;
  updateCounters();
  save();
}
$('#rowNum').onclick = () => editCounter('row', 'row');
$('#stNum').onclick = () => editCounter('stitch', 'stitch');

$('#rowVis').onclick = () => {
  const r = pageState().row;
  r.visible = !r.visible;
  layoutMarkers();
  save();
};
$('#colVis').onclick = () => {
  const c = pageState().col;
  c.visible = !c.visible;
  layoutMarkers();
  save();
};
$('#stDir').onclick = () => {
  const s = project.settings;
  s.stDir = s.stDir === 'rtl' ? 'ltr' : 'rtl';
  layoutMarkers();
  save();
  toast(s.stDir === 'rtl' ? 'Stitches now go right → left' : 'Stitches now go left → right');
};
$('#stStart').onclick = () => {
  const ps = pageState();
  const dir = project.settings.stDir;
  ps.col.start ??= {};
  ps.col.start[dir] = ps.col.x;
  save();
  toast(`Saved. On each new ${dir === 'rtl' ? '←' : '→'} row the stitch marker jumps here.`);
};

/* ---------- drawing ---------- */
function setMode(m) {
  mode = m;
  $('#viewer').classList.toggle('drawing', m === 'draw');
  $('#drawBar').hidden = m !== 'draw';
  $('#modeTrack').classList.toggle('active', m === 'track');
  $('#modeDraw').classList.toggle('active', m === 'draw');
}
$('#modeTrack').onclick = () => setMode('track');
$('#modeDraw').onclick = () => setMode('draw');

function refreshDrawBar() {
  for (const b of document.querySelectorAll('#toolGroup .btn')) b.classList.toggle('active', b.dataset.tool === pen.tool);
  for (const b of document.querySelectorAll('#sizeGroup .btn')) b.classList.toggle('active', Number(b.dataset.size) === pen.size);
  for (const b of document.querySelectorAll('#colorGroup .swatch')) b.classList.toggle('active', b.dataset.color === pen.color);
}
for (const b of document.querySelectorAll('#toolGroup .btn')) b.onclick = () => { pen.tool = b.dataset.tool; refreshDrawBar(); };
for (const b of document.querySelectorAll('#sizeGroup .btn')) b.onclick = () => { pen.size = Number(b.dataset.size); refreshDrawBar(); };
for (const c of INK_COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.dataset.color = c;
  b.onclick = () => {
    pen.color = c;
    if (pen.tool === 'erase') pen.tool = 'pen';
    refreshDrawBar();
  };
  $('#colorGroup').appendChild(b);
}
refreshDrawBar();

function drawStroke(ctx, st, W, H) {
  ctx.save();
  ctx.globalAlpha = st.alpha ?? 1;
  ctx.strokeStyle = st.color;
  ctx.lineWidth = st.size * W;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
  if (st.pts.length === 1) ctx.lineTo(st.pts[0][0] * W + 0.1, st.pts[0][1] * H);
  ctx.stroke();
  ctx.restore();
}
function redrawInk(extra) {
  if (!project) return;
  const ctx = inkCanvas.getContext('2d');
  const W = inkCanvas.width;
  const H = inkCanvas.height;
  ctx.clearRect(0, 0, W, H);
  for (const st of pageState().strokes) drawStroke(ctx, st, W, H);
  if (extra?.pts) drawStroke(ctx, extra, W, H);
}

function normPoint(e) {
  const r = pageWrap.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

function eraseAt([x, y]) {
  const ps = pageState();
  const aspect = pageWrap.clientHeight / pageWrap.clientWidth;
  const r = 14 / pageWrap.clientWidth;
  const before = ps.strokes.length;
  ps.strokes = ps.strokes.filter(
    (st) => !st.pts.some(([px, py]) => Math.hypot(px - x, (py - y) * aspect) < r + st.size / 2));
  if (ps.strokes.length !== before) redrawInk();
}

let curStroke = null;
inkCanvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'draw' || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  inkCanvas.setPointerCapture(e.pointerId);
  const snapshot = JSON.stringify(pageState().strokes);
  const p = normPoint(e);
  if (pen.tool === 'erase') {
    curStroke = { erase: true, snapshot };
    eraseAt(p);
    return;
  }
  const hl = pen.tool === 'highlight';
  curStroke = {
    snapshot,
    color: pen.color,
    alpha: hl ? 0.35 : 1,
    size: (hl ? 18 : pen.size) / pageWrap.clientWidth,
    pts: [p],
  };
  redrawInk(curStroke);
});
inkCanvas.addEventListener('pointermove', (e) => {
  if (!curStroke) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    if (curStroke.erase) eraseAt(normPoint(ev));
    else curStroke.pts.push(normPoint(ev).map((v) => Math.round(v * 1e5) / 1e5));
  }
  if (!curStroke.erase) redrawInk(curStroke);
});
function endStroke() {
  if (!curStroke) return;
  const ps = pageState();
  const { snapshot, erase, ...stroke } = curStroke;
  curStroke = null;
  if (!erase) ps.strokes.push(stroke);
  if (JSON.stringify(ps.strokes) !== snapshot) {
    (undoStacks[project.currentPage] ??= []).push(snapshot);
    save();
  }
  redrawInk();
}
inkCanvas.addEventListener('pointerup', endStroke);
inkCanvas.addEventListener('pointercancel', endStroke);

$('#undoBtn').onclick = () => {
  const stack = undoStacks[project.currentPage];
  if (!stack?.length) return toast('Nothing to undo');
  pageState().strokes = JSON.parse(stack.pop());
  redrawInk();
  save();
};
$('#clearInk').onclick = () => {
  const ps = pageState();
  if (!ps.strokes.length || !confirm('Erase all drawings on this page?')) return;
  (undoStacks[project.currentPage] ??= []).push(JSON.stringify(ps.strokes));
  ps.strokes = [];
  redrawInk();
  save();
};

/* ---------- notes ---------- */
$('#notesBtn').onclick = () => {
  const p = $('#notesPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('#notesText').focus();
};
$('#notesClose').onclick = () => ($('#notesPanel').hidden = true);
$('#notesText').addEventListener('input', (e) => {
  project.notes = e.target.value;
  save();
});

/* ---------- settings ---------- */
function buildSwatches(container, key) {
  container.innerHTML = '';
  for (const c of MARKER_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.classList.toggle('active', project.settings[key] === c);
    b.onclick = () => {
      project.settings[key] = c;
      buildSwatches(container, key);
      layoutMarkers();
      save();
    };
    container.appendChild(b);
  }
}
$('#settingsBtn').onclick = () => {
  const s = project.settings;
  $('#setRowDir').value = s.rowDir;
  $('#setFlip').checked = s.flip;
  $('#setDim').checked = s.dim;
  $('#setOpacity').value = s.opacity;
  buildSwatches($('#rowColors'), 'rowColor');
  buildSwatches($('#colColors'), 'colColor');
  $('#settingsDlg').showModal();
};
const onSetting = (id, fn) => $(id).addEventListener('input', (e) => { fn(e.target); layoutMarkers(); save(); });
onSetting('#setRowDir', (el) => (project.settings.rowDir = el.value));
onSetting('#setFlip', (el) => (project.settings.flip = el.checked));
onSetting('#setDim', (el) => (project.settings.dim = el.checked));
onSetting('#setOpacity', (el) => (project.settings.opacity = Number(el.value)));
$('#resetMarkers').onclick = () => {
  const ps = pageState();
  const fresh = defaultPageState();
  ps.row = fresh.row;
  ps.col = fresh.col;
  layoutMarkers();
  scrollToMarkers(true);
  save();
  $('#settingsDlg').close();
};

/* ---------- fullscreen, keyboard, wake lock ---------- */
$('#fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
};

document.addEventListener('keydown', (e) => {
  if (!project || $('#viewer').hidden || $('#settingsDlg').open) return;
  if (e.target.matches('textarea, input, select')) return;
  const s = project.settings;
  const keys = {
    ' ': () => stepRow(1),
    ArrowUp: () => stepRow(s.rowDir === 'up' ? 1 : -1),
    ArrowDown: () => stepRow(s.rowDir === 'up' ? -1 : 1),
    ArrowLeft: () => stepStitch(s.stDir === 'rtl' ? 1 : -1),
    ArrowRight: () => stepStitch(s.stDir === 'rtl' ? -1 : 1),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});

let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not supported or not allowed — fine */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (project && !$('#viewer').hidden) requestWakeLock();
  } else {
    saveNow();
  }
});
window.addEventListener('pagehide', () => saveNow());

/* ---------- start ---------- */
navigator.storage?.persist?.();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline mode unavailable', err));
}
showLibrary();
