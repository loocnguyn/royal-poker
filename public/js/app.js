import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { cardFace, cardBack, chipStack } from './cards.js';
import { speak, holeCardsSpeech, voiceSupported, hasVietnameseVoice } from './voice.js';
import { sfx, setSfxEnabled } from './sfx.js';
import { betModel } from './betting.js';
import { VoiceChat } from './voicechat.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ───────────────────────── tiện ích ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('vi-VN');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function avatarHTML(name, pic, cls = 'avatar') {
  if (pic) return `<img class="${cls}" src="${esc(pic)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;${cls}&quot;>${esc((name || '?')[0]).toUpperCase()}</span>'">`;
  return `<span class="${cls}">${esc((name || '?')[0]).toUpperCase()}</span>`;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}

// ───────────────────────── cài đặt cá nhân ─────────────────────────
const SETTINGS_KEY = 'rp-settings-v1';
const settings = Object.assign(
  { privacy: false, fourColor: false, back: 'red', sound: true, autoVoice: false, voiceRate: 1, autoVoiceChat: true },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* không sao */ } };
setSfxEnabled(settings.sound);

// ───────────────────────── state ─────────────────────────
const S = {
  user: null, profile: null, booted: false,
  tableId: null, view: null, offset: 0, lastServerTime: 0,
  tickTimer: null, pollTimer: null, channel: null, lobbyChannel: null,
  presence: null, online: [], where: { where: 'Sảnh' },
  inflight: false, again: false,
  seatEls: [], seatSig: [], holeSig: [], seatLayoutKey: '',
  boardHand: null, boardCount: 0, betEls: {},
  preFold: false, preFoldHand: 0, peek: false,
  dockKey: '', dismissedMatch: 0, celebratedMatch: 0,
  lastTickSec: -1, spokenKey: '',
  admins: new Set(), // id các tài khoản admin (bảng hub_profiles, client chỉ đọc được)
};

// ───────────────────────── API ─────────────────────────
async function api(op, params = {}) {
  const { data, error } = await sb.functions.invoke('poker', { body: { op, ...params } });
  if (error) {
    let msg = 'Lỗi kết nối máy chủ';
    try { const j = await error.context.json(); msg = j.error || msg; } catch { /* body không phải JSON */ }
    throw new Error(msg);
  }
  return data;
}

// ───────────────────────── màn hình ─────────────────────────
function show(name) {
  for (const s of ['login', 'lobby', 'table']) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
}

function renderLoginCards() {
  const cards = ['As', 'Kh', 'Qd'];
  $$('.lc').forEach((el, i) => { el.innerHTML = cardFace(cards[i], { fourColor: settings.fourColor }); });
}

// ───────────────────────── đăng nhập (tên đăng nhập + mật khẩu) ─────────────────────────
// Tài khoản nằm trong Supabase Auth với email nội bộ (không gửi mail) — xem functions/register.
const USER_DOMAIN = 'players.royalpoker.test';
let authMode = 'login';
$$('.auth-tab').forEach((t) => (t.onclick = () => {
  authMode = t.dataset.mode;
  $$('.auth-tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#f-name').classList.toggle('hidden', authMode !== 'register');
  $('#a-pass').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
  $('#auth-submit').textContent = authMode === 'register' ? 'Tạo tài khoản & vào chơi' : 'Đăng nhập';
}));
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#auth-submit');
  const username = $('#a-user').value.trim().toLowerCase();
  const password = $('#a-pass').value;
  btn.disabled = true;
  try {
    if (authMode === 'register') {
      const { error } = await sb.functions.invoke('register', { body: { username, password, name: $('#a-name').value } });
      if (error) {
        let msg = 'Không tạo được tài khoản';
        try { msg = (await error.context.json()).error || msg; } catch { /* body không phải JSON */ }
        throw new Error(msg);
      }
    }
    const { error } = await sb.auth.signInWithPassword({ email: `${username}@${USER_DOMAIN}`, password });
    if (error) throw new Error(/invalid/i.test(error.message) ? 'Sai tên đăng nhập hoặc mật khẩu' : error.message);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
};
$('#btn-logout').onclick = async () => { await sb.auth.signOut(); location.hash = ''; };

async function onSignedIn(session) {
  if (S.booted && S.user?.id === session.user.id) return;
  S.booted = true;
  S.user = session.user;
  loadAdmins();
  try {
    const r = await api('me');
    S.profile = r.profile;
  } catch (e) {
    toast(e.message, 'err');
    S.profile = { id: S.user.id, name: S.user.user_metadata?.full_name || 'Player', picture: S.user.user_metadata?.avatar_url || '', wins: 0, matches: 0 };
  }
  renderMe();
  startPresence();
  route();
}

function onSignedOut() {
  S.booted = false;
  S.user = null;
  leaveTable();
  if (S.presence) { sb.removeChannel(S.presence); S.presence = null; }
  show('login');
}

function renderMe() {
  const p = S.profile;
  $('#me-chip').innerHTML = `${avatarHTML(p.name, p.picture)}<div><b>${esc(p.name)}</b><span class="stats">🏆 ${fmt(p.wins)} thắng · ${fmt(p.matches)} trận</span></div>`;
}

// ───────────────────────── online presence ─────────────────────────
function startPresence() {
  if (S.presence) return;
  S.presence = sb.channel('rp-online', { config: { presence: { key: S.user.id } } });
  S.presence
    .on('presence', { event: 'sync' }, () => {
      const st = S.presence.presenceState();
      S.online = Object.values(st).map((arr) => arr[arr.length - 1]).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      renderOnline();
    })
    .subscribe(async (status) => { if (status === 'SUBSCRIBED') await track(S.where); });
}

async function track(where) {
  S.where = where;
  if (!S.presence || !S.profile) return;
  try { await S.presence.track({ id: S.user.id, name: S.profile.name, avatar: S.profile.picture, ...where }); } catch { /* chưa kết nối */ }
}

async function loadAdmins() {
  const { data } = await sb.from('hub_profiles').select('id').eq('role', 'admin');
  S.admins = new Set((data || []).map((r) => r.id));
  rerenderAll();
  renderVoice(voice.snapshot());
}
const adminTag = (id) => (S.admins.has(id) ? '<span class="role-admin">Admin</span>' : '');

function onlineListHTML() {
  if (!S.online.length) return '<li class="empty" style="padding:10px">Chưa có ai</li>';
  return S.online.map((u) => `
    <li>${avatarHTML(u.name, u.avatar)}
      <div class="who"><b>${esc(u.name)}${adminTag(u.id)}${u.id === S.user?.id ? ' (bạn)' : ''}</b>
      <small>${u.tableId ? `🃏 <a href="#/t/${esc(u.tableId)}" style="color:inherit">${esc(u.where)}</a>` : '🏛 Sảnh chờ'}</small></div>
      <span class="dot live"></span></li>`).join('');
}

function renderOnline() {
  $('#online-count').textContent = S.online.length;
  $('#online-count-2').textContent = S.online.length;
  $('#online-list').innerHTML = onlineListHTML();
  const d = $('#drawer-online');
  if (d) d.innerHTML = onlineListHTML();
}

$('#btn-online').onclick = () => {
  const root = $('#drawer-root');
  root.innerHTML = `<div class="drawer-backdrop"></div><div class="drawer"><h3 style="margin:0 0 14px">👥 Đang online (${S.online.length})</h3><ul class="people" id="drawer-online" style="max-height:none">${onlineListHTML()}</ul></div>`;
  $('.drawer-backdrop', root).onclick = () => (root.innerHTML = '');
  root.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => (root.innerHTML = '')));
};

