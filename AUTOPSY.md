# Failure autopsy: "supported" was doing two jobs

Caught in `run_014`, the first end-to-end run against real model output, not invented for the writeup.

## What happened

The vendor-marketing sentinel is an announcement in which Orchestryx claims its platform delivers
"up to 10x faster incident resolution", with no workload mix, no baseline, no incident count and no
measurement period. Nothing from that figure should ever reach an executive brief.

The Skeptic did its job. It returned:

```
src_vendor_benchmark_c2  supported  | label: marketing | modes: ["number_missing_denominator_or_timeframe"]
```

The Operator then wrote a decision card on it, and the deterministic validator passed the card as
publishable. Two of the three sentinel assertions failed:

```
FAIL  sentinel 2 > publishes nothing from the vendor's own benchmark
      expected length 0, got 4
```

## The assumption that was wrong

I had built the validator to reject on the Skeptic's `failureModes` array, and treated
`status: "supported"` as meaning "safe to build a decision on".

It does not. `supported` was silently doing two different jobs:

1. the quoted evidence carries this claim as worded, and
2. this claim is a sound basis for a decision.

For a vendor's own marketing, (1) is true and (2) is false. The source really does say "10x". The
Skeptic recorded the problem accurately, but it put it in `correctedLabel: "marketing"` rather than in
the `failureModes` array my validator was reading. Both are defensible readings of the schema, which
is exactly why the gate cannot depend on which field a model chooses to use.

## How it was detected

The sentinel test, not the output. The four published cards read plausibly. One of them was even
correct reporting ("SOC 2 aligned" is not SOC 2 certified). Reviewing the brief by eye, I would have
approved it. Only the fixture that recorded what *should* happen caught it.

## The repair

In [src/validator.ts](src/validator.ts), in code rather than in a prompt:

- a claim whose corrected label is `marketing` can never ground a decision card, whatever its status
- `number_missing_denominator_or_timeframe` is treated as an unhandled high-risk flag

I also narrowed the test. The original assertion, "publish nothing from this source", was wrong in the
other direction: the article contains sound journalism about the vendor that a CIO should receive.
The test now asserts the precise thing that must not happen, that no card rests on a marketing-labelled
claim, carries the self-reported figure, or repeats a number that lost its denominator.

## What now prevents it

The validator no longer trusts any single field of the Skeptic's verdict as the safety signal. Status,
label and failure modes are each independently blocking. The tests assert on interception outcomes
rather than on wording, so a future prompt change that re-introduces the bug fails the suite instead of
producing a differently-worded brief that still passes.

## What this cost, and the general lesson

The bug lived in the gap between two agents that both behaved correctly. Neither the Skeptic's output
nor the Operator's output is wrong in isolation. The defect is in the contract between them, and it was
only visible in the run trace, where you can see a claim keep its `claimId` while changing meaning as
it crosses a stage boundary. That is the argument for stable claim IDs and per-stage structured output:
without them there is nothing to diff, and the failure looks like a wording problem instead of a
contract problem.
