// Engine No-Limit Texas Hold'em dạng "serverless":
//  - Toàn bộ trạng thái là JSON thuần (lưu trong Postgres).
//  - Không dùng setTimeout: mọi hẹn giờ là mốc thời gian (pending.at, hand.deadline),
//    được xử lý khi có request gọi advance().
//  - Mô hình giải đấu (Sit & Go): ai vào cũng nhận đúng chip khởi điểm, chip chỉ tồn tại trong match.
//  - Thống kê (thắng/số trận) gom vào `deltas` để commit nguyên tử cùng trạng thái bàn.
import { newDeck, shuffle, rankValue } from './cards.js';
import { bestHand } from './evaluator.js';

export const DELAY = {
  street: 800,          // nghỉ giữa các vòng cược
  runout: 1600,         // tự lật bài khi mọi người all-in
  afterFold: 2500,      // sau khi thắng do mọi người bỏ bài
  afterShowdown: 6000,  // xem kết quả showdown
  nextHand: 1500,
  matchStart: 8000,     // đếm ngược trước match đầu tiên (chờ người vào thêm)
  rematch: 5000,        // đếm ngược trước khi bắt đầu rematch
  sitOutKick: 5 * 60_000, // ngồi ngoài quá 5 phút thì tự rời bàn
};

export function createTableState(o) {
  return {
    name: o.name,
    ownerId: o.ownerId,
    passwordHash: o.passwordHash || '',
    smallBlind: o.smallBlind,
    bigBlind: o.bigBlind,
    ante: o.ante || 0,
    startingStack: o.startingStack,
    minPlayers: Math.min(o.minPlayers || 2, o.maxSeats),
    lateJoin: !!o.lateJoin,
    maxSeats: o.maxSeats,
    actionTime: o.actionTime,
    muckLosers: !!o.muckLosers,
    // Tăng blind: mode 'off' | 'hands' | 'minutes'
    blindUp: o.blindUp || { mode: 'off', every: 10, factor: 1.5 },
    baseSmallBlind: o.smallBlind,
    baseBigBlind: o.bigBlind,
    baseAnte: o.ante || 0,
    blindLevel: 0,
    levelHands: 0,
    levelStartedAt: 0,
    seats: new Array(o.maxSeats).fill(null),
    button: -1,
    hand: null,
    handCount: 0,
    log: [],
    pending: null,
    match: { no: 0, active: false, over: false, winner: null, overAt: 0, participants: [], standings: [] },
  };
}

/** Làm tròn "đẹp": 15, 20, 25, 30, 40, 50, 60, 75, 100, 150... */
export function roundNice(x) {
  if (x < 10) return Math.max(1, Math.round(x));
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const steps = [1, 1.2, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];
  let best = mag;
  for (const st of steps) if (Math.abs(st * mag - x) < Math.abs(best - x)) best = st * mag;
  return Math.round(best);
}

export class Game {
  constructor(state, now = Date.now()) {
    this.s = state;
    this.now = now;
    this.deltas = {};   // userId -> { wins, matches } cộng dồn vào thống kê
    this.dirty = false;
  }

  // ───────────────────────── helpers ─────────────────────────

  get n() { return this.s.maxSeats; }

  seatOf(userId) { return this.s.seats.findIndex((p) => p && p.userId === userId); }
  playerCount() { return this.s.seats.filter(Boolean).length; }

  addLog(text) {
    this.s.log.push({ t: this.now, text });
    if (this.s.log.length > 60) this.s.log.shift();
  }

  stat(userId, key) {
    const d = (this.deltas[userId] ||= { wins: 0, matches: 0 });
    d[key]++;
  }

  touch() { this.dirty = true; }

  schedule(type, ms) {
    this.s.pending = { type, at: this.now + ms, handId: this.s.hand ? this.s.hand.id : 0 };
  }

  *clockwise(from) {
    for (let i = 1; i <= this.n; i++) {
      const s = (((from + i) % this.n) + this.n) % this.n;
      if (this.s.seats[s]) yield s;
    }
  }

  nextSeat(from, pred) {
    for (const s of this.clockwise(from)) if (pred(this.s.seats[s], s)) return s;
    return -1;
  }

  inHand(p) { return !!p && p.inHand && !p.folded; }
  canAct(p) { return !!p && p.inHand && !p.folded && !p.allIn; }

  /** Bộ bài mới đã xáo (tách riêng để test có thể dựng bộ bài theo kịch bản). */
  makeDeck() { return shuffle(newDeck()); }

