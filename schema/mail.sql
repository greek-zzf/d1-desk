CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  mailbox_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_deletable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mailbox_id, id)
);

CREATE TABLE IF NOT EXISTS emails (
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
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_id TEXT,
  disposition TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox_folder_date
  ON emails (mailbox_id, folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_emails_thread
  ON emails (mailbox_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_attachments_email
  ON attachments (email_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  tools TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_mailbox
  ON agent_messages (mailbox_id, created_at);
