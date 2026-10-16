import test from 'node:test';
import assert from 'node:assert/strict';

function storage(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
}

test('公告弹窗只显示未读且开启弹窗的公告，刷新、编辑和撤下后重发不重复', async (t) => {
  const saved = new Map();
  storage(t, { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  const first = await import('../src/announcements.js?first');
  const popup = { id: 'popup', popup: 1, revision: 1 }, banner = { id: 'banner', popup: 0 };
  assert.deepEqual(first.unreadAnnouncements([popup, banner]), [popup]);
  first.rememberAnnouncements([popup]);
  assert.deepEqual(first.unreadAnnouncements([popup]), []);
  const reloaded = await import('../src/announcements.js?reloaded');
  assert.deepEqual(reloaded.unreadAnnouncements([{ ...popup, revision: 2 }]), []);
  assert.deepEqual(reloaded.unreadAnnouncements([]), []);
  assert.deepEqual(reloaded.unreadAnnouncements([popup]), []);
  const enabled = { ...banner, popup: 1 };
  assert.deepEqual(reloaded.unreadAnnouncements([popup, enabled]), [enabled]);
  reloaded.rememberAnnouncements([banner]); // 从首页手动看过的公告也不再自动弹出。
  assert.deepEqual(reloaded.unreadAnnouncements([enabled]), []);
  const next = { id: 'next', popup: 1 };
  assert.deepEqual(reloaded.unreadAnnouncements([popup, enabled, next]), [next]);
});

test('浏览器禁用存储时，公告在页面内仍只自动弹出一次', async (t) => {
  storage(t, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  const { unreadAnnouncements, rememberAnnouncements } = await import('../src/announcements.js?blocked');
  const item = { id: 'blocked', popup: 1 };
  assert.deepEqual(unreadAnnouncements([item]), [item]);
  rememberAnnouncements([item]);
  assert.deepEqual(unreadAnnouncements([item]), []);
});
