import express from 'express';
import { createServer, STATUS_CODES } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Dianque } from './app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp({ database = resolve(root, 'data/dianque.sqlite'), adminId = '', publicOrigin = '', dev = false } = {}) {
  if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !/^https?:\/\//.test(publicOrigin))) throw new Error('PUBLIC_ORIGIN 须为完整网站来源，例如 https://mj.example.com，不含末尾斜杠');
  const http = express();
  const server = createServer(http);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const app = new Dianque({ database, adminId, clients: sockets.clients });
  let closing = false;
  http.disable('x-powered-by');
  // 生产服务仅绑定回环地址，转发头只信任同机反向代理。
  http.set('trust proxy', 'loopback');
  http.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  function webRequest(req) {
    const origin = publicOrigin || `http://${req.headers.host}`;
    return new Request(origin + req.originalUrl, {
      method: req.method,
      headers: req.headers,
      ...(!['GET', 'HEAD'].includes(req.method) && req.body?.length ? { body: req.body } : {})
    });
  }
  http.use('/api', express.raw({ type: () => true, limit: '16kb' }), async (req, res) => {
    const response = await app.fetch(webRequest(req), { ip: req.ip });
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  http.use((error, _req, res, _next) => {
    if (error.status !== 413) console.error(error);
    res.status(error.status === 413 ? 413 : 500).json({ error: error.status === 413 ? '请求过大' : '服务暂时不可用，请重试' });
  });
  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/api/')) return dev ? undefined : socket.destroy();
    // upgrade 请求不经过 Express 中间件。
    req.originalUrl = req.url;
    try {
      const request = webRequest(req);
      const response = await app.fetch(request, { upgrade: (data, room) => {
        sockets.handleUpgrade(req, socket, head, (ws) => {
          ws.data = data;
          ws.on('message', (message, binary) => {
            if (!binary && message.toString() === 'ping') ws.send('pong');
            else ws.close(1008, '请通过页面提交操作');
          });
          ws.on('close', () => { if (!closing) app.broadcast(app.room(data.code)); });
          ws.on('error', () => ws.terminate());
          app.broadcast(room);
        });
      } });
      if (response) {
        const body = await response.text();
        socket.end(`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      }
    } catch (error) { console.error(error); socket.destroy(); }
  });
  let vite;
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    http.use(vite.middlewares);
  } else {
    http.use(express.static(resolve(root, 'dist'), { maxAge: 0 }));
    http.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')));
  }
  return { server, app, close: async () => {
    closing = true;
    await vite?.close();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise((done) => sockets.close(done));
    await new Promise((done) => server.close(done));
    app.db.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const instance = await createApp({ database: process.env.DATABASE_PATH, adminId: process.env.ADMIN_USER_ID, publicOrigin: process.env.PUBLIC_ORIGIN, dev: process.argv.includes('--dev') });
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  instance.server.listen(port, host, () => console.log(`点雀已启动：${process.env.PUBLIC_ORIGIN || `http://${host}:${port}`}`));
  instance.server.on('error', async (error) => { console.error('启动失败：', error.message); process.exitCode = 1; await instance.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await instance.close(); });
}
