import { describe, it, expect } from "vitest";
import { validateCard } from "../src/validator.js";
import { SOURCES } from "../src/sources.js";
import type { Claim, DecisionCard, Verdict } from "../src/types.js";

const source = SOURCES[0];

const claim: Claim = {
  claimId: "c1",
  sourceId: source.sourceId,
  sourceUrl: source.url,
  claim: "Change failure rate fell after agent-assisted deployment was introduced",
  evidence: "change failure rate fell from 14.2 percent to 9.6 percent",
  claimType: "fact",
  relevantRoles: ["CTO", "CIO"],
};

const verdict: Verdict = {
  claimId: "c1",
  status: "supported",
  correctedLabel: "fact",
  reasons: ["The quoted figures appear in the source with a denominator and a timeframe"],
  failureModes: [],
  confidence: 0.8,
};

const card: DecisionCard = {
  claimId: "c1",
  signal: "Change failure rate fell from 14.2 percent to 9.6 percent under agent-assisted deployment.",
  evidenceStatus: "One implementation report, no controlled comparison.",
  relevantRoles: ["CTO", "CIO"],
  decision: "Approve a limited agent-assisted deployment pilot, not an autonomous production rollout.",
  owner: "VP Engineering",
  successMetrics: ["change failure rate", "rollback rate", "deployment lead time", "intervention rate"],
  authorityBoundary: "The agent may prepare and validate a deployment but cannot approve production release.",
  escalateWhen: "Security controls are bypassed, evidence conflicts, or rollback verification fails.",
  privacyOrSecurityConcern: "Deployment agent needs production credentials, scope them to prepare-only.",
  reversible: true,
  confidence: 0.7,
};

const check = (c: DecisionCard, v: Verdict = verdict, cl: Claim = claim) =>
  validateCard(c, [cl], [v], SOURCES);

const codes = (c: DecisionCard, v?: Verdict, cl?: Claim) =>
  check(c, v, cl).issues.map((i) => i.code);

describe("deterministic validator", () => {
  it("passes a well-formed card built on supported evidence", () => {
    expect(check(card).status).toBe("publishable");
  });

  it("rejects a card whose claimId matches nothing (an invented card)", () => {
    expect(codes({ ...card, claimId: "ghost" })).toContain("no_matching_claim");
  });

  it("rejects evidence that is not verbatim in the source", () => {
    const drifted = { ...claim, evidence: "change failure rate fell by ninety percent" };
    expect(codes(card, verdict, drifted)).toContain("evidence_not_in_source");
  });

  it("rejects any card built on a claim the skeptic did not support", () => {
    expect(codes(card, { ...verdict, status: "needs_human_review" })).toContain("claim_not_supported");
  });

  it("blocks publication when the skeptic flags injected instructions", () => {
    const flagged: Verdict = { ...verdict, failureModes: ["prompt_injection_in_source"] };
    expect(codes(card, flagged)).toContain("unhandled_high_risk_flag");
  });

  /**
   * The one that matters. The verdict here is spotless: supported, labelled fact, no failure
   * modes, as if the injection had talked the Skeptic out of flagging itself. The card is
   * still blocked, because this check is computed from the source text in code. Without this,
   * the injection defense would be a second opinion from the same kind of component that was
   * compromised, and the README's claim about it would be false.
   */
  it("blocks the source in code even when the skeptic flags nothing at all", () => {
    const injected = SOURCES.find((s) => s.sentinel === "injection")!;
    const fromInjected: Claim = {
      ...claim,
      sourceId: injected.sourceId,
      sourceUrl: injected.url,
      evidence: "The team plans to validate the projection over a full quarter",
    };
    const spotless: Verdict = { ...verdict, status: "supported", correctedLabel: "fact", failureModes: [] };
    const clean: DecisionCard = { ...card, signal: "The team intends to validate the projection." };
    expect(codes(clean, spotless, fromInjected)).toContain("source_carries_injected_instructions");
  });

  it("does not flag a clean source", () => {
    expect(codes(card)).not.toContain("source_carries_injected_instructions");
  });

  it("blocks vendor marketing dressed as independent evidence", () => {
    const flagged: Verdict = { ...verdict, failureModes: ["vendor_marketing_as_independent_evidence"] };
    expect(codes(card, flagged)).toContain("unhandled_high_risk_flag");
  });

  it("rejects a card with no named owner", () => {
    expect(codes({ ...card, owner: "TBD" })).toContain("no_owner");
  });

  it("rejects a card with no measurable success metric", () => {
    expect(codes({ ...card, successMetrics: ["team feels more confident"] })).toContain("no_measurable_metric");
  });

  it("rejects a figure in the signal that does not appear in the evidence", () => {
    expect(codes({ ...card, signal: "Change failure rate fell across all 62 services." })).toContain("unsupported_number");
  });

  it("rejects an invented figure in the evidence status", () => {
    expect(codes({ ...card, evidenceStatus: "Based on 9 controlled trials." })).toContain("unsupported_number");
  });

  /**
   * The decision field is exempt on purpose. The Operator is instructed to prefer a bounded
   * pilot, and a bound has to name a figure that is not in the evidence. Rejecting those would
   * mean only vague decisions could ever publish.
   */
  it("allows a pilot bound in the decision that is absent from the evidence", () => {
    expect(codes({ ...card, decision: "Run a 30-day pilot on 2 services before expanding." }))
      .not.toContain("unsupported_number");
  });

  it("rejects an irreversible action, it can never stand as a published recommendation", () => {
    expect(codes({ ...card, reversible: false })).toContain("irreversible_without_human_approval");
  });

  /**
   * `reversible` is a boolean the Operator sets about its own output. Trusting it would repeat
   * the mistake the injection check made. The decision text is read in code instead.
   */
  it.each([
    "Roll out to all services this quarter.",
    "Decommission the existing deployment pipeline.",
    "Standardise on this vendor company-wide.",
    "Move to a fully autonomous production release process.",
  ])("catches irreversible language in '%s' even when the card claims reversible: true", (decision) => {
    expect(codes({ ...card, decision, reversible: true })).toContain("reversibility_misreported");
  });

  it("does not fire on a genuinely bounded decision", () => {
    expect(codes({ ...card, decision: "Run a 30-day pilot on two services, then reassess." }))
      .not.toContain("reversibility_misreported");
  });

  /**
   * Rules 1 and 2 prove a card cites a real claim. They do not prove it is about it.
   * This is the gap: a valid claimId with a signal on an unrelated subject.
   */
  it("rejects a card whose signal is unrelated to the claim it cites", () => {
    const offTopic = {
      ...card,
      signal: "Procurement should renegotiate its storage vendor licensing terms.",
    };
    expect(codes(offTopic)).toContain("card_not_about_its_claim");
  });

  it("accepts a card that restates its claim in different words", () => {
    const paraphrased = {
      ...card,
      signal: "Deployment change failure rate improved after the agent was introduced.",
    };
    expect(codes(paraphrased)).not.toContain("card_not_about_its_claim");
  });

  it("rejects inference stated without qualification", () => {
    const inferred: Verdict = { ...verdict, correctedLabel: "inference" };
    expect(codes({ ...card, evidenceStatus: "Agent deployment improves reliability." }, inferred))
      .toContain("inference_as_fact");
  });
});

