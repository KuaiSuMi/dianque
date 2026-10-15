import { useEffect, useRef } from 'react';
import { api } from './api';

export function useRoom(code, handlers) {
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  useEffect(() => {
    if (!code) return;
    let socket, retry, heartbeat, stopped = false, delay = 800;
    function connect() {
      clearTimeout(retry);
      if (stopped) return;
      let pong = Date.now();
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${code}/socket`);
      socket.onopen = () => {
        if (stopped) { socket.close(); return; }
        delay = 800;
        callbacks.current.connected(true);
        heartbeat = setInterval(() => {
          if (Date.now() - pong > 60000) socket.close();
          else if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 25000);
      };
      socket.onmessage = ({ data }) => {
        pong = Date.now();
        if (!stopped && data !== 'pong') callbacks.current.state(JSON.parse(data));
      };
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        clearInterval(heartbeat);
        if (stopped) return;
        callbacks.current.connected(false);
        if (event.code === 4001) { stopped = true; callbacks.current.unauthorized(); return; }
        if (event.code === 4002) { stopped = true; callbacks.current.left(); return; }
        api(`/rooms/${code}`).catch((error) => {
          if (stopped) return;
          if (error.status === 401) { stopped = true; callbacks.current.unauthorized(); }
          else if ([403, 404].includes(error.status)) { stopped = true; callbacks.current.left(); }
        }).finally(() => {
          if (stopped) return;
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        });
      };
    }
    const resume = () => { if (document.visibilityState === 'visible' && socket?.readyState === WebSocket.CLOSED) connect(); };
    connect();
    document.addEventListener('visibilitychange', resume);
    return () => { stopped = true; clearTimeout(retry); clearInterval(heartbeat); socket?.close(); document.removeEventListener('visibilitychange', resume); };
  }, [code]);
}
