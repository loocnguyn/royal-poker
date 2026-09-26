import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestHand, evaluate5 } from '../supabase/functions/poker/engine/evaluator.js';
import { newDeck } from '../supabase/functions/poker/engine/cards.js';
import { rng } from './helpers.js';

const H = (s) => s.split(' ');
const cmp = (a, b) => Math.sign(bestHand(H(a)).score - bestHand(H(b)).score);

test('duyệt toàn bộ 2.598.960 bộ 5 lá: đúng tần suất chuẩn của từng loại', () => {
  const deck = newDeck();
  const counts = new Array(9).fill(0);
  let royal = 0;
  const hand = new Array(5);
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++)
    for (let d = c + 1; d < 52; d++) for (let e = d + 1; e < 52; e++) {
      hand[0] = deck[a]; hand[1] = deck[b]; hand[2] = deck[c]; hand[3] = deck[d]; hand[4] = deck[e];
      const r = evaluate5(hand);
      counts[r.category]++;
      if (r.category === 8 && r.ranks[0] === 14) royal++;
    }
  // Tần suất chuẩn (Wikipedia: Poker probability)
  assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  assert.equal(royal, 4);
});

test('tên bộ bài tiếng Việt', () => {
  const cases = {
    'Ah Kh Qh Jh Th 2c 3d': 'Thùng phá sảnh Hoàng gia',
    'Ah 2h 3h 4h 5h Kc Kd': 'Thùng phá sảnh đến 5',
    '9s 9h 9d 9c 2s 3h 4d': 'Tứ quý 9',
    'Ks Kh Kd 2c 2s 7h 8d': 'Cù lũ K đầy 2',
    '2h 7h 9h Jh Kh 3c 4d': 'Thùng, K cao',
    'Ts Jh Qd Kc As 2c 3d': 'Sảnh đến A',
    'As 2d 3c 4h 5s 9c Kd': 'Sảnh đến 5',
    '7s 7h 7d Kc 2s 9h 4d': 'Sám cô 7',
    'Js Jh 4d 4c 2s 9h Ad': 'Hai đôi J và 4',
    'Qs Qh 4d 7c 2s 9h Ad': 'Đôi Q',
    'As Jh 4d 7c 2s 9h 8d': 'Mậu thầu A',
  };
  for (const [cards, name] of Object.entries(cases)) assert.equal(bestHand(H(cards)).name, name, cards);
});

test('các tình huống so bài hiểm', () => {
  // Sảnh A-5 (wheel) thua sảnh 6
  assert.equal(cmp('As 2d 3c 4h 5s 9c 9d', '6s 2d 3c 4h 5s 9c 9d'), -1);
  // Thùng phá sảnh wheel thua thùng phá sảnh 6
  assert.equal(cmp('Ah 2h 3h 4h 5h Kc Kd', '6h 2h 3h 4h 5h Kc Kd'), -1);
  // 7 lá có 2 bộ ba → cù lũ lấy bộ ba cao làm chính
  assert.equal(bestHand(H('Ks Kh Kd 2c 2s 2h 8d')).name, 'Cù lũ K đầy 2');
  // 3 đôi → chỉ lấy 2 đôi cao nhất + kicker cao nhất
  assert.equal(cmp('As Ah Kd Kc Qs Qh 2d', 'As Ah Kd Kc Js Jh Qd'), 0);
  assert.equal(bestHand(H('As Ah Kd Kc Qs Qh 2d')).name, 'Hai đôi A và K');
  // Kicker quyết định
  assert.equal(cmp('As Ad Kc 7h 5s 3c 2d', 'Ah Ac Qc 7d 5h 3s 2c'), 1);
  // Kicker thứ 5 không tính khi đã đủ 5 lá (lá thứ 6,7 không quan trọng)
  assert.equal(cmp('As Ad Kc Qh Js 3c 2d', 'Ah Ac Kd Qc Jh 4s 2c'), 0);
  // Tứ quý trên bàn: kicker quyết định
  assert.equal(cmp('9s 9h 9d 9c As 2h 3d', '9s 9h 9d 9c Ks Qh Jd'), 1);
  // Thùng: so từng lá từ cao xuống
  assert.equal(cmp('Ah Kh 9h 5h 3h 2c 2d', 'Ah Kh 9h 5h 2h 3c 3d'), 1);
  // Sảnh có lá trùng (A-2-3-4-5-5-6) → sảnh 6
  assert.equal(bestHand(H('As 2d 3c 4h 5s 5c 6d')).name, 'Sảnh đến 6');
  // Thùng + sảnh riêng rẽ (không phải TPS) → thùng thắng sảnh
  assert.equal(bestHand(H('2h 3h 4h 5c 6h 9h Kd')).category, 5);
  // Board thắng: cả hai chia pot
  assert.equal(cmp('2c 3d Ts Js Qs Ks As', '4c 5d Ts Js Qs Ks As'), 0);
  // K-A-2-3-4 KHÔNG phải sảnh
  assert.notEqual(bestHand(H('Ks As 2d 3c 4h 9c 8d')).category, 4);
  // Cù lũ lớn hơn thắng
  assert.equal(cmp('3s 3h 3d 2c 2s Kh Qd', '2s 2h 2d As Ad Kh Qd'), 1);
});

