# kompX product brief

## Promise

kompX quietly helps a live meeting from Meta glasses. It listens to the
conversation continuously, surfaces a useful fact or next step only when the
context supports it, and turns agreed work into a shared QM project that
participants can inspect and correct.

## Primary demonstration

Two people share one QM meeting. One person speaks about a decision or an
open question. The glasses continue showing a small listening state and then a
brief cue backed by transcript or GBrain evidence. A participant corrects the
conversation; the prior cue is invalidated. When the meeting ends, QM saves a
summary, begins the agreed brief, and prepares a calendar invitation. The
invitation is sent only after an exact preview is confirmed.

## Interaction principles

- Listening is continuous, visible, and interruptible.
- Silence is a valid result. kompX does not narrate every transcript segment.
- Cues are short, grounded, and attributable to source evidence.
- A correction changes the context revision and makes stale proposals unsafe.
- Participants share the same durable work and can see who produced it.
- External actions are inspectable and require explicit confirmation.

## In scope for the hackathon

- A shared meeting and participant identity in QM.
- Partial and final transcript transport from the Meta surface.
- Ambient cue decisions with transcript and GBrain memory evidence.
- Persisted summary and a single follow-up document task.
- Calendar invitation preview and confirmed send through a supported connector.
- One Memorable workflow record/retrieval pass if the core rehearsal passes.

## Out of scope

- Training a custom model or building a new memory database.
- Background actions without a visible proposal and confirmation.
- Importing private Glance data, device state, credentials, or sessions.
- Claiming hardware or provider support before a live rehearsal.
