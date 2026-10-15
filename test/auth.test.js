import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, verifyPassword } from '../server/auth.js';

test('密码哈希使用独立随机盐，正确区分密码和不存在的账号', () => {
  const password = '测试密码🀄-123456';
  const { salt, hash } = passwordHash(password);
  assert.match(salt, /^[a-f0-9]{32}$/); assert.match(hash, /^[a-f0-9]{64}$/);
  const user = { salt, password_hash: hash };
  assert.equal(verifyPassword(password, user), true);
  assert.equal(verifyPassword(password + 'x', user), false);
  assert.equal(verifyPassword(password, null), false);
  const another = passwordHash(password);
  assert.notEqual(another.salt, salt); assert.notEqual(another.hash, hash);
});