// Bộ đánh giá tham chiếu viết theo cách khác hoàn toàn để so chéo.
function refRank(cards) {
  const RV = { T: 10, J: 11, Q: 12, K: 13, A: 14 };
  const v = (c) => RV[c[0]] || Number(c[0]);
  let best = null;
  const n = cards.length;
  const combos = [];
  const pick = (start, acc) => {
    if (acc.length === 5) { combos.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(cards[i]); pick(i + 1, acc); acc.pop(); }
  };
  pick(0, []);
  for (const five of combos) {
    const vals = five.map(v);
    const bySuit = new Set(five.map((c) => c[1]));
    const cnt = {};
    vals.forEach((x) => (cnt[x] = (cnt[x] || 0) + 1));
    const groups = Object.entries(cnt).map(([k, c]) => [c, Number(k)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const distinct = [...new Set(vals)].sort((a, b) => b - a);
    let straight = 0;
    if (distinct.length === 5) {
      if (distinct[0] - distinct[4] === 4) straight = distinct[0];
      else if (distinct.join() === '14,5,4,3,2') straight = 5;
    }
    const flush = bySuit.size === 1;
    let key;
    if (straight && flush) key = [8, straight];
    else if (groups[0][0] === 4) key = [7, groups[0][1], groups[1][1]];
    else if (groups[0][0] === 3 && groups[1][0] === 2) key = [6, groups[0][1], groups[1][1]];
    else if (flush) key = [5, ...vals.sort((a, b) => b - a)];
    else if (straight) key = [4, straight];
    else if (groups[0][0] === 3) key = [3, ...groups.map((g) => g[1])];
    else if (groups[0][0] === 2 && groups[1][0] === 2) key = [2, ...groups.map((g) => g[1])];
    else if (groups[0][0] === 2) key = [1, ...groups.map((g) => g[1])];
    else key = [0, ...vals.sort((a, b) => b - a)];
    if (!best || cmpKey(key, best) > 0) best = key;
  }
  return best;
}
function cmpKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

test('so chéo 40.000 cặp tay 7 lá ngẫu nhiên với bộ đánh giá tham chiếu', () => {
  const r = rng(12345);
  for (let t = 0; t < 40000; t++) {
    const d = newDeck();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    const board = d.slice(0, 5), a = [...d.slice(5, 7), ...board], b = [...d.slice(7, 9), ...board];
    const mine = Math.sign(bestHand(a).score - bestHand(b).score);
    const ref = cmpKey(refRank(a), refRank(b));
    assert.equal(mine, ref, `${a.join(' ')} vs ${b.join(' ')}`);
    assert.equal(bestHand(a).category, refRank(a)[0]);
  }
});

test('bestHand trả về đúng 5 lá nằm trong 7 lá đã cho', () => {
  const r = rng(7);
  for (let t = 0; t < 2000; t++) {
    const d = newDeck();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    const seven = d.slice(0, 7);
    const best = bestHand(seven);
    assert.equal(best.cards.length, 5);
    assert.equal(new Set(best.cards).size, 5);
    for (const c of best.cards) assert.ok(seven.includes(c));
    assert.equal(evaluate5(best.cards).score, best.score);
  }
});
