# kompX on Meta Ray-Ban Display

The visible app is **kompX**. Its independent bundle ID remains `com.shahdad.glanceqm`; the project is `native/ios/GlanceQM.xcodeproj`. Core, Speech, and Display use the real, exact Meta DAT **1.0.0** release. No MockDeviceKit is linked or created.

## Verification record

Recorded on 2026-09-27:

- Full simulator and signed iPhone builds succeed on this Mac's Xcode 26.1.1. The latest candidate passes nine XCTest tests, zero failures.
- Real SDK configuration, Meta registration, DeviceSession startup, Display startup, and native card sends are verified. The wearer confirmed the lens counter.
- Real glasses `MWDATSpeech` emits nonempty partial and final text. At 14:49:51, this rehearsal had 200 raw events, 52 accepted nonempty updates, six nonempty finals, and 52 authenticated HTTP uploads with status 200.
- Wearer lens Pause/Resume are verified. Pause stops Speech and updates shared status while retaining Display/session. The wearer explicitly paused again at 14:50:37; that was not a capture failure.
- The default demo keeps the lens visible with minimal Listening / Tasks / Menu controls. Longer uninterrupted capture, grounded cue rendering, final summary/tasks/action review, and quiet/locked-phone behavior remain separate acceptance checks.

The official current samples document Xcode 26.4+/Swift 6.3+. Actual 1.0.0 interfaces and this app compile with installed Xcode 26.1.1. This is a measured compatibility result, not a general upstream support guarantee; the binary reports Swift 6.3.3.

## Build and install

```sh
cd native/ios
xcodegen generate
xcodebuild -project GlanceQM.xcodeproj -scheme GlanceQM \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData CODE_SIGNING_ALLOWED=NO build

xcodebuild -project GlanceQM.xcodeproj -scheme GlanceQM \
  -destination 'generic/platform=iOS' -derivedDataPath DerivedData \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM build
xcrun devicectl device install app --device DEVICE_ID \
  DerivedData/Build/Products/Debug-iphoneos/GlanceQM.app
```

Use an existing valid development team. No unrelated bundle ID or certificate replacement is needed. The iPhone must be passcode-unlocked for initial developer-image mounting. Installation succeeded on the tested iOS 27 beta phone after unlock.

## One-time setup

1. In Meta AI, connect the Display glasses and enable Developer Mode for them. Wear them with hinges open.
2. Open kompX → Settings → **Connect with Meta AI**, then approve registration. The app's `glanceqm://connect` deep link opens the same official flow and never starts a microphone.
3. Configure the authenticated bridge using the private connection file below. HTTPS avoids isolated local-network routing problems; `localhost` on the phone means the phone.
4. After registration, the lens presents **kompX / Start**. Tap Start on the lens or phone. It automatically creates/reuses the private meeting; the primary UI requires no room ID.
5. Approve the glasses microphone permission in Meta AI if asked. Only wearer Start requests/starts Speech. **Awaiting speech** means the SDK is listening but has not returned nonempty words in this run.

Speech is experimental and must be available/enabled for the app and compatible glasses in Wearables Developer Center. Development uses MetaAppID `0`; production credentials and release eligibility are not claimed.

The primary path is **Meta Speech from the glasses microphone only**. No failure automatically switches to phone audio. The retained iPhone recognizer is isolated under Advanced connection → Diagnostics / phone test, labelled as test input rather than a glasses demonstration.

## Private connection file

The launcher writes mode-0600 `.local/pairing.json`:

```json
{"serverURL":"https://YOUR_BRIDGE_HOST","operatorToken":"YOUR_LOCAL_TOKEN"}
```

Import via Settings → Advanced connection → **Import connection file**, or transfer to this development app's sandbox:

```sh
xcrun devicectl device copy to --device DEVICE_ID \
  --source /absolute/private/path/pairing.json \
  --destination Documents/pairing.json \
  --domain-type appDataContainer --domain-identifier com.shahdad.glanceqm
xcrun devicectl device process launch --device DEVICE_ID \
  --terminate-existing com.shahdad.glanceqm
```

A fresh launch validates/imports the file, saves the token in Keychain, stores only the URL in preferences, and deletes the sandbox copy. It also replaces a client using the old URL. Do not restart during capture. Tokens never enter links, source, or process arguments.

The tested LAN route failed on the iPhone with `NSURLErrorDomain -1001/-1004`; authenticated HTTPS fixed it. The hostname remains runtime configuration. HTTP Bearer auth and initial-message WebSocket auth remain required through the tunnel.

The verified default keeps the lens visible with Awaiting speech or Listening plus Tasks/Menu. Counters stay in private diagnostics. The advanced Keep lens visible toggle can opt into experimental cleared-display operation; it is not the default until sustained Speech in that mode is verified. The older private `keepDisplayActiveForDiagnostics` connection-file key is retained for compatibility. Neither mode suppresses cues, details, tasks, summary, or action review.

## Lifecycle and behavior

One DeviceSession owns Speech and Display; capabilities attach only after it starts. Tokens/tasks are retained and cancelled on teardown. Selection follows the official DisplayAccess sample: SDK session startup owns connection negotiation, without an app-level connected-link precondition. A single known paired Display can use public SpecificDeviceSelector; otherwise selection is automatic.

Normal mode retains minimal visible status after an actual-listening acknowledgement. Experimental quiet mode calls `Display.clearDisplay()` while Speech remains active. OS microphone indicators are not suppressed. New cues and task/invitation-ready notices briefly appear. Opening detail/tasks/summary/action review holds that view. Rolling summaries do not interrupt active capture. The verified default keeps content visible; cleared-display and locked-phone behavior still need separate tests.

Menu provides lens Pause/End, also available on the phone. End flushes pending transcript before finalization. Invitation confirmation appears after its final preview page and binds to the exact proposal version. A changed proposal resets review. A session stop/disconnect cancels capture intent, including a pending permission return; device availability alone never starts the microphone again.

Quiet means an active DAT session. Waking a terminated app, bypassing Meta lifecycle, or indefinite locked-phone/background capture is not claimed.

## Transcript and transport

Nonempty callbacks share a local segment ID with increasing revisions. Retries preserve ID/revision; repeated identical finals are suppressed. DAT has no utterance ID, so identical final-only utterances cannot be distinguished from duplicate callbacks without an intervening partial. Empty SDK partial callbacks are expected and ignored; a zero latest character count does not erase earlier recognized words.

WebSocket reconnect retrieves a complete snapshot. Failed uploads stop local capture and retain pending updates in memory. A failed flush cannot pause/end the shared meeting and trap the queue behind a closed endpoint. Pending phone updates are not crash-durable. A remote participant ending the meeting can cut off an unfinalized local utterance.

Configuration permits HTTPS and private/local HTTP only. An SDK configuration failure is surfaced without accessing Wearables.shared afterward. An unsigned simulator is not hardware evidence.

## Diagnostics and attribution

`Library/Application Support/GlanceQM/diagnostics.json` in this app's sandbox stores operational states, counters, timestamps, route/host, numeric HTTP/OS errors, SDK session-control error detail, and device don/hinge/thermal state. It excludes tokens, audio, transcript text, attendees, device names, and cue bodies. Retrieve through `devicectl device copy from` with domain `appDataContainer` and identifier `com.shahdad.glanceqm`.

Runtime evidence, the local SDK reference checkout, and build products are ignored by git. [Native attribution](../native/ios/NOTICE.md) identifies official API sources and Meta Developer Terms. The project resolves the pinned remote SPM package; no local SDK copy is required to build.
