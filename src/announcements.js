const shown = new Set();
const key = ({ id, revision }) => `announcement-shown:${id}:${revision}`;

export function unreadAnnouncements(items) {
  return items.filter((item) => {
    if (!item.popup || shown.has(key(item))) return false;
    try { return localStorage.getItem(key(item)) !== '1'; }
    catch { return true; }
  });
}

export function rememberAnnouncements(items) {
  for (const item of items) {
    shown.add(key(item));
    try { localStorage.setItem(key(item), '1'); }
    catch { /* 浏览器禁用存储时，本页内仍不重复弹出。 */ }
  }
}
