CREATE TABLE tracked (
  id INTEGER PRIMARY KEY,
  dest TEXT NOT NULL,
  out TEXT NOT NULL,
  ret TEXT NOT NULL,
  out_key TEXT NOT NULL,
  ret_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE price_points (
  id INTEGER PRIMARY KEY,
  tracked_id INTEGER NOT NULL REFERENCES tracked(id),
  at TEXT NOT NULL,
  chosen_price INTEGER,
  cheapest_price INTEGER,
  cheapest_label TEXT
);
-- AUTOINCREMENT: ids of consumed buttons must never be reused by a later payload
CREATE TABLE options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
