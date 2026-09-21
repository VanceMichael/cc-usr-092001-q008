import assert from "node:assert/strict";
import test from "node:test";

import { appendEvent, openDatabase, verifyIntegrity, AppendConflict, nextSourceSequence } from "../src/db.js";
import { validateEnvelope, validatePayload, EVENT_TYPES } from "../src/events.js";

function envelope(overrides = {}) {
  return {
    event_id: "EVENT-1",
    event_type: EVENT_TYPES.ATHLETE_REGISTERED,
    subject_ref: "A-01",
    occurred_at: "2026-09-01T10:00:00+08:00",
    source: "src",
    source_sequence: 1,
    payload: {
      athlete_id: "A-01",
      pseudonym: "甲",
      sport: "weightlifting",
      gender: "female",
    },
    ...overrides,
  };
}

test("同一 event_id 重放为幂等，内容不同则 409 冲突", () => {
  const db = openDatabase(":memory:");
  const first = appendEvent(db, envelope());
  assert.equal(first.outcome, "appended");

  const replay = appendEvent(db, envelope());
  assert.equal(replay.outcome, "duplicated");

  assert.throws(
    () => appendEvent(db, envelope({ occurred_at: "2026-09-02T10:00:00+08:00" })),
    (error) => error instanceof AppendConflict && error.status === 409,
  );

  // 同来源序号也不能被另一条事件占用
  assert.throws(
    () => appendEvent(db, envelope({ event_id: "EVENT-2", subject_ref: "A-02" })),
    AppendConflict,
  );

  // 新序号正常推进
  assert.equal(nextSourceSequence(db, "src"), 2);
});

test("原始载荷被外部篡改后，完整性校验能够发现", () => {
  const db = openDatabase(":memory:");
  appendEvent(db, envelope());
  const before = verifyIntegrity(db);
  assert.equal(before.ok, true);

  // 直接改库（绕过追加接口）模拟篡改
  db.prepare("UPDATE events SET payload = ? WHERE event_id = ?").run(
    JSON.stringify({ ...envelope().payload, pseudonym: "被篡改" }),
    "EVENT-1",
  );
  const after = verifyIntegrity(db);
  assert.equal(after.ok, false);
  assert.deepEqual(after.mismatches, ["EVENT-1"]);
});

test("人工决定缺少理由或理由过短时被入站校验拒绝", () => {
  const missing = validatePayload(EVENT_TYPES.DECISION_RECORDED, {
    roster_id: "R-1",
    action: "approve",
    decided_by: "u1",
    decided_at: "2026-09-01T10:00:00+08:00",
  });
  assert.ok(missing.some((message) => message.includes("rationale")));

  const tooShort = validateEnvelope({
    ...envelope({ event_type: EVENT_TYPES.DECISION_RECORDED }),
    payload: {
      roster_id: "R-1",
      action: "approve",
      decided_by: "u1",
      decided_at: "2026-09-01T10:00:00+08:00",
      rationale: "x",
    },
  });
  assert.ok(tooShort.some((message) => message.includes("理由过短")));
});

test("信封缺字段或时间格式错误时被拒绝", () => {
  const errors = validateEnvelope({ ...envelope(), occurred_at: "2026-09-01 10:00" });
  assert.ok(errors.length > 0);
  assert.ok(errors.some((message) => message.includes("occurred_at")));

  const noPayload = validateEnvelope({ event_id: "E", event_type: "x", subject_ref: "s",
    occurred_at: "2026-09-01T10:00:00+08:00", source: "src", source_sequence: 1 });
  assert.ok(noPayload.some((message) => message.includes("payload")));
});

test("结果事件必须指明运动员或组合，且效果枚举受控", () => {
  const errors = validatePayload(EVENT_TYPES.RESULT_RECORDED, {
    competition_id: "C-1",
    event_code: "WL-W59",
    recorded_at: "2026-09-01T10:00:00+08:00",
    medal: "platinum",
  });
  assert.ok(errors.some((message) => message.includes("athlete_id")));
  assert.ok(errors.some((message) => message.includes("medal")));
});
