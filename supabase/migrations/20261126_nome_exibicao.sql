-- Nome de exibição do jogador (com aprovação do organizador).
-- O nome original (o do elenco) continua sendo a chave de tudo (histórico, gols, rankings, PIN, presença, votos, News).
-- O jogador só pede um nome para APARECER no site; o organizador aprova. Os números nunca mudam.
-- Mesmo padrão de segurança da presença: tabelas sem acesso direto, funções com privilégio em skalama_private,
-- portas security invoker no public. A leitura pública só mostra nome original -> nome aprovado.

-- ---------- Tabelas ----------
create table if not exists public.player_display_names (
  player_name text primary key check (char_length(player_name) between 1 and 60),
  display_name text check (display_name is null or char_length(display_name) between 2 and 24),
  status text check (status is null or status in ('pending', 'approved', 'rejected')),
  requested_display_name text check (requested_display_name is null or char_length(requested_display_name) between 2 and 24),
  requested_at timestamptz,
  approved_at timestamptz,
  updated_at timestamptz not null default now()
);
create table if not exists public.player_name_changes (
  id bigint generated always as identity primary key,
  player_name text not null check (char_length(player_name) between 1 and 60),
  old_display_name text not null,
  new_display_name text not null,
  approved_at timestamptz not null default now(),
  approved_by uuid,
  by_organizer boolean not null default false
);
create index if not exists player_name_changes_player_idx on public.player_name_changes (player_name, approved_at desc);

alter table public.player_display_names enable row level security;
alter table public.player_name_changes enable row level security;
revoke all on public.player_display_names, public.player_name_changes from anon, authenticated;
drop policy if exists "sem acesso direto" on public.player_display_names;
drop policy if exists "sem acesso direto" on public.player_name_changes;
create policy "sem acesso direto" on public.player_display_names for all to public using (false) with check (false);
create policy "sem acesso direto" on public.player_name_changes for all to public using (false) with check (false);

-- ---------- Ajudantes (privados) ----------
-- Comparação de nomes: sem acento, sem diferença de maiúscula, espaços normalizados.
create or replace function skalama_private.name_cmp(p text) returns text
language sql immutable set search_path = '' as $$
  select translate(upper(regexp_replace(btrim(regexp_replace(coalesce(p, ''), '\*+\s*$', '')), '\s+', ' ', 'g')),
    'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ', 'AAAAAAEEEEIIIIOOOOOUUUUCNY')
$$;

