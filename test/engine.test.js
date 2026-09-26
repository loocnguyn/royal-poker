import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestHand } from '../supabase/functions/poker/engine/evaluator.js';
import { Game, createTableState, DELAY } from '../supabase/functions/poker/engine/game.js';

const score = (cards) => bestHand(cards.split(' ')).score;

test('thứ tự bộ bài', () => {
  const order = [
    '2c 7d 9h Js Ks', '2c 2d 9h Js Ks', '2c 2d 9h 9s Ks', '2c 2d 2h 9s Ks',
    'Ac 2d 3h 4s 5s', '6c 2d 3h 4s 5s', '2h 7h 9h Jh Kh', '2c 2d 2h 9s 9c',
    '2c 2d 2h 2s 9c', 'Ah 2h 3h 4h 5h', 'Th Jh Qh Kh Ah',
  ].map(score);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `index ${i}`);
  assert.equal(bestHand('Th Jh Qh Kh Ah 2c 3d'.split(' ')).name, 'Thùng phá sảnh Hoàng gia');
  assert.equal(score('Ks Kd 9h 8s 2c'), score('Kh Kc 9d 8c 2s'));
  assert.ok(score('Ks Kd As 8s 2c') > score('Kh Kc Qd Jc 9s'));
});

// ── mô phỏng: n người ngồi, match tự bắt đầu, (tuỳ chọn) chỉnh stack ──
function setup(n, opts = {}, stacks) {
  const state = createTableState({
    name: 't', ownerId: 'u0', smallBlind: 5, bigBlind: 10, startingStack: 1000,
    maxSeats: 6, actionTime: 30, ...opts,
  });
  let now = 1_000_000;
  const stats = {};
  const run = (fn) => {
    const g = new Game(state, now);
    g.advance();
    const r = fn ? fn(g) : null;
    g.advance();
    for (const [k, v] of Object.entries(g.deltas)) {
      stats[k] ||= { wins: 0, matches: 0 };
      stats[k].wins += v.wins; stats[k].matches += v.matches;
    }
    return r;
  };
  for (let i = 0; i < n; i++) run((g) => g.sit({ id: 'u' + i, name: 'P' + i }, i));
  const tick = (ms = 10_000) => { now += ms; run(); };
  const t = { state, run, tick, stats, uid: (s) => state.seats[s].userId };
  if (stacks) {
    // Chỉnh stack ngay trước khi match bắt đầu (để test side pot)
    now += DELAY.matchStart;
    const g = new Game(state, now);
    g.s.pending = null;
    g.startMatch = g.startMatch.bind(g);
    // bắt đầu match nhưng đặt stack trước khi chia ván đầu
    const orig = g.maybeStartHand.bind(g);
    g.maybeStartHand = () => { stacks.forEach((v, i) => (state.seats[i].stack = v)); orig(); };
    g.startMatch();
  }
  return t;
}

function startFirstHand(t) {
  t.tick(DELAY.matchStart);
  assert.ok(t.state.hand, 'ván đầu phải bắt đầu');
}

// Chơi đến khi ván kết thúc
function playOut(t, strategy) {
  for (let i = 0; i < 300; i++) {
    const h = t.state.hand;
    if (!h || h.phase === 'done') return;
    if (h.phase === 'betting') {
      const seat = h.toAct;
      if (t.state.seats[seat].sittingOut) { t.tick(1); continue; } // tự fold
      const legal = t.run((g) => g.legalActions(seat));
      const [a, amt] = strategy(legal);
      const err = t.run((g) => g.act(t.uid(seat), a, amt));
      if (err) throw new Error(err);
    } else t.tick(1000);
  }
  throw new Error('ván không kết thúc');
}
const shove = (l) => (l.canRaise ? ['raise', l.maxTo] : [l.canCall ? 'call' : 'check']);
const passive = (l) => [l.canCall ? 'call' : 'check'];
const nextHand = (t) => { t.tick(DELAY.afterShowdown + 10); t.tick(DELAY.nextHand + 10); };

