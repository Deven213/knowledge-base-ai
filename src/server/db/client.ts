import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../config";
import { migrate, MIGRATION_COUNT, schemaVersion } from "./migrate";

// Survive Next.js dev hot-reloads without opening a new connection each time.
const globalForDb = globalThis as unknown as { __kbDb?: Database.Database; __kbDbFile?: string };

/**
 * Before migrating a database that already holds data, writes a consistent copy next to it
 * (`kb.sqlite.pre-migration-v<from>-<time>.bak`). A migration can't be undone by code; restoring that
 * file is the rollback. Returns the backup's path, or null when nothing needed backing up (a new or
 * in-memory database, or one that is already up to date).
 */
export function backupBeforeMigration(db: Database.Database, filename: string): string | null {
  if (!filename || filename === ":memory:") return null;
  const current = schemaVersion(db);
  if (current === 0 || current >= MIGRATION_COUNT) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${filename}.pre-migration-v${current}-${stamp}.bak`;
  db.prepare("VACUUM INTO ?").run(target); // a consistent snapshot, safe while the database is open
  console.info(`[db] backed up the database before migrating v${current} → v${MIGRATION_COUNT}: ${path.basename(target)}`);
  return target;
}

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  backupBeforeMigration(db, filename);
  migrate(db);
  return db;
}

// A connection kept across dev hot-reloads may predate newly added migrations: apply them once per module load.
let migratedThisLoad = false;

export function getDb(): Database.Database {
  if (!globalForDb.__kbDb) {
    const { DATA_DIR } = getConfig();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, "kb.sqlite");
    globalForDb.__kbDb = openDatabase(file);
    globalForDb.__kbDbFile = file;
  } else if (!migratedThisLoad) {
    backupBeforeMigration(globalForDb.__kbDb, globalForDb.__kbDbFile ?? "");
    migrate(globalForDb.__kbDb);
  }
  migratedThisLoad = true;
  return globalForDb.__kbDb;
}
