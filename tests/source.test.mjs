import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('the imported game 3.3 original retains the supplied bytes', async () => {
  const bytes = await readFile(new URL('../knowledge/game-system.md', import.meta.url));
  const start = Buffer.from('<!-- BEGIN_SOURCE_GAME_3_3 -->\n');
  const end = Buffer.from('\n<!-- END_SOURCE_GAME_3_3 -->');
  const startIndex = bytes.indexOf(start);
  const endIndex = bytes.indexOf(end);
  assert.ok(startIndex >= 0 && endIndex > startIndex);
  const original = bytes.subarray(startIndex + start.length, endIndex);
  assert.equal(original.length, 30_291);
  assert.equal(createHash('sha256').update(original).digest('hex'),
    '1da5b778618c20c50f803193050b1aa7163bb9bddc99450f2ee88c226ed8ef67');
});
