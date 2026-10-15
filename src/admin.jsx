import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, LoaderCircle, Search, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { Expanding, PanelTransition, Segmented, Toggle } from './ui';
import { AdminVoices } from './admin-voices';

export function AdminEntry({ open }) {
  return open && <div className="admin-entry"><button className="text-button" onClick={open}><ShieldCheck size={17} />管理中心</button></div>;
}

function Pagination({ offset, total, change }) {
  return total > 20 && <div className="history-pagination"><button className="text-button" disabled={!offset} onClick={() => change(offset - 20)}>上一页</button><span>{offset / 20 + 1} / {Math.ceil(total / 20)}</span><button className="text-button" disabled={offset + 20 >= total} onClick={() => change(offset + 20)}>下一页</button></div>;
}

function UserMatches({ target }) {
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError(''); setSelected(null);
    api(`/admin/users/${target.id}/matches?offset=${offset}`, { signal: abort.signal }).then(setData).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [target.id, offset, revision]);
  async function remove() {
    setBusy(true); setError('');
    try {
      await api(`/admin/matches/${selected.id}`, { method: 'DELETE' });
      setSelected(null); setOffset(0); setRevision((n) => n + 1);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className="admin-section"><h3>对局记录</h3>
    {error && <p role="alert" className="warning-text">{error}<button className="text-button" onClick={() => setRevision((n) => n + 1)}>重试</button></p>}
    {!data && !error && <p role="status">正在读取记录…</p>}
    <PanelTransition view={selected ? 'confirm' : 'list'}>{selected ? <div className="admin-confirm"><p>删除房间 {selected.code} 于 {new Date(selected.endedAt).toLocaleString('zh-CN')} 结束的整场记录？</p><p className="warning-text">同场所有玩家的记录和统计都会移除，无法撤销。</p><div className="panel-actions"><button className="button" disabled={busy} onClick={() => setSelected(null)}>保留</button><button className="button danger" disabled={busy} onClick={remove}>删除整场记录</button></div></div> : data && <>
      <div className="session-list">{data.matches.map((match) => <button key={match.id} disabled={busy} onClick={() => setSelected(match)}><span><b>{match.code} · {match.playerCount} 人对局</b><small>{new Date(match.endedAt).toLocaleString('zh-CN')}</small><small>{match.players.map((p) => p.name).join('、')}</small></span><span className="danger-text">移除</span></button>)}</div>
      {!data.matches.length && <p className="empty">暂无对局记录</p>}<Pagination offset={offset} total={data.total} change={setOffset} />
    </>}</PanelTransition>
  </section>;
}

function UserEditor({ target, user, back, saved }) {
  const creating = !target.id;
  const [nickname, setNickname] = useState(target.nickname || '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canEdit = user.isSuperAdmin || !target.isAdmin || target.id === user.id;
  async function mutate(path, options) {
    setBusy(true); setError('');
    try { const result = await api(path, options); setPassword(''); setConfirmation(''); saved(result); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  function submit(event) {
    event.preventDefault();
    if (password !== confirmation) { setError('两次输入的密码不一致'); return; }
    mutate(creating ? '/admin/users' : `/admin/users/${target.id}`, { method: 'POST', body: { ...(creating || nickname !== target.nickname ? { nickname } : {}), ...(password ? { password } : {}) } });
  }
  return <><div className="account-heading"><button className="text-button" disabled={busy} onClick={back}><ArrowLeft size={17} />用户列表</button><strong>{creating ? '创建账号' : target.nickname}</strong></div>
    {canEdit && <form onSubmit={submit} aria-label={creating ? '创建账号' : '编辑账号'}><fieldset className="admin-fields" disabled={busy}>
      <label>昵称<input autoComplete="off" maxLength={12} required value={nickname} onChange={(e) => setNickname(e.target.value)} /></label>
      {!creating && <p className="field-help">修改后使用新昵称登录，账号和战绩保留。</p>}
      <label>{creating ? '密码' : '新密码'}<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required={creating} placeholder={creating ? '至少 8 位' : '留空则保留原密码'} value={password} onChange={(e) => { setPassword(e.target.value); if (!e.target.value) setConfirmation(''); }} /></label>
      {!creating && <p className="field-help">重置密码后，该账号在所有设备上都须重新登录。</p>}
      {(password || creating) && <label>确认密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
      <button className="button primary full" disabled={busy || (!creating && nickname === target.nickname && !password)}>{busy && <LoaderCircle size={18} className="spin" />}{creating ? '创建账号' : '保存修改'}</button>
    </fieldset></form>}
    {error && <p role="alert" className="warning-text">{error}</p>}
    {!creating && <>
      {user.isSuperAdmin && !target.isSuperAdmin && <div className="settings-row"><span>普通管理员<small>可管理账号、战绩、公告和立直音频</small></span><Toggle label="普通管理员" checked={target.isAdmin} disabled={busy} onChange={(isAdmin) => mutate(`/admin/users/${target.id}/role`, { method: 'POST', body: { isAdmin } })} /></div>}
      {canEdit && target.id !== user.id && !target.isSuperAdmin && <div className="admin-section"><PanelTransition view={deleting ? 'confirm' : 'button'}>{deleting ? <div className="admin-confirm"><p>确定删除账号「{target.nickname}」？该账号将无法登录，同场其他玩家的战绩保留。</p><div className="panel-actions"><button className="button" disabled={busy} onClick={() => setDeleting(false)}>保留账号</button><button className="button danger" disabled={busy} onClick={() => mutate(`/admin/users/${target.id}`, { method: 'DELETE' })}>确认删除账号</button></div></div> : <button className="text-button danger-text" disabled={busy} onClick={() => setDeleting(true)}>删除账号</button>}</PanelTransition></div>}
      <UserMatches target={target} />
    </>}
  </>;
}

function Users({ user, onSaved }) {
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
    onSaved(result); setSelected(null); setOffset(0); setNotice('操作已保存'); setRevision((n) => n + 1);
  }
  return <PanelTransition view={selected ? selected.id || 'new' : 'list'}>{selected ? <UserEditor target={selected} user={user} back={() => setSelected(null)} saved={saved} /> : <section className="admin-users">
    <div className="account-heading"><strong>账号</strong><button className="text-button" onClick={() => setSelected({})}>创建账号</button></div>
    <form className="admin-search" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search); setOffset(0); setRevision((n) => n + 1); }}><label>搜索昵称<input type="search" maxLength={128} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="输入全部或部分昵称" /></label><button className="button" aria-label="搜索用户"><Search size={18} /></button></form>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <div><p className="warning-text" role="alert">{error}</p><button className="text-button" onClick={() => setRevision((n) => n + 1)}>重试</button></div>}
    {!data && !error && <p className="loading-copy" role="status">正在读取账号…</p>}
    {data && <><p className="field-help">共 {data.total} 个账号</p><div className="session-list admin-list">{data.users.map((target) => <button key={target.id} onClick={() => { setSelected(target); setNotice(''); }} aria-label={`编辑 ${target.nickname}`}><span><b>{target.nickname}</b>{target.isAdmin && <span className="admin-badge">{target.isSuperAdmin ? '超级管理员' : '管理员'}</span>}<small>注册于 {new Date(target.createdAt).toLocaleDateString('zh-CN')}</small></span><ChevronRight size={20} /></button>)}</div>
      {!data.users.length && <p className="empty">没有匹配的账号</p>}<Pagination offset={offset} total={data.total} change={setOffset} />
    </>}
  </section>}</PanelTransition>;
}

