-- PIN só com link pessoal de primeiro acesso.
-- Antes: no primeiro acesso, qualquer pessoa podia escolher o nome de quem ainda não tinha PIN e criar o PIN no lugar dele.
-- Agora: check_pin nunca cria PIN. O PIN só nasce por invite_use, com um token aleatório (192 bits, gen_random_bytes)
-- que o organizador gera e manda no privado. Só o hash (sha256) do token fica no banco; vale 30 dias e um uso.
-- Mesmo padrão de segurança da presença: tabela sem acesso direto, funções com privilégio em skalama_private,
-- portas security invoker no public.

-- ---------- Tabela ----------
create table if not exists public.player_invites (
  player_name text primary key check (char_length(player_name) between 1 and 60),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  expires_at timestamptz not null
);
alter table public.player_invites enable row level security;
revoke all on public.player_invites from anon, authenticated;
drop policy if exists "sem acesso direto" on public.player_invites;
create policy "sem acesso direto" on public.player_invites for all to public using (false) with check (false);

-- ---------- Ajudantes (privados) ----------
create or replace function skalama_private.token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- Token novo (base64url, 32 caracteres = 24 bytes aleatórios) para um jogador; substitui o anterior.
create or replace function skalama_private.invite_new(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  v_exp timestamptz := now() + interval '30 days';
begin
  insert into public.player_invites (player_name, token_hash, created_at, used_at, expires_at)
  values (p_name, skalama_private.token_hash(v_token), now(), null, v_exp)
  on conflict (player_name) do update set token_hash = excluded.token_hash, created_at = now(), used_at = null, expires_at = excluded.expires_at;
  return jsonb_build_object('name', p_name, 'token', v_token, 'expires_at', v_exp);
end;
$$;

-- Confere o PIN. Sem PIN criado: erro no_pin (o PIN só nasce pelo link pessoal). Nunca levanta erro.
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
    return jsonb_build_object('ok', false, 'error', 'no_pin');
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

-- Lista de presença: o elenco agora diz quem já tem PIN (quem não tem não pode confirmar sozinho).
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
    'roster', coalesce((select jsonb_agg(jsonb_build_object('name', ro.name, 'keeper', ro.keeper,
        'has_pin', exists (select 1 from public.player_pins p where p.player_name = ro.name)) order by ro.name)
      from skalama_private.roster() ro), '[]'::jsonb)
  );
end;
$$;

-- Votação: participantes também dizem quem já tem PIN.
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
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('name', p->>'name', 'team', p->>'team', 'label', p->>'label',
          'has_pin', exists (select 1 from public.player_pins pp where pp.player_name = p->>'name'))), '[]'::jsonb)
        from jsonb_array_elements(vr.participants) p),
      'eligible', jsonb_array_length(vr.participants),
      'voted', (select count(*) from public.night_votes v where v.round_key = vr.round_key)),
    -- parciais nunca saem com a votação aberta; e nunca sai quem votou em quem
    'results', case when vr.open then null else vr.results end,
    'winner', case when vr.open then null else jsonb_build_object('name', vr.winner_name, 'votes', vr.winner_votes, 'total', vr.total_voters) end);
end;
$$;

-- ---------- Jogador: link pessoal ----------
-- Abre o link: diz de quem é (sem criar nada). Erros: invalid, used, expired, has_pin, not_in_roster.
create or replace function skalama_private.invite_get(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.player_invites%rowtype;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{20,64}$' then return jsonb_build_object('ok', false, 'error', 'invite_invalid'); end if;
  select * into i from public.player_invites where token_hash = skalama_private.token_hash(p_token);
  if not found then return jsonb_build_object('ok', false, 'error', 'invite_invalid'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'error', 'invite_used'); end if;
  if i.expires_at <= now() then return jsonb_build_object('ok', false, 'error', 'invite_expired'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = i.player_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  if exists (select 1 from public.player_pins p where p.player_name = i.player_name) then return jsonb_build_object('ok', false, 'error', 'invite_has_pin'); end if;
  return jsonb_build_object('ok', true, 'name', i.player_name, 'expires_at', i.expires_at);
end;
$$;

-- Cria o PIN pelo link (uso único: o token fica marcado como usado na mesma transação).
create or replace function skalama_private.invite_use(p_token text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.player_invites%rowtype;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{20,64}$' then return jsonb_build_object('ok', false, 'error', 'invite_invalid'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'error', 'pin_format'); end if;
  select * into i from public.player_invites where token_hash = skalama_private.token_hash(p_token) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'invite_invalid'); end if;
  if i.used_at is not null then return jsonb_build_object('ok', false, 'error', 'invite_used'); end if;
  if i.expires_at <= now() then return jsonb_build_object('ok', false, 'error', 'invite_expired'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = i.player_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  if exists (select 1 from public.player_pins p where p.player_name = i.player_name) then return jsonb_build_object('ok', false, 'error', 'invite_has_pin'); end if;
  insert into public.player_pins (player_name, pin_hash) values (i.player_name, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
  update public.player_invites set used_at = now() where player_name = i.player_name;
  return jsonb_build_object('ok', true, 'created', true, 'name', i.player_name);
end;
$$;

-- ---------- Organizador: acesso dos jogadores ----------
-- Situação de cada jogador do elenco: pin (com PIN), invite (link válido não usado), expired, none.
-- Sem token e sem hash: o link só aparece na hora em que é gerado.
create or replace function skalama_private.player_access_admin_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'now', now(), 'players', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', ro.name, 'keeper', ro.keeper,
      'status', case when p.player_name is not null then 'pin'
                     when i.player_name is not null and i.used_at is null and i.expires_at > now() then 'invite'
                     when i.player_name is not null and i.used_at is null then 'expired'
                     else 'none' end,
      'pin_created_at', p.created_at, 'locked', p.locked_until is not null and p.locked_until > now(),
      'invite_created_at', i.created_at, 'invite_expires_at', i.expires_at) order by ro.name)
    from skalama_private.roster() ro
    left join public.player_pins p on p.player_name = ro.name
    left join public.player_invites i on i.player_name = ro.name), '[]'::jsonb));
