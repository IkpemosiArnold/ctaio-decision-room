import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scout, skeptic, operator } from "./agents.js";
import { validateCard } from "./validator.js";
import type { Backend } from "./model.js";
import type { Claim, Run, Source, TraceEvent, ValidatedCard, Verdict } from "./types.js";

export async function runPipeline(
  sources: Source[],
  opts: { runId: string; backend?: Backend; startedAt?: string } ,
): Promise<Run> {
  const trace: TraceEvent[] = [];
  let clock = 0;
  const log = (event: string, detail?: Record<string, unknown>) => trace.push({ at: clock++, event, detail });

  const claims: Claim[] = [];
  const verdicts: Verdict[] = [];
  const retries: Record<string, number> = {};

  log("source_received", { count: sources.length, ids: sources.map((s) => s.sourceId) });

  for (const source of sources) {
    const s = await scout(source, opts.backend);
    retries[`scout_${source.sourceId}`] = s.attempts - 1;
    claims.push(...s.claims);
    log("scout_completed", { sourceId: source.sourceId, claims: s.claims.length });

    const k = await skeptic(source, s.claims, opts.backend);
    retries[`skeptic_${source.sourceId}`] = k.attempts - 1;
    verdicts.push(...k.verdicts);
    log("skeptic_completed", { sourceId: source.sourceId, verdicts: k.verdicts.length });
  }

  log("claims_extracted", { count: claims.length });
  const rejected = verdicts.filter((v) => v.status === "unsupported").length;
  const review = verdicts.filter((v) => v.status === "needs_human_review").length;
  log("skeptic_rejected", { count: rejected });
  log("human_review_required", { count: review });

  const op = await operator(claims, verdicts, opts.backend);
  retries["operator"] = Math.max(0, op.attempts - 1);
  log("operator_created_cards", { count: op.cards.length });

  const cards: ValidatedCard[] = op.cards.map((c) => validateCard(c, claims, verdicts, sources));
  const validatorRejected = cards.filter((c) => c.status === "rejected");
  log("validator_rejected", { count: validatorRejected.length, codes: validatorRejected.flatMap((c) => c.issues.map((i) => i.code)) });

  const publishable = cards.filter((c) => c.status === "publishable").length;
  log(publishable ? "awaiting_editor_approval" : "nothing_publishable", { publishable });

  const supported = verdicts.filter((v) => v.status === "supported").length;
  const citedCards = cards.filter((c) => claims.some((cl) => cl.claimId === c.card.claimId)).length;

  const run: Run = {
    runId: opts.runId,
    startedAt: opts.startedAt ?? "recorded",
    sources: sources.map((s) => ({ sourceId: s.sourceId, url: s.url, title: s.title })),
    claims,
    verdicts,
    cards,
    trace,
    metrics: {
      claims_extracted: claims.length,
      claims_supported: supported,
      claims_rejected: rejected,
      claims_needing_human_review: review,
      unsupported_rejection_rate: verdicts.length ? +(rejected / verdicts.length).toFixed(3) : 0,
      human_review_rate: verdicts.length ? +(review / verdicts.length).toFixed(3) : 0,
      cards_created: op.cards.length,
      cards_publishable: publishable,
      cards_rejected_by_validator: validatorRejected.length,
      citations_lost_between_stages: op.cards.length - citedCards,
      total_retries: Object.values(retries).reduce((a, b) => a + b, 0),
    },
    status: publishable ? "awaiting_editor_approval" : "nothing_publishable",
  };
  return run;
}

export function saveRun(run: Run) {
  mkdirSync(join(process.cwd(), "runs"), { recursive: true });
  writeFileSync(join(process.cwd(), "runs", `${run.runId}.json`), JSON.stringify(run, null, 2));
}

export function renderTrace(run: Run): string {
  const lines = run.trace.map((e) => {
    const n = e.detail && "count" in e.detail ? `_${e.detail.count}` : "";
    return `${e.event}${n}`;
  });
  return [run.runId, ...lines.map((l, i) => `${i === lines.length - 1 ? "└──" : "├──"} ${l}`)].join("\n");
}

export function renderCard(v: ValidatedCard): string {
  const c = v.card;
  return `DECISION CARD  [${v.status.toUpperCase()}]  ${c.claimId}

Signal:
${c.signal}

Evidence status:
${c.evidenceStatus}

Relevant leaders:
${c.relevantRoles.join(", ")}

Decision:
${c.decision}

Owner:
${c.owner}

Success metrics:
${c.successMetrics.join(", ")}

Authority boundary:
${c.authorityBoundary}

Escalate when:
${c.escalateWhen}
${v.issues.length ? `\nValidator issues:\n${v.issues.map((i) => `  - ${i.code}: ${i.detail}`).join("\n")}` : ""}`;
}
