import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'dist/public');
const files = ['index.html', 'app.js', 'styles.css'];
const check = spawnSync(process.execPath, ['--check', join(root, 'web/app.js')], { encoding: 'utf8' });
if (check.status !== 0) throw new Error('PUBLIC_JAVASCRIPT_SYNTAX_INVALID');
const assets = await Promise.all(files.map(async (name) => {
  const bytes = await readFile(join(root, 'web', name));
  const text = bytes.toString('utf8');
  if (/BEGIN_SOURCE_GAME_3_3|sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_-]{24,}|AGNES_API_KEY\s*=/.test(text)) {
    throw new Error('PUBLIC_ASSET_PRIVATE_MATERIAL_DETECTED');
  }
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const asset of assets) await writeFile(join(destination, asset.name), asset.bytes);
await writeFile(join(root, 'dist/build.json'), JSON.stringify({
  formatVersion: 1,
  builtAt: new Date().toISOString(),
  assets: assets.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })),
  includesKnowledge: false,
}, null, 2) + '\n');
console.log(`Built ${assets.length} public assets. Knowledge and credentials stay on the server.`);
