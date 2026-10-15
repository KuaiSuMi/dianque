import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';

const contents = await readFile('.impeccable/tmp/worker/worker.js', 'utf8');
const origin = 'https://dianque.test';
const password = 'test-password-123';
const adminId = '00000000-0000-4000-8000-000000000001';
function runtime(path) {
  return new Miniflare({ resourcePersistencePath: path, workers: [{ config: {
    name: 'dianque', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents } } },
    env: { APP: { type: 'durable-object', worker: 'dianque', exportName: 'Dianque' }, ADMIN_USER_ID: { type: 'text', value: adminId } },
    exports: { Dianque: { type: 'durable-object', storage: 'sqlite' } }
  } }] });
}
async function request(mf, path, { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  // workerd 拒绝跨站请求时不读取正文，避免测试客户端复用已被关闭的连接。
  if (headers.Origin && headers.Origin !== origin) headers = { ...headers, Connection: 'close' };
  const response = await mf.dispatchFetch(origin + '/api' + path, { method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }).catch((error) => { console.error(path, error.cause); throw error; });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0], headers: response.headers };
}
async function register(mf, nickname) {
  const result = await request(mf, '/register', { body: { nickname, password } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result;
}
async function administrator(mf) {
  const user = await register(mf, 'Yuri');
  assert.equal(user.body.user.isAdmin, false, '昵称不能自动获得管理员权限');
  const db = (await mf.getDurableObjectNamespace('APP')).getByName('main');
  await db.one('UPDATE users SET id=? WHERE id=?', adminId, user.body.user.id);
  await db.one('UPDATE sessions SET user_id=? WHERE user_id=?', adminId, user.body.user.id);
  return { cookie: user.cookie, db };
}
async function socket(mf, code, cookie) {
  const response = await mf.dispatchFetch(`${origin}/api/rooms/${code}/socket`, { headers: { Origin: origin, Cookie: cookie, Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const ws = response.webSocket; ws.accept();
  ws.addEventListener('close', () => { try { ws.close(); } catch {} });
  return ws;
}
function message(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', receive); reject(new Error('未收到同步消息')); }, 4000);
    function receive({ data }) { const value = data === 'pong' ? data : JSON.parse(data); if (predicate(value)) { clearTimeout(timer); ws.removeEventListener('message', receive); resolve(value); } }
    ws.addEventListener('message', receive);
  });
}

test('管理员：服务端权限、字段白名单、用户查询分页与输入校验', async () => {
  const mf = runtime();
  try {
    const { cookie, db } = await administrator(mf);
    const member = await register(mf, '普通用户');
    const target = `/admin/users/${member.body.user.id}`;
    assert.equal((await request(mf, '/admin/users')).status, 401);
    assert.equal((await request(mf, '/admin/users', { cookie: member.cookie })).status, 403);
    assert.equal((await request(mf, target, { cookie: member.cookie, body: { nickname: '越权', isAdmin: true } })).status, 403);
    assert.equal((await request(mf, target, { cookie, body: { isAdmin: true } })).status, 400);
    assert.equal((await request(mf, target, { cookie, body: { nickname: '   ' } })).status, 400);
    assert.equal((await request(mf, target, { cookie, body: { password: 'short' } })).status, 400);
    assert.equal((await request(mf, target, { cookie, body: {} })).status, 400);
    assert.equal((await request(mf, target, { cookie, body: { nickname: ' ＹＵＲＩ ' } })).status, 409);
    assert.equal((await request(mf, target, { cookie, body: { nickname: '跨站' }, headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(mf, `/admin/users/${randomUUID()}`, { cookie, body: { nickname: '不存在' } })).status, 404);
    assert.equal((await request(mf, '/admin/users?offset=-1', { cookie })).status, 400);
    const result = await request(mf, '/admin/users?q=%EF%BC%B9%EF%BC%B5%EF%BC%B2%EF%BC%A9', { cookie });
    assert.equal(result.body.total, 1);
    assert.deepEqual(Object.keys(result.body.users[0]).sort(), ['createdAt', 'id', 'isAdmin', 'nickname']);
    assert.equal(result.body.users[0].isAdmin, true);
    for (let i = 0; i < 21; i++) await db.one('INSERT INTO users(id,nickname_key,nickname,salt,password_hash,created_at) SELECT ?,?,?,salt,password_hash,? FROM users WHERE id=?', randomUUID(), `seed${i}`, `seed${i}`, new Date().toISOString(), adminId);
    const first = (await request(mf, '/admin/users', { cookie })).body;
    const second = (await request(mf, '/admin/users?offset=20', { cookie })).body;
    assert.equal(first.total, 23); assert.equal(first.users.length, 20); assert.equal(second.users.length, 3);
    assert.equal(new Set([...first.users, ...second.users].map((u) => u.id)).size, 23);
    await db.one('INSERT INTO limits VALUES (?,?,?)', `admin:${adminId}`, 30, Date.now() + 3600000);
    assert.equal((await request(mf, target, { cookie, body: { nickname: '限额' } })).status, 429);
    assert.equal((await request(mf, '/session', { cookie: member.cookie })).body.user.nickname, '普通用户');
  } finally { await mf.dispose(); }
});

test('管理员改名：保留账号、密码和战绩，房间实时同步，管理员不随昵称转移', async () => {
  const mf = runtime();
  try {
    const { cookie, db } = await administrator(mf);
    const member = await register(mf, '牌友');
    const id = member.body.user.id;
    const room = (await request(mf, '/rooms', { cookie: member.cookie, body: {} })).body;
    const oldHash = (await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash;
    const record = { id: randomUUID(), players: [{ id, name: '牌友', seat: 0 }] };
    await db.one('INSERT INTO matches VALUES (?,?,?,?,?,?)', record.id, room.code, new Date().toISOString(), 4, 'south', JSON.stringify(record));
    await db.one('INSERT INTO results VALUES (?,?,?,?)', record.id, id, 1, 40000);
    const ws = await socket(mf, room.code, member.cookie);
    const renamed = message(ws, (value) => value.players?.[0].name === '新牌友');
    const update = await request(mf, `/admin/users/${id}`, { cookie, body: { nickname: ' 新牌友 ' } });
    assert.equal(update.status, 200); assert.equal(update.body.user.id, id);
    assert.equal((await renamed).revision, room.revision + 1);
    assert.equal((await request(mf, '/session', { cookie: member.cookie })).body.user.nickname, '新牌友');
    assert.equal((await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash, oldHash);
    assert.equal((await request(mf, '/login', { body: { nickname: '牌友', password } })).status, 401);
    assert.equal((await request(mf, '/login', { body: { nickname: '新牌友', password } })).body.user.id, id);
    assert.equal((await request(mf, '/history', { cookie: member.cookie })).body.games, 1);
    assert.equal((await request(mf, `/matches/${record.id}`, { cookie: member.cookie })).body.players[0].name, '牌友');
    assert.equal((await request(mf, `/admin/users/${adminId}`, { cookie, body: { nickname: '管理者' } })).body.user.isAdmin, true);
    assert.equal((await request(mf, '/session', { cookie })).body.user.isAdmin, true);
    assert.equal((await register(mf, 'Yuri')).body.user.isAdmin, false);
    ws.close();
  } finally { await mf.dispose(); }
});

test('管理员重置密码：事务回滚、撤销全部会话和连接、解除昵称锁定及自身重新登录', async () => {
  const mf = runtime();
  try {
    const { cookie, db } = await administrator(mf);
    const member = await register(mf, '重置测试');
    const id = member.body.user.id;
    const another = await request(mf, '/login', { body: { nickname: '重置测试', password } });
    const room = (await request(mf, '/rooms', { cookie: member.cookie, body: {} })).body;
    const ws = await socket(mf, room.code, member.cookie);
    const ws2 = await socket(mf, room.code, another.cookie);
    const closed = Promise.all([ws, ws2].map((socket) => new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))));
    const previousHash = (await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash;
    await db.one("CREATE TRIGGER prevent_reset BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test reset failure'); END");
    const body = { nickname: '重置后', password: 'new-password-456' };
    assert.equal((await request(mf, `/admin/users/${id}`, { cookie, body })).status, 500);
    assert.equal((await request(mf, '/session', { cookie: member.cookie })).body.user.nickname, '重置测试');
    assert.equal((await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash, previousHash);
    assert.equal((await request(mf, `/rooms/${room.code}`, { cookie: member.cookie })).body.players[0].name, '重置测试');
    await db.one('DROP TRIGGER prevent_reset');
    await db.one('INSERT INTO limits VALUES (?,?,?)', 'login:重置后', 10, Date.now() + 900000);
    assert.equal((await request(mf, `/admin/users/${id}`, { cookie, body })).status, 200);
    let timer;
    try {
      // Miniflare 的双连接关闭握手最长等待约 30 秒。
      const events = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('密码重置后连接未关闭')), 40000); })]);
      for (const event of events) assert.equal(event.code, 4001);
    } finally { clearTimeout(timer); for (const socket of [ws, ws2]) if (socket.readyState === 1) socket.close(); }
    for (const token of [member.cookie, another.cookie]) assert.equal((await request(mf, '/session', { cookie: token })).body.user, null);
    assert.equal((await request(mf, '/login', { body: { nickname: body.nickname, password } })).status, 401);
    assert.equal((await request(mf, '/login', { body })).body.user.id, id);
    assert.equal((await request(mf, '/session', { cookie })).body.user.isAdmin, true);
    const self = await request(mf, `/admin/users/${adminId}`, { cookie, body: { password: body.password } });
    assert.equal(self.status, 200); assert.equal(self.body.signedOut, true); assert.match(self.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await request(mf, '/admin/users', { cookie })).status, 401);
    assert.equal((await request(mf, '/login', { body: { nickname: 'Yuri', password: body.password } })).body.user.isAdmin, true);
  } finally { await mf.dispose(); }
});

