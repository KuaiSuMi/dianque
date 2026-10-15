import { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle, LogOut } from 'lucide-react';
import { Segmented } from './ui';
import { api } from './api';

export function AuthForm({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onAuth(await api(`/${mode}`, { method: 'POST', body: { nickname, password } })); setPassword(''); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section className="entry-panel auth-panel"><h1>{mode === 'register' ? '注册点雀' : '登录点雀'}</h1><Segmented label="账号操作" className="entry-tabs" value={mode} onChange={(value) => { setMode(value); setError(''); }} options={ [['login', '登录'], ['register', '注册']] } />
    <form onSubmit={submit}><label>昵称<input autoComplete="username" maxLength={12} value={nickname} onChange={(e) => setNickname(e.target.value)} required /></label><label>密码<input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} minLength={8} maxLength={128} placeholder="至少 8 位" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      {mode === 'register' && <p className="field-help">昵称用于登录。请保存密码，当前不提供密码找回。</p>}{error && <p role="alert" className="warning-text">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{mode === 'register' ? '注册并登录' : '登录'}</button>
    </form></section>;
}

function RankChart({ matches, count }) {
  const width = 600, height = 220, left = 28, right = 16, top = 18, bottom = 20;
  const x = (i) => matches.length === 1 ? width / 2 : left + i * (width - left - right) / (matches.length - 1);
  const y = (rank) => top + (rank - 1) * (height - top - bottom) / (count - 1);
  return <div className="rank-chart"><h3>近期顺位<small>最近 {matches.length} 场</small></h3><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`从早到晚最近 ${matches.length} 场顺位：${matches.map((m) => m.rank).join('、')}`}>
    {Array.from({ length: count }, (_, i) => <g key={i}><line x1={left} x2={width - right} y1={y(i + 1)} y2={y(i + 1)} /><text x="8" y={y(i + 1) + 4}>{i + 1}</text></g>)}
    <polyline points={matches.map((m, i) => `${x(i)},${y(m.rank)}`).join(' ')} />
    {matches.map((m, i) => <circle key={m.id} cx={x(i)} cy={y(m.rank)} r="4"><title>{new Date(m.endedAt).toLocaleDateString('zh-CN')} · 第 {m.rank} 位 · {m.score.toLocaleString()} 点</title></circle>)}
  </svg><div className="chart-dates"><span>较早</span><span>最近</span></div></div>;
}

export function AccountHistory({ user, openRecord, logout }) {
  const [count, setCount] = useState(4);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError('');
    api(`/history?players=${count}&offset=${offset}`, { signal: abort.signal }).then(setData).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [count, offset]);
  async function open(id) {
    setBusy(true); setError('');
    try { openRecord(await api(`/matches/${id}`)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="account-history"><div className="account-heading"><strong>{user.nickname}</strong><button className="text-button" onClick={logout}><LogOut size={16} />退出登录</button></div>
    <Segmented label="统计人数" value={String(count)} onChange={(value) => { setCount(Number(value)); setOffset(0); }} options={ [['4', '四人'], ['3', '三人']] } />
    {error && <p role="alert" className="warning-text">{error}</p>}
    {!data && !error && <p className="loading-copy" role="status">正在读取对局…</p>}
    {data && <><div className="account-stats"><div><span>平均顺位</span><strong>{data.averageRank == null ? '—' : data.averageRank.toFixed(2)}</strong></div><div><span>完成对局</span><strong>{data.games}<small> 场</small></strong></div></div>
      {data.games ? <><RankChart matches={data.recent} count={count} /><div className="account-matches">{data.matches.map((match) => <button key={match.id} disabled={busy} onClick={() => open(match.id)}><span className="match-rank">{match.rank}<small>位</small></span><span>{count === 3 ? '三人' : '四人'}{match.length === 'south' ? '南' : '东'}<small>{new Date(match.endedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {match.code}</small></span><strong>{match.score.toLocaleString()}<small> 点</small></strong></button>)}</div>
        <div className="history-pagination"><button className="text-button" disabled={offset === 0} onClick={() => setOffset(offset - 20)}>上一页</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(data.games / 20)}</span><button className="text-button" disabled={offset + 20 >= data.games} onClick={() => setOffset(offset + 20)}>下一页</button></div></> : <p className="empty">暂无已完成的{count === 3 ? '三人' : '四人'}对局</p>}
    </>}
  </section>;
}
