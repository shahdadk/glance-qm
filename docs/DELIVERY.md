# Document delivery

The Gmail adapter delivers an existing Markdown artifact as an attachment. It
does not ask a model to send email, read a model-provided path, manufacture a
document URL, or claim that Gmail accepted mail until Gmail returns a message
ID. This path works for any prepared Markdown document, including a PRD.

## Approval boundary

`prepareDocumentDelivery(input, contextRevision, proposalVersion)` produces a
canonical preview. Its digest includes the exact UTF-8 document content and
SHA-256, task/artifact IDs, generation, finalized context digest, single recipient address and optional name, subject,
body, attachment filename/content type, context revision, and proposal version.
Use a generation-specific artifact ID, such as `taskId:generation`.

The authenticated wearer must inspect the recipient and exact artifact and
confirm that preview. The controller must check that the task's generation,
artifact hash, and finalized context still match the preview before invoking
the adapter; review-required or stale task output cannot be sent. The adapter
rebuilds the digest and checks every approval field before dispatch. An
internal `confirmed: true` value is an assertion from this trusted controller,
not a substitute for authenticating a wearer at the HTTP boundary.

```ts
const sender = createDocumentSender(process.env);
const preview = prepareDocumentDelivery({
  taskId, artifactId: `${taskId}:${generation}`, generation, contextDigest, content,
  recipient: { email, name }, subject, body,
  filename: 'requirements.md', contentType: 'text/markdown; charset=utf-8',
}, contextRevision, proposalVersion);
// After authenticated confirmation and current-source checks:
const receipt = await sender.adapter!.sendDocument(preview, {
  confirmed: true, digest: preview.digest,
  contextRevision: preview.contextRevision,
  proposalVersion: preview.proposalVersion,
}, stableAttemptKey, sender.attempts, signal);
```

Addresses deliberately accept only one ASCII dot-atom mailbox with a valid DNS
domain. Display names are a separate field. Address lists, comments, quoted
local parts, and internationalized addresses are rejected rather than guessed.
Header control characters are rejected; Unicode names/subjects are encoded as
RFC 2047 words. The filename must be a simple `.md` filename. Content is read
from the supplied string only, never from a filesystem path.

## Credentials and readiness

Use the existing server-only Google OAuth credential file loaded into the
process environment. Add the narrow `gmail.send` grant while preserving the
existing Calendar grant. Refreshing an old token does not add scopes. Verify the
new grant and account during OAuth setup; never infer scope from possession of
a client ID or access token.

```dotenv
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REFRESH_TOKEN=
GOOGLE_OAUTH_SCOPES=
GOOGLE_GMAIL_FROM_EMAIL=
GOOGLE_GMAIL_ACCESS_TOKEN=
```

`GOOGLE_OAUTH_SCOPES` is the space-separated list of granted scopes, including
`https://www.googleapis.com/auth/gmail.send`. `GOOGLE_GMAIL_FROM_EMAIL` is the
verified Google account email. A short-lived `GOOGLE_GMAIL_ACCESS_TOKEN` or
`GOOGLE_ACCESS_TOKEN` can replace refresh credentials. Existing
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` aliases
are supported. No secret values belong in tracked files, browser payloads, or
logs.

`createDocumentSender(env).configured` checks credentials, the recorded Gmail
scope, and sender configuration. It is configuration evidence, not live send
verification. `adapter.readiness()` introspects token scopes read-only; it does
not create a draft or send a message. The narrow send grant does not authorize
mailbox/profile reads. No live email was sent as part of adapter QA.

## Durable outcome handling

`FileDeliveryAttemptStore` creates and fsyncs an exclusive claim before the
Google send request, under `.local/delivery-attempts` (or `GLANCE_LOCAL_DIR`).
The filename hashes the stable attempt key, and files use mode `0600`.
Concurrent requests and restarts cannot reuse a claim. Success atomically
persists Google's message ID, the preview digest, and the MIME Message-ID.
The latter is deterministic for observability; it is **not** a Gmail
idempotency guarantee.

A complete HTTP 4xx response records a rejected outcome with safe status/code
metadata requiring human review. Network failures, HTTP 5xx, malformed success
responses, and persistence errors after dispatch are uncertain. No automatic
retry occurs, including after restart. Inspect the account's Sent folder and
stored receipt before deciding how to proceed. With send-only OAuth, mailbox
reconciliation is manual. Provider acceptance is not proof of recipient inbox
delivery.

## Verification and sources

`npx vitest run test/delivery.test.ts` passes 27 mocked tests covering exact
content approval, header/address injection, Unicode MIME, concurrent claims,
restart duplicate rejection, uncertain transport, rejection metadata, malformed
provider responses, and scope-gated readiness. No test contacts Google.

The implementation follows Google's [MIME/base64url sending
guide](https://developers.google.com/workspace/gmail/api/guides/sending),
[users.messages.send
reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
and [Gmail scope
reference](https://developers.google.com/workspace/gmail/api/auth/scopes).
