# Run the real demo

The desktop companion uses Vite on port 5174 and a bearer-authenticated backend on port 8790. QM and GBrain remain separate durable local services. The launcher checks the real authenticated QM project and GBrain MCP catalog before reporting readiness. Normal startup opens no public tunnel. The explicitly invoked HTTPS fallback below exposes only the existing authenticated backend.

## Existing setup

```sh
npm ci
node scripts/start-demo.mjs
```

The launcher typechecks the backend, creates the operator token once using the application's existing owner-only token loader, and starts on loopback first with an empty private preflight store, so checking authentication does not resume meeting jobs twice. It requires an unauthenticated protected request to return 401 and an authenticated request to reach the app before restarting that owned process on the configured interface. The default interface is `0.0.0.0` for a phone on the same LAN. Set `HOST=127.0.0.1` for desktop-only use.

It prints the desktop URL, the native LAN URL, and secret **file paths**, never token values. It reuses an already running Vite surface without assuming ownership. Only processes started by this launcher are recorded in `.local/demo-processes.json`.

Open `http://localhost:5174`. The web UI asks for the operator token; its private file is `.local/operator-token`. A caller-supplied `GLANCE_OPERATOR_TOKEN` is persisted separately as `.local/operator-token.launch`. Both are mode 0600. Do not paste tokens into URLs or source files.

## iPhone pairing

Connect the Mac and iPhone to the same reachable LAN. Import `.local/pairing.json` through the native companion's development file-import flow described in [META-SETUP.md](META-SETUP.md). It contains `serverURL` and `operatorToken`, uses mode 0600, and is ignored by Git. Transfer it only through the documented local development/app-container workflow; it is a credential, not a shareable demo artifact. Alternatively, enter the LAN URL and token in the native Settings pairing form. Do not use a token-bearing deep link.

The launcher selects an IPv4 address on a physical `en`, `eth`, or `wlan` interface. If the phone uses a different network, set `GLANCE_LAN_IP` to the correct Mac LAN address and rerun the launcher. If local-network permission is requested on iPhone, allow the companion to reach the backend. A browser's CORS allowlist is distinct from native transport authentication.

## Fresh clone: QM

Install the repository's npm dependencies first. QM requires Node >=24.15 and npm >=11.10; the helper can install Homebrew Node24, Docker CLI, and Colima on macOS when `--install-tools` is explicitly supplied.

```sh
npm ci
node scripts/qm-bootstrap.mjs --install-tools --start
```

This tracked bootstrap:

1. Clones upstream `yc-software/qm` outside the submission into `~/.cache/glance-qm/qm` and checks out exact commit `a5a36675041a85e30b9ff3632f678ba36837aabf`.
2. Creates `~/.config/glance-qm/runtime.env` with a random source signing secret and mode 0600, preserving existing configuration.
3. Starts a dedicated `glance-qm` Colima profile if needed, without activating it as the global Docker context. Existing Docker/Colima services remain untouched.
4. Rejects dirty tracked upstream files, reinstalls pinned dependencies with `npm ci` on every bootstrap, and builds the real upstream sandbox Dockerfiles natively for the daemon architecture. No upstream source patch is required.
5. Runs the official web dev-instance launcher with real Codex turns and durable PostgreSQL, provisions the two demo principals/shared project through supported APIs, and verifies a real model completion.

Supply an authorized `OPENAI_API_KEY` through the shell or an existing authorized local Codex OAuth login. Provider secrets are never copied into Git. `QM_SOURCE_DIR`, `QM_RUNTIME_ENV`, and `QM_NODE_BIN` select alternate paths. Running without `--start` prepares the pinned checkout, private config, and image without starting or replacing the QM service.

The original `/tmp/glance-qm-upstream` checkout was lost during a host reboot. The restored instance uses `~/.local/share/glance-qm/qm-source`, retaining its existing signing secret, project, and database volumes. Fresh installations default to the persistent user cache. If an existing upstream launcher has modified tracked dependency lockfiles, the bootstrap refuses that dirty checkout; select a fresh `QM_SOURCE_DIR` for reproduction instead of modifying the running instance. Do not remove a running instance's source checkout. See [QM-SETUP.md](QM-SETUP.md) for reboot recovery.

## Fresh clone: GBrain and optional providers

Follow [GBRAIN-SETUP.md](GBRAIN-SETUP.md) for its pinned source, dedicated PostgreSQL database, OAuth clients, and seed data. The launcher expects an already running authenticated central service and defaults to `~/.local/share/glance-qm/gbrain-runtime/backend-oauth.json`. It checks actual OAuth and MCP tools; a configured URL alone is insufficient. Use the setup commands in that runbook and tracked GBrain service scripts; [ACCOUNT-SETUP.md](ACCOUNT-SETUP.md) covers optional provider authentication.

The launcher reads only allowlisted configuration from:

- `~/.config/glance-qm/connection.json` and `runtime.env` for QM.
- `GBRAIN_CONFIG_FILE` (default above) for GBrain OAuth.
- `~/.config/glance-qm/memorable.env`, `google.env`, `jev.env`, and `demo.env` when present.
- The repository's ignored `.env` and explicit process environment overrides.

