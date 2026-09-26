// Test tích hợp với Supabase thật (Edge Function + Postgres + RLS).
// Chạy: RP_TEST_EMAIL_A=... RP_TEST_EMAIL_B=... RP_TEST_PASSWORD=... npm run test:api
// (2 tài khoản email/password đã xác thực trong project Supabase). Không có biến môi trường → bỏ qua.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SUPABASE_URL, SUPABASE_KEY } from '../public/js/config.js';

const EMAIL_A = process.env.RP_TEST_EMAIL_A;
const EMAIL_B = process.env.RP_TEST_EMAIL_B;
const PASSWORD = process.env.RP_TEST_PASSWORD;
const enabled = !!(EMAIL_A && EMAIL_B && PASSWORD);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  assert.ok(j.access_token, `đăng nhập ${email} thất bại: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id };
}

async function call(u, op, params = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/poker`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(u ? { Authorization: `Bearer ${u.token}` } : {}) },
    body: JSON.stringify({ op, ...params }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ...body };
}

async function rest(u, method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* rỗng */ }
  return { status: r.status, data };
}

const baseTable = {
  name: 'API test', smallBlind: 5, bigBlind: 10, ante: 0, startingStack: 1000, maxSeats: 6, minPlayers: 2,
  actionTime: 10, muckLosers: true, lateJoin: false, blindUp: { mode: 'off' }, password: '',
};

function noSecrets(view, label) {
  const j = JSON.stringify({ ...view, log: [] });
  assert.ok(!j.includes('"deck"'), `${label}: lộ bộ bài`);
  assert.ok(!j.includes('passwordHash'), `${label}: lộ hash mật khẩu`);
}

/** Đợi tới khi fn(view) đúng, gọi tick liên tục */
async function waitFor(u, tableId, fn, ms = 20000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = (await call(u, 'tick', { tableId })).view;
    if (v && fn(v)) return v;
    await sleep(400);
  }
  throw new Error('hết thời gian chờ; view cuối: ' + JSON.stringify(v?.hand ?? v?.match));
}

