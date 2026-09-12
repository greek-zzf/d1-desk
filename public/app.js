import { loadMailRoute, mailView, parseMailHash, resetMail } from "./mail.js";
import { kvView, loadKvRoute, parseKvHash, resetKv } from "./kv.js";
import { loadWorkersRoute, parseWorkersHash, resetWorkers, workersView } from "./workers.js";

const app = document.getElementById("app");

const state = {
  session: null,
  loginToken: "",
  showToken: false,
  accounts: null,
  accountId: "",
  error: "",
  busy: false,
  toast: null,
  databases: [],
  dbFilter: "",
  db: null,
  tables: [],
  tableFilter: "",
  table: null,
  view: "browse",
  columns: [],
  rows: [],
  total: 0,
  limit: 50,
  offset: 0,
  orderBy: "",
  dir: "asc",
  q: "",
  hasRowid: true,
  selected: new Set(),
  editing: null,
  sql: "SELECT name, type FROM sqlite_master\nWHERE type IN ('table', 'view')\nORDER BY name;",
  sqlResult: null,
  schema: null,
  modal: null,
  palette: false,
  paletteQ: "",
  paletteIndex: 0,
  colWidths: {},
};

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "selected") el.selected = !!v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    method: options.method || (options.body ? "POST" : "GET"),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    state.session = null;
    throw Object.assign(new Error(data.error || "未登录"), { status: 401 });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export function toast(message, kind = "ok") {
  state.toast = { message, kind };
  render();
  setTimeout(() => {
    state.toast = null;
    render();
  }, 2800);
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, "") || "/");
  if (raw === "/mail" || raw.startsWith("/mail/")) return parseMailHash(raw);
  if (raw === "/kv" || raw.startsWith("/kv/")) return parseKvHash(raw);
  if (raw === "/workers" || raw.startsWith("/workers/")) return parseWorkersHash(raw);
  const db = raw.match(/^\/db\/([^/]+)(?:\/(.*))?$/);
  if (!db) return { page: "home" };
  const rest = db[2] || "";
  if (rest === "sql") return { page: "sql", dbId: db[1] };
  const t = rest.match(/^t\/(.+)$/);
  if (t) return { page: "table", dbId: db[1], table: t[1] };
  return { page: "db", dbId: db[1] };
}

export function go(hash) {
  location.hash = hash;
}

