export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal: signal || AbortSignal.timeout(15000), headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }).catch((error) => {
    if (error.name === 'TimeoutError') throw new Error('连接超时，请恢复连接后查看结果，避免重复提交');
    throw error;
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !['/login', '/register'].includes(path)) window.dispatchEvent(new Event('dianque:unauthorized'));
    throw Object.assign(new Error(data.error || '请求失败'), { status: response.status });
  }
  return data;
}
