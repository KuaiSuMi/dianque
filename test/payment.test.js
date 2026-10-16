import test from 'node:test';
import assert from 'node:assert/strict';
import { RON_POINTS, TSUMO_POINTS, pointPatterns, tsumoAmounts, paymentTransfers } from '../src/payment.js';
import { newRoom, joinRoom, applyAction, stateOf } from '../server/game.js';

test('常规点数番符区分庄闲和荣和自摸，同金额列出多种组合', () => {
  assert.equal(pointPatterns('ron', false, 3900), '2 番 60 符 / 3 番 30 符');
  assert.equal(pointPatterns('ron', true, 3900), '1 番 80 符 / 2 番 40 符');
  assert.equal(pointPatterns('ron', false, 1600), '1 番 50 符 / 2 番 25 符');
  assert.equal(pointPatterns('ron', false, 7700), '3 番 60 符 / 4 番 30 符');
  assert.equal(pointPatterns('tsumo', false, [400, 700]), '1 番 40 符 / 2 番 20 符');
  assert.equal(pointPatterns('tsumo', false, [400, 800]), '1 番 50 符');
  assert.equal(pointPatterns('tsumo', false, [1000, 2000]), '2 番 60 符 / 3 番 30 符');
  assert.equal(pointPatterns('tsumo', true, [2000, 2000]), '2 番 60 符 / 3 番 30 符');
  assert.equal(pointPatterns('tsumo', false, [800, 1600]), '1 番 100 符 / 2 番 50 符 / 3 番 25 符');
});

test('所有常规档位都有番符说明，限界档位和未选状态正确', () => {
  for (const role of ['nonDealer', 'dealer']) {
    for (const points of RON_POINTS[role]) assert.ok(pointPatterns('ron', role === 'dealer', points), `荣和 ${role} ${points}`);
    for (const points of TSUMO_POINTS[role]) assert.ok(pointPatterns('tsumo', role === 'dealer', points), `自摸 ${role} ${points}`);
  }
  assert.equal(pointPatterns('ron', false, 8000), '满贯 · 5 番 / 4 番 40 符以上 / 3 番 70 符以上');
  assert.equal(pointPatterns('tsumo', false, [3000, 6000]), '跳满 · 6–7 番');
  assert.equal(pointPatterns('ron', true, 24000), '倍满 · 8–10 番');
  assert.equal(pointPatterns('tsumo', true, [12000, 12000]), '三倍满 · 11–12 番');
  assert.equal(pointPatterns('ron', false, 32000), '役满 / 累计役满（13 番以上）');
  assert.equal(pointPatterns('ron', false, undefined), '');
  assert.equal(pointPatterns('tsumo', false, undefined), '');
});

test('三麻自摸损只收两家原档，每家追加本场；双响本场跨西家给最近赢家', () => {
  const rows = [{ from: 0, to: 1 }, { from: 2, to: 1 }];
  const amounts = tsumoAmounts(rows, 0, [1000, 2000]);
  assert.deepEqual(paymentTransfers({ mode: 'tsumo', entry: 'quick', rows, amounts, honba: 2, playerCount: 3 }), [
    { from: 0, to: 1, amount: 2200 }, { from: 2, to: 1, amount: 1200 },
  ]);
  const dealerRows = [{ from: 1, to: 0 }, { from: 2, to: 0 }];
  assert.deepEqual(tsumoAmounts(dealerRows, 0, [4000, 4000]), { 1: 4000, 2: 4000 });
  assert.deepEqual(paymentTransfers({ mode: 'ron', entry: 'quick', rows: [{ from: 2, to: 1 }, { from: 2, to: 0 }], amounts: { 0: 12000, 1: 8000 }, honba: 1, playerCount: 3 }), [
    { from: 2, to: 1, amount: 8000 }, { from: 2, to: 0, amount: 12300 },
  ]);
});

test('荣和快捷点数按本场加点，不修改原始选择', () => {
  const amounts = { 1: 3900 };
  const input = { mode: 'ron', entry: 'quick', rows: [{ from: 0, to: 1 }], amounts };
  assert.deepEqual(paymentTransfers({ ...input, honba: 0 }), [{ from: 0, to: 1, amount: 3900 }]);
  assert.deepEqual(paymentTransfers({ ...input, honba: 2 }), [{ from: 0, to: 1, amount: 4500 }]);
  assert.deepEqual(amounts, { 1: 3900 });
});

