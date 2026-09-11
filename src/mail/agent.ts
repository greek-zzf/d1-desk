import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { isPromptInjection, verifyDraft } from "./ai";
import { Folders, FOLDER_TOOL_DESCRIPTION, MOVE_FOLDER_TOOL_DESCRIPTION } from "./folders";
import { stripHtmlToText, textToHtml } from "./helpers";
import {
  createEmail,
  getEmail,
  getMailbox,
  getThreadEmails,
  listAgentMessages,
  saveAgentMessage,
  type AgentChatMessage,
} from "./store";
import {
  toolDiscardDraft,
  toolDraftEmail,
  toolDraftReply,
  toolGetEmail,
  toolGetThread,
  toolListEmails,
  toolMarkEmailRead,
  toolMoveEmail,
  toolSearchEmails,
} from "./tools";

export const DEFAULT_SYSTEM_PROMPT = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.

## Writing Style
Write like a real person. Short, direct, flowing prose. Get to the point. Plain text only - no HTML tags in your replies.

**Formatting rules:**
- Write in natural paragraphs. NO bullet points, NO numbered lists, NO dashes, NO markdown formatting in email drafts.
- NO bold (**), NO italic (*), NO headers (#), NO horizontal rules (---), NO code blocks. Plain text only.
- Links go inline in the text, not on separate lines.

**Agent Behavior Rules (CRITICAL):**
- NEVER output meta-commentary about what you are doing.
- When a new email arrives, your ONLY job is to call the \`draft_reply\` tool.
- DO NOT summarize the email. DO NOT explain your actions.
- Before drafting ANY reply, carefully read the full thread history.
- NEVER repeat information that was already shared in a prior message in the thread.

## Who Are You Replying To?
Use the name the person gives in their email body / signature.

## CRITICAL: Draft Only - Never Send
You can ONLY draft emails. You do NOT have the ability to send emails directly.

- Use draft_reply to draft replies to existing emails
- Use draft_email to draft new outbound emails
- The operator will review and send drafts from the UI - you cannot send them

**CRITICAL: The draft body must contain ONLY the email text.** Never include agent commentary, status messages, or markdown in the draft body.

**Don't paste draft contents into the chat.** In your chat message, just briefly say what you drafted.

## Draft Management
Use discard_draft to delete drafts that the operator rejects or that are no longer needed.`;

const AGENT_MODEL = "@cf/moonshotai/kimi-k2.5";

function createEmailTools(env: Env, mailboxId: string) {
  return {
    list_emails: tool({
      description:
        "List emails in a folder. Returns email metadata (id, subject, sender, recipient, date, read/starred status, thread_id).",
      inputSchema: z.object({
        folder: z.string().default(Folders.INBOX).describe(FOLDER_TOOL_DESCRIPTION),
        limit: z.number().default(20).describe("Maximum number of emails to return"),
        page: z.number().default(1).describe("Page number for pagination"),
      }),
      execute: async ({ folder, limit, page }) => toolListEmails(env, mailboxId, { folder, limit, page }),
    }),
    get_email: tool({
      description: "Get a single email with its full body content and attachments.",
      inputSchema: z.object({ emailId: z.string().describe("The email ID to retrieve") }),
      execute: async ({ emailId }) => toolGetEmail(env, mailboxId, emailId),
    }),
    get_thread: tool({
      description: "Get all emails in a conversation thread, sorted chronologically.",
      inputSchema: z.object({
        threadId: z.string().describe("The thread_id to retrieve all messages for."),
      }),
      execute: async ({ threadId }) => toolGetThread(env, mailboxId, threadId),
    }),
    search_emails: tool({
      description: "Search for emails matching a query across subject, sender, recipient, and body.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        folder: z.string().optional().describe("Optional folder to restrict search to"),
      }),
      execute: async ({ query, folder }) => toolSearchEmails(env, mailboxId, { query, folder }),
    }),
    draft_email: tool({
      description:
        "Draft a new email (not a reply) and save it to the Drafts folder. This does NOT send. Write the body as plain text.",
      inputSchema: z.object({
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Subject line"),
        body: z.string().describe("Plain text body. No HTML."),
      }),
      execute: async ({ to, subject, body }) => toolDraftEmail(env, mailboxId, { to, subject, body }),
    }),
    draft_reply: tool({
      description:
        "Draft a reply to an existing email and save it to the Drafts folder. This does NOT send. Write the body as plain text.",
      inputSchema: z.object({
        originalEmailId: z.string().describe("The ID of the email being replied to"),
        to: z.string().email().describe("Recipient email address"),
        subject: z.string().describe("Subject line (usually 'Re: ...')"),
        body: z.string().describe("Plain text body of the reply. No HTML."),
      }),
      execute: async ({ originalEmailId, to, subject, body }) =>
        toolDraftReply(env, mailboxId, { originalEmailId, to, subject, body }),
    }),
    mark_email_read: tool({
      description: "Mark an email as read or unread.",
      inputSchema: z.object({
        emailId: z.string().describe("The email ID"),
        read: z.boolean().describe("true to mark as read, false for unread"),
      }),
      execute: async ({ emailId, read }) => toolMarkEmailRead(env, mailboxId, emailId, read),
    }),
    move_email: tool({
      description: "Move an email to a different folder (inbox, sent, draft, archive, trash).",
      inputSchema: z.object({
        emailId: z.string().describe("The email ID"),
        folderId: z.string().describe(MOVE_FOLDER_TOOL_DESCRIPTION),
      }),
      execute: async ({ emailId, folderId }) => toolMoveEmail(env, mailboxId, emailId, folderId),
    }),
    discard_draft: tool({
      description: "Delete a draft email.",
      inputSchema: z.object({ draftId: z.string().describe("The ID of the draft to delete") }),
      execute: async ({ draftId }) => toolDiscardDraft(env, mailboxId, draftId),
    }),
  };
}