test('Workers 账号：密码校验、唯一昵称、Cookie、跨站拒绝、记录隔离与退出', async () => {
  const mf = runtime();
  try {
    assert.equal((await request(mf, '/rooms')).status, 401);
    assert.equal((await request(mf, '/register', { body: { nickname: '测试', password: 'short' } })).status, 400);
    const missing = await request(mf, '/login', { body: { nickname: '不存在的账号', password } });
    assert.equal(missing.status, 401); assert.equal(missing.body.error, '昵称或密码不正确');
    assert.equal(missing.cookie, undefined);
    const user = await register(mf, 'Test');
    assert.match(user.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    assert.deepEqual(Object.keys(user.body.user).sort(), ['id', 'isAdmin', 'nickname']);
    assert.equal((await request(mf, '/register', { body: { nickname: ' ｔｅｓｔ ', password } })).status, 409);
    assert.equal((await request(mf, '/login', { body: { nickname: 'Test', password: 'wrong-password' } })).status, 401);
    const login = await request(mf, '/login', { body: { nickname: 'test', password } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.body.user.id); assert.notEqual(login.cookie, user.cookie);
    assert.equal((await request(mf, '/rooms', { cookie: user.cookie, body: {}, headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(mf, '/rooms', { cookie: user.cookie, body: { playerCount: 5 } })).status, 400);
    const room = (await request(mf, '/rooms', { cookie: user.cookie, body: {} })).body;
    assert.match(room.code, /^[A-Z]{4}$/);
    assert.equal((await request(mf, `/rooms/${room.code}/join`, { cookie: login.cookie, method: 'POST' })).body.players.length, 1);
    const outsider = await register(mf, '旁观者');
    assert.equal((await request(mf, `/rooms/${room.code}`, { cookie: outsider.cookie })).status, 403);
    assert.equal((await request(mf, `/rooms/${room.code}/history`, { cookie: outsider.cookie })).status, 403);
    assert.equal((await request(mf, `/matches/${room.matchId}`, { cookie: outsider.cookie })).status, 404);
    const ws = await socket(mf, room.code, user.cookie);
    const pong = message(ws, (value) => value === 'pong'); ws.send('ping'); await pong;
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve, { once: true }));
    assert.equal((await request(mf, '/logout', { cookie: user.cookie, method: 'POST' })).status, 200);
    assert.equal((await closed).code, 4001);
    assert.equal((await request(mf, '/session', { cookie: user.cookie })).body.user, null);
    assert.equal((await request(mf, '/rooms', { cookie: user.cookie, body: {} })).status, 401);
    assert.equal((await request(mf, '/session', { cookie: login.cookie })).body.user.id, user.body.user.id);
  } finally { await mf.dispose(); }
});

test('注册限流：旧失败计数不阻塞注册，服务端故障回滚，冲突不占额度，成功注册仍限额', async () => {
  const mf = runtime();
  try {
    const db = (await mf.getDurableObjectNamespace('APP')).getByName('main');
    await db.one('INSERT INTO limits VALUES (?,?,?)', 'register:192.0.2.1', 8, Date.now() + 3600000);
    await db.one('INSERT INTO limits VALUES (?,?,?)', 'login:注册测试', 10, Date.now() + 900000);
    await db.one("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test session failure'); END");
    const failed = await request(mf, '/register', { body: { nickname: '注册测试', password } });
    assert.equal(failed.status, 500); assert.equal(failed.cookie, undefined);
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM users')).n, 0);
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', 'registered:192.0.2.1'), undefined);
    assert.equal((await db.one('SELECT count FROM limits WHERE key=?', 'auth:192.0.2.1')).count, 1);
    await db.one('DROP TRIGGER fail_session');
    await register(mf, '注册测试');
    for (let i = 0; i < 10; i++) {
      assert.equal((await request(mf, '/register', { body: { nickname: '注册测试', password } })).status, 409);
    }
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', 'login:注册测试'), undefined);
    for (let i = 0; i < 7; i++) await register(mf, `额度测试${i}`);
    const quota = await db.one('SELECT * FROM limits WHERE key=?', 'registered:192.0.2.1');
    assert.equal(quota.count, 8);
    const blocked = await request(mf, '/register', { body: { nickname: '第九个账号', password } });
    assert.equal(blocked.status, 429); assert.equal(blocked.cookie, undefined);
    assert.match(blocked.body.error, /^注册账号过多，请在 \d+ 分钟后重试$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0 && Number(blocked.headers.get('Retry-After')) <= 3600);
    const after = await db.one('SELECT * FROM limits WHERE key=?', 'registered:192.0.2.1');
    assert.equal(after.count, quota.count); assert.equal(after.until, quota.until);
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM users')).n, 8);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, 'registered:192.0.2.1');
    await register(mf, '第九个账号');
    assert.equal((await db.one('SELECT count FROM limits WHERE key=?', 'registered:192.0.2.1')).count, 1);
  } finally { await mf.dispose(); }
});

test('登录限流：服务端故障不扣昵称额度，错误密码仍计数，限流不延长等待，到期恢复', async () => {
  const mf = runtime();
  try {
    await register(mf, '登录测试');
    const db = (await mf.getDurableObjectNamespace('APP')).getByName('main');
    await db.one("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test session failure'); END");
    assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password } })).status, 500);
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', 'login:登录测试'), undefined);
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM sessions')).n, 1);
    await db.one('DROP TRIGGER fail_session');
    for (let i = 0; i < 10; i++) {
      assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password: 'wrong-password' } })).status, 401);
    }
    const quota = await db.one('SELECT * FROM limits WHERE key=?', 'login:登录测试');
    assert.equal(quota.count, 10);
    const blocked = await request(mf, '/login', { body: { nickname: '登录测试', password } });
    assert.equal(blocked.status, 429); assert.equal(blocked.cookie, undefined);
    assert.match(blocked.body.error, /^登录尝试过多，请在 \d+ 分钟后重试$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0 && Number(blocked.headers.get('Retry-After')) <= 900);
    const after = await db.one('SELECT * FROM limits WHERE key=?', 'login:登录测试');
    assert.equal(after.count, quota.count); assert.equal(after.until, quota.until);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() + 30000, 'login:登录测试');
    assert.match((await request(mf, '/login', { body: { nickname: '登录测试', password } })).body.error, /\d+ 秒后重试$/);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, 'login:登录测试');
    assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password } })).status, 200);
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', 'login:登录测试'), undefined);
  } finally { await mf.dispose(); }
});