function cellText(value) {
  if (value == null) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function cellTitle(text) {
  if (text == null) return "null";
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

function colWidthKey(name) {
  if (state.view === "sql") return `sql:${state.db?.uuid || ""}:${name}`;
  return `browse:${state.db?.uuid || ""}:${state.table || ""}:${name}`;
}

function colgroupEl(names) {
  return h("colgroup", {},
    ...names.map((name) => {
      const w = state.colWidths[colWidthKey(name)] ?? (name === "__select__" ? 42 : null);
      return h("col", w != null ? { style: `width:${w}px` } : {});
    }),
  );
}

function dataTableAttrs(names) {
  const widths = names.map((n) => state.colWidths[colWidthKey(n)] ?? (n === "__select__" ? 42 : null));
  const sized = widths.every((w) => w != null) && names.some((n) => state.colWidths[colWidthKey(n)] != null);
  const attrs = { class: sized ? "data cols-sized" : "data" };
  if (sized) attrs.style = `width:${widths.reduce((a, b) => a + b, 0)}px`;
  return attrs;
}

function headerTh(name, label, { sortable = false } = {}) {
  return h("th", {
    class: sortable ? "sortable" : "",
    dataset: { col: name },
    title: sortable ? "点击排序，拖动右侧边框调整列宽" : "拖动右侧边框调整列宽",
    onClick: sortable
      ? () => {
        if (state.orderBy === name) state.dir = state.dir === "asc" ? "desc" : "asc";
        else { state.orderBy = name; state.dir = "asc"; }
        withBusy(loadRows);
      }
      : undefined,
  }, h("span", { class: "th-label" }, label), colResizer(name));
}

function colResizer(name) {
  return h("span", {
    class: "col-resizer",
    title: "拖动调整列宽，双击按内容适应",
    onPointerdown: (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startColResize(e, name);
    },
    onDblclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const table = e.currentTarget.closest("table");
      const th = e.currentTarget.closest("th");
      const index = [...th.parentElement.children].indexOf(th);
      snapshotTableWidths(table);
      autoFitColumn(table, index, name);
    },
    onClick: (e) => e.stopPropagation(),
  });
}

function snapshotTableWidths(table) {
  table.querySelectorAll("thead th").forEach((th) => {
    const name = th.dataset.col;
    if (!name) return;
    state.colWidths[colWidthKey(name)] = Math.round(th.getBoundingClientRect().width);
  });
}

function applyWidthsToTable(table) {
  const heads = [...table.querySelectorAll("thead th")];
  const cols = [...table.querySelectorAll("colgroup col")];
  let sum = 0;
  heads.forEach((th, i) => {
    const name = th.dataset.col;
    const w = name ? state.colWidths[colWidthKey(name)] : Math.round(th.getBoundingClientRect().width);
    if (!w) return;
    sum += w;
    th.style.width = `${w}px`;
    th.style.minWidth = `${w}px`;
    th.style.maxWidth = `${w}px`;
    if (cols[i]) cols[i].style.width = `${w}px`;
  });
  table.classList.add("cols-sized");
  table.style.width = `${sum}px`;
}

function startColResize(e, name) {
  const handle = e.currentTarget;
  const table = handle.closest("table");
  const wrap = table.closest(".table-wrap");
  snapshotTableWidths(table);
  applyWidthsToTable(table);
  const key = colWidthKey(name);
  const startX = e.clientX;
  const startW = state.colWidths[key];
  handle.classList.add("active");
  document.body.classList.add("col-resizing");
  handle.setPointerCapture?.(e.pointerId);

  const onMove = (ev) => {
    state.colWidths[key] = Math.max(48, Math.round(startW + ev.clientX - startX));
    applyWidthsToTable(table);
    if (!wrap) return;
    const edge = handle.getBoundingClientRect().right;
    const box = wrap.getBoundingClientRect();
    if (edge > box.right - 8) wrap.scrollLeft += edge - (box.right - 8);
    if (edge < box.left + 8) wrap.scrollLeft -= (box.left + 8) - edge;
  };
  const onUp = (ev) => {
    handle.releasePointerCapture?.(ev.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    handle.classList.remove("active");
    document.body.classList.remove("col-resizing");
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function autoFitColumn(table, index, name) {
  const th = table.querySelectorAll("thead th")[index];
  const canvas = autoFitColumn.ctx || (autoFitColumn.ctx = document.createElement("canvas").getContext("2d"));
  canvas.font = getComputedStyle(th).font;
  let max = Math.ceil(canvas.measureText((th.querySelector(".th-label") || th).textContent).width + 36);
  const sampleTd = table.querySelector("tbody td");
  if (sampleTd) canvas.font = getComputedStyle(sampleTd).font;
  table.querySelectorAll(`tbody tr td:nth-child(${index + 1})`).forEach((td) => {
    const t = td.innerText;
    if (!t) return;
    const sample = t.length > 2000 ? t.slice(0, 2000) : t;
    max = Math.max(max, Math.ceil(canvas.measureText(sample).width + 24));
  });
  state.colWidths[colWidthKey(name)] = Math.min(Math.max(max, 48), 1200);
  applyWidthsToTable(table);
}

function isDestructive(sql) {
  return /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|INSERT|REPLACE|CREATE|GRANT)\b/i.test(sql);
}

function pkWhere(row) {
  if (state.hasRowid && row.__rowid != null) return { rowid: row.__rowid };
  const pks = state.columns.filter((c) => c.pk > 0);
  if (pks.length === 0) return null;
  const where = {};
  for (const c of pks) where[c.name] = row[c.name];
  return where;
}

async function loadSession() {
  try {
    state.session = await api("/api/session");
  } catch {
    state.session = null;
  }
}

async function loadDatabases() {
  const data = await api("/api/databases");
  state.databases = data.databases || [];
}

async function loadTables(dbId) {
  const data = await api(`/api/databases/${dbId}/tables`);
  state.tables = data.tables || [];
}

async function loadRows() {
  if (!state.db || !state.table) return;
  const params = new URLSearchParams({
    limit: String(state.limit),
    offset: String(state.offset),
    dir: state.dir,
  });
  if (state.orderBy) params.set("orderBy", state.orderBy);
  if (state.q) params.set("q", state.q);
  const data = await api(
    `/api/databases/${state.db.uuid}/tables/${encodeURIComponent(state.table)}/rows?${params}`,
  );
  state.columns = data.columns || [];
  state.rows = data.rows || [];
  state.total = data.total || 0;
  state.hasRowid = data.hasRowid !== false;
  state.selected = new Set();
}

async function loadSchema() {
  const data = await api(
    `/api/databases/${state.db.uuid}/tables/${encodeURIComponent(state.table)}/schema`,
  );
  state.schema = data;
}

async function route() {
  if (!state.session) {
    render();
    return;
  }
  const loc = parseHash();
  state.error = "";
  state.busy = true;
  render();
  try {
    if (state.databases.length === 0) await loadDatabases();
    if (loc.page === "mail") {
      state.db = null;
      state.table = null;
      await loadMailRoute(loc);
    } else if (loc.page === "kv") {
      state.db = null;
      state.table = null;
      await loadKvRoute(loc);
    } else if (loc.page === "workers") {
      state.db = null;
      state.table = null;
      await loadWorkersRoute(loc);
    } else if (loc.page === "home") {
      state.db = null;
      state.table = null;
      state.view = "browse";
    } else {
      const info = state.databases.find((d) => d.uuid === loc.dbId);
      state.db = info || { uuid: loc.dbId, name: loc.dbId };
      await loadTables(loc.dbId);
      if (loc.page === "sql") {
        state.view = "sql";
        state.table = null;
      } else if (loc.page === "table") {
        state.table = loc.table;
        state.view = "browse";
        state.offset = 0;
        await loadRows();
      } else {
        state.table = null;
        state.view = "browse";
      }
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.busy = false;
    render();
  }
}

export async function withBusy(fn) {
  state.busy = true;
  state.error = "";
  render();
  try {
    await fn();
  } catch (err) {
    state.error = err.message;
    toast(err.message, "error");
  } finally {
    state.busy = false;
    render();
  }
}

const ICONS = {
  shield: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  storage: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="4" x2="12" y2="8"/></svg>`,
  disk: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><line x1="7" y1="15" x2="7.01" y2="15" stroke-width="3"/><line x1="10" y1="15" x2="10.01" y2="15" stroke-width="3"/><line x1="17" y1="9" x2="7" y2="9"/></svg>`,
  chip: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4"/></svg>`,
  keyBig: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3M18.5 4.5l3 3"/></svg>`,
  docBig: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  db: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  kv: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8v8M8 12l4-4M8 12l4 4M15 8v8"/></svg>`,
  workers: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>`,
  mail: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  key: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a3a39d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3M18.5 4.5l3 3"/></svg>`,
  eye: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a3a39d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a3a39d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`,
  extLink: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  arrowLeft: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`,
  alert: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  spinner: `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`,
  topoArrow: `<svg width="42" height="14" viewBox="0 0 42 14" fill="none"><line x1="0" y1="7" x2="36" y2="7" stroke="#d8f848" stroke-width="2"/><polyline points="30 2 37 7 30 12" stroke="#d8f848" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function loginView() {
  const isAccountSelect = Array.isArray(state.accounts) && state.accounts.length > 0;

  return h("div", { class: "login-split-layout" },
    // Left Stage: Architecture, System Topology, Zero-Disk Proofs
    h("aside", { class: "console-panel" },
      h("div", { class: "console-brand" },
        h("h1", { class: "console-title" }, "D1 Desk"),
        h("div", { class: "brand-tag" }, "LEDGER // v2.4"),
      ),

      // System Topology (Comp-led exact architecture)
      h("div", { class: "topology-container" },
        // Left node 1: API Token
        h("div", { class: "topo-stage-node topo-token-node" },
          h("div", { class: "stage-icon", html: ICONS.keyBig }),
          h("div", { class: "stage-label" }, "API Token"),
        ),
        // Arrow 1
        h("div", { class: "topo-stage-arrow", html: ICONS.topoArrow }),
        // Left node 2: D1 Desk Worker
        h("div", { class: "topo-stage-node topo-worker-node" },
          h("div", { class: "stage-icon", html: ICONS.docBig }),
          h("div", { class: "stage-label" }, "D1 Desk Worker"),
        ),
        // Branching SVG connector
        h("svg", { class: "topo-branch-svg", viewBox: "0 0 80 200", fill: "none" },
          h("path", { d: "M 0 100 L 25 100", stroke: "#d8f848", "stroke-width": "2" }),
          h("path", { d: "M 25 100 C 45 100 50 25 75 25", stroke: "#d8f848", "stroke-width": "2" }),
          h("path", { d: "M 25 100 C 45 100 50 75 75 75", stroke: "#d8f848", "stroke-width": "2" }),
          h("path", { d: "M 25 100 C 45 100 50 125 75 125", stroke: "#d8f848", "stroke-width": "2" }),
          h("path", { d: "M 25 100 C 45 100 50 175 75 175", stroke: "#d8f848", "stroke-width": "2" }),
        ),
        // Cloudflare Edge destination box
        h("div", { class: "topo-cf-box" },
          h("div", { class: "topo-cf-header" }, "Cloudflare Edge"),
          h("div", { class: "topo-cf-items" },
            h("div", { class: "topo-cf-item" },
              h("span", { class: "cf-item-icon", html: ICONS.db }),
              h("span", { class: "cf-item-text" }, "D1 (Database)"),
            ),
            h("div", { class: "topo-cf-item" },
              h("span", { class: "cf-item-icon", html: ICONS.kv }),
              h("span", { class: "cf-item-text" }, "KV (Key-Value)"),
            ),
            h("div", { class: "topo-cf-item" },
              h("span", { class: "cf-item-icon", html: ICONS.workers }),
              h("div", { class: "cf-item-col" },
                h("span", { class: "cf-item-text" }, "Workers"),
                h("span", { class: "cf-item-sub" }, "(Compute)"),
              ),
            ),
            h("div", { class: "topo-cf-item" },
              h("span", { class: "cf-item-icon", html: ICONS.mail }),
              h("span", { class: "cf-item-text" }, "Mail (Email)"),
            ),
          ),
        ),
      ),

      // Security Guarantees Section
      h("div", { class: "security-guarantees-card" },
        h("div", { class: "sec-header" },
          h("div", { class: "sec-title" }, "Zero-disk security guarantees"),
          h("div", { class: "sec-icon", html: ICONS.shield }),
        ),
        h("div", { class: "sec-bullets" },
          h("div", { class: "sec-bullet" },
            h("span", { class: "bullet-text" }, "• Ephemeral Storage Only"),
            h("span", { class: "bullet-icon", html: ICONS.storage }),
          ),
          h("div", { class: "sec-bullet" },
            h("span", { class: "bullet-text" }, "• No Persistent Disk Reads/Writes"),
            h("span", { class: "bullet-icon", html: ICONS.disk }),
          ),
          h("div", { class: "sec-bullet" },
            h("span", { class: "bullet-text" }, "• In-Memory State Management"),
            h("span", { class: "bullet-icon", html: ICONS.chip }),
          ),
        ),
      ),
    ),

    // Right Stage: Interactive Terminal Gate
    h("main", { class: "terminal-panel" },
      h("div", { class: "terminal-window" },
        h("div", { class: "terminal-chrome" },
          h("div", { class: "chrome-dots" },
            h("span", { class: "dot-red" }),
            h("span", { class: "dot-yellow" }),
            h("span", { class: "dot-green" }),
          ),
          h("div", { class: "chrome-title" }, "AUTH_GATE // CLOUDFLARE_PROVISION"),
        ),

        h("div", { class: "terminal-body" },
          state.error
            ? h("div", { class: "term-error", role: "alert" },
                h("span", { class: "term-error-icon", html: ICONS.alert }),
                h("div", { class: "term-error-body" },
                  h("div", { class: "term-error-msg" }, state.error),
                  h("div", { class: "term-error-desc" }, "请确认 API Token 未失效，且拥有对应资源 Edit 权限及 Account Settings Read 权限。"),
                ),
              )
            : null,

          isAccountSelect
            ? h("div", { class: "account-matrix-view" },
                h("div", { class: "matrix-head" },
                  h("h2", { class: "matrix-title" }, `检测到 ${state.accounts.length} 个可用 Cloudflare 账号`),
                  h("p", { class: "matrix-sub" }, "请选择本次会话载入的工作台账号："),
                ),
                h("div", { class: "matrix-list" },
                  ...state.accounts.map((a) => {
                    const isSelected = a.id === state.accountId;
                    return h("div", {
                      class: `matrix-card ${isSelected ? "selected" : ""}`,
                      onClick: () => {
                        state.accountId = a.id;
                        render();
                      },
                    },
                      h("div", { class: "matrix-card-left" },
                        h("div", { class: "matrix-acc-name" }, a.name),
                        h("div", { class: "matrix-acc-id" }, `ID: ${a.id}`),
                      ),
                      isSelected
                        ? h("span", { class: "matrix-check-pill", html: ICONS.check })
                        : h("span", { class: "matrix-uncheck" }),
                    );
                  }),
                ),
                h("div", { class: "terminal-actions" },
                  h("button", {
                    class: "btn btn-ghost",
                    type: "button",
                    disabled: state.busy,
                    onClick: () => {
                      state.accounts = null;
                      state.accountId = "";
                      state.error = "";
                      render();
                    },
                  },
                    h("span", { class: "btn-icon", html: ICONS.arrowLeft }),
                    "更换 Token",
                  ),
                  h("button", {
                    class: "btn btn-primary",
                    type: "button",
                    disabled: state.busy,
                    onClick: onLogin,
                  },
                    state.busy
                      ? [h("span", { class: "btn-icon", html: ICONS.spinner }), "进入中…"]
                      : "进入选定账号工作台",
                  ),
                ),
              )
            : h("form", { class: "token-form", onSubmit: onLogin },
                h("div", { class: "field-group" },
                  h("div", { class: "field-label-bar" },
                    h("label", { for: "token" }, "API token"),
                  ),
                  h("div", { class: "token-input-shell" },
                    h("span", { class: "token-prefix-key", html: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#b0b2b8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3M18.5 4.5l3 3"/></svg>` }),
                    h("input", {
                      id: "token",
                      type: state.showToken ? "text" : "password",
                      autocomplete: "off",
                      spellcheck: "false",
                      placeholder: "••••••••••••••••••••••••••••••••",
                      value: state.loginToken,
                      onInput: (e) => {
                        state.loginToken = e.target.value.trim();
                      },
                    }),
                    state.loginToken
                      ? h("button", {
                          type: "button",
                          class: "token-suffix-btn",
                          title: "清空",
                          onClick: () => {
                            state.loginToken = "";
                            render();
                          },
                        }, "×")
                      : null,
                    h("button", {
                      type: "button",
                      class: "token-suffix-btn",
                      title: state.showToken ? "隐藏 Token" : "显示明文",
                      onClick: () => {
                        state.showToken = !state.showToken;
                        render();
                      },
                    },
                      h("span", { class: "btn-icon", html: state.showToken ? ICONS.eye : ICONS.eyeOff }),
                    ),
                  ),
                ),

                // Scopes / Permissions Row
                h("div", { class: "scopes-spec-box" },
                  h("div", { class: "scopes-pills-row" },
                    h("span", { class: "scope-pill" }, "D1: Edit"),
                    h("span", { class: "scope-pill" }, "KV: Edit"),
                    h("span", { class: "scope-pill" }, "Workers: Read"),
                    h("span", { class: "scope-pill" }, "Account: Read"),
                  ),
                ),

                h("button", {
                  class: "btn btn-primary terminal-submit-btn",
                  type: "submit",
                  disabled: state.busy,
                },
                  state.busy
                    ? [h("span", { class: "btn-icon", html: ICONS.spinner }), "CONNECTING..."]
                    : "VALIDATE & ENTER WORKSPACE",
                ),
              ),
        ),
      ),
    ),
  );
}

