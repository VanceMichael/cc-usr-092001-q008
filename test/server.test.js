import assert from "node:assert/strict";
import test from "node:test";

import { healthPayload, createServer } from "../src/server.js";
import { seedDatabase } from "./helpers.js";

test("健康检查返回服务状态", () => {
  assert.deepEqual(healthPayload(), { status: "ok" });
});

async function withServer(setup) {
  const db = setup();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
  const stop = () =>
    new Promise((resolve) =>
      server.close(() => {
        db.close();
        resolve();
      })
    );
  return { call, stop, base };
}

test("端到端：登记事实→草案校验→理由留痕→结果效果→追溯，全程不回写事实", async () => {
  const harness = await withServer(() => seedDatabase().db);
  try {
    const { call } = harness;

    // 注册簿只读视图
    const athletes = await call("GET", "/v1/registry/athletes");
    assert.equal(athletes.status, 200);
    assert.ok(athletes.json.items.some((a) => a.subject_ref === "A-FAN"));

    // 建立方案并评估（问题名单）
    const created = await call("POST", "/v1/plans", {
      competition_id: "G2026", title: "端到端方案", created_by: "coach-zhang",
    });
    assert.equal(created.status, 201);
    const planId = created.json.plan_id;

    const rev = await call("POST", `/v1/plans/${planId}/revisions`, {
      entries: [
        { subject_ref: "A-XU", discipline: "table_tennis", event_code: "TT_MS" },
        { subject_ref: "PAIR-XD-1", entry_kind: "pair", discipline: "table_tennis", event_code: "TT_XD" },
        { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
      ],
      created_by: "coach-zhang", as_of: "2026-09-19T12:00:00+08:00",
    });
    assert.equal(rev.status, 201);
    assert.equal(rev.json.summary.block_count >= 0, true);

    // 无理由决定被拒
    const noReason = await call("POST", `/v1/plans/${planId}/decisions`, {
      action: "approve", reason: "", decided_by: "leader",
    });
    assert.equal(noReason.status, 422);
    assert.equal(noReason.json.error.code, "REASON_REQUIRED");

    // 干净名单（无 block）应可批准：用无伤病、无连续作战、席位足够的组合
    const clean = await call("POST", "/v1/plans", {
      competition_id: "G2026", title: "端到端-稳妥名单", created_by: "coach-li",
    });
    const cleanId = clean.json.plan_id;
    const cleanRev = await call("POST", `/v1/plans/${cleanId}/revisions`, {
      entries: [
        { subject_ref: "A-XU", discipline: "table_tennis", event_code: "TT_MS" },
        { subject_ref: "A-LIU", discipline: "weightlifting", event_code: "WL_M73" },
      ],
      created_by: "coach-li", as_of: "2026-09-19T12:00:00+08:00",
    });
    assert.equal(cleanRev.json.summary.block_count, 0, JSON.stringify(cleanRev.json.findings));
    const approved = await call("POST", `/v1/plans/${cleanId}/decisions`, {
      action: "approve", reason: "队会通过，兼顾成绩与新人", decided_by: "chef",
    });
    assert.equal(approved.status, 201);
    assert.equal(approved.json.status, "decided");

    // 方案对比
    const cmp = await call("GET", "/v1/competitions/G2026/compare");
    assert.equal(cmp.status, 200);
    assert.ok(cmp.json.by_discipline.weightlifting);

    // 登记一条亚运结果（混双夺金+资格+训练验证），POST /facts 自动派生效果
    const result = await call("POST", "/v1/facts", {
      event_id: "EV-E2E-RES", subject_ref: "PAIR-XD-1", fact_type: "competition_result",
      occurred_at: "2026-09-27T20:00:00+08:00", source: "RESULTS", source_sequence: 5,
      payload: {
        competition_id: "G2026", event_code: "TT_XD", entry_kind: "pair",
        pairing_id: "PAIR-XD-1", members: ["A-FAN", "A-CHEN"],
        medal_rank: 1, quota_outcome: "secured",
        validation: { phase: "混双配合验证", coordination_score: 8.8 },
      },
    });
    assert.equal(result.status, 202);
    assert.equal(result.json.results[0].duplicated, false);

    const summary = await call("GET", "/v1/effects/summary?competition_id=G2026");
    assert.equal(summary.json.summary.medal.gold, 1);
    assert.equal(summary.json.summary.olympic_qualification.secured, 1);
    assert.equal(summary.json.summary.training_validation, 1);

    const ledger = await call("GET", "/v1/pairings/PAIR-XD-1/ledger");
    assert.equal(ledger.status, 200);
    assert.equal(ledger.json.total_appearances, 1);
    assert.equal(ledger.json.is_new, true);

    // 运动员追溯
    const liu = await call("GET", "/v1/athletes/A-LIU/timeline");
    assert.equal(liu.status, 200);
    assert.ok(liu.json.timeline.some((e) => e.kind === "selection"));

    // 事实查询接口回显原始发生时间（未被到达时间覆盖）
    const facts = await call("GET", "/v1/facts?fact_type=competition_result");
    const e2eFact = facts.json.facts.find((f) => f.event_id === "EV-E2E-RES");
    assert.equal(e2eFact.occurred_at, "2026-09-27T20:00:00+08:00");
    assert.notEqual(e2eFact.ingested_at, e2eFact.occurred_at);

    // 错误路由
    const missing = await call("GET", "/v1/nope");
    assert.equal(missing.status, 404);
  } finally {
    await harness.stop();
  }
});

test("登记非法事实返回 400 且不入库", async () => {
  const harness = await withServer(() => seedDatabase().db);
  try {
    const bad = await harness.call("POST", "/v1/facts", {
      event_id: "EV-BAD", subject_ref: "X", fact_type: "load",
      occurred_at: "not-a-time", source: "S", source_sequence: 1, payload: {},
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "VALIDATION");
  } finally {
    await harness.stop();
  }
});
