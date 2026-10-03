import { z } from 'zod';
import { ChatMessageSchema } from './chat-record.mjs';

const id = z.string().trim().min(1).max(128);
const shortText = (maximum) => z.string().trim().max(maximum);

export const ContextEvidenceSchema = z.strictObject({
  messageId: id,
  // Preserve the exact quote. Trimming a quote would change the evidence.
  quote: z.string().min(1).max(300),
  source: z.enum(['text', 'annotation']),
});
const EvidenceSchema = z.array(ContextEvidenceSchema).min(1).max(4);
export const ContextFactSchema = z.strictObject({
  subject: z.enum(['self', 'other', 'relationship']),
  field: z.enum(['background', 'work', 'location', 'interests', 'availability', 'met', 'preference', 'relationship_goal']),
  value: shortText(160).min(1),
  evidence: EvidenceSchema,
});
export const ContextMeetingSchema = z.strictObject({
  status: z.enum(['proposed', 'alternative', 'confirmed', 'declined']),
  time: shortText(200),
  place: shortText(200),
  note: shortText(300),
  evidence: EvidenceSchema,
});
export const ContextUpdatesSchema = z.strictObject({
  facts: z.array(ContextFactSchema).max(24),
  meeting: ContextMeetingSchema.nullable(),
});

export class ContextUpdatesError extends Error {
  constructor(category, path = []) {
    super('INVALID_CONTEXT_UPDATES'); this.name = 'ContextUpdatesError'; this.code = 'INVALID_CONTEXT_UPDATES';
    // Fixed categories and schema paths only; never evidence, private values or IDs.
    this.diagnostics = [{ code: category, path }];
  }
}
function invalid(category, path) { throw new ContextUpdatesError(category, path); }

const annotationGuess = /(?:猜|推测|估计|也许|可能|好像|似乎|看起来|像是|大概|应该|不确定|uncertain|guess|maybe|possibly|perhaps|apparently|looks? like)/iu;
function containingClauses(text, quote) {
  const containing = (text.match(/[^。！？!?；;，,\n]+[。！？!?；;，,\n]*/gu) || [text]).filter((sentence) => sentence.includes(quote));
  return containing.length ? containing : [text];
}
function originalText(record) {
  // composeStoredMessage appends explicitly non-verbatim sections. Their text
  // stays in the full input, but has neither a reliable speaker nor fact source.
  const marker = record.text.search(/【(?:图片记录·AI识读后可修改，不是准确原文[^】]*|用户补充意思·非对方原文)】/u);
  return marker === -1 ? record.text : record.text.slice(0, marker);
}
function annotationIsGrounded(text, quote) {
  // A short quote must not hide the uncertainty in its enclosing annotation.
  return containingClauses(text, quote).every((sentence) => !annotationGuess.test(sentence));
}

function resolveEvidence(evidence, records, path) {
  const seen = new Set();
  return evidence.map((item, index) => {
    const key = JSON.stringify([item.messageId, item.source, item.quote]);
    if (seen.has(key)) invalid('duplicate_context_evidence', [...path, index]);
    seen.add(key);
    const record = records.get(item.messageId);
    if (!record) invalid('invalid_context_evidence_reference', [...path, index, 'messageId']);
    const source = item.source === 'annotation' ? record.annotation?.text : originalText(record);
    if (item.source === 'text' && !source.includes(item.quote) && record.text.includes(item.quote)) invalid('nonliteral_text_is_not_evidence', [...path, index, 'source']);
    if (typeof source !== 'string' || !item.quote.trim() || !source.includes(item.quote)) invalid('invalid_context_quote', [...path, index, 'quote']);
    if (item.source === 'annotation' && !annotationIsGrounded(source, item.quote)) invalid('speculative_annotation_fact', [...path, index, 'source']);
    return { record, item, sourceText: source };
  });
}