// ───────────────────────── điều hướng ─────────────────────────
function route() {
  if (!S.user) return;
  const m = location.hash.match(/^#\/t\/([0-9a-f-]{36})/i);
  if (m) enterTable(m[1]);
  else enterLobby();
}
window.addEventListener('hashchange', route);

// ───────────────────────── sảnh ─────────────────────────
async function enterLobby() {
  leaveTable();
  show('lobby');
  track({ where: 'Sảnh' });
  loadTables();
  loadLeaderboard();
  if (!S.lobbyChannel) {
    S.lobbyChannel = sb.channel('rp-lobby')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_tables' }, debounce(() => { if (!S.tableId) loadTables(); }, 400))
      .subscribe();
  }
}

function blindUpText(bu) {
  if (!bu || bu.mode === 'off') return '';
  return `⬆ ×${bu.factor} mỗi ${bu.every} ${bu.mode === 'hands' ? 'ván' : 'phút'}`;
}

async function loadTables() {
  const { data, error } = await sb.from('poker_tables')
    .select('id,name,settings,players,hand_running,created_at')
    .order('players', { ascending: false }).order('created_at', { ascending: false }).limit(60);
  const list = $('#table-list');
  if (error) { list.innerHTML = `<div class="empty">Không tải được danh sách bàn</div>`; return; }
  if (!data.length) {
    list.innerHTML = `<div class="empty glass"><div class="big">🃏</div>Chưa có bàn nào — tạo bàn đầu tiên đi!</div>`;
    return;
  }
  list.innerHTML = data.map((t) => {
    const s = t.settings || {};
    const sbv = s.baseSmallBlind ?? s.smallBlind, bbv = s.baseBigBlind ?? s.bigBlind;
    const dots = Array.from({ length: s.maxSeats || 0 }, (_, i) => `<i class="${i < t.players ? 'on' : ''}"></i>`).join('');
    return `<div class="t-card glass" data-id="${t.id}" tabindex="0" role="button">
      <h4>${s.private ? '🔒 ' : ''}${esc(t.name)}</h4>
      <div class="blinds">${fmt(sbv)}/${fmt(bbv)}<small>${s.ante ? `ante ${fmt(s.ante)}` : 'blinds'}</small></div>
      <div class="meta">
        <span class="tag gold">💰 ${fmt(s.startingStack)} chip</span>
        <span class="tag">⏱ ${s.actionTime}s</span>
        ${blindUpText(s.blindUp) ? `<span class="tag">${blindUpText(s.blindUp)}</span>` : ''}
        ${s.muckLosers ? '<span class="tag">🙈 Úp bài thua</span>' : ''}
        ${s.lateJoin ? '<span class="tag">Vào muộn</span>' : ''}
      </div>
      <div class="foot">
        <div class="seat-dots">${dots}<span style="margin-left:6px;font-size:12.5px;color:var(--muted)">${t.players}/${s.maxSeats}</span></div>
        ${t.hand_running ? '<span class="tag live">● Đang chơi</span>' : '<span class="tag">Đang chờ</span>'}
      </div>
    </div>`;
  }).join('');
  $$('.t-card', list).forEach((el) => {
    el.onclick = () => (location.hash = `#/t/${el.dataset.id}`);
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
  });
}

async function loadLeaderboard() {
  const { data } = await sb.from('poker_profiles').select('id,name,avatar,wins,matches')
    .gt('matches', 0).order('wins', { ascending: false }).order('matches', { ascending: true }).limit(10);
  const el = $('#leaderboard');
  if (!data?.length) { el.innerHTML = '<li class="empty" style="padding:10px">Chưa có ai thắng trận nào</li>'; return; }
  el.innerHTML = data.map((u, i) => `<li><span class="rk r${i + 1}">${i + 1}</span>${avatarHTML(u.name, u.avatar)}
    <div class="who"><b>${esc(u.name)}</b><small>${fmt(u.matches)} trận · ${Math.round((u.wins / u.matches) * 100)}% thắng</small></div>
    <span class="score">${fmt(u.wins)} 🏆</span></li>`).join('');
}

// ───────────────────────── modal ─────────────────────────
function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal glass">${html}</div></div>`;
  const close = () => (root.innerHTML = '');
  $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  $$('[data-close]', root).forEach((b) => (b.onclick = close));
  onMount?.($('.modal', root), close);
  return close;
}

function segHTML(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function bindSeg(root, name, onChange) {
  const seg = $(`[data-seg="${name}"]`, root);
  seg.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    onChange(b.dataset.v);
  }));
}

$('#btn-create').onclick = () => {
  const f = {
    blinds: '25/50', sb: 25, bb: 50, ante: 0, stack: 5000, seats: 6, minPlayers: 2, time: 30,
    buMode: 'hands', buEvery: 10, buFactor: 1.5, muck: true, late: false,
  };
  modal(`
    <h3>Tạo bàn mới</h3>
    <form id="create-form">
      <div class="field"><label>Tên bàn</label><input name="name" maxlength="40" required value="${esc((S.profile?.name || 'My') + "'s table")}" /></div>
      <div class="section-title">Blinds &amp; chip</div>
      <div class="field"><span class="lbl">Blinds khởi điểm (SB/BB)</span>
        ${segHTML('blinds', [['5/10', '5/10'], ['10/20', '10/20'], ['25/50', '25/50'], ['50/100', '50/100'], ['100/200', '100/200'], ['custom', 'Tuỳ chỉnh']], f.blinds)}</div>
      <div class="row" id="custom-blinds" style="display:none">
        <div class="field"><label>Small blind</label><input type="number" name="sb" min="1" value="${f.sb}" /></div>
        <div class="field"><label>Big blind</label><input type="number" name="bb" min="2" value="${f.bb}" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Chip khởi điểm mỗi người</label><input type="number" name="stack" min="100" step="100" value="${f.stack}" />
          <span class="hint">Ai vào bàn cũng nhận đúng số chip này</span></div>
        <div class="field"><label>Ante</label><input type="number" name="ante" min="0" value="${f.ante}" /><span class="hint">0 = không có ante</span></div>
      </div>
      <div class="section-title">Tăng blind theo level</div>
      <div class="field">${segHTML('buMode', [['off', 'Tắt'], ['hands', 'Theo số ván'], ['minutes', 'Theo phút']], f.buMode)}</div>
      <div class="row" id="bu-opts">
        <div class="field"><label id="bu-every-lbl">Tăng sau mỗi (ván)</label><input type="number" name="buEvery" min="1" max="120" value="${f.buEvery}" /></div>
        <div class="field"><span class="lbl">Hệ số tăng</span>${segHTML('buFactor', [['1.25', '×1.25'], ['1.5', '×1.5'], ['2', '×2']], f.buFactor)}</div>
      </div>
      <div class="section-title">Bàn</div>
      <div class="row">
        <div class="field"><label>Số ghế</label><select name="seats">${[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option ${n === f.seats ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field"><label>Đủ bao nhiêu người thì bắt đầu</label><select name="minPlayers">${[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option ${n === f.minPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div class="field"><span class="lbl">Thời gian mỗi lượt</span>${segHTML('time', [[15, '15s'], [20, '20s'], [30, '30s'], [45, '45s'], [60, '60s']], f.time)}</div>
      <label class="check"><input type="checkbox" name="muck" ${f.muck ? 'checked' : ''}/><div><b>🙈 Không để lộ bài người thua</b><small>Khi lật bài, chỉ người thắng phải lật; người thua được úp bài</small></div></label>
      <label class="check"><input type="checkbox" name="late" ${f.late ? 'checked' : ''}/><div><b>Cho vào giữa trận</b><small>Tắt = người vào sau phải chờ trận kế tiếp (công bằng hơn)</small></div></label>
      <div class="field"><label>Mật khẩu (tuỳ chọn)</label><input name="password" maxlength="40" autocomplete="off" placeholder="Để trống = bàn công khai" /></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Huỷ</button><button class="btn btn-gold" id="create-submit">Tạo bàn</button></div>
    </form>`, (m, close) => {
    const form = $('#create-form', m);
    bindSeg(m, 'blinds', (v) => {
      f.blinds = v;
      $('#custom-blinds', m).style.display = v === 'custom' ? '' : 'none';
      if (v !== 'custom') { const [a, b] = v.split('/').map(Number); form.sb.value = a; form.bb.value = b; form.stack.value = b * 100; }
    });
    bindSeg(m, 'buMode', (v) => {
      f.buMode = v;
      $('#bu-opts', m).style.display = v === 'off' ? 'none' : '';
      $('#bu-every-lbl', m).textContent = v === 'minutes' ? 'Tăng sau mỗi (phút)' : 'Tăng sau mỗi (ván)';
    });
    bindSeg(m, 'buFactor', (v) => (f.buFactor = Number(v)));
    bindSeg(m, 'time', (v) => (f.time = Number(v)));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#create-submit', m);
      btn.disabled = true;
      try {
        const seats = Number(form.seats.value);
        const r = await api('create', {
          name: form.name.value,
          smallBlind: Number(form.sb.value), bigBlind: Number(form.bb.value), ante: Number(form.ante.value),
          startingStack: Number(form.stack.value), maxSeats: seats,
          minPlayers: Math.min(Number(form.minPlayers.value), seats),
          actionTime: f.time, muckLosers: form.muck.checked, lateJoin: form.late.checked,
          blindUp: { mode: f.buMode, every: Number(form.buEvery.value), factor: f.buFactor },
          password: form.password.value,
        });
        close();
        location.hash = `#/t/${r.id}`;
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    };
  });
};

// ───────────────────────── cài đặt ─────────────────────────
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-open="settings"]');
  if (b) openSettings();
});