  freshHandState() {
    return {
      inHand: false, folded: false, allIn: false, cards: [],
      bet: 0, totalBet: 0, acted: false, actedLevel: -1,
      lastAction: '', won: 0, handName: '', bestCards: [], revealed: false,
    };
  }

  // ───────────────────────── thời gian ─────────────────────────

  /** Xử lý mọi sự kiện đã đến hạn. */
  advance() {
    for (let guard = 0; guard < 200; guard++) {
      const s = this.s;
      if (s.pending && s.pending.at <= this.now) {
        const ev = s.pending;
        s.pending = null;
        this.touch();
        this.runEvent(ev);
        continue;
      }
      const h = s.hand;
      if (h && h.phase === 'betting' && h.toAct >= 0 && h.deadline && h.deadline <= this.now) {
        this.touch();
        this.timeout();
        continue;
      }
      if (!h) this.kickIdle();
      break;
    }
  }

  setSittingOut(p, value) {
    if (value && !p.sittingOut) p.sitOutSince = this.now;
    p.sittingOut = !!value;
  }

  /** Người ngồi ngoài quá lâu → tự rời bàn, chip về ví. */
  kickIdle() {
    let kicked = false;
    this.s.seats.forEach((p, i) => {
      if (p && p.sittingOut && p.sitOutSince && this.now - p.sitOutSince >= DELAY.sitOutKick) {
        this.addLog(`${p.name} ngồi ngoài quá lâu, tự rời bàn`);
        this.removeSeat(i);
        kicked = true;
      }
    });
    if (kicked) { this.touch(); this.checkMatchOver(); this.checkMatchStart(); }
  }

  /** Mốc thời gian gần nhất cần gọi advance() tiếp. */
  nextWake() {
    const s = this.s;
    const times = [];
    if (s.pending) times.push(s.pending.at);
    if (s.hand && s.hand.phase === 'betting' && s.hand.deadline) times.push(s.hand.deadline);
    if (!s.hand) for (const p of s.seats) if (p && p.sittingOut && p.sitOutSince) times.push(p.sitOutSince + DELAY.sitOutKick);
    return times.length ? Math.min(...times) : 0;
  }

  runEvent(ev) {
    const h = this.s.hand;
    const stale = ev.handId && (!h || h.id !== ev.handId);
    switch (ev.type) {
      case 'start': this.maybeStartHand(); break;
      case 'matchStart': this.startMatch(); break;
      case 'street': if (!stale) { this.dealStreet(); this.proceedFrom(this.s.button); } break;
      case 'showdown': if (!stale) this.showdown(); break;
      case 'cleanup': if (!stale) this.cleanup(); break;
    }
  }

  timeout() {
    const h = this.s.hand;
    const seat = h.toAct;
    const p = this.s.seats[seat];
    const wasSittingOut = p.sittingOut;
    p.timeouts = (p.timeouts || 0) + 1;
    if (p.timeouts >= 2 && !wasSittingOut) { this.setSittingOut(p, true); this.addLog(`${p.name} bị cho ngồi ngoài (hết giờ 2 lần)`); }
    const toCall = h.currentBet - p.bet;
    // Đã ngồi ngoài từ trước: luôn bỏ bài. Hết giờ thật: check nếu được, không thì fold.
    this.applyAction(seat, toCall === 0 && !wasSittingOut ? 'check' : 'fold', 0, true);
  }

  // ───────────────────────── người chơi ─────────────────────────

  sit(user, seat) {
    const s = this.s, m = s.match;
    if (this.seatOf(user.id) !== -1) return 'Bạn đã ngồi ở bàn này';
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.n) return 'Ghế không hợp lệ';
    if (s.seats[seat]) return 'Ghế đã có người';

