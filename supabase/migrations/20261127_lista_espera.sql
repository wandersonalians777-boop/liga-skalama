-- Lista de espera de verdade, origem de cada confirmação e aviso para quem sai da espera.
-- Antes: presence_rebalance recalculava tudo pela ordem de chegada (não dava para "Subir" alguém da espera,
-- e diminuir vagas rebaixava confirmados). Agora o status gravado vale: ninguém é rebaixado sozinho, e
-- presence_fill só sobe o 1º da espera quando sobra vaga, com a rodada travada (for update).

-- ---------- Colunas novas ----------
alter table public.attendance add column if not exists source text not null default 'pin';
alter table public.attendance add column if not exists confirmed_at timestamptz;
alter table public.attendance add column if not exists promoted_at timestamptz;
do $$ begin
  alter table public.attendance add constraint attendance_source_check check (source in ('pin', 'organizador'));
exception when duplicate_object then null; end $$;
-- Quem já estava confirmado mantém a mesma ordem (ordem de chegada).
update public.attendance set confirmed_at = created_at where status = 'in' and confirmed_at is null;

-- ---------- Aviso push para quem sai da espera ----------
-- Liga um aparelho inscrito nas notificações a um jogador (feito pelo próprio jogador, com o PIN).
create table if not exists public.player_push_links (
  endpoint text primary key check (char_length(endpoint) between 10 and 1000),
  player_name text not null check (char_length(player_name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Fila de avisos "Abriu vaga: você está confirmado" (a Edge Function notify-news envia).
create table if not exists public.presence_push_queue (
  id bigint generated always as identity primary key,
  round_key text not null,
  player_name text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  total integer,
  ok integer
);
alter table public.player_push_links enable row level security;
alter table public.presence_push_queue enable row level security;
revoke all on public.player_push_links, public.presence_push_queue from anon, authenticated;
drop policy if exists "sem acesso direto" on public.player_push_links;
drop policy if exists "sem acesso direto" on public.presence_push_queue;
create policy "sem acesso direto" on public.player_push_links for all to public using (false) with check (false);
create policy "sem acesso direto" on public.presence_push_queue for all to public using (false) with check (false);
-- A Edge Function (service_role) só lê os vínculos e marca a fila como enviada.
grant select on public.player_push_links to service_role;
grant select, update on public.presence_push_queue to service_role;

create or replace function skalama_private.presence_notify_promoted(p_round text, p_name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_id bigint; v_secret text;
begin
  insert into public.presence_push_queue (round_key, player_name) values (p_round, p_name) returning id into v_id;
  -- Só manda se o jogador ligou algum aparelho; o pedido sai depois do commit (pg_net).
  if exists (select 1 from public.player_push_links l where l.player_name = p_name) then
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret' limit 1;
    if v_secret is not null then
      perform net.http_post(
        url := 'https://lqmcmxjjvnlbjnwadzex.supabase.co/functions/v1/notify-news',
        body := jsonb_build_object('presence_queue_id', v_id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
        timeout_milliseconds := 15000);
    end if;
  end if;
end $$;

-- Sobe o 1º da espera enquanto houver vaga. Chamar sempre com a rodada travada (for update).
create or replace function skalama_private.presence_fill(p_round text, p_slots integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_in integer; r record; v_out jsonb := '[]'::jsonb;
begin
  select count(*) into v_in from public.attendance where round_key = p_round and status = 'in';
  for r in select id, player_name from public.attendance where round_key = p_round and status = 'wait' order by position, created_at loop
    exit when v_in >= p_slots;
    update public.attendance set status = 'in', confirmed_at = now(), promoted_at = now(), updated_at = now() where id = r.id;
    v_in := v_in + 1;
    v_out := v_out || to_jsonb(r.player_name);
    perform skalama_private.presence_notify_promoted(p_round, r.player_name);
  end loop;
  return v_out;
end $$;

-- Entra na lista: confirmado se houver vaga e ninguém na espera; senão, fim da espera. Já estando, nada muda.
create or replace function skalama_private.presence_join(p_round text, p_name text, p_source text, p_slots integer) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare a public.attendance%rowtype; v_has boolean; v_in integer; v_wait boolean; v_status text; v_pos integer;
begin
  select * into a from public.attendance where round_key = p_round and player_name = p_name for update;
  v_has := found;
  if v_has and a.status in ('in', 'wait') then return a.status; end if;
  select count(*) into v_in from public.attendance where round_key = p_round and status = 'in';
  select exists (select 1 from public.attendance where round_key = p_round and status = 'wait') into v_wait;
  v_status := case when v_in < p_slots and not v_wait then 'in' else 'wait' end;
  v_pos := coalesce((select max(position) from public.attendance where round_key = p_round), 0) + 1;
  if v_has then
    update public.attendance set status = v_status, position = v_pos, source = p_source,
      confirmed_at = case when v_status = 'in' then now() end, promoted_at = null, updated_at = now() where id = a.id;
  else
    insert into public.attendance (round_key, player_name, status, position, source, confirmed_at)
    values (p_round, p_name, v_status, v_pos, p_source, case when v_status = 'in' then now() end);
  end if;
  return v_status;
end $$;

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
    -- Confirmados pela ordem em que entraram; espera pela ordem de chegada. Sem PIN, sem dado sensível.
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.player_name, 'status', a.status, 'keeper', coalesce(ro.keeper, false),
          'source', a.source, 'promoted', a.status = 'in' and a.promoted_at is not null)
        order by case a.status when 'in' then 0 else 1 end,
          case when a.status = 'in' then coalesce(a.confirmed_at, a.created_at) end, a.position, a.created_at)
      from public.attendance a left join skalama_private.roster() ro on ro.name = a.player_name
      where a.round_key = rr.round_key and a.status <> 'out'), '[]'::jsonb),
    'counts', jsonb_build_object(
      'in', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'in'),
      'wait', (select count(*) from public.attendance a where a.round_key = rr.round_key and a.status = 'wait')),
    'roster', coalesce((select jsonb_agg(jsonb_build_object('name', ro.name, 'keeper', ro.keeper,
        'has_pin', exists (select 1 from public.player_pins p where p.player_name = ro.name)) order by ro.name)
      from skalama_private.roster() ro), '[]'::jsonb)
  );
