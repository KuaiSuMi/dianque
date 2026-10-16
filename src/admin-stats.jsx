import { useEffect, useState } from 'react';
import { api } from './api';
import { Segmented } from './ui';

const number = (value) => value.toLocaleString('zh-CN');

export function AdminStats() {
  const [days, setDays] = useState('7');
  const [data, setData] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    api(`/admin/stats?days=${days}`, { signal: abort.signal }).then((next) => { if (!abort.signal.aborted) setData(next); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [days, revision]);
  const current = data?.days === Number(days) ? data : null;
  const max = Math.max(1, ...(current?.daily.map((row) => row.views) || []));
  return <section className="admin-stats" aria-label="网站数据概览">
    <div className="account-heading"><strong>数据概览</strong><button className="text-button" disabled={loading} onClick={() => setRevision((n) => n + 1)}>刷新</button></div>
    {error && <p className="warning-text" role="alert">{error}<button className="text-button" onClick={() => setRevision((n) => n + 1)}>重试</button></p>}
    {data && <>
      <dl className="stats-totals"><div><dt>账号总数</dt><dd>{number(data.totals.users)}</dd><small>管理员 {number(data.totals.admins)} · 已参赛 {number(data.totals.playedUsers)}</small></div><div><dt>已结算对局</dt><dd>{number(data.totals.matches)}</dd><small>三人 {number(data.totals.threePlayerMatches)} · 四人 {number(data.totals.fourPlayerMatches)}</small></div></dl>
      <p className="stats-live"><span>近 5 分钟活跃 <b>{number(data.totals.onlineUsers)}</b></span><span>对局中牌桌 <b>{number(data.totals.activeRooms)}</b></span></p>
    </>}
    <Segmented label="统计时间" value={days} onChange={setDays} options={ [['1', '今日'], ['7', '近 7 天'], ['30', '近 30 天']] } />
    {loading && <p className="field-help" role="status">正在读取统计…</p>}
    {current && <>
      <dl className="stats-period">{[['访问次数', 'views'], ['独立访客', 'visitors'], ['活跃账号', 'activeUsers'], ['新增账号', 'newUsers'], ['完成对局', 'matches'], ['HTTP 请求', 'requests']].map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{number(current.period[key])}</dd></div>)}</dl>
      <section className="stats-chart"><div className="stats-chart-heading"><h3>每日访问次数</h3><span>最高 {number(Math.max(...current.daily.map((row) => row.views)))}</span></div>
        <svg viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label={`每日访问次数：${current.daily.map((row) => `${row.day} ${current.trackingSince && row.day >= current.trackingSince ? row.views : '未记录'}`).join('，')}`}>
          <line x1="0" y1="148" x2="600" y2="148" />
          {current.daily.map((row, i) => { const step = 600 / current.daily.length, width = Math.min(44, step * 0.64), height = row.views / max * 132; return <rect key={row.day} x={step * (i + 0.5) - width / 2} y={148 - height} width={width} height={height} rx="3"><title>{row.day}：{row.views} 次访问，{row.visitors} 位访客</title></rect>; })}
        </svg><div className="chart-dates"><span>{current.from}</span><span>{current.today}</span></div>
        {!current.period.views && <p className="field-help">所选时段暂无访问记录。</p>}
      </section>
      <p className="field-help">访问与活跃数据{current.trackingSince ? `自 ${current.trackingSince} 起记录` : '尚未开始记录'}，日期按北京时间。</p>
      <details className="rules"><summary>统计口径</summary><p>访问次数按打开或刷新页面计；独立访客按浏览器去重，活跃账号按已登录访问去重。清除浏览器数据或更换设备会计为新访客。</p><p>对局按完整一场统计，须确认结算；已删除记录不计入。对局中牌桌包含待确认结算。HTTP 请求包含接口、页面和资源，不含健康检查，也不等于服务器带宽。</p></details>
      <p className="stats-updated">更新于 {new Date(current.updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
    </>}
  </section>;
}
