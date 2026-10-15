import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, newRoom, joinRoom, leaveRoom, stateOf, dealerOf, publicRoom } from '../server/game.js';

let seq = 0;
function room(count = 4) {
  const r = newRoom('ABCD', { id: 'p0', name: '东家', seat: 0, tokenHash: 'private' }, { startPoints: 25000, startDealer: 0, length: 'south' }, count);
  for (let i = 1; i < count; i++) joinRoom(r, { id: `p${i}`, name: `玩家${i}`, tokenHash: 'private' });
  act(r, 0, { type: 'start' });
  return r;
}
function act(r, seat, action) {
  return applyAction(r, `p${seat}`, { requestId: `request-${++seq}`, revision: r.revision, roundId: stateOf(r).roundId, ...action });
}
function receive(r, seat) { act(r, seat, { type: 'receive', pendingId: r.pending.id }); }
function ron(r, from, to, amount) { act(r, from, { type: 'propose', mode: 'ron', transfers: [{ from, to, amount }] }); receive(r, to); }
function conserved(r) { assert.equal(stateOf(r).scores.reduce((a, b) => a + b) + stateOf(r).pot * 1000, 100000); }
function finish(r) { act(r, 0, { type: 'end' }); act(r, 0, { type: 'confirm-end' }); }

for (const count of [3, 4]) test(`${count} 人结算先预览供托，房主确认后给第一名且不可撤销`, () => {
  const r = room(count);
  act(r, 0, { type: 'riichi' });
  const before = structuredClone(stateOf(r));
  act(r, 0, { type: 'end' });
  assert.equal(stateOf(r).status, 'settling');
  assert.deepEqual(stateOf(r).scores, before.scores); assert.equal(stateOf(r).pot, 1);
  const preview = publicRoom(r).settlement;
  assert.equal(preview.potWinner, 1); assert.equal(preview.scores[1], 26000);
  assert.throws(() => act(r, 1, { type: 'confirm-end' }), /房主/);
  assert.throws(() => act(r, 1, { type: 'undo' }), /房主/);
  const confirm = { type: 'confirm-end', requestId: 'confirm-final-once', revision: r.revision };
  act(r, 0, confirm);
  assert.equal(stateOf(r).status, 'ended'); assert.equal(stateOf(r).pot, 0);
  assert.deepEqual(stateOf(r).scores, preview.scores);
  const ended = structuredClone(stateOf(r));
  assert.equal(act(r, 0, confirm), false); assert.deepEqual(stateOf(r), ended);
  assert.throws(() => act(r, 0, { type: 'confirm-end' }), /不在对战结算/);
  assert.equal(r.history.at(-1).entry.potWinner, 1); assert.equal(r.history.at(-1).entry.pot, 1);
  const confirmed = structuredClone(r);
  for (let i = 0; i < count; i++) for (const type of ['undo', 'redo']) assert.throws(() => act(r, i, { type }), /结算已确认/);
  assert.deepEqual(r, confirmed);
  assert.equal(publicRoom(r).canUndo, false); assert.equal(publicRoom(r).canRedo, false);
  assert.equal(stateOf(r).scores.reduce((sum, value) => sum + value), count * 25000);
});

test('结算修改分数后重新确定供托归属，校验权限、输入与过期版本', () => {
  const r = room(); act(r, 0, { type: 'riichi' }); act(r, 0, { type: 'end' });
  const oldRevision = r.revision, before = structuredClone(r);
  const scores = [31000, 23000, 23000, 22000];
  assert.throws(() => act(r, 1, { type: 'settlement-scores', scores }), /房主/);
  for (const invalid of [[25000], [1, 25000, 25000, 24999], [NaN, 0, 0, 0], [1000100, 0, 0, 0]]) {
    assert.throws(() => act(r, 0, { type: 'settlement-scores', scores: invalid }), /点数/); assert.deepEqual(r, before);
  }
  act(r, 0, { type: 'settlement-scores', scores });
  assert.equal(publicRoom(r).settlement.potWinner, 0);
  assert.deepEqual(publicRoom(r).settlement.scores, [32000, 23000, 23000, 22000]);
  assert.deepEqual(r.history.at(-1).entry.before, before.history[before.cursor].state.scores);
  assert.deepEqual(r.history.at(-1).entry.after, scores);
  assert.throws(() => act(r, 0, { type: 'confirm-end', revision: oldRevision }), /更新/);
  assert.throws(() => act(r, 0, { type: 'settlement-scores', scores, revision: oldRevision }), /更新/);
  act(r, 0, { type: 'confirm-end' }); assert.deepEqual(stateOf(r).scores, [32000, 23000, 23000, 22000]); conserved(r);
  act(r, 0, { type: 'start' }); assert.equal(r.matches[0].state.pot, 0);
  assert.deepEqual(r.matches[0].state.scores, [32000, 23000, 23000, 22000]);
});

