# Jev decision gate

## What is implemented

`src/integrations/jev.ts` contains a direct TypeSafe HTTP adapter and a candidate
selection gate. QM is responsible for producing a small, typed candidate set.
Jev selects the next candidate or explicitly holds. This gate is intended to run
before dispatch or publication, rather than only checking prose after the fact.

The application must describe QM-only generation as a separate fallback mode.
A Jev error, missing credential, invalid answer, expired receipt, cancellation,
or changed snapshot never authorizes a candidate. Do not silently fall back to
QM's preferred candidate inside Jev mode.

## Verified upstream contract

The [official API reference](https://docs.typesafe.ai/api), checked September 27,
2026, specifies `POST https://api.typesafe.ai/v1/systemone` with Bearer auth.
Requests contain `model`, one `state`, and a named `questions` map. Choice uses a
`criteria` map; Score uses ordered criteria; Noul asks a yes/no question. Answers
retain their type, complete probability distribution where applicable, and
usage. The adapter preserves raw values and rejects incomplete distributions;
it never interprets percentages or guesses units.

The [official models page](https://docs.typesafe.ai/models) identifies
`jev-1.13.0` and currently maps `jev-latest` to it. We pin `jev-1.13.0` by default
and preserve the responding model in the receipt. This is text/JSON inference,
not direct audio or image processing.

TypeSafe distinguishes [confidence from probability](https://docs.typesafe.ai/confidence).
Our gate checks both, each at a default floor of 0.8. Those are application
policy choices, not empirically validated thresholds for meetings.

## Integration boundary

```ts
const gate = new JevDecisionGate(createJevAdapter({ deadlineMs: 1500 }));
const input = {
  snapshot: immutableAmbientInput,
  candidates: typedJudgments.map((payload, index) => ({
    id: `candidate_${index}`,
    description: describeJudgment(payload),
    payload,
  })),
  instructions: 'Select the next useful action supported by the meeting evidence.',
};
const decision = await gate.decide(input, abortSignal);
if (decision.status !== 'selected') return quiet();
// Reconstruct input with CURRENT context immediately before dispatch.
if (!gate.verify(decision.receipt, currentInput)) return quiet();
// Then deterministic validation and policy checks, before side effects.
```

There are 1–12 supplied candidates, plus an injected `__hold__` choice. The
adapter issues one batch with one shared state and no retries. Its default
1500 ms deadline also bounds transports that ignore abort. The configured
deadline is a latency budget, not a claim about observed provider speed.

Receipt HMACs bind the complete snapshot, candidate payloads and IDs,
instructions, selected ID, model, full Choice answer, and expiry. A fresh
process-local random key authenticates them; these are **local authorization
receipts, not signatures from TypeSafe**. They expire after 10 seconds by
default and cannot survive a process restart. A receipt alone is not human
approval or a promise that evidence is correct. The core remains responsible
for evidence references, exact arithmetic, task ownership, idempotency, and
explicit approval of external calendar/message effects. Changing the context
or payload invalidates authorization, even if the candidate ID stays the same.

## Credentials

Server-side configuration names (blank values intentionally):

```dotenv
JEV_API_KEY=
# Official SDK-style name is also accepted when JEV_API_KEY is not set:
TYPESAFE_API_KEY=
# Optional; default is jev-1.13.0:
JEV_MODEL=
```

Obtain the direct TypeSafe credential from the
[TypeSafe console](https://console.typesafe.ai). Pass it in the server process
environment or directly through `createJevAdapter({ apiKey })`; do not place it
in a browser bundle, source control, transcript, or receipt. The endpoint is
fixed to TypeSafe's official host and redirects are rejected. Error messages
omit response bodies and network error details.

## Validation status

- **Fixture-tested:** `npx vitest run test/jev.test.ts` passed 18 tests on
  September 27, 2026. The documented Choice response is labeled as a fixture.
  Tests cover the exact request shape, all three typed primitives, incomplete
  and malformed answers, unconfigured mode, timeout/abort, HTTP failure,
  candidate mutation, hold, expiry, and receipt tampering.
- **Live adapter and gate verified, September 27, 2026, 15:24 PDT:** the user
  supplied a direct Jev key in the designated owner-only
  `~/.config/glance-qm/jev.env`. Two tiny synthetic requests used the actual
  adapter and official endpoint with its normal 1500 ms deadline. No key was
  printed, copied into this repository, or sent to another provider.

  | Actual request | Observed result |
  | --- | --- |
  | Batched Choice, Noul and Score | 180 ms; model `jev-1.13.0`; all three typed answers and complete distributions validated. Choice selected `calculate` at probability/confidence 1; Noul returned 0.99; Score returned 2 on a three-level rubric. |
  | Candidate decision gate | 109 ms; selected `calculate` at probability 0.97 and confidence 0.95; hold probability 0.03. The receipt verified against the original snapshot and rejected a changed snapshot. |

  These are individual observed synthetic probe latencies, not a benchmark or
  a live meeting rehearsal. The probes produced no external action or artifact.
- **Integration boundary:** the provider candidate-generation path and core's
  immediate receipt verification still require their own end-to-end meeting
  rehearsal. Live adapter success alone does not establish glasses, Exa, QM,
  calendar, or publication behavior.

The old Glance provider was inspected only for designated configuration names;
this adapter was implemented from the current official contract. No old
credential, private transcript, runtime state, or provider implementation was
copied.

## Experimental instant public context

`instant-context.ts` supplies bounded literal name spans from introductory
speech to Jev, which decides whether a public lookup is appropriate. The core
performs Exa research. A subsequent Jev gate chooses a complete, verbatim short
source sentence versus hold. No QM text generation is needed on this narrow
path. The source cue always says **Possible match**; it does not authenticate
the speaker. Neither face identification nor a hardcoded person catalog is used.

This path is opt-in: set `GLANCE_INSTANT_CONTEXT=true` together with
`GLANCE_DECISION_MODE=jev-native`. The default is `false`, so ordinary runtime
startup and the primary QM decision path do not prefetch public sources.

Sentence segmentation uses `Intl.Segmenter`, preserving decimals and negation.
Sentences longer than 145 characters are omitted intact, so the uncertainty
label fits within a 160-character cue. Publication retains the existing 0.8
probability and confidence floors. A single source candidate is selected by
search ranking before Jev's publish/hold choice; competing equally useful facts
do not dilute its distribution. Ordinary non-introduction work uses the general
provider path. A held decision does not authorize publication.

Live standalone helper measurements on September 27, 2026 around 15:51 PDT:

| Input / path | Actual result |
| --- | --- |
| “I’m Garry Tan”, no supplied sources | 638 ms: research gate 138 ms, Exa 358 ms, final gate 142 ms. Source-backed cue selected at probability 0.99 / confidence 0.99. |
| “Hi, I’m John Smith.” | 376 ms; held because the final confidence 0.72 did not meet the unchanged 0.8 policy. No cue authorized. |
| Stable partial “I’m Garry Tan”, then identical final text | Partial lookup preparation 716 ms, then final-to-cue 121 ms with supplied sources. Final probability 0.99 / confidence 0.98. |

The positive cue was “Possible match: Garry Tan is president and CEO of Y
Combinator and a General Partner.” Its source was the
[official Y Combinator profile](https://www.ycombinator.com/people/garry-tan).
The partial-stage receipt failed verification against the final input; the new
final receipt passed, and a changed correction epoch was rejected. The observed
final receipt reference was `jev:abb68512eb489f146`, model `jev-1.13.0`, with
snapshot digest `230c6d5b004d2ce39630b9bef0901a71380a600e7b1657d99f1d724aa1ec442f`.
Receipts expire and are process-local; this reference is audit evidence, not a
reusable authorization.

The full-app synthetic API/WebSocket verifier separately passed 13/13 public
introduction checks in 8.092 seconds, including fresh Jev receipts, four-source
Exa retrieval, and sourced cues for two named public profiles. This is backend
transport evidence from synthetic speech input; it is not a measurement of
physical wearer display latency or sustained background capture.

These are synthetic, real-provider helper checks, not end-to-end browser or
glasses latency measurements. Keep the runtime feature flag off until its own
integration checks pass. Prefetch may return sources only; it never publishes
or dispatches an action, and final publication always needs a fresh receipt.