function openSettings() {
  modal(`
    <h3>Cài đặt</h3>
    <label class="check"><input type="checkbox" id="st-privacy" ${settings.privacy ? 'checked' : ''}/><div><b>🙈 Chế độ riêng tư — không để lộ bài của tôi</b><small>Bài của bạn luôn úp trên màn hình; nhấn giữ để xem, hoặc dùng nút 🔊 nghe đọc bài (nên đeo tai nghe)</small></div></label>
    <label class="check"><input type="checkbox" id="st-voice" ${settings.autoVoice ? 'checked' : ''}/><div><b>🔊 Tự đọc bài trên tay</b><small>Tự đọc 2 lá của bạn mỗi khi được chia bài</small></div></label>
    <div class="field"><span class="lbl">Tốc độ đọc</span>${segHTML('rate', [['0.8', 'Chậm'], ['1', 'Vừa'], ['1.25', 'Nhanh']], settings.voiceRate)}</div>
    <label class="check"><input type="checkbox" id="st-four" ${settings.fourColor ? 'checked' : ''}/><div><b>Bộ bài 4 màu</b><small>♠ đen · ♥ đỏ · ♦ xanh dương · ♣ xanh lá — dễ nhìn Thùng hơn</small></div></label>
    <label class="check"><input type="checkbox" id="st-autovc" ${settings.autoVoiceChat ? 'checked' : ''}/><div><b>Tự vào voice khi vào bàn</b><small>Vào bàn là bật mic nói chuyện luôn. Tắt đi thì bấm "Vào voice" ở góc dưới khi cần.</small></div></label>
    <label class="check"><input type="checkbox" id="st-sound" ${settings.sound ? 'checked' : ''}/><div><b>Hiệu ứng âm thanh</b><small>Tiếng chia bài, chip, đến lượt…</small></div></label>
    <div class="field"><span class="lbl">Mặt sau lá bài</span>${segHTML('back', [['red', 'Đỏ'], ['blue', 'Xanh'], ['black', 'Đen']], settings.back)}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="st-test">🔊 Thử giọng đọc</button>
      <button class="btn btn-gold" data-close>Xong</button>
    </div>`, (m) => {
    const apply = () => { saveSettings(); setSfxEnabled(settings.sound); rerenderAll(); };
    $('#st-privacy', m).onchange = (e) => { settings.privacy = e.target.checked; apply(); };
    $('#st-voice', m).onchange = (e) => { settings.autoVoice = e.target.checked; apply(); };
    $('#st-four', m).onchange = (e) => { settings.fourColor = e.target.checked; apply(); };
    $('#st-sound', m).onchange = (e) => { settings.sound = e.target.checked; apply(); };
    $('#st-autovc', m).onchange = (e) => { settings.autoVoiceChat = e.target.checked; saveSettings(); };
    bindSeg(m, 'rate', (v) => { settings.voiceRate = Number(v); apply(); });
    bindSeg(m, 'back', (v) => { settings.back = v; apply(); });
    $('#st-test', m).onclick = () => {
      if (!voiceSupported()) return toast('Trình duyệt không hỗ trợ đọc giọng nói', 'err');
      speak(holeCardsSpeech(['Ah', 'Ks']), settings.voiceRate);
      if (!hasVietnameseVoice()) toast('Máy chưa có giọng tiếng Việt — thử Edge/Chrome hoặc cài giọng Vietnamese trong cài đặt hệ thống', 'err');
    };
  });
}

function rerenderAll() {
  renderLoginCards();
  if (S.view) { S.seatSig = []; S.holeSig = []; S.boardHand = null; S.dockKey = ''; renderTable(null, S.view, true); }
}

// ───────────────────────── bàn chơi ─────────────────────────
const nowServer = () => Date.now() + S.offset;

// ───────────────────────── voice chat ─────────────────────────
const VICON = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path class="slash" d="M4 4l16 16"/></svg>',
  spk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/></svg>',
  spkOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13" width="4" height="7" rx="1.5"/><rect x="17" y="13" width="4" height="7" rx="1.5"/><path class="slash" d="M4 4l16 16"/></svg>',
  leave: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 14.5c5-4.7 12-4.7 17 0l-2.2 2.3-3.3-1.4v-2.1a9 9 0 0 0-6 0v2.1l-3.3 1.4z"/></svg>',
  caret: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5l5-5 5 5"/></svg>',
};

const voice = new VoiceChat(sb, () => ({ id: S.user?.id, name: S.profile?.name || 'Player', picture: S.profile?.picture || '' }), renderVoice);
let voiceErrShown = '';

