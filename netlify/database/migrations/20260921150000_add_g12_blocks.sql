CREATE TABLE IF NOT EXISTS g12_blocks(
  id BIGSERIAL PRIMARY KEY,
  person_key TEXT NOT NULL,
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS g12_blocks_person_date_idx
  ON g12_blocks(person_key, date);
