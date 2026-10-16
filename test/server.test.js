import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../server/auth.js';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

const origin = 'https://dianque.test';
const password = 'test-password-123';
const loginKey = (name, ip = '192.0.2.1') => `login:${ip}:${digest(name.normalize('NFKC').trim().toLowerCase())}`;
const adminId = '00000000-0000-4000-8000-000000000001';
async function runtime(path) {
  const instance = await createApp({ database: path ? join(path, 'dianque.sqlite') : ':memory:', adminId, publicOrigin: origin });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  instance.url = `http://127.0.0.1:${instance.server.address().port}`;
  return instance;
}
async function request(mf, path, { cookie, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  const response = await fetch(mf.url + '/api' + path, { method, headers: { Origin: origin, 'X-Forwarded-For': '192.0.2.1', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0], headers: response.headers };
}
async function register(mf, nickname) {
  const result = await request(mf, '/register', { body: { nickname, password } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result;
}
async function administrator(mf) {
  const user = await register(mf, 'TestAdmin');
  assert.equal(user.body.user.isAdmin, false, '昵称不能自动获得管理员权限');
  const db = mf.app;
  await db.one('UPDATE users SET id=? WHERE id=?', adminId, user.body.user.id);
  await db.one('UPDATE sessions SET user_id=? WHERE user_id=?', adminId, user.body.user.id);
  return { cookie: user.cookie, db };
}
async function socket(mf, code, cookie) {
  const ws = new WebSocket(`${mf.url.replace(/^http/, 'ws')}/api/rooms/${code}/socket`, { headers: { Origin: origin, Cookie: cookie } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
function message(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', receive); reject(new Error('未收到同步消息')); }, 4000);
    function receive({ data }) { const value = data === 'pong' ? data : JSON.parse(data); if (predicate(value)) { clearTimeout(timer); ws.removeEventListener('message', receive); resolve(value); } }
    ws.addEventListener('message', receive);
  });
}

test('管理权限：任免持久化，普通管理员创建账号，禁止越权修改管理员，删除后撤销会话与座位', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dianque-admin-'));
  let mf = await runtime(path), ws;
  try {
    const { cookie } = await administrator(mf);
    const member = await register(mf, '受委任者');
    const id = member.body.user.id, route = `/admin/users/${id}`;
    assert.equal((await request(mf, `${route}/role`, { cookie: member.cookie, body: { isAdmin: true } })).status, 403);
    assert.equal((await request(mf, `${route}/role`, { cookie, body: { isAdmin: 'yes' } })).status, 400);
    assert.equal((await request(mf, `${route}/role`, { cookie, body: { isAdmin: true } })).body.user.isAdmin, true);
    assert.equal((await request(mf, '/session', { cookie })).body.user.isSuperAdmin, true);
    await mf.close(); mf = await runtime(path);
    assert.equal((await request(mf, '/session', { cookie: member.cookie })).body.user.isAdmin, true);
    for (const [path, options] of [
      [`/admin/users/${adminId}`, { body: { password: 'tampered-password' } }],
      [`/admin/users/${adminId}`, { method: 'DELETE' }],
      [`${route}/role`, { body: { isAdmin: false } }],
    ]) assert.equal((await request(mf, path, { cookie: member.cookie, ...options })).status, 403);
    assert.equal((await request(mf, `/admin/users/${adminId}`, { cookie, method: 'DELETE' })).status, 400);
    assert.equal((await request(mf, '/admin/users', { cookie: member.cookie, body: { nickname: '新建用户', password: 'short' } })).status, 400);
    const created = await request(mf, '/admin/users', { cookie: member.cookie, body: { nickname: '新建用户', password } });
    assert.equal(created.status, 201); assert.equal(created.body.user.isAdmin, false); assert.equal(created.cookie, undefined);
    const newId = created.body.user.id;
    const login = await request(mf, '/login', { body: { nickname: '新建用户', password } }); assert.equal(login.status, 200);
    assert.equal((await request(mf, '/admin/users', { cookie: member.cookie, body: { nickname: '新建用户', password } })).status, 409);
    const room = (await request(mf, '/rooms', { cookie: login.cookie, body: {} })).body;
    ws = await socket(mf, room.code, login.cookie);
    const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    assert.equal((await request(mf, `/admin/users/${newId}`, { cookie: member.cookie, method: 'DELETE', headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(mf, `/admin/users/${newId}`, { cookie: member.cookie, method: 'DELETE' })).status, 200);
    assert.equal(await closed, 4001);
    assert.equal((await request(mf, '/session', { cookie: login.cookie })).body.user, null);
    assert.equal(mf.app.room(room.code).players.length, 0);
    assert.equal(mf.app.one('SELECT * FROM users WHERE id=?', newId), undefined);
    assert.equal((await request(mf, `${route}/role`, { cookie, body: { isAdmin: false } })).status, 200);
    assert.equal((await request(mf, '/admin/users', { cookie: member.cookie })).status, 403);
  } finally { ws?.close(); await mf.close(); await rm(path, { recursive: true, force: true }); }
});

test('整场战绩删除：在局账号保护、全员统计清除、旧场与当前结束场不复活、删除事务回滚', async () => {
  const mf = await runtime();
  try {
    const { cookie, db } = await administrator(mf);
    const players = [];
    for (const name of ['记录甲', '记录乙', '记录丙']) players.push(await register(mf, name));
    let room = (await request(mf, '/rooms', { cookie: players[0].cookie, body: { playerCount: 3, autoDice: true } })).body;
    for (const p of players.slice(1)) room = (await request(mf, `/rooms/${room.code}/join`, { cookie: p.cookie, method: 'POST' })).body;
    const action = async (data) => {
      const response = await request(mf, `/rooms/${room.code}/action`, { cookie: players[0].cookie, body: { requestId: randomUUID(), revision: room.revision, ...data } });
      assert.equal(response.status, 200, JSON.stringify(response.body)); room = response.body;
    };
    await action({ type: 'seat', seat: 2 });
    assert.equal(room.players[2].id, players[0].body.user.id);
    await action({ type: 'start' }); assert.equal(room.state.dice.values.length, 2);
    assert.equal((await request(mf, `/admin/users/${players[1].body.user.id}`, { cookie, method: 'DELETE' })).status, 400);
    await action({ type: 'end' }); await action({ type: 'confirm-end' }); const firstId = room.matchId;
    await action({ type: 'start' });
    assert.equal((await request(mf, `/admin/matches/${firstId}`, { cookie: players[0].cookie, method: 'DELETE' })).status, 403);
    assert.equal((await request(mf, `/admin/matches/${firstId}`, { cookie, method: 'DELETE' })).status, 200);
    assert.equal((await request(mf, `/rooms/${room.code}`, { cookie: players[0].cookie })).body.state.status, 'playing');
    await action({ type: 'end' }); await action({ type: 'confirm-end' }); const secondId = room.matchId;
    const route = `/admin/users/${players[0].body.user.id}/matches`;
    assert.equal((await request(mf, route, { cookie: players[0].cookie })).status, 403);
    assert.equal((await request(mf, route, { cookie })).body.total, 1);
    db.rows("CREATE TRIGGER prevent_delete BEFORE DELETE ON matches BEGIN SELECT RAISE(ABORT, 'test delete failure'); END");
    assert.equal((await request(mf, `/admin/matches/${secondId}`, { cookie, method: 'DELETE' })).status, 500);
    assert.equal(db.room(room.code).matchId, secondId);
    assert.equal(db.one('SELECT COUNT(*) AS n FROM results WHERE match_id=?', secondId).n, 3);
    db.rows('DROP TRIGGER prevent_delete');
    assert.equal((await request(mf, `/admin/matches/${secondId}`, { cookie, method: 'DELETE' })).status, 200);
    room = (await request(mf, `/rooms/${room.code}`, { cookie: players[0].cookie })).body;
    assert.equal(room.state.status, 'waiting'); assert.notEqual(room.matchId, secondId); assert.deepEqual(room.events, []);
    await action({ type: 'seat', seat: 0 });
    for (const p of players) {
      assert.equal((await request(mf, '/history?players=3', { cookie: p.cookie })).body.games, 0);
      assert.equal((await request(mf, `/matches/${secondId}`, { cookie: p.cookie })).status, 404);
    }
    assert.equal((await request(mf, `/rooms/${room.code}/history`, { cookie: players[0].cookie })).body.length, 0);
    assert.equal(db.one('SELECT COUNT(*) AS n FROM matches').n, 0);
  } finally { await mf.close(); }
});

test('公告：管理员发布和编辑、纯文本、并发版本检查、撤下和重启持久化', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dianque-notice-'));
  let mf = await runtime(path);
  try {
    const { cookie } = await administrator(mf);
    const member = await register(mf, '公告读者');
    const body = { title: '测试公告', content: '<script>alert(1)</script>\n第二行', published: false };
    assert.equal((await request(mf, '/admin/announcements', { body, cookie: member.cookie })).status, 403);
    assert.equal((await request(mf, '/admin/announcements', { body: { ...body, title: ' ' }, cookie })).status, 400);
    const created = await request(mf, '/admin/announcements', { body, cookie }); assert.equal(created.status, 201);
    const route = `/admin/announcements/${created.body.id}`;
    assert.deepEqual((await request(mf, '/announcements')).body, []);
    const update = await request(mf, route, { cookie, body: { ...body, published: true, revision: 1 } }); assert.equal(update.status, 200);
    assert.equal((await request(mf, route, { cookie, body: { ...body, revision: 1 } })).status, 400);
    await mf.close(); mf = await runtime(path);
    const published = (await request(mf, '/announcements')).body;
    assert.equal(published.length, 1); assert.equal(published[0].content, body.content); assert.equal(published[0].revision, 2);
    assert.equal((await request(mf, route, { cookie, body: { ...body, revision: 2 } })).status, 200);
    assert.deepEqual((await request(mf, '/announcements')).body, []);
  } finally { await mf.close(); await rm(path, { recursive: true, force: true }); }
});

test('公告删除：管理员权限、跨站拒绝、版本检查、草稿和已发布公告清除及重启持久化', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dianque-notice-delete-'));
  let mf = await runtime(path);
  try {
    const { cookie } = await administrator(mf), member = await register(mf, '公告管理者');
    const body = { title: '待删除公告', content: '删除后不再展示', published: true };
    const created = await request(mf, '/admin/announcements', { cookie, body });
    const route = `/admin/announcements/${created.body.id}`;
    const remove = { method: 'DELETE', cookie };
    assert.equal((await request(mf, `${route}?revision=1`, { method: 'DELETE' })).status, 401);
    assert.equal((await request(mf, `${route}?revision=1`, { ...remove, cookie: member.cookie })).status, 403);
    assert.equal((await request(mf, `${route}?revision=1`, { ...remove, headers: { Origin: 'https://evil.test' } })).status, 403);
    for (const revision of ['', '0', '-1', '1.5', 'bad']) assert.equal((await request(mf, `${route}?revision=${revision}`, remove)).status, 400);
    assert.equal((await request(mf, route, { cookie, body: { ...body, title: '已更新公告', revision: 1 } })).status, 200);
    assert.equal((await request(mf, `${route}?revision=1`, remove)).status, 400);
    assert.equal((await request(mf, '/announcements')).body[0].title, '已更新公告');
    mf.app.rows("CREATE TRIGGER prevent_notice_delete BEFORE DELETE ON announcements BEGIN SELECT RAISE(ABORT, 'test delete failure'); END");
    assert.equal((await request(mf, `${route}?revision=2`, remove)).status, 500);
    assert.equal((await request(mf, '/announcements')).body.length, 1);
    mf.app.rows('DROP TRIGGER prevent_notice_delete');
    assert.equal((await request(mf, `/admin/users/${member.body.user.id}/role`, { cookie, body: { isAdmin: true } })).status, 200);
    assert.equal((await request(mf, `${route}?revision=2`, { ...remove, cookie: member.cookie })).status, 200);
    assert.deepEqual((await request(mf, '/announcements')).body, []);
    assert.deepEqual((await request(mf, '/admin/announcements', { cookie })).body, []);
    assert.equal((await request(mf, `${route}?revision=2`, remove)).status, 404);
    assert.equal((await request(mf, route, { cookie, body: { ...body, revision: 2 } })).status, 404);
    const draft = await request(mf, '/admin/announcements', { cookie, body: { ...body, published: false } });
    assert.equal((await request(mf, `/admin/announcements/${draft.body.id}?revision=1`, remove)).status, 200);
    await mf.close(); mf = await runtime(path);
    assert.deepEqual((await request(mf, '/announcements')).body, []);
    assert.deepEqual((await request(mf, '/admin/announcements', { cookie })).body, []);
  } finally { await mf.close(); await rm(path, { recursive: true, force: true }); }
});

function wave() {
  const data = Buffer.alloc(1644);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
async function upload(mf, cookie, { data = wave(), name = '立直一', format = 'wav', volume = 100, requestOrigin = origin } = {}) {
  const response = await fetch(`${mf.url}/api/admin/riichi-voices?${new URLSearchParams({ name, format, volume })}`, { method: 'POST', headers: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}) }, body: data });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('立直音频：管理员上传、独立音量、稳定 ID 改名、播放范围、重启持久化和删除', async () => {
  const path = await mkdtemp(join(tmpdir(), 'dianque-voice-'));
  let mf = await runtime(path);
  try {
    assert.equal((await request(mf, '/riichi-voices')).status, 401);
    const { cookie } = await administrator(mf), member = await register(mf, '音频管理员');
    assert.equal((await request(mf, `/admin/users/${member.body.user.id}/role`, { cookie, body: { isAdmin: true } })).status, 200);
    const first = await upload(mf, cookie), second = await upload(mf, member.cookie, { name: '立直二', volume: 60 });
    assert.equal(first.status, 201); assert.equal(second.status, 201);
    const voices = (await request(mf, '/riichi-voices', { cookie })).body;
    assert.equal(voices.length, 2); assert.deepEqual(Object.keys(voices[0]).sort(), ['id', 'name', 'size', 'url', 'volume']);
    const voice = first.body, route = `/admin/riichi-voices/${voice.id}`;
    assert.equal(voice.volume, 100); assert.equal(second.body.volume, 60);
    const audio = await fetch(mf.url + voice.url, { headers: { Cookie: cookie } });
    assert.equal(audio.headers.get('Content-Type'), 'audio/wav'); assert.equal(audio.headers.get('Cache-Control'), 'private, max-age=3600, must-revalidate');
    assert.equal(audio.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wave());
    const range = await fetch(mf.url + voice.url, { headers: { Cookie: cookie, Range: 'bytes=0-43' } });
    assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), `bytes 0-43/${wave().length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), wave().subarray(0, 44));
    const suffix = await fetch(mf.url + voice.url, { headers: { Cookie: cookie, Range: 'bytes=-4' } });
    assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(mf.url + voice.url, { headers: { Cookie: cookie, Range: 'bytes=99999-' } })).status, 416);
    assert.equal((await request(mf, route, { cookie: member.cookie, body: { name: '新名称', volume: 35 } })).status, 200);
    await mf.close(); mf = await runtime(path);
    const renamed = (await request(mf, '/riichi-voices', { cookie })).body.find((item) => item.id === voice.id);
    assert.deepEqual(renamed, { ...voice, name: '新名称', volume: 35 });
    assert.deepEqual(Buffer.from(await (await fetch(mf.url + voice.url, { headers: { Cookie: cookie } })).arrayBuffer()), wave());
    assert.equal((await request(mf, '/riichi-voices', { cookie })).body.find((item) => item.id === second.body.id).volume, 60);
    mf.app.rows("CREATE TRIGGER prevent_voice_delete BEFORE DELETE ON riichi_voices BEGIN SELECT RAISE(ABORT, 'test delete failure'); END");
    assert.equal((await request(mf, route, { cookie, method: 'DELETE' })).status, 500);
    assert.equal((await fetch(mf.url + voice.url, { headers: { Cookie: cookie } })).status, 200);
    assert.equal(mf.app.one('SELECT volume FROM riichi_voice_volumes WHERE voice_id=?', voice.id).volume, 35);
    mf.app.rows('DROP TRIGGER prevent_voice_delete');
    assert.equal((await request(mf, route, { cookie: member.cookie, method: 'DELETE' })).status, 200);
    assert.equal((await fetch(mf.url + voice.url, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await request(mf, '/riichi-voices', { cookie })).body.length, 1);
    assert.equal(mf.app.one('SELECT volume FROM riichi_voice_volumes WHERE voice_id=?', voice.id), undefined);
    assert.equal((await request(mf, route, { cookie, body: { name: '已删除', volume: 100 } })).status, 404);
    assert.equal((await request(mf, route, { cookie, method: 'DELETE' })).status, 404);
    assert.equal((await request(mf, `/admin/users/${member.body.user.id}/role`, { cookie, body: { isAdmin: false } })).status, 200);
    assert.equal((await upload(mf, member.cookie)).status, 403);
  } finally { await mf.close(); await rm(path, { recursive: true, force: true }); }
});

test('立直音频：权限、来源、大小、格式、名称、音量与频率边界', async () => {
  const mf = await runtime();
  try {
    const { cookie } = await administrator(mf), member = await register(mf, '普通听众');
    assert.equal((await upload(mf)).status, 401);
    assert.equal((await upload(mf, member.cookie)).status, 403);
    assert.equal((await upload(mf, cookie, { requestOrigin: 'https://evil.test' })).status, 403);
    for (const options of [{ data: Buffer.alloc(0) }, { data: Buffer.from('<html>not audio</html>') }, { format: 'mp3' }, { format: 'html' }, { name: '' }, { name: 'x'.repeat(61) }, { name: '\u0000bad' }, { volume: -1 }, { volume: 101 }, { volume: 50.5 }, { volume: '' }, { volume: 'loud' }]) assert.equal((await upload(mf, cookie, options)).status, 400);
    assert.equal((await upload(mf, cookie, { data: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 413);
    assert.deepEqual((await request(mf, '/riichi-voices', { cookie })).body, []);
    const voice = (await upload(mf, cookie, { name: '../仅为显示名称' })).body, route = `/admin/riichi-voices/${voice.id}`;
    for (const method of ['POST', 'DELETE']) {
      const options = { method, ...(method === 'POST' ? { body: { name: '变更', volume: 20 } } : {}) };
      assert.equal((await request(mf, route, options)).status, 401);
      assert.equal((await request(mf, route, { ...options, cookie: member.cookie })).status, 403);
      assert.equal((await request(mf, route, { ...options, cookie, headers: { Origin: 'https://evil.test' } })).status, 403);
    }
    for (const body of [{}, { name: '缺少音量' }, { name: '', volume: 100 }, { name: 'x'.repeat(61), volume: 100 }, { name: 123, volume: 100 }, { name: 'ok', volume: 100, extra: true }, ...[-1, 101, 0.5, '50', null, true].map((volume) => ({ name: 'ok', volume }))]) assert.equal((await request(mf, route, { cookie, body })).status, 400);
    for (const volume of [0, 100]) {
      assert.equal((await request(mf, route, { cookie, body: { name: voice.name, volume } })).status, 200);
      assert.equal((await request(mf, '/riichi-voices', { cookie })).body.find((item) => item.id === voice.id).volume, volume);
    }
    mf.app.rows("CREATE TRIGGER prevent_voice_volume BEFORE INSERT ON riichi_voice_volumes BEGIN SELECT RAISE(ABORT, 'test volume failure'); END");
    assert.equal((await request(mf, route, { cookie, body: { name: '不应保存', volume: 40 } })).status, 500);
    assert.equal(mf.app.one('SELECT name FROM riichi_voices WHERE id=?', voice.id).name, voice.name);
    mf.app.rows('DROP TRIGGER prevent_voice_volume');
    assert.equal((await fetch(mf.url + voice.url, { headers: { Cookie: cookie } })).status, 200);
    for (const [format, header] of [['mp3', 'ID3'], ['ogg', 'OggS'], ['m4a', '0000ftyp'], ['aac', Buffer.from([0xff, 0xf1])], ['mp3', Buffer.from([0xff, 0xfb])]]) {
      const data = Buffer.alloc(16); Buffer.from(header).copy(data);
      assert.equal((await upload(mf, cookie, { data, format })).status, 201, format);
    }
    mf.app.rows('UPDATE limits SET count=30 WHERE key=?', `voice-upload:${adminId}`);
    const limited = await upload(mf, cookie);
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal((await request(mf, '/riichi-voices', { cookie })).body.length, 6);
  } finally { await mf.close(); }
});

test('安全响应头和音频下载：登录、范围、缓存与按用户和来源计量', async () => {
  const mf = await runtime();
  try {
    const { cookie } = await administrator(mf);
    const voice = (await upload(mf, cookie)).body;
    const headers = { Cookie: cookie, 'X-Forwarded-For': '192.0.2.1' };
    const get = (extra = {}, method = 'GET') => fetch(mf.url + voice.url, { method, headers: { ...headers, ...extra } });
    const health = await request(mf, '/health');
    assert.equal(health.headers.get('Strict-Transport-Security'), 'max-age=31536000');
    assert.equal(health.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(health.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
    assert.match(health.headers.get('Content-Security-Policy'), /script-src 'self';/);
    assert.match(health.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(mf.url + voice.url)).status, 401);
    const userId = mf.app.user(new Request(origin, { headers })).id;
    const byteKey = `media-bytes:${userId}`, ipKey = 'media-ip-bytes:192.0.2.1';
    mf.app.rows('INSERT INTO limits VALUES (?,?,?)', byteKey, 30 * 1024 * 1024 - 4, Date.now() + 60000);
    const partial = await get({ Range: 'bytes=0-3' });
    assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 4);
    const etag = partial.headers.get('ETag');
    const blocked = await get({ Range: 'bytes=4-4' });
    assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    assert.match(blocked.headers.get('Content-Type'), /application\/json/);
    assert.equal((await get({ 'If-None-Match': etag, 'Cache-Control': 'max-age=0' })).status, 304);
    const head = await get({}, 'HEAD');
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(mf.app.one('SELECT count FROM limits WHERE key=?', byteKey).count, 30 * 1024 * 1024);
    mf.app.rows('DELETE FROM limits WHERE key=?', byteKey);
    mf.app.rows('UPDATE limits SET count=? WHERE key=?', 60 * 1024 * 1024, ipKey);
    assert.equal((await get({ Range: 'bytes=0-3' })).status, 429);
    assert.equal(mf.app.one('SELECT count FROM limits WHERE key=?', byteKey), undefined, '来源配额失败时用户额度一起回滚');
    mf.app.rows('DELETE FROM limits WHERE key=?', ipKey);
    assert.equal((await get({ Range: 'bytes=0-1,4-5' })).status, 416);
    assert.equal((await get({ Range: 'bad-range' })).status, 416);
    mf.app.rows('UPDATE limits SET count=120 WHERE key=?', 'media-requests:192.0.2.1');
    assert.equal((await get({}, 'HEAD')).status, 429);
  } finally { await mf.close(); }
});

test('异步登录：校验期间撤销密码不能签发旧凭据的新会话', async (t) => {
  const mf = await runtime();
  try {
    const user = await register(mf, '撤销中登录');
    const one = mf.app.one.bind(mf.app);
    let snapshot;
    const ready = new Promise(resolve => { snapshot = resolve; });
    t.mock.method(mf.app, 'one', (query, ...args) => {
      const result = one(query, ...args);
      if (query === 'SELECT * FROM users WHERE nickname_key=?') snapshot();
      return result;
    });
    const pending = request(mf, '/login', { body: { nickname: '撤销中登录', password } });
    await ready;
    mf.app.rows('UPDATE users SET password_hash=? WHERE id=?', '0'.repeat(64), user.body.user.id);
    assert.equal((await pending).status, 401);
    assert.equal(one('SELECT COUNT(*) AS n FROM sessions').n, 1);
  } finally { await mf.close(); }
});

test('自行修改密码：原密码校验、请求边界、故障回滚和全部旧会话失效', async () => {
  const mf = await runtime();
  let ws;
  try {
    const user = await register(mf, '改密用户');
    const other = await register(mf, '其他用户');
    const second = await request(mf, '/login', { body: { nickname: '改密用户', password } });
    const body = { currentPassword: password, newPassword: 'changed-password-456' };
    const cookie = user.cookie, id = user.body.user.id;
    const db = mf.app;
    const room = (await request(mf, '/rooms', { cookie, body: {} })).body;
    const previousHash = (await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash;
    assert.equal((await request(mf, '/password', { body })).status, 401);
    assert.equal((await request(mf, '/password', { cookie, body, headers: { Origin: 'https://evil.test' } })).status, 403);
    for (const invalid of [{}, { ...body, userId: other.body.user.id }, { ...body, newPassword: 'short' }, { ...body, newPassword: password }]) {
      assert.equal((await request(mf, '/password', { cookie, body: invalid })).status, 400);
    }
    const wrong = await request(mf, '/password', { cookie, body: { ...body, currentPassword: 'wrong-password' } });
    assert.equal(wrong.status, 400); assert.equal(wrong.body.error, '原密码不正确'); assert.equal(wrong.cookie, undefined);
    assert.equal((await request(mf, '/session', { cookie })).body.user.id, id);
    assert.equal((await db.one('SELECT count FROM limits WHERE key=?', `password:${id}`)).count, 1);
    await db.one("CREATE TRIGGER prevent_change BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test change failure'); END");
    assert.equal((await request(mf, '/password', { cookie, body })).status, 500);
    assert.equal((await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash, previousHash);
    assert.equal((await db.one('SELECT count FROM limits WHERE key=?', `password:${id}`)).count, 1);
    assert.equal((await request(mf, '/session', { cookie: second.cookie })).body.user.id, id);
    await db.one('DROP TRIGGER prevent_change');
    await db.one('INSERT INTO limits VALUES (?,?,?)', loginKey('改密用户'), 10, Date.now() + 900000);
    ws = await socket(mf, room.code, cookie);
    let timer;
    const closed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('改密后连接未关闭')), 4000);
      ws.addEventListener('close', resolve, { once: true });
    });
    try {
      const updated = await request(mf, '/password', { cookie, body });
      assert.equal(updated.status, 200); assert.deepEqual(updated.body, { ok: true });
      assert.match(updated.headers.get('Set-Cookie'), /Max-Age=0/);
      assert.equal((await closed).code, 4001);
    } finally { clearTimeout(timer); }
    for (const old of [cookie, second.cookie]) assert.equal((await request(mf, '/session', { cookie: old })).body.user, null);
    assert.equal((await request(mf, '/session', { cookie: other.cookie })).body.user.id, other.body.user.id);
    assert.equal((await request(mf, '/login', { body: { nickname: '改密用户', password } })).status, 401);
    const login = await request(mf, '/login', { body: { nickname: '改密用户', password: body.newPassword } });
    assert.equal(login.status, 200); assert.equal(login.body.user.id, id); assert.equal(login.body.lastRoom, room.code);
    assert.equal((await request(mf, `/rooms/${room.code}`, { cookie: login.cookie })).body.players[0].id, id);
  } finally { if (ws?.readyState === 1) ws.close(); await mf.close(); }
});

test('自行修改密码：原密码错误按账号限流，正确请求不能绕过限额，到期恢复', async () => {
  const mf = await runtime();
  try {
    const user = await register(mf, '改密限流');
    const cookie = user.cookie, key = `password:${user.body.user.id}`;
    const db = mf.app;
    const body = { currentPassword: 'wrong-password', newPassword: 'changed-password-456' };
    for (let i = 0; i < 10; i++) assert.equal((await request(mf, '/password', { cookie, body })).status, 400);
    const limited = await request(mf, '/password', { cookie, body: { ...body, currentPassword: password } });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal((await request(mf, '/session', { cookie })).body.user.id, user.body.user.id);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, key);
    assert.equal((await request(mf, '/password', { cookie, body: { ...body, currentPassword: password } })).status, 200);
    assert.equal(await db.one('SELECT count FROM limits WHERE key=?', key), undefined);
  } finally { await mf.close(); }
});

test('自行修改密码：并发提交只有一次成功，已撤销的会话不能覆盖新密码', async () => {
  const mf = await runtime();
  try {
    const user = await register(mf, '并发改密');
    const passwords = ['changed-password-456', 'changed-password-789'];
    const results = await Promise.all(passwords.map((newPassword) => request(mf, '/password', { cookie: user.cookie, body: { currentPassword: password, newPassword } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    for (let i = 0; i < results.length; i++) {
      assert.equal((await request(mf, '/login', { body: { nickname: '并发改密', password: passwords[i] } })).status, results[i].status === 200 ? 200 : 401);
    }
  } finally { await mf.close(); }
});

test('管理员：服务端权限、字段白名单、用户查询分页与输入校验', async () => {
  const mf = await runtime();
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
    assert.equal((await request(mf, target, { cookie, body: { nickname: ' ＴＥＳＴＡＤＭＩＮ ' } })).status, 409);
    assert.equal((await request(mf, target, { cookie, body: { nickname: '跨站' }, headers: { Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(mf, `/admin/users/${randomUUID()}`, { cookie, body: { nickname: '不存在' } })).status, 404);
    assert.equal((await request(mf, '/admin/users?offset=-1', { cookie })).status, 400);
    const result = await request(mf, '/admin/users?q=%EF%BC%B4%EF%BC%A5%EF%BC%B3%EF%BC%B4%EF%BC%A1%EF%BC%A4%EF%BC%AD%EF%BC%A9%EF%BC%AE', { cookie });
    assert.equal(result.body.total, 1);
    assert.deepEqual(Object.keys(result.body.users[0]).sort(), ['createdAt', 'id', 'isAdmin', 'isSuperAdmin', 'nickname']);
    assert.equal(result.body.users[0].isAdmin, true);
    for (let i = 0; i < 21; i++) await db.one('INSERT INTO users(id,nickname_key,nickname,salt,password_hash,created_at) SELECT ?,?,?,salt,password_hash,? FROM users WHERE id=?', randomUUID(), `seed${i}`, `seed${i}`, new Date().toISOString(), adminId);
    const first = (await request(mf, '/admin/users', { cookie })).body;
    const second = (await request(mf, '/admin/users?offset=20', { cookie })).body;
    assert.equal(first.total, 23); assert.equal(first.users.length, 20); assert.equal(second.users.length, 3);
    assert.equal(new Set([...first.users, ...second.users].map((u) => u.id)).size, 23);
    await db.one('INSERT INTO limits VALUES (?,?,?)', `admin:${adminId}`, 30, Date.now() + 3600000);
    assert.equal((await request(mf, target, { cookie, body: { nickname: '限额' } })).status, 429);
    assert.equal((await request(mf, '/session', { cookie: member.cookie })).body.user.nickname, '普通用户');
  } finally { await mf.close(); }
});

test('管理员改名：保留账号、密码和战绩，房间实时同步，管理员不随昵称转移', async () => {
  const mf = await runtime();
  try {
    const { cookie, db } = await administrator(mf);
    const member = await register(mf, '牌友');
    const id = member.body.user.id;
    const room = (await request(mf, '/rooms', { cookie: member.cookie, body: {} })).body;
    const oldHash = (await db.one('SELECT password_hash FROM users WHERE id=?', id)).password_hash;
    const record = { id: randomUUID(), players: [{ id, name: '牌友', seat: 0 }] };
    await db.one('INSERT INTO matches VALUES (?,?,?,?,?,?)', record.id, room.code, new Date().toISOString(), 4, 'south', JSON.stringify(record));
    await db.one('INSERT INTO results VALUES (?,?,?,?)', record.id, id, 1, 4000);
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
    assert.equal((await register(mf, 'TestAdmin')).body.user.isAdmin, false);
    ws.close();
  } finally { await mf.close(); }
});

test('管理员重置密码：事务回滚、撤销全部会话和连接、解除昵称锁定及自身重新登录', async () => {
  const mf = await runtime();
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
    await db.one('INSERT INTO limits VALUES (?,?,?)', loginKey('重置后'), 10, Date.now() + 900000);
    await db.one('INSERT INTO limits VALUES (?,?,?)', `password:${id}`, 10, Date.now() + 900000);
    assert.equal((await request(mf, `/admin/users/${id}`, { cookie, body })).status, 200);
    assert.equal(await db.one('SELECT count FROM limits WHERE key=?', `password:${id}`), undefined);
    let timer;
    try {
      const events = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('密码重置后连接未关闭')), 4000); })]);
      for (const event of events) assert.equal(event.code, 4001);
    } finally { clearTimeout(timer); for (const socket of [ws, ws2]) if (socket.readyState === 1) socket.close(); }
    for (const token of [member.cookie, another.cookie]) assert.equal((await request(mf, '/session', { cookie: token })).body.user, null);
    assert.equal((await request(mf, '/login', { body: { nickname: body.nickname, password } })).status, 401);
    assert.equal((await request(mf, '/login', { body })).body.user.id, id);
    assert.equal((await request(mf, '/session', { cookie })).body.user.isAdmin, true);
    const self = await request(mf, `/admin/users/${adminId}`, { cookie, body: { password: body.password } });
    assert.equal(self.status, 200); assert.equal(self.body.signedOut, true); assert.match(self.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await request(mf, '/admin/users', { cookie })).status, 401);
    assert.equal((await request(mf, '/login', { body: { nickname: 'TestAdmin', password: body.password } })).body.user.isAdmin, true);
  } finally { await mf.close(); }
});

test('账号：密码校验、唯一昵称、Cookie、跨站拒绝、记录隔离与退出', async () => {
  const mf = await runtime();
  try {
    assert.equal((await request(mf, '/rooms')).status, 401);
    assert.equal((await request(mf, '/register', { body: { nickname: '测试', password: 'short' } })).status, 400);
    const missing = await request(mf, '/login', { body: { nickname: '不存在的账号', password } });
    assert.equal(missing.status, 401); assert.equal(missing.body.error, '昵称或密码不正确');
    assert.equal(missing.cookie, undefined);
    const user = await register(mf, 'Test');
    assert.match(user.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    assert.deepEqual(Object.keys(user.body.user).sort(), ['id', 'isAdmin', 'isSuperAdmin', 'nickname']);
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
  } finally { await mf.close(); }
});

test('HTTP 与 WebSocket 边界：正文限制、JSON 校验、跨站和未登录连接拒绝', async () => {
  const mf = await runtime();
  try {
    for (const [body, status] of [['{', 400], ['null', 400], ['[]', 400], ['x'.repeat(16385), 413]]) {
      const response = await fetch(mf.url + '/api/register', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, status); assert.ok((await response.json()).error);
    }
    assert.equal((await request(mf, '/register', { body: { nickname: '格式', password }, headers: { 'Content-Type': 'text/plain' } })).status, 400);
    const user = await register(mf, '连接测试');
    const room = (await request(mf, '/rooms', { cookie: user.cookie, body: {} })).body;
    for (const [headers, status] of [[{ Origin: origin }, 401], [{ Origin: 'https://evil.test', Cookie: user.cookie }, 403]]) {
      const ws = new WebSocket(`${mf.url.replace(/^http/, 'ws')}/api/rooms/${room.code}/socket`, { headers });
      const response = await new Promise((resolve, reject) => {
        ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); });
        ws.once('error', reject);
        ws.once('open', () => { ws.terminate(); reject(new Error('无效连接被接受')); });
      });
      assert.equal(response, status);
    }
    const ws = await socket(mf, room.code, user.cookie);
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(JSON.stringify({ type: 'start' }));
    assert.equal(await closed, 1008);
  } finally { await mf.close(); }
});

test('注册限流：旧失败计数不阻塞注册，服务端故障回滚，冲突不占额度，成功注册仍限额', async () => {
  const mf = await runtime();
  try {
    const db = mf.app;
    await db.one('INSERT INTO limits VALUES (?,?,?)', 'register:192.0.2.1', 8, Date.now() + 3600000);
    await db.one('INSERT INTO limits VALUES (?,?,?)', loginKey('注册测试'), 10, Date.now() + 900000);
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
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', loginKey('注册测试')), undefined);
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
  } finally { await mf.close(); }
});

test('登录限流：按来源和昵称隔离，故障不扣额度，限流不延长等待，到期恢复', async () => {
  const mf = await runtime();
  try {
    await register(mf, '登录测试');
    const db = mf.app;
    await db.one("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'test session failure'); END");
    assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password } })).status, 500);
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', loginKey('登录测试')), undefined);
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM sessions')).n, 1);
    await db.one('DROP TRIGGER fail_session');
    for (let i = 0; i < 10; i++) {
      assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password: 'wrong-password' } })).status, 401);
    }
    const quota = await db.one('SELECT * FROM limits WHERE key=?', loginKey('登录测试'));
    assert.equal(quota.count, 10);
    const blocked = await request(mf, '/login', { body: { nickname: '登录测试', password } });
    assert.equal(blocked.status, 429); assert.equal(blocked.cookie, undefined);
    assert.match(blocked.body.error, /^登录尝试过多，请在 \d+ 分钟后重试$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0 && Number(blocked.headers.get('Retry-After')) <= 900);
    const after = await db.one('SELECT * FROM limits WHERE key=?', loginKey('登录测试'));
    assert.equal(after.count, quota.count); assert.equal(after.until, quota.until);
    assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password }, headers: { 'X-Forwarded-For': '192.0.2.2' } })).status, 200, '另一来源不能锁住账号');
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() + 30000, loginKey('登录测试'));
    assert.match((await request(mf, '/login', { body: { nickname: '登录测试', password } })).body.error, /\d+ 秒后重试$/);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, loginKey('登录测试'));
    assert.equal((await request(mf, '/login', { body: { nickname: '登录测试', password } })).status, 200);
    assert.equal(await db.one('SELECT * FROM limits WHERE key=?', loginKey('登录测试')), undefined);
  } finally { await mf.close(); }
});

test('认证请求仍按 IP 限流，注册和登录共享额度，到期后恢复', async () => {
  const mf = await runtime();
  try {
    for (let i = 0; i < 30; i++) {
      assert.equal((await request(mf, i % 2 ? '/login' : '/register', { body: { nickname: '请求测试', password: 'short' } })).status, 400);
    }
    const blocked = await request(mf, '/register', { body: { nickname: '请求测试', password } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /^登录或注册请求过多，请在 \d+ 分钟后重试$/);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0 && Number(blocked.headers.get('Retry-After')) <= 900);
    const db = mf.app;
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM users')).n, 0);
    await db.one('UPDATE limits SET until=? WHERE key=?', Date.now() - 1, 'auth:192.0.2.1');
    await register(mf, '请求测试');
  } finally { await mf.close(); }
});

test('对局及结算期间禁止本人和管理员改密码；牌桌开关广播并保存', async () => {
  const mf = await runtime();
  let ws;
  try {
    const admin = await administrator(mf);
    const host = await register(mf, '密码房主'), guest = await register(mf, '密码玩家'), third = await register(mf, '密码第三家');
    let room = (await request(mf, '/rooms', { cookie: host.cookie, body: { playerCount: 3 } })).body;
    for (const cookie of [guest.cookie, third.cookie]) room = (await request(mf, `/rooms/${room.code}/join`, { cookie, method: 'POST' })).body;
    async function act(type, fields = {}, cookie = host.cookie) {
      const result = await request(mf, `/rooms/${room.code}/action`, { cookie, body: { type, revision: room.revision, roundId: room.state.roundId, requestId: randomUUID(), ...fields } });
      assert.equal(result.status, 200, JSON.stringify(result.body)); room = result.body;
    }
    await act('start');
    ws = await socket(mf, room.code, guest.cookie);
    const update = message(ws, (r) => r.config?.autoDice && r.config?.tsumoConfirm);
    const before = structuredClone(room.state);
    await act('table-settings', { autoDice: true, tsumoConfirm: true }, guest.cookie);
    assert.deepEqual((await update).config, room.config); assert.deepEqual(room.state, before);
    assert.deepEqual((await request(mf, `/rooms/${room.code}`, { cookie: guest.cookie })).body.config, room.config);
    const id = guest.body.user.id;
    const original = mf.app.one('SELECT salt,password_hash,nickname FROM users WHERE id=?', id);
    for (const phase of ['playing', 'settling']) {
      if (phase === 'settling') await act('end');
      const self = await request(mf, '/password', { cookie: guest.cookie, body: { currentPassword: password, newPassword: 'new-password-456' } });
      assert.equal(self.status, 400); assert.match(self.body.error, /对局中禁止修改密码/);
      const reset = await request(mf, `/admin/users/${id}`, { cookie: admin.cookie, body: { nickname: '不应改名', password: 'new-password-456' } });
      assert.equal(reset.status, 400); assert.match(reset.body.error, /对局中禁止修改密码/);
      assert.deepEqual(mf.app.one('SELECT salt,password_hash,nickname FROM users WHERE id=?', id), original);
      assert.equal((await request(mf, '/session', { cookie: guest.cookie })).body.user.id, id);
      assert.equal(ws.readyState, WebSocket.OPEN);
    }
    await act('confirm-end');
    assert.equal((await request(mf, '/password', { cookie: guest.cookie, body: { currentPassword: password, newPassword: 'new-password-456' } })).status, 200);
    assert.equal((await request(mf, `/admin/users/${host.body.user.id}`, { cookie: admin.cookie, body: { password: 'reset-password-789' } })).status, 200);
  } finally { ws?.close(); await mf.close(); }
});

test('全员平权：普通成员操作同步，删除本场释放全桌并保留旧战绩，失败与过期请求不丢数据', async () => {
  const mf = await runtime(), sockets = [];
  try {
    const players = [];
    for (const name of ['平权甲', '平权乙', '平权丙', '平权丁']) players.push(await register(mf, name));
    const outsider = await register(mf, '旁观者');
    let room = (await request(mf, '/rooms', { cookie: players[0].cookie, body: {} })).body;
    const code = room.code;
    for (const p of players.slice(1)) room = (await request(mf, `/rooms/${code}/join`, { cookie: p.cookie, method: 'POST' })).body;
    const action = async (actor, data, status = 200) => {
      const response = await request(mf, `/rooms/${code}/action`, { cookie: actor.cookie, body: { revision: room.revision, requestId: randomUUID(), ...data } });
      assert.equal(response.status, status, JSON.stringify(response.body));
      if (status === 200) room = response.body;
    };
    await action(players[1], { type: 'configure', playerCount: 4, length: 'east', startPoints: 30000 });
    await action(players[2], { type: 'shuffle' });
    await action(players[3], { type: 'start' });
    await action(players[1], { type: 'adjust', hand: 4, honba: 2, pot: 0, scores: [27000, 29000, 31000, 33000] });
    const adjustment = room.events.at(-1);
    assert.equal(adjustment.seat, room.players.find((p) => p.id === players[1].body.user.id).seat);
    await action(players[2], { type: 'end' }); await action(players[3], { type: 'confirm-end' });
    const firstId = room.matchId;
    const first = (await request(mf, `/matches/${firstId}`, { cookie: players[0].cookie })).body;
    assert.deepEqual(first.events.find((e) => e.id === adjustment.id), adjustment);
    await action(players[1], { type: 'start' });
    await action(players[2], { type: 'discard-match' }, 400);
    await action(players[2], { type: 'end' });
    const discardedId = room.matchId, stale = room.revision;
    for (const type of ['configure', 'shuffle', 'start', 'adjust', 'end', 'settlement-scores', 'confirm-end', 'discard-match']) await action(outsider, { type }, 403);
    await action(players[3], { type: 'settlement-scores', scores: [32000, 31000, 29000, 28000] });
    await action(players[1], { type: 'discard-match', revision: stale }, 400);
    const before = structuredClone(room);
    mf.app.rows("CREATE TRIGGER prevent_discard BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT, 'test discard failure'); END");
    await action(players[1], { type: 'discard-match' }, 500);
    assert.deepEqual((await request(mf, `/rooms/${code}`, { cookie: players[0].cookie })).body, before);
    for (const p of players) assert.equal((await request(mf, '/session', { cookie: p.cookie })).body.activeRoom, code);
    mf.app.rows('DROP TRIGGER prevent_discard');
    for (const p of players) sockets.push(await socket(mf, code, p.cookie));
    const updates = sockets.map((ws) => message(ws, (r) => r.state?.status === 'waiting'));
    const deletion = { type: 'discard-match', revision: room.revision, requestId: randomUUID() };
    await action(players[1], deletion);
    for (const update of await Promise.all(updates)) { assert.deepEqual(update.state, room.state); assert.deepEqual(update.events, []); }
    assert.notEqual(room.matchId, discardedId);
    assert.equal(room.canUndo, false); assert.equal(room.canRedo, false);
    assert.deepEqual(room.state.scores, [30000, 30000, 30000, 30000]);
    assert.equal(mf.app.one('SELECT COUNT(*) AS n FROM results WHERE match_id=?', discardedId).n, 0);
    for (const p of players) {
      assert.equal((await request(mf, '/session', { cookie: p.cookie })).body.activeRoom, null);
      assert.equal((await request(mf, '/history', { cookie: p.cookie })).body.games, 1);
      assert.equal((await request(mf, `/matches/${discardedId}`, { cookie: p.cookie })).status, 404);
      assert.deepEqual((await request(mf, `/matches/${firstId}`, { cookie: p.cookie })).body, first);
    }
    await action(players[2], { type: 'start' });
    const next = structuredClone(room);
    await action(players[1], deletion); assert.deepEqual(room, next);
    await action(players[1], { type: 'discard-match', revision: deletion.revision }, 400);
    await action(players[3], { type: 'end' }); await action(players[2], { type: 'confirm-end' });
    assert.equal((await request(mf, '/history', { cookie: players[1].cookie })).body.games, 2);
    assert.equal(mf.app.one('SELECT COUNT(*) AS n FROM matches').n, 2);
  } finally { sockets.forEach((ws) => ws.close()); await mf.close(); }
});

test('Node 服务：四端同步、并发收款、账号锁定、结算不可撤销与重启保存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dianque-server-'));
  let mf = await runtime(dir);
  const sockets = [];
  try {
    const players = [];
    for (const name of ['东家', '南家', '西家', '北家']) players.push(await register(mf, name));
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
    const secondDevice = await request(mf, '/login', { body: { nickname: '东家', password } });
    assert.equal(secondDevice.body.activeRoom, code);
    assert.equal((await request(mf, `/rooms/${code}/join`, { cookie: secondDevice.cookie, method: 'POST' })).body.players.length, 4);
    assert.equal((await request(mf, '/rooms', { cookie: secondDevice.cookie, body: {} })).status, 400);
    await action(1, { type: 'end' });
    await action(2, { type: 'undo' });
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
    await action(1, { type: 'settlement-scores', scores: [10000, 50000, 20000, 20000] });
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
    sockets.splice(0).forEach((ws) => ws.close()); await mf.close(); mf = await runtime(dir);
    room = (await request(mf, `/rooms/${code}`, { cookie: players[0].cookie })).body;
    assert.deepEqual(room.state, beforeRestart.state); assert.deepEqual(room.events, beforeRestart.events);
    assert.equal((await request(mf, '/session', { cookie: secondDevice.cookie })).body.activeRoom, code);
    assert.deepEqual((await request(mf, `/matches/${firstMatch}`, { cookie: players[0].cookie })).body, record);
    const reconnected = await socket(mf, code, players[0].cookie); sockets.push(reconnected);
    const update = message(reconnected, (r) => r.state?.status === 'ended'); await action(0, { type: 'confirm-end' }); await update;
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 2);
  } finally { sockets.forEach((ws) => ws.close()); await mf.close(); await rm(dir, { recursive: true, force: true }); }
});

test('退出房间：同步释放座位、关闭同账号连接、清除回房状态并保留战绩', async () => {
  const mf = await runtime(), sockets = [];
  try {
    const players = [];
    for (const name of ['退出玩家', '留座玩家', '第三位', '第四位']) players.push(await register(mf, name));
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
    const device = await request(mf, '/login', { body: { nickname: '退出玩家', password } });
    for (const cookie of [players[0].cookie, device.cookie, players[1].cookie]) sockets.push(await socket(mf, code, cookie));
    const closed = sockets.slice(0, 2).map((ws) => new Promise((resolve) => ws.addEventListener('close', resolve, { once: true })));
    const updated = message(sockets[2], (r) => r.players?.length === 3);
    assert.equal((await request(mf, `/rooms/${code}/leave`, { cookie: players[0].cookie, method: 'POST' })).status, 200);
    assert.deepEqual((await Promise.all(closed)).map((event) => event.code), [4002, 4002]);
    sockets.splice(0, 2);
    room = await updated;
    assert.equal(Object.hasOwn(room, 'hostId'), false);
    assert.deepEqual(room.players.map((p) => [p.id, p.seat]), players.slice(1).map((p, seat) => [p.body.user.id, seat + 1]));
    assert.equal(room.state.status, 'waiting'); assert.equal(room.canUndo, false);
    const session = (await request(mf, '/session', { cookie: device.cookie })).body;
    assert.equal(session.user.id, players[0].body.user.id); assert.equal(session.lastRoom, null); assert.equal(session.activeRoom, null);
    assert.deepEqual((await request(mf, '/rooms', { cookie: players[0].cookie })).body, []);
    assert.equal((await request(mf, `/rooms/${code}`, { cookie: device.cookie })).status, 403);
    assert.equal((await request(mf, `/rooms/${code}/action`, { cookie: device.cookie, body: { type: 'start' } })).status, 403);
    assert.deepEqual((await request(mf, `/matches/${matchId}`, { cookie: players[0].cookie })).body, record);
    assert.equal((await request(mf, '/history', { cookie: players[0].cookie })).body.games, 1);
    room = (await request(mf, `/rooms/${code}/join`, { cookie: players[0].cookie, method: 'POST' })).body;
    assert.equal(room.players[0].id, players[0].body.user.id); assert.equal(Object.hasOwn(room, 'hostId'), false);
    assert.deepEqual((await request(mf, `/matches/${matchId}`, { cookie: players[0].cookie })).body, record);
  } finally { sockets.forEach((ws) => ws.close()); await mf.close(); }
});

test('个人战绩：三人四人分开、平均顺位、最近二十场、分页、私有记录', async () => {
  const mf = await runtime();
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
  } finally { await mf.close(); }
});