function renderVoice(v) {
  const bar = $('#voice-bar');
  const panel = $('#voice-panel');
  if (!bar || !panel) return;
  const n = v.members.length;
  if (!v.room || !voice.supported) {
    bar.classList.add('hidden');
    panel.classList.add('hidden');
    closeVoiceMenu();
    return;
  }
  bar.classList.remove('hidden');

  const me = v.members.find((m) => m.me);
  const micOn = v.joined && !v.muted && !v.deafened && !v.noMic;
  const status = !v.joined
    ? (v.joining ? 'Đang vào voice…' : n ? `${n} người đang trong voice` : 'Chưa có ai trong voice')
    : v.locked ? 'Bấm vào trang để nghe tiếng' : v.connecting ? 'Đang kết nối…' : 'Đã vào voice';
  const good = v.joined && !v.locked && !v.connecting;
  const sig = JSON.stringify([v.joined, v.joining, micOn, v.deafened, v.noMic, status, n, !!me?.speaking, S.profile?.name]);
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    const micTitle = v.noMic ? 'Chưa dùng được micro, bấm để thử lại' : micOn ? 'Tắt mic' : 'Bật mic';
    const spkTitle = v.deafened ? 'Bật loa' : 'Tắt loa';
    bar.innerHTML = `
      <div class="vb-info">
        <div class="vb-ava ${me?.speaking ? 'speaking' : ''}">${avatarHTML(S.profile?.name || '', S.profile?.picture || '')}</div>
        <div class="vb-text"><b>${v.joined ? `Voice · ${n} người` : 'Voice của bàn'}</b><small class="${good ? 'ok' : ''}">${status}</small></div>
      </div>
      <div class="vb-btns">${v.joined ? `
        <div class="vgroup">
          <button class="vbtn ${micOn ? '' : 'off'}" data-v="mic" title="${micTitle}" aria-label="${micTitle}" aria-pressed="${!micOn}">${micOn ? VICON.mic : VICON.micOff}</button>
          <button class="vcaret" data-v="menu-in" title="Chọn micro, âm lượng mic" aria-label="Chọn micro" aria-haspopup="menu">${VICON.caret}</button>
        </div>
        <div class="vgroup">
          <button class="vbtn ${v.deafened ? 'off' : ''}" data-v="spk" title="${spkTitle}" aria-label="${spkTitle}" aria-pressed="${v.deafened}">${v.deafened ? VICON.spkOff : VICON.spk}</button>
          <button class="vcaret" data-v="menu-out" title="Chọn loa / tai nghe, âm lượng" aria-label="Chọn loa" aria-haspopup="menu">${VICON.caret}</button>
        </div>
        <button class="vbtn leave" data-v="leave" title="Rời voice" aria-label="Rời voice">${VICON.leave}</button>`
      : `<button class="btn btn-gold btn-sm vb-join" data-v="join" ${v.joining ? 'disabled' : ''}>${v.joining ? 'Đang vào…' : 'Vào voice'}</button>`}
      </div>`;
    const on = (k, fn) => { const b = $(`[data-v="${k}"]`, bar); if (b) b.onclick = fn; };
    on('join', () => voice.join());
    on('mic', () => voice.toggleMic());
    on('spk', () => voice.toggleSpeaker());
    on('leave', () => { closeVoiceMenu(); voice.leave(); });
    on('menu-in', (e) => toggleVoiceMenu('in', e.currentTarget));
    on('menu-out', (e) => toggleVoiceMenu('out', e.currentTarget));
  }
  if (!v.joined) closeVoiceMenu();

  // danh sách người trong voice (cột bên phải)
  if (n) {
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="vp-head"><span class="dot ${v.joined ? 'live' : ''}"></span>Voice · ${n} người</div>
      <ul>${v.members.map((m) => `<li class="${m.speaking ? 'speaking' : ''}">
        <span class="vp-ava">${avatarHTML(m.name, m.picture)}</span>
        <span class="vp-name">${esc(m.name)}${adminTag(m.id)}${m.me ? ' <small>(bạn)</small>' : ''}</span>
        <span class="vp-state">${m.deafened ? VICON.spkOff : m.muted ? VICON.micOff : ''}</span>
      </li>`).join('')}</ul>`;
  } else {
    panel.classList.add('hidden');
  }

  // vòng sáng quanh ghế của người đang nói
  const byId = new Map(v.members.map((m) => [m.id, m]));
  for (const el of S.seatEls) {
    const m = byId.get(el.dataset.uid);
    const st = !m ? '' : m.speaking ? 'speaking' : m.deafened || m.muted ? 'muted' : 'on';
    if (el.dataset.voice !== st) el.dataset.voice = st;
  }

  if (v.error && v.error !== voiceErrShown) { voiceErrShown = v.error; toast(v.error, 'err'); }
  if (!v.error) voiceErrShown = '';
}

// ── menu chọn thiết bị (mũi tên cạnh nút mic / tai nghe) ──
let voiceMenu = null; // { kind, el, timer, anchor }

function closeVoiceMenu() {
  if (!voiceMenu) return;
  clearInterval(voiceMenu.timer);
  voiceMenu.el.remove();
  voiceMenu.anchor?.classList.remove('open');
  voiceMenu = null;
}

async function toggleVoiceMenu(kind, anchor) {
  if (voiceMenu?.kind === kind) { closeVoiceMenu(); return; }
  closeVoiceMenu();
  const d = await voice.listDevices();
  const el = document.createElement('div');
  el.className = 'voice-menu';
  el.setAttribute('role', 'menu');
  const opts = (list, current) => [{ id: '', label: 'Mặc định của máy' }, ...list]
    .map((x) => `<button class="vm-opt ${x.id === current ? 'on' : ''}" data-id="${esc(x.id)}" role="menuitemradio" aria-checked="${x.id === current}">${esc(x.label)}</button>`).join('');
  if (kind === 'in') {
    const g = Math.round(d.inputGain * 100);
    el.innerHTML = `<h4>Micro</h4>
      <div class="vm-list">${opts(d.inputs, d.inputId)}</div>
      <label class="vm-range"><span>Âm lượng mic <b id="vm-val">${g}%</b></span><input type="range" id="vm-vol" min="0" max="200" step="5" value="${g}" /></label>
      <div class="vm-meter" aria-hidden="true"><i id="vm-level"></i></div>
      <small class="vm-hint">Nói thử: thanh xanh nhảy là mic đang nhận tiếng.</small>`;
  } else {
    const vol = Math.round(d.outputVolume * 100);
    const list = !d.canPickOutput ? '<p class="vm-hint">Trình duyệt này không cho chọn loa, tiếng phát ra loa mặc định của máy.</p>'
      : d.outputs.length ? `<div class="vm-list">${opts(d.outputs, d.outputId)}</div>` : '<p class="vm-hint">Không đọc được danh sách loa của máy.</p>';
    el.innerHTML = `<h4>Loa / tai nghe</h4>${list}
      <label class="vm-range"><span>Âm lượng <b id="vm-val">${vol}%</b></span><input type="range" id="vm-vol" min="0" max="100" step="5" value="${vol}" /></label>`;
  }
  document.body.append(el);
  const r = anchor.closest('.vgroup').getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
  el.style.bottom = `${innerHeight - r.top + 8}px`;
  anchor.classList.add('open');

  el.querySelectorAll('.vm-opt').forEach((b) => (b.onclick = async () => {
    el.querySelectorAll('.vm-opt').forEach((o) => { o.classList.toggle('on', o === b); o.setAttribute('aria-checked', String(o === b)); });
    if (kind === 'in') await voice.setInput(b.dataset.id);
    else voice.setOutput(b.dataset.id);
  }));
  const range = $('#vm-vol', el);
  range.oninput = () => {
    $('#vm-val', el).textContent = `${range.value}%`;
    if (kind === 'in') voice.setInputGain(range.value / 100);
    else voice.setOutputVolume(range.value / 100);
  };
  const timer = kind === 'in' ? setInterval(() => { const l = $('#vm-level', el); if (l) l.style.width = `${Math.round(voice.inputLevel() * 100)}%`; }, 80) : 0;
  voiceMenu = { kind, el, timer, anchor };
}

document.addEventListener('pointerdown', (e) => {
  if (voiceMenu && !voiceMenu.el.contains(e.target) && !e.target.closest('.vcaret')) closeVoiceMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVoiceMenu(); });

function leaveTable() {
  clearTimeout(S.tickTimer);
  clearInterval(S.pollTimer);
  if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
  voice.setRoom(null);
  S.tableId = null;
  S.view = null;
  $('#seats').innerHTML = '';
  $('#board').innerHTML = '';
  $('#fx').innerHTML = '';
  $$('.overlay').forEach((o) => o.remove());
  S.seatEls = []; S.seatSig = []; S.holeSig = []; S.seatLayoutKey = ''; S.boardHand = null; S.betEls = {}; S.dockKey = '';
  $('#dock').innerHTML = '';
}

async function enterTable(id) {
  if (S.tableId === id) return;
  leaveTable();
  S.tableId = id;
  S.lastServerTime = 0;
  voice.setRoom(id);
  if (settings.autoVoiceChat) voice.join();
  show('table');
  $('#tt-name').textContent = 'Đang vào bàn…';
  $('#tt-sub').textContent = '';
  $('#chat-list').innerHTML = '';
  S.channel = sb.channel(`rp-t-${id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'poker_tables', filter: `id=eq.${id}` }, () => refresh())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'poker_chat', filter: `table_id=eq.${id}` }, (p) => addChat(p.new))
    .subscribe();
  S.pollTimer = setInterval(() => refresh(), 15000); // lưới an toàn nếu realtime rớt
  loadChat(id);
  await refresh();
  if (S.view) track({ where: S.view.name, tableId: id });
}

async function refresh() {
  if (!S.tableId) return;
  if (S.inflight) { S.again = true; return; }
  S.inflight = true;
  const id = S.tableId;
  try {
    const r = await api('view', { tableId: id });
    if (S.tableId === id) applyResponse(r);
  } catch (e) {
    if (/không tồn tại/i.test(e.message)) { toast('Bàn không còn tồn tại', 'err'); location.hash = '#/'; }
  } finally {
    S.inflight = false;
    if (S.again) { S.again = false; refresh(); }
  }
}

async function send(op, params = {}) {
  try {
    const r = await api(op, { tableId: S.tableId, ...params });
    applyResponse(r);
    if (r.error) { console.warn('[rp]', op, r.error); toast(r.error, 'err'); }
    return r;
  } catch (e) { console.warn('[rp]', op, e); toast(e.message, 'err'); return null; }
}

function applyResponse(r) {
  if (!r?.view) return;
  const v = r.view;
  if (v.serverTime < S.lastServerTime) return; // phản hồi cũ đến muộn
  S.lastServerTime = v.serverTime;
  S.offset = v.serverTime - Date.now();
  const prev = S.view;
  S.view = v;
  renderTable(prev, v);
  scheduleTick(v);
}

function scheduleTick(v) {
  clearTimeout(S.tickTimer);
  if (!v.nextWake) return;
  // Người trong bàn tick sớm hơn khán giả để tránh cả bàn cùng gọi một lúc
  const jitter = v.mySeat !== -1 ? 80 + Math.random() * 250 : 700 + Math.random() * 900;
  const delay = Math.max(0, v.nextWake - nowServer()) + jitter;
  const id = S.tableId;
  S.tickTimer = setTimeout(async () => {
    if (S.tableId !== id) return;
    try { applyResponse(await api('tick', { tableId: id })); } catch { /* sẽ thử lại khi có cập nhật */ }
  }, Math.min(delay, 2 ** 31 - 1));
}

