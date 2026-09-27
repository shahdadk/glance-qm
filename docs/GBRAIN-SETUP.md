# Self-hosted GBrain for Glance QM

GBrain is running locally, with real OAuth-authenticated MCP reads/writes backed
by a dedicated PostgreSQL/pgvector database. No gbrain.io account is used.

## Provenance and pin

- Official source: https://github.com/garrytan/gbrain
- Checkout: `e78f1c38b947b053f3a46881340f74f316be855a`, version `0.59.0.0`.
- License: MIT; copied notice at `integrations/gbrain/UPSTREAM-LICENSE`.
- Official deployment reference: `docs/integrations/qm-harness.md` in that checkout.
- `integrations/gbrain/tool.json` is copied unchanged from upstream
  `docs/integrations/qm-harness-snippets/tool.json`.
- The local proxy, wrapper, service scripts, and project skill are Glance QM code.
- Source checkout is outside this repository at
  `~/.local/share/glance-qm/gbrain-source`; no private memories were imported.

## Reproduce from a fresh repository clone

Prerequisites: Node.js 22+, Git, Python 3, Bun 1.3.11+, and a running Docker
Engine (Docker Desktop, Colima, or Linux Docker). No existing GBrain checkout,
provider account, API key, or memory files are required. Docker/Bun installation
is a machine prerequisite; this script does not change global services.

```sh
node scripts/bootstrap-gbrain.mjs --dry-run
node scripts/bootstrap-gbrain.mjs
python3 scripts/gbrain-service.py status
```

The bootstrap fetches the exact public GBrain commit in
`integrations/gbrain/runtime.json`, installs its frozen lockfile, pulls the pinned
pgvector image digest, creates a dedicated persistent database, initializes the
schema, and creates all three source-scoped OAuth clients. It generates fresh
random DB/client secrets in an owner-only runtime directory. It starts the
loopback HTTP service. Re-running preserves the database and client secrets;
it migrates schema and converges source/write grants. A mismatched or modified
existing source checkout is refused, never overwritten. Existing unrelated
Docker containers are also refused. Progress output is sanitized; raw bootstrap
output lives in private `bootstrap.log`, which can contain one-time credentials
and must never be published.

Keyword-only retrieval is an explicit reproducible default, so setup needs no
embedding quota. Existing configured provider data is not imported. The
bootstrap performs no private-data seed or external message action.

Default state paths are under `~/.local/share/glance-qm/`. Override
`GLANCE_GBRAIN_SOURCE`, `GLANCE_GBRAIN_RUNTIME`, `GLANCE_GBRAIN_PORT`,
`GLANCE_GBRAIN_PG_PORT`, `GLANCE_GBRAIN_PG_CONTAINER`, and
`GLANCE_GBRAIN_PG_VOLUME` to create a completely separate instance. When using
custom runtime paths, pass the same `GLANCE_GBRAIN_RUNTIME` to the service and
host scripts. `BUN_BIN` and `DOCKER_BIN` can select installed executables.
Standard `DOCKER_HOST`, `DOCKER_CONTEXT`, and `DOCKER_CONFIG` are honored;
otherwise the dedicated `glance-qm` Colima socket is used if present, falling
back to the normal Docker connection. Its private Docker config avoids stale
Desktop credential-helper settings when using the explicit Colima socket.

Optional sandbox CLI reconstruction needs no hidden build artifact:

```sh
node scripts/bootstrap-gbrain.mjs --build-cli
```

This compiles the pinned upstream entrypoint for Linux ARM64 and assembles
`<runtime>/tool/` with `gbrain` (wrapper), `gbrain-bin` (official executable),
`loopback-proxy.mjs`, `tool.json`, and `SKILL.md`. Credentials are not included
in that bundle. Install this directory through the QM deployment tool mechanism,
then provision the intended scope as described below. `--no-start` performs
provisioning without launching or stopping any HTTP service.

## Running configuration

