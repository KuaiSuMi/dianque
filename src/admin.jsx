import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
import { api } from './api';

export function AdminEntry({ open }) {
  return open && <div className="admin-entry"><button className="text-button" onClick={open}><ShieldCheck size={17} />账号管理</button></div>;
}

function UserEditor({ target, currentId, back, saved }) {
  const [nickname, setNickname] = useState(target.nickname);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    if (password !== confirmation) { setError('两次输入的密码不一致'); return; }
    setBusy(true); setError('');
    try {
      const result = await api(`/admin/users/${target.id}`, { method: 'POST', body: { ...(nickname !== target.nickname ? { nickname } : {}), ...(password ? { password } : {}) } });
      setPassword(''); setConfirmation(''); saved(result);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <><div className="account-heading"><button className="text-button" disabled={busy} onClick={back}><ArrowLeft size={17} />用户列表</button><strong>{target.nickname}</strong></div>
    <form onSubmit={submit} aria-label="编辑账号"><fieldset className="admin-fields" disabled={busy}>
      <label>昵称<input autoComplete="off" maxLength={12} required value={nickname} onChange={(e) => setNickname(e.target.value)} /></label>
      <p className="field-help">修改后使用新昵称登录，账号和战绩保留。</p>
      <label>新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} placeholder="留空则保留原密码" value={password} onChange={(e) => { setPassword(e.target.value); if (!e.target.value) setConfirmation(''); }} aria-describedby="admin-password-help" /></label>
      <p id="admin-password-help" className="field-help">原密码不可查看。重置后，该账号在所有设备上都须重新登录{target.id === currentId ? '，包括当前页面' : ''}。</p>
      {password && <label>确认新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      {error && <p role="alert" className="warning-text">{error}</p>}
      <button className="button primary full" disabled={busy || (nickname === target.nickname && !password)}>{busy && <LoaderCircle size={18} className="spin" />}{password ? '保存并重置密码' : '保存昵称'}</button>
    </fieldset></form></>;
}

export function AdminUsers({ user, onSaved }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError('');
    api(`/admin/users?q=${encodeURIComponent(query)}&offset=${offset}`, { signal: abort.signal }).then(setData).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [query, offset, revision]);
  function saved(result) {
    onSaved(result); setSelected(null); setOffset(0); setNotice('账号已更新'); setRevision((n) => n + 1);
  }
  if (selected) return <UserEditor key={selected.id} target={selected} currentId={user.id} back={() => setSelected(null)} saved={saved} />;
  return <section className="admin-users">
    <form className="admin-search" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search); setOffset(0); setRevision((n) => n + 1); }}><label>搜索昵称<input type="search" maxLength={128} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="输入全部或部分昵称" /></label><button className="button" aria-label="搜索用户"><Search size={18} /></button></form>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <div><p className="warning-text" role="alert">{error}</p><button className="text-button" onClick={() => setRevision((n) => n + 1)}>重试</button></div>}
    {!data && !error && <p className="loading-copy" role="status">正在读取账号…</p>}
    {data && <><p className="field-help">共 {data.total} 个账号</p><div className="session-list admin-list">{data.users.map((target) => <button key={target.id} onClick={() => { setSelected(target); setNotice(''); }} aria-label={`编辑 ${target.nickname}`}><span><b>{target.nickname}</b>{target.isAdmin && <span className="admin-badge">管理员</span>}<small>注册于 {new Date(target.createdAt).toLocaleDateString('zh-CN')}</small></span><ChevronRight size={20} /></button>)}</div>
      {!data.users.length && <p className="empty">没有匹配的账号</p>}
      {data.total > 20 && <div className="history-pagination"><button className="text-button" disabled={!offset} onClick={() => setOffset(offset - 20)}>上一页</button><span>{offset / 20 + 1} / {Math.ceil(data.total / 20)}</span><button className="text-button" disabled={offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>下一页</button></div>}
    </>}
  </section>;
}
