// Công cụ dùng chung cho test engine: bàn mô phỏng, dựng bài theo kịch bản, kiểm tra bất biến.
import assert from 'node:assert/strict';
import { Game, createTableState, DELAY } from '../supabase/functions/poker/engine/game.js';
import { newDeck } from '../supabase/functions/poker/engine/cards.js';

export { DELAY };

/** PRNG có seed (mulberry32) để fuzz tái lập được. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // [lo, hi]
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (p) => next() < p;
  return next;
}

/** Game dùng trong test: bộ bài xáo theo seed + ghi lại chip của người rời bàn. */
export class TestGame extends Game {
  makeDeck() {
    const s = this.s;
    const r = rng((s._seed = ((s._seed || 1) * 1103515245 + 12345) >>> 0));
    const d = newDeck();
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
    return d;
  }
  removeSeat(seat) {
    const p = this.s.seats[seat];
    const m = this.s.match;
    if (p && m.active) {
      if (!this.s._rm || this.s._rm.no !== m.no) this.s._rm = { no: m.no, amt: 0 };
      this.s._rm.amt += p.stack + p.totalBet;
    }
    super.removeSeat(seat);
  }
}

/**
 * Bàn mô phỏng như server thật: mỗi thao tác = đọc JSON → Game → advance → thao tác → advance → ghi JSON.
 * (Đúng quy trình của Edge Function, nên bắt được lỗi mất dữ liệu khi serialize.)
 */
export class Table {
  constructor(opts = {}) {
    this.json = JSON.stringify(createTableState({
      name: 'test', ownerId: 'u0', smallBlind: 5, bigBlind: 10, startingStack: 1000,
      maxSeats: 6, actionTime: 30, ...opts,
    }));
    this.now = 1_000_000;
    this.stats = {};
    this.checks = opts.checks !== false;
  }
  get state() { return JSON.parse(this.json); }
  /** Chạy fn(game) như một request. Trả về kết quả fn. */
  run(fn, { advance = true } = {}) {
    const g = new TestGame(JSON.parse(this.json), this.now);
    if (advance) g.advance();
    const r = fn ? fn(g) : null;
    if (advance) g.advance();
    for (const [k, v] of Object.entries(g.deltas)) {
      this.stats[k] ||= { wins: 0, matches: 0 };
      this.stats[k].wins += v.wins;
      this.stats[k].matches += v.matches;
    }
    const out = JSON.stringify(g.s);
    assert.deepEqual(JSON.parse(out), g.s, 'state phải JSON round-trip nguyên vẹn');
    this.json = out;
    if (this.checks) checkInvariants(g.s, this);
    return r;
  }
  tick(ms = 0) { this.now += ms; return this.run(); }
  view(uid) { return this.run((g) => g.viewFor(uid)); }
  sit(uid, seat, name = uid) { return this.run((g) => g.sit({ id: uid, name }, seat)); }
  act(uid, action, amount) { return this.run((g) => g.act(uid, action, amount)); }
  uid(seat) { return this.state.seats[seat]?.userId; }
  legal(seat) { return this.run((g) => g.legalActions(seat)); }
  /** Người đang tới lượt */
  get toAct() { const h = this.state.hand; return h && h.phase === 'betting' ? h.toAct : -1; }
  /** Chờ tới khi có ván đang cược (hoặc hết hạn) */
  waitForAction(maxMs = 60_000) {
    for (let t = 0; t < maxMs; t += 250) {
      if (this.toAct !== -1) return true;
      this.tick(250);
    }
    return false;
  }
  startMatch() {
    this.tick(DELAY.matchStart);
    assert.ok(this.state.hand, 'match phải bắt đầu và chia ván đầu');
  }
  /** Chơi đến hết ván hiện tại bằng strategy(legal, seat) → [action, amount] */
  playHand(strategy) {
    const id = this.state.hand?.id;
    for (let i = 0; i < 500; i++) {
      const h = this.state.hand;
      if (!h || h.id !== id || h.phase === 'done') return;
      if (h.phase === 'betting') {
        const seat = h.toAct;
        const p = this.state.seats[seat];
        if (p.sittingOut) { this.tick(1); continue; }
        const [a, amt] = strategy(this.legal(seat), seat);
        const err = this.act(p.userId, a, amt);
        assert.equal(err, null, `hành động ${a} ${amt} bị từ chối: ${err}`);
      } else this.tick(500);
    }
    throw new Error('ván không kết thúc sau 500 bước');
  }
  finishHand() { for (let i = 0; i < 40 && this.state.hand; i++) this.tick(500); }
  /**
   * Bỏ ván hiện tại và chia ván mới với stack/button tuỳ chọn (chỉ dùng trong test kịch bản).
   * Tắt kiểm tra bảo toàn chip vì stack bị chỉnh tay.
   */
  dealNewHand({ stacks = {}, button } = {}) {
    const s = this.state;
    s.hand = null;
    s.pending = null;
    s.seats.forEach((p, i) => {
      if (!p) return;
      Object.assign(p, { inHand: false, folded: false, allIn: false, cards: [], bet: 0, totalBet: 0, acted: false,
        actedLevel: -1, lastAction: '', won: 0, handName: '', bestCards: [], revealed: false });
      if (i in stacks) p.stack = stacks[i];
    });
    if (button !== undefined) s.button = (button - 1 + s.maxSeats) % s.maxSeats;
    this.skipConservation = true;
    this.json = JSON.stringify(s);
    this.run((g) => g.maybeStartHand());
    return this.state.hand;
  }
  /** Sửa trực tiếp state (test) */
  patch(fn) { const s = this.state; fn(s); this.json = JSON.stringify(s); }
}

