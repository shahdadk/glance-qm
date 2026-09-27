# Real QM development runtime

Glance runs against upstream [yc-software/qm](https://github.com/yc-software/qm), pinned to commit `a5a36675041a85e30b9ff3632f678ba36837aabf` (package version `0.1.0`). The upstream checkout stays outside this submission at `~/.local/share/glance-qm/qm-source`. Do not remove it while the demo runs: QM's supervisor retires an instance whose checkout disappears. The previous `/tmp` checkout was lost on a host reboot; use a persistent source path.

## Verified local instance

- Core API: `http://localhost:9081`
- QM portal: `http://localhost:9129`
- Admin: `http://localhost:9129/admin/`
- Native web surface: `http://localhost:9097`
- Org: `glance`; dev-instance lease: `pool1`
- Harness: real `codex`, configured model `gpt-5.6-sol`; automatic local ChatGPT OAuth discovery and the exported OpenAI API key are available. Mock mode is disabled.
- Session and run persistence: PostgreSQL 16, container `glance-qm-postgres`, host port `55439`, volume `glance-qm-postgres-data`.
- Runtime environment/signing secret: `~/.config/glance-qm/runtime.env` (0600, outside Git).
- Sanitized connection metadata: `~/.config/glance-qm/connection.json`.
- Latest model verification receipt: `~/.config/glance-qm/verification.json`.

The initial live run `e2487ffd-aae4-4c3d-9c37-a924245c5635` completed with `QM_LIVE_OK`, `status: ok`, and SSE `RUN_FINISHED`. Shared project session: `ae338a14-68fd-40a2-bcec-255cd8c5e9b5`.

Additional live checks passed:

- Teammate run `e947d4d1-4f7c-4eec-b689-e640cd5e344f` recalled the founder's verification marker from the same durable shared session.
- Model-to-sandbox run `ad7e08e7-45e2-4e52-8ce4-0261124f6fae` emitted an `execute` tool call, returned stdout `QM_SANDBOX_EXEC_OK` with exit code 0, and completed successfully.
- The upstream `npm run smoke:local-sandbox` passed cold provisioning, shell execution, persistent file survival across warm restart, scratch execution, and cleanup on native ARM64.

## Runtime control

From this repository:

```sh
scripts/qm-runtime.sh status
scripts/qm-runtime.sh doctor
scripts/qm-runtime.sh up --surface web
scripts/qm-runtime.sh logs core
node scripts/qm-provision.mjs
node scripts/qm-verify.mjs
```

After a host reboot, restore the dedicated VM before starting the application.
The existing project, signing secret, and database volumes must be preserved:

```sh
QM_SOURCE_DIR="$HOME/.local/share/glance-qm/qm-source" node scripts/qm-bootstrap.mjs
scripts/qm-runtime.sh up --surface web
python3 scripts/gbrain-service.py start
node scripts/start-demo.mjs
node scripts/tunnel-demo.mjs
```

The bootstrap without `--start` restores the pinned checkout and dependencies;
it does not provision a new project. The temporary tunnel hostname changes if
its process died during reboot, so import the regenerated private pairing file
on the phone. Provider configuration in `/api/health` is not a connectivity
receipt; the normal launcher verifies authenticated QM/GBrain readiness.

If the VM is still recovering, `node scripts/start-demo.mjs --recover-backend`
can restore speech transport and direct Exa/Jev cards first. It preserves normal
authentication and process-ownership checks, but explicitly skips QM/GBrain
connectivity preflight and records that limitation in local process state. QM
summaries and GBrain writes remain unavailable until their services recover.
Run the normal launcher again after recovery to verify those connections.

`up` uses the official upstream dev-instance launcher, reloads changed environment, and preserves the durable database. The upstream doctor compares the entire inherited shell environment and currently reports an environment-drift warning even immediately after a successful reload; all core/web/portal, Git, and Docker checks are healthy. This warning has not prevented verified model or sandbox execution. `down` stops only this QM lease:

```sh
scripts/qm-runtime.sh down
```

Leave the runtime running for the hackathon. The shared Colima VM may also host GBrain; do not stop/delete it or remove volumes as part of ordinary QM shutdown.

## Shared scope and participants

The provisioning script uses supported source-authenticated `/v1/directory`, `/v1/projects`, and project-members endpoints. It creates two internal demo participants, `glance-founder` (Shahdad) and `glance-teammate` (Teammate), and a project named **Glance Shared Meeting**. The second identity is a demo participant, not a claim that a teammate has authenticated.

The local project ID is `7d7b1b44-7332-4f1a-8050-60364fe17212`. Its conversation uses `kind: group`, `channelRef: web-project-7d7b1b44-7332-4f1a-8050-60364fe17212`, and `threadRef: web:glance-founder:meeting:7d7b1b44-7332-4f1a-8050-60364fe17212`. Read fresh values from `connection.json` rather than hardcoding these IDs in application code. QM requires a new web thread to start with the creator's `web:<principalId>:` prefix.

## Authentication and turn receipt

The server-side source client in `integrations/qm/source-client.mjs` follows the upstream signer exactly. The signature is `v0=` plus HMAC-SHA256 over `v0:<unix-seconds>:<METHOD>\n<path-including-query>\n<raw-body>`, sent in `x-signature`, alongside `x-timestamp`. Never send this signing secret to a browser or glasses client.

Submit a real asynchronous turn with `POST /v1/turns?async=1`. The body includes the surface, actor's external ID, group conversation, and text. A successful submission returns `202`, `status: queued`, and `runId`. Read signed `GET /v1/runs/<runId>/events` as SSE; inspect the terminal `CUSTOM/run` result and `RUN_FINISHED`. Queuing alone is not proof of model execution.

## Infrastructure and fresh-machine reproduction

Installed versions: Homebrew `node@24` 24.21.0 (npm 11.19.0), Docker CLI 29.8.0, Colima 0.10.3. Node 24 is selected only in the QM wrapper; the system default Node was not relinked.

Colima profile `glance-qm` uses 4 CPU, 6 GiB RAM, a 20 GiB sparse data disk, and a 12 GiB sparse root disk. Docker connects through `unix://$HOME/.colima/glance-qm/docker.sock` with a dedicated empty Docker config at `~/.config/glance-qm/docker`. This avoids an existing machine-level Docker Desktop credential helper entry without editing it.

For a fresh machine, install a supported Node >=24.15/npm >=11.10 and Docker daemon, clone the exact upstream commit outside the submission repo, and run `npm ci` there. Create an owner-only runtime env file with a freshly generated 32-byte random `CORE_SIGNING_SECRET`, `HARNESS=codex`, `CODEX_MODEL=gpt-5.6-sol`, appropriate Docker connection variables, and the port/org/lease values above. Supply an authorized OpenAI API key through the shell or use QM's documented local Codex OAuth discovery; do not put provider keys in this repository. Then run `scripts/qm-build-sandbox.sh`, `scripts/qm-runtime.sh up --surface web`, provisioning, and verification.

The sandbox build wrapper uses upstream `fly/Dockerfile` and `local/Dockerfile` unchanged, selecting the daemon's native architecture and the upstream fingerprint label. On this Apple Silicon host, the upstream convenience build's forced amd64 image crashed under QEMU after Rosetta installation failed. Native ARM64 builds avoid that emulation failure while retaining the real upstream sandbox.

Upstream setup authority: [dev-instance skill](https://github.com/yc-software/qm/blob/a5a36675041a85e30b9ff3632f678ba36837aabf/.claude/skills/dev-instance/SKILL.md), [source signer](https://github.com/yc-software/qm/blob/a5a36675041a85e30b9ff3632f678ba36837aabf/src/auth/source-auth-sign.ts), [project routes](https://github.com/yc-software/qm/blob/a5a36675041a85e30b9ff3632f678ba36837aabf/src/api/routes/projects.ts), and [turn routes](https://github.com/yc-software/qm/blob/a5a36675041a85e30b9ff3632f678ba36837aabf/src/api/routes/turns.ts).