// ── hình học bàn ──
function geom() {
  const portrait = matchMedia('(max-width: 640px)').matches;
  return portrait
    ? { seat: [38, 44], bet: [24, 27], myBet: [0, 17], dealer: [29, 34], pot: { x: 50, y: 33 } }
    : { seat: [45, 41], bet: [31, 25], myBet: [0, 19], dealer: [36, 31], pot: { x: 50, y: 33 } };
}
function visualIndex(i, v) {
  const n = v.settings.maxSeats;
  return v.mySeat >= 0 ? (i - v.mySeat + n) % n : i;
}
function angleOf(i, v) { return ((90 + (visualIndex(i, v) * 360) / v.settings.maxSeats) * Math.PI) / 180; }
function pointAt(i, v, kind) {
  const g = geom();
  const a = angleOf(i, v) + (kind === 'dealer' ? 0.32 : 0);
  let [rx, ry] = g[kind];
  if (kind === 'bet' && visualIndex(i, v) === 0) { rx = g.myBet[0]; ry = g.myBet[1]; }
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

// ── lá bài ──
function cardHTML(card, { down = false, cls = '', style = '' } = {}) {
  const face = card ? cardFace(card, { fourColor: settings.fourColor }) : '';
  return `<div class="card ${!card || down ? 'down' : ''} ${cls}" style="${style}" ${card ? `data-card="${card}"` : ''}>
    <div class="inner"><div class="face">${face}</div><div class="back">${cardBack(settings.back)}</div></div></div>`;
}

function actClass(a) {
  const w = (a || '').toLowerCase();
  if (w.startsWith('fold')) return 'fold';
  if (w.startsWith('check')) return 'check';
  if (w.startsWith('call')) return 'call';
  if (w.startsWith('all')) return 'allin';
  if (w.startsWith('bet')) return 'bet';
  if (w.startsWith('raise')) return 'raise';
  return '';
}

function actLabel(a) {
  if (!a) return '';
  return a.replace(/(\d+)/, (m) => fmt(m));
}

function buildSeats(v) {
  const n = v.settings.maxSeats;
  const key = `${n}:${v.mySeat}:${matchMedia('(max-width: 640px)').matches}`;
  if (key === S.seatLayoutKey) return;
  S.seatLayoutKey = key;
  const box = $('#seats');
  box.innerHTML = '';
  S.seatEls = [];
  S.seatSig = [];
  S.holeSig = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'seat';
    const p = pointAt(i, v, 'seat');
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;
    if (Math.sin(angleOf(i, v)) < -0.35) el.style.flexDirection = 'column-reverse';
    el.innerHTML = '<div class="holes"></div><div class="seat-body"></div>';
    box.append(el);
    S.seatEls.push(el);
  }
  // Chỗ đặt chip cược
  let bets = $('#bets');
  if (!bets) { bets = document.createElement('div'); bets.id = 'bets'; bets.className = 'fx'; bets.style.zIndex = 4; $('#table-wrap').append(bets); }
  bets.innerHTML = '';
  S.betEls = {};
}

function renderSeat(i, v, prev) {
  const el = S.seatEls[i];
  const p = v.seats[i];
  const h = v.hand;
  const isMe = i === v.mySeat;
  const acting = !!h && h.phase === 'betting' && h.toAct === i;
  const done = h?.phase === 'done';
  const matchOut = p && v.match.active && (p.place > 0 || p.waiting);
  el.dataset.uid = p?.userId || '';

  el.className = ['seat', p ? '' : 'empty', isMe ? 'me' : '', acting ? 'acting' : '',
    p?.folded ? 'folded' : '', p && done && p.winner ? 'winner' : '', matchOut ? 'out' : '',
    isMe && settings.privacy ? 'privacy' : '', isMe && S.peek ? 'peek' : ''].filter(Boolean).join(' ');

  // ── phần thân ghế ──
  const body = $('.seat-body', el);
  if (!p) {
    const sig = `empty:${v.mySeat}`;
    if (S.seatSig[i] !== sig) {
      S.seatSig[i] = sig;
      body.innerHTML = `<div class="pod"><button class="sit-btn" ${v.mySeat !== -1 ? 'disabled' : ''} title="Ngồi ghế ${i + 1}">${v.mySeat !== -1 ? '' : 'Ngồi'}</button></div>`;
      const btn = $('.sit-btn', body);
      if (btn) btn.onclick = () => sitAt(i);
    }
    $('.holes', el).innerHTML = '';
    S.holeSig[i] = '';
    return;
  }

  const badges = [];
  if (p.place > 0 && v.match.active) badges.push(`<span class="badge place">Hạng ${p.place}</span>`);
  else if (p.waiting) badges.push('<span class="badge wait">Chờ trận sau</span>');
  else if (p.sittingOut) badges.push('<span class="badge out">Ngồi ngoài</span>');
  if (!v.match.active && p.rematch && v.match.over) badges.push('<span class="badge ready">✓ Sẵn sàng</span>');

  const showWon = done && p.won > 0;
  const sig = JSON.stringify([p.name, p.picture, p.stack, p.lastAction, badges, showWon ? p.won : 0, h?.id, p.handName, done, S.admins.has(p.userId)]);
  if (S.seatSig[i] !== sig) {
    S.seatSig[i] = sig;
    const tag = p.lastAction ? `<span class="act-tag ${actClass(p.lastAction)}">${esc(actLabel(p.lastAction))}</span>` : '';
    body.innerHTML = `
      <div class="pod">
        ${tag}
        <div class="ava-wrap ${S.admins.has(p.userId) ? 'is-admin' : ''}"><div class="ring"></div>${avatarHTML(p.name, p.picture)}${S.admins.has(p.userId) ? '<span class="admin-ribbon">Admin</span>' : ''}</div>
        <div class="plate"><div class="nm">${esc(p.name)}</div><div class="st">${p.stack > 0 || v.match.active ? fmt(p.stack) : '—'}</div></div>
      </div>
      <div class="badges">${badges.join('')}</div>
      ${done && p.handName ? `<div class="hand-name">${esc(p.handName)}</div>` : ''}
      ${showWon ? `<div class="won">+${fmt(p.won)}</div>` : ''}`;
  }

  // ── bài tẩy ──
  const cards = p.cards || [];
  const bestSet = new Set(done ? (p.bestCards || []) : []);
  const hideMine = isMe && settings.privacy && !S.peek;
  const holeSig = JSON.stringify([h?.id, cards, p.folded, settings.fourColor, settings.back, isMe && settings.privacy]);
  const holes = $('.holes', el);
  if (S.holeSig[i] !== holeSig) {
    const prevSig = S.holeSig[i] ? JSON.parse(S.holeSig[i]) : null;
    const newHand = !prevSig || prevSig[0] !== h?.id || (prevSig[1]?.length || 0) === 0;
    const revealed = prevSig && prevSig[0] === h?.id && prevSig[1]?.[0] === null && cards[0];
    S.holeSig[i] = holeSig;
    if (!cards.length) { holes.innerHTML = ''; }
    else {
      const wrap = $('#table-wrap').getBoundingClientRect();
      const sp = pointAt(i, v, 'seat');
      const dx = (50 - sp.x) / 100 * wrap.width, dy = (50 - sp.y) / 100 * wrap.height;
      const order = dealOrder(v, i);
      holes.innerHTML = cards.map((c, k) => {
        const cls = [newHand && h?.phase !== 'done' ? 'deal-in' : '', revealed ? 'flip-in' : ''].join(' ');
        const delay = (k * order.n + order.idx) * 0.09;
        return cardHTML(c, { down: isMe ? hideMine : !c, cls, style: `--dx:${dx}px;--dy:${dy}px;--delay:${delay}s` });
      }).join('');
      if (newHand && h?.phase !== 'done') cards.forEach((_, k) => setTimeout(() => sfx.deal(0), ((k * order.n + order.idx) * 90)));
      if (isMe) bindPeek(holes);
    }
  }
  // cập nhật trạng thái úp/ngửa (riêng tư) & highlight mà không vẽ lại
  $$('.card', holes).forEach((c) => {
    if (isMe && c.dataset.card) c.classList.toggle('down', hideMine);
    c.classList.toggle('best', bestSet.has(c.dataset.card));
  });
}

function dealOrder(v, seat) {
  const n = v.settings.maxSeats;
  const inHand = [];
  const start = v.hand?.sb ?? 0;
  for (let k = 0; k < n; k++) { const s = (start + k) % n; if (v.seats[s]?.inHand) inHand.push(s); }
  return { idx: Math.max(0, inHand.indexOf(seat)), n: inHand.length || 1 };
}

function bindPeek(holes) {
  const on = (e) => { e.preventDefault(); if (!settings.privacy) return; S.peek = true; peekUpdate(); };
  const off = () => { if (!S.peek) return; S.peek = false; peekUpdate(); };
  holes.onpointerdown = on;
  holes.onpointerup = off;
  holes.onpointerleave = off;
  holes.onpointercancel = off;
  holes.oncontextmenu = (e) => e.preventDefault();
}
function peekUpdate() {
  const v = S.view;
  if (!v || v.mySeat === -1) return;
  renderSeat(v.mySeat, v, null);
  renderDock(v, true);
}
window.addEventListener('pointerup', () => { if (S.peek) { S.peek = false; peekUpdate(); } });

