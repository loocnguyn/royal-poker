// Test luật No-Limit Hold'em theo từng kịch bản (bộ bài dựng sẵn).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Table, DELAY, rig, passive, folder, shove, checkViewPrivacy } from './helpers.js';
import { roundNice } from '../supabase/functions/poker/engine/game.js';

function mk(n, opts = {}, seats) {
  const t = new Table(opts);
  (seats || [...Array(n).keys()]).forEach((i) => t.sit(`u${i}`, i, `P${i}`));
  t.startMatch();
  return t;
}
const nextHand = (t) => { t.finishHand(); t.tick(DELAY.nextHand); };
const seat = (t, i) => t.state.seats[i];

describe('thứ tự hành động & nút dealer', () => {
  test('heads-up: SB là button, đi trước preflop, BB đi trước sau flop; button luân phiên', () => {
    const t = mk(2);
    let s = t.state;
    assert.equal(s.button, 0);
    assert.equal(s.hand.sb, 0);
    assert.equal(s.hand.bb, 1);
    assert.equal(t.toAct, 0);
    assert.equal(t.act('u0', 'call'), null);
    assert.equal(t.toAct, 1, 'BB có quyền option');
    const l = t.legal(1);
    assert.ok(l.canCheck && l.canRaise);
    t.act('u1', 'check');
    t.tick(DELAY.street);
    assert.equal(t.state.hand.street, 'flop');
    assert.equal(t.toAct, 1, 'sau flop BB (không phải button) đi trước');
    t.act('u1', 'check'); t.act('u0', 'check');
    t.tick(DELAY.street); t.act('u1', 'check'); t.act('u0', 'check');
    t.tick(DELAY.street); t.act('u1', 'check'); t.act('u0', 'check');
    t.tick(DELAY.street);
    assert.equal(t.state.hand.phase, 'done');
    nextHand(t);
    s = t.state;
    assert.equal(s.button, 1, 'button chuyển sang người kia');
    assert.equal(s.hand.sb, 1);
    assert.equal(t.toAct, 1);
  });

  test('3 người: UTG đi trước preflop, SB đi trước sau flop, BB được option khi mọi người limp', () => {
    const t = mk(3);
    const h = t.state.hand;
    assert.deepEqual([t.state.button, h.sb, h.bb, t.toAct], [0, 1, 2, 0]);
    t.act('u0', 'call');
    t.act('u1', 'call');
    assert.equal(t.toAct, 2);
    const l = t.legal(2);
    assert.ok(l.canCheck && l.canRaise && l.minTo === 20);
    t.act('u2', 'raise', 30);
    assert.equal(t.toAct, 0, 'raise của BB mở lại hành động');
    assert.ok(t.legal(0).canRaise);
    t.act('u0', 'call'); t.act('u1', 'call');
    t.tick(DELAY.street);
    assert.equal(t.state.hand.street, 'flop');
    assert.equal(t.toAct, 1, 'SB đi trước sau flop');
  });

  test('button bỏ qua ghế trống', () => {
    const t = mk(3, {}, [0, 2, 4]);
    const buttons = [];
    for (let i = 0; i < 4; i++) {
      buttons.push(t.state.button);
      t.playHand(folder);
      nextHand(t);
    }
    assert.deepEqual(buttons, [0, 2, 4, 0]);
  });

  test('button bỏ qua người đã bị loại', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 1000, 1: 1000, 2: 0 }, button: 0 });
    t.patch((s) => { s.seats[2].place = 3; s.match.standings.push({ userId: 'u2', name: 'P2', place: 3 }); });
    nextHand(t);
    const s = t.state;
    assert.ok(s.hand);
    assert.equal(s.seats[2].inHand, false, 'người bị loại không được chia bài');
  });
});