async function onLogin(e) {
  e?.preventDefault?.();
  const token = state.loginToken?.trim();
  if (!token) {
    state.error = "请输入 Cloudflare API Token";
    render();
    return;
  }
  await withBusy(async () => {
    state.error = "";
    const body = state.accounts
      ? { token, accountId: state.accountId }
      : { token };
    const data = await api("/api/login", { body });
    if (data.needAccount) {
      state.accounts = data.accounts;
      state.accountId = data.accounts[0]?.id || "";
      return;
    }
    state.session = { accountId: data.accountId, accountName: data.accountName };
    state.accounts = null;
    await loadDatabases();
  });
}

function topbar() {
  const hash = location.hash;
  const nav = (href, label) =>
    h("a", { class: `btn ${hash === href || hash.startsWith(`${href}/`) ? "btn-primary" : ""}`, href }, label);
  return h("header", { class: "top" },
    h("a", { class: "brand", href: "#/" }, "D1 Desk", h("span", {}, "LEDGER")),
    nav("#/mail", "邮件"),
    nav("#/kv", "KV"),
    nav("#/workers", "Workers"),
    h("button", { class: "btn", onClick: () => { state.palette = true; state.paletteQ = ""; state.paletteIndex = 0; render(); document.getElementById("palette-q")?.focus(); } },
      "切换数据库", h("span", { class: "kbd" }, "⌘K"),
    ),
    h("div", { class: "top-space" }),
    h("div", { class: "account" }, state.session?.accountName || ""),
    h("button", { class: "btn btn-ghost", onClick: logout }, "退出"),
  );
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  resetMail();
  resetKv();
  resetWorkers();
  Object.assign(state, { session: null, databases: [], db: null, tables: [], table: null, loginToken: "", accounts: null });
  go("/");
  render();
}

