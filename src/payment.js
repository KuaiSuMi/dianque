export const RON_POINTS = {
  nonDealer: [1000, 1300, 1600, 2000, 2600, 3200, 3900, 5200, 6400, 7700, 8000, 12000, 16000, 24000, 32000],
  dealer: [1500, 2000, 2400, 2900, 3900, 4800, 5800, 7700, 9600, 11600, 12000, 18000, 24000, 36000, 48000],
};

// 每组依次为子家付款、庄家付款；三麻按自摸损，仅向在座的两家收款。
export const TSUMO_POINTS = {
  nonDealer: [[300, 500], [400, 700], [400, 800], [500, 1000], [700, 1300], [800, 1600], [1000, 2000], [1300, 2600], [1600, 3200], [2000, 3900], [2000, 4000], [3000, 6000], [4000, 8000], [6000, 12000], [8000, 16000]],
  dealer: [500, 700, 800, 1000, 1300, 1600, 2000, 2600, 3200, 3900, 4000, 6000, 8000, 12000, 16000].map((amount) => [amount, amount]),
};

export function pointPatterns(mode, dealer, points) {
  if (points == null) return '';
  const round = (value) => Math.ceil(value / 100) * 100;
  const matches = (base) => mode === 'ron'
    ? round(base * (dealer ? 6 : 4)) === points
    : round(base * (dealer ? 2 : 1)) === points[0] && round(base * 2) === points[1];
  const limits = [
    [2000, '满贯 · 5 番 / 4 番 40 符以上 / 3 番 70 符以上'],
    [3000, '跳满 · 6–7 番'], [4000, '倍满 · 8–10 番'],
    [6000, '三倍满 · 11–12 番'], [8000, '役满 / 累计役满（13 番以上）'],
  ];
  const limit = limits.find(([base]) => matches(base));
  if (limit) return limit[1];
  const patterns = [];
  for (let han = 1; han <= 4; han++) {
    for (const fu of [20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110]) {
      if (fu === 20 && (mode === 'ron' || han < 2)) continue;
      if (fu === 25 && han < (mode === 'tsumo' ? 3 : 2)) continue;
      if (mode === 'tsumo' && han === 1 && fu === 110) continue;
      const base = fu * 2 ** (han + 2);
      if (base < 2000 && matches(base)) patterns.push(`${han} 番 ${fu} 符`);
    }
  }
  return patterns.join(' / ');
}

export function tsumoAmounts(payers, dealer, points) {
  return Object.fromEntries(payers.map(({ from }) => [from, points[from === dealer ? 1 : 0]]));
}

export function paymentTransfers({ mode, entry, rows, amounts, honba, playerCount = 4 }) {
  const honbaWinner = mode === 'ron' && rows.reduce((nearest, row) =>
    !nearest || (row.to - row.from + playerCount) % playerCount < (nearest.to - nearest.from + playerCount) % playerCount ? row : nearest, null)?.to;
  return rows.map(({ from, to }) => {
    const base = Number(amounts[mode === 'ron' ? to : from]);
    const bonus = entry === 'quick' ? honba * (mode === 'tsumo' ? 100 : to === honbaWinner ? 300 : 0) : 0;
    return { from, to, amount: base > 0 ? base + bonus : base };
  });
}