describe('cỡ cược & raise', () => {
  test('min-raise preflop tăng theo mức raise trước', () => {
    const t = mk(3);
    assert.equal(t.act('u0', 'raise', 15), 'Tối thiểu phải là 20');
    assert.equal(t.act('u0', 'raise', 30), null);
    assert.equal(t.legal(1).minTo, 50);
    assert.equal(t.act('u1', 'raise', 100), null);
    assert.equal(t.legal(2).minTo, 170);
    assert.equal(t.act('u2', 'raise', 169), 'Tối thiểu phải là 170');
    assert.equal(t.act('u2', 'raise', 170), null);
  });

  test('sau flop: bet tối thiểu = BB, raise tối thiểu = gấp đôi bet', () => {
    const t = mk(2);
    t.act('u0', 'call'); t.act('u1', 'check'); t.tick(DELAY.street);
    assert.equal(t.legal(1).minTo, 10);
    assert.equal(t.act('u1', 'raise', 5), 'Tối thiểu phải là 10');
    assert.equal(t.act('u1', 'raise', 40), null);
    assert.equal(t.state.seats[1].lastAction, 'Bet 40');
    assert.equal(t.legal(0).minTo, 80);
    assert.equal(t.legal(0).toCall, 40);
  });

  test('raise số thập phân / chuỗi / âm bị từ chối, không làm đổi state', () => {
    const t = mk(2);
    const before = t.json;
    for (const bad of [25.5, '30', -10, NaN, Infinity, null, undefined]) {
      const err = t.run((g) => g.act('u0', 'raise', bad), { advance: false });
      assert.ok(err, `phải từ chối ${bad}`);
    }
    assert.equal(t.json, before);
  });

  test('raise vượt stack = all-in', () => {
    const t = mk(2);
    t.act('u0', 'raise', 999999);
    assert.equal(seat(t, 0).stack, 0);
    assert.equal(seat(t, 0).allIn, true);
    assert.equal(seat(t, 0).lastAction, 'All-in');
  });

  test('all-in thiếu (không đủ min-raise) KHÔNG mở lại quyền raise', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 1000, 1: 1000, 2: 125 }, button: 0 }); // SB=1, BB=2 (125), UTG=0
    t.act('u0', 'raise', 100);
    t.act('u1', 'fold');
    t.act('u2', 'raise', 125); // all-in, raise 25 < 90
    assert.equal(t.toAct, 0);
    const l = t.legal(0);
    assert.equal(l.canRaise, false);
    assert.equal(l.toCall, 25);
    assert.equal(t.act('u0', 'raise', 300), 'Không thể raise lúc này');
  });

  test('raise đủ sau all-in thiếu thì mở lại quyền raise', () => {
    const t = mk(4);
    t.dealNewHand({ stacks: { 0: 125, 1: 1000, 2: 1000, 3: 1000 }, button: 0 }); // SB1 BB2 UTG3
    assert.equal(t.toAct, 3);
    t.act('u3', 'raise', 100);
    t.act('u0', 'raise', 125); // all-in thiếu
    t.act('u1', 'fold');
    assert.ok(t.legal(2).canRaise, 'BB chưa hành động nên vẫn được raise');
    t.act('u2', 'raise', 300); // raise 175 ≥ 90 → đủ
    assert.equal(t.toAct, 3);
    assert.ok(t.legal(3).canRaise, 'raise đủ mở lại quyền cho người đã hành động');
  });

  test('không được raise khi mọi đối thủ đã all-in', () => {
    const t = mk(2);
    t.dealNewHand({ stacks: { 0: 1000, 1: 200 }, button: 0 });
    t.act('u0', 'call');
    t.act('u1', 'raise', 200); // all-in
    const l = t.legal(0);
    assert.equal(l.canRaise, false);
    assert.equal(l.toCall, 190);
  });

  test('check khi đang bị cược / call khi không có gì → lỗi', () => {
    const t = mk(2);
    assert.equal(t.act('u0', 'check'), 'Không thể check');
    t.act('u0', 'call');
    assert.equal(t.act('u1', 'call'), 'Không có gì để call');
    assert.equal(t.act('u1', 'dance'), 'Hành động không hợp lệ');
    assert.equal(t.act('u0', 'check'), 'Chưa đến lượt bạn');
    assert.equal(t.act('ghost', 'check'), 'Bạn chưa ngồi');
  });
});

