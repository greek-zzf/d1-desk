import { Folders, SYSTEM_FOLDERS } from "./folders";
import { normalizeSubject } from "./helpers";

export type EmailRow = {
  mailbox_id: string;
  id: string;
  folder_id: string;
  subject: string | null;
  sender: string | null;
  recipient: string | null;
  cc: string | null;
  bcc: string | null;
  date: string | null;
  read: number | null;
  starred: number | null;
  body: string | null;
  in_reply_to: string | null;
  email_references: string | null;
  thread_id: string | null;
  message_id: string | null;
  raw_headers: string | null;
};

export type AttachmentRow = {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id: string | null;
  disposition: string | null;
};

export type EmailData = {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
  cc?: string | null;
  bcc?: string | null;
  date: string;
  body: string;
  read?: boolean;
  starred?: boolean;
  in_reply_to?: string | null;
  email_references?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  raw_headers?: string | null;
};

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mailboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS folders (
    mailbox_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_deletable INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (mailbox_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS emails (
    mailbox_id TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL,
    subject TEXT,
    sender TEXT,
    recipient TEXT,
    cc TEXT,
    bcc TEXT,
    date TEXT,
    read INTEGER DEFAULT 0,
    starred INTEGER DEFAULT 0,
    body TEXT,
    in_reply_to TEXT,
    email_references TEXT,
    thread_id TEXT,
    message_id TEXT,
    raw_headers TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    content_id TEXT,
    disposition TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder_date ON emails (mailbox_id, folder_id, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails (mailbox_id, thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments (email_id)`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    mailbox_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    tools TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_mailbox ON agent_messages (mailbox_id, created_at)`,
];

let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA_SQL) await db.prepare(sql).run();
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

function boolish(n: number | null | undefined): boolean {
  return !!n;
}

function mapEmail(row: EmailRow, attachments: AttachmentRow[] = []) {
  return {
    ...row,
    read: boolish(row.read),
    starred: boolish(row.starred),
    snippet: row.body ? row.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) : "",
    attachments,
  };
}

export async function listMailboxes(db: D1Database) {
  const { results } = await db.prepare("SELECT id, name, settings, created_at FROM mailboxes ORDER BY name").all<{
    id: string;
    name: string;
    settings: string;
    created_at: string;
  }>();
  return (results ?? []).map((m) => ({
    id: m.id,
    email: m.id,
    name: m.name,
    settings: safeJson(m.settings),
    created_at: m.created_at,
  }));
}

export async function mailboxExists(db: D1Database, mailboxId: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM mailboxes WHERE id = ?").bind(mailboxId).first();
  return !!row;
}

export async function getMailbox(db: D1Database, mailboxId: string) {
  const row = await db
    .prepare("SELECT id, name, settings, created_at FROM mailboxes WHERE id = ?")
    .bind(mailboxId)
    .first<{ id: string; name: string; settings: string; created_at: string }>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.id,
    name: row.name,
    settings: safeJson(row.settings),
    created_at: row.created_at,
  };
}

export async function createMailbox(db: D1Database, email: string, name: string) {
  const id = email.toLowerCase();
  const now = new Date().toISOString();
  const settings = JSON.stringify({
    fromName: name,
    forwarding: { enabled: false, email: "" },
    signature: { enabled: false, text: "" },
    autoDraft: true,
    agentSystemPrompt: "",
  });
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO mailboxes (id, name, settings, created_at) VALUES (?, ?, ?, ?)").bind(id, name, settings, now),
    ...SYSTEM_FOLDERS.map((f) =>
      db
        .prepare("INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, ?)")
        .bind(id, f.id, f.name, f.is_deletable),
    ),
  ];
  await db.batch(stmts);
  return { id, email: id, name, settings: JSON.parse(settings), created_at: now };
}