test('认证请求仍按 IP 限流，注册和登录共享额度，到期后恢复', async () => {
  const mf = runtime();
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal((await request(mf, i % 2 ? '/login' : '/register', { body: { nickname: '请求测试', password: 'short' } })).status, 400);
    }
    const blocked = await request(mf, '/register', { body: { nickname: '请求测试', password } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /^登录或注册请求过多，请在 \d+ 分钟后重试$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0 && Number(blocked.headers.get('Retry-After')) <= 900);
    const db = (await mf.getDurableObjectNamespace('APP')).getByName('main');
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM users')).n, 0);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, 'auth:192.0.2.1');
    await register(mf, '请求测试');
  } finally { await mf.dispose(); }
});

test('Durable Object：四端同步、并发收款、账号锁定、结算不可撤销与重启保存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dianque-worker-'));
  let mf = runtime(dir);
  const sockets = [];
  try {
    const players = [];
    for (const name of ['房主', '南家', '西家', '北家']) players.push(await register(mf, name));
    let room = (await request(mf, '/rooms', { cookie: players[0].cookie, body: {} })).body;
    const code = room.code;
    const action = async (i, data, status = 200) => {
      const result = await request(mf, `/rooms/${code}/action`, { cookie: players[i].cookie, body: { revision: room.revision, roundId: room.state.roundId, requestId: randomUUID(), ...data } });
      assert.equal(result.status, status, JSON.stringify(result.body));
      if (status === 200) room = result.body;
      return result;
    };
    for (const player of players.slice(1)) room = (await request(mf, `/rooms/${code}/join`, { cookie: player.cookie, method: 'POST' })).body;
    for (const player of players) sockets.push(await socket(mf, code, player.cookie));
    const started = sockets.map((ws) => message(ws, (r) => r.state?.status === 'playing'));
    await action(0, { type: 'start' });
    for (const state of await Promise.all(started)) assert.deepEqual(state.state, room.state);
    const secondDevice = await request(mf, '/login', { body: { nickname: '房主', password } });
    assert.equal(secondDevice.body.activeRoom, code);
    assert.equal((await request(mf, `/rooms/${code}/join`, { cookie: secondDevice.cookie, method: 'POST' })).body.players.length, 4);
    assert.equal((await request(mf, '/rooms', { cookie: secondDevice.cookie, body: {} })).status, 400);
    await action(1, { type: 'end' }, 400);
    const riichi = { type: 'riichi', requestId: randomUUID() };
    await action(0, riichi); const revision = room.revision;
    await action(0, riichi); assert.equal(room.revision, revision); assert.equal(room.state.pot, 1);
    await action(0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 3900 }, { from: 0, to: 2, amount: 2000 }] });
    const pendingId = room.pending.id;
    await Promise.all([action(1, { type: 'receive', pendingId }), action(2, { type: 'receive', pendingId })]);
    room = (await request(mf, `/rooms/${code}`, { cookie: players[0].cookie })).body;
    assert.equal(room.pending, null); assert.deepEqual(room.state.scores, [18100, 29900, 27000, 25000]);
    await action(0, { type: 'riichi' });
    const firstMatch = room.matchId;
    await action(0, { type: 'end' });
    await action(1, { type: 'settlement-scores', scores: [10000, 50000, 20000, 20000] }, 400);
    await action(0, { type: 'settlement-scores', scores: [31000, 23000, 23000, 22000] });
    assert.deepEqual(room.settlement.scores, [32000, 23000, 23000, 22000]);
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 0);
    const ended = sockets.map((ws) => message(ws, (r) => r.state?.status === 'ended'));
    await action(0, { type: 'confirm-end' }); await Promise.all(ended);
    const stats = (await request(mf, '/history', { cookie: players[0].cookie })).body;
    assert.equal(stats.games, 1); assert.equal(stats.averageRank, 1); assert.equal(stats.matches[0].score, 32000);
    assert.equal((await request(mf, '/history', { cookie: players[2].cookie })).body.averageRank, 3);
    assert.equal((await request(mf, '/session', { cookie: players[0].cookie })).body.activeRoom, null);
    const record = (await request(mf, `/matches/${firstMatch}`, { cookie: players[0].cookie })).body;
    await action(0, { type: 'undo' }, 400);
    await action(0, { type: 'redo' }, 400);
    assert.equal(room.canUndo, false); assert.equal(room.canRedo, false);
    assert.deepEqual((await request(mf, `/matches/${firstMatch}`, { cookie: players[0].cookie })).body, record);
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 1);
    await action(0, { type: 'shuffle' }); await action(0, { type: 'start' });
    assert.notEqual(room.matchId, firstMatch);
    assert.deepEqual((await request(mf, `/matches/${firstMatch}`, { cookie: players[0].cookie })).body, record);
    assert.equal((await request(mf, `/rooms/${code}/history`, { cookie: players[0].cookie })).body.length, 1);
    await Promise.all(players.map((_, i) => action(i, { type: 'draw', tenpai: false })));
    room = (await request(mf, `/rooms/${code}`, { cookie: players[0].cookie })).body;
    assert.equal(room.state.hand, 1); assert.equal(room.state.honba, 1);
    await action(0, { type: 'end' });
    const beforeRestart = structuredClone(room);
    sockets.splice(0).forEach((ws) => ws.close()); await mf.dispose(); mf = runtime(dir);
    room = (await request(mf, `/rooms/${code}`, { cookie: players[0].cookie })).body;
    assert.deepEqual(room.state, beforeRestart.state); assert.deepEqual(room.events, beforeRestart.events);
    assert.equal((await request(mf, '/session', { cookie: secondDevice.cookie })).body.activeRoom, code);
    assert.deepEqual((await request(mf, `/matches/${firstMatch}`, { cookie: players[0].cookie })).body, record);
    const reconnected = await socket(mf, code, players[0].cookie); sockets.push(reconnected);
    const update = message(reconnected, (r) => r.state?.status === 'ended'); await action(0, { type: 'confirm-end' }); await update;
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 2);
  } finally { sockets.forEach((ws) => ws.close()); await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('退出房间：同步释放座位和转交房主、关闭同账号连接、清除回房状态并保留战绩', async () => {
  const mf = runtime(), sockets = [];
  try {
    const players = [];
    for (const name of ['退出房主', '接任房主', '第三位', '第四位']) players.push(await register(mf, name));
    let room = (await request(mf, '/rooms', { cookie: players[0].cookie, body: {} })).body;
    const code = room.code;
    for (const player of players.slice(1)) room = (await request(mf, `/rooms/${code}/join`, { cookie: player.cookie, method: 'POST' })).body;
    const action = async (data) => {
      const result = await request(mf, `/rooms/${code}/action`, { cookie: players[0].cookie, body: { revision: room.revision, requestId: randomUUID(), ...data } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); room = result.body;
    };
    await action({ type: 'start' });
    assert.equal((await request(mf, `/rooms/${code}/leave`, { cookie: players[0].cookie, method: 'POST' })).status, 400);
    await action({ type: 'end' });
    assert.equal((await request(mf, `/rooms/${code}/leave`, { cookie: players[1].cookie, method: 'POST' })).status, 400);
    await action({ type: 'confirm-end' });
    const matchId = room.matchId;
    const record = (await request(mf, `/matches/${matchId}`, { cookie: players[0].cookie })).body;
    const device = await request(mf, '/login', { body: { nickname: '退出房主', password } });
    for (const cookie of [players[0].cookie, device.cookie, players[1].cookie]) sockets.push(await socket(mf, code, cookie));
    const closed = sockets.slice(0, 2).map((ws) => new Promise((resolve) => ws.addEventListener('close', resolve, { once: true })));
    const updated = message(sockets[2], (r) => r.players?.length === 3);
    assert.equal((await request(mf, `/rooms/${code}/leave`, { cookie: players[0].cookie, method: 'POST' })).status, 200);
    assert.deepEqual((await Promise.all(closed)).map((event) => event.code), [4002, 4002]);
    sockets.splice(0, 2);
    room = await updated;
    assert.equal(room.hostId, players[1].body.user.id);
    assert.deepEqual(room.players.map((p) => [p.id, p.seat]), players.slice(1).map((p, seat) => [p.body.user.id, seat]));
    assert.equal(room.state.status, 'waiting'); assert.equal(room.canUndo, false);
    const session = (await request(mf, '/session', { cookie: device.cookie })).body;
    assert.equal(session.user.id, players[0].body.user.id); assert.equal(session.lastRoom, null); assert.equal(session.activeRoom, null);
    assert.deepEqual((await request(mf, '/rooms', { cookie: players[0].cookie })).body, []);
    assert.equal((await request(mf, `/rooms/${code}`, { cookie: device.cookie })).status, 403);
    assert.equal((await request(mf, `/rooms/${code}/action`, { cookie: device.cookie, body: { type: 'start' } })).status, 403);
    assert.deepEqual((await request(mf, `/matches/${matchId}`, { cookie: players[0].cookie })).body, record);
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 1);
    room = (await request(mf, `/rooms/${code}/join`, { cookie: players[0].cookie, method: 'POST' })).body;
    assert.equal(room.players[3].id, players[0].body.user.id); assert.equal(room.hostId, players[1].body.user.id);
    assert.deepEqual((await request(mf, `/matches/${matchId}`, { cookie: players[0].cookie })).body, record);
  } finally { sockets.forEach((ws) => ws.close()); await mf.dispose(); }
});

test('个人战绩：三人四人分开、平均顺位、最近二十场、分页、私有记录', async () => {
  const mf = runtime();
  try {
    const players = [];
    for (const name of ['甲', '乙', '丙', '其他人']) players.push(await register(mf, name));
    let room = (await request(mf, '/rooms', { cookie: players[0].cookie, body: { playerCount: 3, startPoints: 35000, length: 'east' } })).body;
    const code = room.code;
    for (const player of players.slice(1, 3)) room = (await request(mf, `/rooms/${code}/join`, { cookie: player.cookie, method: 'POST' })).body;
    const action = async (data) => {
      const result = await request(mf, `/rooms/${code}/action`, { cookie: players[0].cookie, body: { revision: room.revision, roundId: room.state.roundId, requestId: randomUUID(), ...data } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); room = result.body;
    };
    for (let i = 0; i < 21; i++) {
      await action({ type: 'start' }); await action({ type: 'end' });
      if (i === 20) await action({ type: 'settlement-scores', scores: [10000, 45000, 50000] });
      await action({ type: 'confirm-end' });
    }
    const stats = (await request(mf, '/history?players=3', { cookie: players[0].cookie })).body;
    assert.equal(stats.games, 21); assert.equal(stats.averageRank, 23 / 21);
    assert.equal(stats.recent.length, 20); assert.equal(stats.matches.length, 20);
    assert.equal(stats.recent.at(-1).rank, 3); assert.equal(stats.matches[0].rank, 3);
    assert.ok(stats.recent.every((m, i, rows) => !i || rows[i - 1].endedAt <= m.endedAt));
    assert.equal((await request(mf, '/history?players=3&offset=20', { cookie: players[0].cookie })).body.matches.length, 1);
    assert.equal((await request(mf, '/history?players=4', { cookie: players[0].cookie })).body.games, 0);
    assert.equal((await request(mf, `/matches/${stats.matches[0].id}`, { cookie: players[3].cookie })).status, 404);
    assert.equal((await request(mf, '/history?players=3&offset=-1', { cookie: players[0].cookie })).status, 400);
    assert.equal((await request(mf, `/rooms/${code}/history`, { cookie: players[0].cookie })).body.length, 20);
    await action({ type: 'configure', playerCount: 4, startPoints: 25000, length: 'south' });
    const joined = await request(mf, `/rooms/${code}/join`, { cookie: players[3].cookie, method: 'POST' });
    assert.equal(joined.status, 200);
    assert.deepEqual((await request(mf, `/rooms/${code}/history`, { cookie: players[3].cookie })).body, []);
  } finally { await mf.dispose(); }
});