test('结算期间禁止开局、改规则、支付和流局，房主可撤销回到对局', () => {
  const r = room(); act(r, 0, { type: 'end' });
  assert.equal(publicRoom(r).settlement.potWinner, null);
  for (const action of [{ type: 'start' }, { type: 'shuffle' }, { type: 'configure', playerCount: 4, startPoints: 25000, length: 'south' }, { type: 'riichi' }, { type: 'draw', tenpai: true }, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 1000 }] }]) assert.throws(() => act(r, 0, action));
  act(r, 0, { type: 'undo' }); assert.equal(stateOf(r).status, 'playing');
  assert.throws(() => act(r, 1, { type: 'redo' }), /房主/);
  assert.throws(() => act(r, 0, { type: 'settlement-scores', scores: [25000, 25000, 25000, 25000] }), /不在对战结算/);
  act(r, 0, { type: 'redo' }); act(r, 0, { type: 'confirm-end' });
  assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000, 25000]);
});

test('有支付或流局投票时不能进入结束结算', () => {
  const r = room(); act(r, 0, { type: 'draw', tenpai: false });
  assert.throws(() => act(r, 0, { type: 'end' }), /完成或取消/);
  act(r, 0, { type: 'draw', tenpai: null });
  act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 1000 }] });
  assert.throws(() => act(r, 0, { type: 'end' }), /完成或取消/);
});

test('房间规则仅房主在大厅修改，三人容量与起始点数同步生效', () => {
  const r = newRoom('TEST', { id: 'p0', name: '甲', seat: 0 }, { startPoints: 25000, startDealer: 0, length: 'south' });
  joinRoom(r, { id: 'p1', name: '乙' });
  const config = { type: 'configure', startPoints: 35000, length: 'east', playerCount: 3 };
  assert.throws(() => act(r, 1, config), /房主/);
  const before = structuredClone(r);
  for (const invalid of [{ startPoints: 25100.5 }, { startPoints: 900 }, { startPoints: 1000100 }, { playerCount: 2 }, { playerCount: '3' }, { length: 'west' }]) {
    assert.throws(() => act(r, 0, { ...config, ...invalid }));
    assert.deepEqual(r, before);
  }
  act(r, 0, config);
  assert.equal(publicRoom(r).config.playerCount, 3);
  assert.deepEqual(stateOf(r).scores, [35000, 35000, 35000]);
  joinRoom(r, { id: 'p2', name: '丙' });
  assert.throws(() => joinRoom(r, { id: 'p3', name: '丁' }), /已满/);
  act(r, 0, { ...config, playerCount: 4 });
  joinRoom(r, { id: 'p3', name: '丁' });
  assert.throws(() => act(r, 0, config), /已有四人/);
  act(r, 0, { type: 'start' });
  assert.throws(() => act(r, 0, { ...config, playerCount: 4 }), /大厅/);
});

test('结束后改规则保留旧场人数、点数和流水，新场不可跨场撤销', () => {
  const r = room(3); ron(r, 0, 1, 2000); finish(r);
  const finished = structuredClone(publicRoom(r));
  act(r, 0, { type: 'configure', startPoints: 30000, length: 'east', playerCount: 4 });
  assert.deepEqual(r.matches[0].state, finished.state);
  assert.deepEqual(r.matches[0].config, finished.config);
  assert.deepEqual(r.matches[0].events, finished.events);
  assert.deepEqual(stateOf(r).scores, [30000, 30000, 30000, 30000]);
  assert.equal(stateOf(r).status, 'waiting');
  assert.throws(() => act(r, 0, { type: 'undo' }), /未开始/);
  joinRoom(r, { id: 'p3', name: '丁' }); act(r, 0, { type: 'start' });
  assert.throws(() => act(r, 0, { type: 'undo' }), /没有可撤销/);
});

