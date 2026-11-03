import "server-only";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scheduler } from "tesseract.js";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import { getConfig } from "@/server/config";

export type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Reads the text in one page image (PNG). */
export interface OcrEngine {
  /** How many pages can be recognized at the same time. */
  readonly concurrency: number;
  recognize(png: Buffer): Promise<string>;
}

/** Render size for OCR: scale 2 is about 144 dpi for a typical page, a good speed/accuracy trade-off. */
const RENDER_SCALE = 2;
/** The worker pool is shut down after this long without OCR work, which frees its memory. */
const IDLE_MS = 60_000;

interface PoolState {
  active: number;
  scheduler?: Promise<Scheduler>;
  timer?: NodeJS.Timeout;
}

// Shared across hot reloads and requests: starting a worker costs seconds and ~100+ MB.
const g = globalThis as typeof globalThis & { __kbOcrPool?: PoolState };
const pool: PoolState = (g.__kbOcrPool ??= { active: 0 });

let testEngine: OcrEngine | null = null;
/** Test hook: use a fake recognizer instead of Tesseract (pass null to restore the real one). */
export function setOcrEngineForTests(engine: OcrEngine | null): void {
  testEngine = engine;
}

function workerCount(): number {
  const configured = getConfig().OCR_WORKERS;
  if (configured) return configured;
  return Math.min(4, Math.max(1, os.availableParallelism() - 1));
}

async function startScheduler(): Promise<Scheduler> {
  const config = getConfig();
  // Language data downloads once on first use and is cached next to the embedding model.
  const cachePath = path.join(config.DATA_DIR, "models", "tessdata");
  mkdirSync(cachePath, { recursive: true });
  const { createScheduler, createWorker } = await import("tesseract.js");
  const scheduler = createScheduler();
  try {
    // One at a time, so the first worker fills the cache and the others read from it.
    for (let i = 0; i < workerCount(); i++) {
      scheduler.addWorker(await createWorker(config.OCR_LANGUAGES, 1, { cachePath }));
    }
  } catch (err) {
    await scheduler.terminate().catch(() => undefined);
    throw err;
  }
  return scheduler;
}

async function withEngine<T>(fn: (engine: OcrEngine) => Promise<T>): Promise<T> {
  if (testEngine) return fn(testEngine);

  pool.active++;
  if (pool.timer) clearTimeout(pool.timer);
  try {
    pool.scheduler ??= startScheduler().catch((err) => {
      pool.scheduler = undefined; // let the next upload try again (e.g. after the network is back)
      throw err;
    });
    const scheduler = await pool.scheduler;
    return await fn({
      concurrency: workerCount(),
      recognize: async (png) => (await scheduler.addJob("recognize", png)).data.text,
    });
  } finally {
    if (--pool.active === 0) {
      pool.timer = setTimeout(() => {
        const idle = pool.scheduler;
        pool.scheduler = undefined;
        void idle?.then((s) => s.terminate()).catch(() => undefined);
      }, IDLE_MS);
      pool.timer.unref();
    }
  }
}

/**
 * OCRs the given 1-based pages of a PDF: each page is rendered to an image and read by Tesseract.
 * Pages are rendered one after another while earlier pages are being recognized in parallel.
 * Returns the raw text per page (possibly empty for blank pages).
 */
export async function ocrPdfPages(pdf: PdfProxy, pageNumbers: number[]): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (pageNumbers.length === 0) return results;

  await withEngine(async (engine) => {
    const inFlight = new Set<Promise<void>>();
    let failure: unknown;

    for (const pageNumber of pageNumbers) {
      if (failure) break;
      const image = Buffer.from(
        await renderPageAsImage(pdf, pageNumber, { canvasImport: () => import("@napi-rs/canvas"), scale: RENDER_SCALE }),
      );
      const job: Promise<void> = engine.recognize(image).then(
        (text) => void results.set(pageNumber, text),
        (err) => void (failure ??= err),
      );
      const tracked: Promise<void> = job.finally(() => void inFlight.delete(tracked));
      inFlight.add(tracked);
      // Keep at most one page queued per worker, so memory stays flat on long documents.
      if (inFlight.size > engine.concurrency) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    if (failure) throw failure;
  });
  return results;
}
