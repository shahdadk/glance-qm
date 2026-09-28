# Development verification history

Historical checkpoints from the hackathon build. For the current overview, see [STATUS.md](STATUS.md). Counts and statements below describe the revision at the time of each check.

# Status

Last updated: final integration verification

## Implemented

- At the operator's request, selecting **kompX** on the native home screen
  immediately opens a preloaded, three-bullet Liquid Energy company brief.
  The home screen retains Start/Pause without an extra company button.
  The brief is labeled “Preloaded brief” with the public company source
  and stays open until Done. This local path performs no live AI lookup and
  does not start the microphone. It uses the SDK's primary/select action;
  a distinct middle-finger or Back gesture binding is not claimed.

- Fresh private GitHub repository created at `shahdadk/glance-qm` with no
  imported history; the foundation is pushed on `main`.
- Shared Zod DTOs, revision rules, event envelopes, action confirmation, and
  pause/resume control are defined in `src/shared/contracts.ts`.
- The backend and web companion implement the shared meeting, ambient cue,
  task, summary, and calendar-preview loop. Native iOS is the glasses bridge;
  the browser companion is support and debugging.
- QM is live connected and the final connected verifier passed 14/14 checks,
  including actual document completion and recovery behavior.
- Self-hosted GBrain is live OAuth/MCP verified for durable writes, readback,
  and keyword search. Embedding/vector recall is not claimed because provider
  quotas are unavailable.
- Memorable procedure save/readback and recall are live verified with
  transcript and attendee redaction.
- Google Calendar OAuth read and exact preview verification pass. No calendar
  invitation has been sent during QA.
- Exa live retrieval returned four attributed sources, and the research-first
  PRD path was verified through the core. Jev live adapter/gate probes and
  Jev-native core verification pass; QM remains the default decision mode.
- The proactive public-introduction verifier passed 13/13 with synthetic
  Garry Tan/Y Combinator and Satya Nadella/Microsoft speech inputs: Jev
  authorized Exa, four identity-supporting sources returned for each, and each
  produced a sourced cue without a question or wake word. No external action
  was sent; this is not a hardware or identity-recognition claim.
- Calendar OAuth read and exact preview verification pass; no invitation has
  been sent. Document delivery is digest-, recipient-, generation-, and
  context-bound; no email has been sent.
- Native iOS signed build and tests pass. A physical Meta Speech test produced
  a nonempty final transcript that reached the backend with HTTP 200. Sustained
  background capture and full Display rehearsal remain unverified.
- Repository ignores local secrets, recordings, generated output, and build
  artifacts. TypeScript source checking remains strict; `skipLibCheck` is
  enabled only for the duplicate `containSubset` declarations emitted by the
  pinned Vitest/Chai packages under TypeScript 7.

## Verification evidence

- On 2026-09-27 at 23:38:22Z, the installed native card rendered sourced Liquid
  Energy background from previously captured real speech. After the stale-source
  fix, the existing Pause control reprocessed that speech while capture stayed
  stopped; transcript contents were unchanged. New Exa research and Jev cue
  receipts preceded the successful native Display send. Wearer Start at
  23:38:35Z was followed by another card at 23:38:36Z; Details at 23:38:38Z
  opened “Why this cue 1/12”, and Done at 23:38:42Z returned to kompX.
  Native card delivery and wearer interaction are verified. Maintenance and
  manual reprocessing were involved, so this is not an immediate speech-to-lens
  latency measurement or a claim of sustained background reliability.

- Physical speech exposed two further defects: clipped/lowercase company
  mentions missed the accelerated lookup, and a QM judgment returned the
  preceding summary's JSON shape because both roles shared one conversation.
  Company lookup now retains a recent introduction across brief filler speech,
  uses company-specific evidence selection, and keeps the strict 0.8 publication
  threshold. Judge and summary work use distinct QM conversation namespaces.
  A real summary-then-judgment provider probe passed on those separate threads.
- At 2026-09-27T23:33:40Z, an isolated replay of seven captured ASR finals at
  their original 22-second spacing produced a sourced Liquid Energy card over
  WebSocket 1,425 ms after the company fragment, with zero warnings. The three
  bullets came from the company's public site and retained “Possible match”
  and “company claims” labels. This replays recorded speech; it does not prove
  a new physical lens delivery. Updated checks pass 208 tests in 14 files.

- Final context-card revision: `npm run check` passes 205 tests in 14 files;
  `npm run build` and `npm run demo` pass. Native fact cards rank literal source
  clauses and require a separate strict Jev publication gate. An isolated real
  Exa/Jev HTTP/WebSocket probe produced three Garry Tan background bullets,
  including Stanford education, from the official YC biography in 1,878 ms
  from accepted final text to snapshot. This is synthetic transport timing,
  not physical speech-to-lens timing or a guaranteed latency. A separate Sajan
  Khosa / Liquid Energy input produced two attributed company-background
  bullets in 991 ms. Source availability and strict confidence holds can still
  suppress a card; these measurements are successful runs, not an SLA.
- GBrain summary replacement now reads the existing revision and uses
  compare-and-swap; create-only writes remain create-only. Nine focused tests
  cover safe repeated saves and conflict/error handling. After reboot recovery,
  a real synthetic first create and second replacement of the same GBrain page
  passed independent readback with distinct revisions. The complete live
  controller verifier then saved two successive QM summaries to the same
  GBrain page in 8,424 ms, with distinct receipts and matching context digests,
  while listening and without End. It completed with zero warnings at
  2026-09-27T23:24:46Z.
- A host reboot stopped the local stack and removed the temporary QM checkout.
  The pinned source was restored to persistent storage. Backend transport and
  the replacement HTTPS tunnel are verified, including authenticated snapshot
  readback. GBrain and QM are restored; authenticated access to the original QM
  project and an actual `QM_LIVE_OK` model completion both pass. Configured
  provider labels alone do not establish service connectivity. The later native
  card rehearsal above verifies delivery; sustained background Speech remains
  a separate limit.

- `npm run check`: both TypeScript projects and the current full test suite pass.
- `npm run build`: production web bundle builds successfully.
- `npm run demo`: deterministic provider/controller flow passes.
- Connected verifier: 14/14 checks pass against the live QM/GBrain/Memorable
  stack, with calendar intentionally held at read/preview verification.
- Exa/ambient, Jev, delivery, and native transport verification receipts are
  recorded in the focused docs and tests.

## Readiness rule

The words `connected` and `live verified` are reserved for a successful
authenticated request or end-to-end rehearsal. A generated fixture, a local
mock, or a provider configuration file is reported as such and does not count.

## Remaining limits and next checks

1. Verify sustained background Speech transcription and Display behavior beyond
   the successful contextual card and Details/Done interaction above.
2. Rehearse the universal ambient flow and its meeting demonstration with two
   participants, recording only sanitized receipts.
3. If the operator chooses to send an invitation or document, verify the exact
   preview and provider readback first; no automatic retry follows uncertainty.
