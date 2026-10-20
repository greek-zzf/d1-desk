import { api, formatTime, go, h, toast, withBusy } from "./app.js";

const FOLDERS = [
  { id: "inbox", name: "收件箱" },
  { id: "sent", name: "已发送" },
  { id: "draft", name: "草稿" },
  { id: "archive", name: "归档" },
  { id: "trash", name: "废纸篓" },
];

export const mail = {
  mailboxes: [],
  config: { domains: [], emailAddresses: [] },
  mailboxId: "",
  folder: "inbox",
  emails: [],
  total: 0,
  offset: 0,
  limit: 50,
  selected: null,
  thread: [],
  compose: null,
  createOpen: false,
  createEmail: "",
  createName: "",
  agentOpen: false,
  agentMessages: [],
  agentInput: "",
  agentBusy: false,
  settingsOpen: false,
  settingsPrompt: "",
  settingsAutoDraft: true,
};

export function resetMail() {
  Object.assign(mail, {
    mailboxes: [],
    mailboxId: "",
    folder: "inbox",
    emails: [],
    total: 0,
    offset: 0,
    selected: null,
    thread: [],
    compose: null,
    createOpen: false,
    agentOpen: false,
    agentMessages: [],
    agentInput: "",
    agentBusy: false,
    settingsOpen: false,
  });
}

export function parseMailHash(raw) {
  const parts = raw.split("/").filter(Boolean);
  return {
    page: "mail",
    mailboxId: parts[1] ? decodeURIComponent(parts[1]) : "",
    folder: parts[2] ? decodeURIComponent(parts[2]) : "inbox",
    emailId: parts[3] ? decodeURIComponent(parts[3]) : "",
  };
}

export async function loadMailRoute(loc) {
  if (mail.mailboxes.length === 0) {
    const [boxes, cfg] = await Promise.all([
      api("/api/mail/mailboxes"),
      api("/api/mail/config").catch(() => ({ domains: [], emailAddresses: [] })),
    ]);
    mail.mailboxes = boxes.mailboxes || [];
    mail.config = cfg;
  }
  mail.mailboxId = loc.mailboxId || mail.mailboxes[0]?.id || "";
  mail.folder = loc.folder || "inbox";
  if (!mail.mailboxId) {
    mail.emails = [];
    mail.selected = null;
    mail.thread = [];
    mail.agentOpen = false;
    mail.agentMessages = [];
    return;
  }
  const [data, agent] = await Promise.all([
    api(
      `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails?folder=${encodeURIComponent(mail.folder)}&limit=${mail.limit}&offset=${mail.offset}`,
    ),
    api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/agent`).catch(() => ({ messages: [] })),
  ]);
  mail.agentMessages = agent.messages || [];
  mail.emails = data.emails || [];
  mail.total = data.total || 0;
  if (loc.emailId) {
    await openEmail(loc.emailId, false);
  } else {
    mail.selected = null;
    mail.thread = [];
    mail.agentOpen = false;
  }
}

async function openEmail(id, pushHash = true) {
  const data = await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(id)}`);
  mail.selected = data.email;
  mail.agentOpen = window.matchMedia("(min-width: 841px)").matches;
  if (data.email?.thread_id) {
    const thread = await api(
      `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/threads/${encodeURIComponent(data.email.thread_id)}`,
    );
    mail.thread = thread.emails || [data.email];
  } else {
    mail.thread = [data.email];
  }
  if (!data.email.read) {
    api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { read: true },
    }).catch(() => {});
    data.email.read = true;
    const row = mail.emails.find((e) => e.id === id);
    if (row) row.read = true;
  }
  if (pushHash) go(`/mail/${encodeURIComponent(mail.mailboxId)}/${mail.folder}/${encodeURIComponent(id)}`);
}

function snippet(email) {
  if (email.snippet) return email.snippet;
  const body = email.body || "";
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
}

export function mailView() {
  bindMailKeys();
  return h("div", {
    class: `mail-work${mail.selected ? " reading" : ""}`,
  },
    h("div", { class: "mail-desk" }, mailboxSide(), listPane()),
    mail.selected ? letterOverlay() : null,
    mail.compose ? composeModal() : null,
    mail.createOpen ? createModal() : null,
    mail.settingsOpen ? settingsModal() : null,
  );
}

