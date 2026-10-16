import test from 'node:test';
import assert from 'node:assert/strict';
import { Dianque } from '../server/app.js';
import { statsDay } from '../server/stats.js';

test('统计按北京时间跨日', () => {
  assert.equal(statsDay(Date.parse('2026-10-15T15:59:59.999Z')), '2026-10-15');
  assert.equal(statsDay(Date.parse('2026-10-15T16:00:00.000Z')), '2026-10-16');
});

test('空统计返回零值和完整日期序列', () => {
  const app = new Dianque();
  try {
    const stats = app.stats.overview(30, Date.parse('2026-10-16T00:00:00Z'));
    assert.equal(stats.daily.length, 30); assert.equal(stats.daily[0].day, '2026-09-17');
    assert.equal(stats.trackingSince, null);
    assert.ok(Object.values(stats.totals).every((value) => value === 0));
    assert.ok(Object.values(stats.period).every((value) => value === 0));
  } finally { app.db.close(); }
});

test('统计去重、跨日范围、活跃节流、完整场次和删除后汇总', () => {
  const app = new Dianque({ adminId: 'a' });
  const now = Date.parse('2026-10-16T04:00:00Z'), day = 86400000;
  try {
    for (const id of ['a', 'b', 'c']) app.rows('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)', id, id, id, '', '', id === 'c' ? null : 'TEST', null, new Date(now - (id === 'c' ? 0 : 8 * day)).toISOString());
    app.rows('INSERT INTO admins VALUES (?)', 'b');
    const request = (cookie) => new Request('https://dianque.test/api/session', { headers: cookie ? { Cookie: cookie } : {} });
    const first = app.stats.visit(request(), now)['Set-Cookie'];
    assert.match(first, /HttpOnly; SameSite=Lax/); assert.match(first, /; Secure$/);
    const visitor = first.split(';')[0];
    assert.deepEqual(app.stats.visit(request(visitor), now), {});
    app.stats.visit(request(visitor), now - 6 * day);
    app.stats.visit(request(), now);
    app.stats.visit(request(), now - 7 * day);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM site_visits WHERE visitor_hash=?', visitor.split('=')[1]).n, 0);
    app.stats.activity('a', now); app.stats.activity('a', now + 1000);
    assert.equal(app.one('SELECT last_seen FROM user_activity WHERE user_id=?', 'a').last_seen, new Date(now).toISOString());
    app.stats.activity('b', now - 6 * day); app.stats.activity('b', now);
    app.stats.activity('c', now - 7 * day);
    app.stats.request(now); app.stats.request(now); app.stats.request(now - 6 * day);
    for (const [id, age, count] of [['one', 0, 4], ['two', 6, 3], ['old', 7, 4]]) app.rows('INSERT INTO matches VALUES (?,?,?,?,?,?)', id, 'TEST', new Date(now - age * day).toISOString(), count, 'south', '{}');
    app.rows('INSERT INTO results VALUES (?,?,?,?)', 'one', 'a', 1, 30000);
    app.rows('INSERT INTO results VALUES (?,?,?,?)', 'one', 'b', 2, 25000);
    app.rows('INSERT INTO results VALUES (?,?,?,?)', 'two', 'a', 1, 30000);
    const stats = app.stats.overview(7, now);
    assert.deepEqual(stats.period, { views: 4, visitors: 2, activeUsers: 2, newUsers: 1, matches: 2, requests: 3 });
    assert.deepEqual(stats.totals, { users: 3, admins: 2, playedUsers: 2, matches: 3, threePlayerMatches: 1, fourPlayerMatches: 2, activeRooms: 1, onlineUsers: 2 });
    assert.deepEqual(stats.daily.at(-1), { day: '2026-10-16', views: 3, visitors: 2, activeUsers: 2, newUsers: 1, matches: 1, requests: 2 });
    assert.equal(stats.daily[1].views, 0); assert.equal(stats.from, '2026-10-10');
    assert.equal(app.stats.overview(1, now).period.views, 3);
    app.rows('DELETE FROM results WHERE match_id=?', 'one'); app.rows('DELETE FROM matches WHERE id=?', 'one');
    assert.equal(app.stats.overview(7, now).totals.matches, 2);
    assert.equal(app.stats.overview(7, now).period.matches, 1);
  } finally { app.db.close(); }
});
