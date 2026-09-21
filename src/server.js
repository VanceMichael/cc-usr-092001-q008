import http from "node:http";
import { URL } from "node:url";

import { openDb } from "./db.js";
import { ingestFact, replayFacts } from "./facts.js";
import { addDecision, addRevision, comparePlans, createPlan, getPlan, listPlans } from "./plans.js";
import { deriveEffects, effectSummary, getPartnershipLedger, listEffects } from "./effects.js";
import { athleteTimeline } from "./trace.js";

export function healthPayload() {
  return { status: "ok" };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  const status = err.status ?? (err.code === "VALIDATION" ? 400 : err.code === "CONFLICT" ? 409 : 500);
  if (status >= 500) console.error(err);
  sendJson(res, status, {
    error: { code: err.code ?? "INTERNAL", message: err.message, ...(err.details ? { details: err.details } : {}) },
  });
}

async function readJson(req) {
  const limit = 2 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error("请求体超过 2MiB 限制");
      err.status = 413;
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("请求体不是合法 JSON");
    err.status = 400;
    err.code = "BAD_JSON";
    throw err;
  }
}

// 注册簿只读视图：由事实流按当前位点归约
function registry(db, kind) {
  const model = replayFacts(db);
  switch (kind) {
    case "athletes":
      return [...model.athletes.values()];
    case "rules":
      return model.rules.map((r) => ({ ...r, body: r.body }));
    case "pairings":
      return [...model.pairings.values()].map((p) => ({ ...p, is_new: !!p.is_new }));
    case "competitions": {
      return [...model.competitions.values()].map((c) => ({
        ...c,
        events: [...model.competitionEvents.values()].filter((e) => e.competition_id === c.competition_id),
      }));
    }
    case "quotas":
      return [...model.quotas.values()];
    case "selection-basis":
      return [...model.selectionBasis.values()];
    default:
      return null;
  }
}

export function createServer(db = openDb()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    try {
      // --- 健康检查 ---
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, healthPayload());
        return;
      }

      // --- 事实登记 ---
      if (method === "POST" && path === "/v1/facts") {
        const body = await readJson(req);
        const events = Array.isArray(body.events) ? body.events : [body];
        if (events.length === 0) throw Object.assign(new Error("events 不能为空"), { status: 400, code: "VALIDATION" });
        const results = [];
        for (const ev of events) {
          const r = ingestFact(db, ev);
          // 比赛结果到达即确定性派生三类效果与配对台账
          if (!r.duplicated && ev.fact_type === "competition_result") {
            deriveEffects(db, { factId: r.id });
          }
          results.push({ event_id: ev.event_id, ...r });
        }
        sendJson(res, 202, { accepted: results.length, results });
        return;
      }

      if (method === "GET" && path === "/v1/facts") {
        const where = [];
        const args = [];
        if (url.searchParams.get("subject_ref")) { where.push("subject_ref = ?"); args.push(url.searchParams.get("subject_ref")); }
        if (url.searchParams.get("fact_type")) { where.push("fact_type = ?"); args.push(url.searchParams.get("fact_type")); }
        if (url.searchParams.get("source")) { where.push("source = ?"); args.push(url.searchParams.get("source")); }
        const sql = "SELECT id,event_id,subject_ref,fact_type,occurred_at,ingested_at,source,source_sequence,payload_digest,payload FROM fact_events"
          + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id";
        const rows = db.prepare(sql).all(...args).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
        sendJson(res, 200, { count: rows.length, facts: rows });
        return;
      }

      // --- 注册簿只读接口 ---
      const regMatch = path.match(/^\/v1\/registry\/(athletes|rules|pairings|competitions|quotas|selection-basis)$/);
      if (method === "GET" && regMatch) {
        sendJson(res, 200, { kind: regMatch[1], items: registry(db, regMatch[1]) });
        return;
      }

      if (method === "GET" && path.startsWith("/v1/registry/availability/")) {
        const ref = decodeURIComponent(path.slice("/v1/registry/availability/".length));
        const model = replayFacts(db);
        sendJson(res, 200, { subject_ref: ref, windows: model.availability.get(ref) ?? [] });
        return;
      }
      if (method === "GET" && path.startsWith("/v1/registry/loads/")) {
        const ref = decodeURIComponent(path.slice("/v1/registry/loads/".length));
        const model = replayFacts(db);
        sendJson(res, 200, { subject_ref: ref, loads: (model.loads.get(ref) ?? []).sort((a, b) => Date.parse(a.metric_date) - Date.parse(b.metric_date)) });
        return;
      }

      // --- 参赛方案 ---
      if (method === "POST" && path === "/v1/plans") {
        const body = await readJson(req);
        sendJson(res, 201, createPlan(db, body));
        return;
      }
      if (method === "GET" && path === "/v1/plans") {
        sendJson(res, 200, { plans: listPlans(db, { competition_id: url.searchParams.get("competition_id") ?? undefined }) });
        return;
      }
      const planMatch = path.match(/^\/v1\/plans\/([^/]+)$/);
      if (method === "GET" && planMatch) {
        sendJson(res, 200, getPlan(db, planMatch[1]));
        return;
      }
      const revMatch = path.match(/^\/v1\/plans\/([^/]+)\/revisions$/);
      if (method === "POST" && revMatch) {
        const body = await readJson(req);
        sendJson(res, 201, addRevision(db, revMatch[1], body));
        return;
      }
      const decMatch = path.match(/^\/v1\/plans\/([^/]+)\/decisions$/);
      if (method === "POST" && decMatch) {
        const body = await readJson(req);
        sendJson(res, 201, addDecision(db, decMatch[1], body));
        return;
      }
      const cmpMatch = path.match(/^\/v1\/competitions\/([^/]+)\/compare$/);
      if (method === "GET" && cmpMatch) {
        sendJson(res, 200, comparePlans(db, cmpMatch[1]));
        return;
      }

      // --- 效果 ---
      if (method === "POST" && path === "/v1/effects/derive") {
        const body = await readJson(req);
        sendJson(res, 201, deriveEffects(db, { factId: body.fact_id ?? null }));
        return;
      }
      if (method === "GET" && path === "/v1/effects") {
        sendJson(res, 200, {
          effects: listEffects(db, {
            competition_id: url.searchParams.get("competition_id") ?? undefined,
            event_code: url.searchParams.get("event_code") ?? undefined,
            subject_ref: url.searchParams.get("subject_ref") ?? undefined,
            effect_type: url.searchParams.get("effect_type") ?? undefined,
          }),
        });
        return;
      }
      if (method === "GET" && path === "/v1/effects/summary") {
        sendJson(res, 200, effectSummary(db, { competition_id: url.searchParams.get("competition_id") ?? undefined }));
        return;
      }
      const ledgerMatch = path.match(/^\/v1\/pairings\/([^/]+)\/ledger$/);
      if (method === "GET" && ledgerMatch) {
        const ledger = getPartnershipLedger(db, ledgerMatch[1]);
        if (!ledger) sendJson(res, 404, { error: { code: "NOT_FOUND", message: `组合 ${ledgerMatch[1]} 尚无共同参赛记录` } });
        else sendJson(res, 200, ledger);
        return;
      }

      // --- 运动员追溯 ---
      const tlMatch = path.match(/^\/v1\/athletes\/([^/]+)\/timeline$/);
      if (method === "GET" && tlMatch) {
        sendJson(res, 200, athleteTimeline(db, tlMatch[1]));
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `无此路由：${method} ${path}` } });
    } catch (err) {
      sendError(res, err);
    }
  });
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`赛历负荷决策台监听 :${port}`);
  });
}
