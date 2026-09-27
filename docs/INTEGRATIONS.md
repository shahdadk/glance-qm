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

Status: foundation contract only; connection pending runtime provisioning.

## GBrain

Hosted GBrain is the intended memory layer. It will supply relevant meeting
history and receive attributed decisions, summaries, and task provenance
through its documented connector. Access tokens belong only in ignored local
state or the runtime secret manager.

Status: foundation contract only; connection pending credential and connector
verification.

## Memorable

Memorable is an optional second-pass integration. After the core flow works,
the runtime may record the successful QM document workflow and retrieve it for
a later task. This keeps workflow memory distinct from GBrain's meeting memory.

Status: planned, not on the critical path.

## Meta glasses

The intended device path uses Meta's documented Device Access Toolkit Speech
and Display capabilities. Speech supplies partial and final transcript events;
Display receives listening state, cues, and exact action previews. A browser
fixture may help debug transport but does not establish a glasses verification.

Status: planned; hardware and signed companion availability must be recorded
after live rehearsal.

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