    const late = m.active && s.lateJoin;
    s.seats[seat] = {
      userId: user.id, name: user.name, picture: user.picture || '',
      stack: m.active && !late ? 0 : s.startingStack,
      waiting: m.active && !late,   // đang có trận → chờ trận sau
      sittingOut: false, sitOutSince: 0, leaving: false, timeouts: 0,
      rematch: true, place: 0,
      ...this.freshHandState(),
    };
    if (late) m.participants.push(user.id);
    this.addLog(`${user.name} vào ghế ${seat + 1}${m.active && !late ? ' (chờ trận sau)' : ''}`);
    this.touch();
    this.checkMatchStart();
    return null;
  }

  leave(userId) {
    const seat = this.seatOf(userId);
    if (seat === -1) return 'Bạn chưa ngồi';
    const p = this.s.seats[seat];
    const h = this.s.hand;
    this.touch();
    if (h && p.inHand && h.phase !== 'done') {
      // Rời bàn giữa trận = bị loại ngay lúc rời (xếp hạng tính tại thời điểm này)
      this.eliminate(p);
      p.leaving = true;
      this.setSittingOut(p, true);
      // Người đã all-in: bài vẫn còn hiệu lực (luật thật), chỉ rời khi ván xong
      if (this.inHand(p) && !p.allIn) this.foldOutOfTurn(seat);
      return null; // rời hẳn khi ván kết thúc
    }
    this.removeSeat(seat);
    this.checkMatchOver();
    this.checkMatchStart();
    return null;
  }

  removeSeat(seat) {
    const p = this.s.seats[seat];
    if (!p) return;
    this.eliminate(p);
    this.s.seats[seat] = null;
    this.addLog(`${p.name} rời bàn`);
  }

  setSitOut(userId, value) {
    const seat = this.seatOf(userId);
    if (seat === -1) return 'Bạn chưa ngồi';
    const p = this.s.seats[seat];
    this.setSittingOut(p, value);
    p.timeouts = 0;
    if (!this.s.match.over) p.rematch = !value;
    this.touch();
    this.checkMatchStart();
    return null;
  }

  show(userId) {
    const seat = this.seatOf(userId);
    const p = this.s.seats[seat];
    const h = this.s.hand;
    if (!p || !h || h.phase !== 'done' || !p.cards.length || p.revealed) return 'Không thể lật bài lúc này';
    p.revealed = true;
    this.addLog(`${p.name} lật bài ${p.cards.join(' ')}`);
    this.touch();
    return null;
  }

  // ───────────────────────── match / rematch ─────────────────────────

  isParticipant(p) { return !!p && this.s.match.active && this.s.match.participants.includes(p.userId); }

  /** Rời bàn giữa trận = bị loại: xếp dưới tất cả người còn ngồi trong trận. */
  eliminate(p) {
    const m = this.s.match;
    if (!this.isParticipant(p) || p.place) return;
    const remaining = this.s.seats.filter((q) => this.isParticipant(q) && !q.place && !q.leaving && q !== p);
    p.place = remaining.length + 1;
    m.standings.push({ userId: p.userId, name: p.name, picture: p.picture, place: p.place });
    this.addLog(`💀 ${p.name} bị loại — hạng ${p.place}`);
  }

  /** Người sẵn sàng cho match kế tiếp. */
  readyPlayers() {
    const over = this.s.match.over;
    return this.s.seats.filter((p) => p && !p.leaving && (over ? p.rematch : !p.sittingOut));
  }

  /** Chưa có trận: đủ người thì đếm ngược bắt đầu; thiếu người thì huỷ đếm ngược. */
  checkMatchStart() {
    const s = this.s;
    if (s.match.active || s.hand) return;
    const need = s.match.over ? 2 : Math.max(2, s.minPlayers);
    const ready = this.readyPlayers().length;
    if (ready >= need) {
      if (!s.pending) this.schedule('matchStart', s.match.over ? DELAY.rematch : DELAY.matchStart);
    } else if (s.pending && s.pending.type === 'matchStart') {
      s.pending = null;
    }
  }

  startMatch() {
    const s = this.s, m = s.match;
    if (m.active || s.hand) return;
    const ready = this.readyPlayers();
    if (ready.length < (m.over ? 2 : Math.max(2, s.minPlayers))) return;
    const readySet = new Set(ready);
    m.no++;
    m.active = true;
    m.over = false;
    m.winner = null;
    m.standings = [];
    m.participants = ready.map((p) => p.userId);
    for (const p of s.seats) {
      if (!p) continue;
      const inMatch = readySet.has(p);
      p.stack = inMatch ? s.startingStack : 0;
      p.waiting = !inMatch;
      p.place = 0;
      p.rematch = false;
      p.timeouts = 0;
      if (inMatch) this.setSittingOut(p, false);
    }
    this.setBlindLevel(0);
    this.addLog(`══ Bắt đầu match #${m.no} · ${ready.length} người · mỗi người ${s.startingStack} chip ══`);
    this.maybeStartHand();
  }

  /** Khi chỉ còn 1 người có chip → người đó vô địch. */
  checkMatchOver() {
    const s = this.s, m = s.match;
    if (!m.active || s.hand) return false;
    const alive = s.seats.filter((p) => this.isParticipant(p) && !p.leaving && p.stack > 0 && !p.place);
    if (alive.length > 1) return false;
    let w = alive[0];
    if (w) {
      w.place = 1;
      m.standings.push({ userId: w.userId, name: w.name, picture: w.picture, place: 1 });
    } else {
      // Mọi người còn lại cùng cháy túi (vd. thua người vừa rời bàn) → người hạng 1 còn ngồi ở bàn thắng
      w = s.seats.find((p) => this.isParticipant(p) && !p.leaving && p.place === 1);
    }
    if (w) {
      this.stat(w.userId, 'wins');
      this.addLog(`🏆 ${w.name} vô địch match #${m.no}!`);
    }
    for (const uid of m.participants) this.stat(uid, 'matches');
    m.standings.sort((a, b) => a.place - b.place);
    m.active = false;
    m.over = true;
    m.overAt = this.now;
    m.winner = w ? { userId: w.userId, name: w.name, picture: w.picture, stack: w.stack } : null;
    for (const p of s.seats) if (p) { p.rematch = false; p.waiting = false; }
    s.pending = null;
    this.touch();
    return true;
  }

  /** Bấm Rematch: sẵn sàng cho trận mới (ai cũng reset về chip khởi điểm). */
  rematch(userId) {
    if (!this.s.match.over) return 'Chưa có match nào kết thúc';
    const seat = this.seatOf(userId);
    if (seat === -1) return 'Bạn chưa ngồi';
    const p = this.s.seats[seat];
    if (p.rematch) return null;
    p.rematch = true;
    this.setSittingOut(p, false);
    this.addLog(`${p.name} sẵn sàng rematch`);
    this.touch();
    this.checkMatchStart();
    return null;
  }

  // ───────────────────────── vòng đời ván bài ─────────────────────────

  maybeStartHand() {
    const s = this.s;
    if (s.hand) return;
    this.kickIdle();
    if (!s.match.active) { this.checkMatchStart(); return; }
    // Trong trận: người ngồi ngoài vẫn bị chia bài & trả blind (tự fold) như giải thật.
    const eligible = s.seats
      .map((p, i) => (this.isParticipant(p) && !p.leaving && !p.place && p.stack > 0 ? i : -1))
      .filter((i) => i !== -1);
    if (eligible.length < 2) { this.checkMatchOver(); return; }
    this.startHand(eligible);
  }

  startHand(eligible) {
    const s = this.s;
    const set = new Set(eligible);
    const isElig = (_, i) => set.has(i);
    for (const p of s.seats) if (p) Object.assign(p, this.freshHandState());
    for (const i of eligible) s.seats[i].inHand = true;

    s.button = this.nextSeat(s.button, isElig);
    let sb, bb;
    if (eligible.length === 2) {
      sb = s.button; // heads-up: button là SB, hành động trước preflop
      bb = this.nextSeat(sb, isElig);
    } else {
      sb = this.nextSeat(s.button, isElig);
      bb = this.nextSeat(sb, isElig);
    }

    this.maybeRaiseBlinds();
    s.handCount++;
    s.hand = {
      id: s.handCount,
      deck: this.makeDeck(),
      board: [],
      street: 'preflop',
      phase: 'betting', // betting | transition | done
      sb, bb,
      toAct: -1,
      currentBet: 0,
      minRaise: s.bigBlind,
      raiseLevel: 0,
      deadline: 0,
      pots: [],
      results: null,
      runout: false,
    };
    const h = s.hand;
    this.addLog(`── Ván #${h.id} · Dealer: ${s.seats[s.button].name} ──`);

    if (s.ante > 0) {
      for (const i of eligible) {
        const p = s.seats[i];
        const a = Math.min(s.ante, p.stack);
        p.stack -= a; p.totalBet += a;
        if (p.stack === 0) p.allIn = true;
      }
      this.addLog(`Mọi người đặt ante ${s.ante}`);
    }
    this.postBlind(sb, s.smallBlind, 'SB');
    this.postBlind(bb, s.bigBlind, 'BB');
    h.currentBet = s.bigBlind;

    for (let round = 0; round < 2; round++) {
      let i = sb;
      for (let k = 0; k < eligible.length; k++) {
        s.seats[i].cards.push(h.deck.pop());
        i = this.nextSeat(i, isElig);
      }
    }
    this.proceedFrom(bb);
  }

  // ───────────────────────── tăng blind ─────────────────────────

  setBlindLevel(level) {
    const s = this.s;
    const f = Math.pow(s.blindUp.factor || 1.5, level);
    s.blindLevel = level;
    s.levelHands = 0;
    s.levelStartedAt = this.now;
    s.bigBlind = level === 0 ? s.baseBigBlind : roundNice(s.baseBigBlind * f);
    s.smallBlind = level === 0 ? s.baseSmallBlind
      : Math.max(1, Math.min(s.bigBlind - 1, roundNice(s.bigBlind * s.baseSmallBlind / s.baseBigBlind)));
    s.ante = level === 0 || !s.baseAnte ? s.baseAnte : roundNice(s.baseAnte * f);
  }

  maybeRaiseBlinds() {
    const s = this.s, bu = s.blindUp;
    if (!bu || bu.mode === 'off') return;
    const due = bu.mode === 'hands'
      ? s.levelHands >= bu.every
      : this.now - s.levelStartedAt >= bu.every * 60_000;
    if (due) {
      this.setBlindLevel(s.blindLevel + 1);
      this.addLog(`⬆ Blind tăng lên level ${s.blindLevel + 1}: ${s.smallBlind}/${s.bigBlind}${s.ante ? ' ante ' + s.ante : ''}`);
    }
    s.levelHands++;
  }

  postBlind(i, amount, label) {
    const p = this.s.seats[i];
    if (p.allIn) return;
    const a = Math.min(amount, p.stack);
    this.putChips(p, a);
    p.lastAction = `${label} ${a}`;
    this.addLog(`${p.name} đặt ${label} ${a}`);
  }

  findNextActor(from) {
    const h = this.s.hand;
    const actors = this.s.seats.filter((p) => this.canAct(p));
    if (actors.length === 0) return -1;
    if (actors.length === 1) {
      const p = actors[0];
      const maxOther = Math.max(0, ...this.s.seats.filter((q) => this.inHand(q) && q !== p).map((q) => q.bet));
      if (p.bet >= maxOther) return -1;
    }
    return this.nextSeat(from, (p) => this.canAct(p) && (!p.acted || p.bet < h.currentBet));
  }

  proceedFrom(seat) {
    const h = this.s.hand;
    const alive = this.s.seats.filter((p) => this.inHand(p));
    if (alive.length === 1) return this.finishByFold();
    const next = this.findNextActor(seat);
    if (next !== -1) {
      h.toAct = next;
      h.phase = 'betting';
      h.deadline = this.now + (this.s.seats[next].sittingOut ? 0 : this.s.actionTime * 1000);
      return;
    }
    this.endStreet();
  }

  endStreet() {
    const s = this.s, h = s.hand;
    h.toAct = -1;
    h.deadline = 0;
    h.phase = 'transition';
    h.pots = this.buildPots().map((p) => p.amount);
    for (const p of s.seats) {
      if (!p) continue;
      p.bet = 0; p.acted = false; p.actedLevel = -1;
      if (this.canAct(p)) p.lastAction = '';
    }
    h.currentBet = 0;
    h.minRaise = s.bigBlind;
    h.raiseLevel = 0;

    const runout = s.seats.filter((p) => this.canAct(p)).length <= 1;
    if (runout && !h.runout) {
      h.runout = true;
      // Luật thật: khi all-in và hết hành động, mọi người lật bài (trừ khi bàn cho úp bài).
      if (!s.muckLosers) for (const p of s.seats) if (this.inHand(p)) p.revealed = true;
    }
    if (h.street === 'river') this.schedule('showdown', DELAY.street);
    else this.schedule('street', runout ? DELAY.runout : DELAY.street);
  }

  dealStreet() {
    const h = this.s.hand;
    h.deck.pop(); // burn
    if (h.street === 'preflop') { h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop()); h.street = 'flop'; }
    else if (h.street === 'flop') { h.board.push(h.deck.pop()); h.street = 'turn'; }
    else if (h.street === 'turn') { h.board.push(h.deck.pop()); h.street = 'river'; }
    this.addLog(`${h.street.toUpperCase()}: ${h.board.join(' ')}`);
  }

  // ───────────────────────── hành động ─────────────────────────

  legalActions(seat) {
    const h = this.s.hand;
    if (!h || h.phase !== 'betting' || h.toAct !== seat) return null;
    const p = this.s.seats[seat];
    const toCall = Math.max(0, h.currentBet - p.bet);
    const maxTo = p.bet + p.stack;
    const othersCanAct = this.s.seats.some((q) => q !== p && this.canAct(q));
    const canRaise = p.stack > toCall && p.actedLevel < h.raiseLevel && othersCanAct;
    return {
      toCall: Math.min(toCall, p.stack),
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canRaise,
      isBet: h.currentBet === 0,
      minTo: Math.min(h.currentBet + h.minRaise, maxTo),
      maxTo,
      myBet: p.bet,
      currentBet: h.currentBet,
      pot: this.potTotal(),
    };
  }

  act(userId, action, amount) {
    const seat = this.seatOf(userId);
    if (seat === -1) return 'Bạn chưa ngồi';
    const legal = this.legalActions(seat);
    if (!legal) return 'Chưa đến lượt bạn';
    if (!['fold', 'check', 'call', 'raise'].includes(action)) return 'Hành động không hợp lệ';
    if (action === 'check' && !legal.canCheck) return 'Không thể check';
    if (action === 'call' && !legal.canCall) return 'Không có gì để call';
    if (action === 'raise') {
      if (!legal.canRaise) return 'Không thể raise lúc này';
      if (!Number.isInteger(amount)) return 'Số tiền không hợp lệ';
      if (amount >= legal.maxTo) amount = legal.maxTo; // all-in
      else if (amount < legal.minTo) return `Tối thiểu phải là ${legal.minTo}`;
      if (amount <= legal.currentBet) return 'Số tiền phải lớn hơn mức cược hiện tại';
    }
    this.s.seats[seat].timeouts = 0;
    this.applyAction(seat, action, amount, false);
    this.touch();
    return null;
  }

  applyAction(seat, action, amount, auto) {
    const h = this.s.hand;
    const p = this.s.seats[seat];
    const prefix = auto ? '(hết giờ) ' : '';
    switch (action) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        this.addLog(`${prefix}${p.name} bỏ bài`);
        break;
      case 'check':
        p.lastAction = 'Check';
        this.addLog(`${prefix}${p.name} check`);
        break;
      case 'call': {
        const a = Math.min(h.currentBet - p.bet, p.stack);
        this.putChips(p, a);
        p.lastAction = p.allIn ? 'All-in' : `Call ${a}`;
        this.addLog(`${p.name} call ${a}${p.allIn ? ' (all-in)' : ''}`);
        break;
      }
      case 'raise': {
        const wasBet = h.currentBet === 0;
        this.putChips(p, amount - p.bet);
        const raiseSize = amount - h.currentBet;
        if (raiseSize >= h.minRaise) {
          h.minRaise = raiseSize;
          h.raiseLevel++; // raise đủ mức → mở lại quyền raise cho người khác
        }
        h.currentBet = amount;
        for (const q of this.s.seats) if (q && q !== p && this.canAct(q)) q.acted = false;
        p.lastAction = p.allIn ? 'All-in' : `${wasBet ? 'Bet' : 'Raise'} ${amount}`;
        this.addLog(`${p.name} ${wasBet ? 'bet' : 'raise lên'} ${amount}${p.allIn ? ' (all-in)' : ''}`);
        break;
      }
    }
    p.acted = true;
    p.actedLevel = h.raiseLevel;
    this.proceedFrom(seat);
  }

  foldOutOfTurn(seat) {
    const h = this.s.hand;
    const p = this.s.seats[seat];
    if (h.phase === 'betting' && h.toAct === seat) { this.applyAction(seat, 'fold', 0, false); return; }
    p.folded = true;
    p.lastAction = 'Fold';
    this.addLog(`${p.name} bỏ bài và rời bàn`);
    const alive = this.s.seats.filter((q) => this.inHand(q));
    if (alive.length === 1) { this.s.pending = null; this.finishByFold(); return; }
    if (h.phase === 'betting' && this.findNextActor(h.toAct - 1) === -1) this.endStreet();
  }

  putChips(p, a) {
    p.stack -= a; p.bet += a; p.totalBet += a;
    if (p.stack === 0) p.allIn = true;
  }

  potTotal() {
    return this.s.seats.reduce((sum, p) => sum + (p ? p.totalBet : 0), 0);
  }

  // ───────────────────────── pot & showdown ─────────────────────────

  refundUncalled() {
    const sorted = this.s.seats.filter((p) => p && p.totalBet > 0).sort((a, b) => b.totalBet - a.totalBet);
    if (!sorted.length) return;
    const top = sorted[0];
    const diff = top.totalBet - (sorted[1] ? sorted[1].totalBet : 0);
    if (diff > 0 && this.inHand(top)) {
      top.totalBet -= diff;
      top.bet = Math.max(0, top.bet - diff);
      top.stack += diff;
      if (top.stack > 0) top.allIn = false;
      this.addLog(`Trả lại ${diff} không ai theo cho ${top.name}`);
    }
  }

  /** Main pot + side pots theo mức đóng góp. */
  buildPots() {
    const contribs = this.s.seats.map((p, i) => ({ p, i })).filter((x) => x.p && x.p.totalBet > 0);
    const levels = [...new Set(contribs.map((x) => x.p.totalBet))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const { p } of contribs) amount += Math.max(0, Math.min(p.totalBet, level) - prev);
      const eligible = contribs.filter((x) => this.inHand(x.p) && x.p.totalBet >= level).map((x) => x.i);
      const last = pots[pots.length - 1];
      if (last && (eligible.length === 0 || last.eligible.join() === eligible.join())) last.amount += amount;
      else pots.push({ amount, eligible });
      prev = level;
    }
    return pots;
  }

  finishByFold() {
    const h = this.s.hand;
    this.refundUncalled();
    const wi = this.s.seats.findIndex((p) => this.inHand(p));
    const w = this.s.seats[wi];
    const total = this.potTotal();
    w.stack += total;
    w.won = total;
    h.results = [{ amount: total, winners: [wi], handName: '', potName: 'pot' }];
    this.addLog(`${w.name} thắng ${total} (mọi người bỏ bài)`);
    this.endHand(DELAY.afterFold);
  }

  showdown() {
    const s = this.s, h = s.hand;
    h.street = 'showdown';
    this.refundUncalled();
    const pots = this.buildPots();
    h.pots = pots.map((p) => p.amount);

    const alive = s.seats.map((p, i) => ({ p, i })).filter((x) => this.inHand(x.p));
    const hands = new Map();
    for (const { p, i } of alive) {
      const best = bestHand([...p.cards, ...h.board]);
      hands.set(i, best);
      p.handName = best.name;
      p.bestCards = best.cards;
    }

    const order = [...this.clockwise(s.button)]; // chip lẻ cho người đầu tiên bên trái button
    h.results = [];
    pots.forEach((pot, idx) => {
      let bestScore = -1, winners = [];
      for (const i of pot.eligible) {
        const sc = hands.get(i).score;
        if (sc > bestScore) { bestScore = sc; winners = [i]; }
        else if (sc === bestScore) winners.push(i);
      }
      winners.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      for (const i of winners) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        s.seats[i].stack += amt;
        s.seats[i].won += amt;
      }
      const potName = pots.length === 1 ? 'pot' : idx === 0 ? 'main pot' : `side pot ${idx}`;
      const handName = hands.get(winners[0]).name;
      h.results.push({ amount: pot.amount, winners, handName, potName });
      this.addLog(`${winners.map((i) => s.seats[i].name).join(', ')} thắng ${potName} ${pot.amount} — ${handName}`);
    });

    const winnerSeats = new Set(h.results.flatMap((r) => r.winners));
    for (const { p, i } of alive) {
      if (!s.muckLosers || winnerSeats.has(i) || p.revealed) {
        p.revealed = true;
        this.addLog(`${p.name} lật ${p.cards.join(' ')} — ${p.handName}`);
      } else {
        this.addLog(`${p.name} úp bài`);
      }
    }
    this.endHand(DELAY.afterShowdown);
  }

  endHand(delay) {
    const h = this.s.hand;
    h.phase = 'done';
    h.toAct = -1;
    h.deadline = 0;
    for (const p of this.s.seats) if (p) { p.totalBet = 0; p.bet = 0; }
    this.schedule('cleanup', delay);
  }

  cleanup() {
    const s = this.s;
    s.hand = null;
    // Ai cháy túi ván này thì bị loại (cùng hạng nếu cháy cùng lúc)
    const busted = s.seats.filter((p) => this.isParticipant(p) && !p.place && p.stack === 0);
    const aliveCount = s.seats.filter((p) => this.isParticipant(p) && !p.place && p.stack > 0 && !p.leaving).length;
    for (const p of busted) {
      p.place = aliveCount + 1;
      s.match.standings.push({ userId: p.userId, name: p.name, picture: p.picture, place: p.place });
      this.addLog(`💀 ${p.name} hết chip — hạng ${p.place}`);
    }
    s.seats.forEach((p, i) => {
      if (!p) return;
      if (p.leaving) this.removeSeat(i);
      else Object.assign(p, this.freshHandState());
    });
    if (!this.checkMatchOver()) this.schedule('start', DELAY.nextHand);
  }

  // ───────────────────────── view cho client ─────────────────────────

  myHand(seat) {
    const h = this.s.hand;
    if (seat === -1 || !h) return null;
    const p = this.s.seats[seat];
    if (!p.cards.length) return null;
    if (h.board.length < 3) {
      const [a, b] = p.cards;
      return a[0] === b[0] ? { category: 1, ranks: [rankValue(a)], name: `Đôi ${a[0] === 'T' ? '10' : a[0]}` } : null;
    }
    const best = bestHand([...p.cards, ...h.board]);
    return { category: best.category, ranks: best.ranks, name: best.name, cards: best.cards };
  }

  viewFor(userId) {
    const s = this.s, h = s.hand;
    const mySeat = this.seatOf(userId);
    const winners = new Set();
    if (h && h.results) for (const r of h.results) for (const i of r.winners) winners.add(i);

    const seats = s.seats.map((p, i) => {
      if (!p) return null;
      const own = p.userId === userId;
      const showCards = own || p.revealed;
      return {
        userId: p.userId, name: p.name, picture: p.picture,
        stack: p.stack, bet: p.bet, totalBet: p.totalBet,
        folded: p.folded, allIn: p.allIn, inHand: p.inHand,
        sittingOut: p.sittingOut, sitOutSince: p.sitOutSince || 0, leaving: p.leaving,
        waiting: !!p.waiting, place: p.place || 0, rematch: p.rematch,
        lastAction: p.lastAction,
        cards: p.inHand && (!p.folded || showCards) ? (showCards ? p.cards : p.cards.map(() => null)) : [],
        revealed: p.revealed,
        won: p.won,
        handName: showCards ? p.handName : '',
        bestCards: p.revealed ? p.bestCards : [],
        winner: winners.has(i),
      };
    });

    const me = mySeat !== -1 ? s.seats[mySeat] : null;
    return {
      name: s.name,
      ownerId: s.ownerId,
      settings: {
        smallBlind: s.smallBlind, bigBlind: s.bigBlind, ante: s.ante,
        startingStack: s.startingStack, minPlayers: s.minPlayers, lateJoin: s.lateJoin, maxSeats: s.maxSeats,
        actionTime: s.actionTime, muckLosers: s.muckLosers, private: !!s.passwordHash,
        blindUp: s.blindUp, baseSmallBlind: s.baseSmallBlind, baseBigBlind: s.baseBigBlind,
      },
      seats,
      button: s.button,
      hand: h ? {
        id: h.id, board: h.board, street: h.street, phase: h.phase,
        toAct: h.toAct, deadline: h.deadline, sb: h.sb, bb: h.bb,
        pots: h.pots, potTotal: this.potTotal(), currentBet: h.currentBet,
        results: h.results,
      } : null,
      match: s.match,
      blinds: {
        level: s.blindLevel, handsInLevel: s.levelHands, levelStartedAt: s.levelStartedAt,
        next: s.blindUp.mode === 'off' ? null : (() => {
          const f = Math.pow(s.blindUp.factor, s.blindLevel + 1);
          const bb = roundNice(s.baseBigBlind * f);
          return { bigBlind: bb, smallBlind: Math.max(1, Math.min(bb - 1, roundNice(bb * s.baseSmallBlind / s.baseBigBlind))) };
        })(),
      },
      pending: s.pending ? { type: s.pending.type, at: s.pending.at } : null,
      nextWake: this.nextWake(),
      mySeat,
      legal: mySeat !== -1 ? this.legalActions(mySeat) : null,
      myHand: this.myHand(mySeat),
      canShow: !!me && !!h && h.phase === 'done' && me.cards.length > 0 && !me.revealed,
      canRematch: !!me && s.match.over && !me.rematch,
      ready: this.readyPlayers().length,
      log: s.log.slice(-40),
      serverTime: this.now,
    };
  }

  summary() {
    const s = this.s;
    return {
      name: s.name,
      players: this.playerCount(),
      hand_running: !!s.hand,
      settings: {
        smallBlind: s.smallBlind, bigBlind: s.bigBlind, ante: s.ante,
        startingStack: s.startingStack, minPlayers: s.minPlayers, lateJoin: s.lateJoin, maxSeats: s.maxSeats,
        actionTime: s.actionTime, muckLosers: s.muckLosers, private: !!s.passwordHash,
        blindUp: s.blindUp, baseSmallBlind: s.baseSmallBlind, baseBigBlind: s.baseBigBlind,
      },
    };
  }
}
