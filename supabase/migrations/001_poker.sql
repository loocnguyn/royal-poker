-- Royal Poker schema. Mọi object đều có tiền tố poker_ để sống chung project khác an toàn.

-- Ví chip của người chơi (tạo lười trong Edge Function, không dùng trigger trên auth.users)
create table if not exists public.poker_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text not null default 'Player',
  avatar text,
  chips bigint not null default 10000 check (chips >= 0),
  last_bonus timestamptz,
  created_at timestamptz not null default now()
);

-- Thông tin công khai của bàn (sảnh chờ + tín hiệu realtime)
create table if not exists public.poker_tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references auth.users(id) on delete set null,
  settings jsonb not null,
  players int not null default 0,
  hand_running boolean not null default false,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trạng thái đầy đủ (có bộ bài & bài tẩy) — KHÔNG có policy nào → client không đọc được.
create table if not exists public.poker_state (
  table_id uuid primary key references public.poker_tables(id) on delete cascade,
  state jsonb not null,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.poker_chat (
  id bigint generated always as identity primary key,
  table_id uuid not null references public.poker_tables(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  text text not null check (char_length(text) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists poker_chat_table_idx on public.poker_chat (table_id, created_at desc);
create index if not exists poker_chat_user_idx on public.poker_chat (user_id);
create index if not exists poker_tables_owner_idx on public.poker_tables (owner_id);

alter table public.poker_profiles enable row level security;
alter table public.poker_tables  enable row level security;
alter table public.poker_state   enable row level security;
alter table public.poker_chat    enable row level security;

drop policy if exists "poker_profiles own row" on public.poker_profiles;
create policy "poker_profiles own row" on public.poker_profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists "poker_tables readable" on public.poker_tables;
create policy "poker_tables readable" on public.poker_tables
  for select to authenticated using (true);

drop policy if exists "poker_chat readable" on public.poker_chat;
create policy "poker_chat readable" on public.poker_chat
  for select to authenticated using (true);

-- Commit nguyên tử: kiểm tra version (optimistic lock) + ghi state + cộng/trừ ví.
-- Ví âm → vi phạm CHECK → rollback toàn bộ.
create or replace function public.poker_commit(
  p_table_id uuid, p_expected bigint, p_state jsonb, p_public jsonb, p_deltas jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v bigint;
  r record;
begin
  update poker_state
     set state = p_state, version = version + 1, updated_at = now()
   where table_id = p_table_id and version = p_expected
  returning version into v;
  if v is null then
    raise exception 'VERSION_CONFLICT';
  end if;

  for r in select key::uuid as uid, value::bigint as d from jsonb_each_text(coalesce(p_deltas, '{}'::jsonb)) loop
    update poker_profiles set chips = chips + r.d where id = r.uid;
  end loop;

  update poker_tables
     set players = (p_public->>'players')::int,
         hand_running = (p_public->>'hand_running')::boolean,
         version = v,
         updated_at = now()
   where id = p_table_id;
  return v;
end $$;

-- Nhận chip miễn phí mỗi 12 giờ khi ví dưới 5.000.
create or replace function public.poker_claim_bonus(p_user uuid)
returns bigint
language plpgsql security definer set search_path = public as $$
declare c bigint;
begin
  update poker_profiles
     set chips = chips + 10000, last_bonus = now()
   where id = p_user
     and chips < 5000
     and (last_bonus is null or last_bonus < now() - interval '12 hours')
  returning chips into c;
  if c is null then raise exception 'BONUS_NOT_AVAILABLE'; end if;
  return c;
end $$;

revoke all on function public.poker_commit(uuid, bigint, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.poker_claim_bonus(uuid) from public, anon, authenticated;
grant execute on function public.poker_commit(uuid, bigint, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.poker_claim_bonus(uuid) to service_role;

-- Realtime: client nghe thay đổi của bàn & chat.
do $$ begin
  alter publication supabase_realtime add table public.poker_tables;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.poker_chat;
exception when duplicate_object then null; end $$;
