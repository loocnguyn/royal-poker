// Test phần client chạy được trong Node: vẽ lá bài SVG, chip, đọc tên bài tiếng Việt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFace, cardBack, chipSVG, chipStack, chipColor, suitColor } from '../public/js/cards.js';
import { cardNameVi, handNameVi, holeCardsSpeech } from '../public/js/voice.js';
import { newDeck } from '../supabase/functions/poker/engine/cards.js';
import { bestHand } from '../supabase/functions/poker/engine/evaluator.js';

const svgOk = (svg, label) => {
  assert.ok(svg.startsWith('<svg'), `${label}: không phải SVG`);
  assert.ok(svg.trim().endsWith('</svg>'), `${label}: SVG không đóng`);
  assert.ok(!/undefined|NaN|null|\[object/.test(svg), `${label}: có giá trị lỗi trong SVG`);
  // cân bằng thẻ <g>
  assert.equal((svg.match(/<g[\s>]/g) || []).length, (svg.match(/<\/g>/g) || []).length, `${label}: <g> không cân`);
  // id của defs không trùng trong cùng một lá
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `${label}: id trùng`);
};

test('vẽ được đủ 52 lá (2 màu & 4 màu) và mặt sau', () => {
  for (const c of newDeck()) {
    svgOk(cardFace(c), c);
    svgOk(cardFace(c, { fourColor: true }), c + ' 4 màu');
  }
  for (const th of ['red', 'blue', 'black', 'khác']) svgOk(cardBack(th), 'back ' + th);
});

test('mỗi lá có id defs khác nhau giữa các lần vẽ (không xung đột gradient trên cùng trang)', () => {
  const a = cardFace('As'), b = cardFace('As');
  const idA = a.match(/id="(bg\d+)"/)[1], idB = b.match(/id="(bg\d+)"/)[1];
  assert.notEqual(idA, idB);
});

test('số pip đúng với lá 2–10, lá hình có khung, lá A có 1 chất lớn', () => {
  for (const r of ['2', '3', '4', '5', '6', '7', '8', '9', 'T']) {
    const n = r === 'T' ? 10 : Number(r);
    const svg = cardFace(r + 'h');
    // 2 pip ở góc + n pip ở giữa; mỗi pip là 1 <g transform=...> bọc path chất cơ
    const pips = (svg.match(/<g transform="(rotate\(180 \d+(\.\d+)? \d+(\.\d+)?\) )?translate/g) || []).length;
    assert.equal(pips, n + 2, `lá ${r}: ${pips} pip`);
  }
  for (const r of ['J', 'Q', 'K']) assert.ok(cardFace(r + 's').includes('clip-path'), `lá ${r} phải có khung hình`);
});

test('màu chất bài', () => {
  assert.equal(suitColor('h'), suitColor('d'));
  assert.equal(suitColor('s'), suitColor('c'));
  assert.notEqual(suitColor('h'), suitColor('s'));
  const four = new Set(['s', 'h', 'd', 'c'].map((s) => suitColor(s, true)));
  assert.equal(four.size, 4);
});

test('chip: màu theo mệnh giá, SVG hợp lệ với mọi số tiền', () => {
  for (const amt of [0, 1, 4, 5, 24, 25, 99, 100, 499, 500, 999, 1000, 4999, 5000, 25000, 100000, 1_000_000, 9e9]) {
    assert.ok(chipColor(amt), `không có màu cho ${amt}`);
    svgOk(chipSVG(amt), `chip ${amt}`);
    assert.ok(chipStack(amt).includes('chip-layer'));
  }
  assert.notEqual(chipColor(5)[1], chipColor(100)[1]);
});

test('tên lá bài tiếng Việt đủ 52 lá, không trùng', () => {
  const names = newDeck().map(cardNameVi);
  for (const n of names) assert.ok(!/undefined/.test(n), n);
  assert.equal(new Set(names).size, 52);
  assert.equal(cardNameVi('Ah'), 'Át cơ');
  assert.equal(cardNameVi('Ks'), 'Già bích');
  assert.equal(cardNameVi('Qd'), 'Đầm rô');
  assert.equal(cardNameVi('Jc'), 'Bồi chuồn');
  assert.equal(cardNameVi('Td'), 'Mười rô');
  assert.equal(cardNameVi('2c'), 'Hai chuồn');
});

test('đọc tên bộ bài bằng tiếng Việt cho mọi loại', () => {
  const cases = [
    ['Ah Kh Qh Jh Th 2c 3d', 'Thùng phá sảnh hoàng gia'],
    ['9h 8h 7h 6h 5h 2c 3d', 'Thùng phá sảnh đến Chín'],
    ['9s 9h 9d 9c 2s 3h 4d', 'Tứ quý Chín'],
    ['Ks Kh Kd 2c 2s 7h 8d', 'Cù lũ Già đầy Hai'],
    ['2h 7h 9h Jh Kh 3c 4d', 'Thùng, Già cao nhất'],
    ['As 2d 3c 4h 5s 9c Kd', 'Sảnh đến Năm'],
    ['7s 7h 7d Kc 2s 9h 4d', 'Sám cô Bảy'],
    ['Js Jh 4d 4c 2s 9h Ad', 'Hai đôi, Bồi và Bốn'],
    ['Qs Qh 4d 7c 2s 9h Ad', 'Đôi Đầm'],
    ['As Jh 4d 7c 2s 9h 8d', 'Mậu thầu, Át cao nhất'],
  ];
  for (const [cards, text] of cases) {
    const b = bestHand(cards.split(' '));
    assert.equal(handNameVi({ category: b.category, ranks: b.ranks }), text);
  }
  assert.equal(handNameVi(null), '');
});

test('chỉ đọc bài trên tay', () => {
  assert.equal(holeCardsSpeech(['Ah', 'Kd']), 'Át cơ, Già rô.');
  assert.equal(holeCardsSpeech(['2c', 'Ts']), 'Hai chuồn, Mười bích.');
  assert.equal(holeCardsSpeech([]), 'Bạn chưa có bài.');
  assert.equal(holeCardsSpeech([null, null]), 'Bạn chưa có bài.');
  assert.equal(holeCardsSpeech(undefined), 'Bạn chưa có bài.');
});
