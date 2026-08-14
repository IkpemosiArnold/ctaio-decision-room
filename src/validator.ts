import type { Claim, DecisionCard, Source, ValidatedCard, ValidationIssue, Verdict } from "./types.js";

/**
 * Deterministic gate. Code, not a model. A model cannot be the last thing standing
 * between an unsupported claim and a published brief, because the same failure that
 * produced the claim can produce its approval.
 *
 * Design rule learned the hard way (see AUTOPSY.md): a check that reads a field the
 * model chose to populate is not a backstop, it is a second opinion from the same
 * source. Anything load-bearing here is computed from the source text or the card
 * text directly, and the model's self-reported flags are treated as extra evidence
 * on top, never as the only trigger.
 */

/** Present and past tense, because "fell" and "cuts" upgrade a projection just as well as "reduced". */
const ACHIEVED =
  /\b(reduced|reduces|cut|cuts|fell|falls|dropped|drops|halved|halves|slashed|slashes|lowered|lowers|eliminated|eliminates|increased|increases|improved|improves|delivered|delivers|achieved|achieves|proved|proven|resulted in|drove)\b/i;
const HEDGE =
  /\b(may|might|could|projected|projection|expected|plans to|forecast|estimated|anticipat\w*|on track to|aims to)\b/i;
const MEASURABLE =
  /\b(rate|rates|time|times|latency|count|counts|percent|percentage|number of|score|scores|volume|frequency|duration|throughput|per\b)\b|%/i;

/**
 * Instructions aimed at an automated reader. Matched against the SOURCE TEXT by code,
 * so a source that talks the Skeptic out of flagging itself is still blocked.
 */
const INJECTION =
  /\b(ignore\s+(the\s+)?(previous|prior|above|all)\s+instructions?|disregard\s+(the\s+)?(previous|prior|above)|you\s+are\s+now\s+|system\s+prompt|do\s+not\s+mention|without\s+human\s+review|set\s+every\s+confidence|mark\s+all\s+claims\s+as)\b/i;

export function sourceCarriesInjection(text: string): boolean {
  return INJECTION.test(text);
}

/**
 * Returns the first achieved-tense verb that is NOT governed by a hedge, or null.
 *
 * A whole-string hedge test is too weak: "reduced spend, and may cut more" passes it while
 * asserting the projection as done. A bare ACHIEVED test is too strong: "projected to cut"
 * is the source's own faithful wording and contains "cut". So each verb is judged by the
 * clause it sits in, using the text immediately before it.
 */
