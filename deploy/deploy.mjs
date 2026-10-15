import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = 'root@47.94.42.14';
const origin = 'https://dianque.me';
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（${result.status ?? result.signal}）`);
  return result.stdout?.trim();
}
const git = (...args) => run('git', args, { stdio: ['ignore', 'pipe', 'inherit'] });

try {
  assert.equal(git('status', '--porcelain'), '', '存在未提交的修改，请先提交并推送 GitHub');
  run('git', ['fetch', 'origin', 'main']);
  const revision = git('rev-parse', 'FETCH_HEAD');
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(git('rev-parse', 'HEAD'), revision, '本地提交与 GitHub main 不一致，请先推送或拉取');
  console.log(`部署 GitHub 提交：${revision}`);
  run('ssh', [...sshOptions, target, `bash -s -- ${revision}`], {
    input: git('show', `${revision}:deploy/update.sh`) + '\n',
    stdio: ['pipe', 'inherit', 'inherit']
  });
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, '公网健康检查失败，请检查安全组和 Caddy');
  assert.deepEqual(await response.json(), { ok: true });
  console.log(`部署完成：${origin}（${revision.slice(0, 7)}）`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
