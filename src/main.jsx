import React, { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { useRoom } from './useRoom';
import { AuthForm, AccountHistory } from './account';
import { AnimatePresence, MotionConfig, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { Expanding, PageTransition, Segmented, Toggle, spring } from './ui';
import { RON_POINTS, TSUMO_POINTS, pointPatterns, tsumoAmounts, paymentTransfers } from './payment';
import { ArrowDownLeft, ArrowRight, Check, ChevronRight, Copy, Download, Expand, Flag, History, Home, Info, LoaderCircle, Minus, Redo2, RotateCcw, Share2, Shuffle, Undo2, Wifi, WifiOff, X } from 'lucide-react';
import './vendor/apple-style.css';
import './styles.css';

const WINDS = ['东', '南', '西', '北'];
const NoticeContext = createContext('');
const fmt = (n) => n.toLocaleString('en-US');
const delta = (n) => `${n > 0 ? '+' : ''}${fmt(n)}`;
const initialCode = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';

function DigitDisplay({ value, compact = false }) {
  const ref = useRef(null);
  const previous = useRef(value);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    const animation = ref.current.animate(reduce ? [{ opacity: 0.6 }, { opacity: 1 }] : [{ opacity: 0.5, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: reduce ? 100 : 280, easing: 'cubic-bezier(.23, 1, .32, 1)' });
    return () => animation.cancel();
  }, [value, reduce]);
  const segments = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  const points = { a: '7,2 35,2 40,7 35,12 7,12 2,7', b: '37,14 42,9 42,39 37,44 32,39 32,19', c: '37,46 42,51 42,81 37,86 32,81 32,51', d: '7,84 35,84 40,89 35,94 7,94 2,89', e: '5,46 10,51 10,81 5,86 0,81 0,51', f: '5,9 10,14 10,39 5,44 0,39 0,14', g: '7,43 35,43 40,48 35,53 7,53 2,48' };
  return <span ref={ref} className={`digits ${compact ? 'digits-small' : ''}`} role="img" aria-label={`${fmt(value)} 点`}>
    {String(value).split('').map((char, index) => <svg key={index} viewBox="0 0 44 96" aria-hidden="true">{Object.entries(points).map(([key, points]) => <polygon key={key} points={points} className={(char === '-' ? key === 'g' : segments[Number(char)]?.includes(key)) ? 'lit' : 'unlit'} />)}</svg>)}
  </span>;
}

function Logo() { return <span className="logo">点雀</span>; }
function Button({ children, icon: Icon, className = '', loading, ...props }) { return <button className={`button ${className}`} {...props}>{loading ? <LoaderCircle size={18} className="spin" /> : Icon ? <Icon size={18} /> : null}{children}</button>; }
function Avatar({ player, large = false }) { return <span className={`avatar seat-${player?.seat ?? 0} ${large ? 'avatar-large' : ''}`}>{player?.name?.slice(0, 1) || '待'}</span>; }
function RiichiStick({ small = false }) { return <span className={`riichi-stick ${small ? 'stick-small' : ''}`} aria-hidden="true"><i /></span>; }

function Sheet({ title, children, close, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const notice = useContext(NoticeContext);
  const onClose = useRef(close);
  onClose.current = close;
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    if (opener instanceof HTMLElement) {
      const from = opener.getBoundingClientRect(), to = dialog.getBoundingClientRect();
      dialog.style.transformOrigin = `${Math.max(0, Math.min(to.width, from.x + from.width / 2 - to.x))}px ${Math.max(0, Math.min(to.height, from.y + from.height / 2 - to.y))}px`;
    }
    const cancel = (event) => { event.preventDefault(); onClose.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <motion.dialog ref={ref} className={`sheet as-glass as-glass-large ${wide ? 'sheet-wide' : ''}`} data-lens="off" data-adapt="off" data-exiting={!present} onClick={(e) => { if (e.target === ref.current && present) close(); }} aria-labelledby={titleId}
    initial={{ opacity: 0, transform: reduce ? 'none' : 'translateY(22px) scale(.96)' }} animate={{ opacity: 1, transform: reduce ? 'none' : 'translateY(0px) scale(1)' }} exit={{ opacity: 0, transform: reduce ? 'none' : 'translateY(14px) scale(.98)', transition: { duration: reduce ? 0.1 : 0.16 } }} transition={reduce ? { duration: 0.1 } : spring}>
    <div className="sheet-handle" /><div className="sheet-header"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X /></button></div>
    <div className="sheet-body">{notice && <p className="sheet-message" role="alert">{notice}</p>}{children}</div>
  </motion.dialog>;
}

function RoomRulesFields({ points, setPoints, length, setLength, count, setCount, seated = 0 }) {
  return <>
    <fieldset className="format-field"><legend>对战形式</legend><Segmented label="对战形式" value={length} onChange={setLength} options={[['south', '南风场'], ['east', '东风场']]} /></fieldset>
    <label>对局人数<select value={count} onChange={(e) => setCount(Number(e.target.value))}><option value={4}>四人</option><option value={3} disabled={seated > 3}>三人</option></select></label>
    {seated > 3 && <p className="field-help">已有四人入座，不能改为三人模式。</p>}
    <label>起始点数<input type="number" inputMode="numeric" min="1000" max="1000000" step="100" required value={points} onChange={(e) => setPoints(e.target.value)} /></label>
    {count === 3 && <p className="field-help">三人自摸损 · 流局罚符共 2,000 点</p>}
  </>;
}

function Lobby({ user, onEnter, notify, openAccount }) {
  const [tab, setTab] = useState(initialCode ? 'join' : 'create');
  const [code, setCode] = useState(initialCode);
  const [points, setPoints] = useState(25000);
  const [length, setLength] = useState('south');
  const [count, setCount] = useState(4);
  const [busy, setBusy] = useState(false);
  const [rooms, setRooms] = useState([]);
  useEffect(() => { const abort = new AbortController(); api('/rooms', { signal: abort.signal }).then(setRooms).catch((e) => { if (!abort.signal.aborted) notify(e.message); }); return () => abort.abort(); }, []);
  async function join(code) {
    setBusy(true);
    try { onEnter(await api(`/rooms/${code}/join`, { method: 'POST' })); }
    catch (error) { notify(error.message); } finally { setBusy(false); }
  }
  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      onEnter(await api(tab === 'create' ? '/rooms' : `/rooms/${code}/join`, { method: 'POST', body: { startPoints: Number(points), playerCount: count, length } }));
    } catch (error) { notify(error.message); } finally { setBusy(false); }
  }
  return <main className="lobby page">
    <header className="app-header"><Logo /><button className="text-button" onClick={openAccount}><History size={17} />{user.nickname} · 我的对局</button></header>
    <div className="lobby-layout">
      <section className="entry-panel"><Segmented className="entry-tabs" label="进入牌桌方式" value={tab} onChange={setTab} options={[['create', '创建牌桌'], ['join', '加入牌桌']]} />
        <motion.form key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} onSubmit={submit}>
          {tab === 'join' ? <label>房间码<input className="code-input" autoCapitalize="characters" autoCorrect="off" maxLength={4} minLength={4} pattern="[A-Z]{4}" placeholder="4 位字母" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} required /></label> : <RoomRulesFields points={points} setPoints={setPoints} length={length} setLength={setLength} count={count} setCount={setCount} />}
          <Button className="primary full" loading={busy} disabled={busy} icon={ArrowRight}>{tab === 'create' ? '创建房间' : '入座'}</Button>
        </motion.form>
      </section>
    </div>
    {rooms.length > 0 && <section className="recent-rooms"><h2>最近房间</h2><div className="session-list">{rooms.map((r) => <button key={r.code} disabled={busy} onClick={() => join(r.code)}><span><b>{r.code}</b><small>{r.config.playerCount === 3 ? '三人' : '四人'}{r.config.length === 'south' ? '南' : '东'} · {['playing', 'settling'].includes(r.status) ? '对局中' : '大厅'}</small></span><ChevronRight size={20} /></button>)}</div></section>}
  </main>;
}