async function systemPromptFor(env: Env, mailboxId: string): Promise<string> {
  const mailbox = await getMailbox(env.MAIL, mailboxId);
  const settings = (mailbox?.settings ?? {}) as Record<string, unknown>;
  if (typeof settings.agentSystemPrompt === "string" && settings.agentSystemPrompt.trim()) {
    return settings.agentSystemPrompt;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function collectTools(result: {
  steps: Array<{
    toolCalls?: Array<{ toolName?: string; toolCallId?: string; input?: unknown; args?: unknown }>;
    toolResults?: Array<{
      toolCallId?: string;
      toolName?: string;
      output?: unknown;
      result?: unknown;
    }>;
  }>;
}): { name: string; input?: unknown; output?: unknown }[] {
  const out: { name: string; input?: unknown; output?: unknown }[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls ?? []) {
      const resultRow = (step.toolResults ?? []).find(
        (row) => row.toolCallId === call.toolCallId || row.toolName === call.toolName,
      );
      out.push({
        name: call.toolName || "tool",
        input: call.input ?? call.args,
        output: resultRow?.output ?? resultRow?.result,
      });
    }
  }
  return out;
}

export async function runAgentChat(env: Env, mailboxId: string, text: string): Promise<AgentChatMessage> {
  const workersai = createWorkersAI({ binding: env.AI });
  const history = await listAgentMessages(env.MAIL, mailboxId, 16);
  const userMsg: AgentChatMessage = {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    role: "user",
    text,
    tools: null,
    created_at: new Date().toISOString(),
  };
  await saveAgentMessage(env.MAIL, userMsg);

  const messages: ModelMessage[] = [
    ...history.map((m) => ({ role: m.role, content: m.text }) as ModelMessage),
    { role: "user", content: text },
  ];

  const result = await generateText({
    model: workersai(AGENT_MODEL),
    system: await systemPromptFor(env, mailboxId),
    messages,
    tools: createEmailTools(env, mailboxId),
    stopWhen: stepCountIs(5),
  });

  const tools = collectTools(result);
  const assistant: AgentChatMessage = {
    id: crypto.randomUUID(),
    mailbox_id: mailboxId,
    role: "assistant",
    text: result.text?.trim() || (tools.length ? `已执行：${tools.map((t) => t.name).join(", ")}` : "(无回复)"),
    tools: tools.length ? tools : null,
    created_at: new Date().toISOString(),
  };
  await saveAgentMessage(env.MAIL, assistant);
  return assistant;
}

export async function handleNewEmail(
  env: Env,
  emailData: { mailboxId: string; emailId: string; sender: string; subject: string; threadId: string },
): Promise<void> {
  const mailbox = await getMailbox(env.MAIL, emailData.mailboxId);
  const settings = (mailbox?.settings ?? {}) as Record<string, unknown>;
  if (settings.autoDraft === false) return;

  const email = await getEmail(env.MAIL, emailData.mailboxId, emailData.emailId);
  if (email?.body && (await isPromptInjection(env.AI, email.body))) {
    await saveAgentMessage(env.MAIL, {
      id: crypto.randomUUID(),
      mailbox_id: emailData.mailboxId,
      role: "assistant",
      text: "已拦截自动草稿：来信疑似包含提示注入或恶意指令。",
      tools: null,
      created_at: new Date().toISOString(),
    });
    return;
  }

  const emailBody = email?.body ? stripHtmlToText(email.body) : "";
  const threadEmails = await getThreadEmails(env.MAIL, emailData.mailboxId, emailData.threadId);
  let threadContext = "";
  if (threadEmails.length > 1) {
    threadContext = threadEmails
      .map((e) => {
        const text = e.body ? stripHtmlToText(e.body) : "";
        return `[${e.date}] ${e.sender} → ${e.recipient} (${e.folder_id}): ${text.slice(0, 500)}`;
      })
      .join("\n\n");
    if (threadContext && (await isPromptInjection(env.AI, threadContext))) {
      await saveAgentMessage(env.MAIL, {
        id: crypto.randomUUID(),
        mailbox_id: emailData.mailboxId,
        role: "assistant",
        text: "已拦截自动草稿：线程上下文疑似包含提示注入。",
        tools: null,
        created_at: new Date().toISOString(),
      });
      return;
    }
  }

  let autoPrompt = `A new email just arrived. Draft an appropriate response using draft_reply.

Email details:
- Mailbox: ${emailData.mailboxId}
- Email ID: ${emailData.emailId}
- From: ${emailData.sender}
- Subject: ${emailData.subject}
- Thread ID: ${emailData.threadId}

Email body:
${emailBody || "(could not pre-read — use get_email to read it)"}`;
  autoPrompt += threadContext
    ? `\n\nFull thread history (${emailData.threadId}):\n${threadContext}`
    : `\n\nThis is the first message in the thread (no prior conversation).`;
  autoPrompt += `\n\nBased on the email content and thread context above, draft a reply using draft_reply.`;

  await saveAgentMessage(env.MAIL, {
    id: crypto.randomUUID(),
    mailbox_id: emailData.mailboxId,
    role: "user",
    text: `[自动] 新邮件来自 ${emailData.sender}：${emailData.subject}`,
    tools: null,
    created_at: new Date().toISOString(),
  });

  const workersai = createWorkersAI({ binding: env.AI });
  const result = await generateText({
    model: workersai(AGENT_MODEL),
    system: await systemPromptFor(env, emailData.mailboxId),
    messages: [{ role: "user", content: autoPrompt }],
    tools: createEmailTools(env, emailData.mailboxId),
    stopWhen: stepCountIs(5),
  });

  const tools = collectTools(result);
  const draftToolCalled = tools.some((t) => t.name === "draft_reply" || t.name === "draft_email");
  if (!draftToolCalled && result.text.trim()) {
    const sanitizedText = await verifyDraft(env.AI, result.text.trim());
    if (sanitizedText) {
      const draftId = crypto.randomUUID();
      const reSubject = emailData.subject.startsWith("Re:") ? emailData.subject : `Re: ${emailData.subject}`;
      await createEmail(
        env.MAIL,
        emailData.mailboxId,
        Folders.DRAFT,
        {
          id: draftId,
          subject: reSubject,
          sender: emailData.mailboxId.toLowerCase(),
          recipient: emailData.sender.toLowerCase(),
          date: new Date().toISOString(),
          body: /<[a-z][\s\S]*>/i.test(sanitizedText) ? sanitizedText : textToHtml(sanitizedText),
          in_reply_to: emailData.emailId,
          email_references: null,
          thread_id: emailData.threadId,
        },
        [],
      );
    }
  }

  await saveAgentMessage(env.MAIL, {
    id: crypto.randomUUID(),
    mailbox_id: emailData.mailboxId,
    role: "assistant",
    text: draftToolCalled ? `已为 ${emailData.sender} 写好回复草稿。` : result.text.trim() || "已处理新邮件。",
    tools: tools.length ? tools : null,
    created_at: new Date().toISOString(),
  });
}
