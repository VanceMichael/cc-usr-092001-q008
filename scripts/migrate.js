import { openDatabase } from "../src/db.js";

const databasePath = process.env.DATABASE_PATH ?? new URL("../data/app.sqlite3", import.meta.url).pathname;
const db = openDatabase(databasePath);
const version = db.prepare("SELECT value FROM service_meta WHERE key = 'schema_version'").get().value;
db.close();
console.log(`数据库初始化完成：${databasePath}（schema_version=${version}）`);