test('match tự bắt đầu sau đếm ngược, mọi người cùng chip khởi điểm', () => {
  const t = setup(1);
  t.tick(DELAY.matchStart);
  assert.equal(t.state.hand, null, '1 người thì không bắt đầu');
  t.run((g) => g.sit({ id: 'u1', name: 'P1' }, 1));
  assert.equal(t.state.pending.type, 'matchStart');
  t.tick(DELAY.matchStart);
  assert.ok(t.state.hand);
  assert.equal(t.state.match.no, 1);
  const total = t.state.seats.filter(Boolean).reduce((a, p) => a + p.stack + p.totalBet, 0);
  assert.equal(total, 2000);
});

test('minPlayers: chờ đủ 3 người mới bắt đầu', () => {
  const t = setup(2, { minPlayers: 3 });
  t.tick(DELAY.matchStart * 2);
  assert.equal(t.state.hand, null);
  t.run((g) => g.sit({ id: 'u2', name: 'P2' }, 2));
  t.tick(DELAY.matchStart);
  assert.ok(t.state.hand);
});

test('heads-up: button là SB, hành động trước preflop', () => {
  const t = setup(2);
  startFirstHand(t);
  const h = t.state.hand;
  assert.equal(h.sb, t.state.button);
  assert.equal(h.toAct, h.sb);
  assert.equal(t.state.seats[h.sb].bet, 5);
  assert.equal(t.state.seats[h.bb].bet, 10);
});

test('3 người: min-raise, fold hết thì thắng pot', () => {
  const t = setup(3);
  startFirstHand(t);
  const utg = t.state.hand.toAct;
  assert.equal(t.run((g) => g.act(t.uid(utg), 'raise', 15)), 'Tối thiểu phải là 20');
  assert.equal(t.run((g) => g.act(t.uid(utg), 'raise', 30)), null);
  let s = t.state.hand.toAct;
  assert.equal(t.run((g) => g.legalActions(s).minTo), 50);
  t.run((g) => g.act(t.uid(s), 'fold'));
  s = t.state.hand.toAct;
  t.run((g) => g.act(t.uid(s), 'fold'));
  assert.equal(t.state.hand.phase, 'done');
  assert.equal(t.state.seats[utg].stack, 1015);
});

test('side pot: all-in ngắn chỉ thắng được main pot', () => {
  const t = setup(3, {}, [100, 500, 500]);
  assert.ok(t.state.hand);
  playOut(t, shove);
  const h = t.state.hand;
  assert.equal(h.board.length, 5);
  assert.equal(h.results.reduce((a, r) => a + r.amount, 0), 1100);
  assert.equal(h.results[0].amount, 300);
  assert.equal(t.state.seats.filter(Boolean).reduce((a, p) => a + p.stack, 0), 1100);
});

test('all-in thiếu (incomplete raise) không mở lại quyền raise', () => {
  const t = setup(3, {}, [1000, 1000, 125]);
  const st = t.state;
  const a = st.hand.toAct;
  t.run((g) => g.act(t.uid(a), 'raise', 100));
  let b = st.hand.toAct;
  let guard = 0;
  while (st.seats[b].stack + st.seats[b].bet !== 125 && guard++ < 3) { t.run((g) => g.act(t.uid(b), 'call')); b = st.hand.toAct; }
  t.run((g) => g.act(t.uid(b), 'raise', 125));
  assert.equal(st.seats[b].allIn, true);
  while (st.hand.phase === 'betting' && st.hand.toAct !== a) t.run((g) => g.act(t.uid(st.hand.toAct), 'call'));
  if (st.hand.phase === 'betting') {
    const legal = t.run((g) => g.legalActions(a));
    assert.equal(legal.canRaise, false);
    assert.equal(legal.toCall, 25);
  }
});

test('hết giờ: tự fold', () => {
  const t = setup(2);
  startFirstHand(t);
  const first = t.state.hand.toAct;
  t.tick(31_000);
  assert.equal(t.state.seats[first].folded, true);
});

test('ngồi ngoài giữa trận vẫn bị chia bài, trả blind và tự fold (không né blind)', () => {
  const t = setup(3);
  startFirstHand(t);
  t.run((g) => g.setSitOut('u2', true));
  for (let k = 0; k < 4; k++) { playOut(t, passive); nextHand(t); }
  assert.ok(t.state.seats[2].stack < 1000, 'người ngồi ngoài bị mất blind');
});

