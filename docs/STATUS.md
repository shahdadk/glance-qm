# Status

Last updated: final integration verification

## Implemented

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

1. Verify sustained background Speech transcription and full Display updates on
   the physical glasses with the latest installed source.
2. Rehearse the universal ambient flow and its meeting demonstration with two
   participants, recording only sanitized receipts.
3. If the operator chooses to send an invitation or document, verify the exact
   preview and provider readback first; no automatic retry follows uncertainty.
