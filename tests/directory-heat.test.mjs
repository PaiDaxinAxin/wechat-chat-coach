import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectoryHeat, latestCounterpartReply } from '../src/directory-heat.mjs';

const DAY = 86_400_000;
const anchor = Date.parse('2026-10-01T09:00:00.000Z');
const iso = (at) => new Date(at).toISOString();
const message = (id, at, speaker = 'other', text = '虚构对方回复。') => ({ id, speaker, text, recordedAt: iso(at) });
const sourceHeat = (score = 80, evidenceIds = ['other-1']) => ({ score, status: 'high_invite', evidenceIds, observedAt: iso(anchor + DAY) });
const messages = [message('other-1', anchor)];

test('whole continuous 24-hour periods decay an 80-point reference to 79 and 78', () => {
  for (const [elapsed, days, value] of [[0, 0, 80], [DAY - 1, 0, 80], [DAY, 1, 79], [2 * DAY - 1, 1, 79], [2 * DAY, 2, 78]]) {
    assert.deepEqual(buildDirectoryHeat(sourceHeat(), messages, { now: anchor + elapsed }), {
      value, baseValue: 80, inactiveDays: days, decayPerDay: 1,
      evaluatedAt: iso(anchor + elapsed), anchorAt: iso(anchor), kind: 'observed',
    });
  }
});

test('rounding happens once on the source assessment and subtraction never passes zero', () => {
  for (const [score, base] of [[0, 0], [2.49, 0], [2.5, 5], [62.49, 60], [62.5, 65], [80, 80], [97.5, 100], [100, 100]]) {
    const result = buildDirectoryHeat(sourceHeat(score), messages, { now: anchor + DAY });
    assert.equal(result.baseValue, base); assert.equal(result.value, Math.max(0, base - 1));
  }
  assert.equal(buildDirectoryHeat(sourceHeat(), messages, { now: anchor + 100 * DAY }).value, 0);
});

test('calendar midnight does not count as a day, including explicit time-zone offsets', () => {
  const at = '2026-10-01T23:59:59+08:00';
  const records = [{ id: 'other-1', speaker: 'other', recordedAt: at }];
  assert.equal(buildDirectoryHeat(sourceHeat(), records, { now: '2026-10-02T00:00:00+08:00' }).inactiveDays, 0);
  assert.equal(buildDirectoryHeat(sourceHeat(), records, { now: '2026-10-02T23:59:59+08:00' }).inactiveDays, 1);
});

test('sparse ranges have a separate preliminary kind and use their own source evidence', () => {
  const heat = { score: null, status: 'insufficient_evidence', evidenceIds: ['recent'], preliminaryRange: { lower: 35, upper: 75, evidenceIds: ['earlier'], provisional: true } };
  const result = buildDirectoryHeat(heat, [message('earlier', anchor), message('recent', anchor + 2 * DAY)], { now: anchor + 2 * DAY });
  assert.equal(result.kind, 'preliminary'); assert.equal(result.baseValue, 55);
  assert.equal(result.value, 53); assert.equal(result.anchorAt, iso(anchor));
  assert.equal(buildDirectoryHeat({ preliminaryRange: { lower: 10, upper: 45, evidenceIds: ['other-1'] } }, messages, { now: anchor }).baseValue, 30);
});

test('unknown and refusal states never display a numeric contact reference', () => {
  for (const heat of [null, undefined, {}, { score: null }, { score: NaN }, { score: Infinity }, { score: -1 }, { score: 101 }, { score: '80' }, { preliminaryRange: { lower: 70, upper: 10 } }, { preliminaryRange: { lower: 10, upper: Infinity } }]) {
    const result = buildDirectoryHeat(heat, messages, { now: anchor + DAY });
    assert.equal(result.kind, 'unknown'); assert.equal(result.baseValue, null); assert.equal(result.value, null);
    assert.equal(result.anchorAt, null); assert.equal(result.inactiveDays, 0);
  }
  const result = buildDirectoryHeat({ ...sourceHeat(100), status: 'pause', preliminaryRange: { lower: 85, upper: 100 } }, messages, { now: anchor + DAY });
  assert.equal(result.kind, 'pause'); assert.equal(result.baseValue, null); assert.equal(result.value, null);
});

test('only counterpart evidence from the source assessment supplies the anchor', () => {
  const records = [message('other-1', anchor), message('uncited', anchor + DAY), message('self-1', anchor + 2 * DAY, 'self')];
  const heat = sourceHeat(80, ['other-1', 'self-1', 'missing']);
  const result = buildDirectoryHeat(heat, records, { now: anchor + 2 * DAY });
  assert.equal(result.value, 78); assert.equal(result.anchorAt, iso(anchor));
  assert.equal(buildDirectoryHeat(sourceHeat(80, ['self-1']), records, { now: anchor + 2 * DAY }).anchorAt, null);
  assert.equal(buildDirectoryHeat(sourceHeat(80, []), records, { now: anchor + 2 * DAY }).anchorAt, null);
  assert.equal(buildDirectoryHeat(heat, records, { now: anchor + 2 * DAY, observedMessageIds: ['uncited', 'self-1'] }).anchorAt, null, 'A source snapshot can exclude a mismatched evidence ID, never add uncited current messages');
  assert.equal(buildDirectoryHeat(heat, records, { now: anchor + 2 * DAY, observedMessageIds: ['other-1'] }).anchorAt, iso(anchor));
});