export async function listFolders(db: D1Database, mailboxId: string) {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.name, f.is_deletable,
              COALESCE(SUM(CASE WHEN e.read = 0 THEN 1 ELSE 0 END), 0) AS unreadCount
       FROM folders f
       LEFT JOIN emails e ON e.mailbox_id = f.mailbox_id AND e.folder_id = f.id
       WHERE f.mailbox_id = ?
       GROUP BY f.id, f.name, f.is_deletable
       ORDER BY f.is_deletable ASC, f.name`,
    )
    .bind(mailboxId)
    .all<{ id: string; name: string; is_deletable: number; unreadCount: number }>();
  return results ?? [];
}

export async function listEmails(
  db: D1Database,
  mailboxId: string,
  opts: { folder?: string; threadId?: string; limit: number; offset: number },
) {
  const cond = ["mailbox_id = ?"];
  const params: unknown[] = [mailboxId];
  if (opts.folder) {
    cond.push("folder_id = ?");
    params.push(opts.folder);
  }
  if (opts.threadId) {
    cond.push("thread_id = ?");
    params.push(opts.threadId);
  }
  const where = cond.join(" AND ");
  const count = await db
    .prepare(`SELECT COUNT(*) AS n FROM emails WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT mailbox_id, id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
              SUBSTR(body, 1, 300) AS body, in_reply_to, email_references, thread_id, message_id, raw_headers
       FROM emails WHERE ${where}
       ORDER BY date DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, opts.limit, opts.offset)
    .all<EmailRow>();
  return { emails: (results ?? []).map((row) => mapEmail(row)), total: Number(count?.n ?? 0) };
}

export async function getEmail(db: D1Database, mailboxId: string, emailId: string) {
  const row = await db
    .prepare("SELECT * FROM emails WHERE mailbox_id = ? AND id = ?")
    .bind(mailboxId, emailId)
    .first<EmailRow>();
  if (!row) return null;
  const { results } = await db
    .prepare("SELECT * FROM attachments WHERE email_id = ?")
    .bind(emailId)
    .all<AttachmentRow>();
  return mapEmail(row, results ?? []);
}

export async function getThreadEmails(db: D1Database, mailboxId: string, threadId: string) {
  const { results } = await db
    .prepare("SELECT * FROM emails WHERE mailbox_id = ? AND thread_id = ? ORDER BY date ASC")
    .bind(mailboxId, threadId)
    .all<EmailRow>();
  const emails = results ?? [];
  if (emails.length === 0) return [];
  const ids = emails.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  const atts = await db
    .prepare(`SELECT * FROM attachments WHERE email_id IN (${placeholders})`)
    .bind(...ids)
    .all<AttachmentRow>();
  const byEmail = new Map<string, AttachmentRow[]>();
  for (const att of atts.results ?? []) {
    const list = byEmail.get(att.email_id) ?? [];
    list.push(att);
    byEmail.set(att.email_id, list);
  }
  return emails.map((row) => mapEmail(row, byEmail.get(row.id) ?? []));
}

export async function emailExists(db: D1Database, emailId: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM emails WHERE id = ?").bind(emailId).first();
  return !!row;
}

export async function ensureFolder(db: D1Database, mailboxId: string, id: string, name: string) {
  await db
    .prepare(
      "INSERT OR IGNORE INTO folders (mailbox_id, id, name, is_deletable) VALUES (?, ?, ?, 1)",
    )
    .bind(mailboxId, id, name)
    .run();
}

