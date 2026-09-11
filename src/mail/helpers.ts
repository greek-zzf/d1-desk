/** Send/receive helpers adapted from Cloudflare agentic-inbox (Apache-2.0). */

export class SenderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderValidationError";
  }
}

export function csvList(value: string | string[] | undefined): string | null {
  if (value == null || value === "") return null;
  const list = Array.isArray(value) ? value : [value];
  return list.map((s) => s.toLowerCase()).join(", ");
}

export function asList(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? value : [value];
}

export function validateSender(
  to: string | string[],
  from: string | { email: string; name: string },
  mailboxId: string,
): { toStr: string; fromEmail: string; fromName: string | undefined; fromDomain: string } {
  const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
  const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();
  const fromName = typeof from === "string" ? undefined : from.name;
  if (fromEmail !== mailboxId.toLowerCase()) {
    throw new SenderValidationError("From address must match the mailbox email address");
  }
  const fromDomain = fromEmail.split("@")[1];
  if (!fromDomain) throw new SenderValidationError("Invalid sender email address");
  return { toStr, fromEmail, fromName, fromDomain };
}

export function generateMessageId(fromDomain: string): {
  messageId: string;
  outgoingMessageId: string;
} {
  const messageId = crypto.randomUUID();
  return { messageId, outgoingMessageId: `${messageId}@${fromDomain}` };
}

export function extractMsgId(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return m ? m[1] : value.trim().split(/\s+/)[0];
}

export function buildThreadingHeaders(
  originalMsgId: string,
  references: string[],
): Record<string, string> {
  return {
    "In-Reply-To": `<${originalMsgId}>`,
    ...(references.length > 0
      ? { References: references.map((r) => `<${r}>`).join(" ") }
      : {}),
  };
}

export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* stored as space-separated */
  }
  return raw.split(/\s+/).filter(Boolean).map(extractMsgId);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToHtml(text: string): string {
  if (!text) return "";
  return `<div style="white-space:pre-wrap">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
}

export function stripHtmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildQuotedReplyBlock(original: {
  date?: string | null;
  sender?: string | null;
  body?: string | null;
}): string {
  if (!original.body) return "";
  const sender = escapeHtml(original.sender || "unknown");
  const date = escapeHtml(original.date || "");
  const body = escapeHtml(stripHtmlToText(original.body)).replace(/\n/g, "<br>");
  return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${date}, ${sender} wrote:<br><br>${body}</blockquote>`;
}

export function allowedAddresses(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function safeFilename(name: string): string {
  return (name || "untitled").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_");
}

export function attachmentKey(emailId: string, attachmentId: string, filename: string): string {
  return `attachments/${emailId}/${attachmentId}/${safeFilename(filename)}`;
}

export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}