test('match: còn 1 người có chip → vô địch, xếp hạng, rematch reset chip', () => {
  const t = setup(3);
  startFirstHand(t);
  for (let k = 0; k < 50 && t.state.match.active; k++) { playOut(t, shove); nextHand(t); }
  const m = t.state.match;
  assert.equal(m.over, true);
  assert.ok(m.winner);
  assert.equal(m.standings[0].place, 1);
  assert.equal(m.standings[0].userId, m.winner.userId);
  assert.equal(t.stats[m.winner.userId].wins, 1);
  for (let i = 0; i < 3; i++) assert.equal(t.stats['u' + i].matches, 1);

  t.run((g) => g.rematch('u0'));
  t.run((g) => g.rematch('u1'));
  t.tick(DELAY.rematch);
  assert.ok(t.state.hand, 'rematch bắt đầu');
  assert.equal(t.state.match.no, 2);
  assert.equal(t.state.seats[2].waiting, true); // u2 không bấm rematch
  assert.equal(t.state.seats[2].inHand, false);
  const total = [0, 1].reduce((a, i) => a + t.state.seats[i].stack + t.state.seats[i].totalBet, 0);
  assert.equal(total, 2000);
});

test('vào giữa trận: chờ trận sau (hoặc chơi luôn nếu bật vào muộn)', () => {
  const t = setup(2);
  startFirstHand(t);
  t.run((g) => g.sit({ id: 'u5', name: 'Late' }, 5));
  assert.equal(t.state.seats[5].waiting, true);
  assert.equal(t.state.seats[5].stack, 0);

  const t2 = setup(2, { lateJoin: true });
  startFirstHand(t2);
  t2.run((g) => g.sit({ id: 'u5', name: 'Late' }, 5));
  assert.equal(t2.state.seats[5].stack, 1000);
  assert.ok(t2.state.match.participants.includes('u5'));
});

test('rời bàn giữa trận → người còn lại vô địch', () => {
  const t = setup(2);
  startFirstHand(t);
  t.run((g) => g.leave('u0'));
  for (let i = 0; i < 5 && t.state.hand; i++) t.tick(7000);
  assert.equal(t.state.match.over, true);
  assert.equal(t.state.match.winner.userId, 'u1');
  assert.equal(t.state.seats[0], null);
});

test('úp bài thua: view không lộ bài người thua & không lộ bộ bài', () => {
  const t = setup(2, { muckLosers: true });
  startFirstHand(t);
  const v = t.run((g) => g.viewFor('u0'));
  assert.deepEqual(v.seats[1].cards, [null, null]);
  assert.ok(v.seats[0].cards[0]);
  playOut(t, passive);
  const h = t.state.hand;
  const winnerSeats = new Set(h.results.flatMap((r) => r.winners));
  const view = t.run((g) => g.viewFor('spectator'));
  view.seats.slice(0, 2).forEach((p, i) => {
    if (winnerSeats.has(i)) assert.ok(p.cards[0]);
    else assert.equal(p.cards[0], null);
  });
  assert.ok(!JSON.stringify(view).includes('"deck"'));
});

test('tăng blind sau mỗi N ván', () => {
  const t = setup(2, { startingStack: 5000, blindUp: { mode: 'hands', every: 2, factor: 2 } });
  startFirstHand(t);
  const bbs = [];
  for (let hand = 0; hand < 5; hand++) {
    assert.ok(t.state.hand, 'ván ' + hand);
    bbs.push(t.state.bigBlind);
    t.run((g) => g.act(t.uid(t.state.hand.toAct), 'fold'));
    t.tick(DELAY.afterFold + 10);
    t.tick(DELAY.nextHand + 10);
  }
  assert.deepEqual(bbs, [10, 10, 20, 20, 40]);
});

test('ngồi ngoài quá 5 phút lúc không có trận → tự rời bàn', () => {
  const t = setup(1);
  t.run((g) => g.setSitOut('u0', true));
  t.tick(DELAY.sitOutKick);
  assert.equal(t.state.seats[0], null);
});
