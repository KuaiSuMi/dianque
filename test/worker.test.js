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
function runtime(path) {
  return new Miniflare({ resourcePersistencePath: path, workers: [{ config: {
    name: 'dianque', compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
    manifest: { mainModule: 'worker.js', modules: { 'worker.js': { type: 'esm', contents } } },
    env: { APP: { type: 'durable-object', worker: 'dianque', exportName: 'Dianque' } },
    exports: { Dianque: { type: 'durable-object', storage: 'sqlite' } }
  } }] });
}
async function request(mf, path, { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await mf.dispatchFetch(origin + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }).catch((error) => { console.error(path, error.cause); throw error; });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0], headers: response.headers };
}
async function register(mf, nickname) {
  const result = await request(mf, '/register', { body: { nickname, password } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result;
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
    assert.deepEqual(Object.keys(user.body.user).sort(), ['id', 'nickname']);
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
