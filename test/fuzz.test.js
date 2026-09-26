// Fuzz: mô phỏng hàng trăm bàn với hành động ngẫu nhiên (kể cả hành động sai, rời bàn, ngồi ngoài,
// vào muộn, nhảy thời gian…). Sau MỖI bước: state phải JSON round-trip được và thoả mọi bất biến
// trong helpers.checkInvariants (bảo toàn chip, không trùng lá, không kẹt ván…).
// Chạy nhiều hơn: FUZZ_GAMES=2000 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Table, DELAY, rng, checkViewPrivacy } from './helpers.js';

const GAMES = Number(process.env.FUZZ_GAMES || 160);

function randomOpts(r) {
  const maxSeats = r.int(2, 9);
  const bb = r.pick([2, 10, 20, 50, 100, 250]);
  const sb = Math.max(1, Math.floor(bb / 2));
  const deep = r.chance(0.5);
  return {
    maxSeats,
    smallBlind: sb,
    bigBlind: bb,
    ante: r.chance(0.3) ? r.int(1, bb) : 0,
    startingStack: bb * (deep ? r.int(40, 300) : r.int(10, 25)),
    actionTime: r.pick([10, 30, 60]),
    muckLosers: r.chance(0.5),
    lateJoin: r.chance(0.3),
    minPlayers: 2,
    blindUp: r.chance(0.6)
      ? { mode: r.pick(['hands', 'minutes']), every: r.int(1, 4), factor: r.pick([1.25, 1.5, 2]) }
      : { mode: 'off', every: 10, factor: 1.5 },
  };
}

function chooseAction(r, l) {
  const x = r();
  if (x < 0.12) return ['fold'];
  if (x < 0.55 || !l.canRaise) return [l.canCheck ? 'check' : 'call'];
  if (x < 0.65) return ['raise', l.maxTo];
  if (x < 0.75) return ['raise', l.minTo];
  // cỡ ngẫu nhiên trong [minTo, maxTo]
  return ['raise', r.int(l.minTo, l.maxTo)];
}

export function fuzzOne(seed) {
  const r = rng(seed);
  const opts = randomOpts(r);
  opts.minPlayers = r.int(2, Math.min(4, opts.maxSeats));
  const t = new Table(opts);
  // Ghi lại 15 thao tác gần nhất để debug khi có lỗi
  const trace = [];
  const origRun = t.run.bind(t);
  t.run = (fn, o) => {
    const src = fn ? fn.toString().replace(/\s+/g, ' ').slice(0, 60) : 'tick';
    const s0 = JSON.parse(t.json);
    trace.push(`[${t.now}] ${src} | hand=${s0.hand?.id}/${s0.hand?.phase}/${s0.hand?.street} toAct=${s0.hand?.toAct}`);
    if (trace.length > 15) trace.shift();
    try { return origRun(fn, o); } catch (e) { e.message += `\n  trace:\n  ${trace.join('\n  ')}`; throw e; }
  };
  const free = () => t.state.seats.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  const seated = () => t.state.seats.filter(Boolean).map((p) => p.userId);
  let nextId = 0;
  const sitNew = () => {
    const f = free();
    if (!f.length) return;
    const id = `p${nextId++}`;
    assert.equal(t.sit(id, r.pick(f), id), null);
  };
  const n = r.int(2, opts.maxSeats);
  for (let i = 0; i < n; i++) sitNew();

  const hands = new Set();
  let matchesDone = 0, lastMatchOver = false, invalidTried = 0;
  const target = r.int(25, 90);

  for (let step = 0; step < 4000 && hands.size < target; step++) {
    const s = t.state;
    if (s.hand) hands.add(s.hand.id);
    if (s.match.over && !lastMatchOver) matchesDone++;
    lastMatchOver = s.match.over;

    // ── sự kiện gây rối ──
    const x = r();
    if (x < 0.006 && seated().length) { t.run((g) => g.leave(r.pick(seated()))); continue; }
    if (x < 0.014 && seated().length) {
      const u = r.pick(seated());
      const p = s.seats.find((q) => q?.userId === u);
      t.run((g) => g.setSitOut(u, !p.sittingOut));
      continue;
    }
    if (x < 0.022) { sitNew(); continue; }
    if (x < 0.03) { t.tick(r.int(0, 3 * 60_000)); continue; } // nhảy thời gian
    if (x < 0.04 && seated().length) {
      // hành động sai lượt / sai tham số → phải bị từ chối & state không đổi
      const u = r.pick(seated());
      const before = t.json;
      const toActUid = s.hand?.phase === 'betting' ? s.seats[s.hand.toAct].userId : null;
      const due = t.run((g) => g.nextWake(), { advance: false });
      if (u !== toActUid && (!due || due > t.now)) {
        const err = t.run((g) => g.act(u, r.pick(['check', 'call', 'fold', 'raise']), r.int(0, 1000)), { advance: false });
        assert.ok(err, 'hành động sai lượt phải bị từ chối');
        assert.equal(t.json, before, 'hành động bị từ chối không được làm đổi state');
        invalidTried++;
      }
      continue;
    }
    if (x < 0.045 && seated().length) { t.run((g) => g.show(r.pick(seated()))); continue; }

    if (s.match.over) {
      for (const u of seated()) if (r.chance(0.5)) t.run((g) => g.rematch(u));
      t.tick(r.int(200, DELAY.rematch));
      if (seated().length < 2) sitNew();
      continue;
    }

    const h = s.hand;
    if (h && h.phase === 'betting') {
      const p = s.seats[h.toAct];
      if (p.sittingOut) { t.tick(1); continue; }
      if (r.chance(0.03)) { t.tick(opts.actionTime * 1000 + 1); continue; } // hết giờ
      const l = t.legal(h.toAct);
      assert.ok(l, 'người tới lượt phải có legal actions');
      assert.ok(l.minTo <= l.maxTo, 'minTo > maxTo');
      if (l.canRaise) assert.ok(l.minTo > l.currentBet || l.minTo === l.maxTo, 'minTo không lớn hơn currentBet');
      // thử một lần raise sai cỡ
      if (l.canRaise && l.minTo < l.maxTo && l.minTo - 1 > l.currentBet && r.chance(0.05)) {
        const before = t.json;
        const err = t.run((g) => g.act(p.userId, 'raise', l.minTo - 1), { advance: false });
        assert.ok(err);
        assert.equal(t.json, before);
      }
      const [a, amt] = chooseAction(r, l);
      const err = t.act(p.userId, a, amt);
      assert.equal(err, null, `seed ${seed}: hành động hợp lệ ${a} ${amt} bị từ chối: ${err}`);
    } else {
      t.tick(r.int(100, 2500));
      if (!s.match.active && !s.match.over && seated().length < 2) sitNew();
    }

    if (step % 7 === 0) {
      const st = t.state;
      for (const u of [...seated().slice(0, 3), 'spectator']) checkViewPrivacy(st, t.view(u), u);
    }
  }
  return { hands: hands.size, matchesDone, invalidTried, stats: t.stats };
}

