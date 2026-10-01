import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ContextUpdatesSchema, validateContextUpdates, normalizeContextUpdates, ContextUpdatesError } from '../src/context-updates.mjs';

const evidence = (messageId, quote, source = 'text') => ({ messageId, quote, source });
const context = {
  userProfile: '本人背景', counterpartProfile: '对方背景',
  messages: [
    { id: 'self', speaker: 'self', text: '我在上海做产品设计，喜欢骑车。周六 19:00 一起去湖畔咖啡见面？' },
    { id: 'other', speaker: 'other', text: '我住杭州，做品牌策划。好，周六 19:00 湖畔咖啡见。', annotation: { text: '我们是在上海朋友聚会认识的。', source: 'user_annotation', updatedAt: '2026-10-01T08:00:00.000Z' } },
  ],
};
const confirmed = () => ({ facts: [], meeting: { status: 'confirmed', time: '周六 19:00', place: '湖畔咖啡', note: '双方记录了具体安排。', evidence: [evidence('self', '周六 19:00 一起去湖畔咖啡见面？'), evidence('other', '好，周六 19:00 湖畔咖啡见。')] } });
const fact = (subject = 'other', field = 'work', value = '品牌策划', ev = evidence('other', '做品牌策划')) => ({ subject, field, value, evidence: [ev] });
const invalid = (value, input = context) => assert.throws(() => validateContextUpdates(value, input), (error) => error instanceof ContextUpdatesError && error.code === 'INVALID_CONTEXT_UPDATES');

