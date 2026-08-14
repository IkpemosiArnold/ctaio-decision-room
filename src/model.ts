import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";

const run = promisify(execFile);
const CASSETTE_DIR = join(process.cwd(), "cassettes");

/**
 * Three backends behind one interface:
 *   replay  - read a recorded response from a cassette. No network, deterministic, used by tests and the demo.
 *   cli     - shell out to the locally authenticated `claude` CLI. Used to record cassettes.
 *   api     - Anthropic API, used when ANTHROPIC_API_KEY is set.
 * Recording is on whenever the backend is not replay, so every real call becomes a fixture.
 */
export type Backend = "replay" | "cli" | "api";

export function defaultBackend(): Backend {
  if (process.env.DECISION_ROOM_BACKEND) return process.env.DECISION_ROOM_BACKEND as Backend;
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return "replay";
}

const MODEL = process.env.DECISION_ROOM_MODEL ?? "claude-sonnet-5";
const MAX_ATTEMPTS = 3; // bounded retries, never an open loop

function key(agent: string, prompt: string) {
  return `${agent}-${createHash("sha256").update(MODEL + "\n" + prompt).digest("hex").slice(0, 16)}`;
}

function readCassette(k: string): string | null {
  const p = join(CASSETTE_DIR, `${k}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).response : null;
}

function writeCassette(k: string, agent: string, prompt: string, response: string) {
  mkdirSync(CASSETTE_DIR, { recursive: true });
  writeFileSync(join(CASSETTE_DIR, `${k}.json`), JSON.stringify({ agent, model: MODEL, prompt, response }, null, 2));
}

/** Models wrap JSON in prose and fences often enough that this has to be defensive. */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

async function callBackend(backend: Backend, prompt: string): Promise<string> {
  if (backend === "cli") {
    const { stdout } = await run("claude", ["-p", prompt, "--max-turns", "1"], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000,
    });
    return stdout;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic api ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { content: { type: string; text?: string }[] };
  return json.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

export type CallResult<T> = { value: T; attempts: number; fromCassette: boolean };

/**
 * One model call, forced through a Zod schema. Retries are bounded and the retry
 * prompt carries the validation error so the second attempt is informed, not a coin flip.
 */
export async function callStructured<T>(
  agent: string,
  prompt: string,
  schema: ZodType<T>,
  backend: Backend = defaultBackend(),
): Promise<CallResult<T>> {
  const cached = readCassette(key(agent, prompt));
  if (cached !== null) return { value: schema.parse(extractJson(cached)), attempts: 1, fromCassette: true };
  if (backend === "replay") {
    throw new Error(
      `no cassette for ${agent} (${key(agent, prompt)}). Record one with: npm run record`,
    );
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\nYour previous reply was rejected: ${lastError}\nReturn corrected JSON only.`;
    try {
      const raw = await callBackend(backend, attemptPrompt);
      const value = schema.parse(extractJson(raw));
      writeCassette(key(agent, prompt), agent, prompt, raw); // key on the ORIGINAL prompt so replay hits
      return { value, attempts: attempt, fromCassette: false };
    } catch (err) {
      lastError = String(err).slice(0, 800);
    }
  }
  throw new Error(`${agent} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