function mailboxSide() {
  return h("aside", { class: "side" },
    h("div", { class: "side-head" },
      h("div", { class: "kicker" }, "MAIL"),
      h("h2", {}, "邮箱"),
    ),
    h("div", { class: "side-tools" },
      h("button", { class: "btn btn-primary btn-wide", onClick: () => { mail.createOpen = true; renderApp(); } }, "新建邮箱"),
      mail.mailboxId
        ? h("button", { class: "btn btn-wide", onClick: openSettings }, "Agent 设置")
        : null,
    ),
    h("div", { class: "table-list" },
      mail.mailboxes.length === 0
        ? h("div", { class: "side-empty" }, "还没有邮箱。点上面新建一个地址，再把 Email Routing catch-all 指到这个 Worker。")
        : mail.mailboxes.map((m) =>
            h("button", {
              class: `table-item mailbox ${mail.mailboxId === m.id ? "active" : ""}`,
              onClick: () => { mail.offset = 0; go(`/mail/${encodeURIComponent(m.id)}/inbox`); },
            }, h("span", { class: "name" }, m.id), h("span", { class: "kind" }, m.name && m.name !== m.id ? m.name : m.id.split("@")[0])),
          ),
      h("div", { class: "kicker", style: "padding:14px 10px 6px" }, "文件夹"),
      ...FOLDERS.map((f) =>
        h("button", {
          class: `table-item folder ${mail.folder === f.id && mail.mailboxId ? "active" : ""}`,
          disabled: !mail.mailboxId,
          onClick: () => { mail.offset = 0; go(`/mail/${encodeURIComponent(mail.mailboxId)}/${f.id}`); },
        }, h("span", { class: "name" }, f.name)),
      ),
    ),
  );
}

function listPane() {
  const start = mail.total === 0 ? 0 : mail.offset + 1;
  const end = Math.min(mail.offset + mail.emails.length, mail.total);
  const folderName = FOLDERS.find((f) => f.id === mail.folder)?.name || mail.folder;
  return h("section", { class: "mail-list" },
    h("div", { class: "mail-mobile-nav" },
      h("select", {
        class: "mail-select",
        disabled: mail.mailboxes.length === 0,
        onChange: (e) => { mail.offset = 0; go(`/mail/${encodeURIComponent(e.target.value)}/inbox`); },
      },
        mail.mailboxes.length === 0
          ? h("option", {}, "没有邮箱")
          : mail.mailboxes.map((m) => h("option", { value: m.id, selected: m.id === mail.mailboxId }, m.id)),
      ),
      h("select", {
        class: "mail-select",
        disabled: !mail.mailboxId,
        onChange: (e) => { mail.offset = 0; go(`/mail/${encodeURIComponent(mail.mailboxId)}/${e.target.value}`); },
      }, ...FOLDERS.map((f) => h("option", { value: f.id, selected: f.id === mail.folder }, f.name))),
    ),
    h("div", { class: "main-bar" },
      h("h2", {}, folderName),
      h("div", { class: "grow" }),
      h("button", {
        class: "btn btn-primary",
        disabled: !mail.mailboxId,
        onClick: () => openCompose(),
      }, "写邮件"),
    ),
    h("div", { class: "mail-items" },
      mail.emails.length === 0
        ? h("div", { class: "empty" },
            h("h3", {}, mail.mailboxId ? "没有邮件" : "还没有邮箱"),
            h("p", {}, mail.mailboxId
              ? "这层文件夹是空的。把域名的 Email Routing catch-all 指到这个 Worker，新信会出现在收件箱。"
              : "先创建一个邮箱地址，再把域名 Email Routing 的 catch-all 指到这个 Worker。"),
            mail.mailboxId
              ? null
              : h("button", { class: "btn btn-primary", onClick: () => { mail.createOpen = true; renderApp(); } }, "新建邮箱"),
          )
        : mail.emails.map((email) =>
            h("button", {
              class: `mail-item ${mail.selected?.id === email.id ? "active" : ""} ${email.read ? "" : "unread"}`,
              onClick: () => withBusy(() => openEmail(email.id)),
            },
              h("div", { class: "mail-item-top" },
                h("span", { class: "mail-from" }, email.sender || "未知发件人"),
                h("span", { class: "mail-date" }, formatTime(email.date)),
              ),
              h("div", { class: "mail-subject" }, email.subject || "(无主题)"),
              h("div", { class: "mail-snippet" }, snippet(email) || " "),
            ),
          ),
    ),
    h("div", { class: "pager" },
      h("span", {}, `${start}–${end} / ${mail.total}`),
      h("button", {
        class: "btn",
        disabled: mail.offset <= 0,
        onClick: () => { mail.offset = Math.max(0, mail.offset - mail.limit); go(currentFolderHash()); },
      }, "上一页"),
      h("button", {
        class: "btn",
        disabled: mail.offset + mail.limit >= mail.total,
        onClick: () => { mail.offset += mail.limit; go(currentFolderHash()); },
      }, "下一页"),
    ),
  );
}

