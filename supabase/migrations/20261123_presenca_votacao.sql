-- Lista de presença pelo link e votação do Craque da noite, com identidade do jogador por nome + PIN.
-- Segurança: as tabelas novas não têm acesso direto (RLS ligado, regra que nega tudo e sem grants para anon/authenticated).
-- Toda leitura e escrita passa por funções. As funções com privilégio (security definer, search_path vazio)
-- ficam no schema skalama_private, que a API não expõe; no public só ficam "portas" security invoker que chamam elas.

create schema if not exists skalama_private;
revoke all on schema skalama_private from public;
grant usage on schema skalama_private to anon, authenticated;

-- ---------- Tabelas ----------
create table if not exists public.player_pins (
  player_name text primary key check (char_length(player_name) between 1 and 60),
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance_rounds (
  round_key text primary key check (round_key ~ '^\d{4}-\d{2}-\d{2}$'),
  match_date date not null,
  start_time time,
  venue text check (venue is null or char_length(venue) <= 120),
  slots integer not null default 20 check (slots between 2 and 60),
  open boolean not null default true,
  closes_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  round_key text not null references public.attendance_rounds(round_key) on delete cascade,
  player_name text not null check (char_length(player_name) between 1 and 60),
  status text not null check (status in ('in', 'out', 'wait')),
  position integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_key, player_name)
);

