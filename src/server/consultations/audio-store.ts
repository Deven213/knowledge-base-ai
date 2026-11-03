import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config";

// Where recordings live. The store is deliberately dumb: it holds opaque bytes under opaque keys. Everything it receives has
// ALREADY been sealed by the application (security/vault.ts), so whoever runs the storage, whether a folder on this server now
// or a cloud bucket later, only ever holds ciphertext, and the keys carry no organization, patient or consultation name.
//
// The folder is private to this server process: nothing serves it over HTTP and no URL to it exists. The only way audio leaves
// is GET /api/consultations/[id]/audio, which checks the signed-in doctor owns the consultation, opens the sealed parts and is
// audited. A cloud driver (S3-compatible, Google Cloud Storage, Azure Blob) would implement this same interface.

export interface AudioStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Removes one object; removing something that is not there is not an error (so a retried deletion is safe). */
  delete(key: string): Promise<void>;
  /** Removes every object whose key starts with `prefix/`; returns how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
  /** Every recording folder in the store with when it was last written, so storage nothing refers to any more can be found and removed. */
  listFolders(): Promise<{ name: string; modifiedAt: number }[]>;
}

/** A recording's folder name in the store: random, so it can't be guessed and says nothing about who it belongs to. */
export const newStorageKey = () => randomUUID().replaceAll("-", "");
export const partKey = (storageKey: string, part: number) => `${storageKey}/part-${String(part).padStart(6, "0")}`;

const KEY = /^[a-f0-9]{32}\/part-\d{6}$/;
const PREFIX = /^[a-f0-9]{32}$/;

export class LocalAudioStore implements AudioStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolves a key to a file inside the root, refusing anything that is not exactly the shape this store writes. */
  private fileFor(key: string): string {
    if (!KEY.test(key)) throw new Error("Invalid audio object key.");
    const file = path.resolve(this.root, key);
    if (!file.startsWith(this.root + path.sep)) throw new Error("Invalid audio object key.");
    return file;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.fileFor(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write beside the final name and rename, so a crash never leaves a half-written part that looks complete.
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFileSync(this.fileFor(key));
  }

  async delete(key: string): Promise<void> {
    fs.rmSync(this.fileFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!PREFIX.test(prefix)) throw new Error("Invalid audio folder.");
    const dir = path.resolve(this.root, prefix);
    if (!dir.startsWith(this.root + path.sep) || !fs.existsSync(dir)) return 0;
    const count = fs.readdirSync(dir).length;
    fs.rmSync(dir, { recursive: true, force: true });
    return count;
  }

  async listFolders(): Promise<{ name: string; modifiedAt: number }[]> {
    if (!fs.existsSync(this.root)) return [];
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PREFIX.test(e.name))
      .map((e) => ({ name: e.name, modifiedAt: fs.statSync(path.join(this.root, e.name)).mtimeMs }));
  }
}

let cached: { dir: string; store: AudioStore } | undefined;

/** The audio store for this deployment. */
export function getAudioStore(config: Pick<AppConfig, "DATA_DIR" | "CONSULTATIONS_AUDIO_DIR">): AudioStore {
  const dir = config.CONSULTATIONS_AUDIO_DIR ?? path.join(config.DATA_DIR, "consultation-audio");
  if (!cached || cached.dir !== dir) cached = { dir, store: new LocalAudioStore(dir) };
  return cached.store;
}
