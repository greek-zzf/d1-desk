export const Folders = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "draft",
  ARCHIVE: "archive",
  TRASH: "trash",
  SPAM: "spam",
} as const;

export type FolderId = (typeof Folders)[keyof typeof Folders];

export const SYSTEM_FOLDERS: { id: FolderId; name: string; is_deletable: number }[] = [
  { id: Folders.INBOX, name: "Inbox", is_deletable: 0 },
  { id: Folders.SENT, name: "Sent", is_deletable: 0 },
  { id: Folders.DRAFT, name: "Drafts", is_deletable: 0 },
  { id: Folders.ARCHIVE, name: "Archive", is_deletable: 0 },
  { id: Folders.TRASH, name: "Trash", is_deletable: 0 },
  { id: Folders.SPAM, name: "Spam", is_deletable: 0 },
];

export const FOLDER_DISPLAY_NAMES: Record<string, string> = {
  [Folders.INBOX]: "收件箱",
  [Folders.SENT]: "已发送",
  [Folders.DRAFT]: "草稿",
  [Folders.ARCHIVE]: "归档",
  [Folders.TRASH]: "废纸篓",
  [Folders.SPAM]: "垃圾邮件",
};

export const FOLDER_TOOL_DESCRIPTION = "Folder to list: inbox, sent, draft, archive, trash";
export const MOVE_FOLDER_TOOL_DESCRIPTION = "Target folder: inbox, sent, draft, archive, trash";
