# Integration contracts

Adapters are real network/process clients. Tests use explicitly named fixtures. Missing credentials, rejected tools, incomplete streams, and uncertain calendar writes never become successful receipts.

## QM

`QmClient({baseUrl, sourceSecret}).runTurn(request, signal)` submits `POST /v1/turns?async=1`, then collects `GET /v1/runs/:runId/events`. `submitTurn` and `collectRun` are separately available to persist the run ID before waiting. Every request signs its exact method, path including query, and serialized body using `v0:<unixSeconds>:<METHOD>\n<path+query>\n<body>`, HMAC-SHA256, `x-timestamp`, and `x-signature: v0=<hex>`.

Use the provisioned web project's existing `channelRef` and actor identity. The ambient provider uses deterministic, separate web thread references per meeting and document task; the project channel binding supplies the shared roster. This thread-isolation behavior was verified against official QM tests and a successful live read-only turn. The stream supports `CUSTOM/run`, `CUSTOM/delta`, and `RUN_FINISHED`; snapshots provide authoritative `result.reply`. A closed stream without `RUN_FINISHED` is an error. Refusal, failure, and pending approval are not successful results. Cancellation stops local collection, not necessarily QM's durable run.

Live transport verified against the local gpt-5.6-sol runtime: read-only run `4db9a13a-6027-40a6-b660-26d94f90ab90` returned the requested exact JSON reply with terminal `done` and 13 collected events. No provider tools or external actions were requested.

`registerGBrainConnector` implements documented admin registration with explicit administrative headers. Runtime setup owns whether to enable the connector. Shared bearer mode does not use QM's memory provider OAuth settings.