function currentFolderHash() {
  return `/mail/${encodeURIComponent(mail.mailboxId)}/${mail.folder}`;
}

function closeReader() {
  mail.selected = null;
  mail.thread = [];
  mail.agentOpen = false;
  go(currentFolderHash());
}

let mailKeysBound = false;
function bindMailKeys() {
  if (mailKeysBound) return;
  mailKeysBound = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (mail.compose || mail.createOpen || mail.settingsOpen) return;
    if (!mail.selected) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) {
      if (!document.activeElement.closest(".mail-letter-agent")) return;
    }
    e.preventDefault();
    closeReader();
  });
}

function letterOverlay() {
  const email = mail.selected;
  return h("div", {
    class: "mail-letter-dim",
    onClick: (e) => { if (e.target === e.currentTarget) closeReader(); },
  },
    h("article", {
      class: "mail-letter",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "mail-letter-title",
    },
      h("header", { class: "mail-letter-bar" },
        h("button", { class: "btn", id: "mail-letter-close", onClick: closeReader }, "关闭"),
        h("div", { class: "mail-actions" },
          h("button", { class: "btn btn-primary", onClick: () => openCompose({ mode: "reply", email }) }, "回复"),
          h("button", { class: "btn btn-primary", onClick: () => moveSelected("archive") }, "归档"),
          h("button", { class: "btn", onClick: () => openCompose({ mode: "forward", email }) }, "转发"),
          h("button", { class: "btn btn-danger", onClick: () => moveSelected("trash") }, "删除"),
          mail.agentOpen
            ? null
            : h("button", { class: "btn", onClick: () => { mail.agentOpen = true; renderApp(); } }, "Agent"),
        ),
      ),
      h("div", { class: "mail-letter-scroll" },
        ...mail.thread.map((msg, i) => letterPage(msg, i === 0)),
      ),
    ),
    mail.agentOpen ? h("div", { class: "mail-letter-agent" }, agentPane()) : null,
  );
}

function letterPage(msg, featured) {
  const atts = msg.attachments || [];
  return h("section", { class: `mail-letter-page${featured ? " featured" : ""}` },
    featured
      ? h("h1", { id: "mail-letter-title" }, msg.subject || "(无主题)")
      : null,
    h("p", { class: featured ? "mail-letter-meta" : "mail-letter-meta continued" },
      `${msg.sender || "未知发件人"} → ${msg.recipient || ""} · ${formatTime(msg.date)}`,
    ),
    emailBody(msg),
    atts.length
      ? h("div", { class: "mail-atts" },
          ...atts.map((att) =>
            h("a", {
              class: "btn",
              href: `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(att.id)}`,
              target: "_blank",
              rel: "noreferrer",
            }, att.filename, ` (${formatBytes(att.size)})`),
          ),
        )
      : null,
  );
}