function ShareSheet({ room, close, notify }) {
  const url = `${location.origin}/?room=${room.code}`;
  const [qr, setQr] = useState('');
  useEffect(() => { import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(url, { width: 240, margin: 2, color: { dark: '#142c2e', light: '#ffffff' } })).then(setQr).catch(() => notify('二维码生成失败，请复制地址')); }, [url]);
  async function copy() {
    try { if (navigator.clipboard) await navigator.clipboard.writeText(url); else { document.querySelector('#room-url').select(); if (!document.execCommand('copy')) throw new Error('copy'); } notify('邀请地址已复制'); } catch { notify('请长按下方地址复制'); }
  }
  return <Sheet title="邀请牌友入座" close={close}><div className="share-content">{qr && <img src={qr} alt={`房间 ${room.code} 的加入二维码`} width="220" height="220" />}<strong className="room-code-big">{room.code}</strong><small>按{room.config.playerCount === 3 ? '东南西' : '东南西北'}顺序入座</small></div><label>邀请地址<input id="room-url" value={url} readOnly onFocus={(e) => e.target.select()} /></label><Button className="primary full" icon={Copy} onClick={copy}>复制邀请地址</Button>{['localhost', '127.0.0.1'].includes(location.hostname) && <p className="warning-text">当前是本机地址。请用启动终端显示的局域网 IP 打开，再邀请其他手机。</p>}</Sheet>;
}

function WaitingRoom({ room, me, act, busy, share, records, configure }) {
  const ended = room.state.status === 'ended';
  const count = room.config.playerCount;
  const reduce = useReducedMotion();
  const [shuffles, setShuffles] = useState(0);
  return <section className="waiting">
    <div className="waiting-heading"><h1>{room.players.length < count ? '等待入座' : '房间大厅'}</h1><p>房间 <strong>{room.code}</strong> · {count === 3 ? '三人' : '四人'}{room.config.length === 'south' ? '南' : '东'} · {fmt(room.config.startPoints)} 点起{ended && <><br />本场已结束</>}</p></div>
    <div className={`seats-list seats-${count}`}>{Array.from({ length: count }, (_, seat) => { const p = room.players[seat]; return <motion.div layout={reduce ? false : 'position'} transition={{ layout: { duration: 0.28, ease: [0.77, 0, 0.175, 1] } }} className={`waiting-seat ${p ? 'taken' : ''}`} key={p?.id || `empty-${seat}`}><span className={`wind-chip ${seat === room.config.startDealer ? 'dealer' : ''}`}>{WINDS[(seat - room.config.startDealer + count) % count]}</span>{p && <Avatar player={p} large />}<strong>{p?.name || '空位'}{p?.id === room.hostId && <span className="host-badge">房主</span>}</strong><small>{p ? `${p.id === me.id ? '你 · ' : ''}${p.seat === room.config.startDealer ? '起庄 · ' : ''}${p.online ? '已连接' : '未连接'}` : ''}</small></motion.div>; })}</div>
    <div className="waiting-actions">{room.players.length < count && <Button icon={Share2} onClick={share}>邀请牌友 · {room.players.length}/{count}</Button>}{me.id === room.hostId ? <><Button disabled={busy || room.players.length < count} onClick={async () => { if (await act({ type: 'shuffle' })) setShuffles((n) => n + 1); }}><motion.span className="shuffle-icon" aria-hidden="true" animate={{ transform: reduce ? 'none' : `rotate(${shuffles * 180}deg)` }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}><Shuffle size={18} /></motion.span>随机选座</Button><Button className="primary" loading={busy} disabled={busy || room.players.length < count} onClick={() => act({ type: 'start' })} icon={ArrowRight}>开始对局</Button></> : <p>等待房主开始对局</p>}</div>
    <div className="waiting-tools"><button className="text-button" onClick={records}><History size={17} />对战记录</button>{me.id === room.hostId && <button className="text-button" disabled={busy} onClick={configure}><Info size={17} />房间设置</button>}</div>
  </section>;
}

