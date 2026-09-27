# Glance QM

Glance QM is an ambient Jarvis-style meeting companion for Meta glasses. It
keeps a meeting transcript active, uses grounded context to decide when a
short cue is useful, and turns the meeting's decisions into shared QM work.
GBrain provides durable meeting memory. Memorable can preserve successful
workflows once the core path is proven.

This is a clean-history hackathon repository owned by `shahdadk`. It is
inspired by the earlier Glance work, but it is an independent implementation.
See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for origin attribution and
integration status.

## Current state

The repository currently contains the foundation contract and runtime
scaffold. The Meta, QM, GBrain, and Memorable connections are deliberately
reported as proposed until they have been connected and rehearsed. A local
fixture or export does not count as a live integration receipt.

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

1. A participant starts one shared QM meeting.
2. Meta Speech supplies partial and final transcript segments continuously.
3. The ambient controller coalesces final segments and asks QM whether to stay
   quiet, retrieve GBrain context, show a grounded cue, or stage follow-up
   work.
4. Participants see the same cues, transcript, tasks, and corrections through
   QM multiplayer.
5. Ending the meeting saves an attributed summary and starts the agreed
   document task. A calendar invitation remains a preview until an exact
   proposal is confirmed.

The public boundary for this loop is defined in
[`src/shared/contracts.ts`](src/shared/contracts.ts).

## Verification

Run `npm run check` after core changes. Run `npm run demo` for the deterministic
fixture flow. Before submission, rehearse the live flow with two participants:
continuous transcript, one relevant memory-backed cue, a correction that
invalidates stale work, summary persistence, document creation, and one
confirmed calendar invitation without duplicates. Record the actual outcome in
[`docs/STATUS.md`](docs/STATUS.md).