end;
$$;

-- Gera (ou troca) o link pessoal de um jogador sem PIN.
create or replace function skalama_private.invite_admin_create(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  if exists (select 1 from public.player_pins p where p.player_name = v_name) then return jsonb_build_object('ok', false, 'error', 'invite_has_pin'); end if;
  return jsonb_build_object('ok', true, 'links', jsonb_build_array(skalama_private.invite_new(v_name)));
end;
$$;

-- Gera links para todos do elenco sem PIN e sem link válido (não invalida links já mandados).
create or replace function skalama_private.invite_admin_create_all() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_links jsonb := '[]'::jsonb;
  v_name text;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  for v_name in
    select ro.name from skalama_private.roster() ro
    where not exists (select 1 from public.player_pins p where p.player_name = ro.name)
      and not exists (select 1 from public.player_invites i where i.player_name = ro.name and i.used_at is null and i.expires_at > now())
    order by ro.name
  loop
    v_links := v_links || jsonb_build_array(skalama_private.invite_new(v_name));
  end loop;
  return jsonb_build_object('ok', true, 'links', v_links);
end;
$$;

-- Resetar acesso: apaga o PIN e gera um link pessoal novo.
create or replace function skalama_private.player_access_admin_reset(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  delete from public.player_pins where player_name = v_name;
  return jsonb_build_object('ok', true, 'links', jsonb_build_array(skalama_private.invite_new(v_name)));
end;
$$;

-- ---------- Portas públicas (security invoker) ----------
create or replace function public.invite_get(p_token text) returns jsonb
language sql stable security invoker set search_path = '' as $$ select skalama_private.invite_get(p_token) $$;
create or replace function public.invite_use(p_token text, p_pin text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.invite_use(p_token, p_pin) $$;
create or replace function public.player_access_admin_list() returns jsonb
language sql stable security invoker set search_path = '' as $$ select skalama_private.player_access_admin_list() $$;
create or replace function public.invite_admin_create(p_name text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.invite_admin_create(p_name) $$;
create or replace function public.invite_admin_create_all() returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.invite_admin_create_all() $$;
create or replace function public.player_access_admin_reset(p_name text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.player_access_admin_reset(p_name) $$;

-- ---------- Permissões ----------
-- Ajudantes sem porta pública: ninguém de fora chama.
revoke all on function skalama_private.token_hash(text), skalama_private.invite_new(text), skalama_private.check_pin(text, text),
  skalama_private.presence_view(text), skalama_private.vote_view(text) from public, anon, authenticated;
revoke all on function
  skalama_private.invite_get(text), skalama_private.invite_use(text, text), skalama_private.player_access_admin_list(),
  skalama_private.invite_admin_create(text), skalama_private.invite_admin_create_all(), skalama_private.player_access_admin_reset(text)
from public;
grant execute on function
  skalama_private.invite_get(text), skalama_private.invite_use(text, text), skalama_private.player_access_admin_list(),
  skalama_private.invite_admin_create(text), skalama_private.invite_admin_create_all(), skalama_private.player_access_admin_reset(text)
to anon, authenticated;
revoke all on function
  public.invite_get(text), public.invite_use(text, text), public.player_access_admin_list(),
  public.invite_admin_create(text), public.invite_admin_create_all(), public.player_access_admin_reset(text)
from public;
grant execute on function
  public.invite_get(text), public.invite_use(text, text), public.player_access_admin_list(),
  public.invite_admin_create(text), public.invite_admin_create_all(), public.player_access_admin_reset(text)
to anon, authenticated;