const FRAME_CSS = `
html {
  margin: 0;
  padding: 0;
  background: #f4efe4;
  color: #1a1914;
  overflow-x: auto;
  overflow-y: hidden;
  height: auto !important;
  min-height: 0 !important;
}
body {
  margin: 0;
  padding: 0;
  background: transparent !important;
  color: #1a1914;
  font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
  font-size: 16px;
  line-height: 1.7;
  overflow-wrap: break-word;
  word-wrap: break-word;
  height: auto !important;
  min-height: 0 !important;
}
body.prose p { margin: 0 0 0.9em; }
body.prose p:last-child { margin-bottom: 0; }
img, svg, video { max-width: 100%; height: auto; }
img[width="1"], img[height="1"], img[width="0"], img[height="0"] { display: none !important; }
table { max-width: 100%; border-collapse: collapse; }
td, th { overflow-wrap: break-word; }
pre, code {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88em;
}
blockquote {
  margin: 0.9em 0;
  padding: 0 0 0 0.95em;
  border-left: 2px solid #d4cbb8;
  color: #5c564a;
}
a { color: #0b57d0; }
hr { border: 0; border-top: 1px solid #e0d6c4; margin: 1.1em 0; }
.gmail_signature, [data-smartmail="gmail_signature"], .mail-sig {
  margin-top: 1.25em;
  color: #7a7368;
  font-size: 0.92em;
}
.mail-quote-wrap { margin: 1.1em 0 0; }
.mail-quote-toggle {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 6px 0;
  min-height: 32px;
  color: #7a7368;
  font: 12px/1.4 inherit;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.mail-quote-toggle::before {
  content: "";
  display: inline-block;
  width: 1.5em;
  border-top: 1px solid #d4cbb8;
  margin-right: 0.55em;
  vertical-align: middle;
}
.mail-quote-toggle:hover { color: #1a1914; }
.mail-quote-toggle:focus-visible {
  outline: 2px solid #1a1914;
  outline-offset: 3px;
}
.mail-quote-hidden[hidden] { display: none !important; }
`.trim();

const HTML_MARK = /<(?:html|body|div|table|p|br|span|pre|blockquote|h[1-6]|ul|ol|li|a|img|center|font|strong|em|b|i|hr|style)\b/i;

function looksLikeHtml(raw) {
  const s = raw.trim();
  return s.startsWith("<!") || s.startsWith("<?") || HTML_MARK.test(s);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function linkify(escaped) {
  return escaped.replace(
    /(https?:\/\/[^\s<]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    (match) => {
      if (match.includes("@") && !/^https?:/i.test(match)) {
        return `<a href="mailto:${match}">${match}</a>`;
      }
      const trimmed = match.replace(/[),.;:!?]+$/g, "");
      const punct = match.slice(trimmed.length);
      return `<a href="${trimmed}" rel="noreferrer">${trimmed}</a>${punct}`;
    },
  );
}

function textToProse(text) {
  const trimmed = text.replace(/\s+$/, "").replace(/^\uFEFF/, "");
  const sigSplit = trimmed.match(/^([\s\S]*?)\n-- \n([\s\S]+)$/);
  const main = sigSplit ? sigSplit[1] : trimmed;
  const sig = sigSplit ? sigSplit[2] : "";
  const toParas = (block) => linkify(escapeHtml(block))
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return toParas(main) + (sig ? `<aside class="mail-sig">${toParas(sig)}</aside>` : "");
}

function cidUrls(msg) {
  const map = new Map();
  if (!msg?.id || !mail.mailboxId) return map;
  for (const att of msg.attachments || []) {
    if (!att.content_id) continue;
    const cid = String(att.content_id).replace(/^<|>$/g, "");
    const url = `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(att.id)}`;
    map.set(cid, url);
    map.set(cid.toLowerCase(), url);
  }
  return map;
}

function sanitizeEmailDocument(raw, msg) {
  const parsed = new DOMParser().parseFromString(raw, "text/html");
  const kill = new Set([
    "SCRIPT", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "BASE",
    "FORM", "APPLET", "FRAMESET", "FRAME", "INPUT", "BUTTON", "SELECT", "TEXTAREA",
  ]);
  const cids = cidUrls(msg);
  const styles = [];
  for (const style of [...parsed.querySelectorAll("style")]) {
    styles.push(style.textContent || "");
    style.remove();
  }
  const comments = [];
  const walker = document.createTreeWalker(parsed, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((node) => node.remove());
  for (const el of [...parsed.querySelectorAll("*")]) {
    if (kill.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim();
      if (name.startsWith("on") || name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }
      if (
        (name === "href" || name === "src" || name === "xlink:href" || name === "action") &&
        /^\s*(javascript|vbscript|data\s*:(?!image\/))/i.test(val)
      ) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") || "";
      const cidMatch = src.match(/^cid:(.+)$/i);
      if (cidMatch) {
        const key = decodeURIComponent(cidMatch[1]).replace(/^<|>$/g, "");
        const url = cids.get(key) || cids.get(key.toLowerCase());
        if (url) el.setAttribute("src", url);
        else el.remove();
      }
    }
    if (el.tagName === "TABLE") {
      const w = parseInt(el.getAttribute("width") || "0", 10);
      if (w > 640) el.setAttribute("width", "100%");
      if (el.style.width && parseInt(el.style.width, 10) > 640) el.style.width = "100%";
    }
  }
  return { body: parsed.body ? parsed.body.innerHTML : raw, styles };
}

function prepareEmailHtml(raw, msg) {
  const text = String(raw || "");
  if (!looksLikeHtml(text)) {
    return { kind: "prose", body: textToProse(text), styles: [] };
  }
  const prepared = sanitizeEmailDocument(text, msg);
  return { kind: "html", ...prepared };
}

function fitMailFrame(iframe) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return;
    const html = doc.documentElement;
    const body = doc.body;
    html.style.height = "auto";
    html.style.minHeight = "0";
    if (body) {
      body.style.height = "auto";
      body.style.minHeight = "0";
    }
    const height = Math.max(body?.scrollHeight || 0, body?.offsetHeight || 0, html.scrollHeight || 0);
    iframe.style.height = `${Math.max(24, height)}px`;
  } catch {
    iframe.style.height = "40vh";
  }
}

