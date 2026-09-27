import { checkResponse, endpoint, IntegrationError, object, requestSignal, required, type Fetch } from './http.ts';
import { parseSse } from './sse.ts';
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface McpToolResult { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean }
/** Hosted MCP bearer connector. Tool identifiers always come from the authenticated catalog. */
export class GBrainClient {
  private readonly url: URL; private token: string | undefined; private readonly fetch: Fetch;
  private readonly oauth: { clientId: string; clientSecret: string; tokenUrl: URL } | undefined; private tokenExpiresAt = 0;
  private session: string | undefined; private protocol = '2025-06-18'; private sequence = 0;
  private initialized: Promise<void> | undefined; private catalog = new Map<string, McpTool>();
  constructor(config: { url: string; bearerToken?: string; clientId?: string; clientSecret?: string; tokenUrl?: string; fetch?: Fetch }) {
    this.url = endpoint(required(config.url, 'GBrain MCP URL')); this.fetch = config.fetch ?? globalThis.fetch;
    if (config.bearerToken) this.token = config.bearerToken;
    else this.oauth = { clientId: required(config.clientId, 'GBrain OAuth client ID'), clientSecret: required(config.clientSecret, 'GBrain OAuth client secret'), tokenUrl: endpoint(required(config.tokenUrl, 'GBrain OAuth token URL')) };
  }
  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (!this.oauth) return required(this.token, 'GBrain bearer token');
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const response = await checkResponse(await this.fetch(this.oauth.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.oauth.clientId, client_secret: this.oauth.clientSecret }).toString(), redirect: 'error', signal: requestSignal(signal, 30_000) }), 'GBrain OAuth');
    const data = object(await response.json());
    if (typeof data.access_token !== 'string' || !data.access_token || (data.token_type !== undefined && String(data.token_type).toLowerCase() !== 'bearer')) throw new IntegrationError('protocol_error', 'GBrain OAuth did not return a bearer token');
    this.token = data.access_token; this.tokenExpiresAt = Date.now() + Math.max(0, (typeof data.expires_in === 'number' ? data.expires_in : 300) - 30) * 1000; return this.token;
  }
  private async rpc(method: string, params: unknown, signal?: AbortSignal, notification = false): Promise<unknown> {
    const id = ++this.sequence;
    const response = await checkResponse(await this.fetch(this.url, {
      method: 'POST', headers: { authorization: `Bearer ${await this.accessToken(signal)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(method !== 'initialize' ? { 'mcp-protocol-version': this.protocol } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), redirect: 'error', signal: requestSignal(signal, 60_000),
    }), 'GBrain');
    const session = response.headers.get('mcp-session-id'); if (session) this.session = session;
    if (notification) { await response.body?.cancel(); return undefined; }
    let payload: unknown;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      if (!response.body) throw new IntegrationError('protocol_error', 'GBrain stream is missing');
      for await (const frame of parseSse(response.body)) { const value = object(JSON.parse(frame.data)); if (value.id === id) { payload = value; break; } }
    } else payload = await response.json();
    const result = object(payload);
    if (result.jsonrpc !== '2.0' || result.id !== id) throw new IntegrationError('protocol_error', 'GBrain RPC response ID mismatch');
    if (result.error !== undefined) throw new IntegrationError('tool_error', `GBrain RPC ${method} failed`);
    if (!('result' in result)) throw new IntegrationError('protocol_error', 'GBrain RPC result is missing');
    return result.result;
  }
  private initialize(signal?: AbortSignal): Promise<void> {
    if (!this.initialized) this.initialized = (async () => {
      const result = object(await this.rpc('initialize', { protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'glance-qm', version: '0.1.0' } }, signal));
      if (typeof result.protocolVersion !== 'string' || !['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(result.protocolVersion)) throw new IntegrationError('protocol_error', 'Unsupported MCP protocol version');
      this.protocol = result.protocolVersion; await this.rpc('notifications/initialized', {}, signal, true);
    })().catch(error => { this.initialized = undefined; throw error; });
    return this.initialized;
  }
  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.initialize(signal); const tools: McpTool[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do {
      const result = object(await this.rpc('tools/list', cursor ? { cursor } : {}, signal));
      if (!Array.isArray(result.tools)) throw new IntegrationError('protocol_error', 'GBrain returned no tools catalog');
      for (const raw of result.tools) { const tool = object(raw); if (typeof tool.name !== 'string' || !tool.name) throw new IntegrationError('protocol_error', 'Invalid MCP tool'); object(tool.inputSchema); tools.push(tool as unknown as McpTool); }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new IntegrationError('protocol_error', 'MCP catalog pagination repeated');
      if (cursor) seen.add(cursor);
    } while (cursor);
    this.catalog = new Map(tools.map(tool => [tool.name, tool])); return tools;
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (!this.catalog.size) await this.listTools(signal);
    if (!this.catalog.has(name)) throw new IntegrationError('unavailable', 'Configured GBrain tool was not found in the authenticated catalog');
    const result = object(await this.rpc('tools/call', { name, arguments: args }, signal));
    if (result.isError === true) {
      let category: string | undefined;
      for (const raw of Array.isArray(result.content) ? result.content : []) {
        try {
          const block = object(raw); const detail = typeof block.text === 'string' ? object(JSON.parse(block.text)) : {};
          if (typeof detail.error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(detail.error)) { category = detail.error; break; }
        } catch { /* Never expose free-form provider text in an error. */ }
      }
      throw new IntegrationError('tool_error', `GBrain tool reported an execution error${category ? ` (${category})` : ''}`);
    }
    if (!Array.isArray(result.content)) throw new IntegrationError('protocol_error', 'GBrain tool content is missing');
    return result as unknown as McpToolResult;
  }
}
/** Structured tool data, otherwise JSON carried in text; plain text remains explicitly text. */
export function toolResultData(result: McpToolResult): unknown {
  if (result.structuredContent) return result.structuredContent;
  // GBrain search appends diagnostic prose after its JSON result block.
  for (const block of result.content) {
    const item = object(block);
    if (item.type === 'text' && typeof item.text === 'string') { try { const data: unknown = JSON.parse(item.text); if (data !== null && typeof data === 'object') return data; } catch {} }
  }
  const text = result.content.map(value => { const item = object(value); return item.type === 'text' && typeof item.text === 'string' ? item.text : ''; }).filter(Boolean).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