export const passive = (l) => [l.canCheck ? 'check' : 'call'];
export const shove = (l) => (l.canRaise ? ['raise', l.maxTo] : [l.canCall ? 'call' : 'check']);
export const folder = (l) => [l.canCheck ? 'check' : 'fold'];

/**
 * Dựng bài cho ván đang chạy: holes = { seat: ['As','Kd'] }, board = 5 lá.
 * Các lá còn lại xếp ngẫu nhiên phía dưới. Board lật theo thứ tự: burn, flop×3, burn, turn, burn, river.
 */
export function rig(table, holes, board = []) {
  const s = table.state;
  const used = new Set([...Object.values(holes).flat(), ...board]);
  assert.equal(used.size, Object.values(holes).flat().length + board.length, 'lá bị trùng trong kịch bản');
  for (const [seat, cards] of Object.entries(holes)) s.seats[seat].cards = [...cards];
  // Người trong ván không được chỉ định giữ bài cũ nếu không trùng
  for (const p of s.seats) if (p?.inHand) for (const c of p.cards) used.add(c);
  const rest = newDeck().filter((c) => !used.has(c));
  const seq = [];
  const street = s.hand.board.length;
  const take = () => rest.pop();
  if (street === 0) seq.push(take(), board[0] ?? take(), board[1] ?? take(), board[2] ?? take());
  if (street <= 3) seq.push(take(), board[3] ?? take());
  if (street <= 4) seq.push(take(), board[4] ?? take());
  s.hand.deck = [...rest, ...seq.reverse()];
  table.json = JSON.stringify(s);
}

// ───────────────────────── bất biến ─────────────────────────

const CARD_RE = /^[2-9TJQKA][shdc]$/;