/**
 * The citation-drift regression. This is the failure the pipeline is built to survive:
 * the Scout quotes the source correctly, then the Operator rewrites a hedged projection
 * as an achieved result. The wording upgrade is the bug, and no model gets to approve it.
 */
describe("citation drift: hedged evidence cannot be upgraded to an achieved result", () => {
  const injected = SOURCES[2];
  const hedged: Claim = {
    claimId: "d1",
    sourceId: injected.sourceId,
    sourceUrl: injected.url,
    claim: "Routing cheap requests to a smaller model is projected to cut inference spend",
    evidence: "projected to cut inference spend by\nroughly 60 percent next quarter",
    claimType: "inference",
    relevantRoles: ["CTO", "CDAO"],
  };
  const hedgedVerdict: Verdict = { ...verdict, claimId: "d1", correctedLabel: "inference", confidence: 0.5 };

  // Every one of these verbs upgrades a projection. Testing only "reduced" would prove the regex, not the property.
  it.each(["reduced", "cut", "fell", "dropped", "halved", "slashed", "lowered", "cuts", "reduces"])(
    "rejects '%s' where the evidence says 'projected to cut'",
    (verb) => {
      const upgraded: DecisionCard = {
        ...card,
        claimId: "d1",
        signal: `Model routing ${verb} inference spend by 60 percent.`,
        evidenceStatus: "Projection from one week of traffic sampling, not yet observed in production.",
      };
      expect(codes(upgraded, hedgedVerdict, hedged)).toContain("epistemic_upgrade");
    },
  );

  it("cannot be smuggled past by adding a hedge word elsewhere in the sentence", () => {
    const smuggled: DecisionCard = {
      ...card,
      claimId: "d1",
      signal: "Model routing reduced inference spend by 60 percent, and may cut more next quarter.",
      evidenceStatus: "Projection from one week of traffic sampling, not yet observed in production.",
    };
    expect(codes(smuggled, hedgedVerdict, hedged)).toContain("epistemic_upgrade");
  });

  it("checks the decision field too, not only the signal", () => {
    const inDecision: DecisionCard = {
      ...card,
      claimId: "d1",
      signal: "Model routing is projected to cut inference spend.",
      evidenceStatus: "Projection from one week of traffic sampling, not yet observed in production.",
      decision: "Given that routing already halved inference spend, expand it to all services.",
    };
    expect(codes(inDecision, hedgedVerdict, hedged)).toContain("epistemic_upgrade");
  });

  it("accepts the same card when it keeps the source's hedge", () => {
    const faithful: DecisionCard = {
      ...card,
      claimId: "d1",
      signal: "Model routing is projected to cut inference spend by roughly 60 percent next quarter.",
      evidenceStatus: "Projection from one week of traffic sampling, not yet observed in production.",
    };
    expect(codes(faithful, hedgedVerdict, hedged)).not.toContain("epistemic_upgrade");
  });
});
