# kompX

kompX is an ambient Jarvis-style meeting companion for Meta glasses. Its
native iOS bridge pairs once with the glasses, keeps a meeting transcript
active, uses grounded context to decide when a short lens cue is useful, and
turns the meeting's decisions into shared QM work. The phone/browser companion
is a debugging and shared-room surface; it is not the glasses experience.
GBrain provides durable meeting memory. Memorable preserves successful
workflows after the core task path completes.

This is a clean-history hackathon repository owned by `shahdadk`. It is
inspired by the earlier Glance work, but it is an independent implementation.
See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for origin attribution and
integration status.

## Current state

The backend, ambient controller, QM/GBrain/Memorable adapters, web companion,
and native iOS bridge are implemented. QM is live verified through the
connected verifier, self-hosted GBrain has live OAuth MCP read/write with
keyword search, and Memorable has a live workflow save/readback. Google
Calendar OAuth read and exact preview verification pass; no invitation has
been sent. Jev is code- and fixture-verified but remains blocked on a live
credential. The native app is installed and registered, but a real glasses
connection is still unverified. A local fixture or export does not count as a
live integration receipt.

## Quick start

Requirements: Node.js 22 or newer (Node.js 24 is preferred for the local QM
runtime), npm, and access to the services used by the live demonstration.

```sh
npm install
npm run check
npm run demo
npm run dev
```

The web companion listens on port `5174`; the backend listens on port `8790`.
The backend access key is generated into ignored local state during setup. It
must be sent as `Authorization: Bearer <key>` for HTTP requests and as the
first `{ "type": "auth", "token": "<key>" }` message on a WebSocket. It must
never appear in a URL or client bundle.

Provider configuration belongs in ignored local state or the runtime's secret
manager. Do not put provider tokens, meeting recordings, personal transcripts,
or generated private briefs in Git.

## Product loop

1. A participant starts one shared QM meeting and pairs the native bridge once.
2. Meta Speech supplies partial and final transcript segments continuously.
3. While listening, the lens stays quiet unless a grounded cue is useful; it
   can show a cue, task, summary, or exact action preview.
4. Participants see the same context, corrections, and QM work through the
   shared room. The companion supports diagnosis and rehearsal.
5. Ending the meeting saves an attributed summary and starts the agreed
   document task. A calendar invitation remains a preview until an exact
   proposal is confirmed.

The public boundary for this loop is defined in
[`src/shared/contracts.ts`](src/shared/contracts.ts).

## Verification

Run `npm run check`, `npm run build`, and `npm run demo` after core changes.
The current source verification covers both TypeScript projects and 84 tests;
the connected verifier covers QM, GBrain, Memorable, calendar preview, and
recovery behavior. Before submission, rehearse the native glasses path with
continuous transcript, one relevant memory-backed cue, a correction that
invalidates stale work, summary persistence, document creation, and one
confirmed calendar invitation without duplicates. Record the actual outcome in
[`docs/STATUS.md`](docs/STATUS.md).