function collapseQuotes(doc, onToggle) {
  const selectors = [
    ".gmail_quote",
    ".gmail_extra",
    "#divRplyFwdMsg",
    ".yahoo_quoted",
    ".protonmail_quote",
    ".moz-cite-prefix",
    "blockquote",
  ];
  let root = null;
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el && doc.body.contains(el)) {
      root = el;
      break;
    }
  }
  if (!root?.parentNode) return;
  const bodyText = (doc.body.textContent || "").trim();
  const quoteText = (root.textContent || "").trim();
  if (!quoteText || quoteText.length < 8) return;
  if (quoteText.length > bodyText.length * 0.85) return;

  const wrap = doc.createElement("div");
  wrap.className = "mail-quote-wrap";
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "mail-quote-toggle";
  btn.textContent = "显示引用的内容";
  const hidden = doc.createElement("div");
  hidden.className = "mail-quote-hidden";
  hidden.hidden = true;
  root.parentNode.insertBefore(wrap, root);
  hidden.append(root);
  wrap.append(btn, hidden);
  btn.addEventListener("click", () => {
    hidden.hidden = !hidden.hidden;
    btn.textContent = hidden.hidden ? "显示引用的内容" : "收起引用";
    onToggle();
  });
}

function isNearWhite(color) {
  const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return false;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const aMatch = String(color).match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([0-9.]+)\)/i);
  const a = aMatch ? Number(aMatch[1]) : 1;
  if (a === 0) return true;
  return r > 244 && g > 238 && b > 228;
}

function sitOnPaper(doc) {
  const paint = (el) => {
    if (!el) return;
    const bg = doc.defaultView?.getComputedStyle(el).backgroundColor;
    if (isNearWhite(bg)) el.style.setProperty("background", "transparent", "important");
  };
  paint(doc.body);
  const kids = [...(doc.body?.children || [])];
  if (kids.length && kids.length <= 4) kids.forEach(paint);
}

function enhanceMailFrame(iframe, extraStyles) {
  const doc = iframe.contentDocument;
  if (!doc?.body) return;
  if (doc.body.dataset.mailEnhanced) {
    fitMailFrame(iframe);
    return;
  }
  doc.body.dataset.mailEnhanced = "1";
  for (const css of extraStyles || []) {
    if (!css.trim()) continue;
    const style = doc.createElement("style");
    style.textContent = css;
    doc.head.append(style);
  }
  sitOnPaper(doc);
  const fit = () => fitMailFrame(iframe);
  collapseQuotes(doc, fit);
  doc.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (!a?.href) return;
    if ((a.getAttribute("href") || "").startsWith("#")) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener,noreferrer");
  });
  for (const img of doc.images) {
    img.addEventListener("load", fit);
    img.addEventListener("error", () => {
      img.style.display = "none";
      fit();
    });
  }
  fit();
  requestAnimationFrame(fit);
  if (typeof ResizeObserver !== "undefined" && doc.body) {
    new ResizeObserver(fit).observe(doc.body);
  }
}