create table if not exists public.night_vote_rounds (
  round_key text primary key check (round_key ~ '^\d{4}-\d{2}-\d{2}$'),
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  open boolean not null default true,
  participants jsonb not null default '[]'::jsonb,
  results jsonb,
  winner_name text,
  winner_votes integer,
  total_voters integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.night_votes (
  id uuid primary key default gen_random_uuid(),
  round_key text not null references public.night_vote_rounds(round_key) on delete cascade,
  voter_name text not null check (char_length(voter_name) between 1 and 60),
  candidate_name text not null check (char_length(candidate_name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_key, voter_name),
  check (voter_name <> candidate_name)
);

alter table public.player_pins enable row level security;
alter table public.attendance_rounds enable row level security;
alter table public.attendance enable row level security;
alter table public.night_vote_rounds enable row level security;
alter table public.night_votes enable row level security;

revoke all on public.player_pins, public.attendance_rounds, public.attendance, public.night_vote_rounds, public.night_votes from anon, authenticated;

drop policy if exists "sem acesso direto" on public.player_pins;
drop policy if exists "sem acesso direto" on public.attendance_rounds;
drop policy if exists "sem acesso direto" on public.attendance;
drop policy if exists "sem acesso direto" on public.night_vote_rounds;
drop policy if exists "sem acesso direto" on public.night_votes;
create policy "sem acesso direto" on public.player_pins for all to public using (false) with check (false);
create policy "sem acesso direto" on public.attendance_rounds for all to public using (false) with check (false);
create policy "sem acesso direto" on public.attendance for all to public using (false) with check (false);
create policy "sem acesso direto" on public.night_vote_rounds for all to public using (false) with check (false);
create policy "sem acesso direto" on public.night_votes for all to public using (false) with check (false);

-- ---------- Ajudantes (privados) ----------
-- Nome comparável: sem o * de goleiro, sem espaços sobrando, em maiúsculas.
create or replace function skalama_private.norm_name(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(btrim(regexp_replace(coalesce(p, ''), '\*+\s*$', '')))
$$;

create or replace function skalama_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_admins a where a.user_id = (select auth.uid()))
$$;

-- Elenco atual (state.roster): nome comparável e se é goleiro.
create or replace function skalama_private.roster() returns table (name text, keeper boolean)
language sql stable security definer set search_path = '' as $$
  select distinct on (skalama_private.norm_name(r)) skalama_private.norm_name(r), r ~ '\*\s*$'
  from public.league_night n, jsonb_array_elements_text(coalesce(n.state->'roster', '[]'::jsonb)) r
  where n.id = 1 and skalama_private.norm_name(r) <> ''
  order by skalama_private.norm_name(r), r ~ '\*\s*$' desc
$$;

-- Confere (ou cria, na primeira vez) o PIN. Nunca levanta erro: a tentativa errada precisa ficar gravada.
create or replace function skalama_private.check_pin(p_name text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.player_pins%rowtype;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'pin_format');
  end if;
  select * into r from public.player_pins where player_name = p_name for update;
  if not found then
    insert into public.player_pins (player_name, pin_hash) values (p_name, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
    return jsonb_build_object('ok', true, 'created', true);
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', r.locked_until);
  end if;
  if extensions.crypt(p_pin, r.pin_hash) = r.pin_hash then
    if r.failed_attempts <> 0 or r.locked_until is not null then
      update public.player_pins set failed_attempts = 0, locked_until = null, updated_at = now() where player_name = p_name;
    end if;
    return jsonb_build_object('ok', true, 'created', false);
  end if;
  if r.failed_attempts + 1 >= 5 then
    update public.player_pins set failed_attempts = 0, locked_until = now() + interval '15 minutes', updated_at = now() where player_name = p_name;
    return jsonb_build_object('ok', false, 'error', 'locked', 'locked_until', now() + interval '15 minutes');
  end if;
  update public.player_pins set failed_attempts = r.failed_attempts + 1, updated_at = now() where player_name = p_name;
  return jsonb_build_object('ok', false, 'error', 'pin_wrong', 'remaining', 5 - (r.failed_attempts + 1));
end;
$$;

-- ---------- Lista de presença ----------
create or replace function skalama_private.presence_is_open(rr public.attendance_rounds) returns boolean
language sql stable set search_path = '' as $$
  select rr.open and (rr.closes_at is null or now() < rr.closes_at)
$$;

-- Distribui as vagas pela ordem de chegada: os primeiros (sem contar quem desistiu) ficam "in", o resto na espera.
create or replace function skalama_private.presence_rebalance(p_round text, p_slots integer) returns void
language sql volatile security definer set search_path = '' as $$
  with ranked as (
    select id, case when row_number() over (order by position, created_at) <= p_slots then 'in' else 'wait' end as want
    from public.attendance where round_key = p_round and status <> 'out'
  )
  update public.attendance a set status = r.want, updated_at = now()
  from ranked r where a.id = r.id and a.status <> r.want
$$;

create or replace function skalama_private.presence_view(p_round text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_key text := p_round;
begin
  if v_key is null or v_key = '' then
    select coalesce(
      (select a.round_key from public.attendance_rounds a, public.league_night n where n.id = 1 and a.round_key = n.state->>'matchDate'),
      (select a.round_key from public.attendance_rounds a order by a.match_date desc limit 1)
    ) into v_key;
  end if;
  select * into rr from public.attendance_rounds where round_key = v_key;
  return jsonb_build_object(
    'round', case when rr.round_key is null then null else jsonb_build_object(
      'round_key', rr.round_key, 'match_date', rr.match_date, 'start_time', to_char(rr.start_time, 'HH24:MI'), 'venue', rr.venue,
      'slots', rr.slots, 'open', skalama_private.presence_is_open(rr), 'closes_at', rr.closes_at) end,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.player_name, 'status', a.status, 'keeper', coalesce(ro.keeper, false)) order by case a.status when 'in' then 0 else 1 end, a.position, a.created_at)
      from public.attendance a left join skalama_private.roster() ro on ro.name = a.player_name
      where a.round_key = rr.round_key and a.status <> 'out'), '[]'::jsonb),
    'counts', jsonb_build_object(
      'in', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'in'),
      'wait', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'wait')),
    'roster', coalesce((select jsonb_agg(jsonb_build_object('name', ro.name, 'keeper', ro.keeper) order by ro.name) from skalama_private.roster() ro), '[]'::jsonb)
  );
end;
$$;

