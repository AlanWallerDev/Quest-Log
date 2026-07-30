-- Append-only event log. Nothing is ever updated or deleted; all app state is
-- derived by folding these rows. `seq` is server arrival order and is used
-- ONLY as a sync cursor -- clients replay by (ts, id), never by seq, because
-- arrival order diverges from causal order after any offline period.
CREATE TABLE IF NOT EXISTS events (
  id      TEXT PRIMARY KEY,                          -- uuid v4, client-generated
  ts      TEXT NOT NULL,                             -- ISO8601, client clock
  seq     INTEGER,                                   -- server arrival order
  type    TEXT NOT NULL,
  payload TEXT NOT NULL                              -- JSON
);

CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);

-- D1 has no AUTOINCREMENT on a non-PK column, so stamp seq on insert.
CREATE TRIGGER IF NOT EXISTS events_seq
AFTER INSERT ON events
FOR EACH ROW WHEN NEW.seq IS NULL
BEGIN
  UPDATE events
     SET seq = (SELECT IFNULL(MAX(seq), 0) + 1 FROM events)
   WHERE id = NEW.id;
END;