function emailBody(msg) {
  const raw = msg.body || "";
  if (!raw.trim()) return h("p", { class: "mail-letter-empty" }, "没有正文");
  const prepared = prepareEmailHtml(raw, msg);
  const iframe = h("iframe", {
    class: "mail-frame",
    sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    referrerpolicy: "no-referrer",
    title: msg.subject || "邮件正文",
  });
  const kind = prepared.kind || "html";
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500&display=swap"><style>${FRAME_CSS}</style></head><body class="${kind}">${prepared.body}</body></html>`;
  iframe.addEventListener("load", () => enhanceMailFrame(iframe, prepared.styles));
  return iframe;
}

function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function openCompose(opts = {}) {
  const email = opts.email;
  const mode = opts.mode || "new";
  let to = "";
  let subject = "";
  let body = "";
  if (mode === "reply" && email) {
    to = email.sender || "";
    subject = email.subject?.startsWith("Re:") ? email.subject : `Re: ${email.subject || ""}`;
  } else if (mode === "forward" && email) {
    subject = email.subject?.startsWith("Fwd:") ? email.subject : `Fwd: ${email.subject || ""}`;
    body = `\n\n---------- Forwarded message ----------\nFrom: ${email.sender}\nDate: ${email.date}\nSubject: ${email.subject}\n\n`;
  }
  mail.compose = { mode, email, to, cc: "", subject, body, files: [] };
  if (mode === "reply" || mode === "forward") mail.agentOpen = true;
  renderApp();
}

function composeModal() {
  const c = mail.compose;
  return h("div", { class: "modal-back", onClick: (e) => { if (e.target === e.currentTarget) { mail.compose = null; renderApp(); } } },
    h("div", { class: "modal mail-compose" },
      h("h3", {}, c.mode === "reply" ? "回复" : c.mode === "forward" ? "转发" : "写邮件"),
      h("div", { class: "field" },
        h("label", {}, "发件人"),
        h("input", { value: mail.mailboxId, disabled: true }),
      ),
      h("div", { class: "field" },
        h("label", {}, "收件人"),
        h("input", { value: c.to, onInput: (e) => { c.to = e.target.value; } }),
      ),
      h("div", { class: "field" },
        h("label", {}, "抄送"),
        h("input", { value: c.cc, onInput: (e) => { c.cc = e.target.value; } }),
      ),
      h("div", { class: "field" },
        h("label", {}, "主题"),
        h("input", { value: c.subject, onInput: (e) => { c.subject = e.target.value; } }),
      ),
      h("div", { class: "field" },
        h("label", {}, "正文"),
        h("textarea", {
          rows: 12,
          onInput: (e) => { c.body = e.target.value; },
        }, c.body),
      ),
      h("div", { class: "field" },
        h("label", {}, "附件"),
        h("input", {
          type: "file",
          multiple: true,
          onChange: (e) => { c.files = [...e.target.files]; },
        }),
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onClick: () => { mail.compose = null; renderApp(); } }, "取消"),
        h("button", { class: "btn btn-primary", onClick: submitCompose }, "发送"),
      ),
    ),
  );
}

function createModal() {
  const hint = mail.config.domains?.length
    ? `地址需要落在：${mail.config.domains.join(", ")}`
    : "填完整邮箱地址，例如 hello@yourdomain.com";
  return h("div", { class: "modal-back", onClick: (e) => { if (e.target === e.currentTarget) { mail.createOpen = false; renderApp(); } } },
    h("div", { class: "modal" },
      h("h3", {}, "新建邮箱"),
      h("p", { class: "lede" }, hint),
      h("div", { class: "field" },
        h("label", {}, "邮箱地址"),
        h("input", {
          placeholder: "hello@yourdomain.com",
          value: mail.createEmail,
          onInput: (e) => { mail.createEmail = e.target.value; },
        }),
      ),
      h("div", { class: "field" },
        h("label", {}, "显示名"),
        h("input", {
          placeholder: "Felix",
          value: mail.createName,
          onInput: (e) => { mail.createName = e.target.value; },
        }),
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onClick: () => { mail.createOpen = false; renderApp(); } }, "取消"),
        h("button", { class: "btn btn-primary", onClick: submitCreate }, "创建"),
      ),
    ),
  );
}