describe('blind, ante & chia pot', () => {
  test('BB all-in thiếu: người khác vẫn phải call đủ 1 BB; side pot đúng', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 1000, 1: 1000, 2: 6 }, button: 0 });
    rig(t, { 0: ['Kc', 'Kd'], 1: ['Qc', 'Qd'], 2: ['Ac', 'Ad'] }, ['2s', '7h', '9d', 'Js', '3c']);
    assert.equal(seat(t, 2).allIn, true);
    assert.equal(t.legal(0).toCall, 10);
    t.act('u0', 'call'); t.act('u1', 'call');
    t.playHand(passive);
    const h = t.state.hand;
    assert.deepEqual(h.results.map((r) => r.amount), [18, 8]);
    assert.deepEqual(h.results[0].winners, [2]);
    assert.deepEqual(h.results[1].winners, [0]);
    assert.equal(seat(t, 2).stack, 18);
    assert.equal(seat(t, 0).stack, 1000 - 10 + 8);
  });

  test('ante: mọi người đặt ante; người chỉ đủ ante vẫn được tranh main pot', () => {
    const t = mk(3, { ante: 2 });
    const s = t.state;
    assert.equal(s.seats[1].totalBet, 7);
    assert.equal(s.seats[2].totalBet, 12);
    assert.equal(s.seats[0].totalBet, 2);
    t.dealNewHand({ stacks: { 0: 2, 1: 1000, 2: 1000 }, button: 2 }); // SB0? button 2 → SB 0, BB 1
    assert.equal(seat(t, 0).allIn, true, 'ante hết chip → all-in');
    assert.equal(seat(t, 0).bet, 0, 'không thể post blind sau khi all-in vì ante');
    rig(t, { 0: ['Ac', 'Ad'], 1: ['Kc', 'Kd'], 2: ['Qc', 'Qd'] }, ['2s', '7h', '9d', 'Js', '3c']);
    t.playHand(passive);
    const r = t.state.hand.results;
    assert.equal(r[0].amount, 6, 'main pot = 3 × ante');
    assert.deepEqual(r[0].winners, [0]);
  });

  test('cược không ai theo được trả lại', () => {
    const t = mk(2);
    t.act('u0', 'call'); t.act('u1', 'check'); t.tick(DELAY.street);
    t.act('u1', 'raise', 500);
    t.act('u0', 'fold');
    const h = t.state.hand;
    assert.equal(h.results[0].amount, 20);
    assert.equal(seat(t, 1).stack, 1010);
    assert.equal(seat(t, 0).stack, 990);
    assert.ok(t.state.log.some((l) => l.text.includes('Trả lại 500')));
  });

  test('chia pot hoà: chip lẻ cho người đầu tiên bên trái button', () => {
    const t = mk(3);
    rig(t, { 0: ['2c', '3d'], 1: ['4c', '5d'], 2: ['2d', '3c'] }, ['Ah', 'Kh', 'Qh', 'Jh', 'Th']);
    t.act('u0', 'call'); t.act('u1', 'fold'); t.act('u2', 'check');
    t.playHand(passive);
    const r = t.state.hand.results[0];
    assert.equal(r.amount, 25);
    assert.deepEqual(r.winners, [2, 0], 'thứ tự: người gần bên trái button trước');
    assert.equal(seat(t, 2).stack, 1003);
    assert.equal(seat(t, 0).stack, 1002);
    assert.equal(seat(t, 1).stack, 995);
  });

  test('3 all-in khác nhau: main pot + side pot', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 100, 1: 300, 2: 1000 }, button: 0 });
    rig(t, { 0: ['Ac', 'Ad'], 1: ['Kc', 'Kd'], 2: ['2c', '2h'] }, ['7s', '8h', '9d', 'Jc', '3s']);
    t.act('u0', 'raise', 100);
    t.act('u1', 'raise', 300);
    t.act('u2', 'call');
    t.playHand(passive);
    const h = t.state.hand;
    assert.deepEqual(h.results.map((r) => [r.amount, r.winners]), [[300, [0]], [400, [1]]]);
    assert.deepEqual([0, 1, 2].map((i) => seat(t, i).stack), [300, 400, 700]);
  });

  test('all-in lớn không ai theo: phần dư được trả lại', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 100, 1: 300, 2: 1000 }, button: 0 });
    rig(t, { 0: ['2c', '2d'], 1: ['3c', '3d'], 2: ['Ac', 'Ad'] }, ['7s', '8h', '9d', 'Jc', 'Ks']);
    t.act('u0', 'raise', 100);
    t.act('u1', 'raise', 300);
    t.act('u2', 'raise', 1000);
    t.playHand(passive);
    assert.deepEqual([0, 1, 2].map((i) => seat(t, i).stack), [0, 0, 1400]);
  });

  test('tiền của người đã fold vẫn nằm trong pot (dead money)', () => {
    const t = mk(4);
    t.dealNewHand({ stacks: { 0: 100, 1: 1000, 2: 1000, 3: 1000 }, button: 0 }); // SB1 BB2 UTG3
    rig(t, { 0: ['Ac', 'Ad'], 1: ['4c', '5d'], 2: ['Kc', 'Kd'], 3: ['Qc', 'Qd'] }, ['7s', '8h', '2d', 'Jc', '3s']);
    t.act('u3', 'raise', 50);
    t.act('u0', 'raise', 100);
    t.act('u1', 'fold');
    t.act('u2', 'call');
    t.act('u3', 'fold');
    t.playHand(passive);
    const h = t.state.hand;
    assert.equal(h.results.reduce((a, r) => a + r.amount, 0), 255);
    assert.deepEqual(h.results[0].winners, [0]);
    assert.equal(seat(t, 0).stack, 255);
  });
});

