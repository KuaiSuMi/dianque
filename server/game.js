import { randomInt, randomUUID } from 'node:crypto';

export const WINDS = ['东', '南', '西', '北'];
const clone = (value) => structuredClone(value);
export class GameError extends Error {}
export function check(condition, message) {
  if (!condition) throw new GameError(message);
}
export function dealerOf(room) {
  return (room.config.startDealer + stateOf(room).hand) % stateOf(room).scores.length;
}
export function stateOf(room) { return room.history[room.cursor].state; }
export function handLabel(state) {
  const count = state.scores.length;
  return `${WINDS[Math.floor(state.hand / count) % 4]} ${state.hand % count + 1} 局`;
}

function initialState(config, count) {
  return { status: 'waiting', hand: 0, roundId: randomUUID(), honba: 0, pot: 0, scores: Array(count).fill(config.startPoints), riichi: Array(count).fill(false) };
}

function checkConfig({ startPoints, length, tsumoConfirm = false, autoDice = false }, count) {
  check([3, 4].includes(count), '请选择三人或四人对局');
  check(Number.isSafeInteger(startPoints) && startPoints >= 1000 && startPoints <= 1000000 && startPoints % 100 === 0, '起始点数须为 1000～1000000 之间的整百数');
  check(['east', 'south'].includes(length), '请选择东风场或南风场');
  check(typeof tsumoConfirm === 'boolean' && typeof autoDice === 'boolean', '房间开关须为布尔值');
}

function checkScores(scores, count) {
  check(Array.isArray(scores) && scores.length === count && scores.every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 1000000 && n % 100 === 0), '点数须为 -1000000～1000000 之间的整百数');
}

function finalResult(state) {
  const scores = [...state.scores];
  const first = scores.reduce((best, score, seat) => score > scores[best] ? seat : best, 0);
  scores[first] += state.pot * 1000;
  return { scores, potWinner: state.pot > 0 ? first : null };
}

export function newRoom(code, player, config, count = 4) {
  config = { tsumoConfirm: false, autoDice: false, ...config };
  checkConfig(config, count);
  check(Number.isInteger(config.startDealer) && config.startDealer >= 0 && config.startDealer < count, '起庄位置无效');
  const state = initialState(config, count);
  return { code, matchId: randomUUID(), createdAt: new Date().toISOString(), hostId: player.id, players: [player], config, revision: 0, cursor: 0, history: [{ state, entry: null }], pending: null, drawVotes: {}, receipts: [] };
}

export function joinRoom(room, player) {
  check(['waiting', 'ended'].includes(stateOf(room).status), '牌局已经开始，只有已入座账号可重连');
  check(room.players.length < stateOf(room).scores.length, '房间已满');
  prepareNextMatch(room);
  player.seat = Array.from({ length: stateOf(room).scores.length }, (_, seat) => seat).find((seat) => !room.players.some((p) => p.seat === seat));
  room.players.push(player);
  room.players.sort((a, b) => a.seat - b.seat);
  if (!room.hostId) room.hostId = player.id;
  room.revision++;
}

export function leaveRoom(room, actorId) {
  check(['waiting', 'ended'].includes(stateOf(room).status), '请先结束并确认当前对局');
  const index = room.players.findIndex((p) => p.id === actorId);
  check(index >= 0, '你不在这个房间');
  prepareNextMatch(room);
  room.players.splice(index, 1);
  if (room.hostId === actorId) room.hostId = room.players[0]?.id ?? null;
  room.revision++;
}

function commit(room, state, entry) {
  if (['start', 'win', 'draw'].includes(entry.type)) {
    if (room.config.autoDice) state.dice = { id: randomUUID(), values: [randomInt(1, 7), randomInt(1, 7)] };
    else delete state.dice;
  }
  room.history = room.history.slice(0, room.cursor + 1);
  room.history.push({ state, entry: { id: randomUUID(), at: new Date().toISOString(), ...entry } });
  room.cursor++;
  room.pending = null;
  room.drawVotes = {};
}

export function prepareNextMatch(room) {
  if (stateOf(room).status !== 'ended') return;
  const { state, players, events, config } = publicRoom(room);
  const match = { id: room.matchId, code: room.code, endedAt: room.history[room.cursor].entry.at, state, players: players.map(({ id, name, seat }) => ({ id, name, seat })), events, config };
  room.matches = [...(room.matches || []), clone(match)];
  room.matchId = randomUUID();
  room.history = [{ state: initialState(room.config, state.scores.length), entry: null }];
  room.cursor = 0;
  room.pending = null;
  room.drawVotes = {};
}

