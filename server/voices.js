import express from 'express';
import { randomUUID } from 'node:crypto';
import { check } from './game.js';

const formats = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const nameOf = (value) => {
  check(typeof value === 'string', '请填写音频名称');
  const name = value.trim();
  check(name.length > 0 && name.length <= 60 && !/[\x00-\x1f\x7f]/.test(name), '音频名称须为 1–60 字');
  return name;
};

function matchesFormat(data, format) {
  if (!Buffer.isBuffer(data) || data.length < 12) return false;
  const text = (start, end) => data.toString('ascii', start, end);
  switch (format) {
    case 'mp3': return text(0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe6) === 0xe2);
    case 'wav': return text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE';
    case 'ogg': return text(0, 4) === 'OggS';
    case 'm4a': return text(4, 8) === 'ftyp';
    case 'aac': return data[0] === 0xff && (data[1] & 0xf6) === 0xf0;
    default: return false;
  }
}

export function voiceRoutes(http, app, webRequest) {
  function administrator(req) {
    const request = webRequest(req);
    if (req.method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin) fail(403, '不允许跨站操作');
    const user = app.user(request);
    if (!user) fail(401, '请先登录');
    if (!app.isAdmin(user)) fail(403, '仅管理员可使用管理功能');
    return user;
  }
  http.get('/api/riichi-voices', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(app.rows('SELECT id,name,length(audio) AS size FROM riichi_voices ORDER BY name,id').map((voice) => ({ ...voice, url: `/media/riichi/${voice.id}` })));
  });
  http.get('/media/riichi/:id', (req, res) => {
    const voice = app.one('SELECT type,audio FROM riichi_voices WHERE id=?', req.params.id);
    res.set('Cache-Control', 'no-store');
    if (!voice) return res.sendStatus(404);
    const data = Buffer.from(voice.audio), ranges = req.range(data.length);
    res.set({ 'Content-Type': voice.type, 'Accept-Ranges': 'bytes' });
    if (ranges === -1) return res.status(416).set('Content-Range', `bytes */${data.length}`).end();
    if (ranges?.type === 'bytes' && ranges.length === 1) {
      const { start, end } = ranges[0];
      return res.status(206).set('Content-Range', `bytes ${start}-${end}/${data.length}`).send(data.subarray(start, end + 1));
    }
    res.send(data);
  });
  http.use('/api/admin/riichi-voices', (req, res, next) => {
    const user = administrator(req);
    app.limit(`voices:${user.id}`, 60);
    res.set('Cache-Control', 'no-store');
    next();
  });
  http.post('/api/admin/riichi-voices', express.raw({ type: () => true, limit: '5mb' }), (req, res) => {
    const user = administrator(req);
    // 校验容器头；具体编码能否播放由浏览器决定。
    check(typeof req.query.format === 'string' && Object.hasOwn(formats, req.query.format) && matchesFormat(req.body, req.query.format), '请选择有效的 MP3、WAV、OGG、M4A 或 AAC 音频');
    const name = nameOf(req.query.name), id = randomUUID();
    app.transaction(() => {
      app.limit(`voice-upload:${user.id}`, 30, 3600000, '音频上传次数过多');
      app.rows('INSERT INTO riichi_voices VALUES (?,?,?,?)', id, name, formats[req.query.format], req.body);
    });
    res.status(201).json({ id, name, size: req.body.length, url: `/media/riichi/${id}` });
  });
  http.post('/api/admin/riichi-voices/:id', express.json({ limit: '16kb' }), (req, res) => {
    administrator(req);
    check(req.body && Object.keys(req.body).length === 1, '请填写音频名称');
    const name = nameOf(req.body.name);
    if (!app.one('UPDATE riichi_voices SET name=? WHERE id=? RETURNING id', name, req.params.id)) fail(404, '音频不存在或已被删除');
    res.json({ ok: true });
  });
  http.delete('/api/admin/riichi-voices/:id', (req, res) => {
    if (!app.one('DELETE FROM riichi_voices WHERE id=? RETURNING id', req.params.id)) fail(404, '音频不存在或已被删除');
    res.json({ ok: true });
  });
}