function homeView() {
  const q = state.dbFilter.trim().toLowerCase();
  const list = state.databases.filter((d) => !q || d.name.toLowerCase().includes(q) || d.uuid.includes(q));
  return h("div", { class: "home" },
    h("div", { class: "home-head" },
      h("div", {},
        h("div", { class: "kicker" }, "WORKSPACE"),
        h("h2", {}, "数据与服务"),
      ),
    ),
    h("div", { class: "grid home-launch" },
      h("a", { class: "card mail-hero", href: "#/mail" },
        h("div", { class: "kicker" }, "EMAIL"),
        h("h3", {}, "邮箱"),
        h("p", { class: "lede" }, "Email Routing 入站，send_email 出站，元数据进 D1，附件进 R2。"),
      ),
      h("a", { class: "card", href: "#/kv" },
        h("div", { class: "kicker" }, "KV"),
        h("h3", {}, "Workers KV"),
        h("p", { class: "lede" }, "浏览 Namespace、按前缀列 key、查看与编辑 value。"),
      ),
      h("a", { class: "card", href: "#/workers" },
        h("div", { class: "kicker" }, "WORKERS"),
        h("h3", {}, "Workers"),
        h("p", { class: "lede" }, "列出账号下脚本，查看 handlers、bindings 与配置。"),
      ),
    ),
    h("div", { class: "home-head", style: "margin-top:28px" },
      h("div", {},
        h("div", { class: "kicker" }, "ACCOUNT DATABASES"),
        h("h2", {}, `${state.databases.length} 个 D1 数据库`),
      ),
      h("input", {
        class: "search",
        placeholder: "搜索名称或 UUID",
        value: state.dbFilter,
        onInput: (e) => { state.dbFilter = e.target.value; render(); },
      }),
    ),
    list.length === 0
      ? h("div", { class: "empty" }, h("h3", {}, "没有匹配的数据库"), h("p", {}, "确认 Token 有 D1 权限，并且这个账号下已经创建了 D1。"))
      : h("div", { class: "grid" },
          ...list.map((d) =>
            h("a", { class: "card", href: `#/db/${d.uuid}` },
              h("div", { class: "kicker" }, d.version || "D1"),
              h("h3", {}, d.name),
              h("div", { class: "meta" },
                h("span", {}, formatBytes(d.file_size)),
                h("span", {}, d.num_tables != null ? `${d.num_tables} 张表` : "表数量未知"),
              ),
              h("div", { class: "uuid" }, d.uuid),
              h("div", { class: "meta" }, h("span", {}, `创建 ${formatTime(d.created_at)}`)),
            ),
          ),
        ),
  );
}