-- Nome pedido: tira espaços sobrando e põe em maiúsculas.
create or replace function skalama_private.display_clean(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

-- Valida um nome de exibição para um jogador. Devolve null se estiver tudo certo, ou o código do erro.
create or replace function skalama_private.display_check(p_player text, p_new text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cmp text := skalama_private.name_cmp(p_new);
begin
  if char_length(p_new) < 2 or char_length(p_new) > 24 then return 'name_length'; end if;
  if p_new !~ '^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .-]+$' or p_new !~ '[A-Za-zÀ-ÖØ-öø-ÿ]' then return 'name_chars'; end if;
  -- nome original de outro jogador do elenco
  if exists (select 1 from skalama_private.roster() ro where ro.name <> p_player and skalama_private.name_cmp(ro.name) = v_cmp) then return 'name_taken'; end if;
  -- nome de exibição (aprovado ou pedido) de outro jogador
  if exists (select 1 from public.player_display_names d where d.player_name <> p_player
      and (skalama_private.name_cmp(d.display_name) = v_cmp or (d.status = 'pending' and skalama_private.name_cmp(d.requested_display_name) = v_cmp))) then
    return 'name_taken';
  end if;
  return null;
end;
$$;

-- Limite: 2 trocas aprovadas pedidas pelo jogador em 60 dias (janela móvel). Libera quando a 2ª mais recente fizer 60 dias.
create or replace function skalama_private.display_limit(p_player text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with w as (
    select approved_at from public.player_name_changes
    where player_name = p_player and not by_organizer and approved_at > now() - interval '60 days'
    order by approved_at desc
  )
  select jsonb_build_object('used', (select count(*) from w), 'max', 2,
    'next_at', case when (select count(*) from w) >= 2 then (select approved_at + interval '60 days' from w offset 1 limit 1) end)
$$;

-- Nome que aparece hoje (aprovado ou o original).
create or replace function skalama_private.display_current(p_player text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select d.display_name from public.player_display_names d where d.player_name = p_player and d.display_name is not null), p_player)
$$;

-- ---------- Leitura pública: só nome original -> nome aprovado ----------
create or replace function skalama_private.display_names_public() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', d.player_name, 'display_name', d.display_name) order by d.player_name), '[]'::jsonb)
  from public.player_display_names d where d.display_name is not null
$$;

-- ---------- Jogador (nome + PIN) ----------
-- Abre "Editar meu nome": confere o PIN (mesmo bloqueio da presença) e diz a situação.
-- Se o último pedido foi recusado, avisa uma vez e limpa o aviso.
create or replace function skalama_private.display_name_status(p_name text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
  v_pin jsonb;
  d public.player_display_names%rowtype;
  v_rejected boolean := false;
begin
  if char_length(v_name) = 0 or char_length(v_name) > 60 or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  v_pin := skalama_private.check_pin(v_name, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  select * into d from public.player_display_names where player_name = v_name for update;
  if found and d.status = 'rejected' then
    v_rejected := true;
    update public.player_display_names set status = null, requested_display_name = null, requested_at = null, updated_at = now() where player_name = v_name;
  end if;
  return jsonb_build_object('ok', true, 'name', v_name, 'display_name', skalama_private.display_current(v_name),
    'pending', case when d.status = 'pending' then d.requested_display_name end,
    'requested_at', case when d.status = 'pending' then d.requested_at end,
    'rejected', v_rejected, 'limit', skalama_private.display_limit(v_name));
end;
$$;

-- Pede um nome novo. Um pedido novo substitui o pendente.
create or replace function skalama_private.request_display_name(p_name text, p_pin text, p_new text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
  v_new text := skalama_private.display_clean(p_new);
  v_pin jsonb;
  v_err text;
  v_limit jsonb;
begin
  if char_length(v_name) = 0 or char_length(v_name) > 60 or not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then
    return jsonb_build_object('ok', false, 'error', 'not_in_roster');
  end if;
  v_pin := skalama_private.check_pin(v_name, p_pin);
  if not (v_pin->>'ok')::boolean then return v_pin; end if;
  v_limit := skalama_private.display_limit(v_name);
  if (v_limit->>'used')::integer >= 2 then return jsonb_build_object('ok', false, 'error', 'name_limit', 'limit', v_limit); end if;
  if skalama_private.name_cmp(v_new) = skalama_private.name_cmp(skalama_private.display_current(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'name_same');
  end if;
  v_err := skalama_private.display_check(v_name, v_new);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into public.player_display_names (player_name, status, requested_display_name, requested_at, updated_at)
  values (v_name, 'pending', v_new, now(), now())
  on conflict (player_name) do update set status = 'pending', requested_display_name = excluded.requested_display_name,
    requested_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'pending', v_new);
end;
$$;

-- ---------- Organizador ----------
create or replace function skalama_private.display_name_admin_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return jsonb_build_object('ok', true,
    'pending', coalesce((select jsonb_agg(jsonb_build_object('name', d.player_name, 'display_name', skalama_private.display_current(d.player_name),
        'requested', d.requested_display_name, 'requested_at', d.requested_at, 'limit', skalama_private.display_limit(d.player_name)) order by d.requested_at)
      from public.player_display_names d where d.status = 'pending'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('name', c.player_name, 'old', c.old_display_name, 'new', c.new_display_name,
        'at', c.approved_at, 'by_organizer', c.by_organizer) order by c.approved_at desc)
      from public.player_name_changes c), '[]'::jsonb));
end;
$$;

-- Grava a troca (aprovação ou edição do organizador). Nome igual ao original = volta ao original (sem nome de exibição).
create or replace function skalama_private.display_apply(p_player text, p_new text, p_by_org boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old text := skalama_private.display_current(p_player);
  v_value text := case when skalama_private.name_cmp(p_new) = skalama_private.name_cmp(p_player) then null else p_new end;
begin
  insert into public.player_display_names (player_name, display_name, status, requested_display_name, requested_at, approved_at, updated_at)
  values (p_player, v_value, case when p_by_org then null else 'approved' end, null, null, now(), now())
  on conflict (player_name) do update set display_name = v_value,
    status = case when p_by_org then public.player_display_names.status else 'approved' end,
    requested_display_name = case when p_by_org then public.player_display_names.requested_display_name else null end,
    requested_at = case when p_by_org then public.player_display_names.requested_at else null end,
    approved_at = now(), updated_at = now();
  insert into public.player_name_changes (player_name, old_display_name, new_display_name, approved_at, approved_by, by_organizer)
  values (p_player, v_old, coalesce(v_value, p_player), now(), (select auth.uid()), p_by_org);
  return jsonb_build_object('ok', true, 'name', p_player, 'display_name', coalesce(v_value, p_player));
end;
$$;

create or replace function skalama_private.display_name_admin_approve(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
  d public.player_display_names%rowtype;
  v_err text;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into d from public.player_display_names where player_name = v_name for update;
  if not found or d.status is distinct from 'pending' then return jsonb_build_object('ok', false, 'error', 'no_request'); end if;
  if (skalama_private.display_limit(v_name)->>'used')::integer >= 2 then return jsonb_build_object('ok', false, 'error', 'name_limit', 'limit', skalama_private.display_limit(v_name)); end if;
  v_err := skalama_private.display_check(v_name, d.requested_display_name);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  return skalama_private.display_apply(v_name, d.requested_display_name, false);
end;
$$;

create or replace function skalama_private.display_name_admin_reject(p_name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update public.player_display_names set status = 'rejected', updated_at = now() where player_name = v_name and status = 'pending';
  if not found then return jsonb_build_object('ok', false, 'error', 'no_request'); end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Organizador edita direto (ou volta ao original com p_display nulo/vazio). Sem limite; fica no histórico como by_organizer.
create or replace function skalama_private.display_name_admin_set(p_name text, p_display text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := skalama_private.norm_name(p_name);
  v_new text := skalama_private.display_clean(coalesce(nullif(btrim(coalesce(p_display, '')), ''), skalama_private.norm_name(p_name)));
  v_err text;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if not exists (select 1 from skalama_private.roster() ro where ro.name = v_name) then return jsonb_build_object('ok', false, 'error', 'not_in_roster'); end if;
  if skalama_private.name_cmp(v_new) = skalama_private.name_cmp(skalama_private.display_current(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'name_same');
  end if;
  if skalama_private.name_cmp(v_new) <> skalama_private.name_cmp(v_name) then
    v_err := skalama_private.display_check(v_name, v_new);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  return skalama_private.display_apply(v_name, v_new, true);
end;
$$;

-- ---------- Portas públicas (security invoker) ----------
create or replace function public.display_names_public() returns jsonb
language sql stable security invoker set search_path = '' as $$ select skalama_private.display_names_public() $$;
create or replace function public.display_name_status(p_name text, p_pin text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.display_name_status(p_name, p_pin) $$;
create or replace function public.request_display_name(p_name text, p_pin text, p_new text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.request_display_name(p_name, p_pin, p_new) $$;
create or replace function public.display_name_admin_list() returns jsonb
language sql stable security invoker set search_path = '' as $$ select skalama_private.display_name_admin_list() $$;
create or replace function public.display_name_admin_approve(p_name text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.display_name_admin_approve(p_name) $$;
create or replace function public.display_name_admin_reject(p_name text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.display_name_admin_reject(p_name) $$;
create or replace function public.display_name_admin_set(p_name text, p_display text) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.display_name_admin_set(p_name, p_display) $$;

-- ---------- Permissões ----------
revoke all on function skalama_private.name_cmp(text), skalama_private.display_clean(text), skalama_private.display_check(text, text),
  skalama_private.display_limit(text), skalama_private.display_current(text), skalama_private.display_apply(text, text, boolean)
from public, anon, authenticated;
revoke all on function
  skalama_private.display_names_public(), skalama_private.display_name_status(text, text), skalama_private.request_display_name(text, text, text),
  skalama_private.display_name_admin_list(), skalama_private.display_name_admin_approve(text), skalama_private.display_name_admin_reject(text),
  skalama_private.display_name_admin_set(text, text)
from public;
grant execute on function
  skalama_private.display_names_public(), skalama_private.display_name_status(text, text), skalama_private.request_display_name(text, text, text),
  skalama_private.display_name_admin_list(), skalama_private.display_name_admin_approve(text), skalama_private.display_name_admin_reject(text),
  skalama_private.display_name_admin_set(text, text)
to anon, authenticated;
revoke all on function
  public.display_names_public(), public.display_name_status(text, text), public.request_display_name(text, text, text),
  public.display_name_admin_list(), public.display_name_admin_approve(text), public.display_name_admin_reject(text),
  public.display_name_admin_set(text, text)
from public;
grant execute on function
  public.display_names_public(), public.display_name_status(text, text), public.request_display_name(text, text, text),
  public.display_name_admin_list(), public.display_name_admin_approve(text), public.display_name_admin_reject(text),
  public.display_name_admin_set(text, text)
to anon, authenticated;
