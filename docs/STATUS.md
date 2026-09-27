# Status

Last updated: Phase 2 integration verification

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
- Jev adapter code and 18 fixture tests pass; no Jev credential is configured,
  so live Jev selection remains blocked. QM remains the default decision mode.
- Native iOS is installed and registered, but a real glasses connection and
  sustained Speech/Display rehearsal remain unverified.
- Repository ignores local secrets, recordings, generated output, and build
  artifacts. TypeScript source checking remains strict; `skipLibCheck` is
  enabled only for the duplicate `containSubset` declarations emitted by the
  pinned Vitest/Chai packages under TypeScript 7.

## Verification evidence

- `npm run check`: both TypeScript projects and 84 tests pass.
- `npm run build`: production web bundle builds successfully.
- `npm run demo`: deterministic provider/controller flow passes.
- Connected verifier: 14/14 checks pass against the live QM/GBrain/Memorable
  stack, with calendar intentionally held at read/preview verification.
- Native device connection: pending a physical glasses rehearsal.

## Readiness rule

The words `connected` and `live verified` are reserved for a successful
authenticated request or end-to-end rehearsal. A generated fixture, a local
mock, or a provider configuration file is reported as such and does not count.

## Remaining limits and next checks

1. Pair the installed native bridge with the physical glasses and verify
   sustained Speech transcription plus Display updates.
2. Rehearse the entire meeting flow with two participants and record only
   sanitized receipts.
3. If the operator chooses to send an invitation, verify the exact preview and
   provider readback first; no automatic retry follows an uncertain outcome.
