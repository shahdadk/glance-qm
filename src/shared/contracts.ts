import { z } from "zod";

/**
 * The small, versioned boundary shared by the Meta surface and the QM
 * runtime. The server validates every request at this boundary and sends
 * snapshots/events that can be replayed by another participant.
 */

export const meetingStatusSchema = z.enum(["listening", "paused", "ended"]);
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

export const participantRoleSchema = z.enum(["owner", "participant"]);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const participantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: participantRoleSchema,
  joinedAt: z.string().min(1),
});
export type Participant = z.infer<typeof participantSchema>;

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  isFinal: z.boolean(),
  revision: z.number().int().nonnegative(),
  speaker: z.string().min(1).optional(),
  capturedAt: z.string().min(1),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const evidenceKindSchema = z.enum([
  "transcript",
  "memory",
  "external",
  "calculation",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  text: z.string().min(1),
  url: z.string().url().optional(),
  kind: evidenceKindSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const cueSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  detail: z.string().min(1).optional(),
  evidence: z.array(evidenceSchema),
  revision: z.number().int().nonnegative(),
});
export type Cue = z.infer<typeof cueSchema>;

export const meetingSummarySchema = z.object({
  text: z.string().min(1),
  decisions: z.array(z.string().min(1)),
  openQuestions: z.array(z.string().min(1)),
  owners: z.array(z.string().min(1)),
  nextSteps: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});
export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

export const providerReceiptSchema = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  detail: z.string().min(1).optional(),
});
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export const meetingWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  createdAt: z.string().min(1),
});
export type MeetingWarning = z.infer<typeof meetingWarningSchema>;

export const finalizationStateSchema = z.enum([
  "not_started",
  "running",
  "completed",
  "failed",
]);
export type FinalizationState = z.infer<typeof finalizationStateSchema>;

export const finalizationSchema = z.object({
  state: finalizationStateSchema,
  error: z.string().min(1).optional(),
  receipt: providerReceiptSchema.optional(),
});
export type Finalization = z.infer<typeof finalizationSchema>;

export const providerModeSchema = z.enum(["live", "fixture", "unconfigured"]);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const operatorMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.string().min(1),
});
export type OperatorMessage = z.infer<typeof operatorMessageSchema>;

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "review_required",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Context metadata for a task's source; it never contains transcript text. */
export const taskOriginSchema = z.object({
  meetingId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative().optional(),
  contextDigest: z.string().min(1).optional(),
  correctionEpoch: z.number().int().nonnegative(),
  lastSegmentId: z.string().min(1).optional(),
  finalCount: z.number().int().nonnegative(),
  capturedAt: z.number().nonnegative(),
});
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: taskStatusSchema,
  content: z.string().optional(),
  url: z.string().url().optional(),
  error: z.string().optional(),
  generation: z.number().int().positive().optional(),
  artifactDigest: z.string().min(1).optional(),
  contextDigest: z.string().min(1).optional(),
  origin: taskOriginSchema.optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const calendarActionStatusSchema = z.enum([
  "proposed",
  "confirmed",
  "sent",
  "uncertain",
  "failed",
  "cancelled",
]);
export type CalendarActionStatus = z.infer<
  typeof calendarActionStatusSchema
>;

export const calendarAttendeeSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
});
export type CalendarAttendee = z.infer<typeof calendarAttendeeSchema>;

export const calendarActionSchema = z.object({
  id: z.string().min(1),
  proposalVersion: z.number().int().positive(),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  timeZone: z.string().min(1),
  attendees: z.array(calendarAttendeeSchema),
  description: z.string().min(1),
  status: calendarActionStatusSchema,
  providerError: z.string().min(1).optional(),
});
export type CalendarAction = z.infer<typeof calendarActionSchema>;

export const deliveryActionStatusSchema = z.enum([
  "proposed",
  "sending",
  "sent",
  "uncertain",
  "failed",
  "cancelled",
]);
export type DeliveryActionStatus = z.infer<typeof deliveryActionStatusSchema>;

export const deliveryRecipientSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).optional(),
});
export type DeliveryRecipient = z.infer<typeof deliveryRecipientSchema>;

/**
 * A reviewable delivery preview. The document bytes stay on the task/artifact
 * boundary; this public action contains only the digest that binds approval to
 * the reviewed artifact.
 */
export const documentDeliveryActionSchema = z.object({
  id: z.string().min(1),
  proposalVersion: z.number().int().positive(),
  taskId: z.string().min(1),
  generation: z.number().int().positive(),
  artifactDigest: z.string().min(1),
  contextDigest: z.string().min(1),
  recipient: deliveryRecipientSchema,
  subject: z.string().min(1),
  body: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.literal("text/markdown; charset=utf-8"),
  status: deliveryActionStatusSchema,
  providerError: z.string().min(1).optional(),
  providerMessageId: z.string().min(1).optional(),
});
export type DocumentDeliveryAction = z.infer<typeof documentDeliveryActionSchema>;