test('optional output absence stays backward compatible and unknown creates no fact or arrangement', () => {
  assert.equal(validateContextUpdates(undefined, context), undefined);
  assert.deepEqual(validateContextUpdates({ facts: [], meeting: null }, context), { facts: [], meeting: null });
});
test('native schema is closed and bounded for facts, meeting and exact evidence quotes', () => {
  const schema = z.toJSONSchema(ContextUpdatesSchema);
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.facts.maxItems, 24);
  assert.equal(schema.properties.facts.items.properties.value.maxLength, 160);
  assert.equal(schema.properties.facts.items.properties.evidence.maxItems, 4);
  assert.equal(schema.properties.facts.items.properties.evidence.items.properties.quote.maxLength, 300);
  invalid({ facts: [], meeting: null, rawConversation: 'private material' });
});
test('self and other statements and explicit annotation history retain separate source evidence', () => {
  const value = { facts: [fact('self', 'work', ' 产品设计 ', evidence('self', '做产品设计')), fact(), fact('relationship', 'met', '上海朋友聚会认识', evidence('other', '上海朋友聚会认识', 'annotation'))], meeting: null };
  const result = normalizeContextUpdates(value, context); assert.equal(result.facts[0].value, '产品设计');
  assert.equal(result.facts[2].evidence[0].source, 'annotation'); assert.deepEqual(result.facts[1], fact());
  assert.equal(value.facts[0].value, ' 产品设计 ', 'Normalization does not mutate the supplied result');
});
test('unknown IDs, fabricated quotes, wrong text/annotation source and duplicate evidence fail closed', () => {
  for (const ev of [evidence('missing', '做品牌策划'), evidence('other', '做金融'), evidence('other', '上海朋友聚会认识'), evidence('other', '做品牌策划', 'annotation')]) invalid({ facts: [fact('other', 'work', '品牌策划', ev)], meeting: null });
  invalid({ facts: [{ ...fact(), evidence: [evidence('other', '做品牌策划'), evidence('other', '做品牌策划')] }], meeting: null });
});
test('speaker identity and one current subject/field slot prevent attribution to the wrong person or contradictory duplicates', () => {
  invalid({ facts: [fact('self')], meeting: null }); invalid({ facts: [fact('other', 'location', '上海', evidence('self', '我在上海'))], meeting: null });
  invalid({ facts: [fact(), { ...fact(), value: '不同职业' }], meeting: null }); invalid({ facts: [fact('self', 'met', '见面', evidence('self', '见面'))], meeting: null });
});
test('inferred drafts cannot establish self or counterpart identity facts but explicit added annotations remain labeled user reports', () => {
  const input = { ...context, messages: [{ id: 'draft', speaker: 'self', text: '我是律师，喜欢潜水。', provenance: 'inferred_from_followup', annotation: { text: '本人实际从事产品设计。', source: 'user_annotation', updatedAt: '2026-10-01T08:00:00.000Z' } }] };
  invalid({ facts: [fact('self', 'work', '律师', evidence('draft', '我是律师'))], meeting: null }, input);
  const value = { facts: [fact('self', 'work', '产品设计', evidence('draft', '实际从事产品设计', 'annotation'))], meeting: null };
  assert.deepEqual(validateContextUpdates(value, input), value);
});
test('cropped annotation quotes cannot turn image guesses into stated background', () => {
  for (const text of ['图片里看起来像住在杭州。', '我猜她是品牌策划。', 'Maybe she works in design.']) {
    const quote = text.includes('杭州') ? '杭州' : text.includes('品牌策划') ? '品牌策划' : 'design';
    const input = { ...context, messages: [{ ...context.messages[1], annotation: { text, source: 'user_annotation', updatedAt: '2026-10-01T08:00:00.000Z' } }] };
    invalid({ facts: [fact('other', 'background', quote, evidence('other', quote, 'annotation'))], meeting: null }, input);
  }
  const input = { ...context, messages: [{ ...context.messages[1], annotation: { text: '照片里看起来像杭州；她本人说自己住在上海。', source: 'user_annotation', updatedAt: '2026-10-01T08:00:00.000Z' } }] };
  assert.equal(validateContextUpdates({ facts: [fact('other', 'location', '上海', evidence('other', '自己住在上海', 'annotation'))], meeting: null }, input).facts[0].value, '上海');
});
test('confirmed meeting uses both recorded parties with verbatim time/place, without inventing platform verification', () => {
  assert.deepEqual(validateContextUpdates(confirmed(), context), confirmed());
  for (const field of ['time', 'place']) { const value = confirmed(); value.meeting[field] = ''; invalid(value); value.meeting[field] = '未提及的安排'; invalid(value); }
  for (const speaker of ['self', 'other']) { const value = confirmed(); value.meeting.evidence = value.meeting.evidence.filter((ev) => ev.messageId === speaker); invalid(value); }
});
test('adjacent short affirmative answers can accept a concrete evidenced invitation, while unrelated good/availability/laugh/emoji cannot', () => {
  for (const answer of ['好呀', '好的', '可以', '没问题', '我会去。', '我会来', '我会到场', 'OK']) {
    const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer);
    assert.equal(validateContextUpdates(value, input).meeting.status, 'confirmed');
  }
  for (const answer of ['有空', '哈哈', '🙂', '周六有空', '好像没时间', '那天可能有空']) {
    const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer); invalid(value, input);
  }
  for (const answer of ['好呀', '我会去。']) {
    const input = { ...context, messages: [context.messages[0], { id: 'unrelated', speaker: 'self', text: '我买了本书。' }, { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer); invalid(value, input);
  }
});
test('quote slicing cannot conceal negation or uncertainty in the surrounding recorded clause', () => {
  for (const answer of ['我没有确认见面', '我还没确认周六 19:00 湖畔咖啡见', '我可能到时见', '我不是确认见面']) {
    const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer.includes('见面') ? '确认见面' : answer.includes('到时见') ? '到时见' : '周六 19:00 湖畔咖啡见'); invalid(value, input);
  }
  const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: '见面可以啊，不过周六没空，再看吧。' }] };
  const value = confirmed(); value.meeting.evidence[1] = evidence('other', '见面可以啊'); invalid(value, input);
});
test('a generic question about meeting is not agreement while concrete counterpart invitation plus recorded self acceptance can agree', () => {
  const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: '你想见面吗？' }] };
  const value = confirmed(); value.meeting.evidence[1] = evidence('other', '见面'); invalid(value, input);
  const concrete = { ...context, messages: [{ id: 'other', speaker: 'other', text: '周六 19:00 一起去湖畔咖啡见面？' }, { id: 'self', speaker: 'self', text: '好呀' }] };
  value.meeting.evidence = [evidence('other', concrete.messages[0].text), evidence('self', '好呀')]; assert.equal(validateContextUpdates(value, concrete).meeting.status, 'confirmed');
});
test('a concrete invitation accepted with 不见不散 is not mistaken for negative 不见', () => {
  const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: '好，周六 19:00 湖畔咖啡不见不散。' }] };
  const value = confirmed(); value.meeting.evidence[1] = evidence('other', '不见不散'); assert.equal(validateContextUpdates(value, input).meeting.status, 'confirmed');
});
test('generic meeting preferences and unrelated plans cannot accept a concrete invitation', () => {
  for (const answer of ['我其实喜欢线下见面聊。', '我会去健身。']) {
    const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer); invalid(value, input);
  }
  for (const answer of ['就这么定。', '按这个安排。', '不见不散。', '没问题']) {
    const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: answer }] };
    const value = confirmed(); value.meeting.evidence[1] = evidence('other', answer);
    assert.equal(validateContextUpdates(value, input).meeting.status, 'confirmed');
  }
});
test('image descriptions and user-supplied meanings cannot launder ambiguous speakers through text evidence', () => {
  for (const text of ['【图片记录·AI识读后可修改，不是准确原文，可能包含双方内容】\n左边说我是老师，右边说我是医生。', '嗯\n【用户补充意思·非对方原文】\n我猜她说的是我是医生。']) {
    const input = { ...context, messages: [{ id: 'image', speaker: 'other', text }] };
    invalid({ facts: [fact('other', 'work', '医生', evidence('image', '我是医生'))], meeting: null }, input);
  }
  const input = { ...context, messages: [context.messages[0], { id: 'other', speaker: 'other', text: '【图片记录·AI识读后可修改，不是准确原文，可能包含双方内容】\n好，周六 19:00 湖畔咖啡见。' }] };
  const value = confirmed(); invalid(value, input);
  const actual = { ...context, messages: [{ id: 'actual', speaker: 'other', text: '我是医生。\n【用户补充意思·非对方原文】\n我猜她说的是想约会。' }] };
  assert.equal(validateContextUpdates({ facts: [fact('other', 'work', '医生', evidence('actual', '我是医生'))], meeting: null }, actual).facts[0].value, '医生');
});
test('inferred invitation can be proposed and counterpart explicit acceptance can confirm it without proving self identity', () => {
  const input = { ...context, messages: [{ ...context.messages[0], provenance: 'inferred_from_followup' }, context.messages[1]] };
  assert.equal(validateContextUpdates(confirmed(), input).meeting.status, 'confirmed');
  const proposed = confirmed(); proposed.meeting.status = 'proposed'; proposed.meeting.evidence = [proposed.meeting.evidence[0]];
  assert.equal(validateContextUpdates(proposed, input).meeting.status, 'proposed');
});
test('annotations and model plans alone cannot fabricate mutual confirmed agreement', () => {
  const input = { ...context, messages: [{ id: 'other', speaker: 'other', text: '哈哈', annotation: { text: '线下曾提议周六 19:00 湖畔咖啡见面。', source: 'user_annotation', updatedAt: '2026-10-01T08:00:00.000Z' } }] };
  const value = confirmed(); value.meeting.evidence = [evidence('other', '周六 19:00 湖畔咖啡见面', 'annotation')]; invalid(value, input);
  invalid({ facts: [], meeting: { ...value.meeting, evidence: [evidence('future-plan', '周六 19:00 湖畔咖啡见面')] } }, input);
});
test('hand-recorded boundary suppresses only old derived meeting and retains evidenced background without mutating source', () => {
  const input = { ...context, counterpartProfile: JSON.stringify({ manualMeetingBoundary: { source: 'user_recorded_meeting', messageIdsAtSave: ['self', 'other'] } }) };
  const value = { ...confirmed(), facts: [fact()] };
  assert.deepEqual(validateContextUpdates(value, input), { facts: [fact()], meeting: null }); assert.equal(value.meeting.status, 'confirmed');
  const fresh = { ...input, messages: [...input.messages, { id: 'new', speaker: 'other', text: '我们约好周六 19:00 湖畔咖啡见。' }] };
  const updated = confirmed(); updated.meeting.evidence[1] = evidence('new', '约好周六 19:00 湖畔咖啡见'); assert.equal(validateContextUpdates(updated, fresh).meeting.status, 'confirmed');
  const unrelated = { ...input, messages: [...input.messages, { id: 'busy', speaker: 'other', text: '最近忙工作。' }] };
  const smuggled = confirmed(); smuggled.meeting.evidence.push(evidence('busy', '最近忙工作')); assert.equal(validateContextUpdates(smuggled, unrelated).meeting, null, 'A new but unrelated quote cannot revive a cancelled old arrangement');
});
test('proposed, alternative and declined arrangements can retain unknown slots, and no prior projection is accumulated', () => {
  for (const status of ['proposed', 'alternative', 'declined']) {
    const value = { facts: [], meeting: { status, time: '', place: '', note: '未提供具体时间地点。', evidence: [evidence('other', '好，周六 19:00 湖畔咖啡见。')] } };
    assert.deepEqual(validateContextUpdates(value, context), value);
  }
  const old = validateContextUpdates({ facts: [fact()], meeting: null }, context);
  const current = validateContextUpdates({ facts: [], meeting: null }, context); assert.deepEqual(current, { facts: [], meeting: null }); assert.equal(old.facts.length, 1);
});
test('errors contain categories and fixed paths, never quote, identity values or message identifiers', () => {
  const privateValue = 'private-marker-not-in-any-record';
  try { validateContextUpdates({ facts: [fact('other', 'work', privateValue, evidence('private-id', privateValue))], meeting: null }, context); assert.fail('Expected evidence rejection'); }
  catch (error) { assert.equal(error.code, 'INVALID_CONTEXT_UPDATES'); assert.doesNotMatch(JSON.stringify(error), /private-marker|private-id/); assert.deepEqual(error.diagnostics, [{ code: 'invalid_context_evidence_reference', path: ['facts', 0, 'evidence', 0, 'messageId'] }]); }
});
