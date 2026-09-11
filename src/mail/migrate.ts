import { json, signaturesEqual } from "../auth";
import { attachmentKey } from "./helpers";
import {
  createMailbox,
  ensureFolder,
  ensureSchema,
  importEmail,
  mailboxExists,
  updateMailboxSettings,
  type AttachmentRow,
} from "./store";

const PAGE_SIZE = 25;
const EMAILS_PER_REQUEST = 10;

type OldMailboxStub = {
  getEmails(opts: {
    page?: number;
    limit?: number;
    sortColumn?: string;
    sortDirection?: string;
  }): Promise<Array<{ id: string }>>;
  getEmail(id: string): Promise<{
    id: string;
    folder_id?: string | null;
    subject?: string | null;
    sender?: string | null;
    recipient?: string | null;
    cc?: string | null;
    bcc?: string | null;
    date?: string | null;
    read?: boolean | number;
    starred?: boolean | number;
    body?: string | null;
    in_reply_to?: string | null;
    email_references?: string | null;
    thread_id?: string | null;
    message_id?: string | null;
    raw_headers?: string | null;
    attachments?: AttachmentRow[];
  } | null>;
  getFolders(): Promise<Array<{ id: string; name: string }>>;
};

type Cursor = {
  mailboxes: string[];
  i: number;
  page: number;
  offset: number;
};

function migrateReady(env: Env): env is Env & {
  MAIL: D1Database;
  MAIL_BUCKET: R2Bucket;
  OLD_MAIL_BUCKET: R2Bucket;
  OLD_MAILBOX: DurableObjectNamespace;
} {
  return Boolean(env.MAIL && env.MAIL_BUCKET && env.OLD_MAIL_BUCKET && env.OLD_MAILBOX);
}

export async function authorizeMigrate(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("x-migration-key") ?? "";
  if (!env.MIGRATION_KEY || !key) return false;
  return signaturesEqual(key, env.MIGRATION_KEY);
}