function renderBoard(v, prev) {
  const board = $('#board');
  const h = v.hand;
  const cards = h?.board || [];
  if (S.boardHand !== (h?.id ?? null)) {
    S.boardHand = h?.id ?? null;
    S.boardCount = 0;
    board.innerHTML = Array.from({ length: 5 }, () => '<div class="slot"></div>').join('');
  }
  const slots = board.children;
  if (cards.length > S.boardCount) {
    for (let k = S.boardCount; k < cards.length; k++) {
      const delay = (k - S.boardCount) * 0.14;
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHTML(cards[k], { cls: 'flip-in', style: `--delay:${delay}s` });
      slots[k].replaceWith(tmp.firstElementChild);
      setTimeout(() => sfx.flip(), delay * 1000);
    }
    S.boardCount = cards.length;
  }
  // highlight 5 lá thắng
  const done = h?.phase === 'done' && h.street === 'showdown';
  const best = new Set();
  if (done) v.seats.forEach((p) => { if (p?.winner) (p.bestCards || []).forEach((c) => best.add(c)); });
  $$('.card', board).forEach((c) => {
    c.classList.toggle('best', done && best.has(c.dataset.card));
    c.classList.toggle('dim', done && best.size > 0 && !best.has(c.dataset.card));
  });
}

function renderPotAndBanners(v) {
  const h = v.hand;
  const potEl = $('#pot'), banner = $('#banner'), res = $('#hand-result');
  // pot
  const collected = (h?.pots || []).reduce((a, b) => a + b, 0);
  if (h && h.phase !== 'done' && collected > 0) {
    potEl.innerHTML = `<div class="pot-main">${chipStack(collected, 22)}<span class="lbl">POT</span>${fmt(collected)}</div>
      ${h.pots.length > 1 ? `<div class="side-pots">${h.pots.map((a, k) => `<span>${k === 0 ? 'Main' : `Side ${k}`}: ${fmt(a)}</span>`).join('')}</div>` : ''}`;
  } else potEl.innerHTML = '';

  // kết quả ván
  if (h?.phase === 'done' && h.results) {
    const r = h.results[0];
    const names = r.winners.map((s) => v.seats[s]?.name).filter(Boolean).join(', ');
    res.innerHTML = `<div class="hr">🏆 ${esc(names)} thắng ${fmt(h.results.reduce((a, x) => a + x.amount, 0))}${r.handName ? ` · ${esc(r.handName)}` : ''}</div>`;
  } else res.innerHTML = '';

  // banner trạng thái match
  const m = v.match;
  let bn = '';
  if (!m.active && !m.over) {
    const need = Math.max(2, v.settings.minPlayers || 2);
    if (v.pending?.type === 'matchStart') {
      const sec = Math.max(0, Math.ceil((v.pending.at - nowServer()) / 1000));
      bn = `<div class="bn">Match bắt đầu sau <b data-countdown="${v.pending.at}">${sec}</b>s · ${v.ready} người</div>`;
    } else {
      bn = `<div class="bn">Đang chờ người chơi (${v.ready}/${need})${v.mySeat === -1 ? ' — chọn ghế để ngồi' : ''}</div>`;
    }
  } else if (m.active && !h) {
    bn = '';
  }
  if (banner.innerHTML !== bn) banner.innerHTML = bn;
  potEl.style.visibility = bn ? 'hidden' : '';
}

function renderBets(v, prev) {
  const box = $('#bets');
  if (!box) return;
  const g = geom();
  v.seats.forEach((p, i) => {
    const amount = p?.bet || 0;
    let el = S.betEls[i];
    if (!amount) { if (el) { el.remove(); delete S.betEls[i]; } return; }
    const pt = pointAt(i, v, 'bet');
    if (!el) {
      el = document.createElement('div');
      el.className = 'bet';
      const sp = pointAt(i, v, 'seat');
      const wrap = $('#table-wrap').getBoundingClientRect();
      el.style.setProperty('--dx', `${(sp.x - pt.x) / 100 * wrap.width}px`);
      el.style.setProperty('--dy', `${(sp.y - pt.y) / 100 * wrap.height}px`);
      box.append(el);
      S.betEls[i] = el;
    }
    el.style.left = `${pt.x}%`;
    el.style.top = `${pt.y}%`;
    if (el.dataset.amount !== String(amount)) {
      el.dataset.amount = amount;
      el.innerHTML = `${chipStack(amount, 20)}${fmt(amount)}`;
    }
  });
  void g;
}

function flyChips(from, to, amount, delay = 0) {
  const fx = $('#fx');
  const el = document.createElement('div');
  el.className = 'fly';
  el.innerHTML = chipStack(amount, 22);
  el.style.left = `${from.x}%`;
  el.style.top = `${from.y}%`;
  fx.append(el);
  setTimeout(() => {
    el.getBoundingClientRect();
    el.style.left = `${to.x}%`;
    el.style.top = `${to.y}%`;
    setTimeout(() => { el.style.opacity = '0'; }, 450);
    setTimeout(() => el.remove(), 800);
  }, delay);
}

function renderDealer(v) {
  const d = $('#dealer-btn');
  if (v.button < 0 || !v.seats[v.button] || !v.hand) { d.classList.remove('show'); return; }
  const p = pointAt(v.button, v, 'dealer');
  d.style.left = `${p.x}%`;
  d.style.top = `${p.y}%`;
  d.classList.add('show');
}

function renderHeader(v) {
  $('#tt-name').textContent = `${v.settings.private ? '🔒 ' : ''}${v.name}`;
  const s = v.settings;
  const bu = s.blindUp;
  let next = '';
  if (bu && bu.mode !== 'off' && v.match.active && v.blinds.next) {
    next = bu.mode === 'hands'
      ? ` · lên <b>${fmt(v.blinds.next.smallBlind)}/${fmt(v.blinds.next.bigBlind)}</b> sau ${Math.max(0, bu.every - v.blinds.handsInLevel)} ván`
      : ` · lên <b>${fmt(v.blinds.next.smallBlind)}/${fmt(v.blinds.next.bigBlind)}</b> sau <span data-levelat="${v.blinds.levelStartedAt + bu.every * 60000}"></span>`;
  }
  $('#tt-sub').innerHTML = `Blind <b>${fmt(s.smallBlind)}/${fmt(s.bigBlind)}</b>${s.ante ? ` ante ${fmt(s.ante)}` : ''}${v.match.active ? ` · Level ${v.blinds.level + 1}` : ''}${next}${v.match.no ? ` · Match #${v.match.no}` : ''}`;
}