function Announcements() {
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    api('/admin/announcements', { signal: abort.signal }).then(setItems).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [revision]);
  function edit(item) { setEditing(item); setDeleting(false); setError(''); setNotice(''); }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const { id, title, content, published, revision } = editing;
      if (deleting) {
        await api(`/admin/announcements/${id}?revision=${revision}`, { method: 'DELETE' });
        setItems((items) => items.filter((item) => item.id !== id));
      } else await api(`/admin/announcements${id ? `/${id}` : ''}`, { method: 'POST', body: { title, content, published: !!published, ...(id ? { revision } : {}) } });
      setNotice(deleting ? '公告已删除' : '公告已保存');
      setEditing(null); setDeleting(false); setRevision((n) => n + 1);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section>{notice && <p className="field-help" role="status">{notice}</p>}{error && <p className="warning-text" role="alert">{error}</p>}<PanelTransition view={editing ? deleting ? 'delete' : editing.id || 'new' : 'list'}>{editing ? <>
    <button className="text-button" disabled={busy} onClick={() => edit(null)}><ArrowLeft size={17} />公告列表</button>
    {deleting ? <div className="admin-section admin-confirm"><p>确定删除公告「{editing.title}」？删除后将从首页和管理中心移除，无法撤销。</p><div className="panel-actions"><button className="button" disabled={busy} onClick={() => setDeleting(false)}>保留公告</button><button className="button danger" disabled={busy} onClick={submit}>{busy && <LoaderCircle size={18} className="spin" />}确认删除公告</button></div></div> : <form className="admin-section" onSubmit={submit}><fieldset className="admin-fields" disabled={busy}>
      <label>标题<input maxLength={80} required value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></label>
      <label>正文<textarea maxLength={3000} rows={8} required value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} /></label>
      <div className="settings-row"><span>在首页发布<small>关闭后仅管理员可见</small></span><Toggle label="在首页发布" checked={!!editing.published} disabled={busy} onChange={(published) => setEditing({ ...editing, published })} /></div>
      <button className="button primary full" disabled={busy}>{editing.published ? '保存并发布' : '保存草稿'}</button>
      {editing.id && <button type="button" className="text-button danger-text admin-delete" onClick={() => setDeleting(true)}>删除公告</button>}
    </fieldset></form>}
  </> : <><div className="account-heading"><strong>公告</strong><button className="text-button" onClick={() => edit({ title: '', content: '', published: true })}>新建公告</button></div>
    <div className="session-list">{items?.map((item) => <button key={item.id} onClick={() => edit(item)}><span><b>{item.title}</b><small>{item.published ? '已发布' : '草稿'} · {new Date(item.updated_at).toLocaleString('zh-CN')}</small></span><ChevronRight size={20} /></button>)}</div>
    {items?.length === 0 && <p className="empty">暂无公告</p>}{!items && !error && <p role="status">正在读取公告…</p>}
    {error && <button className="text-button" onClick={() => { setError(''); setRevision((n) => n + 1); }}>重试</button>}
  </>}</PanelTransition></section>;
}

export function AdminUsers({ user, onSaved }) {
  const [tab, setTab] = useState('users');
  return <Expanding initial={false}><Segmented className="admin-tabs" label="管理内容" value={tab} onChange={setTab} options={[["users", "账号与战绩"], ["announcements", "公告"], ["voices", "立直音频"]]} /><PanelTransition view={tab}>{tab === 'users' ? <Users user={user} onSaved={onSaved} /> : tab === 'announcements' ? <Announcements /> : <AdminVoices />}</PanelTransition></Expanding>;
}
