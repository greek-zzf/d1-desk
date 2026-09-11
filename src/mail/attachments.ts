import { attachmentKey, safeFilename } from "./helpers";
import type { AttachmentRow } from "./store";

export type IncomingAttachment = {
  content: string;
  filename: string;
  type: string;
  disposition: string;
  contentId?: string;
};

export async function storeBase64Attachments(
  bucket: R2Bucket,
  emailId: string,
  attachments?: IncomingAttachment[],
): Promise<AttachmentRow[]> {
  if (!attachments?.length) return [];
  const results: AttachmentRow[] = [];
  for (const att of attachments) {
    const id = crypto.randomUUID();
    const filename = safeFilename(att.filename);
    const bytes = base64ToBytes(att.content);
    await bucket.put(attachmentKey(emailId, id, filename), bytes);
    results.push({
      id,
      email_id: emailId,
      filename,
      mimetype: att.type,
      size: bytes.byteLength,
      content_id: att.contentId || null,
      disposition: att.disposition,
    });
  }
  return results;
}

export async function storeParsedAttachments(
  bucket: R2Bucket,
  emailId: string,
  attachments: {
    filename?: string | null;
    mimeType?: string;
    content: ArrayBuffer | Uint8Array | string;
    contentId?: string;
    disposition?: string | null;
  }[],
): Promise<AttachmentRow[]> {
  const results: AttachmentRow[] = [];
  for (const att of attachments) {
    const id = crypto.randomUUID();
    const filename = safeFilename(att.filename || "untitled");
    const bytes =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : att.content instanceof Uint8Array
          ? att.content
          : new Uint8Array(att.content);
    await bucket.put(attachmentKey(emailId, id, filename), bytes);
    results.push({
      id,
      email_id: emailId,
      filename,
      mimetype: att.mimeType || "application/octet-stream",
      size: bytes.byteLength,
      content_id: att.contentId || null,
      disposition: att.disposition || "attachment",
    });
  }
  return results;
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
