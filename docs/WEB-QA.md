# Glance companion verification

Run `npm run dev:web`. The browser uses port 5174 with a same-origin `/api` proxy to the local runtime on 8790.

## Final product direction

The main surface is a simple Glance companion: listening status, one useful thought, and Now / Tasks / Summary views. Starting a conversation creates or resumes the current meeting internally. There is no meeting-ID entry, dashboard, provider panel, or manual transcript column in the main flow. Sharing passes an opaque session ID in a link. Pairing and diagnostics live under Settings → Advanced.

The actual Meta glasses app and device audio are separate native surfaces; the browser never claims device connection or delivery.

## Capabilities

- One-time token pairing, stored in this browser tab's sessionStorage. HTTP Bearer auth and initial WebSocket auth; no credentials in URLs.
- Automatic current-session restoration, explicitly started microphone, pause/resume, and finish/summary.
- Browser speech recognition sends final text sequentially; interim speech stays local. Connection loss and stopped/ended sessions stop capture.
- Stable cue and source details; shared questions/corrections; tasks and downloadable documents; summary.
- Exact calendar preview with timing, time zone, recipients, description, and version-bound explicit confirmation. Uncertain delivery is visible and never automatically retried.
- Advanced labeled manual input, transcript, provider configuration, and persisted runtime warnings retained for diagnostics.

## Verification performed

- `npx tsc -p web/tsconfig.json` — passed after the simplified companion change.
- `npx vite build --config web/vite.config.ts` — passed; production JS approximately 299 kB / 89 kB gzip.
- Native Chrome guest profile via CUA: connected using the local token, transferred through native TextEdit/clipboard without emitting its contents. Token clipboard was replaced with the non-sensitive conversation URL afterward.
- Created QA session `50c63424-1ceb-4c03-bcbf-8089216ba819` before the UI simplification. Real HTTP + WebSocket authentication and snapshot loading passed.
- Paused and resumed the real backend session; microphone control correctly disabled when paused.
- Added labeled manual transcript: “We have 48 customer interviews to complete over 6 weeks. How many interviews do we need each week?” Real backend returned a sourced arithmetic cue with result 8. The provider label duplicated the number in presentation; reported to core, which is tightening quantity-label prompting.
- Inspected the simplified actual Chrome screenshot: no meeting IDs or provider/debug panels in main content, a single stable cue, source disclosure, listening control and question input.
- Clicked Start listening, accepted Chrome's one-visit microphone permission, and observed both browser “Microphone recording” and app “Listening” state.
- Sustained Chrome “Microphone recording” and app “Listening” for approximately two minutes, then Pause listening turned the microphone off and paused the runtime. No capture-state errors occurred.
- Switched to Tasks and Summary while capture stayed active. The live runtime produced a summary of the 48 interviews / 6 weeks discussion and a next step of 8 interviews per week; Summary rendered it correctly without manual end.

- Mobile and keyboard checks completed: 390 px responsive viewport in native Chrome DevTools, no visible horizontal overflow, and Tab moved from Now to Tasks with a clear white focus outline.

## Remaining checks / limits

- Real spoken-audio transcription remains unverified: the controlled test had no deliberate spoken utterance and produced no browser final segments.
- Task/document rendering and end-of-meeting finalization against the current live runtime.
- Calendar UI confirmation behavior against an isolated fixture; no external invitation will be sent during QA.
- This is Web Speech, not raw PCM streaming. Browser/provider support varies. Native glasses capture is not validated by these checks.
- Browser share links use the current origin. With the default localhost binding, they are local-machine companion links, not public multiplayer links. The runtime currently authenticates a single operator. Native device LAN access is a separate configured path.

- Typed correction while paused saved successfully (revision 5), but the running pre-fix backend did not produce a cue. Core added paused explicit-input processing; it awaits coordinated runtime restart and retest.
