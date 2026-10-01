import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChatImage, interpretChatImage, guardImageBytes, validateImageInterpretation, MAX_IMAGE_BYTES } from '../src/image-input.mjs';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5p8AAAAASUVORK5CYII=';
const knowledgeText = '# Private complete framework\n' + 'Synthetic private knowledge stays intact. '.repeat(100);
const context = { userProfile: 'Fictional profile.', counterpartProfile: 'Fictional counterpart.', messages: [] };
const output = { description: '画面里是一只猫，文字像是“知道了”；说话人不能确认。', kind: 'sticker', uncertainty: '不能仅凭表情确定是调侃或拒绝。' };
const env = { AGNES_API_KEY: 'synthetic-key' };
const response = (value) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function', function: { name: 'submit_coaching_result', arguments: JSON.stringify(value) } }] } }] }) });

test('image validation accepts bounded canonical raster bytes and rejects remote, malformed, mismatched and oversized inputs', () => {
  const image = validateChatImage(png); assert.equal(image.mime, 'image/png'); assert.equal(image.bytes, 68); assert.match(image.hash, /^[a-f0-9]{64}$/);
  for (const invalid of ['https://example.test/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', png.replace('image/png', 'image/jpeg'), png.replace('base64,', 'base64, '), png.slice(0, -1), 'data:image/png;base64,YWJj']) assert.throws(() => validateChatImage(invalid), { code: 'IMAGE_INVALID' });
  assert.throws(() => validateChatImage(`data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`), { code: 'IMAGE_TOO_LARGE', status: 413 });
});
test('image understanding reuses one complete-KB structured provider request with distinct image and user explanation sources', async () => {
  let calls = 0;
  const result = await interpretChatImage({ context, image: validateChatImage(png), explanation: '我理解是开玩笑，不是她确认的意思。' }, { knowledgeText, env, fetchImpl: async (_url, request) => {
    calls++; const body = JSON.parse(request.body);
    assert.equal(body.messages[1].content, knowledgeText); assert.equal(body.messages[2].content[1].image_url.url, png);
    assert.equal(body.messages[2].content[0].type, 'text'); assert.ok(body.messages[2].content[0].text.includes('user_interpretation')); assert.ok(body.messages[2].content[0].text.includes('不是图片原文'));
    assert.equal(body.tool_choice.function.name, 'submit_coaching_result'); assert.equal(body.max_tokens, 1200);
    return response(output);
  } });
  assert.deepEqual(result, output); assert.equal(calls, 1);
});
test('untrusted image output cannot expose complete private knowledge or arbitrary fields, and failures never retry', async () => {
  let calls = 0;
  await assert.rejects(interpretChatImage({ context, image: validateChatImage(png) }, { knowledgeText, env, fetchImpl: async () => { calls++; return response({ ...output, extra: knowledgeText }); } }), { code: 'invalid_model_output' });
  await assert.rejects(interpretChatImage({ context, image: validateChatImage(png) }, { knowledgeText, env, fetchImpl: async () => { calls++; return response({ ...output, description: knowledgeText.slice(0, 500) }); } }), { code: 'OUTPUT_KNOWLEDGE_EXCERPT_BLOCKED' });
  assert.equal(calls, 2);
});

test('image bytes cannot be retained as an explanation or complete/split model text and failures never retry', async () => {
  const image = validateChatImage(png), encoded = png.split(',')[1], cut = 40;
  let calls = 0;
  const options = { knowledgeText, env, fetchImpl: async () => { calls++; return response(output); } };
  for (const explanation of [png, encoded, encoded.replace(/(.{16})/g, '$1\n'), encoded.replace(/=+$/, '')]) {
    await assert.rejects(interpretChatImage({ context, image, explanation }, options), { code: 'IMAGE_BYTES_BLOCKED' });
  }
  assert.equal(calls, 0, 'unsafe input fails before any provider request');
  for (const candidate of [
    { ...output, description: png },
    { ...output, uncertainty: encoded },
    { description: encoded.slice(0, cut), kind: 'sticker', uncertainty: encoded.slice(cut) },
    { uncertainty: `后半段：${encoded.slice(cut)}。`, kind: 'unknown', description: `前半段：${encoded.slice(0, cut)}。` },
    { ...output, description: encoded.replace(/(.{16})/g, '$1\n') },
  ]) {
    const before = calls;
    await assert.rejects(interpretChatImage({ context, image }, { ...options, fetchImpl: async () => { calls++; return response(candidate); } }), (error) => error.code === 'IMAGE_BYTES_BLOCKED' && error.message === 'IMAGE_BYTES_BLOCKED' && error.cause === undefined);
    assert.equal(calls, before + 1, 'unsafe output is not retried');
  }
  assert.deepEqual(await interpretChatImage({ context, image, explanation: '😂 我觉得这是开玩笑；不是对方确认的意思。' }, options), output);
  assert.doesNotThrow(() => guardImageBytes({ description: 'base64、PNG只是说明文字。', kind: 'unknown', uncertainty: 'A/B或😂都不代表原图。' }, image));
});

test('central interpretation validation blocks image bytes in extra values, keys and field fragments', () => {
  const image = validateChatImage(png), encoded = png.split(',')[1], cut = 40;
  for (const candidate of [
    { ...output, extra: png },
    { ...output, [encoded]: 'extra field' },
    { description: encoded.slice(0, cut), kind: 'sticker', uncertainty: '', extra: { remainder: encoded.slice(cut) } },
  ]) assert.throws(() => validateImageInterpretation(candidate, image), { code: 'IMAGE_BYTES_BLOCKED' });
  assert.throws(() => validateImageInterpretation({ ...output, extra: 'ordinary text' }, image), { code: 'invalid_model_output' });
});
