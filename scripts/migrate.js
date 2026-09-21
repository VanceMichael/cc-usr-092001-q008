import { openDb } from "../src/db.js";

const databasePath = process.env.DATABASE_PATH ?? null;
const db = openDb(databasePath);
const row = db
  .prepare("SELECT value FROM service_meta WHERE key = 'schema_version'")
  .get();
db.close();
console.log(
  `数据库初始化完成：${databasePath ?? "data/app.sqlite3"}（schema_version=${row?.value ?? "unknown"}）`
);
