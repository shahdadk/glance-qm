import { createHash, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { DomainError, type MeetingController, type MeetingRecord } from '../core/controller.js';
import { confirmDeliveryRequestSchema, type DocumentDeliveryAction } from '../shared/contracts.js';
import { createDocumentSender, deliveryMailbox, prepareDocumentDelivery, type DeliveryAttemptStore, type DeliveryPreview, type DeliveryReceipt, type GmailDeliveryAdapter } from '../integrations/delivery.js';
import { IntegrationError } from '../integrations/http.js';

export interface DocumentSender { configured: boolean; adapter: Pick<GmailDeliveryAdapter, 'sendDocument'> | undefined; attempts: DeliveryAttemptStore }
export interface DeliveryRouteOptions { env?: Readonly<Record<string, string | undefined>>; sender?: DocumentSender }
interface DeliveryRecord extends MeetingRecord {
  deliveryExecution?: { actionId: string; previewDigest: string; contextRevision: number; idempotencyKey: string; receipt?: DeliveryReceipt };
  deliveryReceipts?: { actionId: string; artifactDigest: string; recipientEmail: string; receipt: DeliveryReceipt }[];
}
const safeHeader = (limit: number) => z.string().trim().min(1).max(limit).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Invalid header');
const prepareRequest = z.object({
  recipient: z.union([z.literal('self'), z.object({ email: z.string().email().max(254), name: safeHeader(120).optional() }).strict()]),
  subject: safeHeader(300).optional(), body: z.string().trim().min(1).max(10_000).optional(),
}).strict();
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const recipientKey = (email: string) => email.toLowerCase();
function alreadyDelivered(value: DeliveryRecord, artifactDigest: string, email: string): boolean {
  const recipient = recipientKey(email);
  return value.deliveryReceipts?.some(item => item.artifactDigest === artifactDigest && item.recipientEmail === recipient) === true ||
    (value.deliveryAction?.status === 'sent' && value.deliveryAction.artifactDigest === artifactDigest && recipientKey(value.deliveryAction.recipient.email) === recipient);
}
function preserveReceipt(value: DeliveryRecord): void {
  const action = value.deliveryAction; const receipt = value.deliveryExecution?.receipt;
  if (action?.status !== 'sent' || !receipt?.accepted || !receipt.messageId) return;
  const history = value.deliveryReceipts ??= [];
  if (!history.some(item => item.actionId === action.id)) history.push({ actionId: action.id, artifactDigest: action.artifactDigest, recipientEmail: recipientKey(action.recipient.email), receipt });
}

function source(controller: MeetingController, record: MeetingRecord, taskId: string) {
  const task = record.tasks.find(item => item.id === taskId); const origin = record.taskOrigins[taskId];
  if (!task || !origin) throw new DomainError(404, 'task_not_found', 'Unknown document task.');
  if (task.status !== 'completed') throw new DomainError(409, 'document_review_required', 'Review the current completed document before preparing or sending it.');
  if (!task.content?.trim()) throw new DomainError(409, 'document_unavailable', 'This task does not have a deliverable document.');
  const artifactDigest = sha256(task.content);
  if (origin.artifactDigest !== artifactDigest || (task.artifactDigest && task.artifactDigest !== artifactDigest)) throw new DomainError(409, 'stale_document', 'Document contents changed; generate and review the current artifact.');
  const context = controller.finalizedContext(record);
  if (task.contextDigest !== context.digest) throw new DomainError(409, 'stale_document', 'The conversation changed; review the current document.');
  return { task, content: task.content, generation: origin.generation ?? 1, artifactDigest, context };
}

function preview(controller: MeetingController, record: MeetingRecord, action: DocumentDeliveryAction): DeliveryPreview {
  const current = source(controller, record, action.taskId);
  if (current.generation !== action.generation || current.artifactDigest !== action.artifactDigest || current.context.digest !== action.contextDigest) throw new DomainError(409, 'stale_delivery', 'The document or conversation changed; review a new delivery preview.');
  return prepareDocumentDelivery({ taskId: action.taskId, artifactId: action.artifactDigest, generation: action.generation, contextDigest: action.contextDigest, content: current.content, recipient: { email: action.recipient.email, ...(action.recipient.name ? { name: action.recipient.name } : {}) }, subject: action.subject, body: action.body, filename: action.filename, contentType: action.contentType }, current.context.revision, action.proposalVersion);
}

/** Install after the application's operator authentication middleware. */
export function installDeliveryRoutes(app: Express, controller: MeetingController, options: DeliveryRouteOptions = {}): void {
  const env = options.env ?? process.env;
  const sender = options.sender ?? createDocumentSender(env);
  app.post('/api/meetings/:id/tasks/:taskId/delivery', async (request, response) => {
    const input = prepareRequest.parse(request.body);
    let recipient: { email: string; name?: string };
    try {
      if (input.recipient === 'self') {
        if (!env.GOOGLE_GMAIL_FROM_EMAIL) throw new DomainError(409, 'recipient_unavailable', 'The connected account email is unavailable. Choose an explicit recipient.');
        recipient = { email: deliveryMailbox(env.GOOGLE_GMAIL_FROM_EMAIL) };
      } else recipient = { email: deliveryMailbox(input.recipient.email), ...(input.recipient.name ? { name: input.recipient.name } : {}) };
    } catch (error) {
      if (error instanceof IntegrationError) throw new DomainError(400, 'invalid_recipient', 'Choose one valid recipient email address.');
      throw error;
    }
    const result = await controller.updateDelivery(request.params.id!, record => {
      const value = record as DeliveryRecord;
      if (value.deliveryAction && ['sending', 'uncertain'].includes(value.deliveryAction.status)) throw new DomainError(409, 'delivery_in_progress', 'An earlier delivery needs its outcome checked before another can be prepared.');
      const current = source(controller, value, request.params.taskId!);
      if (alreadyDelivered(value, current.artifactDigest, recipient.email)) throw new DomainError(409, 'document_already_delivered', 'This document was already delivered to this recipient.');
      preserveReceipt(value);
      const action: DocumentDeliveryAction = {
        id: randomUUID(), proposalVersion: (value.deliveryAction?.proposalVersion ?? 0) + 1,
        taskId: current.task.id, generation: current.generation, artifactDigest: current.artifactDigest, contextDigest: current.context.digest,
        recipient, subject: input.subject ?? current.task.title.slice(0, 300).replace(/[\u0000-\u001f\u007f]/g, ' '),
        body: input.body ?? 'Please find the reviewed document attached.', filename: 'document.md', contentType: 'text/markdown; charset=utf-8', status: 'proposed',
      };
      const prepared = preview(controller, value, action);
      // A repeated prepare (including concurrent clicks) reuses the same
      // approval and attempt identity when every reviewed field is unchanged.
      if (value.deliveryAction?.status === 'proposed' && value.deliveryExecution?.actionId === value.deliveryAction.id) {
        const existingVersion = prepareDocumentDelivery(prepared.input, prepared.contextRevision, value.deliveryAction.proposalVersion);
        if (existingVersion.digest === value.deliveryExecution.previewDigest) return;
      }
      value.deliveryAction = action;
      value.deliveryExecution = { actionId: action.id, previewDigest: prepared.digest, contextRevision: prepared.contextRevision, idempotencyKey: `document:${value.id}:${action.id}:${action.proposalVersion}` };
    });
    response.status(201).json(result);
  });

  app.post('/api/meetings/:id/deliveries/:deliveryId/confirm', async (request, response) => {
    const input = confirmDeliveryRequestSchema.strict().parse(request.body);
    if (!sender.configured || !sender.adapter) throw new DomainError(503, 'delivery_unconfigured', 'Connect Gmail with sending permission before sending documents.');
    let prepared!: DeliveryPreview; let attemptKey = '';
    const validate = (record: MeetingRecord, expectedStatus: 'proposed' | 'sending') => {
      const value = record as DeliveryRecord; const action = value.deliveryAction; const execution = value.deliveryExecution;
      if (!action || action.id !== request.params.deliveryId || !execution || execution.actionId !== action.id) throw new DomainError(404, 'delivery_not_found', 'Unknown delivery preview.');
      if (action.proposalVersion !== input.proposalVersion) throw new DomainError(409, 'stale_delivery', 'Review the latest delivery preview before sending.');
      if (action.status !== expectedStatus) throw new DomainError(409, 'delivery_already_attempted', 'This delivery is no longer available to send. Review its stored outcome.');
      if (alreadyDelivered(value, action.artifactDigest, action.recipient.email)) throw new DomainError(409, 'document_already_delivered', 'This document was already delivered to this recipient.');
      const rebuilt = preview(controller, value, action);
      if (rebuilt.digest !== execution.previewDigest || rebuilt.contextRevision !== execution.contextRevision) throw new DomainError(409, 'stale_delivery', 'The delivery preview changed; review it again.');
      return { value, action, execution, rebuilt };
    };
    await controller.updateDelivery(request.params.id!, record => {
      const checked = validate(record, 'proposed'); prepared = checked.rebuilt; attemptKey = checked.execution.idempotencyKey; checked.action.status = 'sending';
    });
    // Revalidate within the same durable queue immediately before the adapter's
    // atomic attempt claim; token refresh must not make source approval stale.
    const attempts: DeliveryAttemptStore = {
      claim: async (key, digest) => {
        let claimed = false;
        await controller.updateDelivery(request.params.id!, async record => {
          const checked = validate(record, 'sending');
          if (key !== checked.execution.idempotencyKey || digest !== checked.execution.previewDigest) throw new DomainError(409, 'stale_delivery', 'Delivery approval no longer matches this attempt.');
          claimed = await sender.attempts.claim(key, digest);
        });
        return claimed;
      },
      finish: (...args) => sender.attempts.finish(...args),
    };
    try {
      const receipt = await sender.adapter.sendDocument(prepared, { confirmed: true, digest: prepared.digest, contextRevision: prepared.contextRevision, proposalVersion: prepared.proposalVersion }, attemptKey, attempts);
      if (!receipt.accepted || !receipt.messageId || receipt.previewDigest !== prepared.digest) throw new IntegrationError('uncertain_send', 'Gmail did not return a matching delivery receipt.');
      const result = await controller.updateDelivery(request.params.id!, record => {
        const value = record as DeliveryRecord;
        if (value.deliveryAction?.id !== request.params.deliveryId || value.deliveryExecution?.actionId !== request.params.deliveryId) throw new DomainError(409, 'delivery_changed', 'The stored delivery changed during sending.');
        value.deliveryAction.status = 'sent'; value.deliveryAction.providerMessageId = receipt.messageId; value.deliveryExecution.receipt = receipt;
        preserveReceipt(value);
      });
      response.json(result);
    } catch (error) {
      const rejected = error instanceof DomainError || (error instanceof IntegrationError && ['authentication', 'not_configured', 'approval_required'].includes(error.code)) || (error instanceof IntegrationError && error.code === 'http_error' && !!error.status && error.status >= 400 && error.status < 500);
      const result = await controller.updateDelivery(request.params.id!, record => {
        if (record.deliveryAction?.id !== request.params.deliveryId) return;
        record.deliveryAction.status = rejected ? 'failed' : 'uncertain';
        record.deliveryAction.providerError = rejected ? 'Delivery was not sent. Review the document, recipient and connected account before preparing another delivery.' : 'Delivery outcome is uncertain. Check Gmail before preparing another delivery; no automatic retry was made.';
      });
      response.status(rejected ? 409 : 502).json({ ...result, error: { code: rejected ? 'delivery_rejected' : 'delivery_uncertain', message: result.deliveryAction?.providerError } });
    }
  });
}
