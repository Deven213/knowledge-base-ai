import type { Server } from "node:http";

export const FAKE_KEY_PREFIX: string;
export const FAKE_API_KEY: string;
export const MOCK_REMARK: string;
export const TRANSCRIPT_RESPONSE: {
  segments: { speaker: string; text: string; language: string; uncertain: boolean }[];
  remarks: string[];
  audioQuality: string;
};
export const NOTE_RESPONSE: {
  sections: { key: string; items: { text: string; origin: string; evidence: number[]; quote: string }[] }[];
  flags: unknown[];
};

export interface MockRequestRecord {
  seq: number;
  kind: string;
  [field: string]: unknown;
}

export interface FakeGemini {
  server: Server;
  port: number;
  url: string;
  requests(): MockRequestRecord[];
  close(): Promise<void>;
}

export interface FakeGeminiOptions {
  port?: number;
  logFile?: string;
  failFirst?: boolean;
  token?: string;
  onShutdown?: () => void;
}

export function startFakeGemini(options?: FakeGeminiOptions): Promise<FakeGemini>;