function workspace() {
  const q = state.tableFilter.trim().toLowerCase();
  const tables = state.tables.filter((t) => !q || t.name.toLowerCase().includes(q));
  return h("div", { class: "work" },
    h("aside", { class: "side" },
      h("div", { class: "side-head" },
        h("div", { class: "kicker" }, "DATABASE"),
        h("h2", {}, state.db?.name || ""),
      ),
      h("div", { class: "side-tools" },
        h("input", {
          class: "search",
          style: "max-width:none",
          placeholder: "筛选表",
          value: state.tableFilter,
          onInput: (e) => { state.tableFilter = e.target.value; render(); },
        }),
      ),
      h("div", { class: "table-list" },
        h("button", {
          class: `table-item ${state.view === "sql" && !state.table ? "active" : ""}`,
          onClick: () => go(`/db/${state.db.uuid}/sql`),
        }, h("span", { class: "name" }, "SQL 查询"), h("span", { class: "kind" }, "editor")),
        ...tables.map((t) =>
          h("button", {
            class: `table-item ${state.table === t.name ? "active" : ""}`,
            onClick: () => go(`/db/${state.db.uuid}/t/${encodeURIComponent(t.name)}`),
          },
            h("span", { class: "name" }, t.name),
            h("span", { class: "kind" }, t.type),
          ),
        ),
      ),
    ),
    h("section", { class: "main" }, mainBar(), h("div", { class: `pane ${state.busy ? "busy" : ""}` }, mainPane())),
  );
}