async function submitCreate() {
  await withBusy(async () => {
    const data = await api("/api/mail/mailboxes", {
      body: { email: mail.createEmail.trim(), name: mail.createName.trim() || mail.createEmail.trim() },
    });
    mail.createOpen = false;
    mail.createEmail = "";
    mail.createName = "";
    mail.mailboxes = [];
    toast("邮箱已创建");
    go(`/mail/${encodeURIComponent(data.mailbox.id)}/inbox`);
  });
}

async function filesToAttachments(files) {
  const out = [];
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    out.push({
      content: btoa(bin),
      filename: file.name,
      type: file.type || "application/octet-stream",
      disposition: "attachment",
    });
  }
  return out;
}

async function submitCompose() {
  const c = mail.compose;
  if (!c.to.trim() || !c.subject.trim() || !c.body.trim()) {
    toast("收件人、主题和正文都要填", "error");
    return;
  }
  await withBusy(async () => {
    const attachments = c.files?.length ? await filesToAttachments(c.files) : undefined;
    const payload = {
      to: c.to.split(",").map((s) => s.trim()).filter(Boolean),
      cc: c.cc ? c.cc.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      from: mail.mailboxId,
      subject: c.subject,
      text: c.body,
      attachments,
    };
    const path = c.mode === "reply" && c.email
      ? `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(c.email.id)}/reply`
      : c.mode === "forward" && c.email
        ? `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(c.email.id)}/forward`
        : `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails`;
    await api(path, { body: payload });
    mail.compose = null;
    toast("已发送");
    mail.offset = 0;
    go(`/mail/${encodeURIComponent(mail.mailboxId)}/sent`);
  });
}

async function moveSelected(folderId) {
  if (!mail.selected) return;
  await withBusy(async () => {
    const id = mail.selected.id;
    const idx = mail.emails.findIndex((e) => e.id === id);
    const next = (idx >= 0 ? mail.emails[idx + 1] : null) || (idx > 0 ? mail.emails[idx - 1] : null);
    await api(
      `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(id)}/move`,
      { body: { folderId } },
    );
    toast(folderId === "trash" ? "已移到废纸篓" : "已归档");
    mail.emails = mail.emails.filter((e) => e.id !== id);
    mail.total = Math.max(0, mail.total - 1);
    if (next && next.id !== id) {
      await openEmail(next.id);
    } else {
      mail.selected = null;
      mail.thread = [];
      mail.agentOpen = false;
      go(currentFolderHash());
    }
  });
}

const TOOL_LABELS = {
  list_emails: "列出邮件",
  get_email: "阅读邮件",
  get_thread: "加载线程",
  search_emails: "搜索",
  draft_email: "起草新邮件",
  draft_reply: "起草回复",
  discard_draft: "丢弃草稿",
  mark_email_read: "更新已读",
  move_email: "移动邮件",
};

function agentPane() {
  return h("aside", { class: "agent-pane" },
    h("div", { class: "main-bar" },
      h("h2", {}, "Agent"),
      h("div", { class: "grow" }),
      h("button", {
        class: "btn",
        disabled: !mail.mailboxId || mail.agentBusy,
        onClick: clearAgent,
      }, "清空"),
      h("button", {
        class: "btn",
        onClick: () => { mail.agentOpen = false; renderApp(); },
      }, "关闭"),
    ),
    h("div", { class: "agent-log", id: "agent-log" },
      mail.agentMessages.length === 0
        ? h("div", { class: "side-empty" }, "可以问：「收件箱最近有什么？」「给最新一封写回复草稿」。新邮件到达时会自动起草回复，不会直接发送。")
        : mail.agentMessages.map((msg) => agentBubble(msg)),
      mail.agentBusy ? h("div", { class: "agent-bubble assistant" }, h("div", { class: "agent-text" }, "思考中…")) : null,
    ),
    h("form", { class: "agent-input", onSubmit: sendAgent },
      h("textarea", {
        rows: 2,
        placeholder: mail.mailboxId ? "给 Agent 发指令…" : "先选择邮箱",
        disabled: !mail.mailboxId || mail.agentBusy,
        value: mail.agentInput,
        onInput: (e) => { mail.agentInput = e.target.value; },
        onKeydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendAgent(e);
          }
        },
      }),
      h("button", { class: "btn btn-primary", type: "submit", disabled: !mail.mailboxId || mail.agentBusy }, "发送"),
    ),
  );
}

