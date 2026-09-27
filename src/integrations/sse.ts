import { IntegrationError } from './http.ts';
export interface SseEvent { data: string; event?: string; id?: string }
/** Incremental UTF-8 SSE parser; supports CRLF splits, comments and multiline data. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let lines: string[] = [];
  const parse = (): SseEvent | undefined => {
    const data: string[] = []; let event: string | undefined; let id: string | undefined;
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':'); const key = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'data') data.push(value); else if (key === 'event') event = value; else if (key === 'id' && !value.includes('\0')) id = value;
    }
    lines = [];
    return data.length ? { data: data.join('\n'), ...(event ? { event } : {}), ...(id !== undefined ? { id } : {}) } : undefined;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 8_388_608) throw new IntegrationError('protocol_error', 'SSE frame exceeds size limit');
      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer))) {
        if (!done && match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        if (line === '') { const event = parse(); if (event) yield event; } else lines.push(line);
      }
      if (done) break;
    }
    // An unterminated event is incomplete under the SSE specification; discard it.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