test(`fuzz ${GAMES} bàn ngẫu nhiên: mọi bất biến luôn đúng`, () => {
  let totalHands = 0, totalMatches = 0, totalInvalid = 0;
  for (let seed = 1; seed <= GAMES; seed++) {
    try {
      const res = fuzzOne(seed);
      totalHands += res.hands;
      totalMatches += res.matchesDone;
      totalInvalid += res.invalidTried;
      // thống kê: số trận thắng ≤ số trận kết thúc; mỗi người tối đa 1 trận/lần kết thúc
      const wins = Object.values(res.stats).reduce((a, x) => a + x.wins, 0);
      assert.ok(wins <= res.matchesDone + 1);
    } catch (e) {
      e.message = `[seed ${seed}] ${e.message}`;
      throw e;
    }
  }
  assert.ok(totalHands > GAMES * 20, `quá ít ván được chơi (${totalHands}) → có thể bị kẹt`);
  assert.ok(totalMatches > GAMES / 4, `quá ít trận kết thúc (${totalMatches})`);
  console.log(`  ↳ ${totalHands} ván, ${totalMatches} trận kết thúc, ${totalInvalid} hành động sai bị chặn`);
});

test('fuzz chip nông (nhiều all-in, loại người liên tục, rematch nhiều vòng)', () => {
  let matches = 0;
  for (let seed = 1000; seed < 1000 + Math.ceil(GAMES / 2); seed++) {
    const r = rng(seed);
    const t = new Table({ maxSeats: r.int(2, 9), smallBlind: 5, bigBlind: 10, startingStack: r.int(10, 40), ante: r.pick([0, 1, 5]),
      blindUp: { mode: 'hands', every: 1, factor: 2 }, muckLosers: r.chance(0.5) });
    const n = r.int(2, t.state.maxSeats);
    for (let i = 0; i < n; i++) t.sit(`q${i}`, i);
    for (let step = 0; step < 3000 && matches < 10_000; step++) {
      const s = t.state;
      if (s.match.over) {
        matches++;
        assert.ok(s.match.standings.length >= 1);
        for (const p of s.seats) if (p) t.run((g) => g.rematch(p.userId));
        t.tick(DELAY.rematch);
        continue;
      }
      if (s.hand?.phase === 'betting') {
        const l = t.legal(s.hand.toAct);
        const err = t.act(s.seats[s.hand.toAct].userId, ...chooseAction(r, l));
        assert.equal(err, null, `[seed ${seed}] ${err}`);
      } else t.tick(1000);
    }
  }
  assert.ok(matches > 50, `chỉ ${matches} trận kết thúc`);
});