function advance(state, keepDealer, isDraw) {
  if (!keepDealer) state.hand++;
  state.honba = isDraw || keepDealer ? state.honba + 1 : 0;
  state.riichi.fill(false);
  state.roundId = randomUUID();
}

function settle(room) {
  const pending = room.pending;
  const state = clone(stateOf(room));
  const before = [...state.scores];
  for (const transfer of pending.transfers) {
    state.scores[transfer.from] -= transfer.amount;
    state.scores[transfer.to] += transfer.amount;
  }
  const winners = [...new Set(pending.transfers.map((t) => t.to))];
  const payer = pending.transfers[0].from;
  const count = state.scores.length;
  // 双响、三响的供托归放铳者下家方向最近的和牌者。
  const potWinner = pending.mode === 'tsumo' ? winners[0] : winners.toSorted((a, b) => ((a - payer + count) % count) - ((b - payer + count) % count))[0];
  const entry = { type: 'win', label: handLabel(state), honba: state.honba, mode: pending.mode, transfers: pending.transfers, pot: state.pot, potWinner, winners, before };
  state.scores[potWinner] += state.pot * 1000;
  state.pot = 0;
  advance(state, winners.includes(dealerOf(room)), false);
  entry.after = [...state.scores];
  commit(room, state, entry);
}