function mainBar() {
  const tabs = [];
  if (state.table) {
    tabs.push(
      h("div", { class: "tabs" },
        tabBtn("browse", "浏览"),
        tabBtn("schema", "结构"),
        tabBtn("sql", "SQL"),
      ),
    );
  }
  return h("div", { class: "main-bar" },
    h("h2", {}, state.table || (state.view === "sql" ? "SQL" : "选择一张表")),
    ...tabs,
    h("div", { class: "grow" }),
    state.view === "browse" && state.table
      ? h("input", {
          class: "search",
          placeholder: "筛选当前表",
          value: state.q,
          onChange: (e) => {
            state.q = e.target.value;
            state.offset = 0;
            withBusy(loadRows);
          },
        })
      : null,
    state.view === "browse" && state.table
      ? h("button", { class: "btn", onClick: () => openInsert() }, "插入行")
      : null,
    state.view === "browse" && state.table
      ? h("button", { class: "btn btn-danger", disabled: state.selected.size === 0, onClick: deleteSelected }, `删除 ${state.selected.size || ""}`.trim())
      : null,
    state.view === "sql"
      ? h("button", { class: "btn btn-primary", onClick: runSql }, "运行", h("span", { class: "kbd" }, "⌘↵"))
      : null,
  );
}

function tabBtn(id, label) {
  return h("button", {
    class: `tab ${state.view === id ? "active" : ""}`,
    onClick: async () => {
      state.view = id;
      if (id === "schema" && state.table) await withBusy(loadSchema);
      if (id === "sql" && state.table) {
        state.sql = `SELECT * FROM ${quoteIdentClient(state.table)} LIMIT 50;`;
      }
      render();
    },
  }, label);
}

function quoteIdentClient(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function mainPane() {
  if (state.error) return h("div", { class: "empty" }, h("h3", {}, "出错了"), h("p", {}, state.error));
  if (!state.table && state.view !== "sql") {
    return h("div", { class: "empty" },
      h("h3", {}, "从左侧打开一张表"),
      h("p", {}, "或者直接进入 SQL 编辑器，对当前数据库执行查询。"),
    );
  }
  if (state.view === "sql") return sqlPane();
  if (state.view === "schema") return schemaPane();
  return browsePane();
}

function browsePane() {
  const cols = state.columns;
  const start = state.total === 0 ? 0 : state.offset + 1;
  const end = Math.min(state.offset + state.rows.length, state.total);
  const colNames = ["__select__", ...cols.map((c) => c.name)];
  return h("div", { style: "height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto;min-width:0" },
    h("div", { class: "table-wrap" },
      h("table", dataTableAttrs(colNames),
        colgroupEl(colNames),
        h("thead", {},
          h("tr", {},
            h("th", { class: "th-select", dataset: { col: "__select__" } },
              h("input", {
                type: "checkbox",
                onChange: (e) => {
                  state.selected = e.target.checked ? new Set(state.rows.map((_, i) => i)) : new Set();
                  render();
                },
              }),
            ),
            ...cols.map((c) =>
              headerTh(c.name, `${c.name}${state.orderBy === c.name ? (state.dir === "asc" ? " ↑" : " ↓") : ""}`, { sortable: true }),
            ),
          ),
        ),
        h("tbody", {},
          state.rows.length === 0
            ? h("tr", {}, h("td", { colspan: String(cols.length + 1) }, "没有数据"))
            : state.rows.map((row, i) => rowEl(row, i, cols)),
        ),
      ),
    ),
    h("div", { class: "pager" },
      h("span", {}, `${start}–${end} / ${state.total}`),
      h("button", { class: "btn", disabled: state.offset <= 0, onClick: () => { state.offset = Math.max(0, state.offset - state.limit); withBusy(loadRows); } }, "上一页"),
      h("button", { class: "btn", disabled: state.offset + state.limit >= state.total, onClick: () => { state.offset += state.limit; withBusy(loadRows); } }, "下一页"),
      h("button", { class: "btn", onClick: exportCsv }, "导出 CSV"),
    ),
  );
}

function rowEl(row, index, cols) {
  return h("tr", {},
    h("td", {},
      h("input", {
        type: "checkbox",
        checked: state.selected.has(index),
        onChange: (e) => {
          if (e.target.checked) state.selected.add(index);
          else state.selected.delete(index);
          render();
        },
      }),
    ),
    ...cols.map((c) => cellEl(row, index, c.name)),
  );
}

function cellEl(row, index, col) {
  const key = `${index}:${col}`;
  if (state.editing === key) {
    const input = h("input", {
      value: row[col] == null ? "" : String(row[col]),
      onKeydown: (e) => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") { state.editing = null; render(); }
      },
      onBlur: (e) => saveCell(row, col, e.target.value),
    });
    queueMicrotask(() => { input.focus(); input.select(); });
    return h("td", { class: "editing" }, input);
  }
  const text = cellText(row[col]);
  return h("td", {
    class: text == null ? "null" : "",
    title: cellTitle(text),
    onDblclick: () => { state.editing = key; render(); },
  }, h("span", { class: "cell" }, text == null ? "null" : text));
}