export async function importEmail(
  db: D1Database,
  mailboxId: string,
  folder: string,
  email: EmailData & { read?: boolean; starred?: boolean },
  attachments: AttachmentRow[],
): Promise<"inserted" | "exists"> {
  if (await emailExists(db, email.id)) return "exists";
  const folderRow = await db
    .prepare("SELECT id FROM folders WHERE mailbox_id = ? AND (id = ? OR name = ?) LIMIT 1")
    .bind(mailboxId, folder, folder)
    .first<{ id: string }>();
  if (!folderRow) throw new Error(`folder "${folder}" not found`);
  await db
    .prepare(
      `INSERT OR IGNORE INTO emails (
        mailbox_id, id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
        body, in_reply_to, email_references, thread_id, message_id, raw_headers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      mailboxId,
      email.id,
      folderRow.id,
      email.subject,
      email.sender,
      email.recipient,
      email.cc ?? null,
      email.bcc ?? null,
      email.date,
      email.read ? 1 : 0,
      email.starred ? 1 : 0,
      email.body,
      email.in_reply_to ?? null,
      email.email_references ?? null,
      email.thread_id ?? null,
      email.message_id ?? null,
      email.raw_headers ?? null,
    )
    .run();
  for (const att of attachments) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(att.id, att.email_id, att.filename, att.mimetype, att.size, att.content_id, att.disposition)
      .run();
  }
  return "inserted";
}

export async function createEmail(
  db: D1Database,
  mailboxId: string,
  folder: string,
  email: EmailData,
  attachments: AttachmentRow[],
) {
  const folderRow = await db
    .prepare("SELECT id FROM folders WHERE mailbox_id = ? AND (id = ? OR name = ?) LIMIT 1")
    .bind(mailboxId, folder, folder)
    .first<{ id: string }>();
  if (!folderRow) throw new Error(`folder "${folder}" not found`);
  const isSent = folderRow.id === Folders.SENT;
  await db
    .prepare(
      `INSERT INTO emails (
        mailbox_id, id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
        body, in_reply_to, email_references, thread_id, message_id, raw_headers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      mailboxId,
      email.id,
      folderRow.id,
      email.subject,
      email.sender,
      email.recipient,
      email.cc ?? null,
      email.bcc ?? null,
      email.date,
      isSent ? 1 : email.read ? 1 : 0,
      email.starred ? 1 : 0,
      email.body,
      email.in_reply_to ?? null,
      email.email_references ?? null,
      email.thread_id ?? null,
      email.message_id ?? null,
      email.raw_headers ?? null,
    )
    .run();
  for (const att of attachments) {
    await db
      .prepare(
        `INSERT INTO attachments (id, email_id, filename, mimetype, size, content_id, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(att.id, att.email_id, att.filename, att.mimetype, att.size, att.content_id, att.disposition)
      .run();
  }
}

export async function updateEmail(
  db: D1Database,
  mailboxId: string,
  emailId: string,
  patch: { read?: boolean; starred?: boolean },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.read !== undefined) {
    sets.push("read = ?");
    params.push(patch.read ? 1 : 0);
  }
  if (patch.starred !== undefined) {
    sets.push("starred = ?");
    params.push(patch.starred ? 1 : 0);
  }
  if (sets.length === 0) return getEmail(db, mailboxId, emailId);
  params.push(mailboxId, emailId);
  await db
    .prepare(`UPDATE emails SET ${sets.join(", ")} WHERE mailbox_id = ? AND id = ?`)
    .bind(...params)
    .run();
  return getEmail(db, mailboxId, emailId);
}

export async function markThreadRead(db: D1Database, mailboxId: string, threadId: string) {
  await db
    .prepare("UPDATE emails SET read = 1 WHERE mailbox_id = ? AND thread_id = ? AND read = 0")
    .bind(mailboxId, threadId)
    .run();
}

export async function moveEmail(db: D1Database, mailboxId: string, emailId: string, folderId: string) {
  const folder = await db
    .prepare("SELECT id FROM folders WHERE mailbox_id = ? AND id = ?")
    .bind(mailboxId, folderId)
    .first();
  if (!folder) return false;
  const result = await db
    .prepare("UPDATE emails SET folder_id = ? WHERE mailbox_id = ? AND id = ?")
    .bind(folderId, mailboxId, emailId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteEmail(db: D1Database, mailboxId: string, emailId: string) {
  const email = await db
    .prepare("SELECT id FROM emails WHERE mailbox_id = ? AND id = ?")
    .bind(mailboxId, emailId)
    .first();
  if (!email) return null;
  const { results } = await db
    .prepare("SELECT id, filename FROM attachments WHERE email_id = ?")
    .bind(emailId)
    .all<{ id: string; filename: string }>();
  await db.prepare("DELETE FROM attachments WHERE email_id = ?").bind(emailId).run();
  await db.prepare("DELETE FROM emails WHERE mailbox_id = ? AND id = ?").bind(mailboxId, emailId).run();
  return results ?? [];
}

export async function getAttachment(db: D1Database, attachmentId: string) {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").bind(attachmentId).first<AttachmentRow>();
}

export async function findThreadBySubject(
  db: D1Database,
  mailboxId: string,
  subject: string,
  senderAddress?: string,
): Promise<string | null> {
  const normalized = normalizeSubject(subject);
  if (!normalized) return null;
  const { results } = await db
    .prepare(
      `SELECT thread_id, subject, GROUP_CONCAT(DISTINCT LOWER(sender)) AS senders,
              GROUP_CONCAT(DISTINCT LOWER(recipient)) AS recipients
       FROM emails
       WHERE mailbox_id = ? AND thread_id IS NOT NULL AND date >= datetime('now', '-7 days')
       GROUP BY thread_id
       ORDER BY MAX(date) DESC
       LIMIT 50`,
    )
    .bind(mailboxId)
    .all<{ thread_id: string; subject: string; senders: string; recipients: string }>();
  const sender = senderAddress?.toLowerCase().trim();
  for (const row of results ?? []) {
    if (normalizeSubject(row.subject || "") !== normalized) continue;
    if (sender) {
      const participants = `${row.senders || ""},${row.recipients || ""}`;
      if (!participants.includes(sender)) continue;
    }
    return row.thread_id;
  }
  return null;
}

export async function updateMailboxSettings(
  db: D1Database,
  mailboxId: string,
  settings: Record<string, unknown>,
) {
  const current = await getMailbox(db, mailboxId);
  if (!current) return null;
  const merged = { ...(current.settings as Record<string, unknown>), ...settings };
  await db
    .prepare("UPDATE mailboxes SET settings = ? WHERE id = ?")
    .bind(JSON.stringify(merged), mailboxId)
    .run();
  return getMailbox(db, mailboxId);
}

export async function searchEmails(
  db: D1Database,
  mailboxId: string,
  opts: { query: string; folder?: string; limit?: number },
) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const q = `%${opts.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const cond = ["mailbox_id = ?", "(subject LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\' OR recipient LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')"];
  const params: unknown[] = [mailboxId, q, q, q, q];
  if (opts.folder) {
    cond.push("folder_id = ?");
    params.push(opts.folder);
  }
  const { results } = await db
    .prepare(
      `SELECT mailbox_id, id, folder_id, subject, sender, recipient, cc, bcc, date, read, starred,
              SUBSTR(body, 1, 300) AS body, in_reply_to, email_references, thread_id, message_id, raw_headers
       FROM emails WHERE ${cond.join(" AND ")}
       ORDER BY date DESC LIMIT ?`,
    )
    .bind(...params, limit)
    .all<EmailRow>();
  return (results ?? []).map((row) => mapEmail(row));
}

export type AgentChatMessage = {
  id: string;
  mailbox_id: string;
  role: "user" | "assistant";
  text: string;
  tools: { name: string; input?: unknown; output?: unknown }[] | null;
  created_at: string;
};

export async function listAgentMessages(db: D1Database, mailboxId: string, limit = 40) {
  const { results } = await db
    .prepare(
      `SELECT id, mailbox_id, role, text, tools, created_at
       FROM agent_messages WHERE mailbox_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(mailboxId)
    .all<{ id: string; mailbox_id: string; role: string; text: string; tools: string | null; created_at: string }>();
  const rows = results ?? [];
  const sliced = rows.length > limit ? rows.slice(rows.length - limit) : rows;
  return sliced.map((row) => ({
    id: row.id,
    mailbox_id: row.mailbox_id,
    role: row.role === "assistant" ? "assistant" : "user",
    text: row.text,
    tools: parseTools(row.tools),
    created_at: row.created_at,
  })) as AgentChatMessage[];
}

export async function saveAgentMessage(db: D1Database, message: AgentChatMessage) {
  await db
    .prepare(
      `INSERT INTO agent_messages (id, mailbox_id, role, text, tools, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.id,
      message.mailbox_id,
      message.role,
      message.text,
      message.tools ? JSON.stringify(message.tools) : null,
      message.created_at,
    )
    .run();
}

export async function clearAgentMessages(db: D1Database, mailboxId: string) {
  await db.prepare("DELETE FROM agent_messages WHERE mailbox_id = ?").bind(mailboxId).run();
}

function parseTools(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