export function applyAction(room, actorId, action) {
  const player = room.players.find((p) => p.id === actorId);
  check(player, '你不在这个房间');
  check(action && typeof action === 'object', '操作格式错误');
  check(typeof action.requestId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(action.requestId), '操作编号无效');
  const receipt = `${actorId}:${action.requestId}`;
  if (room.receipts.includes(receipt)) return false;
  let state = clone(stateOf(room));
  const count = state.scores.length;
  const seat = player.seat;
  const concurrent = ['approve', 'receive', 'cancel', 'draw'].includes(action.type);
  if (concurrent) check(action.roundId === state.roundId, '局数已改变，请查看最新牌局');
  else check(action.revision === room.revision, '牌局有更新，请查看最新状态后重试');

  if (action.type === 'configure') {
    check(player.id === room.hostId, '只有房主可以修改房间规则');
    check(['waiting', 'ended'].includes(state.status), '只能在房间大厅修改规则');
    checkConfig(action, action.playerCount);
    check(room.players.length <= action.playerCount, '已有四人入座，不能改为三人模式');
    prepareNextMatch(room);
    room.config = { startPoints: action.startPoints, length: action.length, startDealer: room.config.startDealer % action.playerCount, tsumoConfirm: action.tsumoConfirm ?? false, autoDice: action.autoDice ?? false };
    for (const p of room.players.filter((p) => p.seat >= action.playerCount)) {
      p.seat = Array.from({ length: action.playerCount }, (_, seat) => seat).find((seat) => !room.players.some((other) => other.seat === seat));
    }
    room.players.sort((a, b) => a.seat - b.seat);
    room.history = [{ state: initialState(room.config, action.playerCount), entry: null }];
    room.cursor = 0;
  } else if (action.type === 'table-settings') {
    check(player.id === room.hostId, '只有房主可以修改牌桌设置');
    check(state.status === 'playing', '请在对局中修改牌桌设置');
    check(!room.pending && Object.keys(room.drawVotes).length === 0, '请先完成或取消当前结算，再修改牌桌设置');
    check(typeof action.tsumoConfirm === 'boolean' && typeof action.autoDice === 'boolean', '确认和骰子开关须为布尔值');
    room.config.tsumoConfirm = action.tsumoConfirm;
    room.config.autoDice = action.autoDice;
  } else if (action.type === 'start') {
    check(player.id === room.hostId, '只有房主可以开局');
    check(['waiting', 'ended'].includes(state.status) && room.players.length === count, `${count === 3 ? '三' : '四'}人入座后才能开局`);
    prepareNextMatch(room);
    state = clone(stateOf(room));
    state.status = 'playing';
    commit(room, state, { type: 'start', label: '对局开始' });
  } else if (action.type === 'seat') {
    check(['waiting', 'ended'].includes(state.status), '只能在房间大厅换座');
    check(Number.isInteger(action.seat) && action.seat >= 0 && action.seat < count && action.seat !== seat, '请选择其他座位');
    prepareNextMatch(room);
    const other = room.players.find((p) => p.seat === action.seat);
    if (other) other.seat = seat;
    player.seat = action.seat;
    room.players.sort((a, b) => a.seat - b.seat);
  } else if (action.type === 'shuffle') {
    check(player.id === room.hostId, '只有房主可以随机选座');
    check(['waiting', 'ended'].includes(state.status), '只能在房间大厅随机选座');
    check(room.players.length === count, `${count === 3 ? '三' : '四'}人入座后才能随机选座`);
    prepareNextMatch(room);
    for (let i = room.players.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [room.players[i], room.players[j]] = [room.players[j], room.players[i]];
    }
    room.players.forEach((p, index) => { p.seat = index; });
  } else if (action.type === 'undo' || action.type === 'redo') {
    check(state.status !== 'ended', '结算已确认，不能撤销或重做');
    check(state.status !== 'waiting', '牌局还未开始');
    check(!room.pending && Object.keys(room.drawVotes).length === 0, '请先取消待确认的结算或流局申请');
    const target = room.history[room.cursor + (action.type === 'undo' ? -1 : 1)]?.state;
    if ([state.status, target?.status].includes('settling')) check(player.id === room.hostId, '只有房主可以撤销或重做对战结算');
    if (action.type === 'undo') {
      check(room.cursor > 1, '没有可撤销的操作');
      room.cursor--;
    } else {
      check(room.cursor < room.history.length - 1, '没有可重做的操作');
      room.cursor++;
    }
    stateOf(room).roundId = randomUUID();
  } else if (action.type === 'settlement-scores' || action.type === 'confirm-end') {
    check(player.id === room.hostId, '只有房主可以修改或确认对战结算');
    check(state.status === 'settling', '当前不在对战结算中');
    if (action.type === 'settlement-scores') {
      checkScores(action.scores, count);
      const before = [...state.scores];
      state.scores = [...action.scores];
      commit(room, state, { type: 'settlement-scores', label: '结算分数调整', before, after: [...state.scores] });
    } else {
      const { scores, potWinner } = finalResult(state);
      const before = [...state.scores], pot = state.pot;
      Object.assign(state, { status: 'ended', scores, pot: 0, roundId: randomUUID() });
      commit(room, state, { type: 'end', label: '对战结束', before, after: [...scores], pot, potWinner });
    }
  } else {
    check(state.status === 'playing', '当前不在对局中');
    if (action.type === 'adjust') {
      check(player.id === room.hostId, '只有房主可以修改当前场况');
      check(!room.pending && Object.keys(room.drawVotes).length === 0, '请先完成或取消当前结算');
      check(Number.isInteger(action.hand) && action.hand >= 0 && action.hand < count * 4, '局数无效');
      check(Number.isInteger(action.honba) && action.honba >= 0 && action.honba <= 99, '本场须为 0～99');
      check(Number.isInteger(action.pot) && action.pot >= 0 && action.pot <= 99, '供托须为 0～99');
      checkScores(action.scores, count);
      const before = { hand: state.hand, honba: state.honba, pot: state.pot, scores: [...state.scores] };
      if (state.hand !== action.hand) state.riichi.fill(false);
      Object.assign(state, { hand: action.hand, honba: action.honba, pot: action.pot, scores: [...action.scores], roundId: randomUUID() });
      commit(room, state, { type: 'adjust', label: '场况调整', before, after: { hand: state.hand, honba: state.honba, pot: state.pot, scores: [...state.scores] } });
    } else if (action.type === 'riichi') {
      check(!room.pending && Object.keys(room.drawVotes).length === 0, '请先完成当前结算');
      check(!state.riichi[seat], '本局已经立直');
      check(state.scores[seat] >= 1000, '点数不足 1000，无法立直');
      state.scores[seat] -= 1000;
      state.pot++;
      state.riichi[seat] = true;
      commit(room, state, { type: 'riichi', seat, label: handLabel(state), honba: state.honba });
    } else if (action.type === 'propose') {
      check(!room.pending && Object.keys(room.drawVotes).length === 0, '已有待确认的结算');
      check(['ron', 'tsumo'].includes(action.mode), '和牌类型无效');
      check(Array.isArray(action.transfers) && action.transfers.length >= 1 && action.transfers.length < count, '付款数量无效');
      const transfers = action.transfers.map((t) => {
        check(t && Number.isInteger(t.from) && Number.isInteger(t.to) && t.from >= 0 && t.from < count && t.to >= 0 && t.to < count && t.from !== t.to, '付款座位无效');
        check(Number.isSafeInteger(t.amount) && t.amount > 0 && t.amount <= 1000000 && t.amount % 100 === 0, '点数须为 100 的倍数，且在 100～1000000 之间');
        return { from: t.from, to: t.to, amount: t.amount };
      });
      const payers = [...new Set(transfers.map((t) => t.from))];
      const winners = [...new Set(transfers.map((t) => t.to))];
      if (action.mode === 'ron') check(payers.length === 1 && payers[0] === seat && winners.length === transfers.length, '荣和须由放铳者向不同的和牌者支付');
      else check(transfers.length === count - 1 && payers.length === count - 1 && winners.length === 1 && (winners[0] === seat || payers.includes(seat)), `自摸必须包含${count === 3 ? '两' : '三'}家向同一人的支付`);
      room.pending = { id: randomUUID(), mode: action.mode, createdBy: seat, transfers, payers, winners, approved: payers.includes(seat) ? [seat] : [], received: [] };
    } else if (action.type === 'approve' || action.type === 'receive' || action.type === 'cancel') {
      const pending = room.pending;
      check(pending && pending.id === action.pendingId, '这笔结算已完成或已取消');
      const needsApproval = pending.mode !== 'tsumo' || room.config.tsumoConfirm;
      if (action.type === 'cancel') {
        check((needsApproval && pending.payers.includes(seat)) || pending.winners.includes(seat), '只有确认方可以取消这笔结算');
        room.pending = null;
      } else if (action.type === 'approve') {
        check(needsApproval, '本房间自摸仅由自摸家确认');
        check(pending.payers.includes(seat), '只有付款方可以确认付款');
        check(!pending.approved.includes(seat), '你已确认付款');
        pending.approved.push(seat);
      } else {
        check(!needsApproval || pending.approved.length === pending.payers.length, '请等待所有付款方确认');
        check(pending.winners.includes(seat), '只有收款方可以确认收款');
        check(!pending.received.includes(seat), '你已确认收款');
        pending.received.push(seat);
        if (pending.received.length === pending.winners.length) settle(room);
      }
    } else if (action.type === 'draw') {
      check(!room.pending, '请先完成或取消点数支付');
      check(action.tenpai === null || typeof action.tenpai === 'boolean', '请选择听牌或未听');
      check(action.tenpai !== false || !state.riichi[seat], '立直玩家应选择听牌；若误按立直，请先撤销');
      if (action.tenpai === null) delete room.drawVotes[seat];
      else room.drawVotes[seat] = action.tenpai;
      if (Object.keys(room.drawVotes).length === count) {
        const ready = Object.entries(room.drawVotes).filter(([, value]) => value).map(([key]) => Number(key));
        if (ready.length > 0 && ready.length < count) {
          const pool = (count - 1) * 1000;
          for (let i = 0; i < count; i++) state.scores[i] += ready.includes(i) ? pool / ready.length : -pool / (count - ready.length);
        }
        const entry = { type: 'draw', label: handLabel(state), honba: state.honba, ready, after: [...state.scores] };
        advance(state, ready.includes(dealerOf(room)), true);
        commit(room, state, entry);
      }
    } else if (action.type === 'end') {
      check(player.id === room.hostId, '只有房主可以结束对战');
      check(!room.pending && Object.keys(room.drawVotes).length === 0, '请先完成或取消当前结算');
      Object.assign(state, { status: 'settling', roundId: randomUUID() });
      commit(room, state, { type: 'settlement', label: '进入对战结算' });
    } else throw new GameError('未知操作');
  }
  room.revision++;
  room.receipts.push(receipt);
  room.receipts = room.receipts.slice(-200);
  return true;
}

export function publicRoom(room, online = []) {
  const state = stateOf(room);
  return {
    code: room.code, matchId: room.matchId, createdAt: room.createdAt, hostId: room.hostId, config: { ...room.config, playerCount: state.scores.length }, matches: room.matches || [],
    revision: room.revision, state, dealer: dealerOf(room), label: handLabel(state),
    settlement: state.status === 'settling' ? finalResult(state) : null,
    players: room.players.map(({ id, name, seat }) => ({ id, name, seat, online: online.includes(id) })),
    pending: room.pending, drawVotes: room.drawVotes,
    canUndo: state.status !== 'ended' && room.cursor > 1, canRedo: state.status !== 'ended' && room.cursor < room.history.length - 1,
    events: room.history.slice(1).map(({ entry }, i) => ({ ...entry, undone: i + 1 > room.cursor }))
  };
}