describe('API tích hợp', { skip: !enabled && 'thiếu RP_TEST_EMAIL_A / RP_TEST_EMAIL_B / RP_TEST_PASSWORD' }, () => {
  let A, B, tableId, privateId;

  before(async () => {
    A = await login(EMAIL_A);
    B = await login(EMAIL_B);
  });

  after(async () => {
    for (const id of [tableId, privateId].filter(Boolean)) {
      await call(A, 'leave', { tableId: id });
      await call(B, 'leave', { tableId: id });
    }
  });

  test('không có token → 401', async () => {
    const r = await call(null, 'me');
    assert.equal(r.status, 401);
    const r2 = await call({ token: 'rác' }, 'me');
    assert.equal(r2.status, 401);
  });

  test('me trả về hồ sơ, không có email', async () => {
    const r = await call(A, 'me');
    assert.equal(r.status, 200);
    assert.equal(r.profile.id, A.id);
    assert.equal(typeof r.profile.wins, 'number');
    assert.ok(!('email' in r.profile));
  });

  test('op lạ → 400', async () => {
    const r = await call(A, 'hack');
    assert.equal(r.status, 400);
  });

  test('tạo bàn: validate đầu vào', async () => {
    const bad = [
      [{ name: '' }, 'Tên bàn'],
      [{ smallBlind: 10, bigBlind: 10 }, 'Blind'],
      [{ smallBlind: 0 }, 'Blind'],
      [{ ante: 11 }, 'Ante'],
      [{ startingStack: 50 }, 'Chip khởi điểm'],
      [{ maxSeats: 10 }, 'Số ghế'],
      [{ maxSeats: 1 }, 'Số ghế'],
      [{ minPlayers: 7 }, 'Số người tối thiểu'],
      [{ actionTime: 5 }, 'Thời gian'],
      [{ blindUp: { mode: 'hands', every: 0, factor: 2 } }, 'Chu kỳ'],
      [{ blindUp: { mode: 'hands', every: 5, factor: 9 } }, 'Hệ số'],
      [{ smallBlind: 'abc' }, 'Blind'],
    ];
    for (const [patch, msg] of bad) {
      const r = await call(A, 'create', { ...baseTable, ...patch });
      assert.equal(r.status, 400, JSON.stringify(patch));
      assert.match(r.error, new RegExp(msg), JSON.stringify(patch));
    }
  });

  test('tạo bàn, ngồi ghế, lỗi ngồi trùng', async () => {
    const c = await call(A, 'create', baseTable);
    assert.equal(c.status, 200);
    tableId = c.id;
    let r = await call(A, 'sit', { tableId, seat: 0 });
    assert.equal(r.error, undefined);
    assert.equal(r.view.mySeat, 0);
    r = await call(B, 'sit', { tableId, seat: 0 });
    assert.equal(r.error, 'Ghế đã có người');
    r = await call(B, 'sit', { tableId, seat: 99 });
    assert.equal(r.error, 'Ghế không hợp lệ');
    r = await call(B, 'sit', { tableId, seat: 1 });
    assert.equal(r.error, undefined);
    assert.equal(r.view.pending.type, 'matchStart');
    r = await call(B, 'sit', { tableId, seat: 2 });
    assert.equal(r.error, 'Bạn đã ngồi ở bàn này');
    const bad = await call(A, 'view', { tableId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(bad.status, 400);
  });

  test('match tự bắt đầu; không ai thấy bài của người khác; không lộ bí mật', async () => {
    const va = await waitFor(A, tableId, (v) => v.hand && v.hand.phase === 'betting');
    assert.equal(va.match.no, 1);
    assert.ok(va.seats[0].cards.every(Boolean), 'A thấy bài của mình');
    assert.deepEqual(va.seats[1].cards, [null, null], 'A không thấy bài B');
    const vb = (await call(B, 'view', { tableId })).view;
    assert.deepEqual(vb.seats[0].cards, [null, null], 'B không thấy bài A');
    for (const c of va.seats[0].cards) assert.ok(!JSON.stringify({ ...vb, log: [] }).includes(`"${c}"`), 'lá của A lộ trong view của B');
    noSecrets(va, 'A'); noSecrets(vb, 'B');
  });

  test('hành động sai lượt bị từ chối; gửi trùng song song chỉ áp dụng 1 lần', async () => {
    const v = (await call(A, 'view', { tableId })).view;
    const actor = v.hand.toAct === 0 ? A : B;
    const other = actor === A ? B : A;
    const wrong = await call(other, 'act', { tableId, action: 'call' });
    assert.equal(wrong.error, 'Chưa đến lượt bạn');
    const before = v.hand.id;
    // 4 lệnh call giống nhau + 4 tick cùng lúc
    const reqs = [
      ...Array.from({ length: 4 }, () => call(actor, 'act', { tableId, action: 'call' })),
      ...Array.from({ length: 4 }, () => call(other, 'tick', { tableId })),
    ];
    const res = await Promise.all(reqs);
    for (const r of res) assert.equal(r.status, 200, JSON.stringify(r));
    const ok = res.slice(0, 4).filter((r) => !r.error).length;
    assert.equal(ok, 1, 'chỉ đúng 1 lệnh call được chấp nhận');
    const after = (await call(A, 'view', { tableId })).view;
    assert.equal(after.hand.id, before);
    const calls = after.log.filter((l) => / call /.test(l.text)).length;
    assert.equal(calls, 1);
  });

  test('chơi hết ván qua API; chip bảo toàn', async () => {
    for (let i = 0; i < 40; i++) {
      const v = (await call(A, 'tick', { tableId })).view;
      if (!v.hand || v.hand.phase === 'done') break;
      if (v.hand.phase === 'betting') {
        const u = v.hand.toAct === 0 ? A : B;
        const vv = (await call(u, 'view', { tableId })).view;
        if (vv.legal) await call(u, 'act', { tableId, action: vv.legal.canCheck ? 'check' : 'call' });
      } else await sleep(500);
    }
    const v = await waitFor(A, tableId, (x) => !x.hand || x.hand.phase === 'done', 15000);
    const total = v.seats.filter(Boolean).reduce((a, p) => a + p.stack + p.totalBet, 0);
    assert.equal(total, 2000);
  });

  test('hết giờ phía server: tự động bỏ bài/check sau actionTime', async () => {
    const v = await waitFor(A, tableId, (x) => x.hand && x.hand.phase === 'betting', 15000);
    const hid = v.hand.id, seat = v.hand.toAct;
    await sleep(10_800);
    const v2 = (await call(A, 'tick', { tableId })).view;
    const moved = v2.hand?.id !== hid || v2.hand.toAct !== seat;
    assert.ok(moved, 'người hết giờ phải bị tự động hành động');
    assert.ok(v2.log.some((l) => l.text.startsWith('(hết giờ)')));
  });

  test('RLS: client không đọc được bài/bộ bài, không ghi được dữ liệu, không gọi được hàm nội bộ', async () => {
    const st = await rest(A, 'GET', `poker_state?table_id=eq.${tableId}`);
    assert.deepEqual(st.data, [], 'poker_state phải ẩn hoàn toàn với client');
    const upd = await rest(A, 'PATCH', `poker_tables?id=eq.${tableId}`, { name: 'hacked' });
    assert.ok(upd.status >= 400 || (Array.isArray(upd.data) && upd.data.length === 0), 'không được sửa poker_tables');
    const ins = await rest(A, 'POST', 'poker_chat', { table_id: tableId, user_id: A.id, name: 'fake', text: 'spoof' });
    assert.ok(ins.status >= 400, 'không được chèn chat trực tiếp (giả mạo tên)');
    const prof = await rest(A, 'PATCH', `poker_profiles?id=eq.${A.id}`, { wins: 9999 });
    assert.ok(prof.status >= 400 || (Array.isArray(prof.data) && prof.data.length === 0), 'không được tự sửa số trận thắng');
    const rpc = await rest(A, 'POST', 'rpc/poker_commit', { p_table_id: tableId, p_expected: 0, p_state: {}, p_public: {}, p_deltas: {} });
    assert.ok(rpc.status >= 400, 'không được gọi poker_commit');
    const del = await rest(A, 'DELETE', `poker_tables?id=eq.${tableId}`);
    assert.ok(del.status >= 400 || (Array.isArray(del.data) && del.data.length === 0));
    const t = await rest(A, 'GET', `poker_tables?id=eq.${tableId}&select=name`);
    assert.equal(t.data[0].name, 'API test', 'tên bàn không bị đổi');
    const pl = await rest(A, 'GET', 'poker_profiles?select=*&limit=1');
    assert.equal(pl.status, 200);
    if (pl.data[0]) assert.ok(!('email' in pl.data[0]), 'bảng xếp hạng không lộ email');
  });

  test('chat qua API, đọc được bằng REST', async () => {
    const text = `hello ${Date.now()}`;
    const r = await call(A, 'chat', { tableId, text });
    assert.equal(r.ok, true);
    const empty = await call(A, 'chat', { tableId, text: '   ' });
    assert.equal(empty.status, 400);
    const q = await rest(B, 'GET', `poker_chat?table_id=eq.${tableId}&order=created_at.desc&limit=5`);
    const m = q.data.find((x) => x.text === text);
    assert.ok(m);
    assert.equal(m.user_id, A.id);
  });

  test('rời bàn giữa trận → người kia vô địch; rematch bắt đầu trận mới', async () => {
    await call(A, 'leave', { tableId });
    const v = await waitFor(B, tableId, (x) => x.match.over, 20000);
    assert.equal(v.match.winner.userId, B.id);
    await call(A, 'sit', { tableId, seat: 3 }); // ngồi lại lúc chờ rematch → tự sẵn sàng
    const r = await call(B, 'rematch', { tableId });
    assert.equal(r.error, undefined);
    const v2 = await waitFor(B, tableId, (x) => x.match.active && x.match.no === 2, 15000);
    assert.deepEqual(v2.match.participants.sort(), [A.id, B.id].sort());
  });

  test('bàn có mật khẩu', async () => {
    const c = await call(A, 'create', { ...baseTable, name: 'API private', password: 'bí mật' });
    privateId = c.id;
    const pub = await rest(B, 'GET', `poker_tables?id=eq.${privateId}&select=settings`);
    assert.equal(pub.data[0].settings.private, true);
    assert.ok(!JSON.stringify(pub.data).includes('bí mật'));
    let r = await call(B, 'sit', { tableId: privateId, seat: 0, password: 'sai' });
    assert.equal(r.error, 'Sai mật khẩu bàn');
    r = await call(B, 'sit', { tableId: privateId, seat: 0 });
    assert.equal(r.error, 'Sai mật khẩu bàn');
    r = await call(B, 'sit', { tableId: privateId, seat: 0, password: 'bí mật' });
    assert.equal(r.error, undefined);
  });
});
