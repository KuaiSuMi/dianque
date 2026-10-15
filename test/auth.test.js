import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { passwordHash, verifyPassword } from '../server/auth.js';

test('密码运算在 Cloudflare 原生 KDF 限制内完成，正确区分密码和不存在的账号', (t) => {
  const { pbkdf2Sync, scryptSync } = crypto;
  t.mock.method(crypto, 'pbkdf2Sync', (...args) => {
    assert.ok(args[2] <= 100000, 'Cloudflare PBKDF2 上限为 100000 次');
    return pbkdf2Sync(...args);
  });
  t.mock.method(crypto, 'scryptSync', (password, salt, length, options) => {
    assert.ok(options.N * options.r * options.p <= 2 ** 20, 'Cloudflare scrypt 成本上限为 2^20');
    assert.ok(options.maxmem <= 64 * 1024 * 1024, '密码运算为其他房间状态保留内存');
    return scryptSync(password, salt, length, options);
  });
  syncBuiltinESMExports();
  try {
    const password = '测试密码🀄-123456';
    const { salt, hash } = passwordHash(password);
    assert.match(salt, /^[a-f0-9]{32}$/); assert.match(hash, /^[a-f0-9]{64}$/);
    const user = { salt, password_hash: hash };
    assert.equal(verifyPassword(password, user), true);
    assert.equal(verifyPassword(password + 'x', user), false);
    assert.equal(verifyPassword(password, null), false);
    const another = passwordHash(password);
    assert.notEqual(another.salt, salt); assert.notEqual(another.hash, hash);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
