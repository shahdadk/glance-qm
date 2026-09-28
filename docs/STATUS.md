# Verification status

Last reviewed: September 27, 2026. kompX is a working hardware prototype with incomplete ambient reliability.

## What has been verified

| Area | Evidence | Scope |
| --- | --- | --- |
| Source checks | 211 TypeScript tests; build and nine-check fixture demo passed | Backend and web source; fixtures are distinct from live services |
| Native app | 13 native tests and signed iPhone build passed | Meta DAT 1.0.0 Speech and Display bridge |
| Glasses speech | Nonempty partials/finals uploaded from the actual Meta microphone with HTTP 200 | Explicit wearer Start/Pause; no phone-microphone fallback |
| Context cards | Actual company card delivered to the glasses; wearer used Details and Done | Successful physical flow involved maintenance and reprocessing |
| QM | Authenticated access to the original shared project and real model/document completion | Separate judgment, summary, and task threads; shared QM principals verified |
| GBrain | Two successive live controller checkpoints saved to the same page, with distinct revisions and exact readback | Session remained listening; no End call; keyword recall |
| Memorable | Successful procedure storage, retrieval, and reuse as workflow reference | Abstract procedures; conversation memory remains in GBrain |
| Exa + Jev | Live sourced research, action selection, and context-bound publication receipts | Holds and source uncertainty can still suppress a card |
| Calendar / Gmail | OAuth/readiness, previews, confirmation and duplicate-send protections | No real email or calendar invitation sent during verification |

## Two distinct display paths

**Ambient cards** use captured conversation, public research or memory, and Jev authorization. They are not yet dependable for every phrase or repeated attempt. A verified physical flow at 23:38:22Z used previously captured speech and Pause reprocessing, followed by wearer Start → card → Details → Done. It must not be described as a guaranteed instant response.

**The manual interface demo** opens a preloaded Liquid Energy brief by selecting the kompX wordmark. Its source attribution and “Preloaded brief” label are visible on the card. This local shortcut is independent of live inference and does not start the microphone. Home shows kompX and the separate Start/Pause control; Done dismisses the held brief. The SDK exposes a Select action, not a separately remappable middle-finger/Back gesture.

## Performance evidence

Recorded successful isolated Exa/Jev runs produced cards in approximately 1–2 seconds from accepted final text to an observed WebSocket snapshot. A replay of seven recorded speech fragments produced a card in 1,425 ms after its company fragment. These are selected successful test runs, not a latency guarantee or physical microphone-to-lens benchmark.

The live memory controller saved two successive checkpoints in 8,424 ms during an accelerated verification run. Normal rolling checkpoints run every 30 seconds when finalized context is stable. This does not mean every spoken word is immediately written to GBrain.

## Remaining limits

- Automatic triggering and repeated conversational attempts remain inconsistent.
- Sustained locked-phone/background capture is not established.
- The app authenticates one local operator. QM's shared-project behavior does not establish multi-user app authentication.
- GBrain semantic embeddings are not verified; keyword search is the demonstrated recall path.
- Public research is context about a possible profile, not authentication of a speaker's identity.
- Sending email or invitations remains an explicit, separately reviewed action.

## Reproduce and inspect

- [Credential-free source reproduction](REPRODUCIBILITY.md)
- [Connected setup and runbook](RUN-DEMO.md)
- [Meta build and hardware evidence](META-SETUP.md)
- [Integration contracts](INTEGRATION-CONTRACTS.md)
- [Development verification history](VERIFICATION-HISTORY.md)
- [Recorded continuation checks](CONTINUATION-VERIFICATION.md)

Raw recordings, personal transcripts, pairing files, and provider credentials are excluded from Git. Provider configuration alone is not evidence of a successful provider call; a fixture is not hardware evidence.
