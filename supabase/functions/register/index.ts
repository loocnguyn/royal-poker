// Royal Poker — tạo tài khoản bằng tên đăng nhập + mật khẩu (không cần email).
// Tài khoản được tạo trong Supabase Auth với email nội bộ <username>@players.royalpoker.test (không bao giờ gửi mail),
// đã xác nhận sẵn, nên client đăng nhập ngay bằng signInWithPassword.
import { createClient } from 'npm:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

export const USER_DOMAIN = 'players.royalpoker.test';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Chống spam đơn giản: tối đa 5 tài khoản / 10 phút / IP (trong một instance)
const recent = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (recent.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  if (list.length >= 5) return true;
  list.push(now);
  recent.set(ip, list);
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30) || username;

    if (!/^[a-z0-9_.]{3,20}$/.test(username))
      return json({ error: 'Tên đăng nhập 3–20 ký tự, chỉ gồm chữ không dấu, số, dấu _ hoặc .' }, 400);
    if (password.length < 6 || password.length > 72) return json({ error: 'Mật khẩu phải từ 6 đến 72 ký tự' }, 400);

    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (tooMany(ip)) return json({ error: 'Tạo quá nhiều tài khoản, thử lại sau ít phút' }, 429);

    const { data, error } = await admin.auth.admin.createUser({
      email: `${username}@${USER_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { full_name: name, username },
    });
    if (error) {
      if (/already|exists|registered/i.test(error.message)) return json({ error: 'Tên đăng nhập này đã có người dùng' }, 409);
      console.error(error);
      return json({ error: 'Không tạo được tài khoản' }, 500);
    }
    await admin.from('poker_profiles').upsert({ id: data.user.id, name, avatar: '' }, { onConflict: 'id' });
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: 'Lỗi máy chủ' }, 500);
  }
});
