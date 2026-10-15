import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { check } from './game.js';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export function nicknameValue(value) {
  check(typeof value === 'string', '请填写昵称');
  const nickname = value.normalize('NFKC').trim();
  check([...nickname].length >= 1 && [...nickname].length <= 12 && !/[\u0000-\u001f\u007f]/.test(nickname), '昵称须为 1～12 个字');
  return { nickname, key: nickname.toLowerCase() };
}
export function passwordValue(value) {
  check(typeof value === 'string' && value.length >= 8 && value.length <= 128, '密码须为 8～128 位');
  return value;
}
export function credentials(body) {
  return { ...nicknameValue(body.nickname), password: passwordValue(body.password) };
}
export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  // 使用 scrypt 的 32 MiB 档位，避免小内存实例因密码校验耗尽内存。
  return { salt, hash: scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex') };
}
export function verifyPassword(password, user) {
  const actual = passwordHash(password, user?.salt || '0'.repeat(32)).hash;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(user?.password_hash || '0'.repeat(64), 'hex')) && !!user;
}
export function cookie(token, request, maxAge = SESSION_SECONDS) {
  return `dianque_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export function sessionHash(request) {
  const token = request.headers.get('Cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith('dianque_session='))?.slice(16);
  return token && /^[a-f0-9]{64}$/.test(token) ? digest(token) : null;
}