end;
$$;

-- Jogador (sem login): nome do elenco + PIN. Vai jogar (true) ou não vai (false).
create or replace function skalama_private.presence_set(p_round text, p_name text, p_pin text, p_going boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_name text := skalama_private.norm_name(p_name);
  v_pin jsonb;
  a public.attendance%rowtype;
  v_promoted jsonb := '[]'::jsonb;
  v_wait_pos integer;
begin
  if p_round is null or p_round !~ '^\d{4}-\d{2}-\d{2}$' or p_going is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if char_length(v_name) = 0 or char_length(v_name) > 60 or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if not skalama_private.presence_is_open(rr) then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  v_pin := skalama_private.check_pin(v_name, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  if p_going then
    perform skalama_private.presence_join(p_round, v_name, 'pin', rr.slots);
  else
    update public.attendance set status = 'out', confirmed_at = null, promoted_at = null, updated_at = now()
      where round_key = p_round and player_name = v_name;
    if not found then
      insert into public.attendance (round_key, player_name, status, position, source)
      values (p_round, v_name, 'out', coalesce((select max(position) from public.attendance where round_key = p_round), 0) + 1, 'pin');
    end if;
    v_promoted := skalama_private.presence_fill(p_round, rr.slots);
  end if;
  select * into a from public.attendance where round_key = p_round and player_name = v_name;
  if a.status = 'wait' then
    select count(*) + 1 into v_wait_pos from public.attendance w
      where w.round_key = p_round and w.status = 'wait' and (w.position < a.position or (w.position = a.position and w.created_at < a.created_at));
  end if;
  return jsonb_build_object('ok', true, 'created', (v_pin->>'created')::boolean,
      'me', jsonb_build_object('name', v_name, 'status', a.status, 'wait_pos', v_wait_pos, 'promoted', a.status = 'in' and a.promoted_at is not null),
      'promoted', v_promoted)
    || jsonb_build_object('view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: confirma alguém sem PIN (vale com a lista fechada; com a lista cheia vai para a espera) ou tira alguém.
create or replace function skalama_private.presence_admin_set(p_round text, p_name text, p_going boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_name text := skalama_private.norm_name(p_name);
  v_status text;
  v_promoted jsonb := '[]'::jsonb;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_going is null or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if p_going then
    v_status := skalama_private.presence_join(p_round, v_name, 'organizador', rr.slots);
  else
    delete from public.attendance where round_key = p_round and player_name = v_name;
    v_promoted := skalama_private.presence_fill(p_round, rr.slots);
  end if;
  return jsonb_build_object('ok', true, 'status', v_status, 'promoted', v_promoted, 'view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: passa da espera para os confirmados quem ele escolher, se houver vaga.
create or replace function skalama_private.presence_admin_promote(p_round text, p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  rr public.attendance_rounds%rowtype;
  v_name text := skalama_private.norm_name(p_name);
  v_in integer;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if not exists (select 1 from public.attendance where round_key = p_round and player_name = v_name and status = 'wait') then
    return jsonb_build_object('ok', false, 'error', 'not_waiting');
  end if;
  select count(*) into v_in from public.attendance where round_key = p_round and status = 'in';
  if v_in >= rr.slots then return jsonb_build_object('ok', false, 'error', 'no_slot'); end if;
  update public.attendance set status = 'in', confirmed_at = now(), promoted_at = now(), updated_at = now()
    where round_key = p_round and player_name = v_name;
  perform skalama_private.presence_notify_promoted(p_round, v_name);
  return jsonb_build_object('ok', true, 'promoted', jsonb_build_array(v_name), 'view', skalama_private.presence_view(p_round));
end;
$$;

-- Organizador: data/horário/local/vagas/aberta. Vagas de 2 a 40 e nunca menos que os confirmados;
-- vaga a mais puxa a espera na hora.
create or replace function skalama_private.presence_admin_round(p_round text, p_start text, p_venue text, p_slots integer, p_open boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start time;
  v_slots integer := coalesce(p_slots, 20);
  v_in integer;
  v_promoted jsonb;
  rr public.attendance_rounds%rowtype;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_round is null or p_round !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'round_format'); end if;
  if p_start is not null and p_start !~ '^\d{2}:\d{2}$' then return jsonb_build_object('ok', false, 'error', 'time_format'); end if;
  if v_slots < 2 or v_slots > 40 then return jsonb_build_object('ok', false, 'error', 'slots'); end if;
  if p_venue is not null and char_length(p_venue) > 120 then return jsonb_build_object('ok', false, 'error', 'venue'); end if;
  select * into rr from public.attendance_rounds where round_key = p_round for update;
  select count(*) into v_in from public.attendance where round_key = p_round and status = 'in';
  if v_slots < v_in then return jsonb_build_object('ok', false, 'error', 'slots_below', 'confirmed', v_in); end if;
  v_start := nullif(p_start, '')::time;
  insert into public.attendance_rounds (round_key, match_date, start_time, venue, slots, open, closes_at)
  values (p_round, p_round::date, v_start, nullif(btrim(p_venue), ''), v_slots, coalesce(p_open, true),
          case when v_start is null then null else (p_round::date + v_start) at time zone 'America/Sao_Paulo' end)
  on conflict (round_key) do update set
    start_time = excluded.start_time, venue = excluded.venue, slots = excluded.slots, open = excluded.open,
    closes_at = excluded.closes_at, updated_at = now();
  v_promoted := skalama_private.presence_fill(p_round, v_slots);
  return jsonb_build_object('ok', true, 'promoted', v_promoted, 'view', skalama_private.presence_view(p_round));
end;
$$;

-- Jogador liga este aparelho (já inscrito nas notificações) ao nome dele, com o PIN.
create or replace function skalama_private.presence_push_link(p_name text, p_pin text, p_endpoint text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_name text := skalama_private.norm_name(p_name); v_pin jsonb;
begin
  if p_endpoint is null or char_length(p_endpoint) < 10 or char_length(p_endpoint) > 1000 then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if not exists (select 1 from public.push_subscriptions s where s.endpoint = p_endpoint) then return jsonb_build_object('ok', false, 'error', 'not_subscribed'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  v_pin := skalama_private.check_pin(v_name, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  insert into public.player_push_links (endpoint, player_name) values (p_endpoint, v_name)
  on conflict (endpoint) do update set player_name = excluded.player_name, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- Portas públicas novas (security invoker) ----------
create or replace function public.presence_admin_promote(p_round text, p_name text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_admin_promote(p_round, p_name) $$;
create or replace function public.presence_push_link(p_name text, p_pin text, p_endpoint text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.presence_push_link(p_name, p_pin, p_endpoint) $$;

-- ---------- Permissões ----------
revoke all on function skalama_private.presence_notify_promoted(text, text), skalama_private.presence_fill(text, integer),
  skalama_private.presence_join(text, text, text, integer) from public, anon, authenticated;
revoke all on function skalama_private.presence_admin_promote(text, text), skalama_private.presence_push_link(text, text, text) from public;
grant execute on function skalama_private.presence_admin_promote(text, text), skalama_private.presence_push_link(text, text, text) to anon, authenticated;
revoke all on function public.presence_admin_promote(text, text), public.presence_push_link(text, text, text) from public;
grant execute on function public.presence_admin_promote(text, text), public.presence_push_link(text, text, text) to anon, authenticated;