describe('lật bài / úp bài', () => {
  test('all-in: tự chia hết board; không muck → lật bài ngay khi hết hành động', () => {
    const t = mk(2);
    t.act('u0', 'raise', 1000);
    t.act('u1', 'call');
    const v = t.view('spectator');
    assert.ok(v.seats[0].cards[0] && v.seats[1].cards[0], 'bài được lật khi all-in');
    checkViewPrivacy(t.state, v, 'spectator');
    for (let i = 0; i < 10 && t.state.hand.phase !== 'done'; i++) t.tick(DELAY.runout);
    assert.equal(t.state.hand.board.length, 5);
    assert.equal(t.state.hand.phase, 'done');
  });

  test('bàn "úp bài thua": all-in không lật; showdown chỉ lật người thắng', () => {
    const t = mk(2, { muckLosers: true });
    rig(t, { 0: ['Ac', 'Ad'], 1: ['Kc', 'Kd'] }, ['7s', '8h', '2d', 'Jc', '3s']);
    t.act('u0', 'raise', 1000);
    t.act('u1', 'call');
    let v = t.view('spectator');
    assert.deepEqual(v.seats[1].cards, [null, null]);
    for (let i = 0; i < 10 && t.state.hand.phase !== 'done'; i++) t.tick(DELAY.runout);
    v = t.view('spectator');
    assert.deepEqual(v.seats[0].cards, ['Ac', 'Ad']);
    assert.deepEqual(v.seats[1].cards, [null, null], 'người thua được úp bài');
    checkViewPrivacy(t.state, v, 'spectator');
    assert.ok(!t.state.log.some((l) => l.text.includes('Kc')), 'log không lộ bài người úp');
  });

  test('chia pot thì cả hai đều lật; nút "lật bài" chỉ dùng được khi ván xong', () => {
    const t = mk(2, { muckLosers: true });
    rig(t, { 0: ['2c', '3d'], 1: ['2d', '3c'] }, ['Ah', 'Kh', 'Qh', 'Jh', 'Th']);
    assert.equal(t.run((g) => g.show('u0')), 'Không thể lật bài lúc này');
    t.playHand(passive);
    const v = t.view('spectator');
    assert.ok(v.seats[0].cards[0] && v.seats[1].cards[0]);
  });

  test('người thua tự lật bài sau ván', () => {
    const t = mk(2, { muckLosers: true });
    rig(t, { 0: ['Ac', 'Ad'], 1: ['Kc', 'Kd'] }, ['7s', '8h', '2d', 'Jc', '3s']);
    t.playHand(passive);
    assert.equal(t.view('x').seats[1].cards[0], null);
    assert.equal(t.run((g) => g.show('u1')), null);
    assert.deepEqual(t.view('x').seats[1].cards, ['Kc', 'Kd']);
    assert.equal(t.run((g) => g.show('u1')), 'Không thể lật bài lúc này', 'không lật 2 lần');
  });

  test('view của từng người chơi & khán giả không lộ bài ở mọi thời điểm', () => {
    const t = mk(4);
    for (let n = 0; n < 6; n++) {
      for (let i = 0; i < 200 && t.state.hand && t.state.hand.phase !== 'done'; i++) {
        for (const u of ['u0', 'u1', 'u2', 'u3', 'spectator']) checkViewPrivacy(t.state, t.view(u), u);
        if (t.toAct >= 0) t.act(t.uid(t.toAct), ...passive(t.legal(t.toAct)));
        else t.tick(500);
      }
      nextHand(t);
    }
  });
});