async function saveCell(row, col, raw) {
  state.editing = null;
  const where = pkWhere(row);
  if (!where) {
    toast("这张表没有主键，无法直接改单元格，请用 SQL。", "error");
    render();
    return;
  }
  const next = raw === "" ? null : raw;
  if (String(row[col] ?? "") === String(next ?? "")) {
    render();
    return;
  }
  await withBusy(async () => {
    await api(`/api/databases/${state.db.uuid}/tables/${encodeURIComponent(state.table)}/rows`, {
      method: "PATCH",
      body: { values: { [col]: next }, where },
    });
    toast("已保存");
    await loadRows();
  });
}

function openInsert() {
  const values = {};
  for (const c of state.columns) {
    if (c.pk && /INT/i.test(c.type)) continue;
    values[c.name] = c.dflt_value == null ? "" : String(c.dflt_value);
  }
  state.modal = { type: "insert", values };
  render();
}

async function submitInsert() {
  const values = {};
  for (const [k, v] of Object.entries(state.modal.values)) {
    values[k] = v === "" ? null : v;
  }
  await withBusy(async () => {
    await api(`/api/databases/${state.db.uuid}/tables/${encodeURIComponent(state.table)}/rows`, {
      body: { values },
    });
    state.modal = null;
    toast("已插入");
    await loadRows();
  });
}

async function deleteSelected() {
  if (!confirm(`删除选中的 ${state.selected.size} 行？`)) return;
  await withBusy(async () => {
    const rows = [...state.selected].map((i) => state.rows[i]);
    for (const row of rows) {
      const where = pkWhere(row);
      if (!where) throw new Error("没有主键，无法删除。请用 SQL。");
      await api(`/api/databases/${state.db.uuid}/tables/${encodeURIComponent(state.table)}/rows`, {
        method: "DELETE",
        body: { where },
      });
    }
    toast("已删除");
    await loadRows();
  });
}

