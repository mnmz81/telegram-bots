CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'rss',
  category TEXT NOT NULL DEFAULT 'industry',
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  url TEXT NOT NULL,
  url_norm TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  points INTEGER
);
CREATE INDEX items_fetched ON items(fetched_at);
-- kind: scheduled | now | alert
CREATE TABLE digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL
);
-- a copy of what was sent, so it outlives the 30-day item retention (saved list, weekly email)
CREATE TABLE digest_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  digest_id INTEGER NOT NULL REFERENCES digests(id),
  pos INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL,
  coverage INTEGER NOT NULL,
  title_he TEXT NOT NULL,
  summary_he TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  importance INTEGER NOT NULL DEFAULT 3,
  expanded TEXT
);
CREATE TABLE feedback (
  di_id INTEGER PRIMARY KEY REFERENCES digest_items(id),
  vote INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE saved (
  di_id INTEGER PRIMARY KEY REFERENCES digest_items(id),
  at TEXT NOT NULL
);
CREATE TABLE mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  until TEXT
);
-- every message in the chat (sent and received), for /clear
CREATE TABLE chat_messages (
  message_id INTEGER PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
