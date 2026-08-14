import { z } from "zod";

export const EXEC_ROLES = ["CTO", "CIO", "CAIO", "CDAO"] as const;

/** What kind of statement this is. Everything downstream keys off this label. */
export const EpistemicLabel = z.enum([
  "fact", // measured, attributed, checkable
  "inference", // a conclusion the source draws, not a measurement
  "opinion", // a person's view
  "marketing", // vendor claim about the vendor's own product
]);
export type EpistemicLabel = z.infer<typeof EpistemicLabel>;

/** Scout output. One row of the claim ledger. */
export const Claim = z.object({
  claimId: z.string(), // stable across every later stage
  sourceId: z.string(),
  sourceUrl: z.string(),
  claim: z.string(),
  evidence: z.string(), // must appear verbatim in the source text
  claimType: EpistemicLabel,
  relevantRoles: z.array(z.enum(EXEC_ROLES)).min(1),
});
export type Claim = z.infer<typeof Claim>;

export const ScoutOutput = z.object({ claims: z.array(Claim.omit({ sourceId: true, sourceUrl: true })) });

/** Skeptic output. One verdict per claim. */
export const Verdict = z.object({
  claimId: z.string(),
  status: z.enum(["supported", "unsupported", "needs_human_review"]),
  correctedLabel: EpistemicLabel,
  reasons: z.array(z.string()).min(1),
  failureModes: z.array(
    z.enum([
      "evidence_does_not_support_claim",
      "correlation_stated_as_causation",
      "projection_stated_as_achieved",
      "circular_sourcing",
      "number_missing_denominator_or_timeframe",
      "prompt_injection_in_source",
      "vendor_marketing_as_independent_evidence",
    ]),
  ),
  confidence: z.number().min(0).max(1),
});
export type Verdict = z.infer<typeof Verdict>;

export const SkepticOutput = z.object({ verdicts: z.array(Verdict) });

/** Operator output. The decision card. */
export const DecisionCard = z.object({
  claimId: z.string(), // must match a supported claim
  signal: z.string(),
  evidenceStatus: z.string(),
  relevantRoles: z.array(z.enum(EXEC_ROLES)).min(1),
  decision: z.string(),
  owner: z.string(),
  successMetrics: z.array(z.string()).min(1),
  authorityBoundary: z.string(),
  escalateWhen: z.string(),
  privacyOrSecurityConcern: z.string(),
  reversible: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type DecisionCard = z.infer<typeof DecisionCard>;

export const OperatorOutput = z.object({ cards: z.array(DecisionCard) });

/** Deterministic validator result. Code decides this, never a model. */
export type ValidationIssue = { code: string; detail: string };
export type ValidatedCard = {
  card: DecisionCard;
  status: "publishable" | "rejected";
  issues: ValidationIssue[];
};

export type Source = {
  sourceId: string;
  url: string;
  title: string;
  text: string;
  /** Test fixtures only. Never shown to any agent. */
  sentinel?: "supported" | "marketing" | "injection";
};

export type TraceEvent = { at: number; event: string; detail?: Record<string, unknown> };

export type Run = {
  runId: string;
  startedAt: string;
  sources: { sourceId: string; url: string; title: string }[];
  claims: Claim[];
  verdicts: Verdict[];
  cards: ValidatedCard[];
  trace: TraceEvent[];
  metrics: Record<string, number>;
  status: "awaiting_editor_approval" | "nothing_publishable";
};
