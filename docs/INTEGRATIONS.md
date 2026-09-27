# Integrations and attribution

This document separates planned, locally implemented, connected, and live
verified behavior. It is part of the submission record; do not upgrade a
status without recording the command or rehearsal that established it.

## QM

QM is the intended shared execution environment and multiplayer surface. The
project will use one shared meeting/session for participants and a separate
follow-up task run in that same project. The adapter must use QM's documented
interfaces; it must not invent a private REST contract or treat a fixture as
an integration receipt.

Status: connected and live verified. The final connected verifier passed 14/14
checks, including an actual QM document completion and a durable shared
session. The local runtime is pinned and its secrets remain outside this
repository.

## GBrain

Self-hosted GBrain is the memory layer for this submission. It supplies
relevant meeting history and receives attributed decisions, summaries, and task
provenance through its OAuth MCP connector. Access tokens belong only in
ignored local state or the runtime secret manager. Keyword search is the
reproducible default because the available embedding providers are quota
limited; semantic/vector recall is not claimed.

Status: live verified for OAuth, MCP discovery, durable `put_page`/`get_page`,
and lexical `search`. The dedicated PostgreSQL/pgvector service is pinned and
isolated. No gbrain.io-hosted account is required for the demonstrated path.

## Memorable

Memorable records the successful QM document workflow and retrieves it for a
later task. This keeps workflow memory distinct from GBrain's meeting memory;
the adapter stores abstract steps and verified receipts rather than meeting
transcripts or attendee identities.

Status: live verified for a procedure save, list/readback, and recall. Setup and
consent remain explicit runtime prerequisites.

## Meta glasses

The intended device path uses Meta's documented Device Access Toolkit Speech
and Display capabilities through a native iOS bridge. The bridge pairs once;
Speech supplies partial and final transcript events, and Display receives a
quiet listening state, useful cues, tasks, summaries, and exact action
previews. The browser/mobile companion supports debugging and shared-room
rehearsal; it does not claim device delivery.

Status: signed build and native tests pass; the physical Speech path produced a
nonempty final transcript that reached the backend with HTTP 200. Sustained
background capture and full Display rehearsal remain unverified. The latest
source layout is documented separately from the installed build.

## Exa

Exa is the only public web-research provider. The server sends a short,
standalone public topic and returns up to four bounded, attributed sources.
Private transcript text, names, identifiers, URLs, and credentials are blocked
at the query boundary. GBrain remains the source for private/project memory.

Status: live adapter and factory retrieval passed with four real sources, and
the core's research-first PRD path was live verified. There is no silent search
fallback.

## Jev

Jev is an optional semantic selection gate after QM produces a bounded typed
candidate set. Receipts are verified against the current context immediately
before the core applies a judgment; a hold, timeout, changed context, or
invalid response produces no action.

Status: live adapter/gate probes and Jev-native core verification passed. QM
remains the default mode when `GLANCE_DECISION_MODE=qm`; Jev remains an
optional decision mode and never authorizes an external action by itself.

## Calendar and document delivery

Calendar OAuth read and exact preview verification pass; no invitation has been
sent. The Gmail document-delivery adapter binds the reviewed artifact digest,
generation, context, recipient, and proposal version, records uncertain sends,
and refuses automatic retries. No email has been sent during QA.

## River AI and other sponsors

River AI, Superset, and UFO are not required dependencies for the first
rehearsal. Adding them is acceptable only if the sponsor integration is already
authenticated and improves the central demonstration without adding an
unverified failure point. The first submission should not claim their use.

## Origin notes

Glance QM is an independent implementation by `shahdadk`. It carries forward
principles from the earlier Glance project—judgment-first control flow,
bounded active context, coalesced transcript evaluation, evidence-linked
decisions, and explicit side-effect confirmation. No Glance credentials,
sessions, personal transcripts, runtime files, or device assumptions are
included here. Any external code copied into this repository must be listed
with its source, license, and changed files before commit.