export function checkInvariants(s, ctx = {}) {
  const seats = s.seats.filter(Boolean);
  for (const p of seats) {
    for (const k of ['stack', 'bet', 'totalBet']) {
      assert.ok(Number.isInteger(p[k]) && p[k] >= 0, `${p.name}.${k} = ${p[k]} không hợp lệ`);
    }
    assert.ok(p.totalBet >= p.bet, `${p.name}: totalBet < bet`);
    if (p.allIn && s.hand && s.hand.phase !== 'done') assert.equal(p.stack, 0, `${p.name} all-in nhưng còn chip`);
  }
  // không trùng người
  const ids = seats.map((p) => p.userId);
  assert.equal(new Set(ids).size, ids.length, 'một người ngồi 2 ghế');

  const h = s.hand;
  if (h) {
    // lá bài: hợp lệ, không trùng, tổng ≤ 52
    const all = [...h.deck, ...h.board];
    for (const p of seats) if (p.inHand) all.push(...p.cards);
    for (const c of all) assert.match(c, CARD_RE, `lá bài lạ: ${c}`);
    assert.equal(new Set(all).size, all.length, 'có lá bài bị trùng');
    assert.ok(all.length <= 52);
    const expectBoard = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 }[h.street];
    assert.equal(h.board.length, expectBoard, `board ${h.board.length} lá ở street ${h.street}`);
    for (const p of seats) if (p.inHand) assert.equal(p.cards.length, 2, `${p.name} không có đúng 2 lá`);
    for (const p of seats) if (!p.inHand) assert.equal(p.totalBet, 0, `${p.name} không trong ván mà có cược`);

    if (h.phase === 'betting') {
      const a = s.seats[h.toAct];
      assert.ok(a && a.inHand && !a.folded && !a.allIn, `toAct=${h.toAct} không thể hành động`);
      assert.ok(!a.acted || a.bet < h.currentBet, 'toAct đã hành động và đã đủ cược');
      assert.ok(h.deadline > 0, 'đang cược mà không có deadline');
      const maxBet = Math.max(0, ...seats.filter((p) => p.inHand).map((p) => p.bet));
      assert.ok(h.currentBet >= maxBet, 'currentBet nhỏ hơn cược lớn nhất');
      if (h.street !== 'preflop') assert.equal(h.currentBet, maxBet, 'currentBet sai sau preflop');
      assert.ok(h.minRaise >= s.bigBlind || h.minRaise > 0);
      assert.equal(s.pending, null, 'đang cược nhưng lại có sự kiện hẹn giờ');
    } else {
      assert.ok(s.pending, `ván ở phase ${h.phase} mà không có sự kiện tiếp theo → kẹt`);
    }
    const alive = seats.filter((p) => p.inHand && !p.folded);
    if (h.phase !== 'done') assert.ok(alive.length >= 2, 'còn < 2 người mà ván chưa kết thúc');
    if (h.phase === 'done') {
      assert.ok(h.results?.length, 'ván xong mà không có kết quả');
      for (const r of h.results) assert.ok(r.winners.length >= 1 && r.amount > 0);
    }
  }

  // chống kẹt khi không có ván
  const m = s.match;
  if (!h && m.active) {
    const alive = seats.filter((p) => m.participants.includes(p.userId) && !p.place && p.stack > 0 && !p.leaving);
    if (alive.length >= 2) assert.ok(s.pending, 'trận đang diễn ra nhưng không hẹn ván tiếp → kẹt');
  }
  if (!m.active) {
    for (const p of seats) assert.ok(!p.inHand || (h && h.phase === 'done'), 'không có trận mà vẫn có người trong ván');
  }

  // bảo toàn chip trong một match: Σ(stack + cược) + chip người đã rời = số người tham gia × chip khởi điểm
  if (m.active && !ctx.skipConservation) {
    const inPlay = s.seats.filter((p) => p && m.participants.includes(p.userId)).reduce((a, p) => a + p.stack + p.totalBet, 0);
    const removed = s._rm && s._rm.no === m.no ? s._rm.amt : 0;
    assert.equal(inPlay + removed, m.participants.length * s.startingStack, `chip không bảo toàn: ${inPlay}+${removed}`);
    for (const p of seats) if (!m.participants.includes(p.userId)) assert.equal(p.stack + p.totalBet, 0, `${p.name} không tham gia trận mà có chip`);
  }
  if (m.over) {
    const places = m.standings.map((x) => x.place);
    assert.ok(places.every((x) => x >= 1));
    if (m.winner) assert.equal(m.standings[0].userId, m.winner.userId);
  }
}

/** Kiểm tra view không làm lộ thông tin bí mật. */
export function checkViewPrivacy(state, view, viewerId) {
  const json = JSON.stringify({ ...view, log: [] }); // log chỉ chứa bài đã lật (kiểm tra riêng)
  assert.ok(!json.includes('"deck"'), 'view lộ bộ bài');
  assert.ok(!json.includes('passwordHash'), 'view lộ hash mật khẩu');
  const h = state.hand;
  state.seats.forEach((p, i) => {
    if (!p) return;
    const vs = view.seats[i];
    const mine = p.userId === viewerId;
    if (!mine && !p.revealed) {
      for (const c of vs.cards) assert.equal(c, null, `lộ bài của ${p.name} cho ${viewerId}`);
      assert.equal(vs.handName, '', `lộ tên bộ bài của ${p.name}`);
      for (const c of p.cards) {
        // lá tẩy của người khác không được xuất hiện ở đâu trong view (trừ khi trùng board — không thể)
        if (h && !h.board.includes(c)) assert.ok(!json.includes(`"${c}"`), `lá ${c} của ${p.name} lộ trong view`);
      }
    }
  });
}
