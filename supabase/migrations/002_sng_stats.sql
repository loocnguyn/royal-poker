-- Chuyển sang mô hình Sit & Go: bỏ ví chip, thêm thống kê thắng/số trận.
drop function if exists public.poker_claim_bonus(uuid);

alter table public.poker_profiles drop column if exists chips;
alter table public.poker_profiles drop column if exists last_bonus;
alter table public.poker_profiles drop column if exists email;
alter table public.poker_profiles add column if not exists wins int not null default 0;
alter table public.poker_profiles add column if not exists matches int not null default 0;

-- Tên/ảnh/thống kê là công khai trong app (bảng xếp hạng).
drop policy if exists "poker_profiles own row" on public.poker_profiles;
drop policy if exists "poker_profiles readable" on public.poker_profiles;
create policy "poker_profiles readable" on public.poker_profiles
  for select to authenticated using (true);
create index if not exists poker_profiles_wins_idx on public.poker_profiles (wins desc);

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

  for r in select key::uuid as uid, value as d from jsonb_each(coalesce(p_deltas, '{}'::jsonb)) loop
    update poker_profiles
       set wins = wins + coalesce((r.d->>'wins')::int, 0),
           matches = matches + coalesce((r.d->>'matches')::int, 0)
     where id = r.uid;
  end loop;

  update poker_tables
     set players = (p_public->>'players')::int,
         hand_running = (p_public->>'hand_running')::boolean,
         settings = coalesce(p_public->'settings', settings),
         version = v,
         updated_at = now()
   where id = p_table_id;
  return v;
end $$;

revoke all on function public.poker_commit(uuid, bigint, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.poker_commit(uuid, bigint, jsonb, jsonb, jsonb) to service_role;

-- Bàn cũ (mô hình ví) không còn tương thích
delete from public.poker_tables;
