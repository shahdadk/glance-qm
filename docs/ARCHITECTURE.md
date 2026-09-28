# Architecture

## Boundaries

The web companion and Meta bridge are clients of the backend. The backend
owns meeting snapshots, revision checks, authentication, event fan-out, and
provider adapters. QM owns shared sessions and durable tasks. GBrain is used
for memory retrieval and meeting writes through its documented connector.
Memorable is an optional workflow memory adapter. Provider credentials stay in
the server/runtime secret boundary.

```text
Meta Speech + Display
          |
          | authenticated HTTP / WebSocket
          v
  Glance QM backend  ---->  QM shared session and tasks
          |                 |
          +---------------> GBrain memory connector
          |
          +---------------> Memorable workflow connector (optional)
```

## State and revisions

Each meeting has a monotonically increasing revision. Transcript segments carry
their own segment revision and stable ID so partial updates can be replaced
without duplicating final speech. A cue, summary, or action proposal must
reference the context revision from which it was derived. A correction or new
final segment invalidates work derived from an older revision.

The server sends a complete snapshot when a client connects and typed events
for subsequent updates. A reconnecting client can discard local state and
replay the latest snapshot safely.

## HTTP boundary

All routes except `GET /api/health` require a bearer token. The public request
and response shapes live in `src/shared/contracts.ts` and are validated at
runtime with Zod.

| Route | Purpose |
| --- | --- |
| `POST /api/meetings` | Create a meeting from a title and optional participant names. |
| `GET /api/meetings/:id` | Read the current meeting snapshot. |
| `POST /api/meetings/:id/transcript` | Append or revise a transcript segment. |
| `POST /api/meetings/:id/messages` | Add authenticated participant input. |
| `POST /api/meetings/:id/control` | Pause or resume ambient capture. |
| `POST /api/meetings/:id/end` | End the meeting and begin summary/follow-up work. |
| `POST /api/meetings/:id/actions/:actionId/confirm` | Confirm the exact calendar proposal version. |
| `GET /api/health` | Return non-secret service and provider readiness. |

The WebSocket route `GET /api/meetings/:id/events` requires the first message
to be `{ "type": "auth", "token": "..." }`. Tokens never appear in query
parameters.

## Ambient decision loop

The runtime keeps a bounded active context while retaining the complete meeting
for retrieval. It coalesces pending transcript work and allows one judgment at
a time. In Jev-native mode, QM proposes bounded structured candidates and Jev selects
an outcome: quiet, retrieve memory, research, show a cue, or stage a task/action.
The optional accelerated public-context path uses direct Jev selection over
transcript/source candidates with Exa retrieval. Judgment, summary, and task
work use separate QM thread namespaces. Code owns ordering, revision checks,
provider timeouts, and side-effect gates.

The native app also provides a local, explicitly labeled preloaded brief for
manual interface demonstrations. Selecting the kompX wordmark opens that card
without a provider call or microphone activation. This presentation path is
separate from ambient inference; it does not generate a model receipt.
