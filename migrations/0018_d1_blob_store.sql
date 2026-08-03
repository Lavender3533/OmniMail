-- D1 Blob Store: replaces R2 for environments without R2 access.
-- Stores binary data in D1 using base64 encoding.
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,           -- base64-encoded binary data
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_blobs_created_at ON blobs(created_at);
