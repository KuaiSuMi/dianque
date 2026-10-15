import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, verifyPassword } from '../server/auth.js';
import { scryptSync } from 'node:crypto';

test('密码哈希使用独立随机盐，正确区分密码和不存在的账号', async () => {
  const password = '测试密码🀄-123456';
  const { salt, hash } = await passwordHash(password);
  assert.match(salt, /^[a-f0-9]{32}$/); assert.match(hash, /^[a-f0-9]{64}$/);
  const user = { salt, password_hash: hash };
  assert.equal(await verifyPassword(password, user), true);
  assert.equal(await verifyPassword(password + 'x', user), false);
  assert.equal(await verifyPassword(password, null), false);
  const another = await passwordHash(password);
  assert.notEqual(another.salt, salt); assert.notEqual(another.hash, hash);
  assert.equal(hash, scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'), '已保存的密码哈希格式不变');
});

test('密码计算让出事件循环，超过四个并发立即拒绝，完成后恢复容量', async () => {
  let complete = 0;
  const work = Array.from({ length: 4 }, () => passwordHash('bounded-password').then(() => complete++));
  try {
    await assert.rejects(passwordHash('excess-password'), (error) => error.status === 503 && error.retryAfter === 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(complete, 0, '计算期间仍可处理事件循环');
  } finally { await Promise.all(work); }
  assert.match((await passwordHash('after-completion')).hash, /^[a-f0-9]{64}$/);
});