function renderLog(v) {
  const box = $('#log-list');
  const key = v.log.length + ':' + (v.log[v.log.length - 1]?.t || 0);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = v.log.map((l) => `<div class="${/^(──|══|🏆)/.test(l.text) ? 'sep' : ''}">${esc(l.text)}</div>`).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ── dock (hành động) ──
function renderDock(v, force = false) {
  const dock = $('#dock');
  const me = v.mySeat !== -1 ? v.seats[v.mySeat] : null;
  const h = v.hand;
  const L = v.legal;

  if (L) {
    const key = `act:${h.id}:${h.street}:${h.currentBet}:${h.toAct}:${L.toCall}:${L.maxTo}`;
    if (!force && S.dockKey === key) return;
    S.dockKey = key;
    return renderActions(dock, v, L);
  }

  const handLbl = v.myHand && (!settings.privacy || S.peek) ? `<span class="my-hand-lbl">${esc(v.myHand.name)}</span>` : '';
  const key = JSON.stringify(['info', v.mySeat, me?.sittingOut, me?.cards?.length, me?.folded, h?.id, h?.phase, v.canShow, v.canRematch, handLbl, S.preFold, v.match.active, me?.waiting, me?.place]);
  if (!force && S.dockKey === key) return;
  S.dockKey = key;

  if (!me) {
    const midMatch = v.match.active && !v.settings.lateJoin;
    dock.innerHTML = `<div class="dock-inner glass"><div class="info">👀 Bạn đang xem bàn. ${midMatch ? 'Trận đang diễn ra — ngồi vào sẽ chơi từ trận sau.' : 'Chọn một ghế trống để ngồi.'}</div></div>`;
    return;
  }
  const inHand = me.inHand && !me.folded && h && h.phase !== 'done';
  dock.innerHTML = `<div class="dock-inner glass">
    <div class="info">
      ${handLbl}
      ${me.cards?.length ? `<button class="btn btn-sm" id="d-voice" title="Đọc bài bằng giọng nói">🔊 Đọc bài</button>` : ''}
      ${inHand ? `<label class="pre-act"><input type="checkbox" id="d-prefold" ${S.preFold ? 'checked' : ''}/> Tự Check/Fold</label>` : ''}
      ${v.canShow ? '<button class="btn btn-sm btn-gold" id="d-show">👀 Lật bài</button>' : ''}
      ${v.canRematch ? '<button class="btn btn-sm btn-gold" id="d-rematch">🔁 Rematch</button>' : ''}
      ${me.place > 0 && v.match.active ? `<span>Bạn đã bị loại — hạng <b>${me.place}</b>. Chờ trận sau nhé!</span>` : ''}
      ${me.waiting && v.match.active ? '<span>⏳ Bạn sẽ vào từ trận sau</span>' : ''}
      <button class="btn btn-sm" id="d-sitout">${me.sittingOut ? '▶ Quay lại chơi' : '⏸ Ngồi ngoài'}</button>
      <button class="btn btn-sm btn-ghost" id="d-leave">🚪 Rời bàn</button>
    </div></div>`;
  $('#d-voice')?.addEventListener('click', readMyCards);
  $('#d-prefold')?.addEventListener('change', (e) => { S.preFold = e.target.checked; S.preFoldHand = h?.id; });
  $('#d-show')?.addEventListener('click', () => send('show'));
  $('#d-rematch')?.addEventListener('click', () => send('rematch'));
  $('#d-sitout').onclick = () => send('sitout', { value: !me.sittingOut });
  $('#d-leave').onclick = leaveSeat;
}

// Một nút hành động đi theo thanh kéo: đầu thanh = Check/Call, kéo lên = Bet/Raise, hết cỡ = All-in.
function renderActions(dock, v, L) {
  const step = Math.max(1, v.settings.smallBlind);
  const bm = betModel(L, step);
  const handLbl = v.myHand && (!settings.privacy || S.peek) ? `<span class="my-hand-lbl">${esc(v.myHand.name)}</span>` : '';

  dock.innerHTML = `<div class="dock-inner glass">
    ${bm.canSlide ? `<div class="raise-row">
      <div class="presets">
        <button data-p="call">${L.canCheck ? 'Check' : 'Call'}</button><button data-p="min">Min</button><button data-p="0.5">½ Pot</button><button data-p="0.75">¾ Pot</button><button data-p="1">Pot</button><button data-p="all">All-in</button>
      </div>
      <input type="range" id="r-range" min="${bm.callTo}" max="${bm.max}" step="${step}" value="${bm.callTo}" aria-label="Mức cược" />
      <input class="amt" id="r-amt" type="number" min="${bm.callTo}" max="${bm.max}" value="${bm.callTo}" aria-label="Số chip" />
    </div>` : ''}
    <div class="act-row">
      <button class="btn btn-red" id="a-fold">Fold<span class="kbd">F</span></button>
      <button class="btn btn-teal" id="a-main"><span id="m-lbl"></span><small id="m-sub"></small></button>
    </div>
    <div class="info">${handLbl}<button class="btn btn-sm" id="d-voice">🔊 Đọc bài</button></div>
  </div>`;

  const range = $('#r-range'), amt = $('#r-amt'), main = $('#a-main');
  let cur = bm.callTo;
  const paint = (val) => {
    const lb = bm.label(val);
    $('#m-lbl').textContent = lb.text;
    $('#m-sub').textContent = lb.amount == null ? '' : fmt(lb.amount);
    main.classList.toggle('btn-teal', lb.kind === 'call');
    main.classList.toggle('btn-gold', lb.kind === 'raise');
  };
  const setVal = (x) => {
    cur = bm.snap(x);
    if (range) range.value = cur;
    if (amt) amt.value = cur;
    paint(cur);
  };
  setVal(bm.callTo); // mặc định = Check/Call (an toàn nhất)
  if (bm.canSlide) {
    range.oninput = () => setVal(range.value);
    amt.oninput = () => { cur = bm.snap(amt.value); range.value = cur; paint(cur); };
    amt.onchange = () => setVal(amt.value);
    $$('.presets button').forEach((b) => (b.onclick = () => {
      const p = b.dataset.p;
      setVal(p === 'call' ? bm.callTo : p === 'min' ? L.minTo : p === 'all' ? L.maxTo : bm.potFraction(Number(p)));
    }));
  }
  main.onclick = () => {
    const a = bm.action(amt ? amt.value : cur);
    doAct(a.action, a.amount);
  };
  $('#a-fold').onclick = () => doAct('fold');
  $('#d-voice').onclick = readMyCards;
}

let acting = false;
async function doAct(action, amount) {
  if (acting) return;
  acting = true;
  $$('.act-row .btn').forEach((b) => (b.disabled = true));
  await send('act', { action, amount });
  acting = false;
  // Nếu vẫn còn lượt (vd. server báo lỗi), vẽ lại để các nút bật trở lại
  if (S.view?.legal) { S.dockKey = ''; renderDock(S.view); }
}

document.addEventListener('keydown', (e) => {
  if (!S.view?.legal || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f') $('#a-fold')?.click();
  else if (k === 'c') doAct(S.view.legal.canCheck ? 'check' : 'call'); // check/call ngay, bỏ qua thanh kéo
  else if (k === 'r' || k === 'enter') $('#a-main')?.click();
});

function readMyCards() {
  const v = S.view;
  if (!v || v.mySeat === -1) return;
  if (!voiceSupported()) return toast('Trình duyệt không hỗ trợ giọng nói', 'err');
  const me = v.seats[v.mySeat];
  speak(holeCardsSpeech(me.cards), settings.voiceRate);
  if (!hasVietnameseVoice()) toast('Chưa có giọng tiếng Việt trên máy — dùng Edge/Chrome để nghe chuẩn hơn', 'err');
}

// Tự đọc bài trên tay một lần mỗi ván (khi vừa được chia)
function autoVoice(v) {
  if (!settings.autoVoice || v.mySeat === -1 || !v.hand) return;
  const me = v.seats[v.mySeat];
  if (!me?.cards?.[0] || String(v.hand.id) === S.spokenKey) return;
  S.spokenKey = String(v.hand.id);
  speak(holeCardsSpeech(me.cards), settings.voiceRate);
}

// ── overlay: vô địch & rematch ──
function renderOverlay(v) {
  const stage = $('.stage');
  let ov = $('.overlay', stage);
  const m = v.match;
  if (!m.over || S.dismissedMatch === m.no) { ov?.remove(); return; }
  if (!ov) { ov = document.createElement('div'); ov.className = 'overlay'; stage.append(ov); }
  if (S.celebratedMatch !== m.no) {
    S.celebratedMatch = m.no;
    sfx.fanfare();
    confetti();
  }
  const w = m.winner;
  const me = v.mySeat !== -1 ? v.seats[v.mySeat] : null;
  const readyNames = v.seats.filter((p) => p?.rematch).map((p) => p.name);
  const countdown = v.pending?.type === 'matchStart'
    ? `<div class="countdown" data-countdown="${v.pending.at}">${Math.max(0, Math.ceil((v.pending.at - nowServer()) / 1000))}</div><div class="wsub">Rematch sắp bắt đầu…</div>` : '';
  const html = `<div class="winner-card">
      <svg class="trophy" viewBox="0 0 64 64"><defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".5" stop-color="#e2b75a"/><stop offset="1" stop-color="#8a6516"/></linearGradient></defs>
        <path fill="url(#tg)" d="M18 6h28v6h10v6c0 8-6 14-13 15-2 5-5 8-9 9v6h8v6H22v-6h8v-6c-4-1-7-4-9-9-7-1-13-7-13-15v-6h10V6zm-6 12c0 4 3 8 7 9-1-3-1-6-1-9h-6zm40 0h-6c0 3 0 6-1 9 4-1 7-5 7-9z"/>
        <rect x="18" y="56" width="28" height="4" rx="2" fill="#8a6516"/></svg>
      ${w ? `${avatarHTML(w.name, w.picture)}<div class="wname">${esc(w.name)}</div><div class="wsub">Vô địch Match #${m.no}${w.userId === S.user.id ? ' — chúc mừng bạn! 🎉' : ''}</div>` : '<div class="wname">Match kết thúc</div>'}
      ${countdown}
      <ul class="standings">${(m.standings || []).map((st) => `<li><span class="medal">${['🥇', '🥈', '🥉'][st.place - 1] || `#${st.place}`}</span><span class="nm">${esc(st.name)}</span>${readyNames.includes(st.name) ? '<span class="rd">✓ rematch</span>' : ''}</li>`).join('')}</ul>
      <div class="winner-actions">
        ${v.canRematch ? '<button class="btn btn-gold" id="ov-rematch">🔁 Rematch</button>' : me?.rematch ? `<span class="tag live">✓ Đã sẵn sàng · ${readyNames.length} người</span>` : ''}
        <button class="btn btn-ghost" id="ov-close">Xem bàn</button>
        ${me ? '<button class="btn btn-ghost" id="ov-leave">Rời bàn</button>' : ''}
      </div>
    </div>`;
  if (ov.dataset.html !== html) {
    ov.dataset.html = html;
    ov.innerHTML = html;
    $('#ov-rematch', ov)?.addEventListener('click', () => send('rematch'));
    $('#ov-close', ov).onclick = () => { S.dismissedMatch = m.no; ov.remove(); };
    $('#ov-leave', ov)?.addEventListener('click', leaveSeat);
  }
}

// ── pháo giấy ──
function confetti() {
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#f7e08a', '#e2b75a', '#e5484d', '#1fb89e', '#3b82f6', '#ffffff'];
  const parts = Array.from({ length: 180 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 16 - 4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 10, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
    }
    if (t - t0 < 4200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

// ── hiệu ứng khi trạng thái đổi ──
function transitions(prev, v) {
  if (!prev) return;
  const ph = prev.hand, h = v.hand;
  const sameHand = ph && h && ph.id === h.id;
  const potPt = geom().pot;

  // âm thanh theo hành động
  v.seats.forEach((p, i) => {
    const q = prev.seats[i];
    if (!p || !q || p.lastAction === q.lastAction || !p.lastAction || !sameHand) return;
    const c = actClass(p.lastAction);
    if (c === 'fold') sfx.fold();
    else if (c === 'check') sfx.check();
    else if (c) sfx.chips();
  });

  // gom cược vào pot khi hết vòng
  if (sameHand) {
    let flew = false;
    prev.seats.forEach((q, i) => {
      if (q?.bet > 0 && !(v.seats[i]?.bet > 0)) { flyChips(pointAt(i, prev, 'bet'), potPt, q.bet); flew = true; }
    });
    if (flew) setTimeout(() => sfx.chips(), 350);
  }

  // trả pot cho người thắng
  if (h?.phase === 'done' && h.results && !(sameHand && ph.phase === 'done')) {
    const delay = 550;
    for (const r of h.results) for (const s of r.winners) flyChips(potPt, pointAt(s, v, 'seat'), r.amount, delay);
    setTimeout(() => sfx.win(), delay);
    if (h.results.some((r) => r.winners.includes(v.mySeat)) && h.street === 'showdown') setTimeout(() => confettiSmall(), delay);
  }

  // đến lượt mình
  if (v.legal && !prev.legal) {
    sfx.turn();
    if (S.preFold && S.preFoldHand === h.id) {
      S.preFold = false;
      setTimeout(() => doAct(v.legal.canCheck ? 'check' : 'fold'), 200);
    }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Royal Poker', { body: 'Đến lượt bạn!', silent: true });
    }
  }
  if (!sameHand) { S.preFold = false; }
}

function confettiSmall() {
  const wrap = $('#table-wrap');
  for (let k = 0; k < 18; k++) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:50%;top:60%;width:8px;height:8px;border-radius:2px;background:${['#f7e08a', '#e2b75a', '#fff'][k % 3]};z-index:9;pointer-events:none;transition:transform 1s cubic-bezier(.2,.8,.3,1),opacity 1s`;
    wrap.append(d);
    requestAnimationFrame(() => {
      d.style.transform = `translate(${(Math.random() - 0.5) * 300}px, ${-Math.random() * 200}px) rotate(${Math.random() * 720}deg)`;
      d.style.opacity = '0';
    });
    setTimeout(() => d.remove(), 1100);
  }
}

// ── render tổng ──
function renderTable(prev, v, force = false) {
  buildSeats(v);
  renderHeader(v);
  for (let i = 0; i < v.settings.maxSeats; i++) renderSeat(i, v, prev);
  renderVoice(voice.snapshot()); // ghế có thể vừa dựng lại hoặc đổi người ngồi
  renderBoard(v, prev);
  renderPotAndBanners(v);
  renderBets(v, prev);
  renderDealer(v);
  renderDock(v, force);
  renderOverlay(v);
  renderLog(v);
  if (!force) transitions(prev, v);
  autoVoice(v);
}

// Vòng lặp đồng hồ: vòng thời gian, đếm ngược
function clockLoop() {
  const v = S.view;
  if (v && S.tableId) {
    const h = v.hand;
    S.seatEls.forEach((el, i) => {
      const ring = el.querySelector('.ring');
      if (!ring) return;
      if (h && h.phase === 'betting' && h.toAct === i && h.deadline) {
        const p = clamp((h.deadline - nowServer()) / (v.settings.actionTime * 1000), 0, 1);
        ring.style.setProperty('--p', p);
        ring.style.setProperty('--ring-color', p > 0.5 ? '#1fb89e' : p > 0.2 ? '#f59e0b' : '#ef4444');
        if (i === v.mySeat) {
          const sec = Math.ceil((h.deadline - nowServer()) / 1000);
          if (sec <= 5 && sec > 0 && sec !== S.lastTickSec) { S.lastTickSec = sec; sfx.tick(); }
        }
      }
    });
    $$('[data-countdown]').forEach((el) => { el.textContent = Math.max(0, Math.ceil((Number(el.dataset.countdown) - nowServer()) / 1000)); });
    $$('[data-levelat]').forEach((el) => {
      const ms = Math.max(0, Number(el.dataset.levelat) - nowServer());
      el.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    });
  }
  requestAnimationFrame(clockLoop);
}
requestAnimationFrame(clockLoop);

// ── ngồi / rời ──
async function sitAt(seat) {
  const v = S.view;
  if (!v) return;
  if (v.settings.private) {
    modal(`<h3>🔒 Bàn có mật khẩu</h3><form id="pw-form"><div class="field"><label>Mật khẩu</label><input name="pw" type="password" autofocus required /></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>Huỷ</button><button class="btn btn-gold">Ngồi</button></div></form>`, (m, close) => {
      $('#pw-form', m).onsubmit = async (e) => { e.preventDefault(); close(); await send('sit', { seat, password: e.target.pw.value }); askNotify(); };
    });
    return;
  }
  await send('sit', { seat });
  askNotify();
}

function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function leaveSeat() {
  const v = S.view;
  const me = v?.mySeat !== -1 ? v.seats[v.mySeat] : null;
  const risky = me && v.match.active && !me.place && !me.waiting;
  const go = async () => { await send('leave'); $('.overlay')?.remove(); };
  if (!risky) return go();
  modal(`<h3>Rời bàn giữa trận?</h3><p style="color:var(--muted)">Trận đang diễn ra — rời bàn sẽ bị tính là <b>bị loại</b>. Nếu bạn đang trong ván, bài sẽ tự động bỏ.</p>
    <div class="modal-actions"><button class="btn btn-ghost" data-close>Ở lại</button><button class="btn btn-red" id="lv-yes">Rời bàn</button></div>`, (m, close) => {
    $('#lv-yes', m).onclick = () => { close(); go(); };
  });
}

$('#btn-back').onclick = () => { location.hash = '#/'; };
$('#btn-share').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Đã sao chép link bàn — gửi cho bạn bè nhé!', 'ok'); }
  catch { toast(location.href); }
};
$('#btn-side').onclick = () => $('#side').classList.toggle('open');
$$('.tab').forEach((t) => (t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('#tab-chat').classList.toggle('hidden', t.dataset.tab !== 'chat');
  $('#tab-log').classList.toggle('hidden', t.dataset.tab !== 'log');
}));

// ── chat ──
async function loadChat(id) {
  const { data } = await sb.from('poker_chat').select('id,user_id,name,text,created_at').eq('table_id', id)
    .order('created_at', { ascending: false }).limit(50);
  if (S.tableId !== id) return;
  $('#chat-list').innerHTML = '';
  (data || []).reverse().forEach(addChat);
}
function addChat(m) {
  const box = $('#chat-list');
  if (box.querySelector(`[data-id="${m.id}"]`)) return;
  const el = document.createElement('div');
  el.className = `chat-msg ${m.user_id === S.user?.id ? 'mine' : ''}`;
  el.dataset.id = m.id;
  el.innerHTML = `<b>${esc(m.name)}</b>${esc(m.text)}`;
  box.append(el);
  box.scrollTop = box.scrollHeight;
}
$('#chat-form').onsubmit = async (e) => {
  e.preventDefault();
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  try { await api('chat', { tableId: S.tableId, text }); } catch (err) { toast(err.message, 'err'); }
};

window.addEventListener('resize', debounce(() => { if (S.view) { S.seatLayoutKey = ''; renderTable(null, S.view, true); } }, 200));
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tableId) refresh(); });

// Handle debug (chỉ chứa state phía client của chính người dùng)
window.__rp = { S, api, send, sb };

// ───────────────────────── khởi động ─────────────────────────
(async function boot() {
  renderLoginCards();
  sb.auth.onAuthStateChange((event, session) => {
    if (session) setTimeout(() => onSignedIn(session), 0);
    else if (event === 'SIGNED_OUT') onSignedOut();
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session) onSignedIn(session);
  else show('login');
})();
