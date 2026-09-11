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
  agentOpen: true,
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
  }
}

async function openEmail(id, pushHash = true) {
  const data = await api(`/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(id)}`);
  mail.selected = data.email;
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
  return h("div", { class: `mail-work ${mail.agentOpen ? "with-agent" : ""}` },
    mailboxSide(),
    listPane(),
    readerPane(),
    mail.agentOpen ? agentPane() : null,
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
      h("button", {
        class: "btn btn-wide",
        onClick: () => { mail.agentOpen = !mail.agentOpen; renderApp(); },
      }, mail.agentOpen ? "收起 Agent" : "打开 Agent"),
    ),
    h("div", { class: "table-list" },
      mail.mailboxes.length === 0
        ? h("div", { class: "side-empty" }, "还没有邮箱。创建一个地址，并把 Email Routing 指到这个 Worker。")
        : mail.mailboxes.map((m) =>
            h("button", {
              class: `table-item ${mail.mailboxId === m.id ? "active" : ""}`,
              onClick: () => { mail.offset = 0; go(`/mail/${encodeURIComponent(m.id)}/inbox`); },
            }, h("span", { class: "name" }, m.name || m.id), h("span", { class: "kind" }, m.id.split("@")[0])),
          ),
      h("div", { class: "kicker", style: "padding:14px 10px 6px" }, "文件夹"),
      ...FOLDERS.map((f) =>
        h("button", {
          class: `table-item ${mail.folder === f.id && mail.mailboxId ? "active" : ""}`,
          disabled: !mail.mailboxId,
          onClick: () => { mail.offset = 0; go(`/mail/${encodeURIComponent(mail.mailboxId)}/${f.id}`); },
        }, h("span", { class: "name" }, f.name), h("span", { class: "kind" }, f.id)),
      ),
    ),
  );
}

function listPane() {
  const start = mail.total === 0 ? 0 : mail.offset + 1;
  const end = Math.min(mail.offset + mail.emails.length, mail.total);
  return h("section", { class: "mail-list" },
    h("div", { class: "main-bar" },
      h("h2", {}, FOLDERS.find((f) => f.id === mail.folder)?.name || mail.folder),
      h("div", { class: "grow" }),
      h("button", {
        class: "btn btn-primary",
        disabled: !mail.mailboxId,
        onClick: () => openCompose(),
      }, "写邮件"),
    ),
    h("div", { class: "mail-items" },
      mail.emails.length === 0
        ? h("div", { class: "empty" }, h("h3", {}, "没有邮件"), h("p", {}, "把域名的 Email Routing catch-all 指到这个 Worker，并先创建一个邮箱地址。"))
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

function readerPane() {
  if (!mail.selected) {
    return h("section", { class: "mail-reader" },
      h("div", { class: "empty" }, h("h3", {}, "选择一封邮件"), h("p", {}, "从中间列表打开，或点右上角写一封新的。")),
    );
  }
  const email = mail.selected;
  return h("section", { class: "mail-reader" },
    h("div", { class: "main-bar" },
      h("h2", {}, email.subject || "(无主题)"),
      h("div", { class: "grow" }),
      h("button", { class: "btn", onClick: () => openCompose({ mode: "reply", email }) }, "回复"),
      h("button", { class: "btn", onClick: () => openCompose({ mode: "forward", email }) }, "转发"),
      h("button", { class: "btn", onClick: () => moveSelected("archive") }, "归档"),
      h("button", { class: "btn btn-danger", onClick: () => moveSelected("trash") }, "删除"),
    ),
    h("div", { class: "mail-thread" },
      ...mail.thread.map((msg) => messageCard(msg)),
    ),
  );
}

function messageCard(msg) {
  const atts = msg.attachments || [];
  return h("article", { class: "mail-card" },
    h("div", { class: "mail-card-head" },
      h("div", {},
        h("div", { class: "mail-from" }, msg.sender || ""),
        h("div", { class: "mail-meta" }, `到 ${msg.recipient || ""}`),
      ),
      h("div", { class: "mail-date" }, formatTime(msg.date)),
    ),
    emailBody(msg.body || ""),
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

function emailBody(html) {
  const iframe = h("iframe", {
    class: "mail-frame",
    sandbox: "",
    referrerpolicy: "no-referrer",
  });
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#1b1b16;background:#fff;word-break:break-word}
    img{max-width:100%;height:auto}
    a{color:#0b57d0}
  </style></head><body>${html}</body></html>`;
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
    await api(
      `/api/mail/mailboxes/${encodeURIComponent(mail.mailboxId)}/emails/${encodeURIComponent(mail.selected.id)}/move`,
      { body: { folderId } },
    );
    toast(folderId === "trash" ? "已移到废纸篓" : "已归档");
    mail.selected = null;
    go(currentFolderHash());
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
