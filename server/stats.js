import { randomUUID } from 'node:crypto';
import { digest } from './auth.js';

const dayMs = 86400000;
export const statsDay = (now) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);

export class SiteStats {
  constructor(app) {
    this.app = app;
    app.db.exec(`
      CREATE TABLE IF NOT EXISTS site_visits (day TEXT NOT NULL, visitor_hash TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY(day,visitor_hash));
      CREATE TABLE IF NOT EXISTS site_traffic (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_activity (day TEXT NOT NULL, user_id TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(day,user_id));
      CREATE INDEX IF NOT EXISTS activity_user ON user_activity(user_id,last_seen DESC);
    `);
  }
  visit(request, now = Date.now()) {
    const saved = request.headers.get('Cookie')?.match(/(?:^|;\s*)dq_visitor=([a-f0-9-]{36})(?:;|$)/)?.[1];
    const id = saved || randomUUID();
    try {
      this.app.rows('INSERT INTO site_visits VALUES (?,?,1) ON CONFLICT(day,visitor_hash) DO UPDATE SET views=views+1', statsDay(now), digest(id));
    } catch (error) { console.error('访问统计写入失败', error); }
    return saved ? {} : { 'Set-Cookie': `dq_visitor=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` };
  }
  activity(userId, now = Date.now()) {
    try {
      this.app.rows('INSERT INTO user_activity VALUES (?,?,?) ON CONFLICT(day,user_id) DO UPDATE SET last_seen=excluded.last_seen WHERE last_seen<?', statsDay(now), userId, new Date(now).toISOString(), new Date(now - 60000).toISOString());
    } catch (error) { console.error('活跃统计写入失败', error); }
  }
  request(now = Date.now()) {
    try {
      this.app.rows('INSERT INTO site_traffic VALUES (?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1', statsDay(now));
    } catch (error) { console.error('请求统计写入失败', error); }
  }
  overview(days, now = Date.now()) {
    const { app } = this;
    const today = statsDay(now), from = statsDay(now - (days - 1) * dayMs);
    const since = new Date(`${from}T00:00:00+08:00`).toISOString(), until = new Date(now).toISOString();
    const daily = Array.from({ length: days }, (_, i) => ({ day: statsDay(now - (days - 1 - i) * dayMs), views: 0, visitors: 0, activeUsers: 0, newUsers: 0, matches: 0, requests: 0 }));
    const byDay = new Map(daily.map((row) => [row.day, row]));
    const groups = [
      app.rows('SELECT day,SUM(views) AS views,COUNT(*) AS visitors FROM site_visits WHERE day BETWEEN ? AND ? GROUP BY day', from, today),
      app.rows('SELECT day,COUNT(*) AS activeUsers FROM user_activity WHERE day BETWEEN ? AND ? GROUP BY day', from, today),
      app.rows("SELECT date(created_at,'+8 hours') AS day,COUNT(*) AS newUsers FROM users WHERE created_at BETWEEN ? AND ? GROUP BY day", since, until),
      app.rows("SELECT date(ended_at,'+8 hours') AS day,COUNT(*) AS matches FROM matches WHERE ended_at BETWEEN ? AND ? GROUP BY day", since, until),
      app.rows('SELECT day,requests FROM site_traffic WHERE day BETWEEN ? AND ?', from, today),
    ];
    for (const group of groups) for (const row of group) Object.assign(byDay.get(row.day), row);
    const users = app.one('SELECT COUNT(*) AS total,SUM(CASE WHEN id=? OR EXISTS(SELECT 1 FROM admins WHERE user_id=users.id) THEN 1 ELSE 0 END) AS admins FROM users', app.adminId);
    const matches = app.one('SELECT COUNT(*) AS total,COUNT(CASE WHEN player_count=3 THEN 1 END) AS three,COUNT(CASE WHEN player_count=4 THEN 1 END) AS four FROM matches');
    return {
      days, from, today, updatedAt: until,
      trackingSince: app.one('SELECT MIN(day) AS day FROM site_traffic').day,
      totals: {
        users: users.total, admins: users.admins || 0,
        playedUsers: app.one('SELECT COUNT(DISTINCT user_id) AS n FROM results').n,
        matches: matches.total, threePlayerMatches: matches.three, fourPlayerMatches: matches.four,
        activeRooms: app.one('SELECT COUNT(DISTINCT active_room) AS n FROM users WHERE active_room IS NOT NULL').n,
        onlineUsers: app.one('SELECT COUNT(DISTINCT user_id) AS n FROM user_activity WHERE last_seen>=?', new Date(now - 5 * 60000).toISOString()).n,
      },
      period: {
        views: daily.reduce((sum, row) => sum + row.views, 0),
        visitors: app.one('SELECT COUNT(DISTINCT visitor_hash) AS n FROM site_visits WHERE day BETWEEN ? AND ?', from, today).n,
        activeUsers: app.one('SELECT COUNT(DISTINCT user_id) AS n FROM user_activity WHERE day BETWEEN ? AND ?', from, today).n,
        newUsers: daily.reduce((sum, row) => sum + row.newUsers, 0),
        matches: daily.reduce((sum, row) => sum + row.matches, 0),
        requests: daily.reduce((sum, row) => sum + row.requests, 0),
      },
      daily,
    };
  }
}
