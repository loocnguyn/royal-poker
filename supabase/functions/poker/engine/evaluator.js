import { rankValue } from './cards.js';

const RANK_NAMES = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' };
const rn = (v) => RANK_NAMES[v] || String(v);

// Đánh giá đúng 5 lá. score càng lớn càng mạnh.
export function evaluate5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);

  let straightHigh = 0;
  const uniq = [...new Set(vals)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5
  }

  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.map((g) => g[0]);
  const shape = groups.map((g) => g[1]).join('');

  let category, ranks;
  if (straightHigh && flush) { category = 8; ranks = [straightHigh]; }
  else if (shape === '41') { category = 7; ranks = ordered; }
  else if (shape === '32') { category = 6; ranks = ordered; }
  else if (flush) { category = 5; ranks = vals; }
  else if (straightHigh) { category = 4; ranks = [straightHigh]; }
  else if (shape === '311') { category = 3; ranks = ordered; }
  else if (shape === '221') { category = 2; ranks = ordered; }
  else if (shape === '2111') { category = 1; ranks = ordered; }
  else { category = 0; ranks = vals; }

  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (ranks[i] || 0);
  return { score, category, ranks };
}

export function describe(category, ranks) {
  switch (category) {
    case 8: return ranks[0] === 14 ? 'Thùng phá sảnh Hoàng gia' : `Thùng phá sảnh đến ${rn(ranks[0])}`;
    case 7: return `Tứ quý ${rn(ranks[0])}`;
    case 6: return `Cù lũ ${rn(ranks[0])} đầy ${rn(ranks[1])}`;
    case 5: return `Thùng, ${rn(ranks[0])} cao`;
    case 4: return `Sảnh đến ${rn(ranks[0])}`;
    case 3: return `Sám cô ${rn(ranks[0])}`;
    case 2: return `Hai đôi ${rn(ranks[0])} và ${rn(ranks[1])}`;
    case 1: return `Đôi ${rn(ranks[0])}`;
    default: return `Mậu thầu ${rn(ranks[0])}`;
  }
}

// 5 lá tốt nhất trong 5–7 lá.
export function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const five = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const r = evaluate5(five);
            if (!best || r.score > best.score) best = { ...r, cards: five };
          }
  best.name = describe(best.category, best.ranks);
  return best;
}
