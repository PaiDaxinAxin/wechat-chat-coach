import { z } from 'zod';

export const ReplyIntervalSchema = z.strictObject({
  fromAt: z.iso.datetime().nullable(), toAt: z.iso.datetime(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  fromSource: z.enum(['clipboard_copied', 'suggestion_prepared', 'user_reported_wechat_sent', 'unknown']),
  toSource: z.enum(['counterpart_text_recorded', 'user_reported_wechat_received']),
  reliability: z.enum(['app_interval_estimate', 'weak_preparation_estimate', 'user_reported_interval', 'unknown']),
  interpretation: z.literal('not_verified_wechat_latency'),
});

export const ChatMessageSchema = z.strictObject({
  id: z.string().trim().min(1), speaker: z.enum(['self', 'other']), text: z.string().trim().min(1),
  provenance: z.enum(['user_entered', 'user_entered_edit', 'user_confirmed_record', 'inferred_from_followup']).optional(),
  recordedAt: z.iso.datetime().optional(),
  wechatTime: z.strictObject({ at: z.iso.datetime(), source: z.literal('user_reported'), editedAt: z.iso.datetime() }).nullable().optional(),
  replyInterval: ReplyIntervalSchema.nullable().optional(),
});

export const COACH_CONTEXT_VERSION = 'recorded-context-2';
// Bump whenever output schemas or coaching policy change, so persisted results
// from an older protocol cannot masquerade as the current classification.
export const COACH_PROTOCOL_VERSION = 'native-coaching-3';
