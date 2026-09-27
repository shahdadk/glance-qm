# Exa public research

Exa is kompX's only web-search provider. There is no silent search fallback.
The server-only `ExaClient` calls the documented
[`POST https://api.exa.ai/search`](https://exa.ai/docs/reference/search)
with `x-api-key`, `type: "fast"`, `numResults: 4`, and
`contents.text.maxCharacters: 3000`. The official API schema was checked on
2026-09-27, including the text options in its linked Markdown/OpenAPI reference.
No provider SDK or source code from the old Glance project is used.

## Runtime boundary

```ts
const research = new ExaClient({ apiKey: process.env.EXA_API_KEY });
const sources = await research.search(publicTopic, abortSignal);
```

The key belongs only in the server process environment. Local operator setup
uses `~/.config/glance-qm/exa.env` with mode `0600`; neither the adapter nor the
web client reads the clipboard. Do not place the key in source, client bundles,
URLs, logs, or evidence. The factory/runtime is responsible for loading the
private environment file. No key is necessary for fixture tests.

Only a minimized, standalone public topic is permitted as the search query.
The semantic caller must omit private meeting facts, names, identifiers,
transcripts, and memory text. The adapter rejects queries longer than 240
characters, multiline input, email addresses, URLs, and recognizable credential
assignments. These checks are a backstop, not a complete privacy classifier.
Use the core's revision-bound retrieval flow so a correction cancels pending
research and prevents stale results from becoming a cue.

## Evidence and limits

- One request, four-second timeout (configurable downward; five-second maximum),
  and a one-second Exa livecrawl budget. There are no retries.
- At most four sources and 3,000 source characters per source; response reading
  is capped at 256 KB. Empty results are a valid empty array.
- Text is taken directly from Exa's returned page text, or returned highlights
  if text is absent. A title or generated summary alone is never evidence.
- Links retain the actual returned URL. Only public-looking HTTP(S) hostnames
  are accepted; credentials, unusual ports, IP literals, local/reserved hosts,
  and non-HTTP schemes are rejected. The adapter never follows result links.
  Host checks are syntactic; this is not a DNS/public-access verification.
- Evidence IDs hash the canonical URL and bounded source content, so a changed
  document produces a new ID. Duplicate canonical URLs are removed.
- `getProvenance(id)` returns a server-side title, actual URL, retrieval time,
  and content hash for up to the most recent 64 records. It contains no API key.
  Retrieval time means the API retrieval, not the original page crawl time.
- There is no global search-result cache. Revision-aware retrieval ownership
  belongs to the controller; returned web content remains untrusted data.
- Typed failures distinguish missing configuration, rejected query,
  authentication (401/403), quota/rate limit (402/429), timeout, cancellation,
  malformed response, and other unavailability. Provider response bodies and
  raw transport errors are never exposed.

## Verification

`npx vitest run test/exa.test.ts`: 12 tests passed. Adapter source typechecking
passed using `npx tsc -p tsconfig.json --noEmit`.

Live adapter search verified on 2026-09-27 using the operator-designated Exa
key from the private environment file. The public query was `Node.js stream
backpressure writable write false drain event official documentation`.

The real API returned four content-bearing sources in **393 ms**, each bounded
to 3,000 characters:

- https://nodejs.org/learn/modules/backpressuring-in-streams
- https://nodejs.org/docs/latest/api/stream.html
- https://github.com/jrasanen/node/commit/e9044c83a9b997bde60432cd056d36e3a7d8d1e3
- https://nodejs.org/api/stream.md

Only source URLs, IDs, character counts, and latency were emitted by the
verification command. An earlier request returned HTTP 401 before the operator
corrected the provider-designated credential. The corrected key succeeded.
This receipt verifies the real adapter/API path; controller cue integration and
physical glasses delivery require their own acceptance checks.
