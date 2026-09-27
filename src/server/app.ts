import express, { type ErrorRequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { appendTranscriptRequestSchema, confirmActionRequestSchema, createMeetingRequestSchema, postMessageRequestSchema, wsAuthMessageSchema, type HealthResponse, type ServerEvent } from '../shared/contracts.js';
import { DomainError, MeetingController } from '../core/controller.js';
import { NotFoundError } from '../core/store.js';
import { validToken } from './auth.js';

export interface AppOptions {
  controller: MeetingController;
  token: string;
  allowedOrigins?: string[];
  memorableConfigured?: boolean;
}
export function createApp(options: AppOptions): { server: Server; app: express.Express; close: () => Promise<void> } {
  const { controller, token } = options;
  const origins = new Set(options.allowedOrigins ?? ['http://localhost:5174', 'http://127.0.0.1:5174']);
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin) {
      if (!origins.has(origin)) { response.status(403).json({ error: { code: 'origin_denied', message: 'Origin is not allowed.' } }); return; }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'OPTIONS') { response.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, service: 'glance-qm', version: '0.1.0', providers: { qm: controller.providers.configured.qm ? 'configured' : 'unconfigured', gbrain: controller.providers.configured.gbrain ? 'configured' : 'unconfigured', memorable: options.memorableConfigured ? 'configured' : 'unconfigured' }, providerMode: controller.providers.mode, decisionMode: controller.providers.decisionMode ?? (controller.providers.configured.qm ? 'qm-only' : 'unconfigured'), authentication: 'local-single-operator' } satisfies HealthResponse & { providerMode: string; decisionMode: string; authentication: string });
  });
  app.use('/api', (request, response, next) => {
    const authorization = request.headers.authorization;
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!validToken(presented, token)) { response.status(401).json({ error: { code: 'unauthorized', message: 'A valid local operator token is required.' } }); return; }
    next();
  });
  app.post('/api/meetings', async (request, response) => { response.status(201).json(await controller.create(createMeetingRequestSchema.parse(request.body))); });
  app.get('/api/meetings/:id', async (request, response) => { response.json(await controller.get(request.params.id!)); });
  app.get('/api/meetings/:id/tasks/:taskId/document', async (request, response) => {
    const meeting = await controller.get(request.params.id!);
    const task = meeting.tasks.find(item => item.id === request.params.taskId);
    if (!task?.content || task.status !== 'completed') throw new DomainError(404, 'document_not_found', 'The document is not available.');
    response.setHeader('Content-Disposition', `attachment; filename="${task.id}.md"`);
    response.type('text/markdown').send(task.content);
  });
  app.post('/api/meetings/:id/transcript', async (request, response) => { response.json(await controller.append(request.params.id!, appendTranscriptRequestSchema.parse(request.body))); });
  app.post('/api/meetings/:id/messages', async (request, response) => { response.json(await controller.message(request.params.id!, postMessageRequestSchema.parse(request.body))); });
  app.post('/api/meetings/:id/end', async (request, response) => { response.json(await controller.end(request.params.id!)); });
  app.post('/api/meetings/:id/control', async (request, response) => { const body = z.object({ action: z.enum(['pause', 'resume']) }).parse(request.body); response.json(await controller.control(request.params.id!, body.action)); });
  app.post('/api/meetings/:id/actions/:actionId/confirm', async (request, response) => { const body = confirmActionRequestSchema.parse(request.body); response.json(await controller.confirm(request.params.id!, request.params.actionId!, body.proposalVersion)); });
  app.use((_request, response) => { response.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint.' } }); });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) { response.status(400).json({ error: { code: 'invalid_request', message: 'Request validation failed.', issues: error.issues } }); return; }
    if (error instanceof DomainError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof NotFoundError) { response.status(404).json({ error: { code: 'meeting_not_found', message: error.message } }); return; }
    if (error instanceof SyntaxError) { response.status(400).json({ error: { code: 'invalid_json', message: 'Request must contain valid JSON.' } }); return; }
    response.status(500).json({ error: { code: 'internal_error', message: 'The operation could not be completed.' } });
  };
  app.use(errors);
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const match = /^\/api\/meetings\/([a-zA-Z0-9_-]{1,100})\/events$/.exec(url.pathname);
    // A token in a URL can leak via history and logs. It is never accepted here.
    if (!match || url.search || (request.headers.origin && !origins.has(request.headers.origin))) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, connection => {
      let authenticated = false;
      let authAttempted = false;
      const id = match[1]!;
      const listener = (event: ServerEvent): void => { if (authenticated && event.meetingId === id && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(event)); };
      const timer = setTimeout(() => connection.close(4401, 'Authentication required'), 5000);
      timer.unref();
      connection.on('message', async raw => {
        if (authAttempted) { connection.close(4400, 'Only initial authentication is accepted'); return; }
        authAttempted = true;
        try {
          const input = wsAuthMessageSchema.parse(JSON.parse(raw.toString()));
          if (!validToken(input.token, token)) { connection.close(4401, 'Invalid operator token'); return; }
          if (connection.readyState !== WebSocket.OPEN) return;
          authenticated = true; clearTimeout(timer);
          const unsubscribe = await controller.subscribe(id, listener);
          if (connection.readyState !== WebSocket.OPEN) unsubscribe();
        } catch { connection.close(4404, 'Authentication or meeting lookup failed'); }
      });
      connection.on('close', () => { clearTimeout(timer); controller.off('event', listener); });
      connection.on('error', () => { clearTimeout(timer); controller.off('event', listener); });
    });
  });
  return {
    app, server,
    close: async () => {
      for (const connection of sockets.clients) connection.close(1001, 'Server closing');
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await controller.close();
    },
  };
}
