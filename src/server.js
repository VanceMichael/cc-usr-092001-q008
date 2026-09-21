import http from "node:http";
import path from "node:path";

import {
  appendEvent,
  digestPayload,
  getEvent,
  listEvents,
  openDatabase,
  verifyIntegrity,
  nextSourceSequence,
} from "./db.js";
import { validateEnvelope } from "./events.js";
import {
  athleteTimeline,
  buildState,
  compareRosters,
  competitionResults,
  pairingProfile,
  resolveRuleVersion,
  validateRoster,
} from "./projection.js";

export function healthPayload() {
  return { status: "ok" };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 });
  }
}

function parseRoute(pathname) {
  // /rosters/{id}/validation 等简单模式匹配
  const parts = pathname.split("/").filter(Boolean);
  return parts;
}

/** 发送方若携带 payload_digest，必须与服务端规范摘要一致，防止传输中载荷被改动。 */
function digestErrors(envelope) {
  if (envelope.payload_digest === undefined || envelope.payload_digest === null) return [];
  if (typeof envelope.payload_digest !== "string" || !envelope.payload_digest.startsWith("sha256:")) {
    return ["payload_digest: 必须是 sha256: 前缀的字符串"];
  }
  const expected = digestPayload(envelope.payload);
  return envelope.payload_digest === expected ? [] : [`payload_digest: 与载荷重算摘要不一致（期望 ${expected}）`];
}