test('三人局顺序为东一、东二、东三、南一，庄家和风位不出现北家', () => {
  const r = room(3);
  for (let hand = 0; hand < 3; hand++) {
    assert.equal(publicRoom(r).label, `东 ${hand + 1} 局`);
    assert.equal(dealerOf(r), hand);
    ron(r, hand, (hand + 1) % 3, 1000);
  }
  assert.equal(publicRoom(r).label, '南 1 局'); assert.equal(dealerOf(r), 0);
});

test('三人自摸需要两家确认，不允许缺少付款方或使用北家座位', () => {
  const r = room(3);
  const transfers = [{ from: 0, to: 1, amount: 2000 }, { from: 2, to: 1, amount: 1000 }];
  assert.throws(() => act(r, 1, { type: 'propose', mode: 'tsumo', transfers: transfers.slice(0, 1) }), /两家/);
  assert.throws(() => act(r, 1, { type: 'propose', mode: 'tsumo', transfers: [transfers[0], { from: 3, to: 1, amount: 1000 }] }), /座位/);
  act(r, 1, { type: 'propose', mode: 'tsumo', transfers });
  act(r, 0, { type: 'approve', pendingId: r.pending.id });
  assert.throws(() => receive(r, 1), /等待/);
  assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000]);
  act(r, 2, { type: 'approve', pendingId: r.pending.id }); receive(r, 1);
  assert.deepEqual(stateOf(r).scores, [23000, 28000, 24000]); assert.equal(stateOf(r).hand, 1);
});

test('三人双响供托跨西家交给最近赢家，全部收款后才落账', () => {
  const r = room(3); act(r, 2, { type: 'riichi' });
  act(r, 2, { type: 'propose', mode: 'ron', transfers: [{ from: 2, to: 1, amount: 1000 }, { from: 2, to: 0, amount: 2000 }] });
  receive(r, 1); assert.equal(stateOf(r).pot, 1); receive(r, 0);
  assert.deepEqual(stateOf(r).scores, [28000, 26000, 21000]); assert.equal(stateOf(r).pot, 0);
});

for (const readyCount of [0, 1, 2, 3]) test(`三人流局 ${readyCount} 家听牌，三人全部确认才结算 2000 点罚符`, () => {
  const r = room(3); const oldRound = stateOf(r).roundId;
  for (let seat = 0; seat < 2; seat++) act(r, seat, { type: 'draw', tenpai: seat < readyCount });
  assert.equal(stateOf(r).roundId, oldRound);
  act(r, 2, { type: 'draw', tenpai: 2 < readyCount });
  const expected = [[25000, 25000, 25000], [27000, 24000, 24000], [26000, 26000, 23000], [25000, 25000, 25000]][readyCount];
  assert.deepEqual(stateOf(r).scores, expected);
  assert.equal(stateOf(r).honba, 1); assert.equal(stateOf(r).hand, readyCount ? 0 : 1);
  assert.notEqual(stateOf(r).roundId, oldRound); assert.deepEqual(r.drawVotes, {});
});

test('房主场况修改有校验、流水及撤销重做，同局保留立直，换局清除立直', () => {
  const r = room(); act(r, 1, { type: 'riichi' });
  const original = structuredClone(stateOf(r));
  const adjustment = { type: 'adjust', hand: 0, honba: 2, pot: 2, scores: [-1000, 34000, 35000, 30000] };
  assert.throws(() => act(r, 1, adjustment), /房主/);
  const unchanged = structuredClone(r);
  for (const invalid of [{ hand: 16 }, { hand: -1 }, { honba: 1.5 }, { pot: 100 }, { scores: [0, 0, 0] }, { scores: [10001, 20000, 30000, 40000] }]) {
    assert.throws(() => act(r, 0, { ...adjustment, ...invalid })); assert.deepEqual(r, unchanged);
  }
  act(r, 0, adjustment);
  assert.deepEqual(stateOf(r).scores, adjustment.scores);
  assert.equal(stateOf(r).riichi[1], true);
  assert.deepEqual(r.history.at(-1).entry.before.scores, original.scores);
  assert.deepEqual(r.history.at(-1).entry.after.scores, adjustment.scores);
  assert.throws(() => act(r, 1, { type: 'draw', tenpai: true, roundId: original.roundId }), /局数已改变/);
  act(r, 0, { type: 'undo' });
  assert.deepEqual({ ...stateOf(r), roundId: original.roundId }, original);
  act(r, 0, { type: 'redo' }); assert.deepEqual(stateOf(r).scores, adjustment.scores);
  act(r, 0, { ...adjustment, hand: 5 });
  assert.equal(publicRoom(r).label, '南 2 局'); assert.equal(dealerOf(r), 1);
  assert.deepEqual(stateOf(r).riichi, [false, false, false, false]);
});

