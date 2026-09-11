import PostalMime from "postal-mime";
import { Folders } from "./folders";
import { storeParsedAttachments } from "./attachments";
import { allowedAddresses, extractMsgId } from "./helpers";
import { handleNewEmail } from "./agent";
import { createEmail, ensureSchema, findThreadBySubject, getMailbox, mailboxExists } from "./store";

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
  if (streamSize > MAX_EMAIL_SIZE) {
    throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
  }
  if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
  const result = new Uint8Array(streamSize);
  let bytesRead = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytesRead + value.length > streamSize) {
      await reader.cancel();
      throw new Error("Stream exceeds declared size");
    }
    result.set(value, bytesRead);
    bytesRead += value.length;
  }
  return result;
}

export async function receiveEmail(
  event: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (!env.MAIL || !env.MAIL_BUCKET) {
    console.error(JSON.stringify({ message: "mail bindings missing, dropping email" }));
    return;
  }
  await ensureSchema(env.MAIL);

  const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
  const parsedEmail = await new PostalMime().parse(rawEmail);
  if (!parsedEmail.to?.length || !parsedEmail.to[0].address) {
    throw new Error("received email with empty to");
  }

  const allowed = allowedAddresses(env.EMAIL_ADDRESSES);
  const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
  const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
  const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

  let mailboxId: string | undefined;
  if (allowed.length > 0) {
    mailboxId = allRecipients.find((addr) => allowed.includes(addr));
    if (!mailboxId) {
      console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`);
      return;
    }
  } else {
    mailboxId = allRecipients[0];
  }
  if (!mailboxId) throw new Error("received email with no valid recipient address");
  if (!(await mailboxExists(env.MAIL, mailboxId))) {
    console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`);
    return;
  }

  const messageId = crypto.randomUUID();
  const attachmentData = parsedEmail.attachments?.length
    ? await storeParsedAttachments(env.MAIL_BUCKET, messageId, parsedEmail.attachments)
    : [];

  const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
  const emailReferences = parsedEmail.references
    ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId)
    : [];
  let threadId = emailReferences[0] || inReplyTo || messageId;
  if (!inReplyTo && emailReferences.length === 0) {
    const subjectThread = await findThreadBySubject(
      env.MAIL,
      mailboxId,
      parsedEmail.subject || "",
      parsedEmail.from?.address,
    );
    if (subjectThread) threadId = subjectThread;
  }
  const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

  await createEmail(
    env.MAIL,
    mailboxId,
    Folders.INBOX,
    {
      id: messageId,
      subject: parsedEmail.subject || "",
      sender: (parsedEmail.from?.address || "").toLowerCase(),
      recipient: allRecipients.join(", "),
      cc: ccRecipients.join(", ") || null,
      bcc: bccRecipients.join(", ") || null,
      date: parsedEmail.date ? new Date(parsedEmail.date).toISOString() : new Date().toISOString(),
      body: parsedEmail.html || parsedEmail.text || "",
      in_reply_to: inReplyTo,
      email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
      thread_id: threadId,
      message_id: originalMessageId,
      raw_headers: JSON.stringify(parsedEmail.headers),
    },
    attachmentData,
  );

  if (env.AI) {
    const mailbox = await getMailbox(env.MAIL, mailboxId);
    const settings = (mailbox?.settings ?? {}) as Record<string, unknown>;
    if (settings.autoDraft !== false) {
      ctx.waitUntil(
        handleNewEmail(env, {
          mailboxId,
          emailId: messageId,
          sender: (parsedEmail.from?.address || "").toLowerCase(),
          subject: parsedEmail.subject || "",
          threadId,
        }).catch((e) => {
          console.error("Auto-draft failed:", e instanceof Error ? e.message : e);
        }),
      );
    }
  }
}
