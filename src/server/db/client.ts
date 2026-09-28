import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../config";
import { migrate } from "./migrate";

// Survive Next.js dev hot-reloads without opening a new connection each time.
const globalForDb = globalThis as unknown as { __kbDb?: Database.Database };

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

// A connection kept across dev hot-reloads may predate newly added migrations: apply them once per module load.
let migratedThisLoad = false;

export function getDb(): Database.Database {
  if (!globalForDb.__kbDb) {
    const { DATA_DIR } = getConfig();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    globalForDb.__kbDb = openDatabase(path.join(DATA_DIR, "kb.sqlite"));
  } else if (!migratedThisLoad) {
    migrate(globalForDb.__kbDb);
  }
  migratedThisLoad = true;
  return globalForDb.__kbDb;
}