test('场况修改拒绝过期编辑、待确认支付与流局投票', () => {
  const r = room(3);
  const adjustment = { type: 'adjust', hand: 2, honba: 1, pot: 0, scores: [25000, 25000, 25000] };
  const revision = r.revision; act(r, 1, { type: 'riichi' });
  assert.throws(() => act(r, 0, { ...adjustment, revision }), /更新/);
  act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 1000 }] });
  assert.throws(() => act(r, 0, adjustment), /完成或取消/);
  act(r, 0, { type: 'cancel', pendingId: r.pending.id });
  act(r, 1, { type: 'draw', tenpai: true });
  assert.throws(() => act(r, 0, adjustment), /完成或取消/);
});

test('四人到齐且房主确认才能开局，不能加入已开局房间', () => {
  const r = newRoom('ABCD', { id: 'p0', name: '甲', seat: 0 }, { startPoints: 25000, startDealer: 2, length: 'east' });
  assert.throws(() => act(r, 0, { type: 'start' }), /四人/);
  for (let i = 1; i < 4; i++) joinRoom(r, { id: `p${i}`, name: '乙' });
  assert.throws(() => act(r, 1, { type: 'start' }), /房主/);
  act(r, 0, { type: 'start' }); assert.equal(dealerOf(r), 2);
  assert.throws(() => joinRoom(r, { id: 'p5' }), /已经开始/);
});
test('立直扣点入供托且同局不能重复立直', () => {
  const r = room(); act(r, 0, { type: 'riichi' });
  assert.equal(stateOf(r).scores[0], 24000); assert.equal(stateOf(r).pot, 1);
  assert.throws(() => act(r, 0, { type: 'riichi' }), /已经立直/); conserved(r);
});
test('点数不足 1000 不能立直', () => {
  const r = room(); stateOf(r).scores[0] = 900;
  assert.throws(() => act(r, 0, { type: 'riichi' }), /不足/);
});
test('收款方二次确认前不扣点、不换局；外人不能确认', () => {
  const r = room(); act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 3900 }] });
  assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000, 25000]); assert.equal(stateOf(r).hand, 0);
  assert.throws(() => receive(r, 2), /只有收款方/);
  receive(r, 1); assert.deepEqual(stateOf(r).scores, [21100, 28900, 25000, 25000]); assert.equal(stateOf(r).hand, 1); conserved(r);
});
test('庄家和牌连庄，支付值已含本场，供托另外交付', () => {
  const r = room(); act(r, 2, { type: 'riichi' });
  ron(r, 1, 0, 5800); assert.equal(stateOf(r).honba, 1); assert.equal(stateOf(r).hand, 0);
  assert.deepEqual(stateOf(r).scores, [31800, 19200, 24000, 25000]);
  ron(r, 2, 3, 2300); assert.equal(stateOf(r).hand, 1); assert.equal(stateOf(r).honba, 0);
  assert.equal(stateOf(r).scores[3], 27300); assert.equal(stateOf(r).pot, 0); conserved(r);
});
test('自摸先等三家付款，再由赢家确认，最终只换一次局', () => {
  const r = room();
  act(r, 1, { type: 'propose', mode: 'tsumo', transfers: [{ from: 0, to: 1, amount: 2000 }, { from: 2, to: 1, amount: 1000 }, { from: 3, to: 1, amount: 1000 }] });
  assert.throws(() => receive(r, 1), /等待所有付款方/);
  for (const seat of [0, 2, 3]) act(r, seat, { type: 'approve', pendingId: r.pending.id });
  assert.equal(stateOf(r).hand, 0); assert.equal(stateOf(r).scores[1], 25000);
  receive(r, 1); assert.equal(stateOf(r).hand, 1); assert.deepEqual(stateOf(r).scores, [23000, 29000, 24000, 24000]); conserved(r);
});
test('双响等待全部收款人，供托按放铳者下家方向分配', () => {
  const r = room(); act(r, 2, { type: 'riichi' });
  act(r, 3, { type: 'propose', mode: 'ron', transfers: [{ from: 3, to: 2, amount: 3900 }, { from: 3, to: 0, amount: 5800 }] });
  receive(r, 2); assert.equal(stateOf(r).scores[3], 25000); receive(r, 0);
  assert.deepEqual(stateOf(r).scores, [31800, 25000, 27900, 15300]); assert.equal(stateOf(r).honba, 1); assert.equal(stateOf(r).hand, 0); conserved(r);
});
for (const count of [0, 1, 2, 3, 4]) test(`${count} 家听牌，四人全部确认才结算流局`, () => {
  const r = room(); const roundId = stateOf(r).roundId;
  for (let seat = 0; seat < 3; seat++) act(r, seat, { type: 'draw', tenpai: seat < count, roundId });
  assert.equal(stateOf(r).honba, 0); assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000, 25000]);
  act(r, 3, { type: 'draw', tenpai: 3 < count, roundId });
  assert.equal(stateOf(r).honba, 1); assert.equal(stateOf(r).hand, count ? 0 : 1);
  const expected = Array.from({ length: 4 }, (_, seat) => 25000 + (count === 0 || count === 4 ? 0 : seat < count ? 3000 / count : -3000 / (4 - count)));
  assert.deepEqual(stateOf(r).scores, expected); conserved(r);
});
test('流局保留供托；立直不能报未听；可以撤回流局确认', () => {
  const r = room(); act(r, 0, { type: 'riichi' });
  assert.throws(() => act(r, 0, { type: 'draw', tenpai: false }), /立直玩家/);
  act(r, 0, { type: 'draw', tenpai: true }); act(r, 0, { type: 'draw', tenpai: null }); assert.equal(Object.keys(r.drawVotes).length, 0);
  for (let seat = 0; seat < 4; seat++) act(r, seat, { type: 'draw', tenpai: true });
  assert.equal(stateOf(r).pot, 1); assert.equal(stateOf(r).honba, 1); assert.deepEqual(stateOf(r).riichi, Array(4).fill(false)); conserved(r);
});
test('撤销/重做恢复点数与整局状态，拒绝撤销前延迟到达的投票', () => {
  const r = room(); act(r, 0, { type: 'riichi' });
  const originalRoundId = stateOf(r).roundId;
  ron(r, 3, 1, 8000); const result = structuredClone(stateOf(r));
  act(r, 2, { type: 'undo' }); assert.equal(stateOf(r).pot, 1); assert.equal(stateOf(r).riichi[0], true); assert.equal(stateOf(r).hand, 0);
  assert.throws(() => act(r, 2, { type: 'draw', tenpai: true, roundId: originalRoundId }), /局数已改变/);
  act(r, 2, { type: 'redo' }); assert.deepEqual(stateOf(r).scores, result.scores); assert.equal(stateOf(r).hand, result.hand); assert.equal(stateOf(r).pot, 0); conserved(r);
  act(r, 2, { type: 'undo' }); act(r, 2, { type: 'riichi' }); assert.equal(publicRoom(r).canRedo, false);
});
test('未完成结算时不许撤销、立直、开始另一笔结算', () => {
  const r = room(); act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 1000 }] });
  assert.throws(() => act(r, 2, { type: 'undo' }), /取消/);
  assert.throws(() => act(r, 2, { type: 'riichi' }), /当前结算/);
  assert.throws(() => act(r, 2, { type: 'draw', tenpai: false }), /支付/);
  assert.throws(() => act(r, 2, { type: 'cancel', pendingId: r.pending.id }), /相关玩家/);
  act(r, 1, { type: 'cancel', pendingId: r.pending.id }); assert.equal(r.pending, null);
});
test('拒绝错误金额、伪造付款方、重复收款人、不完整自摸', () => {
  const r = room();
  for (const amount of [0, -100, 150, 1.5, Infinity, 1000100, '1000']) assert.throws(() => act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount }] }), /点数/);
  assert.throws(() => act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 2, to: 1, amount: 1000 }] }), /放铳者/);
  assert.throws(() => act(r, 0, { type: 'propose', mode: 'ron', transfers: [{ from: 0, to: 1, amount: 1000 }, { from: 0, to: 1, amount: 1000 }] }), /不同/);
  assert.throws(() => act(r, 0, { type: 'propose', mode: 'tsumo', transfers: [{ from: 0, to: 1, amount: 1000 }] }), /三家/);
});
test('重复请求不重复扣点，过时版本不覆盖当前状态', () => {
  const r = room(); const action = { type: 'riichi', requestId: 'idempotent-001', revision: r.revision, roundId: stateOf(r).roundId };
  applyAction(r, 'p0', action); const revision = r.revision;
  assert.equal(applyAction(r, 'p0', action), false); assert.equal(r.revision, revision); assert.equal(stateOf(r).pot, 1);
  assert.throws(() => act(r, 1, { type: 'riichi', revision: 0 }), /更新/); conserved(r);
});
test('东四局换南一局；对战结束须房主确认且不可撤销', () => {
  const r = room(); for (let i = 0; i < 4; i++) ron(r, i, (i + 1) % 4, 1000);
  assert.equal(publicRoom(r).label, '南 1 局'); assert.equal(dealerOf(r), 0);
  assert.throws(() => act(r, 1, { type: 'end' }), /房主/);
  finish(r); assert.equal(stateOf(r).status, 'ended');
  assert.throws(() => act(r, 0, { type: 'riichi' }), /对局中/);
  assert.throws(() => act(r, 0, { type: 'undo' }), /结算已确认/); conserved(r);
});

