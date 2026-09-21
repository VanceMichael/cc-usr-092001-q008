import { appendEvent, openDatabase } from "../src/db.js";
import { EVENT_TYPES as T } from "../src/events.js";

/** 内存库 + 自增来源序号的测试夹具。 */
export function makeHarness() {
  const db = openDatabase(":memory:");
  const sequences = new Map();

  function emit(eventType, subjectRef, payload, occurredAt, source = "training-admin") {
    const next = (sequences.get(source) ?? 0) + 1;
    sequences.set(source, next);
    const envelope = {
      event_id: `${eventType.toUpperCase().replaceAll(".", "-")}-${subjectRef}-${next}`,
      event_type: eventType,
      subject_ref: subjectRef,
      occurred_at: occurredAt,
      source,
      source_sequence: next,
      payload,
    };
    const result = appendEvent(db, envelope);
    if (result.outcome !== "appended") throw new Error(`测试事件未成功追加：${eventType} ${subjectRef}`);
    return result.event;
  }

  return { db, emit, T };
}

export { T };
