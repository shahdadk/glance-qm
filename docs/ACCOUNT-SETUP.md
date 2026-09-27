# Account setup

Provider secrets stay under `~/.config/glance-qm/`, outside this repository,
with directory mode `0700` and secret file mode `0600`. Never paste keys into
chat, commit them, or include them in demonstration output.

Run `node scripts/account-status.mjs` for redacted file/key-name readiness.
This checks local configuration only and does not authenticate or send data.

## Memorable

The isolated CLI is
`~/.config/glance-qm/tools/node_modules/.bin/memorable` (verified version
0.5.30). `pg` is installed beside it for the optional QM Postgres backend.
Set `MEMORABLE_HOME=~/.config/glance-qm/memorable` using an expanded absolute
path in the runtime environment, so demonstration procedures are isolated.

The account is signed in at the Memorable dashboard. Initial inspection found
zero environments. The device flow was approved and the isolated CLI successfully authenticated
and reported an extraction allowance. Local write consent is `read-write`.
Procedure extraction/recall verification is owned by the integration rehearsal.
A device authorization was prepared for hostname
`glance-qm-demo`; its short-lived approval code is provided privately during
setup and is intentionally not retained in this document.

The human approves the device at <https://memorable.sh/dash/device>.
The approved key is saved directly to
`~/.config/glance-qm/memorable.env` as `MEMORABLE_API_KEY`, without logging it.
The approved key was also imported using `memorable login --paste` over stdin;
the CLI stores it under `MEMORABLE_HOME/.memorable/config.json`. Merely setting
`MEMORABLE_API_KEY` did not configure CLI v0.5.30. The isolated local backend
was initialized and enabled. To inspect the configured runtime:

```sh
set -a
. "$HOME/.config/glance-qm/memorable.env"
set +a
"$HOME/.config/glance-qm/tools/node_modules/.bin/memorable" status
```

For the documented QM Postgres backend, also set `MEMORABLE_DB_URL` and
`ORG_ID=glance`, and use `init qm`. Do not infer a Postgres URL from a runtime
using another storage backend. The local backend is supported independently.
Store only minimized, non-secret traces of actual completed work. A successful
CLI status is not evidence of a successful extraction and recall rehearsal.

Sources: [CLI](https://www.memorable.sh/docs/cli),
[extraction/device API](https://www.memorable.sh/docs/api), and
[QM integration](https://www.memorable.sh/docs/qm).

## Google Calendar

The environment has the designated variable names `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN`. A read-only
refresh attempt against Google's token endpoint returned `invalid_grant` on
2026-09-27. A subsequent fresh Calendar-only OAuth login succeeded for the
designated Google account; Google granted `calendar.events` plus
openid/email/profile identity scopes. New refresh credentials were exported
directly into the private `google.env` file. The inherited refresh token remains
stale: load this file before starting the runtime. A fresh official token
refresh and a direct Calendar `events.list` request with `fields=kind` returned
HTTP 200 (`calendar#events`). No event details were logged and no invitation
was sent.

The gws read command inherited an unrelated quota project and returned 403.
The direct REST adapter does not add that quota header and passed the same
read check; no IAM permissions were changed to work around the CLI error.

The direct Calendar adapter accepts a valid Calendar access token. Runtime
refresh credentials belong in `~/.config/glance-qm/google.env`; the adapter
owner wires the refresh callback. Do not reuse a token from a different app
or account without verifying the intended account and existing permission.

Use the narrow scope `https://www.googleapis.com/auth/calendar.events` for
reading and creating events. Sending an invitation remains gated on the
exact current preview, including attendees and event time. Credential setup
never authorizes a test invitation.

The supported gws loopback flow has been started using the designated client
pair and isolated configuration, with only Calendar event and identity scopes.
Human consent completed successfully. For future setup, if Google rejects the
loopback callback, obtain the
designated client's type and registered
redirect URIs. The current environment does not supply that metadata. Save
the existing client JSON as `~/.config/glance-qm/google-client.json` with mode
`0600`, or provide its non-secret type and registered redirect URI. Do not
invent a callback URI or silently create a new OAuth application.

The isolated Google Workspace CLI is
`~/.config/glance-qm/tools/node_modules/.bin/gws`. With a verified Desktop
OAuth client, it supports loopback login and an isolated
`GOOGLE_WORKSPACE_CLI_CONFIG_DIR`. Request only the event scope:

```sh
gws auth login --scopes https://www.googleapis.com/auth/calendar.events
```

Its implementation also requests `openid`, email, and profile identity
scopes. Review the consent screen before approval. The upstream QM bundled
Google connector requests a broader Gmail/Drive/Sheets/Tasks/Calendar bundle,
so it is not the chosen path for this Calendar-only demonstration.

Sources: [Google Workspace CLI authentication](https://github.com/googleworkspace/cli#authentication),
[Google Calendar authorization](https://developers.google.com/workspace/calendar/api/auth),
and [QM Google connector configuration](https://github.com/yc-software/qm/blob/main/src/connectors/oauth.ts).

## Email delivery expansion

The requested PRD email feature uses `gmail.send` only, alongside the existing
Calendar event and identity scopes. Human OAuth approval completed. Tokeninfo verified `gmail.send` and
`calendar.events` plus identity scopes, userinfo verified the designated
account, and Calendar events read returned HTTP 200.
No Gmail read/modify or Drive scope was granted. The runtime file was replaced
atomically after these checks, with its previous version backed up privately
as `google.before-gmail.env` (mode `0600`). Email sending still requires confirmation of the exact recipient,
subject, message, and document preview.

The verified grant populates `GOOGLE_OAUTH_SCOPES` (space-separated exact
scopes) and `GOOGLE_GMAIL_FROM_EMAIL` in the private `google.env` file. These
are readiness metadata; a configured string alone does not prove a valid grant.

No live email was sent during account setup.
