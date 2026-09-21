import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase, digestPayload } from "../src/db.js";
import { createServer, healthPayload } from "../src/server.js";

function startServer(db) {
  return new Promise((resolve) => {
    const server = createServer(db);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

let seq = 0;
function eventOf(type, subject, payload, occurredAt, source = "api-test") {
  seq += 1;
  return {
    event_id: `EV-${seq}`,
    event_type: type,
    subject_ref: subject,
    occurred_at: occurredAt,
    source,
    source_sequence: seq,
    payload,
  };
}

async function seedMinimal(base) {
  const events = [
    eventOf("athlete.registered", "A1", {
      athlete_id: "A1", pseudonym: "甲", sport: "weightlifting", gender: "female",
    }, "2026-01-05T09:00:00+08:00"),
    eventOf("sport_rule.published", "WL", {
      rule_set_id: "WL-2026", sport: "weightlifting", version: "v2026",
      effective_from: "2026-01-01T00:00:00+08:00",
      entries: [{ event_code: "WL-W59", max_entries_per_noc: 1, max_entries_per_athlete: 1, compatible_with: ["WL-W59"] }],
    }, "2025-12-20T10:00:00+08:00", "rules-office"),
    eventOf("competition.scheduled", "C1", {
      competition_id: "C1", name: "测试赛", sport: "weightlifting",
      start_at: "2026-09-19T09:00:00+08:00", end_at: "2026-09-24T20:00:00+08:00",
    }, "2026-02-15T10:00:00+08:00", "calendars"),
    eventOf("quota.held", "Q1", {
      quota_id: "Q1", sport: "weightlifting", event_code: "WL-W59",
      holder_type: "athlete", holder_ref: "A1", earned_at: "2026-05-01T10:00:00+08:00", status: "confirmed",
    }, "2026-05-01T10:00:00+08:00"),
    eventOf("roster.created", "R1", {
      roster_id: "R1", competition_id: "C1", sport: "weightlifting",
      label: "方案一", created_at: "2026-08-05T09:00:00+08:00",
    }, "2026-08-05T09:00:00+08:00"),
    eventOf("roster.entry_added", "E1", {
      roster_id: "R1", entry_id: "E1", athlete_id: "A1", event_code: "WL-W59", role: "individual",
    }, "2026-08-05T09:10:00+08:00"),
  ];
  for (const event of events) {
    const result = await post(base, "/events", event);
    assert.equal(result.status, 201);
  }
}

test("健康检查返回服务状态", () => {
  assert.deepEqual(healthPayload(), { status: "ok" });
});

test("端到端：登记—校验—人工决定—结果—追溯，且无任何改写原始数据的入口", async (t) => {
  const { server, base } = await startServer(openDatabase(":memory:"));
  t.after(() => server.close());

  await seedMinimal(base);

  // 草案干净：钉定规则、无阻断项
  const validation = await get(base, "/rosters/R1/validation?as_of=2026-09-01T00:00:00%2B08:00");
  assert.equal(validation.status, 200);
  assert.equal(validation.body.pinned_rule.version, "v2026");
  assert.equal(validation.body.counts.block, 0);
  assert.equal(validation.body.active_entry_count, 1);

  // 人工决定必须带理由
  const badDecision = await post(base, "/events", eventOf("decision.recorded", "R1", {
    roster_id: "R1", action: "approve", decided_by: "u1",
    decided_at: "2026-08-22T10:30:00+08:00",
  }, "2026-08-22T10:30:00+08:00", "decision-desk"));
  assert.equal(badDecision.status, 400);

  const decision = await post(base, "/events", eventOf("decision.recorded", "R1", {
    roster_id: "R1", action: "approve", decided_by: "u1",
    decided_at: "2026-08-22T10:30:00+08:00", rationale: "席位、伤病与赛历均无异常，批准。",
  }, "2026-08-22T10:30:00+08:00", "decision-desk"));
  assert.equal(decision.status, 201);

  // 结果三类效果
  const result = await post(base, "/events", eventOf("result.recorded", "RES1", {
    competition_id: "C1", event_code: "WL-W59", athlete_id: "A1",
    medal: "gold", olympic_qualification: "earned",
    training_validation: { phase: "phase-1", passed: true },
    recorded_at: "2026-09-23T20:00:00+08:00",
  }, "2026-09-23T20:00:00+08:00", "results"));
  assert.equal(result.status, 201);

  const results = await get(base, "/competitions/C1/results");
  assert.equal(results.body.medals.length, 1);
  assert.equal(results.body.olympic_qualifications.length, 1);
  assert.equal(results.body.training_validations.length, 1);

  // 运动员追溯
  const timeline = await get(base, "/athletes/A1/timeline");
  assert.equal(timeline.status, 200);
  assert.ok(timeline.body.timeline.some((item) => item.kind === "entry_added"));
  assert.ok(timeline.body.timeline.some((item) => item.kind === "result"));

  // 方案对比
  const compare = await get(base, "/competitions/C1/compare");
  assert.equal(compare.body.options.length, 1);
  assert.equal(compare.body.options[0].latest_decision.action, "approve");

  // 规则按时刻解析
  const rules = await get(base, "/rules/effective?sport=weightlifting&at=2026-09-01T00:00:00%2B08:00");
  assert.equal(rules.body.version, "v2026");

  // 事件可回放；同一事件重复投递幂等
  const replay = await post(base, "/events", {
    event_id: "EV-1", event_type: "athlete.registered", subject_ref: "A1",
    occurred_at: "2026-01-05T09:00:00+08:00", source: "api-test", source_sequence: 1,
    payload: { athlete_id: "A1", pseudonym: "甲", sport: "weightlifting", gender: "female" },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.outcome, "duplicated");

  // 没有任何 PUT/PATCH/DELETE 入口可以改写历史
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}/events/EV-1`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject_ref: "hacked" }),
    });
    assert.equal(response.status, 404, `${method} 不应存在`);
  }

  const integrity = await get(base, "/integrity");
  assert.equal(integrity.body.ok, true);
});

test("非法事件返回 400 且带有字段级错误", async (t) => {
  const { server, base } = await startServer(openDatabase(":memory:"));
  t.after(() => server.close());

  const response = await post(base, "/events", {
    event_id: "BAD-1",
    event_type: "athlete.registered",
    subject_ref: "A1",
    occurred_at: "not-a-time",
    source: "src",
    source_sequence: 1,
    payload: { athlete_id: "A1" },
  });
  assert.equal(response.status, 400);
  assert.ok(Array.isArray(response.body.errors));
  assert.ok(response.body.errors.some((message) => message.includes("occurred_at")));
  assert.ok(response.body.errors.some((message) => message.includes("gender")));
});

test("携带的 payload_digest 与载荷不一致时拒绝", async (t) => {
  const { server, base } = await startServer(openDatabase(":memory:"));
  t.after(() => server.close());

  const event = eventOf("athlete.registered", "A1", {
    athlete_id: "A1", pseudonym: "甲", sport: "weightlifting", gender: "female",
  }, "2026-01-05T09:00:00+08:00");
  const wrong = { ...event, payload_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000" };
  const response = await post(base, "/events", wrong);
  assert.equal(response.status, 400);
  assert.ok(response.body.errors.some((message) => message.includes("payload_digest")));

  // 摘要正确时正常写入
  const good = { ...event, payload_digest: digestPayload(event.payload) };
  const ok = await post(base, "/events", good);
  assert.equal(ok.status, 201);
});

test("批量导入任一事件失败时整体回滚", async (t) => {
  const { server, base } = await startServer(openDatabase(":memory:"));
  t.after(() => server.close());

  const good = eventOf("athlete.registered", "A1", {
    athlete_id: "A1", pseudonym: "甲", sport: "weightlifting", gender: "female",
  }, "2026-01-05T09:00:00+08:00");
  const bad = eventOf("athlete.registered", "A2", {
    athlete_id: "A2", pseudonym: "乙",
  }, "2026-01-05T09:05:00+08:00");

  const response = await post(base, "/events/batch", { events: [good, bad] });
  assert.equal(response.status, 400);

  const list = await get(base, "/events");
  assert.equal(list.body.events.length, 0, "失败批次不得留下部分写入");
});
