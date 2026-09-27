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
| Meta Device Access Toolkit | Swift package `1.0.0`, revision `1f38beecba83c4c8b5e343540f9cd615323ab19a` | [Meta setup](META-SETUP.md), `native/ios/project.yml`, committed `Package.resolved` |

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

On 2026-09-27, the first isolated working-tree source copy passed `npm ci`, strict
TypeScript checks, test execution, and the Vite production build with Node
22.15.0. Its `npm run demo` failed because `src/demo.ts` had not yet been supplied
by the implementation worker. This is an intermediate result, not final acceptance.

The GBrain owner has added `scripts/bootstrap-gbrain.mjs` and
`integrations/gbrain/runtime.json` to fetch its exact commit, install with a frozen
lockfile, and provision its dedicated database and OAuth clients. Its isolated
fresh-runtime verification is in progress. QM bootstrap is also being implemented;
consult its setup document for the final command and verification result.
The final acceptance run must recheck both bootstrap paths and rerun the
committed-HEAD verifier after all implementation is committed. Runtime receipts in integration
docs describe actual service checks separately from fixture test results.
