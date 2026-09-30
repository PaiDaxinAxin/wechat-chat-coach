import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createBetaStore, seedOwner } from '../src/beta-store.mjs';

function argument(name, fallback) {
  const position = process.argv.indexOf(`--${name}`);
  if (position === -1) return fallback;
  if (!process.argv[position + 1] || process.argv[position + 1].startsWith('--')) throw new Error('ARGUMENT_REQUIRED');
  return process.argv[position + 1];
}
const command = process.argv[2];
process.umask(0o077);
const dataDir = resolve(argument('data-dir', process.env.CHAT_COACH_DATA_DIR ?? 'data/beta'));
const store = createBetaStore({ dataDir });
try {
  if (command === 'init') {
    const username = argument('username', 'owner');
    const credentialsPath = resolve(argument('credentials-file', resolve(dataDir, 'owner-access.json')));
    const password = `P1-${randomBytes(24).toString('base64url')}`;
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    const file = await open(credentialsPath, 'wx', 0o600);
    let initialized = false;
    try {
      // The recoverable credential receipt must exist before the database commit.
      await file.writeFile(JSON.stringify({ username, password, createdAt: new Date().toISOString() }, null, 2) + '\n');
      await file.sync();
      await seedOwner(store, { username, password });
      initialized = true;
    } finally {
      await file.close();
      if (!initialized) await unlink(credentialsPath).catch(() => {});
    }
    console.log(`Owner initialized. Read credentials locally at ${credentialsPath}. No password was printed.`);
  } else if (command === 'invite') {
    const ownerId = argument('owner-id');
    const plan = argument('plan', 'free');
    const outputPath = resolve(argument('output', resolve(dataDir, `invite-${Date.now()}.json`)));
    if (!ownerId || !['free', 'paid'].includes(plan)) throw new Error('OWNER_ID_AND_VALID_PLAN_REQUIRED');
    const invitation = store.createInvite({ ownerId, plan });
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, JSON.stringify(invitation, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Invite written privately to ${outputPath}. Share it with the intended tester.`);
  } else {
    throw new Error('USE_INIT_OR_INVITE');
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'ADMIN_OPERATION_FAILED';
  console.error(code);
  process.exitCode = 1;
} finally {
  store.close();
}