The app launcher defaults structured judgment/proposals to `QM_JUDGE_MODEL=gpt-6-luna`, `QM_JUDGE_THINKING_LEVEL=low`, and `QM_JUDGE_FAST_MODE=true`; document and summary work retain the separately configured QM model. These are app per-turn settings, not global QM model changes. A tiny read-only live probe completed in 2.479 seconds; full meeting latency depends on context and workload.

The default GBrain tool bindings are `search`, `put_page`, and `get_page`; names can be overridden explicitly. Memorable, Google Calendar, and Jev configuration is passed only under named allowlisted variables, and their presence is not reported as a successful live action.

Freshly approved Google credentials in private `google.env` supersede stale inherited OAuth values from the login shell. Set `GLANCE_USE_GOOGLE_SHELL_ENV=1` only when deliberately selecting different exported Google credentials. Calendar writes still require confirmation of the exact current proposal in the app; startup never sends invitations.

## Restart and stop

Provider settings are loaded at backend startup. After changing provider config or backend implementation, restart the owned app processes:

```sh
node scripts/stop-demo.mjs --backend-only
node scripts/start-demo.mjs
```

`stop-demo.mjs` verifies each recorded PID's start time and exact command before signalling it. It preserves pre-existing Vite, QM, GBrain, Docker, database volumes, and the separate Glance service on 8787. It refuses stale or mismatched ownership records. A changed config causes `start-demo.mjs` to request this explicit restart rather than replacing another process.

Use `--backend-only` for a backend update to preserve the running tunnel and
phone pairing URL. Omitting the flag also stops the recorded frontend and
tunnel. During a provider outage, `start-demo.mjs --recover-backend` explicitly
restores app transport and direct research without claiming QM/GBrain readiness;
run the normal launcher after provider recovery to verify their connections.

Private logs are `.local/demo-backend.log`, `.local/demo-web.log` if the launcher owns Vite, and `.local/demo-typecheck.log`. The public `/api/health` endpoint contains nonsecret readiness labels. Authenticated project/MCP preflight establishes connectivity; only completed integration receipts establish successful model, memory, document, or calendar work.

## Update the backend without interrupting the phone tunnel

When the native session is paused and a backend update is ready, use:

```sh
node scripts/stop-demo.mjs --backend-only
node scripts/start-demo.mjs
```

The backend-only flag preserves owned Cloudflare and Vite processes and their ownership records. Startup reuses the same live HTTPS URL and operator token, while recovering durable meetings from the existing store. Do not delete `.local` or replace the pairing file during an update. Confirm the native capture is paused before coordinating a restart. Recheck `node scripts/tunnel-demo.mjs`; optionally set `GLANCE_TUNNEL_TEST_MEETING_ID` to the existing paused meeting to verify its authenticated WSS snapshot without logging its transcript.

## Verify the connected flow

After the live backend is ready, `node scripts/verify-live.mjs` creates synthetic QA meeting/provider data and exercises recall, a grounded cue, a correction, a calendar preview, summary persistence, and document work. It never confirms or sends a calendar invitation. The script records sanitized results in `docs/VERIFICATION.md`; failed checks remain visible. This connected check is distinct from the credential-free fixture command `npm run demo`.

The web companion is a desktop development surface. Its default loopback URL and single-operator credentials are not a remote participant identity or proof of multiplayer app authentication. The native Meta companion connects to the separately authenticated LAN backend; QM's two demo principals establish shared QM session behavior.

## HTTPS fallback when the phone cannot reach LAN

Run `node scripts/tunnel-demo.mjs` after the backend is healthy. This starts one recorded Cloudflare Quick Tunnel to `http://127.0.0.1:8790`; it does not touch another tunnel or the separate Glance service. It checks local authentication before publication, then verifies external HTTPS health 200, invalid bearer 401, and WebSocket upgrade with initial-message authentication rejection 4401. Set `GLANCE_TUNNEL_TEST_MEETING_ID` to an existing meeting ID to additionally verify an authenticated snapshot through external WSS without logging its contents. It updates `.local/pairing.json` to the temporary HTTPS URL while retaining the exact existing operator token. Re-import that private file on the phone.

Quick Tunnel hostnames are temporary and have no uptime guarantee. Keep this owned process running during the demo. Re-running the helper reuses its recorded live tunnel; it does not rotate a healthy URL. `stop-demo.mjs` stops the recorded tunnel alongside its owned backend; starting a replacement tunnel requires importing the new pairing URL. Regular `start-demo.mjs` preserves the verified HTTPS pairing while its owned tunnel remains live.

The Mac's default resolver temporarily returned NXDOMAIN for newly allocated hostnames during setup. The helper verifies public records using 1.1.1.1/8.8.8.8 and validates HTTPS certificates normally; it never changes system DNS. The phone must still resolve the hostname through its own network. There are no tokens in the URL. Application credentials remain in the bearer header or the WebSocket's first authentication message. External SSE is not used.

Cloudflare's [Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) describes the temporary development service and its limitations.
