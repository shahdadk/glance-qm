# Reproducing the submission

The submission must contain our application, integration adapters, build commands,
bootstrap scripts, and any upstream patches. Third-party packages and SDKs are
fetched from pinned upstream releases; `node_modules`, SDK binaries, private
credentials, recordings, provider databases, and operator state are not source.
A working machine is not a substitute for these repository artifacts.

## Application from a fresh clone

Use Node.js 22 or newer and npm (QM's separate runtime requires the newer version
specified in [QM setup](QM-SETUP.md)). From the repository root:

```sh
npm ci
npm run check
npm run build
npm run demo
```

`package-lock.json` pins the exact npm dependency graph. The application build
and deterministic fixture tests require no QM checkout, GBrain checkout, model
credentials, recordings, or personal home-directory state. The fixture demo
establishes local behavior only; it is not evidence of model, provider, or glasses
execution.

For an independent copy of the committed submission:

```sh
node scripts/check-reproducibility.mjs
```

The verifier extracts `git archive HEAD` into a temporary directory, installs
with `npm ci`, and runs check/build/demo. Its child processes receive a fresh
empty `HOME` and an allowlist of environment variables; provider credentials and
existing application state are not inherited. npm's download cache may be reused.
No existing runtime is stopped, and no live-provider commands run. Temporary
source is removed by default; `--keep` retains it for inspection.

During development, `--working-tree` copies only allowlisted, Git-visible source
files, including uncommitted implementation. This mode is explicitly **not a
committed-submission receipt**. `--static-only` verifies required files and rejects
machine-local npm dependencies without installing packages. These checks do not
prove Docker bootstrap or iOS signing.

## Provider runtime sources

The live environment needs Docker, separately supplied authorized credentials,
and bootstrap steps described by each integration owner:

| Dependency | Exact source pin | Reproduction authority |
| --- | --- | --- |
| QM | `yc-software/qm` commit `a5a36675041a85e30b9ff3632f678ba36837aabf` | [QM setup](QM-SETUP.md) |
| GBrain | `garrytan/gbrain` commit `e78f1c38b947b053f3a46881340f74f316be855a` | [GBrain setup](GBRAIN-SETUP.md) |
| Meta Device Access Toolkit | Swift package `1.0.0`, revision `1f38beecba83c4c8b5e343540f9cd615323ab19a` | [Meta setup](META-SETUP.md), `native/ios/project.yml`, `Package.resolved` (native submission pending at the verified revision below) |

An external checkout is acceptable as a generated cache only when repository
commands fetch its exact pin and apply every required custom change. Never depend
on a pre-existing `/tmp` checkout, unrecorded edits, or a personal workspace. Keep
generated credentials outside Git and follow the integration setup's secret
handling. Credentials and paid-provider availability are prerequisites supplied
by the operator, not submission source files.

The native project uses remote Swift Package Manager dependencies. Its ignored
`MetaWearablesDAT` inspection checkout and `DerivedData` are not build inputs.
Xcode, Apple signing/provisioning, hardware access, and runtime SDK authorization
remain separate prerequisites. A simulator build is not a glasses receipt.

## Verification record

On 2026-09-27, the default verifier passed against committed application revision
`6f10bb2166f9984ed6a2d997be263b22ed79b5f3`, extracted with `git archive HEAD`.
It used Node 22.15.0, an empty temporary home directory, no inherited provider
credentials, and npm's download cache. It did not copy the working tree,
`node_modules`, external runtime checkouts, databases, or private configuration.

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Passed; 209 packages installed from the lockfile |
| `npm run check` | Passed strict backend/web TypeScript checks and 84 tests in six files |
| `npm run build` | Passed production Vite build, 39 modules |
| `npm run demo` | Passed nine explicitly labeled offline fixture checks; zero calendar sends |
| Local npm dependency/source import checks | Passed |

This validates the committed backend, integration code, fixture rehearsal, and
web application without the operator's hidden configuration. It does not prove
provider availability, external side effects, Docker provisioning, or hardware.
No existing QM, GBrain, backend, web, or device runtime was stopped.

The checked revision contains 73 files and **no native files**. Native source,
its package lock, and its setup document were still awaiting a separate commit.
The Meta pin above records the intended native dependency; this application
verification is not a native clean-clone or hardware pass. Native build and
device acceptance require their own committed-revision receipt.

A bounded scan of that committed tree found no common credential/private-key
patterns or committed private-state/generated-output paths. One historical
absolute workspace path appeared in `docs/JEV.md` only; it is prose, not an
application dependency. This pattern scan is not a comprehensive secret audit.

The provider bootstrap commands are now repository source:

```sh
node scripts/qm-bootstrap.mjs --help
node scripts/bootstrap-gbrain.mjs --dry-run
```

The GBrain owner separately verified a fresh pinned checkout, dedicated new
PostgreSQL volume/runtime, scoped OAuth clients, an idempotent rerun, Linux ARM64
CLI compilation, and authenticated HTTP/MCP initialization. The temporary test
instance was stopped; the primary runtime was preserved. The QM owner verified
prepare-only bootstrap against the existing exact source and cached image;
that is not a separate fresh-machine Docker proof. Consult
[QM setup](QM-SETUP.md), [GBrain setup](GBRAIN-SETUP.md), and
[demo startup](RUN-DEMO.md) for prerequisites and commands.

Live-provider receipts in those integration documents remain distinct from the
application's offline fixture results. Re-run the default verifier after later
application changes; this receipt attests only the exact revision above.