| Component | Value |
| --- | --- |
| Host MCP | `http://127.0.0.1:3131/mcp` |
| OAuth token endpoint | `http://127.0.0.1:3131/token` |
| Discovery | `http://127.0.0.1:3131/.well-known/oauth-authorization-server` |
| Health | `http://127.0.0.1:3131/health` |
| DB engine | PostgreSQL 16 + pgvector, schema 165 |
| DB container | `glance-qm-gbrain-postgres` |
| DB loopback port | `55440` |
| DB persistent volume | `glance-qm-gbrain-data` |
| ARM64 image | `pgvector/pgvector:pg16` |
| Image digest at setup | `sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b` |
| Isolated runtime directory | `~/.local/share/glance-qm/gbrain-runtime` |
| Source / shared write prefix | `glance-demo` / `chan-glance-demo/` |

This uses the existing dedicated `glance-qm` Colima VM. Docker commands use
`DOCKER_HOST=unix://$HOME/.colima/glance-qm/docker.sock` and
`DOCKER_CONFIG=$HOME/.config/glance-qm/docker`. The GBrain database has a 768 MB
container memory limit; QM has its own separate PostgreSQL database and volume.

```sh
python3 scripts/gbrain-service.py start
python3 scripts/gbrain-service.py status
# Stop only the owned GBrain HTTP process:
python3 scripts/gbrain-service.py stop
```

The service runs `bun <official-checkout>/src/cli.ts serve --http --bind
127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131`. No launchd service or
hostwide settings were changed. Start the dedicated Colima VM and database first
if the computer has restarted. Logs and PID are inside the private runtime dir.

## Credentials and source boundaries

The runtime directory is mode 0700. These JSON files are mode 0600 and must never
be checked into Git or emitted in logs:

- `backend-oauth.json`: shared project service, `chan-glance-demo/` writes.
- `alice-oauth.json`: `emp-alice/` and `chan-glance-demo/` writes.
- `bob-oauth.json`: `emp-bob/` and `chan-glance-demo/` writes.

Each JSON has `url`, `tokenUrl`, `clientId`, and `clientSecret`. The host DB
credential lives separately in `host.env` / `postgres.env`; never give it to QM
sandboxes. All three clients have only OAuth `read write` scopes and federated
read access to source `glance-demo`. Clients were created with supported CLI:

```sh
scripts/gbrain-host.sh sources add glance-demo --name 'Glance QM shared demo memory'
scripts/gbrain-host.sh auth register-client glance-demo-backend \
  --grant-types client_credentials --scopes 'read write' \
  --source glance-demo --federated-read glance-demo \
  --bound-slug-prefixes chan-glance-demo/
```

The registration command prints a one-time secret: capture its output into a
private file, never normal logs. Alice/Bob were separately registered with their
own personal prefix plus the shared prefix. Reads are source-granular, not
prefix-private: every authorized participant can read all of `glance-demo`.
The shared service credential does not impersonate a human identity.

## MCP contract verified against the live catalog

Exchange credentials by POSTing form-urlencoded `grant_type=client_credentials`,
`client_id`, and `client_secret` to `/token`. Keep returned bearer tokens server
side and renew them after expiry. MCP supports `initialize`,
`notifications/initialized`, `tools/list`, and `tools/call`; accept
`application/json, text/event-stream`.

- `put_page`: `{slug, content, source_id?}`. `content` is complete Markdown with
  YAML frontmatter. Omit revision for create-only; replacement requires
  `expected_revision` from `get_page`, or an explicitly intended `force:true`.
  `request_id` may hold a stable UUID to recover a timed-out write safely.
- `get_page`: `{slug, source_id?, include_content?:true}`. Result includes
  `revision`, `compiled_truth`, provenance, and optionally canonical `content`.
- `search`: `{query, limit?, source_id?}`. Results include slug/title/chunk text,
  source, score, and evidence metadata.
- `whoami`: reports effective scopes, source and prefix grants.

The complete live discovery receipt is private local
`gbrain-runtime/tool-catalog.json`, with no credentials.

