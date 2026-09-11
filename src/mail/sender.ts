import { base64ToBytes } from "./attachments";

export type SendEmailParams = {
  to: string | string[];
  from: string | { email: string; name: string };
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | { email: string; name: string };
  attachments?: {
    content: string;
    filename: string;
    type: string;
    disposition: "attachment" | "inline";
    contentId?: string;
  }[];
  headers?: Record<string, string>;
};

export async function sendEmail(
  binding: SendEmail,
  params: SendEmailParams,
): Promise<{ messageId?: string }> {
  const from: string | EmailAddress =
    typeof params.from === "string" ? params.from : { email: params.from.email, name: params.from.name };
  const attachments: EmailAttachment[] | undefined = params.attachments?.map((att) => {
    const content = looksLikeText(att.type)
      ? decodeMaybeBase64Text(att.content)
      : bytesBuffer(base64ToBytes(att.content));
    if (att.disposition === "inline" && att.contentId) {
      return {
        disposition: "inline" as const,
        contentId: att.contentId,
        filename: att.filename,
        type: att.type,
        content,
      };
    }
    return { disposition: "attachment" as const, filename: att.filename, type: att.type, content };
  });
  const result = await binding.send({
    to: params.to,
    from,
    subject: params.subject,
    html: params.html,
    text: params.text,
    cc: params.cc,
    bcc: params.bcc,
    replyTo:
      params.replyTo == null
        ? undefined
        : typeof params.replyTo === "string"
          ? params.replyTo
          : { email: params.replyTo.email, name: params.replyTo.name },
    headers: params.headers,
    attachments,
  });
  return { messageId: result.messageId };
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function looksLikeText(type: string): boolean {
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json");
}

function decodeMaybeBase64Text(content: string): string {
  try {
    return new TextDecoder().decode(base64ToBytes(content));
  } catch {
    return content;
  }
}
