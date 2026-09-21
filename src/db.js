import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "2";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  subject_ref     TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  source          TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  payload         TEXT NOT NULL,
  payload_digest  TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  UNIQUE(source, source_sequence)
);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_ref);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`;

/** v1 只建立了 service_meta；若存在无自增主键的旧 events 表，则按原顺序保留数据升级结构。 */
function migrateEventsTable(db) {
  const columns = db.prepare("PRAGMA table_info(events)").all();
  if (columns.length > 0 && !columns.some((column) => column.name === "id")) {
    db.exec("ALTER TABLE events RENAME TO events_legacy");
    db.exec(`
      CREATE TABLE events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT NOT NULL UNIQUE,
        event_type      TEXT NOT NULL,
        subject_ref     TEXT NOT NULL,
        occurred_at     TEXT NOT NULL,
        source          TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        payload         TEXT NOT NULL,
        payload_digest  TEXT NOT NULL,
        registered_at   TEXT NOT NULL,
        UNIQUE(source, source_sequence)
      );
      INSERT INTO events
        (id, event_id, event_type, subject_ref, occurred_at, source, source_sequence, payload, payload_digest, registered_at)
      SELECT rowid, event_id, event_type, subject_ref, occurred_at, source, source_sequence, payload, payload_digest, registered_at
      FROM events_legacy;
      DROP TABLE events_legacy;
    `);
  }
}

/** 规范序列化：键递归排序，保证摘要可跨进程重算。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function digestPayload(payload) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(payload), "utf8").digest("hex")}`;
}

export function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  if (databasePath !== ":memory:") {
    db.exec("PRAGMA journal_mode=WAL");
  }
  db.exec(SCHEMA_SQL);
  migrateEventsTable(db);
  db.prepare("INSERT INTO service_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    "schema_version",
    SCHEMA_VERSION,
  );
  return db;
}

const INSERT_EVENT = `
INSERT INTO events
  (event_id, event_type, subject_ref, occurred_at, source, source_sequence, payload, payload_digest, registered_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class AppendConflict extends Error {
  constructor(message, existing) {
    super(message);
    this.name = "AppendConflict";
    this.status = 409;
    this.existing = existing;
  }
}

function rowToEvent(row) {
  return {
    id: Number(row.id),
    event_id: row.event_id,
    event_type: row.event_type,
    subject_ref: row.subject_ref,
    occurred_at: row.occurred_at,
    source: row.source,
    source_sequence: row.source_sequence,
    payload: JSON.parse(row.payload),
    payload_digest: row.payload_digest,
    registered_at: row.registered_at,
  };
}

/**
 * 追加一条事件。事件一经写入不可修改、不可删除：
 * - event_id 重复且内容一致 => 幂等返回 duplicated；
 * - event_id 重复但内容不一致，或同来源序号被不同内容占用 => AppendConflict(409)。
 */
export function appendEvent(db, envelope, registeredAt = new Date().toISOString()) {
  const payloadText = stableStringify(envelope.payload);
  const digest = digestPayload(envelope.payload);
  try {
    db.prepare(INSERT_EVENT).run(
      envelope.event_id,
      envelope.event_type,
      envelope.subject_ref,
      envelope.occurred_at,
      envelope.source,
      envelope.source_sequence,
      payloadText,
      digest,
      registeredAt,
    );
  } catch (error) {
    const isConstraint =
      String(error.code ?? "").startsWith("SQLITE_CONSTRAINT") ||
      /constraint failed/i.test(error.message ?? "");
    if (!isConstraint) throw error;
    const byId = db.prepare("SELECT * FROM events WHERE event_id = ?").get(envelope.event_id);
    const bySource = db
      .prepare("SELECT * FROM events WHERE source = ? AND source_sequence = ?")
      .get(envelope.source, envelope.source_sequence);
    const existing = byId ?? bySource;
    if (
      existing &&
      existing.event_type === envelope.event_type &&
      existing.subject_ref === envelope.subject_ref &&
      existing.occurred_at === envelope.occurred_at &&
      existing.payload === payloadText
    ) {
      return { outcome: "duplicated", event: rowToEvent(existing) };
    }
    throw new AppendConflict("事件标识冲突：相同 event_id 或来源序号已被不同内容占用，原始记录不可覆盖", existing ? rowToEvent(existing) : null);
  }
  return { outcome: "appended", event: getEvent(db, envelope.event_id) };
}

export function getEvent(db, eventId) {
  const row = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  return row ? rowToEvent(row) : null;
}

export function listEvents(db) {
  return db.prepare("SELECT * FROM events ORDER BY id ASC").all().map(rowToEvent);
}

/** 重算全部载荷摘要，任何不匹配都意味着原始记录被外部改动。 */
export function verifyIntegrity(db) {
  const rows = db.prepare("SELECT event_id, payload, payload_digest FROM events ORDER BY id ASC").all();
  const mismatches = [];
  for (const row of rows) {
    const parsed = JSON.parse(row.payload);
    if (digestPayload(parsed) !== row.payload_digest) mismatches.push(row.event_id);
  }
  return { total: rows.length, mismatches, ok: mismatches.length === 0 };
}

export function nextSourceSequence(db, source) {
  const row = db
    .prepare("SELECT COALESCE(MAX(source_sequence), 0) + 1 AS next FROM events WHERE source = ?")
    .get(source);
  return row.next;
}