test('大厅退出释放座位、按座位顺序转交房主，空房间可重新入座', () => {
  const r = newRoom('TEST', { id: 'p0', name: '甲', seat: 0 }, { startPoints: 25000, startDealer: 2, length: 'south' });
  for (let i = 1; i < 4; i++) joinRoom(r, { id: `p${i}`, name: `玩家${i}` });
  leaveRoom(r, 'p1');
  assert.equal(r.hostId, 'p0');
  assert.deepEqual(r.players.map((p) => [p.id, p.seat]), [['p0', 0], ['p2', 1], ['p3', 2]]);
  assert.equal(r.config.startDealer, 1);
  leaveRoom(r, 'p0');
  assert.equal(r.hostId, 'p2'); assert.equal(r.config.startDealer, 0);
  assert.throws(() => act(r, 0, { type: 'configure', startPoints: 35000, playerCount: 3, length: 'east' }), /不在/);
  act(r, 2, { type: 'configure', startPoints: 35000, playerCount: 3, length: 'east' });
  leaveRoom(r, 'p2'); leaveRoom(r, 'p3');
  assert.equal(r.hostId, null); assert.deepEqual(r.players, []);
  joinRoom(r, { id: 'p4', name: '新人' });
  assert.equal(r.hostId, 'p4'); assert.equal(r.players[0].seat, 0);
});