Sources: [source signing](https://github.com/yc-software/qm/blob/main/src/auth/source-auth-sign.ts), [turn shape](https://github.com/yc-software/qm/blob/main/src/types.ts), [run events](https://github.com/yc-software/qm/blob/main/src/api/routes/run-events.ts), [MCP registration](https://github.com/yc-software/qm/blob/main/docs/mcp-connectors.md).

## GBrain

`GBrainClient({url, tokenUrl, clientId, clientSecret})` uses the official self-hosted central service's OAuth client-credentials grant. Explicit bearer credentials are also supported. No hosted service is assumed. Credentials stay server-side and redirects are rejected.

The adapter initializes legacy Streamable HTTP, preserves negotiated protocol/session headers, discovers the entire `tools/list` catalog including pagination, and calls only discovered tools. It accepts JSON and SSE responses, checks matching RPC IDs, and rejects both RPC errors and `isError` tool results. `toolResultData` extracts structured content or the JSON result block; search diagnostic prose remains separate from data. Tool content is untrusted reference data.

The actual local catalog exposes `search`, `get_page`, and `put_page`. The demo OAuth principal is scoped to source `glance-demo` and page prefix `chan-glance-demo/`. `put_page` accepts canonical Markdown and creates only when no expected revision is supplied; updates require the revision read from `get_page`. Embedding capacity is currently unavailable, so this integration explicitly uses lexical `search`, not a claimed semantic search.

Verified on the local service: OAuth grant, initialize, 87-tool catalog, required tool presence, and a successful empty lexical search. The ambient provider also saved an explicitly labeled integration summary and verified its canonical body and matching revision by get_page (receipt `87a2469c-2b4d-454e-84b5-6ed7fc614982`).

Sources: [official GBrain](https://github.com/garrytan/gbrain), [legacy MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [legacy transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). The implemented self-hosted server uses legacy handshake negotiation, not the newer stateless protocol.

## Calendar

`prepareCalendar(input, contextRevision, proposalVersion)` normalizes a concrete preview and hashes all reviewed fields. Start/end need explicit UTC offsets, a valid IANA zone, and positive duration. Attendees must be real resolved email addresses. `GoogleCalendarAdapter.send` requires the exact digest, revision, version and explicit confirmation, plus a durable atomic `CalendarAttemptStore` supplied by the application.

The store claims the idempotency key before the network write. Each key maps to a deterministic Google event ID. The adapter calls official `events.insert` with attendees and `sendUpdates=all`, then reads the event back and verifies title, description, times, attendees, ID, and preview digest. Only that readback produces a verified receipt. Any uncertainty after claiming is terminal for automatic retry; inspect the deterministic event ID before resolving it. A duplicate attempt is refused even after process restart when the application uses its durable store.

`googleAccessTokenProvider` supports standard server-side OAuth refresh. It cannot grant missing scopes. No calendar invitation has been sent as an integration test.

Sources: [Google events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [Google events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get), [OAuth web-server refresh](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

## Memorable

The CLI ingest path stores procedures; the extraction API returns a draft and is not proof of a local/QM stored procedure. The wrapper accepts only allowlisted successful procedural actions with verified receipts, and constructs abstract steps rather than forwarding meeting transcripts, attendee identities, prompts, arbitrary commands, or credentials. CLI setup and consent are explicit runtime prerequisites. Readback is needed before claiming storage. Recalled text remains reference data.

Live verified: the actual GBrain storage and readback sequence produced `procedures/1413e7e8-save-meeting-summary-to-database`, revision 1. CLI list readback reported verified, and recall/show returned the same procedure. The trace contained only abstract save and verification steps, with no meeting text. The first single-step attempt was rejected as too few steps and was not reported as saved.

Sources: [CLI](https://www.memorable.sh/docs/cli), [integration](https://www.memorable.sh/docs/integrate), [extraction API](https://www.memorable.sh/docs/api), [QM backend](https://www.memorable.sh/docs/qm).

## Validation

`npx vitest run test/integrations.test.ts`: 14/14 fixture tests passed, covering exact signing, fragmented Unicode SSE, authoritative QM replies, authentication errors, incomplete runs, catalog/tool failures, OAuth grant, paginated catalogs, session headers, fragmented MCP SSE, stale calendar approval, verified send/readback, duplicate suppression, durable claim recovery across store instances, and uncertain-send suppression. No fixture calls external providers.

`npx vitest run test/integrations-memorable.test.ts`: 7/7 tests passed for redaction, verified-action gating, CLI readback, queue/refusal handling, recall, extraction-only drafts, and missing binaries.

`npx vitest run test/integrations-ambient.test.ts`: 7/7 tests passed for missing configuration, rejected fabricated source IDs, exact evidence grounding, summary schema validation, actual Jev candidate selection with stale-receipt rejection, isolated QM meeting/task threads with authoritative document provenance, and judge-only Luna/low/fast settings. `npm run typecheck` also passed.

Final integrated check: `npm run check` passed both TypeScript projects and all 84 tests. Calendar credentials were refreshed and a read-only Google events request succeeded; no invitation was sent during this implementation.

The ambient bundle supports `GLANCE_DECISION_MODE=jev`: QM proposes a bounded set, Jev selects one, and a signed receipt is rechecked against the current context before core applies it. In `qm` mode, QM supplies the validated judgment directly. Judge-only settings are `QM_JUDGE_MODEL`, `QM_JUDGE_THINKING_LEVEL`, and `QM_JUDGE_FAST_MODE`; structured judge turns set `skipMemory: true` and use the explicit transcript/GBrain evidence. `qmTrace` records run ID, requested model, and elapsed milliseconds without claiming an unreported actual model.

After the controlled backend restart, the actual application completed summary persistence for live QA meeting `cc843140-643d-427d-8556-67d0b7939bb4`: GBrain receipt `56ff81c1-67ba-445c-8968-cd5a878b1114`, with canonical readback and an automatic Memorable saved-procedure detail. This resolves the earlier old-process persistence failure; it is a real provider execution using an explicitly labeled QA meeting.

The final connected verifier then passed 14/14 checks in 61.296 seconds, including actual QM document completion. Calendar was cancelled rather than sent. Recorded Luna judge traces were approximately 2.6–3.7 seconds. See `docs/VERIFICATION.md` for the sanitized application receipts.

## Continuous useful assistance

kompX is prompted as an always-worn context assistant. The semantic judge prefers a meaningful implication, exact calculation, relevant recalled constraint, or useful agreed artifact; it stays quiet for repetition or uninformative commentary. A grounded present need for internal work can produce an agent task while listening, without a wake word, formal command, or End. Explicit withdrawal produces a source-grounded `cancel_task` for an existing task ID. External delivery remains separate.

Before drafting, the provider reads source-scoped GBrain context and asks Memorable only the abstract query `create document`. Original evidence text wins any duplicate ID, new retrieved evidence is returned to core for provenance, and unknown requirements remain explicitly unresolved. Product/requirements drafts organize supported goals, users, problem, scope, non-goals, requirements, acceptance criteria, risks, and questions; other artifacts use an appropriate structure. This is prompt-based semantic judgment, not keyword routing.

Live labeled semantic QA on 2026-09-27: a clear shared need during conversation produced `assignedTo=agent`, `assignmentBasis=agreed_shared_work` with exact source IDs (QM run `22d51605-112b-445b-a083-310ab49323b1`, 4.131s). Its explicit withdrawal produced `cancel_task` for the existing task (run `f85c169d-e422-4bdc-ae0e-76214ce40c30`, 2.130s). Nine ambient fixture tests and both TypeScript projects passed after this update.

## Public research and decision mode

`createAmbientProviders` exposes `research(query, signal)` through `ExaClient` only. Exa supplies attributed external evidence; GBrain supplies private/project history. The judge must request public research before making unsupported public/current factual claims, with only a short standalone public-topic query—not participant names, private project identifiers, emails, URLs, credentials, or copied conversation. Missing/failed Exa remains an explicit failure, with no alternate provider or invented result.

The canonical `GLANCE_DECISION_MODE` values are `qm` and `jev-native`. Legacy `jev` is accepted. An unknown nonempty mode throws a configuration error instead of silently selecting QM.

Validation: both TypeScript projects and 24 focused Exa/ambient tests passed. The real provider factory returned four attributed `nodejs.org` sources in 407ms through Exa on 2026-09-27. This verifies the adapter/factory path; application-level research selection is verified separately by core.