function PlayerCard({ player, room, me, position, onPay }) {
  const seat = player.seat;
  const wind = WINDS[(seat - room.dealer + room.config.playerCount) % room.config.playerCount];
  const score = room.state.scores[seat];
  const difference = room.state.scores[me.seat] - score;
  return <button className={`player-display position-${position} ${seat === room.dealer ? 'is-dealer' : ''} ${room.state.riichi[seat] ? 'has-riichi' : ''}`} onClick={() => onPay(seat)} disabled={room.state.status !== 'playing' || !!room.pending || Object.keys(room.drawVotes).length > 0} aria-label={`向${player.name}支付，${wind}家${player.id === room.hostId ? '，房主' : ''}，${fmt(score)}点，我的点差${delta(difference)}点`}>
    <div className="player-top"><Avatar player={player} /><span className="player-name"><span>{player.name}{player.id === room.hostId && <span className="host-badge">房主</span>}</span><span className={`connection-dot ${player.online ? 'online' : ''}`} /></span><span className={`wind-chip ${seat === room.dealer ? 'dealer' : ''}`}>{wind}</span></div>
    <DigitDisplay value={score} compact /><div className="player-bottom"><span className="player-status"><span>{seat === room.config.startDealer ? <><Flag size={11} />起庄</> : seat === room.dealer ? '庄家' : position === 'top' ? '对家' : position === 'left' ? '上家' : '下家'}</span>{room.state.riichi[seat] && <span className="riichi-label"><RiichiStick small />立直</span>}</span><span className="score-difference">{delta(difference)}</span></div>
  </button>;
}

function AmountChoices({ label, options, value, onChange, tsumo = false }) {
  return <div className={`quick-amounts ${tsumo ? 'tsumo-amounts' : ''}`} role="group" aria-label={label}>
    {options.map(([amount, text]) => <button type="button" key={amount} aria-pressed={value === amount} onClick={() => onChange(amount)}>{text}</button>)}
  </div>;
}

function PointPatterns({ name, text }) {
  return <div aria-live="polite" aria-atomic="true">{text && <motion.section key={text} className="point-patterns" aria-label={`${name}的对应番符`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}><h3>对应番符</h3><p>{text}</p></motion.section>}</div>;
}