describe('hết giờ & ngồi ngoài', () => {
  test('hết giờ: check nếu được, fold nếu đang bị cược; 2 lần → ngồi ngoài', () => {
    const t = mk(2);
    t.tick(30_001); // SB phải call → fold
    assert.equal(seat(t, 0).lastAction, 'Fold');
    assert.equal(seat(t, 0).timeouts, 1);
    nextHand(t); // u1 là SB/button
    t.act('u1', 'call');
    t.tick(30_001); // u0 là BB có quyền check → check
    assert.ok(t.state.log.some((l) => l.text === '(hết giờ) P0 check'), 'lần hết giờ thứ 2 vẫn được check miễn phí');
    assert.equal(seat(t, 0).sittingOut, true, '2 lần hết giờ → ngồi ngoài');
    assert.equal(t.state.log.filter((l) => l.text.includes('bị cho ngồi ngoài')).length, 1, 'log chỉ báo 1 lần');
  });

  test('người ngồi ngoài vẫn trả blind và tự fold ngay (kể cả khi được check)', () => {
    const t = mk(3);
    t.run((g) => g.setSitOut('u2', true));
    nextHand(t);
    const before = seat(t, 2).stack;
    for (let k = 0; k < 3; k++) { t.playHand(passive); nextHand(t); }
    assert.ok(seat(t, 2).stack < before, 'bị trừ blind');
    // quay lại chơi
    t.run((g) => g.setSitOut('u2', false));
    nextHand(t);
    assert.equal(seat(t, 2).sittingOut, false);
  });

  test('ngồi ngoài > 5 phút giữa trận → bị mời ra, tính là bị loại', () => {
    const t = mk(3);
    t.run((g) => g.setSitOut('u2', true));
    for (let i = 0; i < 2000 && seat(t, 2); i++) {
      if (t.toAct >= 0 && !seat(t, t.toAct).sittingOut) t.act(t.uid(t.toAct), ...folder(t.legal(t.toAct)));
      else t.tick(3000);
    }
    assert.equal(seat(t, 2), null);
    assert.ok(t.state.match.standings.some((x) => x.userId === 'u2'));
  });

  test('bỏ trống lâu (3 giờ) rồi có request: chỉ xử lý 1 lần hết giờ, không auto-fold dây chuyền', () => {
    const t = mk(3);
    const hid = t.state.hand.id;
    t.tick(3 * 3600_000);
    const s = t.state;
    assert.equal(s.hand.id, hid);
    const acted = s.seats.filter((p) => p && p.lastAction && !/^(SB|BB)/.test(p.lastAction));
    assert.equal(acted.length, 1);
    assert.ok(s.hand.deadline > t.now);
  });

  test('sự kiện hẹn giờ của ván cũ bị bỏ qua', () => {
    const t = mk(2);
    for (const type of ['showdown', 'street', 'cleanup']) {
      t.patch((s) => { s.pending = { type, at: 0, handId: 999 }; });
      t.tick(0);
      const s = t.state;
      assert.equal(s.hand.street, 'preflop', `không bị ${type} sai ván`);
      assert.equal(s.hand.phase, 'betting');
      assert.equal(s.pending, null);
    }
  });
});

