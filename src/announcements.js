const shown = new Set();
const key = (id) => `announcement-shown:${id}`;

export function unreadAnnouncements(items) {
  return items.filter((item) => {
    if (!item.popup || shown.has(item.id)) return false;
    try { return localStorage.getItem(key(item.id)) !== '1'; }
    catch { return true; }
  });
}

export function rememberAnnouncements(items) {
  for (const { id } of items) {
    shown.add(id);
    try { localStorage.setItem(key(id), '1'); }
    catch { /* 浏览器禁用存储时，本页内仍不重复弹出。 */ }
  }
}