## QM sandbox CLI

The backend can call MCP directly through its OAuth client. Official GBrain also
supports QM's agent CLI integration. The compiled Linux ARM64 binary is
`gbrain-runtime/gbrain-linux-arm64`, built with:

```sh
bun build --compile --no-compile-autoload-bunfig --target=bun-linux-arm64 \
  --outfile /path/to/gbrain-linux-arm64 src/cli.ts
```

Install the binary as `gbrain-bin` beside `integrations/gbrain/gbrain` and
`loopback-proxy.mjs`. Advertise `tool.json` and the project `SKILL.md`. Do not bake
credentials into an image. The wrapper starts a private sandbox loopback proxy
from port 3131 to `host.lima.internal:3131`, preserving the official issuer URLs
without exposing the host service on the LAN. This is needed because discovery
advertises loopback URLs; reaching the MCP URL alone is insufficient for OAuth.

Provision each intended scope with the official supported CLI (secrets delivered
through the runtime credential boundary, never command logs):

```sh
gbrain init --mcp-only --issuer-url http://127.0.0.1:3131 \
  --mcp-url http://127.0.0.1:3131/mcp \
  --oauth-client-id "$GBRAIN_CLIENT_ID" \
  --oauth-client-secret "$GBRAIN_CLIENT_SECRET"
gbrain whoami
```

The credential becomes scope-local `.gbrain/config.json`. A shared project uses
the backend client; separate personal scopes use their own clients. The wrapper
and CLI were verified in an ephemeral `qm-sandbox-local:latest` container. The
existing live QM project sandbox was not modified by this task.

## Verification on 2026-09-27

Real service checks passed, using an explicitly synthetic meeting fixture:

1. OAuth credential exchange, MCP initialize, and live tool discovery.
2. `put_page` committed `chan-glance-demo/samples/runtime-restart-check` with
   revision `f878023c-7c9f-451d-84e7-181f355a0728`.
3. `get_page` and search for `Orchid` returned the attributed sample summary.
4. HTTP server stopped/restarted: same content and revision returned.
5. Dedicated GBrain PostgreSQL container restarted: same revision returned from
   the persistent volume.
6. Alice writing `emp-bob/...` was denied. Explicit reads outside `glance-demo`
   were denied. Bob could read the shared sample summary.
7. Official Linux ARM64 CLI in the QM sandbox image successfully ran thin-client
   init (discovery + token + MCP), `whoami`, and `search Orchid`.

A second clean source checkout, runtime directory, Docker container, and volume
were then provisioned with `bootstrap-gbrain.mjs` on ports 3132/55441. Fresh
setup, an idempotent rerun, optional Linux ARM64 CLI compilation, HTTP start,
OAuth credential exchange, and authenticated MCP initialization all passed.
The main port-3131 service stayed running throughout; the temporary verification
instance was stopped afterward. The pinned upstream checkout has no tracked
patches.

Private raw receipts are in `gbrain-runtime/*-receipt.json`. The fixture is
marked sample in its title/body and is not a claim about a real meeting.

## Actual limits

Both existing embedding provider keys were tested: OpenAI embeddings returned
HTTP 429, and Gemini embeddings returned HTTP 429 `RESOURCE_EXHAUSTED`. Setup
therefore explicitly selected `search.mcp_keyword_only=true` and conservative
search mode. Durable writes and PostgreSQL keyword recall work; semantic/vector
recall is not currently verified. Embedding jobs may remain queued. Once quota
is available, revalidate the chosen embedding provider, embed stale content, and
turn off keyword-only mode before claiming semantic recall.

This is database-only canonical storage in a persistent Docker volume. GBrain
correctly reports no Markdown write-through because no git-backed source is
configured. Container restart durability is proven; this is not an off-device
backup, nor a full export/import recovery rehearsal. TLS/public hosting, source
privacy beyond the documented shared source, and live participant credential
injection into QM personal sandboxes are not claimed.
