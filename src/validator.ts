import type { Claim, DecisionCard, Source, ValidatedCard, ValidationIssue, Verdict } from "./types.js";

/**
 * Deterministic gate. Code, not a model. A model cannot be the last thing standing
 * between an unsupported claim and a published brief, because the same failure that
 * produced the claim can produce the approval.
 */

const HEDGE = /\b(may|might|could|projected|projection|expected|plans to|is expected|forecast|estimated|anticipat\w*)\b/i;
const ACHIEVED = /\b(reduced|cut|eliminated|increased|delivered|achieved|proved|proven|resulted in|drove)\b/i;
const MEASURABLE = /(rate|time|latency|count|percent|%|per\s|number of|score|volume|frequency|duration)/i;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const numbers = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => Number(n) !== 0);

export function validateCard(
  card: DecisionCard,
  claims: Claim[],
  verdicts: Verdict[],
  sources: Source[],
): ValidatedCard {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, detail: string) => issues.push({ code, detail });

  const claim = claims.find((c) => c.claimId === card.claimId);
  const verdict = verdicts.find((v) => v.claimId === card.claimId);

  // 1. Provenance. A card with no traceable claim is an invention.
  if (!claim || !verdict) {
    fail("no_matching_claim", `claimId ${card.claimId} does not match any extracted claim`);
    return { card, status: "rejected", issues };
  }
  const source = sources.find((s) => s.sourceId === claim.sourceId);
  if (!claim.sourceUrl) fail("no_evidence_url", "claim carries no source URL");

  // 2. Citation integrity. The quoted evidence must exist verbatim in the source.
  if (!source) fail("no_source", `source ${claim.sourceId} not found`);
  else if (!normalize(source.text).includes(normalize(claim.evidence))) {
    fail("evidence_not_in_source", `evidence excerpt is not a verbatim substring of ${claim.sourceId}`);
  }

  // 3. The Skeptic's verdict binds. Only supported claims may be published.
  if (verdict.status !== "supported") {
    fail("claim_not_supported", `skeptic status is ${verdict.status}`);
  }
  if (verdict.failureModes.includes("prompt_injection_in_source")) {
    fail("unhandled_high_risk_flag", "source flagged for prompt injection");
  }
  if (verdict.failureModes.includes("vendor_marketing_as_independent_evidence")) {
    fail("unhandled_high_risk_flag", "vendor marketing presented as independent evidence");
  }
  /**
   * Caught in run_014. The Skeptic marked a vendor's "up to 10x faster" claim `supported`
   * because the source really does say it, while labelling it `marketing`. Both readings are
   * defensible, which is the point: "the evidence carries this wording" is not the same test as
   * "this is a basis for a decision". The label binds here in code, so the distinction cannot be
   * lost to a model's choice of field.
   */
  if (verdict.correctedLabel === "marketing") {
    fail("marketing_as_decision_basis", "a vendor's claim about its own product cannot ground a decision");
  }
  if (verdict.failureModes.includes("number_missing_denominator_or_timeframe")) {
    fail("unhandled_high_risk_flag", "figure has no denominator or timeframe");
  }

  // 4. No inference presented as fact.
  if (verdict.correctedLabel !== "fact" && !HEDGE.test(card.evidenceStatus) && !/not\b/i.test(card.evidenceStatus)) {
    fail("inference_as_fact", `claim is ${verdict.correctedLabel} but evidenceStatus states it unqualified`);
  }

  // 5. Citation drift. Hedged evidence cannot become achieved wording downstream.
  if (HEDGE.test(claim.evidence) && !HEDGE.test(card.signal) && ACHIEVED.test(card.signal)) {
    fail("epistemic_upgrade", `evidence is hedged but the signal states it as achieved: "${card.signal}"`);
  }

  // 6. Ownership and measurability.
  if (!card.owner.trim() || /^(tbd|n\/?a|unknown|someone)$/i.test(card.owner.trim())) {
    fail("no_owner", "card has no named decision owner");
  }
  if (!card.successMetrics.some((m) => MEASURABLE.test(m))) {
    fail("no_measurable_metric", "no success metric names a rate, time, count or percentage");
  }

  // 7. Unsupported numbers. Every figure in the card must come from the evidence.
  const allowed = new Set(numbers(claim.evidence));
  const invented = [...numbers(card.signal), ...numbers(card.decision)].filter((n) => !allowed.has(n));
  if (invented.length) fail("unsupported_number", `figures not present in the evidence: ${invented.join(", ")}`);

  // 8. Irreversible action always needs a human, it can never publish as a standing recommendation.
  if (!card.reversible) fail("irreversible_without_human_approval", "card recommends a hard-to-reverse action");

  return { card, status: issues.length ? "rejected" : "publishable", issues };
}
