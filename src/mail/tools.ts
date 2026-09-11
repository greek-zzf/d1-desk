import { verifyDraft } from "./ai";
import { Folders } from "./folders";
import { buildQuotedReplyBlock, stripHtmlToText, textToHtml } from "./helpers";
import {
  createEmail,
  deleteEmail,
  getEmail,
  getThreadEmails,
  listEmails,
  moveEmail,
  searchEmails,
  updateEmail,
} from "./store";

export async function toolListEmails(
  env: Env,
  mailboxId: string,
  params: { folder: string; limit: number; page: number },
) {
  const limit = Math.min(Math.max(params.limit || 20, 1), 50);
  const page = Math.max(params.page || 1, 1);
  const offset = (page - 1) * limit;
  return listEmails(env.MAIL, mailboxId, { folder: params.folder || Folders.INBOX, limit, offset });
}

export async function toolGetEmail(env: Env, mailboxId: string, emailId: string) {
  const email = await getEmail(env.MAIL, mailboxId, emailId);
  if (!email) return { error: "Email not found" };
  return { ...email, body_text: email.body ? stripHtmlToText(email.body) : "", body_html: email.body };
}

export async function toolGetThread(env: Env, mailboxId: string, threadId: string) {
  const emails = await getThreadEmails(env.MAIL, mailboxId, threadId);
  return {
    thread_id: threadId,
    message_count: emails.length,
    messages: emails.map((email) => ({
      ...email,
      body_text: email.body ? stripHtmlToText(email.body) : "",
    })),
  };
}

export async function toolSearchEmails(
  env: Env,
  mailboxId: string,
  params: { query: string; folder?: string },
) {
  return searchEmails(env.MAIL, mailboxId, params);
}

export async function toolDraftReply(
  env: Env,
  mailboxId: string,
  params: { originalEmailId: string; to: string; subject: string; body: string },
) {
  const sanitized = await verifyDraft(env.AI, params.body.trim());
  if (!sanitized) return { error: "Draft verification failed — body could not be verified. Please try again." };
  const original = await getEmail(env.MAIL, mailboxId, params.originalEmailId);
  const threadId = original?.thread_id || params.originalEmailId;
  const quoted = original
    ? buildQuotedReplyBlock({ date: original.date, sender: original.sender || params.to, body: original.body })
    : "";
  const bodyHtml = (/<[a-z][\s\S]*>/i.test(sanitized) ? sanitized : textToHtml(sanitized)) + quoted;
  const draftId = crypto.randomUUID();
  await createEmail(
    env.MAIL,
    mailboxId,
    Folders.DRAFT,
    {
      id: draftId,
      subject: params.subject,
      sender: mailboxId.toLowerCase(),
      recipient: params.to.toLowerCase(),
      date: new Date().toISOString(),
      body: bodyHtml,
      in_reply_to: params.originalEmailId,
      email_references: null,
      thread_id: threadId,
    },
    [],
  );
  return {
    status: "draft_saved",
    draftId,
    message: "Draft saved to Drafts folder. Review it and confirm to send.",
    draft: { originalEmailId: params.originalEmailId, to: params.to, subject: params.subject, body: params.body.trim() },
  };
}

export async function toolDraftEmail(
  env: Env,
  mailboxId: string,
  params: { to: string; subject: string; body: string },
) {
  const sanitized = await verifyDraft(env.AI, params.body.trim());
  if (!sanitized) return { error: "Draft verification failed — body could not be verified. Please try again." };
  const bodyHtml = /<[a-z][\s\S]*>/i.test(sanitized) ? sanitized : textToHtml(sanitized);
  const draftId = crypto.randomUUID();
  await createEmail(
    env.MAIL,
    mailboxId,
    Folders.DRAFT,
    {
      id: draftId,
      subject: params.subject,
      sender: mailboxId.toLowerCase(),
      recipient: params.to.toLowerCase(),
      date: new Date().toISOString(),
      body: bodyHtml,
      in_reply_to: null,
      email_references: null,
      thread_id: draftId,
    },
    [],
  );
  return {
    status: "draft_saved",
    draftId,
    message: "Draft saved to Drafts folder. Review it and confirm to send.",
    draft: { to: params.to, subject: params.subject, body: params.body.trim() },
  };
}

export async function toolMarkEmailRead(env: Env, mailboxId: string, emailId: string, read: boolean) {
  const email = await updateEmail(env.MAIL, mailboxId, emailId, { read });
  if (!email) return { error: "Email not found" };
  return { status: "updated", emailId, read };
}

export async function toolMoveEmail(env: Env, mailboxId: string, emailId: string, folderId: string) {
  const ok = await moveEmail(env.MAIL, mailboxId, emailId, folderId);
  return ok ? { status: "moved", emailId, folder: folderId } : { error: "Failed to move email" };
}

export async function toolDiscardDraft(env: Env, mailboxId: string, draftId: string) {
  const email = await getEmail(env.MAIL, mailboxId, draftId);
  if (!email) return { error: "Draft not found" };
  if (email.folder_id !== Folders.DRAFT) return { error: "Cannot discard: email is not a draft" };
  await deleteEmail(env.MAIL, mailboxId, draftId);
  return { status: "discarded", draftId };
}
