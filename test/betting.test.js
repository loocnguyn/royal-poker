// Test thanh cược 1 nút (public/js/betting.js) — kể cả kiểm chéo với engine thật.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betModel } from '../public/js/betting.js';
import { Table, DELAY, rng } from './helpers.js';

const legal = (o) => ({
  toCall: 0, canCheck: true, canCall: false, canRaise: true, isBet: true,
  minTo: 10, maxTo: 1000, myBet: 0, currentBet: 0, pot: 30, ...o,
});

test('không ai cược: đầu thanh = Check, kéo lên = Bet, hết cỡ = All-in', () => {
  const bm = betModel(legal());
  assert.equal(bm.callTo, 0);
  assert.deepEqual(bm.label(0), { text: 'Check', amount: null, kind: 'call' });
  assert.deepEqual(bm.action(0), { action: 'check' });
  assert.deepEqual(bm.label(50), { text: 'Bet', amount: 50, kind: 'raise' });
  assert.deepEqual(bm.action(50), { action: 'raise', amount: 50 });
  assert.deepEqual(bm.label(1000), { text: 'All-in', amount: 1000, kind: 'raise' });
});

test('bị cược: đầu thanh = Call đúng số chip còn thiếu, kéo lên = Raise tới', () => {
  // BB đã đặt 10, đối thủ raise lên 30 → cần call 20; min raise tới 50
  const bm = betModel(legal({ toCall: 20, canCheck: false, canCall: true, isBet: false, myBet: 10, currentBet: 30, minTo: 50, maxTo: 1000 }));
  assert.equal(bm.callTo, 30);
  assert.deepEqual(bm.label(30), { text: 'Call', amount: 20, kind: 'call' });
  assert.deepEqual(bm.action(30), { action: 'call' });
  assert.deepEqual(bm.label(80), { text: 'Raise', amount: 80, kind: 'raise' });
  assert.deepEqual(bm.action(80), { action: 'raise', amount: 80 });
});

test('giá trị giữa Call và Min-raise được làm tròn về mốc gần hơn', () => {
  const bm = betModel(legal({ toCall: 20, canCheck: false, canCall: true, isBet: false, myBet: 10, currentBet: 30, minTo: 50 }));
  assert.equal(bm.snap(35), 30); // gần Call hơn
  assert.equal(bm.snap(45), 50); // gần min-raise hơn
  assert.equal(bm.snap(-5), 30);
  assert.equal(bm.snap(99999), 1000);
  assert.equal(bm.snap('abc'), 30);
  assert.equal(bm.snap(''), 30);
});

test('call hết chip hiện "All-in"; không raise được thì không có thanh', () => {
  const bm = betModel(legal({ toCall: 200, canCheck: false, canCall: true, canRaise: false, myBet: 0, currentBet: 500, maxTo: 200 }));
  assert.equal(bm.canSlide, false);
  assert.deepEqual(bm.label(bm.callTo), { text: 'All-in', amount: 200, kind: 'call' });
  assert.deepEqual(bm.action(99999), { action: 'call' });
});

test('mức theo pot', () => {
  const bm = betModel(legal({ pot: 100, minTo: 10 }), 5);
  assert.equal(bm.potFraction(0.5), 50);
  assert.equal(bm.potFraction(1), 100);
  // raise: pot 60 (gồm cược 30 đối thủ), cần call 20 → pot-size raise = 30 + (60+20) = 110
  const bm2 = betModel(legal({ toCall: 20, canCheck: false, canCall: true, isBet: false, myBet: 10, currentBet: 30, minTo: 50, pot: 60 }), 5);
  assert.equal(bm2.potFraction(1), 110);
  assert.equal(bm2.potFraction(0.1), 50, 'nhỏ hơn min-raise → lên min-raise');
});

test('kiểm chéo với engine: mọi vị trí thanh kéo đều tạo hành động hợp lệ', () => {
  const r = rng(99);
  let checked = 0;
  for (let game = 0; game < 60; game++) {
    const n = r.int(2, 6);
    const t = new Table({ maxSeats: 6, smallBlind: 5, bigBlind: 10, startingStack: r.int(100, 3000), ante: r.pick([0, 2]) });
    for (let i = 0; i < n; i++) t.sit(`u${i}`, i);
    t.tick(DELAY.matchStart);
    for (let step = 0; step < 400 && t.state.match.active; step++) {
      const h = t.state.hand;
      if (!h || h.phase !== 'betting') { t.tick(1000); continue; }
      const seat = h.toAct;
      const L = t.legal(seat);
      const bm = betModel(L, 5);
      // Thử nhiều vị trí thanh (không thực hiện) — hành động phải hợp lệ với engine
      const probes = [bm.callTo, bm.max, L.minTo, bm.potFraction(0.5), bm.potFraction(1), r.int(bm.callTo, bm.max), r.int(bm.callTo, bm.max) + 0.4];
      for (const x of probes) {
        const a = bm.action(x);
        // kiểm tra trên bản sao state, không làm đổi bàn thật
        const copy = new Table();
        copy.json = t.json; copy.now = t.now; copy.checks = false;
        const e2 = copy.run((g) => g.act(t.uid(seat), a.action, a.amount), { advance: false });
        assert.equal(e2, null, `slider ${x} → ${JSON.stringify(a)} bị từ chối: ${e2} (legal ${JSON.stringify(L)})`);
        checked++;
      }
      const a = bm.action(r.chance(0.6) ? bm.callTo : r.int(bm.callTo, bm.max));
      assert.equal(t.act(t.uid(seat), a.action, a.amount), null);
    }
  }
  assert.ok(checked > 1000, `chỉ kiểm được ${checked} vị trí`);
});
