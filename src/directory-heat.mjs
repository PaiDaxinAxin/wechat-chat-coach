import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1_000;
const TimestampSchema = z.iso.datetime({ offset: true });

function timestamp(value) {
  if (!TimestampSchema.safeParse(value).success) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function messageTime(message) {
  return timestamp(message?.wechatTime?.at) ?? timestamp(message?.recordedAt);
}

function evaluationTime(now) {
  const value = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : timestamp(now);
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new RangeError('Invalid directory evaluation time');
  return value;
}

function baseHeat(heat) {
  if (heat?.status === 'pause') return { kind: 'pause', baseValue: null, evidenceIds: [] };
  if (Number.isFinite(heat?.score) && heat.score >= 0 && heat.score <= 100) {
    return { kind: 'observed', baseValue: Math.round(heat.score / 5) * 5, evidenceIds: heat.evidenceIds };
  }
  const range = heat?.preliminaryRange;
  if (Number.isFinite(range?.lower) && Number.isFinite(range?.upper) && range.lower >= 0 && range.upper <= 100 && range.lower <= range.upper) {
    return { kind: 'preliminary', baseValue: Math.round((range.lower + range.upper) / 10) * 5, evidenceIds: range.evidenceIds ?? heat.evidenceIds };
  }
  return { kind: 'unknown', baseValue: null, evidenceIds: [] };
}

/** Read-time contact reference, not a calibrated attraction score or invitation
 * threshold. Always start from the immutable assessment; never pass a previously
 * decayed directory value back in as the source score. The caller supplies its
 * trusted server clock, and may restrict evidence to the assessment's snapshot.
 */
export function buildDirectoryHeat(heat, messages, { now = Date.now(), observedMessageIds } = {}) {
  const evaluated = evaluationTime(now);
  const { kind, baseValue, evidenceIds } = baseHeat(heat);
  const sourceIds = new Set(Array.isArray(evidenceIds) ? evidenceIds : []);
  if (observedMessageIds !== undefined) {
    const observed = new Set(Array.isArray(observedMessageIds) ? observedMessageIds : []);
    for (const id of sourceIds) if (!observed.has(id)) sourceIds.delete(id);
  }
  let anchor = null;
  if (baseValue !== null) {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.speaker !== 'other' || !sourceIds.has(message.id)) continue;
      const at = messageTime(message);
      if (at !== null && (anchor === null || at > anchor)) anchor = at;
    }
  }
  // Missing historical timestamps remain unknown. Neither model observedAt nor
  // profile edits, copy receipts or unilateral messages can renew this anchor.
  const inactiveDays = anchor === null ? 0 : Math.floor(Math.max(0, evaluated - anchor) / DAY_MS);
  return {
    value: baseValue === null ? null : Math.max(0, baseValue - inactiveDays),
    baseValue,
    inactiveDays,
    decayPerDay: 1,
    evaluatedAt: new Date(evaluated).toISOString(),
    anchorAt: anchor === null ? null : new Date(anchor).toISOString(),
    kind,
  };
}

/** The directory preview follows stored conversation order. Correcting a clock
 * changes this message's displayed time, not which message is the latest reply.
 */
export function latestCounterpartReply(messages) {
  const last = Array.isArray(messages) ? messages.findLast((message) => message?.speaker === 'other') : undefined;
  const at = messageTime(last);
  const text = typeof last?.text === 'string' ? last.text.trim().replace(/\s+/gu, ' ') : '';
  const points = Array.from(text);
  return {
    lastReplyAt: at === null ? null : new Date(at).toISOString(),
    lastReplyPreview: points.length > 120 ? `${points.slice(0, 119).join('')}…` : text,
  };
}