function agentBubble(msg) {
  const tools = msg.tools || [];
  const drafted = tools.some((t) => t.name === "draft_reply" || t.name === "draft_email");
  return h("div", { class: `agent-bubble ${msg.role}` },
    ...tools.map((t) => h("div", { class: "agent-tool" }, TOOL_LABELS[t.name] || t.name)),
    msg.text ? h("div", { class: "agent-text" }, msg.text) : null,
    drafted
      ? h("button", {
          class: "btn",
          onClick: () => { mail.offset = 0; go(`/mail/${encodeURIComponent(mail.mailboxId)}/draft`); },
        }, "查看草稿")
      : null,
  );
}

async function sendAgent(e) {
  e?.preventDefault?.();
  const text = mail.agentInput.trim();
  if (!text || !mail.mailboxId || mail.agentBusy) return;
  mail.agentInput = "";
  mail.agentBusy = true;
  mail.agentMessages = [
    ...mail.agentMessages,
    { id: "tmp-user", role: "user", text, tools: null, created_at: new Date().toISOString() },
  ];
  renderApp();
  queueMicrotask(() => {
    const log = document.getElementById("agent-log");
    if (log) log.scrollTop = log.scrollHeight;
  });
  try {
    const data = await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/agent`, { body: { text } });
    mail.agentMessages = mail.agentMessages.filter((m) => m.id !== "tmp-user");
    mail.agentMessages.push(
      { id: crypto.randomUUID?.() || String(Date.now()), role: "user", text, tools: null, created_at: new Date().toISOString() },
      data.message,
    );
  } catch (err) {
    toast(err.message || "Agent 调用失败", "error");
  } finally {
    mail.agentBusy = false;
    renderApp();
    queueMicrotask(() => {
      const log = document.getElementById("agent-log");
      if (log) log.scrollTop = log.scrollHeight;
    });
  }
}

async function clearAgent() {
  if (!mail.mailboxId) return;
  await withBusy(async () => {
    await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/agent`, { method: "DELETE" });
    mail.agentMessages = [];
    toast("对话已清空");
  });
}

async function openSettings() {
  const data = await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}`);
  const settings = data.mailbox?.settings || {};
  mail.settingsPrompt = settings.agentSystemPrompt || "";
  mail.settingsAutoDraft = settings.autoDraft !== false;
  mail.settingsOpen = true;
  renderApp();
}

function settingsModal() {
  return h("div", { class: "modal-back", onClick: (e) => { if (e.target === e.currentTarget) { mail.settingsOpen = false; renderApp(); } } },
    h("div", { class: "modal mail-compose" },
      h("h3", {}, "Agent 设置"),
      h("p", { class: "lede" }, "新邮件到达时自动起草回复（不会直接发送）。自定义系统提示会覆盖默认人设。"),
      h("label", { class: "check" },
        h("input", {
          type: "checkbox",
          checked: mail.settingsAutoDraft,
          onChange: (e) => { mail.settingsAutoDraft = e.target.checked; },
        }),
        " 新邮件自动起草回复",
      ),
      h("div", { class: "field", style: "margin-top:14px" },
        h("label", {}, "自定义系统提示（可空）"),
        h("textarea", {
          rows: 10,
          onInput: (e) => { mail.settingsPrompt = e.target.value; },
        }, mail.settingsPrompt),
      ),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn", onClick: () => { mail.settingsOpen = false; renderApp(); } }, "取消"),
        h("button", { class: "btn btn-primary", onClick: saveSettings }, "保存"),
      ),
    ),
  );
}

async function saveSettings() {
  await withBusy(async () => {
    await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}`, {
      method: "PUT",
      body: { settings: { autoDraft: mail.settingsAutoDraft, agentSystemPrompt: mail.settingsPrompt } },
    });
    mail.settingsOpen = false;
    toast("已保存");
  });
}

function renderApp() {
  window.dispatchEvent(new Event("mail-render"));
}