test('对局和结算期间不能退出，确认后退出保留完整成绩并允许补位', () => {
  const r = room();
  let before = structuredClone(r);
  assert.throws(() => leaveRoom(r, 'p0'), /结束并确认/); assert.deepEqual(r, before);
  ron(r, 0, 1, 3900); act(r, 0, { type: 'end' });
  before = structuredClone(r);
  assert.throws(() => leaveRoom(r, 'p1'), /结束并确认/); assert.deepEqual(r, before);
  act(r, 0, { type: 'confirm-end' });
  const ended = structuredClone(publicRoom(r));
  leaveRoom(r, 'p0');
  assert.equal(stateOf(r).status, 'waiting'); assert.equal(r.hostId, 'p1');
  assert.deepEqual(r.matches[0].state, ended.state);
  assert.deepEqual(r.matches[0].players, ended.players.map(({ id, name, seat }) => ({ id, name, seat })));
  assert.deepEqual(r.matches[0].events, ended.events);
  assert.equal(publicRoom(r).canUndo, false);
  joinRoom(r, { id: 'p4', name: '新玩家' });
  assert.equal(r.players[3].id, 'p4');
  act(r, 1, { type: 'start' });
  assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000, 25000]);
  assert.throws(() => act(r, 1, { type: 'undo' }), /没有可撤销/);
});
test('公开记录不包含玩家身份凭证', () => { assert.equal(JSON.stringify(publicRoom(room())).includes('tokenHash'), false); });

