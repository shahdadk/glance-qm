# kompX

kompX is an ambient Jarvis-style context interface for Meta glasses. Its
native iOS bridge pairs once with the glasses, keeps spoken context active,
and turns useful moments into quiet lens cues or contextual action cards. A
meeting is the strongest demonstration, but the product boundary is broader:
kompX can recall, research, draft, summarize, and stage a deliberate delivery
from whatever the wearer is discussing. The phone/browser companion is a
debugging and shared-room surface; it is not the glasses experience. GBrain
provides durable memory. Memorable preserves successful workflows after the
core task path completes.

This is a clean-history hackathon repository owned by `shahdadk`. It is
inspired by the earlier Glance work, but it is an independent implementation.
See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for origin attribution and
integration status.

## Current state

The backend, ambient controller, QM/GBrain/Memorable/Exa adapters, web
companion, and native iOS bridge are implemented. QM is live verified through
the connected verifier, self-hosted GBrain has live OAuth MCP read/write with
keyword search, Memorable has live workflow save/readback, and Exa research
has live four-source retrieval plus an end-to-end PRD research path. Jev has a
live adapter/gate probe and core Jev-native verification. Google Calendar OAuth
read and exact preview verification pass; no invitation has been sent. Gmail
document delivery is preview- and duplicate-safe, but no email has been sent.
The native app is signed, installed, and registered; one nonempty physical
Speech result reached the backend with HTTP 200. Sustained background speech
and full glasses Display rehearsal remain unverified. A local fixture or export
does not count as a live integration receipt.

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

1. The wearer starts kompX and pairs the native bridge once.
2. Meta Speech supplies partial and final transcript segments as context.
3. While listening, the lens stays quiet unless a grounded cue is useful; a
   contextual card can show a cue, research result, draft/task, summary, or
   exact delivery preview.
4. A meeting can share the same context and QM work with another participant;
   the companion supports diagnosis and rehearsal.
5. A delivery or calendar action remains a preview until the exact artifact,
   recipient, and current context are confirmed.

The public boundary for this loop is defined in
[`src/shared/contracts.ts`](src/shared/contracts.ts).

## Verification

Run `npm run check`, `npm run build`, and `npm run demo` after core changes.
The current source verification covers both TypeScript projects and the full
focused test suite; connected verification covers QM, GBrain, Memorable, Exa,
Jev-native selection, calendar preview, and delivery safeguards. Before
submission, rehearse the native glasses path with a nonempty transcript,
useful context card, correction invalidation, summary/document work, and an
exact delivery preview. Record the actual outcome in
[`docs/STATUS.md`](docs/STATUS.md).