export function bareAchievedVerb(text: string): string | null {
  const re = new RegExp(ACHIEVED.source, "gi");
  for (const m of text.matchAll(re)) {
    const window = text.slice(Math.max(0, m.index - 45), m.index);
    if (!HEDGE.test(window)) return m[0];
  }
  return null;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
/** No zero filter. "0 incidents" is as inventable as any other figure. */
const numbers = (s: string) => s.match(/\d+(?:\.\d+)?/g) ?? [];

export function validateCard(
  card: DecisionCard,
  claims: Claim[],
  verdicts: Verdict[],
  sources: Source[],
): ValidatedCard {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, detail: string) => issues.push({ code, detail });

  // 0. Identity. Duplicate ids would silently bind a card to the wrong claim.
  if (claims.filter((c) => c.claimId === card.claimId).length > 1) {
    fail("ambiguous_claim_id", `claimId ${card.claimId} is not unique in the ledger`);
  }
  if (verdicts.filter((v) => v.claimId === card.claimId).length > 1) {
    fail("ambiguous_claim_id", `claimId ${card.claimId} has more than one verdict`);
  }

  const claim = claims.find((c) => c.claimId === card.claimId);
  const verdict = verdicts.find((v) => v.claimId === card.claimId);

  // 1. Provenance. A card with no traceable claim is an invention.
  if (!claim || !verdict) {
    fail("no_matching_claim", `claimId ${card.claimId} does not match any extracted claim`);
    return { card, status: "rejected", issues };
  }
  const source = sources.find((s) => s.sourceId === claim.sourceId);
  if (!claim.sourceUrl.trim()) fail("no_evidence_url", "claim carries no source URL");

  // 2. Citation integrity. The quoted evidence must exist verbatim in the source.
  if (!source) fail("no_source", `source ${claim.sourceId} not found`);
  else if (!normalize(source.text).includes(normalize(claim.evidence))) {
    fail("evidence_not_in_source", `evidence excerpt is not a verbatim substring of ${claim.sourceId}`);
  }

  /**
   * 3. Prompt injection, decided in code from the source text, per SOURCE and not per claim.
   * If a source contains instructions aimed at an automated reader, nothing derived from that
   * source publishes, including sibling claims the Skeptic did not flag. This holds whether or
   * not any model noticed, which is the only version of this check worth having.
   */
  if (source && sourceCarriesInjection(source.text)) {
    fail("source_carries_injected_instructions", `${claim.sourceId} contains instructions aimed at an automated reader`);
  }
  if (verdict.failureModes.includes("prompt_injection_in_source")) {
    fail("unhandled_high_risk_flag", "skeptic flagged the source for prompt injection");
  }

  // 4. The Skeptic's verdict binds. Only supported claims may be published.
  if (verdict.status !== "supported") fail("claim_not_supported", `skeptic status is ${verdict.status}`);

  /**
   * 5. Vendor marketing can never ground a decision. Caught in run_014: the Skeptic marked a
   * vendor's "10x faster" claim `supported` because the source really does say it, while
   * labelling it `marketing`. "The evidence carries this wording" is not "this is a basis for
   * a decision", so status, label and failure modes are each independently blocking.
   */
  if (verdict.correctedLabel === "marketing") {
    fail("marketing_as_decision_basis", "a vendor's claim about its own product cannot ground a decision");
  }
  if (verdict.failureModes.includes("vendor_marketing_as_independent_evidence")) {
    fail("unhandled_high_risk_flag", "vendor marketing presented as independent evidence");
  }
  if (verdict.failureModes.includes("number_missing_denominator_or_timeframe")) {
    fail("unhandled_high_risk_flag", "figure has no denominator or timeframe");
  }

  // 6. No inference presented as fact. Requires an explicit limit, not just any hedge token.
  if (verdict.correctedLabel !== "fact" && !HEDGE.test(card.evidenceStatus) && !/\bnot\b|\bno\b/i.test(card.evidenceStatus)) {
    fail("inference_as_fact", `claim is ${verdict.correctedLabel} but evidenceStatus states it unqualified`);
  }

  /**
   * 7. Citation drift. If the evidence is hedged, no narrative field may state the thing as done.
   * Deliberately does NOT exempt a card that also contains a hedge word: "reduced spend, and may
   * cut more" would otherwise smuggle the upgrade past on the strength of one token.
   */
  if (HEDGE.test(claim.evidence)) {
    for (const [field, text] of [
      ["signal", card.signal],
      ["decision", card.decision],
      ["evidenceStatus", card.evidenceStatus],
    ] as const) {
      const bare = bareAchievedVerb(text);
      if (bare) {
        fail("epistemic_upgrade", `evidence is hedged but ${field} states "${bare}" as achieved`);
      }
    }
  }

  // 8. Ownership and measurability.
  if (!card.owner.trim() || /^(tbd|n\/?a|unknown|someone|the team)$/i.test(card.owner.trim())) {
    fail("no_owner", "card has no named decision owner");
  }
  if (!card.successMetrics.some((m) => MEASURABLE.test(m))) {
    fail("no_measurable_metric", "no success metric names a rate, time, count or percentage");
  }

  /**
   * 9. Unsupported numbers, checked on the evidentiary fields only. `decision` is exempt on
   * purpose: the Operator is told to prefer a bounded pilot, and a bound has to name a figure
   * ("30 days", "2 services") that by definition is not in the evidence. Scoping this rule to
   * the fields that describe what the evidence shows avoids rejecting every card that follows
   * the instruction, while still blocking invented findings.
   */
  const allowed = new Set(numbers(claim.evidence));
  const invented = [...numbers(card.signal), ...numbers(card.evidenceStatus)].filter((n) => !allowed.has(n));
  if (invented.length) fail("unsupported_number", `figures not present in the evidence: ${invented.join(", ")}`);

  // 10. Irreversible action always needs a human, it can never stand as a published recommendation.
  if (!card.reversible) fail("irreversible_without_human_approval", "card recommends a hard-to-reverse action");

  return { card, status: issues.length ? "rejected" : "publishable", issues };
}