create or replace function skalama_private.presence_get(p_round text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_round is not null and p_round !~ '^\d{4}-\d{2}-\d{2}$' then
    return jsonb_build_object('error', 'round_format');
  end if;
  return skalama_private.presence_view(p_round);
end;
$$;

-- Jogador (sem login): nome do elenco + PIN. Vai jogar (true) ou não vai (false).
create or replace function skalama_private.presence_set(p_round text, p_name text, p_pin text, p_going boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_name text := skalama_private.norm_name(p_name);
  v_pin jsonb;
  v_status text;
begin
  if p_round is null or p_round !~ '^\d{4}-\d{2}-\d{2}$' or p_going is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if char_length(v_name) = 0 or char_length(v_name) > 60 or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  -- trava a rodada: duas pessoas nunca pegam a mesma vaga
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if not skalama_private.presence_is_open(rr) then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  v_pin := skalama_private.check_pin(v_name, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  if p_going then
    insert into public.attendance (round_key, player_name, status, position)
    values (p_round, v_name, 'wait', coalesce((select max(position) from public.attendance where round_key = p_round), 0) + 1)
    on conflict (round_key, player_name) do update
      set status = 'wait', position = excluded.position, updated_at = now()
      where public.attendance.status = 'out';
  else
    update public.attendance set status = 'out', updated_at = now() where round_key = p_round and player_name = v_name;
    if not found then
      insert into public.attendance (round_key, player_name, status, position)
      values (p_round, v_name, 'out', coalesce((select max(position) from public.attendance where round_key = p_round), 0) + 1);
    end if;
  end if;
  perform skalama_private.presence_rebalance(p_round, rr.slots);
  select status into v_status from public.attendance where round_key = p_round and player_name = v_name;
  return jsonb_build_object('ok', true, 'created', (v_pin->>'created')::boolean, 'me', jsonb_build_object('name', v_name, 'status', v_status))
    || jsonb_build_object('view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: cria/atualiza a lista (data, horário, local, vagas, aberta/fechada).
create or replace function skalama_private.presence_admin_round(p_round text, p_start text, p_venue text, p_slots integer, p_open boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start time;
  v_slots integer := coalesce(p_slots, 20);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_round is null or p_round !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'round_format'); end if;
  if p_start is not null and p_start !~ '^\d{2}:\d{2}$' then return jsonb_build_object('ok', false, 'error', 'time_format'); end if;
  if v_slots < 2 or v_slots > 60 then return jsonb_build_object('ok', false, 'error', 'slots'); end if;
  if p_venue is not null and char_length(p_venue) > 120 then return jsonb_build_object('ok', false, 'error', 'venue'); end if;
  v_start := nullif(p_start, '')::time;
  insert into public.attendance_rounds (round_key, match_date, start_time, venue, slots, open, closes_at)
  values (p_round, p_round::date, v_start, nullif(btrim(p_venue), ''), v_slots, coalesce(p_open, true),
          case when v_start is null then null else (p_round::date + v_start) at time zone 'America/Sao_Paulo' end)
  on conflict (round_key) do update set
    start_time = excluded.start_time, venue = excluded.venue, slots = excluded.slots, open = excluded.open,
    closes_at = excluded.closes_at, updated_at = now();
  perform skalama_private.presence_rebalance(p_round, v_slots);
  return jsonb_build_object('ok', true, 'view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: confirma alguém sem celular (vale mesmo com a lista fechada) ou tira alguém da lista.
create or replace function skalama_private.presence_admin_set(p_round text, p_name text, p_going boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_name text := skalama_private.norm_name(p_name);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_going is null or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if p_going then
    insert into public.attendance (round_key, player_name, status, position)
    values (p_round, v_name, 'wait', coalesce((select max(position) from public.attendance where round_key = p_round), 0) + 1)
    on conflict (round_key, player_name) do update set status = 'wait', position = excluded.position, updated_at = now()
      where public.attendance.status = 'out';
  else
    delete from public.attendance where round_key = p_round and player_name = v_name;
  end if;
  perform skalama_private.presence_rebalance(p_round, rr.slots);
  return jsonb_build_object('ok', true, 'view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: troca o PIN de um jogador (p_pin nulo apaga: o jogador cria outro na próxima vez).
create or replace function skalama_private.player_pin_admin_set(p_name text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if char_length(v_name) = 0 or char_length(v_name) > 60 then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if p_pin is null then
    delete from public.player_pins where player_name = v_name;
    return jsonb_build_object('ok', true, 'cleared', true);
  end if;
  if p_pin !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'error', 'pin_format'); end if;
  insert into public.player_pins (player_name, pin_hash) values (v_name, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (player_name) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- Organizador: quem tem PIN criado e quem está bloqueado (sem hash).
create or replace function skalama_private.player_pin_admin_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'players', coalesce((select jsonb_agg(jsonb_build_object('name', p.player_name, 'locked', p.locked_until is not null and p.locked_until > now())) from public.player_pins p), '[]'::jsonb));
end;
$$;

-- ---------- Craque da noite ----------
-- Jogos oficiais da noite (sem treino): a noite vai até 6 h da manhã do dia seguinte (horário de Brasília).
create or replace function skalama_private.night_games(p_key text) returns setof jsonb
language sql stable security definer set search_path = '' as $$
  select g from public.league_night n, jsonb_array_elements(coalesce(n.state->'gameHistory', '[]'::jsonb)) g
  where n.id = 1 and coalesce(g->>'training', 'false') <> 'true' and g->>'finishedAt' is not null
    and to_char(((g->>'finishedAt')::timestamptz at time zone 'America/Sao_Paulo') - interval '6 hours', 'YYYY-MM-DD') = p_key
$$;

-- Quem jogou na noite: nome comparável, time do último jogo e nota média (para desempate).
create or replace function skalama_private.night_participants(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with perf as (
    select skalama_private.norm_name(p->>'player') as name, p->>'team' as team,
      case when p->>'team' = g->>'home' then coalesce(g->>'homeLabel', g->>'home') else coalesce(g->>'awayLabel', g->>'away') end as label,
      nullif(p->>'score', '')::numeric as score, (g->>'finishedAt')::timestamptz as at
    from skalama_private.night_games(p_key) g, jsonb_array_elements(coalesce(g->'performance', '[]'::jsonb)) p
    where coalesce(p->>'player', '') <> ''
  ), agg as (
    select name, round(avg(score), 2) as avg, count(*) as games,
      (array_agg(team order by at desc))[1] as team, (array_agg(label order by at desc))[1] as label
    from perf group by name
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'team', team, 'label', label, 'avg', avg, 'games', games) order by name), '[]'::jsonb) from agg
$$;

create or replace function skalama_private.vote_finalize(p_key text, p_force boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  vr public.night_vote_rounds%rowtype;
  v_results jsonb;
begin
  select * into vr from public.night_vote_rounds where round_key = p_key for update;
  if not found or not vr.open then return; end if;
  if not p_force and now() < vr.closes_at then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'team', c.team, 'label', c.label, 'votes', c.votes, 'avg', c.avg) order by c.votes desc, c.avg desc nulls last, c.name), '[]'::jsonb)
  into v_results
  from (
    select p->>'name' as name, p->>'team' as team, p->>'label' as label, nullif(p->>'avg', '')::numeric as avg,
      (select count(*) from public.night_votes v where v.round_key = p_key and v.candidate_name = p->>'name') as votes
    from jsonb_array_elements(vr.participants) p
  ) c;
  update public.night_vote_rounds set open = false, closes_at = least(closes_at, now()), results = v_results,
    winner_name = case when coalesce((v_results->0->>'votes')::integer, 0) > 0 then v_results->0->>'name' end,
    winner_votes = coalesce((v_results->0->>'votes')::integer, 0),
    total_voters = (select count(*) from public.night_votes v where v.round_key = p_key),
    updated_at = now()
  where round_key = p_key;
end;
$$;

create or replace function skalama_private.vote_view(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  vr public.night_vote_rounds%rowtype;
  v_key text := p_key;
begin
  if v_key is null or v_key = '' then
    select round_key into v_key from public.night_vote_rounds order by opens_at desc limit 1;
  end if;
  if v_key is null then return jsonb_build_object('round', null); end if;
  perform skalama_private.vote_finalize(v_key, false);
  select * into vr from public.night_vote_rounds where round_key = v_key;
  if not found then return jsonb_build_object('round', null); end if;
  return jsonb_build_object('round', jsonb_build_object(
      'round_key', vr.round_key, 'opens_at', vr.opens_at, 'closes_at', vr.closes_at, 'open', vr.open,
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('name', p->>'name', 'team', p->>'team', 'label', p->>'label')), '[]'::jsonb) from jsonb_array_elements(vr.participants) p),
      'eligible', jsonb_array_length(vr.participants),
      'voted', (select count(*) from public.night_votes v where v.round_key = vr.round_key)),
    -- parciais nunca saem com a votação aberta; e nunca sai quem votou em quem
    'results', case when vr.open then null else vr.results end,
    'winner', case when vr.open then null else jsonb_build_object('name', vr.winner_name, 'votes', vr.winner_votes, 'total', vr.total_voters) end);
end;
$$;

create or replace function skalama_private.vote_get(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_key is not null and p_key !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('error', 'round_format'); end if;
  return skalama_private.vote_view(p_key);
end;
$$;

-- Últimos vencedores (Tela principal e Divulgação).
create or replace function skalama_private.vote_winners(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('round_key', round_key, 'name', winner_name, 'votes', winner_votes, 'total', total_voters,
    'team', (select p->>'team' from jsonb_array_elements(participants) p where p->>'name' = winner_name limit 1),
    'label', (select p->>'label' from jsonb_array_elements(participants) p where p->>'name' = winner_name limit 1)) order by round_key desc), '[]'::jsonb)
  from (select * from public.night_vote_rounds where not open and winner_name is not null order by round_key desc limit least(greatest(coalesce(p_limit, 5), 1), 20)) x
$$;

create or replace function skalama_private.vote_cast(p_key text, p_voter text, p_pin text, p_candidate text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  vr public.night_vote_rounds%rowtype;
  v_voter text := skalama_private.norm_name(p_voter);
  v_cand text := skalama_private.norm_name(p_candidate);
  v_pin jsonb;
begin
  if p_key is null or p_key !~ '^\d{4}-\d{2}-\d{2}$' or char_length(v_voter) = 0 or char_length(v_voter) > 60 or char_length(v_cand) = 0 or char_length(v_cand) > 60 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  perform skalama_private.vote_finalize(p_key, false);
  select * into vr from public.night_vote_rounds where round_key = p_key for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if not vr.open or now() >= vr.closes_at then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if not exists (select 1 from jsonb_array_elements(vr.participants) p where p->>'name' = v_voter) then
    return jsonb_build_object('ok', false, 'error', 'not_player');
  end if;
  if not exists (select 1 from jsonb_array_elements(vr.participants) p where p->>'name' = v_cand) then
    return jsonb_build_object('ok', false, 'error', 'bad_candidate');
  end if;
  if v_voter = v_cand then return jsonb_build_object('ok', false, 'error', 'self_vote'); end if;
  v_pin := skalama_private.check_pin(v_voter, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  insert into public.night_votes (round_key, voter_name, candidate_name) values (p_key, v_voter, v_cand)
  on conflict (round_key, voter_name) do update set candidate_name = excluded.candidate_name, updated_at = now();
  return jsonb_build_object('ok', true, 'created', (v_pin->>'created')::boolean, 'mine', v_cand, 'view', skalama_private.vote_view(p_key));
end;
$$;

-- Organizador: abre a votação da noite (24 h) ou fecha antes.
create or replace function skalama_private.vote_admin_open(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_part jsonb;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_key is null or p_key !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'round_format'); end if;
  v_part := skalama_private.night_participants(p_key);
  if jsonb_array_length(v_part) < 2 then return jsonb_build_object('ok', false, 'error', 'no_games'); end if;
  insert into public.night_vote_rounds (round_key, opens_at, closes_at, open, participants)
  values (p_key, now(), now() + interval '24 hours', true, v_part)
  on conflict (round_key) do update set opens_at = now(), closes_at = now() + interval '24 hours', open = true, participants = excluded.participants,
    results = null, winner_name = null, winner_votes = null, total_voters = null, updated_at = now();
  -- votos de quem não está mais na lista (ex.: jogo apagado) não contam
  delete from public.night_votes v where v.round_key = p_key
    and (not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.voter_name)
      or not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.candidate_name));
  return jsonb_build_object('ok', true, 'view', skalama_private.vote_view(p_key));
end;
$$;

create or replace function skalama_private.vote_admin_close(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_key is null or p_key !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'round_format'); end if;
  perform skalama_private.vote_finalize(p_key, true);
  return jsonb_build_object('ok', true, 'view', skalama_private.vote_view(p_key));
end;
$$;

-- ---------- Portas públicas (security invoker: sem privilégio próprio) ----------
create or replace function public.presence_get(p_round text default null) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_get(p_round) $$;
create or replace function public.presence_set(p_round text, p_name text, p_pin text, p_going boolean) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_set(p_round, p_name, p_pin, p_going) $$;
create or replace function public.presence_admin_round(p_round text, p_start text, p_venue text, p_slots integer, p_open boolean) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_admin_round(p_round, p_start, p_venue, p_slots, p_open) $$;
create or replace function public.presence_admin_set(p_round text, p_name text, p_going boolean) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_admin_set(p_round, p_name, p_going) $$;
create or replace function public.player_pin_admin_set(p_name text, p_pin text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.player_pin_admin_set(p_name, p_pin) $$;
create or replace function public.player_pin_admin_list() returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.player_pin_admin_list() $$;
create or replace function public.vote_get(p_key text default null) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_get(p_key) $$;
create or replace function public.vote_winners(p_limit integer default 5) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_winners(p_limit) $$;
create or replace function public.vote_cast(p_key text, p_voter text, p_pin text, p_candidate text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_cast(p_key, p_voter, p_pin, p_candidate) $$;
create or replace function public.vote_admin_open(p_key text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_admin_open(p_key) $$;
create or replace function public.vote_admin_close(p_key text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_admin_close(p_key) $$;

-- ---------- Permissões ----------
revoke all on all functions in schema skalama_private from public, anon, authenticated;
grant execute on function
  skalama_private.presence_get(text), skalama_private.presence_set(text, text, text, boolean),
  skalama_private.presence_admin_round(text, text, text, integer, boolean), skalama_private.presence_admin_set(text, text, boolean),
  skalama_private.player_pin_admin_set(text, text), skalama_private.player_pin_admin_list(),
  skalama_private.vote_get(text), skalama_private.vote_winners(integer), skalama_private.vote_cast(text, text, text, text),
  skalama_private.vote_admin_open(text), skalama_private.vote_admin_close(text)
to anon, authenticated;

revoke all on function
  public.presence_get(text), public.presence_set(text, text, text, boolean),
  public.presence_admin_round(text, text, text, integer, boolean), public.presence_admin_set(text, text, boolean),
  public.player_pin_admin_set(text, text), public.player_pin_admin_list(),
  public.vote_get(text), public.vote_winners(integer), public.vote_cast(text, text, text, text),
  public.vote_admin_open(text), public.vote_admin_close(text)
from public;
grant execute on function
  public.presence_get(text), public.presence_set(text, text, text, boolean),
  public.presence_admin_round(text, text, text, integer, boolean), public.presence_admin_set(text, text, boolean),
  public.player_pin_admin_set(text, text), public.player_pin_admin_list(),
  public.vote_get(text), public.vote_winners(integer), public.vote_cast(text, text, text, text),
  public.vote_admin_open(text), public.vote_admin_close(text)
to anon, authenticated;
