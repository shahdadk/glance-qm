# Status

Last updated: foundation bootstrap

## Implemented

- Fresh GitHub repository created at `shahdadk/glance-qm` with no imported
  history.
- Local starter moved into the clean `glance-qm` project directory.
- Shared Zod DTOs and TypeScript types are defined in
  `src/shared/contracts.ts`.
- Port and script conventions are pinned: web `5174`, backend `8790`.
- Repository ignores local secrets, recordings, generated output, and build
  artifacts.
- TypeScript source checking remains strict; `skipLibCheck` is enabled only to
  avoid the duplicate `containSubset` declaration emitted by the pinned
  Vitest/Chai declaration packages under TypeScript 7.

## Not yet verified

- Node backend route implementation and WebSocket fan-out.
- Real QM runtime connection and multiplayer session.
- Hosted GBrain memory read/write.
- Meta glasses continuous speech/display rehearsal.
- Calendar provider send and duplicate prevention.
- Memorable workflow record/retrieval.

## Readiness rule

The words `connected` and `live verified` are reserved for a successful
authenticated request or end-to-end rehearsal. A generated fixture, a local
mock, or a provider configuration file is reported as such and does not count.

## Next checks

1. Install dependencies and run `npm run check`.
2. Provision the local QM runtime and confirm the health route.
3. Run a two-participant meeting rehearsal with transcript correction.
4. Connect GBrain, then record the exact memory read/write evidence.
5. Add Memorable only after the core rehearsal passes.
