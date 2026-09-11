import { json } from "../auth";
import {
  SenderValidationError,
  allowedAddresses,
  asList,
  attachmentKey,
  buildQuotedReplyBlock,
  buildThreadingHeaders,
  csvList,
  generateMessageId,
  parseReferences,
  stripHtmlToText,
  textToHtml,
  validateSender,
} from "./helpers";
import { storeBase64Attachments } from "./attachments";
import { Folders } from "./folders";
import { sendEmail, type SendEmailParams } from "./sender";
import { runAgentChat } from "./agent";
import {
  clearAgentMessages,
  createEmail,
  createMailbox,
  deleteEmail,
  ensureSchema,
  getAttachment,
  getEmail,
  getMailbox,
  getThreadEmails,
  listAgentMessages,
  listEmails,
  listFolders,
  listMailboxes,
  mailboxExists,
  markThreadRead,
  moveEmail,
  updateEmail,
  updateMailboxSettings,
} from "./store";

type SendBody = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  from?: string | { email: string; name: string };
  subject?: string;
  html?: string;
  text?: string;
  attachments?: {
    content: string;
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
    contentId?: string;
  }[];
  in_reply_to?: string;
  references?: string[];
  thread_id?: string;
};

function mailReady(env: Env): env is Env & { MAIL: D1Database; MAIL_BUCKET: R2Bucket } {
  return Boolean(env.MAIL && env.MAIL_BUCKET);
}