test('同房间连续开局重置点数和局况，保留当场记录且不能跨场撤销', () => {
  const r = room();
  act(r, 2, { type: 'riichi' });
  ron(r, 0, 1, 3900);
  act(r, 3, { type: 'riichi' });
  finish(r);
  const ended = structuredClone(publicRoom(r));
  assert.throws(() => act(r, 1, { type: 'start' }), /房主/);
  act(r, 0, { type: 'start' });
  assert.equal(r.code, ended.code);
  assert.deepEqual(r.players.map((p) => p.id), ended.players.map((p) => p.id));
  assert.equal(stateOf(r).status, 'playing');
  assert.equal(stateOf(r).hand, 0); assert.equal(stateOf(r).honba, 0); assert.equal(stateOf(r).pot, 0);
  assert.deepEqual(stateOf(r).scores, [25000, 25000, 25000, 25000]);
  assert.deepEqual(stateOf(r).riichi, [false, false, false, false]);
  assert.notEqual(stateOf(r).roundId, ended.state.roundId);
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0].state, ended.state);
  assert.deepEqual(r.matches[0].players, ended.players.map(({ id, name, seat }) => ({ id, name, seat })));
  assert.deepEqual(r.matches[0].events, ended.events);
  assert.equal(publicRoom(r).canUndo, false);
  assert.throws(() => act(r, 0, { type: 'undo' }), /没有可撤销/);
  assert.throws(() => act(r, 2, { type: 'draw', tenpai: true, roundId: ended.state.roundId }), /局数已改变/);
  finish(r); act(r, 0, { type: 'start' });
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches[0].state, ended.state);
  assert.equal(JSON.stringify(publicRoom(r)).includes('tokenHash'), false);
});

test('随机选座仅房主在四人大厅可用，保持身份和历史，按新座位记分', () => {
  const r = newRoom('ABCD', { id: 'p0', name: '东家', seat: 0, tokenHash: 'private0' }, { startPoints: 25000, startDealer: 0, length: 'south' });
  assert.throws(() => act(r, 0, { type: 'shuffle' }), /四人/);
  for (let i = 1; i < 4; i++) joinRoom(r, { id: `p${i}`, name: `玩家${i}`, tokenHash: `private${i}` });
  assert.throws(() => act(r, 1, { type: 'shuffle' }), /房主/);
  act(r, 0, { type: 'shuffle' });
  assert.equal(stateOf(r).status, 'waiting');
  act(r, 0, { type: 'start' });
  assert.throws(() => act(r, 0, { type: 'shuffle' }), /大厅/);
  act(r, 2, { type: 'riichi' }); finish(r);
  const ended = structuredClone(publicRoom(r));
  act(r, 0, { type: 'shuffle' });
  assert.equal(stateOf(r).status, 'waiting');
  assert.equal(r.hostId, 'p0');
  assert.deepEqual(r.players.map((p) => p.id).sort(), ['p0', 'p1', 'p2', 'p3']);
  r.players.forEach((p, index) => { assert.equal(p.seat, index); assert.equal(p.tokenHash, `private${p.id.slice(1)}`); });
  assert.deepEqual(r.matches[0].players, ended.players.map(({ id, name, seat }) => ({ id, name, seat })));
  assert.deepEqual(r.matches[0].state, ended.state);
  const archived = structuredClone(r.matches);
  act(r, 0, { type: 'shuffle' });
  assert.deepEqual(r.matches, archived);
  act(r, 0, { type: 'start' });
  act(r, 2, { type: 'riichi' });
  const seat = r.players.find((p) => p.id === 'p2').seat;
  assert.equal(stateOf(r).scores[seat], 24000);
  assert.equal(stateOf(r).riichi[seat], true);
  assert.equal(dealerOf(r), 0); conserved(r);
});