test('refreshes, repeated analyses, profile metadata and self spam do not renew the same evidence', () => {
  const now = anchor + 4 * DAY;
  const records = [...messages, ...Array.from({ length: 4 }, (_, index) => message(`self-${index}`, anchor + (index + 1) * DAY, 'self', '嗨'))];
  const expected = buildDirectoryHeat(sourceHeat(), records, { now });
  const refreshed = { ...sourceHeat(), observedAt: iso(now), updatedAt: iso(now), copiedAt: iso(now) };
  assert.equal(expected.value, 76);
  assert.deepEqual(buildDirectoryHeat(refreshed, records, { now }), expected);
  assert.deepEqual(buildDirectoryHeat(refreshed, records, { now }), expected, 'Readback never writes the decayed value as a new base');
  assert.equal(buildDirectoryHeat(refreshed, records, { now: now + DAY }).value, 75);
});

test('a later reply cannot rebound an older assessment before a new assessment uses it', () => {
  const records = [...messages, message('other-2', anchor + 3 * DAY)];
  assert.equal(buildDirectoryHeat(sourceHeat(), records, { now: anchor + 3 * DAY }).value, 77);
  assert.equal(buildDirectoryHeat(sourceHeat(80, ['other-1', 'other-2']), records, { now: anchor + 3 * DAY }).value, 80);
});

test('corrected actual message times take priority over late recording and use the latest evidenced occurrence', () => {
  const records = [
    { ...message('other-1', anchor + 4 * DAY), wechatTime: { at: iso(anchor), source: 'user_reported', editedAt: iso(anchor + 4 * DAY) } },
    { ...message('other-2', anchor + 5 * DAY), wechatTime: { at: iso(anchor + DAY), source: 'user_reported', editedAt: iso(anchor + 5 * DAY) } },
  ];
  const result = buildDirectoryHeat(sourceHeat(80, ['other-1', 'other-2']), records, { now: anchor + 5 * DAY });
  assert.equal(result.anchorAt, iso(anchor + DAY)); assert.equal(result.inactiveDays, 4); assert.equal(result.value, 76);
});

test('invalid corrections fall back to recording time while missing legacy dates remain unknown', () => {
  for (const at of ['invalid', '', null, '2026-02-30T10:00:00Z', '2026-10-01T09:00:00']) {
    const records = [{ ...messages[0], wechatTime: { at } }];
    assert.equal(buildDirectoryHeat(sourceHeat(), records, { now: anchor + DAY }).value, 79);
  }
  const legacy = [{ id: 'other-1', speaker: 'other', text: '旧记录', createdAt: iso(anchor), updatedAt: iso(anchor + DAY) }];
  const result = buildDirectoryHeat(sourceHeat(), legacy, { now: anchor + 3 * DAY });
  assert.equal(result.anchorAt, null); assert.equal(result.inactiveDays, 0); assert.equal(result.value, 80);
  assert.deepEqual(buildDirectoryHeat({ ...sourceHeat(), observedAt: iso(anchor + 3 * DAY) }, legacy, { now: anchor + 3 * DAY }), result, 'A model timestamp cannot act as missing legacy interaction time');
});

test('future timestamps and a regressed server clock never create negative decay or overflow', () => {
  const result = buildDirectoryHeat(sourceHeat(), messages, { now: anchor - DAY });
  assert.equal(result.anchorAt, iso(anchor)); assert.equal(result.inactiveDays, 0); assert.equal(result.value, 80);
  for (const now of [NaN, Infinity, 'invalid', null, new Date(NaN)]) {
    assert.throws(() => buildDirectoryHeat(sourceHeat(), messages, { now }), RangeError);
  }
  assert.deepEqual(buildDirectoryHeat(sourceHeat(), messages, { now: new Date(anchor) }), buildDirectoryHeat(sourceHeat(), messages, { now: anchor }));
});

test('heat inputs and recorded messages remain unchanged', () => {
  const heat = Object.freeze({ ...sourceHeat(), evidenceIds: Object.freeze(['other-1']) });
  const records = Object.freeze([Object.freeze({ ...messages[0], annotation: Object.freeze({ text: '今天补了背景。', updatedAt: iso(anchor + DAY) }) })]);
  const before = JSON.stringify({ heat, records });
  buildDirectoryHeat(heat, records, { now: anchor + 5 * DAY }); latestCounterpartReply(records);
  assert.equal(JSON.stringify({ heat, records }), before);
  assert.equal(heat.score, 80);
});

test('latest reply preview follows stored order even after older timestamps are corrected', () => {
  const records = [
    message('older-record', anchor + DAY, 'other', '前一条'),
    { ...message('latest-record', anchor + 2 * DAY, 'other', ' 最新的\n对方回复 '), wechatTime: { at: iso(anchor), source: 'user_reported' } },
    message('self', anchor + 3 * DAY, 'self', '不应成为对方预览'),
  ];
  assert.deepEqual(latestCounterpartReply(records), { lastReplyAt: iso(anchor), lastReplyPreview: '最新的 对方回复' });
  assert.deepEqual(latestCounterpartReply([]), { lastReplyAt: null, lastReplyPreview: '' });
  assert.deepEqual(latestCounterpartReply([{ id: 'legacy', speaker: 'other', text: '旧文本', updatedAt: iso(anchor) }]), { lastReplyAt: null, lastReplyPreview: '旧文本' });
});

test('reply previews are bounded and do not split Unicode code points', () => {
  const preview = latestCounterpartReply([message('other-1', anchor, 'other', '🙂'.repeat(130))]);
  assert.equal(Array.from(preview.lastReplyPreview).length, 120);
  assert.equal(preview.lastReplyPreview, `${'🙂'.repeat(119)}…`);
});
