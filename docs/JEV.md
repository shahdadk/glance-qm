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
- **Not live-verified:** neither `JEV_API_KEY` nor `TYPESAFE_API_KEY` was present
  in the worker process. The explicitly designated prior Glance
  `.local/provider.env` contained neither Jev nor TypeSafe variable names.
  The newer designated `/Users/shahdad/projects/glance` checkout also had no
  `.local/provider.env`, `.env`, or `.env.local`; its documented runtime's
  provider env/readiness files were absent. Its README itself labels Jev as
  unverified. No additional Jev credential binding was found in the inspected
  provider configuration code.
  No inference probe was sent with a substitute credential, and no key was
  copied into this project. A direct TypeSafe key is still required for a tiny
  inference probe.
- **Integration:** the gate is a library boundary. Native product behavior also
  requires the provider candidate-generation path and the core's immediate
  receipt verification before dispatch. Adapter unit tests alone do not prove
  an end-to-end native flow.

The old Glance provider was inspected only for designated configuration names;
this adapter was implemented from the current official contract. No old
credential, private transcript, runtime state, or provider implementation was
copied.