describe('rời bàn', () => {
  test('rời bàn khi đang tới lượt: tự fold, đối thủ thắng match', () => {
    const t = mk(2);
    t.run((g) => g.leave('u0'));
    assert.equal(t.state.hand.phase, 'done');
    t.finishHand();
    const m = t.state.match;
    assert.equal(m.over, true);
    assert.equal(m.winner.userId, 'u1');
    assert.equal(seat(t, 0), null);
    assert.deepEqual(m.standings.map((x) => [x.userId, x.place]), [['u1', 1], ['u0', 2]]);
  });

  test('rời bàn khi chưa tới lượt (3 người): fold ngay, ván tiếp tục, rời hẳn sau ván', () => {
    const t = mk(3);
    t.run((g) => g.leave('u2')); // BB, chưa tới lượt
    assert.equal(seat(t, 2).folded, true);
    assert.equal(seat(t, 2).leaving, true);
    assert.equal(t.state.hand.phase, 'betting');
    t.playHand(passive);
    t.finishHand();
    assert.equal(seat(t, 2), null);
    assert.equal(t.state.match.active, true, 'còn 2 người → trận tiếp tục');
  });

  test('người rời bàn là người cuối cùng cần hành động → vòng cược kết thúc đúng', () => {
    const t = mk(3);
    t.act('u0', 'call');
    t.act('u1', 'call');
    t.run((g) => g.leave('u0')); // toAct là u2 (BB)
    assert.equal(t.toAct, 2);
    t.act('u2', 'check');
    t.tick(DELAY.street);
    assert.equal(t.state.hand.street, 'flop');
  });

  test('rời bàn giữa 2 ván → xếp hạng; người chờ trận sau rời không ảnh hưởng', () => {
    const t = mk(3);
    t.run((g) => g.sit({ id: 'late', name: 'Late' }, 5));
    t.run((g) => g.leave('late'));
    assert.equal(seat(t, 5), null);
    assert.equal(t.state.match.standings.length, 0);
    t.playHand(folder);
    t.finishHand(); // đang chờ ván tiếp
    t.run((g) => g.leave('u1'));
    assert.equal(t.state.match.standings[0].userId, 'u1');
    assert.equal(t.state.match.standings[0].place, 3);
  });
});