export const meetingSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: meetingStatusSchema,
  revision: z.number().int().nonnegative(),
  participants: z.array(participantSchema),
  transcript: z.array(transcriptSegmentSchema),
  cue: cueSchema.optional(),
  summary: meetingSummarySchema.optional(),
  tasks: z.array(taskSchema),
  calendarAction: calendarActionSchema.optional(),
  deliveryAction: documentDeliveryActionSchema.optional(),
  warnings: z.array(meetingWarningSchema).optional(),
  finalization: finalizationSchema.optional(),
  providerMode: providerModeSchema.optional(),
  operatorMessages: z.array(operatorMessageSchema).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MeetingSnapshot = z.infer<typeof meetingSnapshotSchema>;

export const createMeetingRequestSchema = z.object({
  title: z.string().trim().min(1).max(240),
  participantNames: z.array(z.string().trim().min(1).max(120)).max(32).optional(),
});
export type CreateMeetingRequest = z.infer<typeof createMeetingRequestSchema>;

export const appendTranscriptRequestSchema = z.object({
  segmentId: z.string().min(1),
  text: z.string().trim().min(1),
  isFinal: z.boolean(),
  revision: z.number().int().nonnegative(),
  speaker: z.string().trim().min(1).optional(),
});
export type AppendTranscriptRequest = z.infer<
  typeof appendTranscriptRequestSchema
>;

export const meetingControlRequestSchema = z.object({
  action: z.enum(["pause", "resume"]),
});
export type MeetingControlRequest = z.infer<typeof meetingControlRequestSchema>;

export const confirmActionRequestSchema = z.object({
  proposalVersion: z.number().int().positive(),
});
export type ConfirmActionRequest = z.infer<typeof confirmActionRequestSchema>;

export const reviewTaskRequestSchema = z.object({
  generation: z.number().int().positive(),
  contextDigest: z.string().min(1),
});
export type ReviewTaskRequest = z.infer<typeof reviewTaskRequestSchema>;

export const confirmDeliveryRequestSchema = z.object({
  proposalVersion: z.number().int().positive(),
});
export type ConfirmDeliveryRequest = z.infer<typeof confirmDeliveryRequestSchema>;

export const postMessageRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  participantId: z.string().min(1),
});
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

export const wsAuthMessageSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});
export type WsAuthMessage = z.infer<typeof wsAuthMessageSchema>;

export const eventTypeSchema = z.enum([
  "snapshot",
  "transcript",
  "cue",
  "summary",
  "task",
  "action",
  "delivery",
  "status",
  "error",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const meetingStatusPayloadSchema = z.object({
  status: meetingStatusSchema,
  revision: z.number().int().nonnegative(),
});
export type MeetingStatusPayload = z.infer<typeof meetingStatusPayloadSchema>;

export const taskEventPayloadSchema = z.object({
  task: taskSchema,
});
export type TaskEventPayload = z.infer<typeof taskEventPayloadSchema>;

export const actionEventPayloadSchema = z.object({
  calendarAction: calendarActionSchema,
});
export type ActionEventPayload = z.infer<typeof actionEventPayloadSchema>;

export const deliveryEventPayloadSchema = z.object({
  deliveryAction: documentDeliveryActionSchema,
});
export type DeliveryEventPayload = z.infer<typeof deliveryEventPayloadSchema>;

export const errorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().optional(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    meetingId: z.string().min(1),
    payload: meetingSnapshotSchema,
  }),
  z.object({
    type: z.literal("transcript"),
    meetingId: z.string().min(1),
    payload: transcriptSegmentSchema,
  }),
  z.object({
    type: z.literal("cue"),
    meetingId: z.string().min(1),
    payload: cueSchema,
  }),
  z.object({
    type: z.literal("summary"),
    meetingId: z.string().min(1),
    payload: meetingSummarySchema,
  }),
  z.object({
    type: z.literal("task"),
    meetingId: z.string().min(1),
    payload: taskEventPayloadSchema,
  }),
  z.object({
    type: z.literal("action"),
    meetingId: z.string().min(1),
    payload: actionEventPayloadSchema,
  }),
  z.object({
    type: z.literal("delivery"),
    meetingId: z.string().min(1),
    payload: deliveryEventPayloadSchema,
  }),
  z.object({
    type: z.literal("status"),
    meetingId: z.string().min(1),
    payload: meetingStatusPayloadSchema,
  }),
  z.object({
    type: z.literal("error"),
    meetingId: z.string().min(1),
    payload: errorPayloadSchema,
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("glance-qm"),
  version: z.string().min(1),
  providers: z.object({
    qm: z.enum(["configured", "unconfigured", "degraded"]),
    gbrain: z.enum(["configured", "unconfigured", "degraded"]),
    memorable: z.enum(["configured", "unconfigured", "degraded"]),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