function PaymentSheet({ room, me, target, close, act, busy }) {
  const isSelf = target === me.seat;
  const [mode, setMode] = useState(isSelf ? 'tsumo' : 'ron');
  const [entry, setEntry] = useState('quick');
  const [amounts, setAmounts] = useState({});
  const [recipients, setRecipients] = useState([target]);
  const [error, setError] = useState('');
  const others = room.players.filter((p) => p.seat !== me.seat);
  const winner = room.players[target];
  const rows = mode === 'ron' ? others.filter((p) => recipients.includes(p.seat)).map((p) => ({ player: p, from: me.seat, to: p.seat })) : room.players.filter((p) => p.seat !== target).map((p) => ({ player: p, from: p.seat, to: target }));
  const transfers = paymentTransfers({ mode, entry, rows, amounts, honba: room.state.honba, playerCount: room.config.playerCount });
  const total = transfers.reduce((sum, t) => sum + (Number.isFinite(t.amount) ? t.amount : 0), 0);
  const tsumoPoints = TSUMO_POINTS[target === room.dealer ? 'dealer' : 'nonDealer'];
  const selectedTsumo = tsumoPoints.findIndex((points) => rows.every(({ from }) => amounts[from] === points[from === room.dealer ? 1 : 0]));
  function changeEntry(value) { setEntry(value); setAmounts({}); setError(''); }
  async function submit(e) {
    e.preventDefault(); setError('');
    if (!rows.length) { setError('请选择至少一位和牌者'); return; }
    if (entry === 'quick' && transfers.some((t) => !Number.isFinite(t.amount))) { setError('请选择每位和牌者的点数'); return; }
    if (transfers.some((t) => !Number.isSafeInteger(t.amount) || t.amount <= 0 || t.amount > 1000000 || t.amount % 100 !== 0)) { setError('每笔点数请填 100～1000000 之间的整百数'); return; }
    if (await act({ type: 'propose', mode, transfers })) close();
  }
  return <Sheet title={isSelf ? '自摸结算' : `向 ${winner.name} 支付`} close={close}>
    {!isSelf && <Segmented className="compact-tabs" label="支付方式" value={mode} onChange={(value) => { setMode(value); setAmounts({}); setError(''); }} options={[['ron', '荣和支付'], ['tsumo', '对方自摸']]} />}
    <Segmented className="amount-entry-tabs" label="点数输入方式" value={entry} onChange={changeEntry} options={[['quick', '常规点数'], ['custom', '自定义']]} />
    <p className="payment-help">{room.state.honba} 本场<span>{entry === 'quick' ? mode === 'tsumo' ? `每家自动加 ${fmt(room.state.honba * 100)} 点` : `自动加 ${fmt(room.state.honba * 300)} 点` : '请填写已含本场的金额'}</span></p>
    <form className="payment-form" onSubmit={submit} noValidate>
      <AnimatePresence initial={false}>{mode === 'ron' && <Expanding key="winners"><fieldset className="winner-select"><legend>和牌者（可多选）</legend>{others.map((p) => <label className="check-label" key={p.id}><input type="checkbox" checked={recipients.includes(p.seat)} onChange={(e) => setRecipients(e.target.checked ? [...recipients, p.seat] : recipients.filter((s) => s !== p.seat))} /><span>{p.name}</span></label>)}</fieldset></Expanding>}</AnimatePresence>
      <AnimatePresence initial={false}>{mode === 'tsumo' && entry === 'quick' && <Expanding key="tsumo-points"><p className="amount-caption">{target === room.dealer ? '庄家自摸 · 每家支付' : '子家自摸 · 子家 / 庄家'}</p><AmountChoices label="自摸常规点数" tsumo options={tsumoPoints.map((points, index) => [index, target === room.dealer ? fmt(points[0]) : `${fmt(points[0])} / ${fmt(points[1])}`])} value={selectedTsumo} onChange={(index) => { setAmounts(tsumoAmounts(rows, room.dealer, tsumoPoints[index])); setError(''); }} /><PointPatterns name={winner.name} text={pointPatterns('tsumo', target === room.dealer, tsumoPoints[selectedTsumo])} /></Expanding>}</AnimatePresence>
      <div className="payment-rows"><AnimatePresence initial={false}>{rows.map(({ player: p }, index) => <Expanding className="payment-recipient" key={p.id}>
        <motion.div key={`${mode}-${entry}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}>
        <div className="payment-row"><Avatar player={p} /><span>{p.name}<small>{mode === 'ron' ? '收款' : '付款'}{p.seat === room.dealer ? ' · 庄家' : ''}</small></span>
          {entry === 'custom' ? <input aria-label={`${p.name}的${mode === 'ron' ? '收款' : '付款'}点数（已含本场）`} type="number" inputMode="numeric" min="100" max="1000000" step="100" placeholder="0" value={amounts[p.seat] || ''} onChange={(e) => setAmounts({ ...amounts, [p.seat]: e.target.value })} required /> : <strong className="payment-amount">{Number.isFinite(transfers[index].amount) ? fmt(transfers[index].amount) : '—'}{amounts[p.seat] > 0 && transfers[index].amount > amounts[p.seat] && <small>含本场 +{fmt(transfers[index].amount - amounts[p.seat])}</small>}</strong>}<span className="point-unit">点</span>
        </div>
        {entry === 'quick' && mode === 'ron' && <><AmountChoices label={`${p.name}的常规点数`} options={RON_POINTS[p.seat === room.dealer ? 'dealer' : 'nonDealer'].map((n) => [n, fmt(n)])} value={amounts[p.seat]} onChange={(n) => { setAmounts({ ...amounts, [p.seat]: n }); setError(''); }} /><PointPatterns name={p.name} text={pointPatterns('ron', p.seat === room.dealer, amounts[p.seat])} /></>}
        </motion.div>
      </Expanding>)}</AnimatePresence></div>
      <AnimatePresence initial={false}>{entry === 'quick' && mode === 'ron' && rows.length > 1 && <Expanding key="honba-hint"><p className="field-help">本场只加给下家方向最近的和牌者。</p></Expanding>}</AnimatePresence>
      <div className="payment-total"><span>支付合计</span><strong>{fmt(total)}<small> 点</small></strong></div><p className="field-help">供托 {fmt(room.state.pot * 1000)} 点另计，收款确认后换局。</p>
      <AnimatePresence initial={false}>{error && <Expanding key="error"><p role="alert" className="warning-text">{error}</p></Expanding>}</AnimatePresence><Button className="primary full" icon={ArrowRight} loading={busy} disabled={busy}>发起结算</Button>
    </form>
  </Sheet>;
}

function PendingPanel({ room, me, act, busy }) {
  const p = room.pending;
  const canApprove = p.payers.includes(me.seat) && !p.approved.includes(me.seat);
  const canReceive = p.winners.includes(me.seat) && !p.received.includes(me.seat) && p.approved.length === p.payers.length;
  const involved = [...p.payers, ...p.winners].includes(me.seat);
  return <section className="pending-panel" aria-live="polite">
    <div className="transfer-list">{p.transfers.map((t) => <div key={`${t.from}-${t.to}`}><span>{room.players[t.from].name}<ArrowRight size={13} />{room.players[t.to].name}</span><strong>{fmt(t.amount)}<small> 点</small></strong></div>)}</div>
    <div className="confirmation-steps"><span>付款确认 {p.approved.length}/{p.payers.length}</span><span>收款确认 {p.received.length}/{p.winners.length}</span></div>
    <p className="field-help">{p.approved.length < p.payers.length ? `等待 ${p.payers.filter((s) => !p.approved.includes(s)).map((s) => room.players[s].name).join('、')} 确认付款。` : `等待 ${p.winners.filter((s) => !p.received.includes(s)).map((s) => room.players[s].name).join('、')} 确认收款。`}{room.state.pot > 0 && `供托 ${room.state.pot} 根将另外发放。`}</p>
    <div className="panel-actions">{involved && <Button className="quiet" disabled={busy} onClick={() => act({ type: 'cancel', pendingId: p.id })}>拒绝 / 取消</Button>}{canApprove && <Button className="primary" loading={busy} disabled={busy} onClick={() => act({ type: 'approve', pendingId: p.id })} icon={Check}>确认我的付款</Button>}{canReceive && <Button className="primary" loading={busy} disabled={busy} onClick={() => act({ type: 'receive', pendingId: p.id })} icon={Check}>确认收款</Button>}</div>
  </section>;
}

function DrawSheet({ room, me, act, busy, close }) {
  const voted = Object.hasOwn(room.drawVotes, me.seat);
  const vote = (tenpai) => act({ type: 'draw', tenpai });
  return <Sheet title="确认流局" close={close}><p className="muted" role="status">{voted ? `已确认，等待其他玩家（${Object.keys(room.drawVotes).length}/${room.config.playerCount}）` : '全员确认后结算罚符并换局。'}</p><div className="draw-status">{room.players.map((p) => <div key={p.id}><Avatar player={p} /><span>{p.name}</span><small>{Object.hasOwn(room.drawVotes, p.seat) ? room.drawVotes[p.seat] ? '已确认 · 听牌' : '已确认 · 未听' : '待确认'}</small></div>)}</div><div className="draw-options"><Button className="primary" disabled={busy} icon={Check} onClick={() => vote(true)}>我已听牌</Button><Button disabled={busy || room.state.riichi[me.seat]} icon={Minus} onClick={() => vote(false)}>我未听牌</Button></div>{room.state.riichi[me.seat] && <p className="field-help">已立直，只能报听；误操作请先撤销。</p>}{voted && <Button className="quiet full" disabled={busy} onClick={() => vote(null)}>撤回我的流局确认</Button>}</Sheet>;
}

function EventRow({ event, room }) {
  const name = (seat) => room.players[seat]?.name || '';
  let title = event.label, description = '', change = '';
  if (event.type === 'riichi') { title = `${name(event.seat)} 立直`; description = `${event.label} · ${event.honba} 本场`; change = '−1,000'; }
  if (event.type === 'win') { title = `${event.winners.map(name).join('、')} ${event.mode === 'tsumo' ? '自摸' : '荣和'}`; description = event.transfers.map((t) => `${name(t.from)} → ${name(t.to)} ${fmt(t.amount)}`).join(' / '); change = `+${fmt(event.transfers.reduce((n, t) => n + t.amount, 0))}`; }
  if (event.type === 'draw') { title = '流局'; description = event.ready.length ? `${event.ready.map(name).join('、')} 听牌` : '全员未听'; change = '本场 +1'; }
  if (event.type === 'settlement-scores') description = event.after.map((score, seat) => `${name(seat)} ${fmt(event.before[seat])} → ${fmt(score)}`).join(' / ');
  if (event.type === 'adjust') { const count = room.state.scores.length; description = `${WINDS[Math.floor(event.after.hand / count) % 4]} ${event.after.hand % count + 1} 局 · ${event.after.honba} 本场 · 供托 ${event.after.pot} 根；${event.after.scores.map((score, seat) => `${name(seat)} ${fmt(event.before.scores[seat])} → ${fmt(score)}`).join(' / ')}`; }
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className={`event-row ${event.undone ? 'undone' : ''}`}><div className="event-detail"><strong>{title}{event.undone && <small>已撤销</small>}</strong>{(description || event.pot > 0) && <p>{description}{event.pot > 0 && ` · 供托 ${event.pot} 根${Number.isInteger(event.potWinner) ? ` → ${name(event.potWinner)}` : '保留'}`}</p>}</div><div className="event-value"><strong>{change}</strong><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div></motion.div>;
}

function Records({ room, record: fixedRecord, close }) {
  const [older, setOlder] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  async function load(offset = 0, signal) {
    setLoading(true); setError('');
    try { const rows = await api(`/rooms/${room.code}/history?offset=${offset}`, { signal }); setOlder((previous) => offset ? [...previous, ...rows] : rows); setMore(rows.length === 20); }
    catch (e) { if (!signal?.aborted) setError(e.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { if (!room) return; const abort = new AbortController(); load(0, abort.signal); return () => abort.abort(); }, [room?.code, room?.matchId]);
  const games = fixedRecord ? [fixedRecord] : [...(room.state.status !== 'waiting' ? [{ ...room, id: room.matchId }] : []), ...older];
  const record = games.find((game) => game.id === selectedId) || games[0];
  const source = fixedRecord || room;
  function download() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...record }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `点雀-${record.code}-${record.id}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <Sheet title="对战记录" close={close} wide><div className="record-summary"><span>牌桌 {source.code}<small>{new Date(record?.endedAt || source.createdAt).toLocaleString('zh-CN')}</small></span><Button icon={Download} disabled={!record} onClick={download}>导出</Button></div>
    {error && <p role="alert" className="warning-text">{error}<button className="text-button" onClick={() => load(older.length)}>重试</button></p>}
    {games.length > 1 && <label className="record-game-picker">对战场次<select value={record.id} onChange={(e) => setSelectedId(e.target.value)}>{games.map((game) => <option key={game.id} value={game.id}>{game.state.status === 'ended' ? new Date(game.endedAt || game.events.at(-1)?.at).toLocaleString('zh-CN') : game.state.status === 'settling' ? '本场 · 结算中' : '本场 · 进行中'}</option>)}</select></label>}
    {more && <button className="text-button" disabled={loading} onClick={() => load(older.length)}>读取更早对局</button>}
    {record ? <><div className="standing-list">{[...record.players].sort((a, b) => record.state.scores[b.seat] - record.state.scores[a.seat] || a.seat - b.seat).map((p, i) => <div key={p.id}><span className="rank">{i + 1}</span><Avatar player={p} /><span>{p.name}</span><strong>{fmt(record.state.scores[p.seat])}</strong></div>)}</div>{record.state.pot > 0 && <p className="field-help">台面供托：{record.state.pot} 根，{fmt(record.state.pot * 1000)} 点。未分配供托保留在记录中。</p>}<h3 className="records-heading">点数流水</h3><div className="event-list">{[...record.events].reverse().map((event) => <EventRow key={event.id} event={event} room={record} />)}</div></> : <div className="empty"><p>暂无对战记录</p></div>}
  </Sheet>;
}

function RoomConfigSheet({ room, act, busy, close }) {
  const [points, setPoints] = useState(room.config.startPoints);
  const [length, setLength] = useState(room.config.length);
  const [count, setCount] = useState(room.config.playerCount);
  const [revision] = useState(room.revision);
  const stale = room.revision !== revision;
  async function submit(event) {
    event.preventDefault();
    if (await act({ type: 'configure', startPoints: Number(points), length, playerCount: count, revision })) close();
  }
  return <Sheet title="房间设置" close={close}><form className="settings-form" onSubmit={submit}>
    <RoomRulesFields points={points} setPoints={setPoints} length={length} setLength={setLength} count={count} setCount={setCount} seated={room.players.length} />
    {stale && <p role="alert" className="warning-text">房间已更新，请重新打开设置。</p>}
    <Button className="primary full" icon={Check} loading={busy} disabled={busy || stale}>保存设置</Button>
  </form></Sheet>;
}

function RoundSettingsSheet({ room, act, busy, close }) {
  const count = room.config.playerCount;
  const [wind, setWind] = useState(Math.floor(room.state.hand / count) % 4);
  const [hand, setHand] = useState(room.state.hand % count);
  const [honba, setHonba] = useState(room.state.honba);
  const [pot, setPot] = useState(room.state.pot);
  const [scores, setScores] = useState([...room.state.scores]);
  const [revision] = useState(room.revision);
  const stale = room.revision !== revision;
  async function submit(event) {
    event.preventDefault();
    if (await act({ type: 'adjust', hand: wind * count + hand, honba: Number(honba), pot: Number(pot), scores: scores.map(Number), revision })) close();
  }
  return <Sheet title="修改当前场况" close={close}><form className="settings-form" onSubmit={submit}>
    <div className="round-settings-grid"><label>场风<select value={wind} onChange={(e) => setWind(Number(e.target.value))}>{WINDS.map((name, index) => <option key={name} value={index}>{name}风场</option>)}</select></label><label>局数<select value={hand} onChange={(e) => setHand(Number(e.target.value))}>{Array.from({ length: count }, (_, index) => <option key={index} value={index}>第 {index + 1} 局</option>)}</select></label><label>本场<input type="number" inputMode="numeric" min="0" max="99" step="1" required value={honba} onChange={(e) => setHonba(e.target.value)} /></label><label>供托<input type="number" inputMode="numeric" min="0" max="99" step="1" required value={pot} onChange={(e) => setPot(e.target.value)} /></label></div>
    <div className="round-score-inputs">{room.players.map((player) => <label key={player.id}>{player.name}的点数<input type="number" inputMode="text" min="-1000000" max="1000000" step="100" required value={scores[player.seat]} onChange={(e) => setScores(scores.map((score, seat) => seat === player.seat ? e.target.value : score))} /></label>)}</div>
    <p className="field-help">修改会同步全桌并记入流水，可撤销。改变局数时清除本局立直标记。</p>
    {stale && <p role="alert" className="warning-text">场况已更新，请重新打开设置。</p>}
    <Button className="primary full" icon={Check} loading={busy} disabled={busy || stale}>保存场况</Button>
  </form></Sheet>;
}

function Settlement({ room, me, act, busy, edit, records, undo, redo }) {
  const { scores, potWinner } = room.settlement;
  const host = me.id === room.hostId;
  const ranking = [...room.players].sort((a, b) => scores[b.seat] - scores[a.seat] || a.seat - b.seat);
  return <section className="settlement-page">
    <h1>对战结算</h1>
    {potWinner !== null ? <p className="settlement-pot">供托 {room.state.pot} 根 · {fmt(room.state.pot * 1000)} 点 → {room.players[potWinner].name}<small>已计入下方分数；同分按座次排序。</small></p> : <p className="settlement-pot">{room.label} · {room.state.honba} 本场</p>}
    <div className="standing-list settlement-standings">{ranking.map((player, index) => <div key={player.id}><span className="rank">{index + 1}</span><Avatar player={player} /><span className="settlement-player">{player.name}{player.id === room.hostId && <span className="host-badge">房主</span>}{player.id === me.id && <small>你</small>}</span><strong>{fmt(scores[player.seat])}</strong></div>)}</div>
    {host ? <div className="settlement-actions"><Button className="full" disabled={busy} onClick={edit}>修改分数</Button><Button className="primary full" loading={busy} disabled={busy} icon={Check} onClick={() => act({ type: 'confirm-end' })}>确认结算并返回大厅</Button></div> : <p className="settlement-wait" role="status">等待房主确认结算</p>}
    <div className="waiting-tools"><button className="text-button" onClick={records}><History size={17} />对战记录</button>{host && <><button className="text-button" disabled={busy || !room.canUndo} onClick={undo}><Undo2 size={17} />撤销上一步</button>{room.canRedo && <button className="text-button" disabled={busy} onClick={redo}><Redo2 size={17} />重做上一步</button>}</>}</div>
  </section>;
}

function SettlementScoresSheet({ room, act, busy, close }) {
  const [scores, setScores] = useState([...room.state.scores]);
  const [revision] = useState(room.revision);
  const stale = room.revision !== revision;
  async function submit(event) {
    event.preventDefault();
    if (await act({ type: 'settlement-scores', scores: scores.map(Number), revision })) close();
  }
  return <Sheet title="修改结算分数" close={close}><form onSubmit={submit}>
    <p className="field-help">填写分配供托前的分数。保存后，供托自动计入第一名。</p>
    <div className="round-score-inputs">{room.players.map((player) => <label key={player.id}>{player.name}的点数<input type="number" inputMode="text" min="-1000000" max="1000000" step="100" required value={scores[player.seat]} onChange={(e) => setScores(scores.map((score, seat) => seat === player.seat ? e.target.value : score))} /></label>)}</div>
    {stale && <p className="warning-text" role="alert">结算已更新，请重新打开修改分数。</p>}
    <Button className="primary full" disabled={busy || stale} loading={busy} icon={Check}>保存分数</Button>
  </form></Sheet>;
}

function Table({ room, me, act, busy, connected, notify, home }) {
  const [sheet, setSheet] = useState(null);
  const [target, setTarget] = useState(null);
  const current = room.state;
  const count = room.config.playerCount;
  const pendingId = room.pending?.id;
  const locked = busy || !connected;
  const pending = !!room.pending || Object.keys(room.drawVotes).length > 0;
  const pay = (seat) => { if (!connected) return notify('连接恢复后再操作'); setTarget(seat); setSheet('pay'); };
  const close = () => setSheet((open) => open === sheet ? null : open);
  const [wake, setWake] = useState(false);
  const wakeRef = useRef(null);
  useEffect(() => {
    let live = true;
    async function acquire() {
      if (!wake || document.visibilityState !== 'visible') return;
      try { const lock = await navigator.wakeLock.request('screen'); if (!live) { await lock.release(); return; } wakeRef.current = lock; } catch { if (live) { setWake(false); notify('当前设备无法保持亮屏，请在系统设置中调整'); } }
    }
    if (wake) acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => { live = false; document.removeEventListener('visibilitychange', acquire); wakeRef.current?.release(); wakeRef.current = null; };
  }, [wake]);
  useEffect(() => {
    setSheet((open) => pendingId ? 'pending' : open === 'pending' ? null : open);
  }, [pendingId]);
  useEffect(() => {
    setSheet((open) => current.status !== 'playing' || ['pay', 'draw', 'riichi'].includes(open) ? null : open);
  }, [current.roundId, current.status]);
  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); else notify('可将网页添加到主屏幕，以全屏使用'); } catch { notify('请将网页添加到主屏幕，以全屏使用'); }
  }
  return <main className="table-page page"><header className="app-header"><Logo /><div className="header-room">{['waiting', 'ended'].includes(current.status) && <button className="text-button" disabled={busy} onClick={home} aria-label="退出房间" title="退出房间"><Home size={17} /></button>}<button className="text-button" onClick={() => setSheet('share')}>房间 {room.code}<Share2 size={15} /></button><span className={`network ${connected ? 'connected' : ''}`}>{connected ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{connected ? '已同步' : '重连中'}</span></span></div></header>
    {!connected && <div role="status" className="offline-banner">连接中断，重连前暂停操作。</div>}
    {current.status === 'settling' ? <Settlement room={room} me={me} act={act} busy={locked} edit={() => setSheet('settlement-scores')} records={() => setSheet('records')} undo={() => setSheet('undo')} redo={() => setSheet('redo')} /> : current.status !== 'playing' ? <WaitingRoom room={room} me={me} act={act} busy={locked} share={() => setSheet('share')} records={() => setSheet('records')} configure={() => setSheet('configure')} /> : <>
      <div className="table-toolbar"><div><span>{count === 3 ? '三人' : '四人'}{room.config.length === 'south' ? '南' : '东'}</span>{me.id === room.hostId && <button className="text-button end-game-button" disabled={locked || pending} onClick={() => act({ type: 'end' })}>结束对战</button>}</div><div className="history-buttons as-glass as-glass-group" data-adapt="off"><button className="as-item" aria-label="撤销上一步" title="撤销上一步" disabled={locked || !room.canUndo || pending} onClick={() => setSheet('undo')}><Undo2 size={18} /><span>撤销</span></button><button className="as-item" aria-label="重做上一步" title="重做上一步" disabled={locked || !room.canRedo || pending} onClick={() => setSheet('redo')}><Redo2 size={18} /><span>重做</span></button></div></div>
      {(room.pending || Object.keys(room.drawVotes).length > 0) && <button className="pending-alert" onClick={() => setSheet(room.pending ? 'pending' : 'draw')}><span><ArrowDownLeft size={17} />{room.pending ? '待确认支付' : `流局确认 ${Object.keys(room.drawVotes).length}/${count}`}</span><span>查看<ChevronRight size={16} /></span></button>}
      <div className="play-layout"><div className="main-console"><div className="round-strip"><div className="round-title"><span>{WINDS[Math.floor(current.hand / count) % 4]}</span><strong>{current.hand % count + 1}<small>局</small></strong></div><div className="round-counter"><span>本场</span><strong>{current.honba}<small>本</small></strong></div><div className="round-counter"><span><RiichiStick small />供托</span><strong>{current.pot}<small>根</small></strong></div></div>
        <div className={`mahjong-table table-${count}`}>{count === 4 && <PlayerCard player={room.players[(me.seat + 2) % count]} room={room} me={me} position="top" onPay={pay} />}<PlayerCard player={room.players[(me.seat + count - 1) % count]} room={room} me={me} position="left" onPay={pay} /><PlayerCard player={room.players[(me.seat + 1) % count]} room={room} me={me} position="right" onPay={pay} /></div>
        <section className={`self-display ${me.seat === room.dealer ? 'is-dealer' : ''} ${current.riichi[me.seat] ? 'self-riichi' : ''}`}><div className="self-top"><span className={`wind-chip ${me.seat === room.dealer ? 'dealer' : ''}`}>{WINDS[(me.seat - room.dealer + count) % count]}</span><span className="self-name">{me.name}{me.id === room.hostId && <span className="host-badge">房主</span>}<small>我</small></span>{me.seat === room.config.startDealer && <span className="start-marker"><Flag size={12} />起庄</span>}{current.riichi[me.seat] && <span className="riichi-label"><RiichiStick small />立直</span>}<span className="self-rank">{room.players.filter((p) => current.scores[p.seat] > current.scores[me.seat]).length + 1} 位</span></div><div className="self-score"><DigitDisplay value={current.scores[me.seat]} /><span className="self-unit">点</span></div></section>
        <div className="table-actions"><button className="riichi-button" disabled={locked || pending || current.riichi[me.seat] || current.scores[me.seat] < 1000} onClick={() => setSheet('riichi')}><RiichiStick /><span>{current.riichi[me.seat] ? '已立直' : '立直'}</span><small>1,000 点</small></button><Button disabled={locked || pending} onClick={() => pay(me.seat)} icon={ArrowDownLeft}>自摸</Button><Button disabled={locked || !!room.pending} onClick={() => setSheet('draw')} icon={RotateCcw}>流局{Object.keys(room.drawVotes).length ? <small>{Object.keys(room.drawVotes).length}/{count}</small> : null}</Button></div>
      </div></div>
      <nav className="bottom-nav as-glass as-glass-group" data-adapt="off" aria-label="牌桌工具"><button className="as-item" onClick={() => setSheet('records')}><History size={19} /><span>对战记录</span></button><button className="as-item" onClick={fullscreen}><Expand size={18} /><span>全屏显示</span></button><button className="as-item" onClick={() => setSheet('settings')}><Info size={18} /><span>牌桌设置</span></button></nav>
    </>}
    <AnimatePresence mode="wait">{sheet === 'share' && <ShareSheet key="share" room={room} close={close} notify={notify} />}{sheet === 'pay' && <PaymentSheet key="pay" room={room} me={me} target={target} close={close} act={act} busy={locked} />}{sheet === 'draw' && <DrawSheet key="draw" room={room} me={me} close={close} act={act} busy={locked} />}{sheet === 'records' && <Records key="records" room={room} close={close} />}
    {sheet === 'pending' && room.pending && <Sheet key="pending" title={room.pending.mode === 'tsumo' ? '确认自摸结算' : room.pending.winners.length > 1 ? '确认多家和牌' : '确认点数交付'} close={close}><PendingPanel room={room} me={me} act={act} busy={locked} /></Sheet>}
    {['riichi', 'undo', 'redo'].includes(sheet) && <Sheet key={sheet} title={{ riichi: '确认立直', undo: '撤销上一步', redo: '重做上一步' }[sheet]} close={close}><p className="confirm-copy">{{ riichi: '扣除 1,000 点，计入供托。', undo: '撤销全桌上一步，恢复点数和局况。', redo: '恢复全桌上一步撤销的操作。' }[sheet]}</p><Button className="primary full" loading={busy} disabled={locked} icon={Check} onClick={async () => { if (await act({ type: sheet })) close(); }}>确认{sheet === 'riichi' ? '立直' : sheet === 'undo' ? '撤销' : '重做'}</Button></Sheet>}
    {sheet === 'configure' && me.id === room.hostId && <RoomConfigSheet key="configure" room={room} act={act} busy={locked} close={close} />}
    {sheet === 'adjust' && me.id === room.hostId && <RoundSettingsSheet key="adjust" room={room} act={act} busy={locked || pending} close={close} />}
    {sheet === 'settlement-scores' && me.id === room.hostId && current.status === 'settling' && <SettlementScoresSheet key="settlement-scores" room={room} act={act} busy={locked} close={close} />}
    {sheet === 'settings' && <Sheet key="settings" title="牌桌设置" close={close}>{me.id === room.hostId && <Button className="full" disabled={locked || pending} onClick={() => setSheet('adjust')}>修改当前场况<ChevronRight size={17} /></Button>}{pending && me.id === room.hostId && <p className="field-help">先完成或取消当前结算，再修改场况。</p>}<div className="settings-row"><span>保持屏幕常亮<small>{'wakeLock' in navigator ? '前台显示时生效' : '需要 HTTPS 与支持的浏览器'}</small></span><Toggle label="保持屏幕常亮" checked={wake} disabled={!('wakeLock' in navigator)} onChange={setWake} /></div><details className="rules"><summary>规则与使用说明</summary><p>庄家和牌或流局听牌连庄。本场随连庄或流局增加，子家和牌后清零。多家和牌的供托交给放铳者下家方向最近的和牌者。</p><p>三人模式采用自摸损，两家按原档支付，本场每家加 100 点；流局罚符共 2,000 点。</p><p>不自动判断终场、飞人或止庄；对战结束后由房主点击结束。对局中不能离开牌桌或加入其他房间。</p><p>登录同一账号即可恢复原座位。结束并确认结算后，成绩会保存到个人对局记录。</p><p>安装：在 HTTPS 地址打开，Android 使用浏览器“安装”，iPhone 使用 Safari“分享 → 添加到主屏幕”。局域网 HTTP 可直接记分。</p></details></Sheet>}</AnimatePresence>
  </main>;
}

function App() {
  useEffect(() => { window.LiquidGlass.init(); }, []);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [room, setRoom] = useState(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountRecord, setAccountRecord] = useState(null);
  const inFlight = useRef(false);
  const notify = (text) => setMessage(text);
  function receive(next) { setRoom((previous) => !previous || previous.code !== next.code || previous.revision > next.revision ? previous : next); }
  function enter(next) { setRoom(next); setConnected(false); history.replaceState(null, '', `/?room=${next.code}`); }
  function left() { setRoom(null); setConnected(false); history.replaceState(null, '', '/'); }
  function unauthorized() { setUser(null); setRoom(null); setAccountOpen(false); setAccountRecord(null); notify('请重新登录'); }
  useEffect(() => { window.addEventListener('dianque:unauthorized', unauthorized); return () => window.removeEventListener('dianque:unauthorized', unauthorized); }, []);
  async function restore(session) {
    if (!session.user) { setUser(null); return; }
    const code = session.activeRoom || initialCode || session.lastRoom;
    if (code) {
      try { enter(await api(`/rooms/${code}`)); }
      catch (error) { if (session.activeRoom || ![403, 404].includes(error.status)) throw error; }
    }
    setUser(session.user);
  }
  useEffect(() => {
    api('/session').then(restore).then(() => setReady(true)).catch((error) => setConnectionError(error.message));
  }, []);
  useEffect(() => { if (!message) return; const id = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(id); }, [message]);
  useRoom(user && room?.code, { state: receive, connected: setConnected, unauthorized, left });
  async function home() {
    if (!room || inFlight.current) return;
    if (['playing', 'settling'].includes(room?.state.status)) { notify('请先结束当前对局'); return; }
    inFlight.current = true; setBusy(true);
    try {
      await api(`/rooms/${room.code}/leave`, { method: 'POST' });
      left();
    } catch (error) { notify(error.message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function logout() {
    try { await api('/logout', { method: 'POST' }); setUser(null); setRoom(null); setAccountOpen(false); setAccountRecord(null); history.replaceState(null, '', '/'); }
    catch (error) { notify(error.message); }
  }
  async function act(action) {
    if (!connected || inFlight.current) { if (!inFlight.current) notify('连接恢复后再操作'); return false; }
    inFlight.current = true; setBusy(true);
    try {
      const payload = { revision: room.revision, roundId: room.state.roundId, ...action, requestId: crypto.getRandomValues(new Uint32Array(4)).join('-') };
      receive(await api(`/rooms/${room.code}/action`, { method: 'POST', body: payload }));
      if (action.type === 'undo') notify('已撤销，全桌点数与局数已同步');
      if (action.type === 'redo') notify('已重做，全桌状态已同步');
      return true;
    } catch (error) { if (error.status === 401) unauthorized(); else notify(error.message); return false; }
    finally { setBusy(false); inFlight.current = false; }
  }
  const me = room?.players.find((p) => p.id === user?.id);
  if (!ready) return <main className="connecting"><Logo /><LoaderCircle className="spin" size={28} /><p>{connectionError || '正在连接…'}</p>{connectionError && <Button onClick={() => location.reload()}>重试</Button>}</main>;
  return <NoticeContext.Provider value={message}><AnimatePresence mode="wait" initial={false}><PageTransition key={!user ? 'auth' : !room ? 'lobby' : `room-${room.code}-${room.state.status === 'ended' ? 'waiting' : room.state.status}`}>
    {!user ? <main className="lobby page"><header className="app-header"><Logo /></header><div className="lobby-layout"><AuthForm onAuth={restore} /></div></main> : room && me ? <Table room={room} me={me} act={act} busy={busy} connected={connected} notify={notify} home={home} /> : <Lobby user={user} onEnter={enter} notify={notify} openAccount={() => setAccountOpen(true)} />}
    </PageTransition></AnimatePresence>
    <AnimatePresence>{accountOpen && user && <Sheet key="account" title="我的对局" close={() => setAccountOpen(false)} wide><AccountHistory user={user} openRecord={setAccountRecord} logout={logout} /></Sheet>}{accountRecord && <Records key="account-record" record={accountRecord} close={() => setAccountRecord(null)} />}</AnimatePresence>
    <AnimatePresence>{message && <motion.div key={message} className="toast as-glass as-glass-large" data-adapt="off" data-lens="off" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>{message}<button aria-label="关闭提示" onClick={() => setMessage('')}><X size={16} /></button></motion.div>}</AnimatePresence></NoticeContext.Provider>;
}

createRoot(document.getElementById('root')).render(<MotionConfig reducedMotion="user"><App /></MotionConfig>);
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => {});
