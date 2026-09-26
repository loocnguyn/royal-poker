// Royal Poker — Supabase Edge Function: toàn bộ API game.
// Client gọi POST { op, ...params } kèm Authorization: Bearer <access_token>.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Game, createTableState } from './engine/game.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class UserError extends Error {}

type Profile = { id: string; name: string; picture: string; wins: number; matches: number };
const toProfile = (d: any): Profile => ({ id: d.id, name: d.name, picture: d.avatar || '', wins: d.wins, matches: d.matches });

async function ensureProfile(user: any): Promise<Profile> {
  const { data } = await admin.from('poker_profiles').select('*').eq('id', user.id).maybeSingle();
  if (data) return toProfile(data);
  const meta = user.user_metadata || {};
  const name = String(meta.full_name || meta.name || (user.email || 'Player').split('@')[0]).slice(0, 40);
  const avatar = meta.avatar_url || meta.picture || '';
  const { data: created, error } = await admin
    .from('poker_profiles')
    .upsert({ id: user.id, name, avatar }, { onConflict: 'id' })
    .select('*')
    .single();
  if (error) throw error;
  return toProfile(created);
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN);

/** Đọc bàn → advance → mutate → commit nguyên tử (có retry khi xung đột version). */
async function withTable(tableId: string, me: Profile, mutate?: (g: Game) => string | null | Promise<string | null>) {
  if (typeof tableId !== 'string' || tableId.length > 64) throw new UserError('Bàn không hợp lệ');
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row, error } = await admin
      .from('poker_state').select('state, version').eq('table_id', tableId).maybeSingle();
    if (error) throw error;
    if (!row) throw new UserError('Bàn không tồn tại');

    const game = new Game(row.state, Date.now());
    game.advance();
    const err = mutate ? await mutate(game) : null;
    game.advance(); // xử lý hành động tự động phát sinh ngay (vd. người ngồi ngoài tự fold)

    if (game.dirty || Object.keys(game.deltas).length) {
      const { error: cErr } = await admin.rpc('poker_commit', {
        p_table_id: tableId,
        p_expected: row.version,
        p_state: game.s,
        p_public: game.summary(),
        p_deltas: game.deltas,
      });
      if (cErr) {
        if (cErr.message.includes('VERSION_CONFLICT')) {
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
          continue;
        }
        throw cErr;
      }
    }
    return { view: game.viewFor(me.id), error: err || undefined };
  }
  throw new UserError('Bàn đang bận, thử lại');
}

function validateCreate(b: any) {
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw new UserError('Tên bàn không được trống');
  const smallBlind = int(b.smallBlind), bigBlind = int(b.bigBlind), ante = int(b.ante ?? 0);
  if (!(smallBlind >= 1 && bigBlind >= 2 && smallBlind < bigBlind && bigBlind <= 100000))
    throw new UserError('Blind không hợp lệ (SB phải nhỏ hơn BB)');
  if (!(ante >= 0 && ante <= bigBlind)) throw new UserError('Ante phải từ 0 đến BB');
  const startingStack = int(b.startingStack);
  if (!(startingStack >= bigBlind * 10 && startingStack <= 10_000_000))
    throw new UserError('Chip khởi điểm phải ≥ 10 BB');
  const maxSeats = int(b.maxSeats);
  if (!(maxSeats >= 2 && maxSeats <= 9)) throw new UserError('Số ghế từ 2 đến 9');
  const minPlayers = int(b.minPlayers ?? 2);
  if (!(minPlayers >= 2 && minPlayers <= maxSeats)) throw new UserError('Số người tối thiểu từ 2 đến số ghế');
  const actionTime = int(b.actionTime);
  if (!(actionTime >= 10 && actionTime <= 120)) throw new UserError('Thời gian hành động 10–120 giây');
  const bu = b.blindUp || {};
  const mode = ['off', 'hands', 'minutes'].includes(bu.mode) ? bu.mode : 'off';
  const every = int(bu.every);
  const factor = Number(bu.factor);
  if (mode !== 'off' && !(every >= 1 && every <= 120)) throw new UserError('Chu kỳ tăng blind 1–120');
  if (mode !== 'off' && !(factor >= 1.1 && factor <= 3)) throw new UserError('Hệ số tăng blind 1.1–3');
  const password = String(b.password || '').slice(0, 40);
  return {
    name, smallBlind, bigBlind, ante, startingStack, maxSeats, minPlayers, actionTime,
    muckLosers: !!b.muckLosers,
    lateJoin: !!b.lateJoin,
    blindUp: { mode, every: mode === 'off' ? 10 : every, factor: mode === 'off' ? 1.5 : factor },
    password,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: 'Chưa đăng nhập' }, 401);
    const me = await ensureProfile(auth.user);
    const b = await req.json().catch(() => ({}));

    switch (b.op) {
      case 'me':
        return json({ profile: me });

      case 'create': {
        const o = validateCreate(b);
        // dọn các bàn trống quá 30 phút
        await admin.from('poker_tables').delete().eq('players', 0)
          .lt('updated_at', new Date(Date.now() - 30 * 60_000).toISOString());
        const { data: t, error } = await admin.from('poker_tables')
          .insert({ name: o.name, owner_id: me.id, settings: {} })
          .select('id').single();
        if (error) throw error;
        const state = createTableState({
          ...o, ownerId: me.id,
          passwordHash: o.password ? await sha256(`${t.id}:${o.password}`) : '',
        });
        const g = new Game(state);
        const { error: sErr } = await admin.from('poker_state').insert({ table_id: t.id, state, version: 0 });
        if (sErr) throw sErr;
        await admin.from('poker_tables').update({ settings: g.summary().settings }).eq('id', t.id);
        return json({ id: t.id });
      }

      case 'view':
      case 'tick':
        return json(await withTable(b.tableId, me));

      case 'sit': {
        let pwOk = true;
        return json(await withTable(b.tableId, me, async (g) => {
          if (g.s.passwordHash && pwOk) {
            pwOk = (await sha256(`${b.tableId}:${String(b.password || '')}`)) === g.s.passwordHash;
          }
          if (!pwOk) return 'Sai mật khẩu bàn';
          return g.sit(me, int(b.seat));
        }));
      }
      case 'leave':   return json(await withTable(b.tableId, me, (g) => g.leave(me.id)));
      case 'sitout':  return json(await withTable(b.tableId, me, (g) => g.setSitOut(me.id, !!b.value)));
      case 'act':     return json(await withTable(b.tableId, me, (g) => g.act(me.id, String(b.action), int(b.amount))));
      case 'show':    return json(await withTable(b.tableId, me, (g) => g.show(me.id)));
      case 'rematch': return json(await withTable(b.tableId, me, (g) => g.rematch(me.id)));

      case 'chat': {
        const text = String(b.text || '').trim().slice(0, 200);
        if (!text) throw new UserError('Tin nhắn trống');
        const { error } = await admin.from('poker_chat')
          .insert({ table_id: b.tableId, user_id: me.id, name: me.name, text });
        if (error) throw new UserError('Không gửi được tin nhắn');
        return json({ ok: true });
      }

      default:
        return json({ error: 'Unknown op' }, 400);
    }
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: 'Lỗi máy chủ' }, 500);
  }
});
