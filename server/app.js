import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { applyAction, check, GameError, joinRoom, leaveRoom, newRoom, prepareNextMatch, publicRoom, stateOf } from './game.js';
import { cookie, credentials, nicknameValue, passwordValue, newToken, passwordHash, sessionHash, SESSION_SECONDS, verifyPassword, digest } from './auth.js';

const codePattern = /^[A-Z]{4}$/;
const active = (room) => ['playing', 'settling'].includes(stateOf(room).status);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } });

async function bodyOf(request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  let size = 0, text = '';
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); fail(413, '请求过大'); }
    text += decoder.decode(value, { stream: true });
  }
  if (!size) return {};
  check(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', '请求格式须为 JSON');
  let body;
  try { body = JSON.parse(text + decoder.decode()); } catch { fail(400, '请求格式错误'); }
  check(body && typeof body === 'object' && !Array.isArray(body), '请求格式错误');
  return body;
}

export class Dianque {
  constructor({ database = ':memory:', adminId = '', clients = new Set() } = {}) {
    if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
    this.db = new DatabaseSync(database);
    this.adminId = adminId;
    this.clients = clients;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, nickname_key TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, active_room TEXT, last_room TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, published INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS riichi_voices (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, audio BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS riichi_voice_volumes (voice_id TEXT PRIMARY KEY, volume INTEGER NOT NULL CHECK(volume BETWEEN 0 AND 100));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (user_id TEXT NOT NULL, code TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY(user_id,code));
      CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, code TEXT NOT NULL, ended_at TEXT NOT NULL, player_count INTEGER NOT NULL, length TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS matches_room ON matches(code,ended_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS results (match_id TEXT NOT NULL, user_id TEXT NOT NULL, rank INTEGER NOT NULL, score INTEGER NOT NULL, PRIMARY KEY(match_id,user_id));
      CREATE INDEX IF NOT EXISTS results_user ON results(user_id,match_id);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS limits_expiry ON limits(until);
    `);
  }

  rows(query, ...args) { return this.db.prepare(query).all(...args); }
  one(query, ...args) { return this.rows(query, ...args)[0]; }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sockets(tag) { return [...this.clients].filter((ws) => !tag || ws.data.code === tag || ws.data.userId === tag); }
  checkLimit(key, max, message = '操作太频繁', cost = 1) {
    const now = Date.now();
    const row = this.one('SELECT count,until FROM limits WHERE key=?', key);
    if (row && row.until > now && row.count + cost > max) {
      const retryAfter = Math.ceil((row.until - now) / 1000);
      const wait = retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} 分钟` : `${retryAfter} 秒`;
      throw Object.assign(new Error(`${message}，请在 ${wait}后重试`), { status: 429, retryAfter });
    }
    return row;
  }
  limit(key, max, duration = 60000, message = '操作太频繁', cost = 1) {
    const row = this.checkLimit(key, max, message, cost), now = Date.now();
    this.rows('INSERT INTO limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until=excluded.until', key, row && row.until > now ? row.count + cost : cost, row && row.until > now ? row.until : now + duration);
  }
  clearLoginLimits(key) {
    this.rows('DELETE FROM limits WHERE key LIKE ?', `login:%:${digest(key)}`);
  }
  user(request) {
    const hash = sessionHash(request);
    return hash ? this.one('SELECT users.*,sessions.hash AS session_hash,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?', hash, Date.now()) : null;
  }
  isSuperAdmin(user) { return user.id === this.adminId; }
  isAdmin(user) { return this.isSuperAdmin(user) || !!this.one('SELECT user_id FROM admins WHERE user_id=?', user.id); }
  publicUser(user) { return { id: user.id, nickname: user.nickname, isAdmin: this.isAdmin(user), isSuperAdmin: this.isSuperAdmin(user) }; }
  session(user) { return { user: this.publicUser(user), activeRoom: user.active_room, lastRoom: user.last_room }; }
  createUser(body, { salt, hash }) {
    const { nickname, key } = credentials(body);
    if (this.one('SELECT id FROM users WHERE nickname_key=?', key)) fail(409, '昵称已被使用');
    const id = randomUUID();
    this.rows('INSERT INTO users(id,nickname_key,nickname,salt,password_hash,created_at) VALUES (?,?,?,?,?,?)', id, key, nickname, salt, hash, new Date().toISOString());
    return this.one('SELECT * FROM users WHERE id=?', id);
  }
  async admin(request, url, body, user) {
    if (!this.isAdmin(user)) fail(403, '仅管理员可使用管理功能');
    if (url.pathname.startsWith('/api/admin/announcements')) return this.announcements(request, url, body);
    const matchRoute = url.pathname.match(/^\/api\/admin\/matches\/([a-f0-9-]{36})$/);
    if (matchRoute && request.method === 'DELETE') {
      const changed = this.transaction(() => {
        const match = this.one('SELECT code FROM matches WHERE id=?', matchRoute[1]);
        if (!match) fail(404, '对局记录不存在');
        const room = this.room(match.code);
        if (room.matchId === matchRoute[1]) {
          check(stateOf(room).status === 'ended', '只能移除已经结束的对局记录');
          prepareNextMatch(room); room.revision++;
          this.save(room);
        }
        this.rows('DELETE FROM results WHERE match_id=?', matchRoute[1]);
        this.rows('DELETE FROM matches WHERE id=?', matchRoute[1]);
        return room;
      });
      this.broadcast(changed);
      return json({ ok: true });
    }
    if (url.pathname === '/api/admin/users' && request.method === 'POST') {
      check(Object.keys(body).length === 2 && Object.keys(body).every((key) => ['nickname', 'password'].includes(key)), '请填写昵称和密码');
      this.checkLimit(`admin:${user.id}`, 30, '账号修改次数过多');
      const encoded = await passwordHash(credentials(body).password);
      const created = this.transaction(() => {
        user = this.user(request);
        if (!user) fail(401, '请先登录');
        if (!this.isAdmin(user)) fail(403, '仅管理员可使用管理功能');
        this.limit(`admin:${user.id}`, 30, 3600000, '账号修改次数过多');
        return this.createUser(body, encoded);
      });
      return json({ user: this.publicUser(created) }, 201);
    }
    if (url.pathname === '/api/admin/users' && request.method === 'GET') {
      const query = (url.searchParams.get('q') || '').normalize('NFKC').trim().toLowerCase();
      const offset = Number(url.searchParams.get('offset') || 0);
      check(query.length <= 128 && Number.isSafeInteger(offset) && offset >= 0, '查询条件无效');
      const total = this.one('SELECT COUNT(*) AS n FROM users WHERE instr(nickname_key,?)>0', query).n;
      const users = this.rows('SELECT id,nickname,created_at FROM users WHERE instr(nickname_key,?)>0 ORDER BY created_at DESC,id LIMIT 20 OFFSET ?', query, offset);
      return json({ total, users: users.map((row) => ({ ...this.publicUser(row), createdAt: row.created_at })) });
    }
    const route = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9-]{36})(?:\/(role|matches))?$/);
    if (!route) fail(404, '接口不存在');
    const target = this.one('SELECT * FROM users WHERE id=?', route[1]);
    if (!target) fail(404, '账号不存在');
    if (route[2] === 'matches' && request.method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      check(Number.isSafeInteger(offset) && offset >= 0, '页码无效');
      const matches = this.rows('SELECT matches.id,code,ended_at AS endedAt,player_count AS playerCount,rank,score,payload FROM matches JOIN results ON results.match_id=matches.id WHERE user_id=? ORDER BY ended_at DESC,matches.id DESC LIMIT 20 OFFSET ?', target.id, offset);
      return json({ total: this.one('SELECT COUNT(*) AS n FROM results WHERE user_id=?', target.id).n, matches: matches.map(({ payload, ...match }) => ({ ...match, players: JSON.parse(payload).players })) });
    }
    if (route[2] === 'role' && request.method === 'POST') {
      if (!this.isSuperAdmin(user)) fail(403, '只有超级管理员可以任免管理员');
      check(!this.isSuperAdmin(target), '不能修改超级管理员的权限');
      check(Object.keys(body).length === 1 && typeof body.isAdmin === 'boolean', '管理员权限无效');
      if (body.isAdmin) this.rows('INSERT OR IGNORE INTO admins VALUES (?)', target.id);
      else this.rows('DELETE FROM admins WHERE user_id=?', target.id);
      return json({ user: this.publicUser(target) });
    }
    if (route[2]) fail(404, '接口不存在');
    if (!this.isSuperAdmin(user) && this.isAdmin(target) && target.id !== user.id) fail(403, '只有超级管理员可以修改其他管理员');
    if (request.method === 'DELETE') {
      check(target.id !== user.id && !this.isSuperAdmin(target), '不能删除自己或超级管理员');
      const rooms = this.transaction(() => {
        const rooms = this.rows('SELECT rooms.payload FROM rooms JOIN members ON rooms.code=members.code WHERE members.user_id=?', target.id).map(({ payload }) => JSON.parse(payload));
        check(!target.active_room && !rooms.some((room) => active(room)), '该账号正在对局，请结束对局后再删除');
        for (const room of rooms) {
          if (room.players.some((p) => p.id === target.id)) { leaveRoom(room, target.id); this.save(room); }
        }
        this.rows('DELETE FROM sessions WHERE user_id=?', target.id);
        this.rows('DELETE FROM admins WHERE user_id=?', target.id);
        this.rows('DELETE FROM members WHERE user_id=?', target.id);
        this.rows('DELETE FROM results WHERE user_id=?', target.id);
        this.clearLoginLimits(target.nickname_key);
        this.rows('DELETE FROM limits WHERE key IN (?,?,?)', `password:${target.id}`, `request:${target.id}`, `admin:${target.id}`);
        this.rows('DELETE FROM users WHERE id=?', target.id);
        return rooms;
      });
      for (const ws of this.sockets(target.id)) ws.close(4001, '账号已删除');
      rooms.forEach((room) => this.broadcast(room));
      return json({ ok: true });
    }
    if (request.method !== 'POST') fail(404, '接口不存在');
    const fields = Object.keys(body);
    check(fields.length > 0 && fields.every((key) => ['nickname', 'password'].includes(key)), '仅支持修改昵称或密码');
    const renamed = 'nickname' in body ? nicknameValue(body.nickname) : null;
    const password = 'password' in body ? passwordValue(body.password) : null;
    this.checkLimit(`admin:${user.id}`, 30, '账号修改次数过多');
    const encoded = password ? await passwordHash(password) : null;
    const rooms = [];
    const updated = this.transaction(() => {
      user = this.user(request);
      if (!user) fail(401, '请先登录');
      if (!this.isAdmin(user)) fail(403, '仅管理员可使用管理功能');
      const target = this.one('SELECT * FROM users WHERE id=?', route[1]);
      if (!target) fail(404, '账号不存在');
      if (!this.isSuperAdmin(user) && this.isAdmin(target) && target.id !== user.id) fail(403, '只有超级管理员可以修改其他管理员');
      if (password) check(!user.active_room && !target.active_room, '对局中禁止修改密码，请结束并确认结算后再修改');
      this.limit(`admin:${user.id}`, 30, 3600000, '账号修改次数过多');
      if (renamed) {
        if (this.one('SELECT id FROM users WHERE nickname_key=? AND id<>?', renamed.key, target.id)) fail(409, '昵称已被使用');
        this.rows('UPDATE users SET nickname=?,nickname_key=? WHERE id=?', renamed.nickname, renamed.key, target.id);
        for (const row of this.rows('SELECT rooms.payload FROM members JOIN rooms ON rooms.code=members.code WHERE members.user_id=?', target.id)) {
          const room = JSON.parse(row.payload), player = room.players.find((p) => p.id === target.id);
          if (!player) continue;
          player.name = renamed.nickname; room.revision++;
          this.rows('UPDATE rooms SET payload=? WHERE code=?', JSON.stringify(room), room.code);
          rooms.push(room);
        }
      }
      if (password) {
        const { salt, hash } = encoded;
        this.rows('UPDATE users SET salt=?,password_hash=? WHERE id=?', salt, hash, target.id);
        this.rows('DELETE FROM sessions WHERE user_id=?', target.id);
        this.rows('DELETE FROM limits WHERE key=?', `password:${target.id}`);
      }
      this.clearLoginLimits(target.nickname_key);
      if (renamed) this.clearLoginLimits(renamed.key);
      return this.publicUser({ ...target, nickname: renamed?.nickname || target.nickname });
    });
    if (password) for (const ws of this.sockets(updated.id)) ws.close(4001, '密码已重置，请重新登录');
    rooms.forEach((room) => this.broadcast(room));
    const signedOut = !!password && updated.id === user.id;
    return json({ user: updated, signedOut }, 200, signedOut ? { 'Set-Cookie': cookie('', request, 0) } : {});
  }
  announcements(request, url, body) {
    if (url.pathname === '/api/admin/announcements' && request.method === 'GET') return json(this.rows('SELECT * FROM announcements ORDER BY updated_at DESC,id DESC LIMIT 100'));
    const route = url.pathname.match(/^\/api\/admin\/announcements(?:\/([a-f0-9-]{36}))?$/);
    if (route?.[1] && request.method === 'DELETE') {
      const revision = Number(url.searchParams.get('revision'));
      check(Number.isSafeInteger(revision) && revision > 0, '公告版本无效');
      const previous = this.one('SELECT revision FROM announcements WHERE id=?', route[1]);
      if (!previous) fail(404, '公告不存在或已被删除');
      check(revision === previous.revision, '公告已被修改，请重新打开后再删除');
      this.rows('DELETE FROM announcements WHERE id=?', route[1]);
      return json({ ok: true });
    }
    if (!route || request.method !== 'POST') fail(404, '接口不存在');
    check(Object.keys(body).every((key) => ['title', 'content', 'published', 'revision'].includes(key)), '公告字段无效');
    check(typeof body.title === 'string' && body.title.trim().length > 0 && body.title.length <= 80, '公告标题须为 1～80 字');
    check(typeof body.content === 'string' && body.content.trim().length > 0 && body.content.length <= 3000, '公告正文须为 1～3000 字');
    check(typeof body.published === 'boolean', '请选择公告发布状态');
    const id = route[1] || randomUUID();
    this.transaction(() => {
      const previous = this.one('SELECT revision FROM announcements WHERE id=?', id);
      if (route[1] && !previous) fail(404, '公告不存在');
      check(!previous || body.revision === previous.revision, '公告已被修改，请重新打开');
      this.rows('INSERT INTO announcements VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,published=excluded.published,revision=excluded.revision,updated_at=excluded.updated_at', id, body.title.trim(), body.content.trim(), Number(body.published), (previous?.revision || 0) + 1, new Date().toISOString());
    });
    return json(this.one('SELECT * FROM announcements WHERE id=?', id), route[1] ? 200 : 201);
  }
  room(code, user) {
    check(codePattern.test(code), '房间码为 4 位大写字母');
    const row = this.one('SELECT payload FROM rooms WHERE code=?', code);
    if (!row) fail(404, '房间不存在');
    const room = JSON.parse(row.payload);
    if (user && !room.players.some((p) => p.id === user.id)) fail(403, '你不在这个房间');
    return room;
  }
  checkActive(user, code) {
    const current = this.one('SELECT active_room FROM users WHERE id=?', user.id).active_room;
    check(!current || current === code, `对局尚未结束，请先回到房间 ${current}`);
  }
  view(room) {
    return publicRoom(room, this.sockets(room.code).filter((ws) => ws.readyState === 1).map((ws) => ws.data.userId));
  }
  broadcast(room) {
    const sockets = this.sockets(room.code);
    for (const ws of sockets) {
      if (ws.readyState !== 1) continue;
      const { sessionHash: hash, userId } = ws.data;
      if (!this.one('SELECT hash FROM sessions WHERE hash=? AND expires_at>?', hash, Date.now())) ws.close(4001, '登录已过期');
      else if (!room.players.some((p) => p.id === userId)) ws.close(4002, '已退出房间');
    }
    const message = JSON.stringify(this.view(room));
    for (const ws of sockets) if (ws.readyState === 1) { try { ws.send(message); } catch { ws.close(1011, '请重新连接'); } }
  }
  archive(room) {
    const state = stateOf(room);
    if (state.status !== 'ended') return;
    const { players, events, config } = publicRoom(room);
    const endedAt = room.history[room.cursor].entry.at;
    const record = { id: room.matchId, code: room.code, createdAt: room.createdAt, endedAt, state, config, events, players: players.map(({ id, name, seat }) => ({ id, name, seat })) };
    this.rows('INSERT INTO matches VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,payload=excluded.payload', record.id, room.code, endedAt, players.length, config.length, JSON.stringify(record));
    const ranking = [...players].sort((a, b) => state.scores[b.seat] - state.scores[a.seat] || a.seat - b.seat);
    ranking.forEach((p, i) => this.rows('INSERT INTO results VALUES (?,?,?,?) ON CONFLICT(match_id,user_id) DO UPDATE SET rank=excluded.rank,score=excluded.score', record.id, p.id, i + 1, state.scores[p.seat]));
  }
  save(room) {
    if (active(room)) {
      for (const player of room.players) {
        const other = this.one('SELECT active_room FROM users WHERE id=?', player.id).active_room;
        check(!other || other === room.code, `${player.name}正在另一房间对局`);
      }
      room.players.forEach((p) => this.rows('UPDATE users SET active_room=?,last_room=? WHERE id=?', room.code, room.code, p.id));
    } else this.rows('UPDATE users SET active_room=NULL WHERE active_room=?', room.code);
    this.archive(room);
    // 已结束场次独立存入 matches，避免每次广播重复传输历史。
    room.matches = [];
    this.rows('INSERT INTO rooms VALUES (?,?) ON CONFLICT(code) DO UPDATE SET payload=excluded.payload', room.code, JSON.stringify(room));
  }

  async fetch(request, { ip, upgrade } = {}) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (method !== 'GET' || request.headers.get('Upgrade')) {
        if (request.headers.get('Origin') !== url.origin) fail(403, '不允许跨站操作');
      }
      if (path === '/api/health') return json({ ok: true });
      if (path === '/api/announcements' && method === 'GET') return json(this.rows('SELECT id,title,content,revision,updated_at FROM announcements WHERE published=1 ORDER BY updated_at DESC,id DESC LIMIT 100'));
      const body = method === 'POST' && request.body ? await bodyOf(request) : {};
      if (method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
        this.limit(`auth:${ip}`, 30, 15 * 60000, '登录或注册请求过多');
        const { nickname, key, password } = credentials(body);
        const loginKey = `login:${ip}:${digest(key)}`;
        const snapshot = this.one('SELECT * FROM users WHERE nickname_key=?', key);
        if (path === '/api/register' && snapshot) fail(409, '昵称已被使用');
        this.checkLimit(path === '/api/register' ? `registered:${ip}` : loginKey, path === '/api/register' ? 8 : 10, path === '/api/register' ? '注册账号过多' : '登录尝试过多');
        const encoded = path === '/api/register' ? await passwordHash(password) : null;
        const verified = path === '/api/login' && await verifyPassword(password, snapshot);
        // 账号、会话和配额一起提交，服务端故障不消耗注册或昵称登录额度。
        return this.transaction(() => {
          let user = this.one('SELECT * FROM users WHERE nickname_key=?', key);
          if (path === '/api/register') {
            if (user) fail(409, '昵称已被使用');
            this.limit(`registered:${ip}`, 8, 3600000, '注册账号过多');
            user = this.createUser({ nickname, password }, encoded);
          } else {
            this.limit(loginKey, 10, 15 * 60000, '登录尝试过多');
            // 密码错误仍须提交失败计数，不能抛出异常触发回滚。
            if (!verified || !user || user.id !== snapshot.id || user.password_hash !== snapshot.password_hash) return json({ error: '昵称或密码不正确' }, 401);
          }
          this.rows('DELETE FROM limits WHERE key=? OR until<?', loginKey, Date.now());
          this.rows('DELETE FROM sessions WHERE expires_at<?', Date.now());
          const token = newToken();
          this.rows('INSERT INTO sessions VALUES (?,?,?)', digest(token), user.id, Date.now() + SESSION_SECONDS * 1000);
          return json(this.session(user), path === '/api/register' ? 201 : 200, { 'Set-Cookie': cookie(token, request) });
        });
      }
      const user = this.user(request);
      if (path === '/api/session' && method === 'GET') return json(user ? this.session(user) : { user: null });
      if (!user) fail(401, '请先登录');
      this.limit(`request:${user.id}`, 120);
      if (path.startsWith('/api/admin/')) return await this.admin(request, url, body, user);
      if (path === '/api/password' && method === 'POST') {
        check(!user.active_room, '对局中禁止修改密码，请结束并确认结算后再修改');
        check(Object.keys(body).length === 2 && Object.keys(body).every((key) => ['currentPassword', 'newPassword'].includes(key)), '请填写原密码和新密码');
        const currentPassword = passwordValue(body.currentPassword), newPassword = passwordValue(body.newPassword);
        check(currentPassword !== newPassword, '新密码不能与原密码相同');
        this.checkLimit(`password:${user.id}`, 10, '原密码验证次数过多');
        const verified = await verifyPassword(currentPassword, user);
        const encoded = verified ? await passwordHash(newPassword) : null;
        const response = this.transaction(() => {
          const current = this.user(request);
          if (!current || current.password_hash !== user.password_hash) fail(401, '请重新登录');
          check(!current.active_room, '对局中禁止修改密码，请结束并确认结算后再修改');
          this.limit(`password:${user.id}`, 10, 15 * 60000, '原密码验证次数过多');
          if (!verified) return json({ error: '原密码不正确' }, 400);
          const { salt, hash } = encoded;
          this.rows('UPDATE users SET salt=?,password_hash=? WHERE id=?', salt, hash, user.id);
          this.rows('DELETE FROM sessions WHERE user_id=?', user.id);
          this.rows('DELETE FROM limits WHERE key=?', `password:${user.id}`);
          this.clearLoginLimits(user.nickname_key);
          return json({ ok: true }, 200, { 'Set-Cookie': cookie('', request, 0) });
        });
        if (response.ok) for (const ws of this.sockets(user.id)) ws.close(4001, '密码已修改，请重新登录');
        return response;
      }
      if (path === '/api/logout' && method === 'POST') {
        this.rows('DELETE FROM sessions WHERE hash=?', user.session_hash);
        for (const ws of this.sockets()) if (ws.data.sessionHash === user.session_hash) ws.close(4001, '已退出登录');
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('', request, 0) });
      }
      if (path === '/api/rooms' && method === 'GET') {
        const rows = this.rows('SELECT rooms.code,rooms.payload FROM members JOIN rooms ON rooms.code=members.code WHERE members.user_id=? ORDER BY joined_at DESC LIMIT 50', user.id);
        return json(rows.map(({ payload }) => { const room = JSON.parse(payload); return { code: room.code, config: { ...room.config, playerCount: stateOf(room).scores.length }, status: stateOf(room).status }; }));
      }
      if (path === '/api/rooms' && method === 'POST') {
        this.checkActive(user);
        this.limit(`create:${user.id}`, 10, 3600000);
        let code;
        do { code = Array.from({ length: 4 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(26)]).join(''); } while (this.one('SELECT code FROM rooms WHERE code=?', code));
        const room = newRoom(code, { id: user.id, name: user.nickname, seat: 0 }, { startPoints: body.startPoints ?? 25000, startDealer: 0, length: body.length ?? 'south', tsumoConfirm: body.tsumoConfirm ?? false, autoDice: body.autoDice ?? false }, body.playerCount ?? 4);
        this.transaction(() => {
          this.save(room);
          this.rows('INSERT INTO members VALUES (?,?,?)', user.id, code, new Date().toISOString());
          this.rows('UPDATE users SET last_room=? WHERE id=?', code, user.id);
        });
        return json(this.view(room), 201);
      }
      if (path === '/api/history' && method === 'GET') {
        const count = Number(url.searchParams.get('players') || 4);
        check([3, 4].includes(count), '对局人数无效');
        const offset = Number(url.searchParams.get('offset') || 0);
        check(Number.isSafeInteger(offset) && offset >= 0, '页码无效');
        const stats = this.one('SELECT COUNT(*) AS games,AVG(results.rank) AS averageRank FROM results JOIN matches ON matches.id=results.match_id WHERE user_id=? AND player_count=?', user.id, count);
        const query = 'SELECT matches.id,code,ended_at AS endedAt,length,player_count AS playerCount,rank,score FROM results JOIN matches ON matches.id=results.match_id WHERE user_id=? AND player_count=? ORDER BY ended_at DESC,matches.id DESC LIMIT 20 OFFSET ?';
        return json({ ...stats, recent: this.rows(query, user.id, count, 0).reverse(), matches: this.rows(query, user.id, count, offset) });
      }
      const matchRoute = path.match(/^\/api\/matches\/([a-f0-9-]{36})$/);
      if (matchRoute && method === 'GET') {
        const row = this.one('SELECT payload FROM matches JOIN results ON results.match_id=matches.id WHERE matches.id=? AND results.user_id=?', matchRoute[1], user.id);
        if (!row) fail(404, '对局记录不存在');
        return json(JSON.parse(row.payload));
      }
      const route = path.match(/^\/api\/rooms\/([A-Z]{4})(?:\/(join|leave|action|socket|history))?$/);
      if (!route) fail(404, '接口不存在');
      const [, code, operation] = route;
      if (operation === 'join' && method === 'POST') {
        this.checkActive(user, code);
        const room = this.room(code);
        this.transaction(() => {
          if (!room.players.some((p) => p.id === user.id)) { joinRoom(room, { id: user.id, name: user.nickname, seat: room.players.length }); this.save(room); }
          this.rows('INSERT INTO members VALUES (?,?,?) ON CONFLICT(user_id,code) DO UPDATE SET joined_at=excluded.joined_at', user.id, code, new Date().toISOString());
          this.rows('UPDATE users SET last_room=? WHERE id=?', code, user.id);
        });
        this.broadcast(room);
        return json(this.view(room));
      }
      const room = this.room(code, user);
      if (operation === 'history' && method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        check(Number.isSafeInteger(offset) && offset >= 0, '页码无效');
        return json(this.rows('SELECT payload FROM matches JOIN results ON results.match_id=matches.id WHERE code=? AND matches.id<>? AND results.user_id=? ORDER BY ended_at DESC,matches.id DESC LIMIT 20 OFFSET ?', code, room.matchId, user.id, offset).map(({ payload }) => JSON.parse(payload)));
      }
      this.checkActive(user, code);
      if (!operation && method === 'GET') return json(this.view(room));
      if (operation === 'leave' && method === 'POST') {
        this.transaction(() => {
          leaveRoom(room, user.id);
          this.save(room);
          this.rows('DELETE FROM members WHERE user_id=? AND code=?', user.id, code);
          this.rows('UPDATE users SET last_room=NULL WHERE id=? AND last_room=?', user.id, code);
        });
        this.broadcast(room);
        return json({ ok: true });
      }
      if (operation === 'action' && method === 'POST') {
        this.transaction(() => { if (applyAction(room, user.id, body)) this.save(room); });
        this.broadcast(room);
        return json(this.view(room));
      }
      if (operation === 'socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        check(this.sockets(user.id).length < 12, '打开的页面过多，请关闭部分页面后重试');
        if (!upgrade) fail(400, '需要 WebSocket 连接');
        return upgrade({ code, userId: user.id, sessionHash: user.session_hash }, room);
      }
      fail(404, '接口不存在');
    } catch (error) {
      const status = error instanceof GameError ? 400 : error.status || 500;
      if (status === 500) console.error(error);
      return json({ error: status === 500 ? '服务暂时不可用，请重试' : error.message }, status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  }
}
