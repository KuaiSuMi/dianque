import { DurableObject } from 'cloudflare:workers';
import { randomInt, randomUUID } from 'node:crypto';
import { applyAction, check, GameError, joinRoom, leaveRoom, newRoom, publicRoom, stateOf } from './game.js';
import { cookie, credentials, newToken, passwordHash, sessionHash, SESSION_SECONDS, verifyPassword, digest } from './auth.js';

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

export class Dianque extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, nickname_key TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, active_room TEXT, last_room TEXT, created_at TEXT NOT NULL);
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
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0]; }
  limit(key, max, duration = 60000) {
    const now = Date.now();
    const row = this.one('SELECT count,until FROM limits WHERE key=?', key);
    if (row && row.until > now && row.count >= max) fail(429, '操作太频繁，请稍后再试');
    this.sql.exec('INSERT INTO limits VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,until=excluded.until', key, row && row.until > now ? row.count + 1 : 1, row && row.until > now ? row.until : now + duration);
  }
  user(request) {
    const hash = sessionHash(request);
    return hash ? this.one('SELECT users.*,sessions.hash AS session_hash,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>?', hash, Date.now()) : null;
  }
  session(user) { return { user: { id: user.id, nickname: user.nickname }, activeRoom: user.active_room, lastRoom: user.last_room }; }
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
    return publicRoom(room, this.ctx.getWebSockets(room.code).filter((ws) => ws.readyState === 1).map((ws) => ws.deserializeAttachment().userId));
  }
  broadcast(room) {
    const sockets = this.ctx.getWebSockets(room.code);
    for (const ws of sockets) {
      const { sessionHash: hash, userId } = ws.deserializeAttachment();
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
    this.sql.exec('INSERT INTO matches VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at,payload=excluded.payload', record.id, room.code, endedAt, players.length, config.length, JSON.stringify(record));
    const ranking = [...players].sort((a, b) => state.scores[b.seat] - state.scores[a.seat] || a.seat - b.seat);
    ranking.forEach((p, i) => this.sql.exec('INSERT INTO results VALUES (?,?,?,?) ON CONFLICT(match_id,user_id) DO UPDATE SET rank=excluded.rank,score=excluded.score', record.id, p.id, i + 1, state.scores[p.seat]));
  }
  save(room) {
    if (active(room)) {
      for (const player of room.players) {
        const other = this.one('SELECT active_room FROM users WHERE id=?', player.id).active_room;
        check(!other || other === room.code, `${player.name}正在另一房间对局`);
      }
      room.players.forEach((p) => this.sql.exec('UPDATE users SET active_room=?,last_room=? WHERE id=?', room.code, room.code, p.id));
    } else this.sql.exec('UPDATE users SET active_room=NULL WHERE active_room=?', room.code);
    this.archive(room);
    // 已结束场次独立存入 matches，避免每次广播重复传输历史。
    room.matches = [];
    this.sql.exec('INSERT INTO rooms VALUES (?,?) ON CONFLICT(code) DO UPDATE SET payload=excluded.payload', room.code, JSON.stringify(room));
  }

  async fetch(request) {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (method !== 'GET' || request.headers.get('Upgrade')) {
        if (request.headers.get('Origin') !== url.origin) fail(403, '不允许跨站操作');
      }
      if (path === '/api/health') return json({ ok: true });
      const body = method === 'POST' && request.body ? await bodyOf(request) : {};
      if (method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        this.limit(`auth:${ip}`, 30, 15 * 60000);
        const { nickname, key, password } = credentials(body);
        this.limit(`login:${key}`, 10, 15 * 60000);
        let user = this.one('SELECT * FROM users WHERE nickname_key=?', key);
        if (path === '/api/register') {
          this.limit(`register:${ip}`, 8, 3600000);
          if (user) fail(409, '昵称已被使用');
          const { salt, hash } = passwordHash(password);
          this.sql.exec('INSERT INTO users(id,nickname_key,nickname,salt,password_hash,created_at) VALUES (?,?,?,?,?,?)', randomUUID(), key, nickname, salt, hash, new Date().toISOString());
          user = this.one('SELECT * FROM users WHERE nickname_key=?', key);
        } else if (!verifyPassword(password, user)) fail(401, '昵称或密码不正确');
        this.sql.exec('DELETE FROM limits WHERE key=? OR until<?', `login:${key}`, Date.now());
        this.sql.exec('DELETE FROM sessions WHERE expires_at<?', Date.now());
        const token = newToken();
        this.sql.exec('INSERT INTO sessions VALUES (?,?,?)', digest(token), user.id, Date.now() + SESSION_SECONDS * 1000);
        return json(this.session(user), path === '/api/register' ? 201 : 200, { 'Set-Cookie': cookie(token, request) });
      }
      const user = this.user(request);
      if (path === '/api/session' && method === 'GET') return json(user ? this.session(user) : { user: null });
      if (!user) fail(401, '请先登录');
      this.limit(`request:${user.id}`, 120);
      if (path === '/api/logout' && method === 'POST') {
        this.sql.exec('DELETE FROM sessions WHERE hash=?', user.session_hash);
        for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment().sessionHash === user.session_hash) ws.close(4001, '已退出登录');
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('', request, 0) });
      }
      if (path === '/api/rooms' && method === 'GET') {
        const rows = this.sql.exec('SELECT rooms.code,rooms.payload FROM members JOIN rooms ON rooms.code=members.code WHERE members.user_id=? ORDER BY joined_at DESC LIMIT 50', user.id).toArray();
        return json(rows.map(({ payload }) => { const room = JSON.parse(payload); return { code: room.code, config: { ...room.config, playerCount: stateOf(room).scores.length }, status: stateOf(room).status }; }));
      }
      if (path === '/api/rooms' && method === 'POST') {
        this.checkActive(user);
        this.limit(`create:${user.id}`, 10, 3600000);
        let code;
        do { code = Array.from({ length: 4 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[randomInt(26)]).join(''); } while (this.one('SELECT code FROM rooms WHERE code=?', code));
        const room = newRoom(code, { id: user.id, name: user.nickname, seat: 0 }, { startPoints: body.startPoints ?? 25000, startDealer: 0, length: body.length ?? 'south' }, body.playerCount ?? 4);
        this.ctx.storage.transactionSync(() => {
          this.save(room);
          this.sql.exec('INSERT INTO members VALUES (?,?,?)', user.id, code, new Date().toISOString());
          this.sql.exec('UPDATE users SET last_room=? WHERE id=?', code, user.id);
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
        return json({ ...stats, recent: this.sql.exec(query, user.id, count, 0).toArray().reverse(), matches: this.sql.exec(query, user.id, count, offset).toArray() });
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
        this.ctx.storage.transactionSync(() => {
          if (!room.players.some((p) => p.id === user.id)) { joinRoom(room, { id: user.id, name: user.nickname, seat: room.players.length }); this.save(room); }
          this.sql.exec('INSERT INTO members VALUES (?,?,?) ON CONFLICT(user_id,code) DO UPDATE SET joined_at=excluded.joined_at', user.id, code, new Date().toISOString());
          this.sql.exec('UPDATE users SET last_room=? WHERE id=?', code, user.id);
        });
        this.broadcast(room);
        return json(this.view(room));
      }
      const room = this.room(code, user);
      if (operation === 'history' && method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        check(Number.isSafeInteger(offset) && offset >= 0, '页码无效');
        return json(this.sql.exec('SELECT payload FROM matches JOIN results ON results.match_id=matches.id WHERE code=? AND matches.id<>? AND results.user_id=? ORDER BY ended_at DESC,matches.id DESC LIMIT 20 OFFSET ?', code, room.matchId, user.id, offset).toArray().map(({ payload }) => JSON.parse(payload)));
      }
      this.checkActive(user, code);
      if (!operation && method === 'GET') return json(this.view(room));
      if (operation === 'leave' && method === 'POST') {
        this.ctx.storage.transactionSync(() => {
          leaveRoom(room, user.id);
          this.save(room);
          this.sql.exec('DELETE FROM members WHERE user_id=? AND code=?', user.id, code);
          this.sql.exec('UPDATE users SET last_room=NULL WHERE id=? AND last_room=?', user.id, code);
        });
        this.broadcast(room);
        return json({ ok: true });
      }
      if (operation === 'action' && method === 'POST') {
        this.ctx.storage.transactionSync(() => { if (applyAction(room, user.id, body)) this.save(room); });
        this.broadcast(room);
        return json(this.view(room));
      }
      if (operation === 'socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        check(this.ctx.getWebSockets(user.id).length < 12, '打开的页面过多，请关闭部分页面后重试');
        const [client, server] = Object.values(new WebSocketPair());
        server.serializeAttachment({ code, userId: user.id, sessionHash: user.session_hash });
        this.ctx.acceptWebSocket(server, [code, user.id]);
        this.broadcast(room);
        return new Response(null, { status: 101, webSocket: client });
      }
      fail(404, '接口不存在');
    } catch (error) {
      const status = error instanceof GameError ? 400 : error.status || 500;
      if (status === 500) console.error(error);
      return json({ error: status === 500 ? '服务暂时不可用，请重试' : error.message }, status);
    }
  }
  webSocketMessage(ws) { ws.close(1008, '请通过页面提交操作'); }
  webSocketClose(ws) { ws.close(1000, '连接已关闭'); this.broadcast(this.room(ws.deserializeAttachment().code)); }
  webSocketError(ws) { ws.close(1011, '连接中断'); }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return url.pathname.startsWith('/api/') ? env.APP.getByName('main').fetch(request) : env.ASSETS.fetch(request);
  }
};
