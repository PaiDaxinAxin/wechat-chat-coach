import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { BetaError } from './beta-store.mjs';
import { QUESTIONNAIRES, validateProfile, CounterpartInputSchema } from './domain.mjs';

const seeds = new WeakMap();
const USERNAME = 'local-demo';

export function assertLocalDemoRequest(req) {
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) || Object.keys(req.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-') || ['x-real-ip', 'via'].includes(name))) throw new BetaError('DEMO_LOOPBACK_REQUIRED', 403);
}

// The private receipt makes seeding resumable, without resetting an edited demo.
async function receiptFor(store) {
  const path = join(store.dataDir, 'demo-seed.json');
  let receipt;
  try { receipt = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new BetaError('DEMO_SEED_INVALID', 500);
    receipt = { version: 1, initialized: false, counterpartId: null };
    await writeFile(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  }
  if (receipt.version !== 1 || typeof receipt.initialized !== 'boolean' || !(receipt.counterpartId === null || typeof receipt.counterpartId === 'string')) throw new BetaError('DEMO_SEED_INVALID', 500);
  await chmod(path, 0o600);
  return { path, receipt };
}

export function ensureLocalDemoSeed(store) {
  if (seeds.has(store)) return seeds.get(store);
  const pending = (async () => {
    const { path, receipt } = await receiptFor(store);
    let user = store.getUserByUsername(USERNAME);
    if (!user) user = await store.seedOwner({ username: USERNAME, password: `${randomBytes(32).toString('base64url')}A1` });
    if (user.role !== 'owner') throw new BetaError('DEMO_ACCOUNT_CONFLICT', 409);
    if (receipt.userId && receipt.userId !== user.id) throw new BetaError('DEMO_ACCOUNT_CONFLICT', 409);
    if (!receipt.initialized) {
      if (!store.getProfile(user.id)) store.putProfile(user.id, validateProfile({
        background: '【虚构演示】男生，28岁，产品设计师，住在杭州，喜欢徒步和摄影。',
        style: '简短、自然、偶尔幽默，不喜欢连续追问。',
        growthGoals: '练习接住对方感受，再自然表达兴趣，不急着升级关系。',
        relationshipGoal: '认真了解彼此，在双方愿意时约一次轻松见面。',
        questionnaire: { kind: 'short', answers: Object.fromEntries(QUESTIONNAIRES.short.map(({ id }, index) => [id, [3, 4, 3, 2, 4][index % 5]])) },
      }, user.plan));
      let counterpart = store.listCounterparts(user.id)[0];
      if (!counterpart) counterpart = store.putCounterpart(user.id, CounterpartInputSchema.parse({
        alias: '小禾 · 虚构演示', channel: 'app',
        appProfile: '【虚构】27岁，杭州，品牌策划；喜欢跑步、咖啡和周末小旅行。',
        offlineScene: '', background: '【虚构】交友软件匹配后加微信，已简单聊过各自的兴趣；还没有见面。', rounds: 2,
      }));
      receipt.counterpartId = counterpart.id;
      // Stable message IDs are not necessary: a partially seeded conversation is
      // retained as-is after interruption, rather than inventing additional turns.
      if (store.listMessages(user.id, counterpart.id).length === 0) {
        for (const message of [
          { speaker: 'self', text: '看到你也喜欢跑步，周末一般去哪儿跑？' },
          { speaker: 'other', text: '天气好的时候去江边，不过最近一直在忙工作。' },
          { speaker: 'self', text: '看来你最近节奏挺满，我这周也刚忙完一个项目。' },
          { speaker: 'other', text: '对呀，刚接了新项目。你是做什么的？' },
        ]) store.putMessage(user.id, counterpart.id, message);
      }
      receipt.initialized = true;
      receipt.userId = user.id;
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
      await rename(temporary, path);
    }
    let counterpartId = receipt.counterpartId;
    if (counterpartId) {
      try { store.getCounterpart(user.id, counterpartId); }
      catch (error) { if (error.code === 'COUNTERPART_NOT_FOUND') counterpartId = null; else throw error; }
    }
    return { user, counterpartId, synthetic: true };
  })();
  seeds.set(store, pending);
  const release = () => { if (seeds.get(store) === pending) seeds.delete(store); };
  pending.then(release, release);
  return pending;
}