export async function handleMailApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!mailReady(env)) {
    return json({ error: "Mail is not configured (MAIL D1 / MAIL_BUCKET missing)" }, { status: 501 });
  }
  await ensureSchema(env.MAIL);

  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/api/mail/config") {
    return json({
      domains: allowedAddresses(env.DOMAINS),
      emailAddresses: allowedAddresses(env.EMAIL_ADDRESSES),
    });
  }

  if (method === "GET" && path === "/api/mail/mailboxes") {
    return json({ mailboxes: await listMailboxes(env.MAIL) });
  }

  if (method === "POST" && path === "/api/mail/mailboxes") {
    const body = (await request.json()) as { email?: string; name?: string };
    const email = body.email?.trim().toLowerCase();
    const name = body.name?.trim();
    if (!email || !name) return json({ error: "email and name are required" }, { status: 400 });
    if (!email.includes("@")) return json({ error: "invalid email" }, { status: 400 });
    const allowed = allowedAddresses(env.EMAIL_ADDRESSES);
    if (allowed.length > 0 && !allowed.includes(email)) {
      return json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, { status: 403 });
    }
    if (await mailboxExists(env.MAIL, email)) return json({ error: "Mailbox already exists" }, { status: 409 });
    const mailbox = await createMailbox(env.MAIL, email, name);
    return json({ mailbox }, { status: 201 });
  }

  const mb = path.match(/^\/api\/mail\/mailboxes\/([^/]+)(?:\/(.*))?$/);
  if (!mb) return json({ error: "Not found" }, { status: 404 });
  const mailboxId = decodeURIComponent(mb[1]).toLowerCase();
  const rest = mb[2] ?? "";
  if (!(await mailboxExists(env.MAIL, mailboxId))) return json({ error: "Mailbox not found" }, { status: 404 });

  if (method === "GET" && rest === "") {
    return json({ mailbox: await getMailbox(env.MAIL, mailboxId) });
  }

  if (method === "PUT" && rest === "") {
    const body = (await request.json()) as { settings?: Record<string, unknown> };
    if (!body.settings || typeof body.settings !== "object") {
      return json({ error: "settings is required" }, { status: 400 });
    }
    const mailbox = await updateMailboxSettings(env.MAIL, mailboxId, body.settings);
    return json({ mailbox });
  }

  if (rest === "agent") {
    if (!env.AI) return json({ error: "Workers AI is not configured" }, { status: 501 });
    if (method === "GET") {
      return json({ messages: await listAgentMessages(env.MAIL, mailboxId) });
    }
    if (method === "DELETE") {
      await clearAgentMessages(env.MAIL, mailboxId);
      return json({ ok: true });
    }
    if (method === "POST") {
      const body = (await request.json()) as { text?: string };
      const text = body.text?.trim();
      if (!text) return json({ error: "text is required" }, { status: 400 });
      try {
        const message = await runAgentChat(env, mailboxId, text);
        return json({ message });
      } catch (error) {
        const err = error instanceof Error ? error.message : "Agent failed";
        console.error(JSON.stringify({ message: "agent chat failed", error: err }));
        return json({ error: err }, { status: 502 });
      }
    }
  }

  if (method === "GET" && rest === "folders") {
    return json({ folders: await listFolders(env.MAIL, mailboxId) });
  }

  if (method === "GET" && rest === "emails") {
    const folder = url.searchParams.get("folder") || Folders.INBOX;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const data = await listEmails(env.MAIL, mailboxId, { folder, limit, offset });
    return json(data);
  }

  if (method === "POST" && rest === "emails") {
    return sendFromMailbox(env, mailboxId, (await request.json()) as SendBody, ctx);
  }

  const emailMatch = rest.match(/^emails\/([^/]+)(?:\/(.*))?$/);
  if (emailMatch) {
    const emailId = decodeURIComponent(emailMatch[1]);
    const extra = emailMatch[2] ?? "";

    if (method === "GET" && extra === "") {
      const email = await getEmail(env.MAIL, mailboxId, emailId);
      return email ? json({ email }) : json({ error: "Email not found" }, { status: 404 });
    }

    if (method === "PATCH" && extra === "") {
      const body = (await request.json()) as { read?: boolean; starred?: boolean };
      const email = await updateEmail(env.MAIL, mailboxId, emailId, body);
      return email ? json({ email }) : json({ error: "Email not found" }, { status: 404 });
    }

    if (method === "DELETE" && extra === "") {
      const atts = await deleteEmail(env.MAIL, mailboxId, emailId);
      if (atts === null) return json({ error: "Email not found" }, { status: 404 });
      if (atts.length > 0) {
        await Promise.all(atts.map((att) => env.MAIL_BUCKET.delete(attachmentKey(emailId, att.id, att.filename))));
      }
      return json({ ok: true });
    }

    if (method === "POST" && extra === "move") {
      const body = (await request.json()) as { folderId?: string };
      if (!body.folderId) return json({ error: "folderId is required" }, { status: 400 });
      const ok = await moveEmail(env.MAIL, mailboxId, emailId, body.folderId);
      return ok ? json({ status: "moved" }) : json({ error: "Folder not found" }, { status: 400 });
    }

    if (method === "POST" && extra === "reply") {
      return replyOrForward(env, mailboxId, emailId, (await request.json()) as SendBody, "reply", ctx);
    }
    if (method === "POST" && extra === "forward") {
      return replyOrForward(env, mailboxId, emailId, (await request.json()) as SendBody, "forward", ctx);
    }

    const attMatch = extra.match(/^attachments\/([^/]+)$/);
    if (method === "GET" && attMatch) {
      const attachmentId = decodeURIComponent(attMatch[1]);
      const attachment = await getAttachment(env.MAIL, attachmentId);
      if (!attachment || attachment.email_id !== emailId) {
        return json({ error: "Attachment not found" }, { status: 404 });
      }
      const obj = await env.MAIL_BUCKET.get(attachmentKey(emailId, attachmentId, attachment.filename));
      if (!obj) return json({ error: "Attachment file not found" }, { status: 404 });
      const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
      return new Response(obj.body, {
        headers: {
          "Content-Type": attachment.mimetype,
          "Content-Disposition": `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }

  const threadMatch = rest.match(/^threads\/([^/]+)$/);
  if (method === "GET" && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const emails = await getThreadEmails(env.MAIL, mailboxId, threadId);
    return json({ emails });
  }

  return json({ error: "Not found" }, { status: 404 });
}

type EnvWithMail = Env & { MAIL: D1Database; MAIL_BUCKET: R2Bucket };

async function sendFromMailbox(
  env: EnvWithMail,
  mailboxId: string,
  body: SendBody,
  ctx: ExecutionContext,
): Promise<Response> {
  const prepared = prepareSend(mailboxId, body);
  if ("error" in prepared) return json({ error: prepared.error }, { status: 400 });
  if (!env.EMAIL) return json({ error: "EMAIL sending binding is not configured" }, { status: 501 });

  const attachmentData = await storeBase64Attachments(env.MAIL_BUCKET, prepared.messageId, body.attachments);
  await createEmail(env.MAIL, mailboxId, Folders.SENT, prepared.record, attachmentData);
  ctx.waitUntil(
    sendEmail(env.EMAIL, prepared.params).catch((e) => {
      console.error("Deferred email delivery failed:", e instanceof Error ? e.message : e);
    }),
  );
  return json({ id: prepared.messageId, status: "sent" }, { status: 202 });
}

async function replyOrForward(
  env: EnvWithMail,
  mailboxId: string,
  emailId: string,
  body: SendBody,
  mode: "reply" | "forward",
  ctx: ExecutionContext,
): Promise<Response> {
  const original = await getEmail(env.MAIL, mailboxId, emailId);
  if (!original) return json({ error: "Original email not found" }, { status: 404 });
  if (!env.EMAIL) return json({ error: "EMAIL sending binding is not configured" }, { status: 501 });

  const originalMsgId = original.message_id || original.id;
  const references = [...parseReferences(original.email_references), originalMsgId].filter(Boolean);
  const threadId = mode === "reply" ? original.thread_id || original.id : undefined;
  if (mode === "reply" && !body.html && !body.text) {
    body.html = (body.html || "") + buildQuotedReplyBlock(original);
  }
  if (mode === "reply") {
    body.in_reply_to = originalMsgId;
    body.references = references;
    body.thread_id = threadId;
  }

  const prepared = prepareSend(mailboxId, body);
  if ("error" in prepared) return json({ error: prepared.error }, { status: 400 });

  if (mode === "reply") {
    prepared.record.in_reply_to = originalMsgId;
    prepared.record.email_references = JSON.stringify(references);
    prepared.record.thread_id = threadId || prepared.messageId;
    prepared.params.headers = buildThreadingHeaders(originalMsgId, references);
  } else {
    prepared.record.in_reply_to = null;
    prepared.record.email_references = null;
    prepared.record.thread_id = prepared.messageId;
  }

  const attachmentData = await storeBase64Attachments(env.MAIL_BUCKET, prepared.messageId, body.attachments);
  await createEmail(env.MAIL, mailboxId, Folders.SENT, prepared.record, attachmentData);
  if (mode === "reply" && threadId) await markThreadRead(env.MAIL, mailboxId, threadId);

  ctx.waitUntil(
    sendEmail(env.EMAIL, prepared.params).catch((e) => {
      console.error(`Deferred ${mode} delivery failed:`, e instanceof Error ? e.message : e);
    }),
  );
  return json({ id: prepared.messageId, status: "sent" }, { status: 202 });
}

function prepareSend(mailboxId: string, body: SendBody) {
  if (!body.to) return { error: "to is required" };
  if (!body.subject) return { error: "subject is required" };
  if (!body.html && !body.text) return { error: "html or text is required" };
  const from = body.from ?? mailboxId;
  let fromEmail: string;
  let fromName: string | undefined;
  let fromDomain: string;
  let toStr: string;
  try {
    ({ toStr, fromEmail, fromName, fromDomain } = validateSender(body.to, from, mailboxId));
  } catch (e) {
    if (e instanceof SenderValidationError) return { error: e.message };
    throw e;
  }
  const html = body.html || (body.text ? textToHtml(body.text) : "");
  const text = body.text || (body.html ? stripHtmlToText(body.html) : "");
  const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
  const now = new Date().toISOString();
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const cc = asList(body.cc)?.filter(Boolean);
  const bcc = asList(body.bcc)?.filter(Boolean);
  const params: SendEmailParams = {
    to: body.to,
    cc: cc?.length ? cc : undefined,
    bcc: bcc?.length ? bcc : undefined,
    from: fromName ? { email: fromEmail, name: fromName } : fromEmail,
    subject: body.subject,
    html,
    text,
    attachments: body.attachments,
  };
  return {
    messageId,
    params,
    record: {
      id: messageId,
      subject: body.subject,
      sender: fromEmail,
      recipient: toStr,
      cc: csvList(body.cc),
      bcc: csvList(body.bcc),
      date: now,
      body: html || text,
      in_reply_to: body.in_reply_to || null,
      email_references: body.references ? JSON.stringify(body.references) : null,
      thread_id: body.thread_id || body.in_reply_to || messageId,
      message_id: outgoingMessageId,
      raw_headers: JSON.stringify([
        { key: "from", value: fromHeader },
        { key: "to", value: Array.isArray(body.to) ? body.to.join(", ") : body.to },
        { key: "subject", value: body.subject },
        { key: "date", value: now },
        { key: "message-id", value: `<${outgoingMessageId}>` },
      ]),
    },
  };
}