function exportCsv() {
  const cols = state.columns.map((c) => c.name);
  const lines = [cols.join(",")];
  for (const row of state.rows) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.table || "query"}.csv`;
  a.click();
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function sqlPane() {
  const result = state.sqlResult;
  const cols = result?.results?.[0] ? Object.keys(result.results[0]) : [];
  return h("div", { class: "sql-wrap" },
    h("textarea", {
      class: "sql-editor",
      spellcheck: "false",
      onInput: (e) => { state.sql = e.target.value; },
    }, state.sql),
    h("div", { class: "sql-results" },
      result
        ? h("div", { class: "sql-meta" },
            h("span", {}, `${result.results?.length ?? 0} 行`),
            h("span", {}, `${result.meta?.duration ?? "—"} ms`),
            h("span", {}, `读 ${result.meta?.rows_read ?? 0}`),
            h("span", {}, `写 ${result.meta?.rows_written ?? 0}`),
            h("span", {}, `changes ${result.meta?.changes ?? 0}`),
            h("button", { class: "btn", onClick: () => {
              state.columns = cols.map((name) => ({ name, pk: 0, type: "" }));
              state.rows = result.results;
              exportCsv();
            } }, "导出结果"),
          )
        : h("div", { class: "sql-meta" }, "⌘/Ctrl + Enter 运行当前 SQL"),
      result
        ? h("div", { class: "table-wrap" },
            h("table", dataTableAttrs(cols),
              colgroupEl(cols),
              h("thead", {}, h("tr", {}, ...cols.map((c) => headerTh(c, c)))),
              h("tbody", {},
                (result.results || []).map((row) =>
                  h("tr", {}, ...cols.map((c) => {
                    const text = cellText(row[c]);
                    return h("td", {
                      class: text == null ? "null" : "",
                      title: cellTitle(text),
                    }, h("span", { class: "cell" }, text == null ? "null" : text));
                  })),
                ),
              ),
            ),
          )
        : h("div", { class: "empty" }, h("p", {}, "运行查询后结果会显示在这里。")),
    ),
  );
}

async function runSql() {
  const sql = state.sql.trim();
  if (!sql) return;
  if (isDestructive(sql) && !confirm("这条 SQL 会改数据。确认执行？")) return;
  await withBusy(async () => {
    const data = await api(`/api/databases/${state.db.uuid}/query`, { body: { sql } });
    state.sqlResult = data.result;
    toast("已执行");
  });
}

function schemaPane() {
  const schema = state.schema;
  if (!schema) return h("div", { class: "empty" }, h("p", {}, "加载结构中…"));
  return h("div", { class: "schema" },
    h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "列"), h("th", {}, "类型"), h("th", {}, "NULL"), h("th", {}, "默认"), h("th", {}, "PK"))),
      h("tbody", {},
        ...(schema.columns || []).map((c) =>
          h("tr", {},
            h("td", {}, c.name),
            h("td", {}, c.type || "—"),
            h("td", {}, c.notnull ? "NO" : "YES"),
            h("td", { class: c.dflt_value == null ? "null" : "" }, c.dflt_value == null ? "null" : String(c.dflt_value)),
            h("td", {}, c.pk ? String(c.pk) : ""),
          ),
        ),
      ),
    ),
    schema.sql ? h("pre", {}, schema.sql) : null,
  );
}

function modalView() {
  if (!state.modal) return null;
  if (state.modal.type === "insert") {
    return h("div", { class: "modal-back", onClick: (e) => { if (e.target === e.currentTarget) { state.modal = null; render(); } } },
      h("div", { class: "modal" },
        h("h3", {}, `插入 · ${state.table}`),
        ...Object.keys(state.modal.values).map((name) =>
          h("div", { class: "field" },
            h("label", {}, name),
            h("input", {
              value: state.modal.values[name],
              onInput: (e) => { state.modal.values[name] = e.target.value; },
            }),
          ),
        ),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", onClick: () => { state.modal = null; render(); } }, "取消"),
          h("button", { class: "btn btn-primary", onClick: submitInsert }, "插入"),
        ),
      ),
    );
  }
  return null;
}

function paletteView() {
  if (!state.palette) return null;
  const q = state.paletteQ.trim().toLowerCase();
  const items = state.databases.filter((d) => !q || d.name.toLowerCase().includes(q) || d.uuid.includes(q));
  const idx = Math.min(state.paletteIndex, Math.max(items.length - 1, 0));
  return h("div", { class: "modal-back", onClick: (e) => { if (e.target === e.currentTarget) { state.palette = false; render(); } } },
    h("div", { class: "palette" },
      h("input", {
        id: "palette-q",
        placeholder: "搜索数据库…",
        value: state.paletteQ,
        onInput: (e) => { state.paletteQ = e.target.value; state.paletteIndex = 0; render(); document.getElementById("palette-q")?.focus(); },
        onKeydown: (e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); state.paletteIndex = Math.min(idx + 1, items.length - 1); render(); }
          if (e.key === "ArrowUp") { e.preventDefault(); state.paletteIndex = Math.max(idx - 1, 0); render(); }
          if (e.key === "Enter" && items[idx]) {
            state.palette = false;
            go(`/db/${items[idx].uuid}`);
          }
          if (e.key === "Escape") { state.palette = false; render(); }
        },
      }),
      h("div", { class: "palette-list" },
        ...items.map((d, i) =>
          h("button", {
            class: `palette-item ${i === idx ? "active" : ""}`,
            onClick: () => { state.palette = false; go(`/db/${d.uuid}`); },
          }, h("span", {}, d.name), h("span", { class: "uuid" }, d.uuid.slice(0, 8))),
        ),
      ),
    ),
  );
}

function render() {
  const root = h("div", { class: "shell" });
  if (!state.session) {
    app.replaceChildren(loginView(), state.toast ? h("div", { class: `toast ${state.toast.kind}` }, state.toast.message) : null);
    return;
  }
  const loc = parseHash();
  let body = homeView();
  if (loc.page === "mail") body = mailView();
  else if (loc.page === "kv") body = kvView();
  else if (loc.page === "workers") body = workersView();
  else if (state.db) body = workspace();
  root.append(topbar(), body);
  if (state.modal) root.append(modalView());
  if (state.palette) root.append(paletteView());
  if (state.toast) root.append(h("div", { class: `toast ${state.toast.kind}` }, state.toast.message));
  app.replaceChildren(root);
}

window.addEventListener("hashchange", route);
window.addEventListener("mail-render", render);
window.addEventListener("kv-render", render);
window.addEventListener("workers-render", render);
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!state.session) return;
    state.palette = true;
    state.paletteQ = "";
    state.paletteIndex = 0;
    render();
    queueMicrotask(() => document.getElementById("palette-q")?.focus());
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && state.view === "sql") {
    e.preventDefault();
    runSql();
  }
});

(async function init() {
  render();
  await loadSession();
  if (state.session) await route();
  else render();
})();