describe('match, xếp hạng & rematch', () => {
  function bust(t, loserSeat, winnerSeat) {
    const s = t.state;
    const holes = {};
    for (const [i, p] of s.seats.entries()) if (p?.inHand) holes[i] = i === winnerSeat ? ['Ac', 'Ad'] : i === loserSeat ? ['2c', '7d'] : ['3h', '8s'];
    rig(t, holes, ['Ks', 'Qh', '9d', '5c', '4s']);
  }

  test('bị loại lần lượt → hạng 3, 2, vô địch; thống kê thắng/trận', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 100, 1: 1000, 2: 1900 }, button: 1 }); // SB2 BB0 UTG1
    bust(t, 0, 2);
    t.playHand((l, s) => (s === 1 ? folder(l) : shove(l)));
    t.finishHand();
    assert.equal(seat(t, 0).place, 3);
    t.tick(DELAY.nextHand);
    bust(t, 1, 2);
    t.playHand(shove);
    t.finishHand();
    const m = t.state.match;
    assert.equal(m.over, true);
    assert.deepEqual(m.standings.map((x) => [x.userId, x.place]), [['u2', 1], ['u1', 2], ['u0', 3]]);
    assert.deepEqual(t.stats.u2, { wins: 1, matches: 1 });
    assert.deepEqual(t.stats.u0, { wins: 0, matches: 1 });
  });

  test('2 người cháy túi cùng ván → cùng hạng', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 100, 1: 100, 2: 2800 }, button: 0 });
    rig(t, { 0: ['2c', '7d'], 1: ['3c', '8d'], 2: ['Ac', 'Ad'] }, ['Ks', 'Qh', '9d', '5c', '4s']);
    t.playHand(shove);
    t.finishHand();
    const m = t.state.match;
    assert.equal(m.over, true);
    assert.equal(m.winner.userId, 'u2');
    assert.deepEqual(m.standings.map((x) => x.place), [1, 2, 2]);
  });

  test('rematch: chỉ người bấm được vào; chip & blind reset; người mới vào lúc chờ tự sẵn sàng', () => {
    const t = mk(3, { blindUp: { mode: 'hands', every: 1, factor: 2 } });
    for (let i = 0; i < 3; i++) { t.playHand(folder); nextHand(t); }
    assert.ok(t.state.bigBlind > 10, 'blind đã tăng');
    t.run((g) => { g.leave('u0'); });
    t.finishHand();
    t.run((g) => { g.leave('u1'); });
    t.finishHand();
    assert.equal(t.state.match.over, true);
    assert.equal(t.run((g) => g.rematch('ghost')), 'Bạn chưa ngồi');
    t.run((g) => g.rematch('u2'));
    assert.equal(t.state.pending, null, 'mới 1 người sẵn sàng → chưa đếm ngược');
    t.sit('new', 4, 'Newbie');
    assert.equal(t.state.pending.type, 'matchStart');
    t.tick(DELAY.rematch);
    const s = t.state;
    assert.equal(s.match.no, 2);
    assert.equal(s.match.active, true);
    assert.equal(s.bigBlind, 10, 'blind về level 0');
    assert.deepEqual(s.match.participants.sort(), ['new', 'u2']);
    assert.equal(s.seats[2].stack + s.seats[2].totalBet, 1000);
    assert.equal(t.run((g) => g.rematch('u2')), 'Chưa có match nào kết thúc');
  });

  test('người không bấm rematch sẽ chờ, không được chia bài', () => {
    const t = mk(3);
    t.run((g) => g.leave('u0'));
    t.finishHand();
    t.run((g) => g.leave('u1'));
    t.finishHand();
    t.sit('a', 0); t.sit('b', 1);
    t.tick(DELAY.rematch);
    const s = t.state;
    assert.equal(s.seats[2].waiting, true);
    assert.equal(s.seats[2].inHand, false);
    assert.equal(s.seats[2].stack, 0);
  });

  test('đếm ngược bắt đầu bị huỷ khi thiếu người', () => {
    const t = new Table({ minPlayers: 3 });
    t.sit('a', 0); t.sit('b', 1); t.sit('c', 2);
    assert.equal(t.state.pending.type, 'matchStart');
    t.run((g) => g.leave('c'));
    assert.equal(t.state.pending, null);
    t.tick(DELAY.matchStart * 2);
    assert.equal(t.state.match.active, false);
    t.run((g) => g.setSitOut('a', true));
    t.sit('c', 2); t.sit('d', 3);
    t.tick(DELAY.matchStart);
    assert.deepEqual(t.state.match.participants.sort(), ['b', 'c', 'd'], 'người ngồi ngoài không vào trận');
  });

  test('vào muộn: tắt → chờ; bật → chơi luôn với chip khởi điểm', () => {
    const t = mk(2);
    t.sit('x', 3);
    assert.equal(seat(t, 3).waiting, true);
    const t2 = mk(2, { lateJoin: true });
    t2.sit('x', 3);
    assert.equal(seat(t2, 3).stack, 1000);
    t2.playHand(folder);
    nextHand(t2);
    assert.equal(seat(t2, 3).inHand, true);
  });

  test('ngồi: ghế đã có người / ghế không hợp lệ / ngồi 2 ghế', () => {
    const t = new Table();
    t.sit('a', 0);
    assert.equal(t.run((g) => g.sit({ id: 'b', name: 'b' }, 0)), 'Ghế đã có người');
    assert.equal(t.run((g) => g.sit({ id: 'b', name: 'b' }, 6)), 'Ghế không hợp lệ');
    assert.equal(t.run((g) => g.sit({ id: 'b', name: 'b' }, -1)), 'Ghế không hợp lệ');
    assert.equal(t.run((g) => g.sit({ id: 'b', name: 'b' }, 1.5)), 'Ghế không hợp lệ');
    assert.equal(t.run((g) => g.sit({ id: 'a', name: 'a' }, 2)), 'Bạn đã ngồi ở bàn này');
  });
});