async function listOldMailboxIds(bucket: R2Bucket): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix: "mailboxes/", cursor, limit: 1000 });
    for (const obj of listed.objects) {
      const name = obj.key.replace(/^mailboxes\//, "").replace(/\.json$/, "");
      if (name.includes("@")) ids.push(name.toLowerCase());
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  ids.sort();
  return ids;
}

export async function handleMigrate(request: Request, env: Env): Promise<Response> {
  if (!(await authorizeMigrate(request, env))) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!migrateReady(env)) {
    return json(
      { error: "Migration bindings missing (OLD_MAIL_BUCKET / OLD_MAILBOX)" },
      { status: 501 },
    );
  }
  await ensureSchema(env.MAIL);

  if (request.method === "GET") {
    const mailboxes = await listOldMailboxIds(env.OLD_MAIL_BUCKET);
    return json({ mailboxes, count: mailboxes.length });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: { cursor?: Cursor } = {};
  try {
    if ((request.headers.get("content-type") || "").includes("application/json")) {
      body = (await request.json()) as { cursor?: Cursor };
    }
  } catch {
    body = {};
  }

  const mailboxes = body.cursor?.mailboxes?.length
    ? body.cursor.mailboxes
    : await listOldMailboxIds(env.OLD_MAIL_BUCKET);

  if (mailboxes.length === 0) {
    return json({ done: true, mailboxes: [], imported: 0, skipped: 0, message: "旧 inbox 里没有邮箱" });
  }

  let i = body.cursor?.i ?? 0;
  let page = body.cursor?.page ?? 1;
  let offset = body.cursor?.offset ?? 0;
  let imported = 0;
  let skipped = 0;
  let copiedFiles = 0;
  const errors: string[] = [];

  while (i < mailboxes.length && imported + skipped < EMAILS_PER_REQUEST) {
    const mailboxId = mailboxes[i];
    try {
      await ensureMailbox(env, mailboxId);
      const stub = env.OLD_MAILBOX.get(env.OLD_MAILBOX.idFromName(mailboxId)) as unknown as OldMailboxStub;
      const batch = await stub.getEmails({
        page,
        limit: PAGE_SIZE,
        sortColumn: "date",
        sortDirection: "ASC",
      });
      if (batch.length === 0) {
        i += 1;
        page = 1;
        offset = 0;
        continue;
      }
      const slice = batch.slice(offset);
      for (const row of slice) {
        if (imported + skipped >= EMAILS_PER_REQUEST) break;
        try {
          const result = await importOneEmail(env, mailboxId, stub, row.id);
          if (result.status === "inserted") imported += 1;
          else skipped += 1;
          copiedFiles += result.files;
        } catch (error) {
          skipped += 1;
          errors.push(`${mailboxId}/${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        offset += 1;
      }
      if (offset >= batch.length) {
        if (batch.length < PAGE_SIZE) {
          i += 1;
          page = 1;
          offset = 0;
        } else {
          page += 1;
          offset = 0;
        }
      }
    } catch (error) {
      errors.push(`${mailboxId}: ${error instanceof Error ? error.message : String(error)}`);
      i += 1;
      page = 1;
      offset = 0;
    }
  }

  const done = i >= mailboxes.length;
  return json({
    done,
    cursor: done ? null : { mailboxes, i, page, offset },
    mailbox: mailboxes[Math.min(i, mailboxes.length - 1)],
    imported,
    skipped,
    copiedFiles,
    errors,
  });
}

async function ensureMailbox(
  env: Env & { MAIL: D1Database; OLD_MAIL_BUCKET: R2Bucket; OLD_MAILBOX: DurableObjectNamespace },
  mailboxId: string,
) {
  const obj = await env.OLD_MAIL_BUCKET.get(`mailboxes/${mailboxId}.json`);
  let settings: Record<string, unknown> = {};
  let name = mailboxId;
  if (obj) {
    try {
      settings = (await obj.json()) as Record<string, unknown>;
      if (typeof settings.fromName === "string" && settings.fromName.trim()) name = settings.fromName;
    } catch {
      settings = {};
    }
  }
  if (!(await mailboxExists(env.MAIL, mailboxId))) {
    await createMailbox(env.MAIL, mailboxId, name);
  }
  const stub = env.OLD_MAILBOX.get(env.OLD_MAILBOX.idFromName(mailboxId)) as unknown as OldMailboxStub;
  try {
    const folders = await stub.getFolders();
    for (const folder of folders) {
      if (folder?.id) await ensureFolder(env.MAIL, mailboxId, folder.id, folder.name || folder.id);
    }
  } catch {
    /* system folders already created */
  }
  if (Object.keys(settings).length > 0) {
    await updateMailboxSettings(env.MAIL, mailboxId, {
      fromName: name,
      agentSystemPrompt: typeof settings.agentSystemPrompt === "string" ? settings.agentSystemPrompt : "",
      autoDraft: settings.autoDraft !== false,
    });
  }
}

async function importOneEmail(
  env: Env & { MAIL: D1Database; MAIL_BUCKET: R2Bucket; OLD_MAIL_BUCKET: R2Bucket },
  mailboxId: string,
  stub: OldMailboxStub,
  emailId: string,
): Promise<{ status: "inserted" | "exists"; files: number }> {
  const email = await stub.getEmail(emailId);
  if (!email) return { status: "exists", files: 0 };
  const attachments = (email.attachments ?? []).map((att) => ({
    id: att.id,
    email_id: att.email_id || email.id,
    filename: att.filename,
    mimetype: att.mimetype,
    size: att.size,
    content_id: att.content_id ?? null,
    disposition: att.disposition ?? "attachment",
  }));
  const status = await importEmail(
    env.MAIL,
    mailboxId,
    email.folder_id || "inbox",
    {
      id: email.id,
      subject: email.subject || "",
      sender: email.sender || "",
      recipient: email.recipient || "",
      cc: email.cc ?? null,
      bcc: email.bcc ?? null,
      date: email.date || new Date().toISOString(),
      body: email.body || "",
      read: Boolean(email.read),
      starred: Boolean(email.starred),
      in_reply_to: email.in_reply_to ?? null,
      email_references: email.email_references ?? null,
      thread_id: email.thread_id ?? email.id,
      message_id: email.message_id ?? null,
      raw_headers: email.raw_headers ?? null,
    },
    attachments,
  );
  let files = 0;
  for (const att of attachments) {
    const key = attachmentKey(att.email_id, att.id, att.filename);
    if (await env.MAIL_BUCKET.head(key)) continue;
    const src = await env.OLD_MAIL_BUCKET.get(key);
    if (!src) continue;
    await env.MAIL_BUCKET.put(key, src.body, { httpMetadata: src.httpMetadata });
    files += 1;
  }
  return { status, files };
}