export function createServer(db) {
  const currentState = () => buildState(listEvents(db));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const parts = parseRoute(url.pathname);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, healthPayload());
        return;
      }

      if (request.method === "POST" && url.pathname === "/events") {
        const envelope = await readJsonBody(request);
        const errors = [...validateEnvelope(envelope), ...digestErrors(envelope)];
        if (errors.length > 0) {
          sendJson(response, 400, { error: "事件校验未通过", errors });
          return;
        }
        const result = appendEvent(db, envelope);
        sendJson(response, result.outcome === "appended" ? 201 : 200, result);
        return;
      }

      // 批量追加：全部成功才提交，任一冲突整体回滚，适合一次性导入一个选拔周期的材料。
      if (request.method === "POST" && url.pathname === "/events/batch") {
        const body = await readJsonBody(request);
        if (!Array.isArray(body?.events)) {
          sendJson(response, 400, { error: "字段 events 必须是事件数组" });
          return;
        }
        const outcomes = [];
        db.exec("BEGIN");
        try {
          for (const envelope of body.events) {
            const errors = [...validateEnvelope(envelope), ...digestErrors(envelope)];
            if (errors.length > 0) throw Object.assign(new Error("事件校验未通过"), { status: 400, errors });
            outcomes.push(appendEvent(db, envelope));
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          sendJson(response, error.status ?? 500, {
            error: error.message,
            errors: error.errors,
            existing: error.existing ?? null,
          });
          return;
        }
        sendJson(response, 201, {
          appended: outcomes.filter((outcome) => outcome.outcome === "appended").length,
          duplicated: outcomes.filter((outcome) => outcome.outcome === "duplicated").length,
        });
        return;
      }

      if (request.method === "GET" && (parts[0] === "events")) {
        let events = listEvents(db);
        if (parts[1]) events = events.filter((event) => event.event_id === parts[1]);
        if (url.searchParams.get("subject_ref")) {
          const subjectRef = url.searchParams.get("subject_ref");
          events = events.filter((event) => event.subject_ref === subjectRef);
        }
        if (parts[1] && events.length === 0) {
          sendJson(response, 404, { error: "事件不存在" });
          return;
        }
        sendJson(response, 200, { events });
        return;
      }

      if (request.method === "GET" && url.pathname === "/integrity") {
        sendJson(response, 200, verifyIntegrity(db));
        return;
      }

      if (request.method === "GET" && url.pathname === "/sources/next-sequence") {
        const source = url.searchParams.get("source");
        if (!source) {
          sendJson(response, 400, { error: "需要 source 查询参数" });
          return;
        }
        sendJson(response, 200, { source, next_source_sequence: nextSourceSequence(db, source) });
        return;
      }

      // 以下为只读投影视图，每次请求从事件流重算，不缓存可变结论。
      if (request.method === "GET" && parts[0] === "athletes" && parts[2] === "timeline") {
        const state = currentState();
        const timeline = athleteTimeline(state, parts[1]);
        if (!timeline) {
          sendJson(response, 404, { error: "运动员未登记" });
          return;
        }
        sendJson(response, 200, timeline);
        return;
      }

      if (request.method === "GET" && parts[0] === "pairings" && parts[2] === "profile") {
        const state = currentState();
        const profile = pairingProfile(state, parts[1]);
        if (!profile) {
          sendJson(response, 404, { error: "组合未登记" });
          return;
        }
        sendJson(response, 200, profile);
        return;
      }

      if (request.method === "GET" && parts[0] === "rosters" && parts.length === 1) {
        const state = currentState();
        const competitionId = url.searchParams.get("competition_id");
        const sport = url.searchParams.get("sport");
        const rows = [...state.rosters.values()]
          .filter((roster) => (!competitionId || roster.competition_id === competitionId))
          .filter((roster) => (!sport || roster.sport === sport))
          .map((roster) => ({
            roster_id: roster.roster_id,
            competition_id: roster.competition_id,
            sport: roster.sport,
            label: roster.label,
            created_at: roster.created_at,
            submitted_at: roster.submitted_at,
            entry_count: [...roster.entries.values()].filter((entry) => entry.removed_at === null).length,
            decisions: roster.decisions,
          }));
        sendJson(response, 200, { rosters: rows });
        return;
      }

      if (request.method === "GET" && parts[0] === "rosters" && parts[2] === "validation") {
        const state = currentState();
        const options = {};
        if (url.searchParams.get("as_of")) options.asOf = url.searchParams.get("as_of");
        const gapDays = url.searchParams.get("consecutive_gap_days");
        if (gapDays !== null) options.consecutiveGapDays = Number(gapDays);
        const report = validateRoster(state, parts[1], options);
        if (!report) {
          sendJson(response, 404, { error: "草案不存在" });
          return;
        }
        sendJson(response, 200, report);
        return;
      }

      if (request.method === "GET" && parts[0] === "competitions" && parts[2] === "compare") {
        const state = currentState();
        const report = compareRosters(state, parts[1]);
        if (!report) {
          sendJson(response, 404, { error: "比赛未登记" });
          return;
        }
        sendJson(response, 200, report);
        return;
      }

      if (request.method === "GET" && parts[0] === "competitions" && parts[2] === "results") {
        const state = currentState();
        if (!state.competitions.has(parts[1])) {
          sendJson(response, 404, { error: "比赛未登记" });
          return;
        }
        sendJson(response, 200, competitionResults(state, parts[1]));
        return;
      }

      if (request.method === "GET" && url.pathname === "/rules/effective") {        const sport = url.searchParams.get("sport");
        const at = url.searchParams.get("at") ?? new Date().toISOString();
        if (!sport) {
          sendJson(response, 400, { error: "需要 sport 查询参数" });
          return;
        }
        const state = currentState();
        const version = resolveRuleVersion(state, sport, at);
        if (!version) {
          sendJson(response, 404, { error: "该时刻没有已生效的规则版本", sport, at });
          return;
        }
        sendJson(response, 200, {
          rule_set_id: version.rule_set_id,
          sport: version.sport,
          version: version.version,
          effective_from: version.effective_from,
          entries: [...version.entries.values()].map((entry) => ({
            ...entry,
            compatible_with: [...entry.compatible_with],
          })),
        });
        return;
      }

      sendJson(response, 404, { error: "未知路径" });
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.message });
    }
  });

  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const databasePath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const db = openDatabase(databasePath);
  createServer(db).listen(port, "0.0.0.0", () => {
    console.log(`决策台服务监听 ${port}，数据库：${databasePath}`);
  });
}
