CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY,
  zh_name TEXT NOT NULL,
  en_name TEXT,
  class_name TEXT NOT NULL,
  tutor TEXT NOT NULL,
  cas TEXT NOT NULL,
  cas_key TEXT NOT NULL,
  round_status TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS slots(
  slot_key TEXT PRIMARY KEY,
  cas_key TEXT NOT NULL,
  date TEXT NOT NULL,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  weekday TEXT,
  eligible_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
  g12_locked INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  booked_student_id INTEGER REFERENCES students(id),
  source_status TEXT,
  source_reason TEXT
);

CREATE TABLE IF NOT EXISTS bookings(
  id BIGSERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  slot_key TEXT NOT NULL REFERENCES slots(slot_key),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  cancelled_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_student
  ON bookings(student_id) WHERE status='active';

CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot
  ON bookings(slot_key) WHERE status='active';