// A deliberately narrow arrangement guard, not a general conversation parser.
// Availability, laughter and emoji alone never establish mutual agreement.
const selfArrangement = /(?:就这么定|就这样定|就这么说定|约好了|约好|一言为定|不见不散|到时见|到时候见|准时见|见面|碰面|见吧|见啦|见哦|见你|再见面|我会(?:去|到|来)|我(?:过去|过来|会到)|按你说的|按这个安排|没有问题|没问题|确认|see you|confirmed|it'?s a date|let'?s meet|i(?:'ll| will) (?:come|be there))/iu;
const otherCommitment = /(?:就这么定|就这样定|就这么说定|约好了|约好|一言为定|不见不散|到时见|到时候见|准时见|按你说的|按这个安排|see you|it'?s a date)/iu;
const unresolvedArrangement = /(?:不(?:去|见|约|来)|别(?:约|见)|不方便|不想|没空|没时间|没有(?:确认|答应|同意|约好)|没(?:确认|答应|同意|约好)|不是(?:确认|约好|说好)|未确认|还没(?:确认|答应|定)|到时再说|再看|待定|也许|可能|好像|不确定|不一定|取消|not sure|maybe|cannot|can't|cancel|did not agree|haven't confirmed)/iu;
const shortAffirmation = /^(?:好(?:的|呀|啊|吧)?|可以|行(?:啊|呀)?|没问题|我会(?:去|来|到场|到)|ok(?:ay)?|yes|sure)[\s。.!！~～]*$/iu;
function arrangementUnresolved(entry) { return unresolvedArrangement.test(entry.sourceText.replace(/不见不散/gu, '约定见面')); }
function concreteInvitation(text, meeting) {
  return text.includes(meeting.time) && text.includes(meeting.place)
    && /(?:一起|约|见|去|喝|吃|meet|coffee|dinner|lunch)/iu.test(text)
    && !unresolvedArrangement.test(text.replace(/不见不散/gu, '约定见面'));
}
function adjacentInvitation(entry, meeting, messages, selfEvidence) {
  const index = messages.findIndex(({ id: messageId }) => messageId === entry.record.id), previous = messages[index - 1];
  return previous?.speaker === 'self' && selfEvidence.some(({ record }) => record.id === previous.id) && concreteInvitation(originalText(previous), meeting);
}
function otherClearlyAccepts(entry, meeting, messages, selfEvidence) {
  const clauses = containingClauses(entry.sourceText, entry.item.quote), quote = clauses.join('。');
  if (arrangementUnresolved(entry)) return false;
  if (/[?？]|(?:吗|么)[\s。!！~～]*$/u.test(quote.trim())) {
    const index = messages.findIndex(({ id: messageId }) => messageId === entry.record.id), next = messages[index + 1];
    // A concrete counterpart invitation followed by an actually recorded self
    // answer is different from a generic "你想见面吗？" or an inferred self draft.
    return concreteInvitation(entry.sourceText, meeting) && next?.speaker === 'self' && next.provenance !== 'inferred_from_followup'
      && selfEvidence.some(({ record }) => record.id === next.id) && shortAffirmation.test(originalText(next).trim());
  }
  if (shortAffirmation.test(entry.sourceText.trim())) {
    // Only an adjacent affirmative answer to a concrete, evidenced invitation.
    // "好" in an unrelated topic, or sliced out of "好像没空", cannot confirm it.
    return adjacentInvitation(entry, meeting, messages, selfEvidence);
  }
  // A generic preference for meeting, or going somewhere unrelated, is not an
  // acceptance. Unanchored wording must commit to the proposed arrangement.
  if (otherCommitment.test(quote)) return true;
  // Both anchors and an affirmative/date verb permit ordinary concrete wording,
  // without requiring one canned phrase such as "不见不散".
  return quote.includes(meeting.time) && quote.includes(meeting.place)
    && /(?:见|去|到|好|行|可以|同意|定|meet|okay|yes|sure)/iu.test(quote) && !/[?？]/u.test(quote);
}
function selfHasMeetingIntent(entry, meeting) {
  const quote = containingClauses(entry.sourceText, entry.item.quote).join('。');
  if (arrangementUnresolved(entry)) return false;
  if (selfArrangement.test(quote)) return true;
  if ((quote.includes(meeting.time) || quote.includes(meeting.place)) && /(?:一起|约|见|去|到|喝|吃|怎么样|如何|meet|coffee|dinner|lunch)/iu.test(quote)) return true;
  return entry.record.provenance !== 'inferred_from_followup' && shortAffirmation.test(entry.sourceText.trim());
}
function freshMeetingChange(sources, meeting, boundary, messages) {
  const fresh = sources.filter(({ record }) => !boundary.has(record.id));
  const textSources = sources.filter(({ item }) => item.source === 'text');
  const self = textSources.filter(({ record }) => record.speaker === 'self');
  return fresh.some((entry) => {
    const quote = containingClauses(entry.sourceText, entry.item.quote).join('。');
    const anchored = Boolean(meeting.time && quote.includes(meeting.time) || meeting.place && quote.includes(meeting.place));
    if (meeting.status === 'confirmed') {
      if (entry.item.source !== 'text' || entry.record.speaker !== 'other' || entry.record.provenance === 'inferred_from_followup') return false;
      if (!otherClearlyAccepts(entry, meeting, messages, self)) return false;
      return anchored || adjacentInvitation(entry, meeting, messages, self);
    }
    if (meeting.status === 'declined') return /(?:不(?:去|见|约|来)|没空|没时间|取消|不能去|cancel|can't|cannot)/iu.test(quote)
      && (anchored || /(?:不(?:去|见|约|来)|取消|不能去|cancel)/iu.test(quote) || adjacentInvitation(entry, meeting, messages, self));
    return anchored && /(?:一起|约|见|去|到|喝|吃|换|改|meet|coffee|dinner|lunch)/iu.test(quote)
      || /(?:想约|约你|找个时间|见面吧|碰个面|喝杯|换个时间|改天见|let'?s meet|want to meet)/iu.test(quote);
  });
}

function manualBoundary(context) {
  try {
    const profile = JSON.parse(context.counterpartProfile);
    const boundary = profile?.manualMeetingBoundary;
    if (boundary?.source === 'user_recorded_meeting' && Array.isArray(boundary.messageIdsAtSave) && boundary.messageIdsAtSave.every((value) => typeof value === 'string')) return new Set(boundary.messageIdsAtSave);
  } catch { /* Plain-text profiles are supported; they do not contain this metadata. */ }
  return null;
}

/** Validate one complete projection against the original, fully supplied records.
 * Undefined is the backwards-compatible absence of the new optional output.
 * This never writes profiles, carries prior projections forward or verifies that
 * a user-recorded statement is true outside the supplied conversation.
 */
export function validateContextUpdates(updates, context) {
  if (updates === undefined) return undefined;
  const parsed = ContextUpdatesSchema.safeParse(updates);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]; invalid(issue.code, issue.path);
  }
  const messages = z.array(ChatMessageSchema).safeParse(context?.messages);
  if (!messages.success) invalid('invalid_context_records', []);
  const records = new Map(messages.data.map((record) => [record.id, record]));
  if (records.size !== messages.data.length) invalid('duplicate_context_message_ids', []);
  const result = parsed.data, fields = new Set();
  result.facts.forEach((fact, index) => {
    const path = ['facts', index], key = `${fact.subject}:${fact.field}`;
    if (fields.has(key)) invalid('duplicate_context_fact_field', path);
    fields.add(key);
    const sources = resolveEvidence(fact.evidence, records, [...path, 'evidence']);
    for (const { record, item } of sources) {
      if (item.source === 'text' && record.provenance === 'inferred_from_followup') invalid('inferred_draft_is_not_fact', [...path, 'evidence']);
      if (item.source === 'text' && fact.subject !== 'relationship' && record.speaker !== fact.subject) invalid('context_subject_speaker_mismatch', [...path, 'subject']);
    }
    if (fact.field === 'met' && fact.subject !== 'relationship') invalid('meeting_history_subject_mismatch', [...path, 'subject']);
  });
  if (result.meeting) {
    const meeting = result.meeting, path = ['meeting'];
    const sources = resolveEvidence(meeting.evidence, records, [...path, 'evidence']);
    const boundary = manualBoundary(context);
    for (const field of ['time', 'place']) {
      if (meeting[field] && !sources.some(({ item }) => item.quote.includes(meeting[field]))) invalid('unsupported_meeting_anchor', [...path, field]);
    }
    if (meeting.status === 'confirmed') {
      if (!meeting.time || !meeting.place) invalid('confirmed_meeting_requires_time_and_place', path);
      const self = sources.filter(({ record, item }) => item.source === 'text' && record.speaker === 'self');
      const other = sources.filter(({ record, item }) => item.source === 'text' && record.speaker === 'other' && record.provenance !== 'inferred_from_followup');
      if (!self.length || !other.length) invalid('confirmed_meeting_requires_both_speakers', [...path, 'evidence']);
      if (!self.some((entry) => selfHasMeetingIntent(entry, meeting))) invalid('confirmed_meeting_requires_self_arrangement', [...path, 'evidence']);
      if (!other.some((entry) => otherClearlyAccepts(entry, meeting, messages.data, self))) invalid('confirmed_meeting_requires_explicit_other_agreement', [...path, 'evidence']);
    }
    // Old evidence may be valid history while a newer hand-entered decision is
    // authoritative. Suppress only the old derived meeting, preserving the reply
    // and evidenced facts; the API independently applies the private receipt.
    if (boundary && !freshMeetingChange(sources, meeting, boundary, messages.data)) result.meeting = null;
  }
  return result;
}

/** Keep only independently evidenced auxiliary output. Invalid extraction must
 * not discard an otherwise valid coaching result. Readback still uses the
 * complete strict validator above; no rejected candidate enters stored state.
 */
export function sanitizeContextUpdates(updates, context) {
  if (updates === undefined) return undefined;
  const empty = { facts: [], meeting: null };
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)
    || !Object.hasOwn(updates, 'facts') || !Object.hasOwn(updates, 'meeting')
    || Object.keys(updates).some((key) => !['facts', 'meeting'].includes(key))
    || !Array.isArray(updates.facts) || updates.facts.length > 24) return empty;

  const keyOf = (fact) => typeof fact?.subject === 'string' && typeof fact?.field === 'string' ? JSON.stringify([fact.subject, fact.field]) : null;
  const counts = new Map();
  for (const fact of updates.facts) {
    const key = keyOf(fact);
    if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const fact of updates.facts) {
    // Even one invalid duplicate makes the intended value unresolved. Never
    // select the first or last conflicting extraction as authoritative.
    if (counts.get(keyOf(fact)) > 1) continue;
    try { empty.facts.push(...validateContextUpdates({ facts: [fact], meeting: null }, context).facts); }
    catch (error) { if (!(error instanceof ContextUpdatesError)) throw error; }
  }
  try { empty.meeting = validateContextUpdates({ facts: [], meeting: updates.meeting }, context).meeting; }
  catch (error) { if (!(error instanceof ContextUpdatesError)) throw error; }
  return empty;
}

// Normalization is schema trimming plus the same evidence validation; it is not
// a second source of derived state or a NLP reconstruction of missing facts.
export const normalizeContextUpdates = validateContextUpdates;