describe('tăng blind', () => {
  test('theo phút', () => {
    const t = mk(2, { startingStack: 5000, blindUp: { mode: 'minutes', every: 1, factor: 2 } });
    assert.equal(t.state.bigBlind, 10);
    t.playHand(folder);
    t.finishHand();
    t.tick(61_000);
    assert.equal(t.state.bigBlind, 20);
    assert.equal(t.state.smallBlind, 10);
  });

  test('làm tròn đẹp', () => {
    assert.deepEqual([15, 22.5, 33.75, 75, 112, 168.75, 253, 380, 5.4].map(roundNice), [15, 20, 30, 75, 120, 150, 250, 400, 5]);
  });

  test('SB luôn nhỏ hơn BB ở mọi level', () => {
    for (const [sb, bb] of [[1, 2], [5, 10], [25, 50], [10, 25], [50, 100]]) {
      const t = mk(2, { smallBlind: sb, bigBlind: bb, startingStack: 1e6, blindUp: { mode: 'hands', every: 1, factor: 1.5 } });
      for (let i = 0; i < 12; i++) {
        const s = t.state;
        assert.ok(s.smallBlind < s.bigBlind && s.smallBlind >= 1, `${s.smallBlind}/${s.bigBlind}`);
        t.playHand(folder);
        nextHand(t);
      }
    }
  });
});

describe('rời bàn trong lúc tự lật bài (all-in)', () => {
  test('người đã all-in rời bàn: bài vẫn còn hiệu lực, vẫn có thể thắng', () => {
    const t = mk(2);
    rig(t, { 0: ['Ac', 'Ad'], 1: ['Kc', 'Kd'] }, ['7s', '8h', '2d', 'Jc', '3s']);
    t.act('u0', 'raise', 1000);
    t.act('u1', 'call');
    t.run((g) => g.leave('u0'));
    assert.equal(seat(t, 0).folded, false, 'không được fold bài all-in');
    for (let i = 0; i < 10 && t.state.hand?.phase !== 'done'; i++) t.tick(DELAY.runout);
    assert.deepEqual(t.state.hand.results[0].winners, [0], 'AA vẫn thắng dù đã rời bàn');
    t.finishHand();
    assert.equal(seat(t, 0), null);
    assert.equal(t.state.match.over, true);
    assert.equal(t.state.match.winner.userId, 'u1', 'người rời bàn không thể vô địch');
  });

  test('rời bàn giữa 2 vòng cược khiến chỉ còn 1 người → thắng ngay', () => {
    const t = mk(3);
    t.dealNewHand({ stacks: { 0: 1000, 1: 1000, 2: 100 }, button: 0 });
    t.act('u0', 'call'); t.act('u1', 'call'); t.act('u2', 'raise', 100); // u2 all-in
    t.act('u0', 'call'); t.act('u1', 'fold');
    assert.equal(t.state.hand.phase, 'transition');
    t.run((g) => g.leave('u0'));
    const h = t.state.hand;
    assert.equal(h.phase, 'done');
    assert.deepEqual(h.results[0].winners, [2]);
  });
});
