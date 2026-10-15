import { createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { check } from './game.js';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export function credentials(body) {
  check(typeof body.nickname === 'string', '请填写昵称');
  const nickname = body.nickname.normalize('NFKC').trim();
  check([...nickname].length >= 1 && [...nickname].length <= 12 && !/[\u0000-\u001f\u007f]/.test(nickname), '昵称须为 1～12 个字');
  check(typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 128, '密码须为 8～128 位');
  return { nickname, key: nickname.toLowerCase(), password: body.password };
}
export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 600000, 32, 'sha256').toString('hex') };
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