test('多家荣和本场只给最近赢家，跨过北家且不依赖勾选顺序', () => {
  const input = { mode: 'ron', entry: 'quick', honba: 2, amounts: { 0: 12000, 1: 8000, 2: 3900 } };
  assert.deepEqual(paymentTransfers({ ...input, rows: [{ from: 3, to: 2 }, { from: 3, to: 0 }, { from: 3, to: 1 }] }), [
    { from: 3, to: 2, amount: 3900 }, { from: 3, to: 0, amount: 12600 }, { from: 3, to: 1, amount: 8000 },
  ]);
  assert.deepEqual(paymentTransfers({ ...input, rows: [{ from: 3, to: 2 }, { from: 3, to: 1 }] }), [
    { from: 3, to: 2, amount: 3900 }, { from: 3, to: 1, amount: 8600 },
  ]);
});

test('子家自摸一次选档，按实际庄家分配并给三家各加本场', () => {
  const rows = [{ from: 0, to: 1 }, { from: 2, to: 1 }, { from: 3, to: 1 }];
  const amounts = tsumoAmounts(rows, 2, [1000, 2000]);
  assert.deepEqual(amounts, { 0: 1000, 2: 2000, 3: 1000 });
  assert.deepEqual(paymentTransfers({ mode: 'tsumo', entry: 'quick', honba: 2, rows, amounts }), [
    { from: 0, to: 1, amount: 1200 }, { from: 2, to: 1, amount: 2200 }, { from: 3, to: 1, amount: 1200 },
  ]);
});

test('庄家自摸三家支付相同，快捷档位保留满贯等常见金额', () => {
  const rows = [{ from: 0, to: 2 }, { from: 1, to: 2 }, { from: 3, to: 2 }];
  const amounts = tsumoAmounts(rows, 2, [4000, 4000]);
  assert.deepEqual(paymentTransfers({ mode: 'tsumo', entry: 'quick', honba: 1, rows, amounts }).map((t) => t.amount), [4100, 4100, 4100]);
  assert.ok(RON_POINTS.dealer.includes(12000));
  assert.ok(RON_POINTS.nonDealer.includes(8000));
  assert.ok(TSUMO_POINTS.nonDealer.some(([child, dealer]) => child === 2000 && dealer === 4000));
});

test('自定义金额按最终实付金额提交，荣和与自摸均不追加本场', () => {
  assert.deepEqual(paymentTransfers({ mode: 'ron', entry: 'custom', honba: 3, rows: [{ from: 0, to: 1 }], amounts: { 1: '4800' } }), [{ from: 0, to: 1, amount: 4800 }]);
  assert.deepEqual(paymentTransfers({ mode: 'tsumo', entry: 'custom', honba: 3, rows: [{ from: 0, to: 1 }, { from: 2, to: 1 }, { from: 3, to: 1 }], amounts: { 0: '2300', 2: '1300', 3: '1300' } }).map((t) => t.amount), [2300, 1300, 1300]);
});

test('未选择或无效金额不能变成仅支付本场', () => {
  for (const entry of ['quick', 'custom']) {
    const input = { mode: 'ron', entry, honba: 2, rows: [{ from: 0, to: 1 }] };
    assert.ok(Number.isNaN(paymentTransfers({ ...input, amounts: {} })[0].amount));
    assert.equal(paymentTransfers({ ...input, amounts: { 1: '' } })[0].amount, 0);
    assert.equal(paymentTransfers({ ...input, amounts: { 1: -100 } })[0].amount, -100);
  }
});

test('快捷结算落账不重复追加本场，供托仍由服务端另行分配', () => {
  const room = newRoom('TEST', { id: 'p0', name: '甲', seat: 0 }, { startPoints: 25000, startDealer: 0, length: 'south' });
  for (let seat = 1; seat < 4; seat++) joinRoom(room, { id: `p${seat}`, name: `玩家${seat}` });
  let seq = 0;
  const act = (seat, action) => applyAction(room, `p${seat}`, { requestId: `payment-test-${++seq}`, revision: room.revision, roundId: stateOf(room).roundId, ...action });
  act(0, { type: 'start' });
  stateOf(room).honba = 2;
  act(3, { type: 'riichi' });
  const transfers = paymentTransfers({ mode: 'ron', entry: 'quick', honba: 2, rows: [{ from: 0, to: 1 }], amounts: { 1: 3900 } });
  act(0, { type: 'propose', mode: 'ron', transfers });
  assert.equal(room.pending, null);
  assert.deepEqual(stateOf(room).scores, [20500, 30500, 25000, 24000]);
  assert.equal(stateOf(room).pot, 0);
  assert.equal(stateOf(room).hand, 1);
  act(0, { type: 'undo' });
  assert.deepEqual(stateOf(room).scores, [25000, 25000, 25000, 24000]);
  assert.equal(stateOf(room).honba, 2);
  assert.equal(stateOf(room).pot, 1);
});
