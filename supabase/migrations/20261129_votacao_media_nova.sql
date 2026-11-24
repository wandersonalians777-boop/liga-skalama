-- Votação do Craque da noite: o desempate (maior nota média da noite) passa a usar a NOTA NOVA, calculada pelo site
-- (gamePerformance/scoreFor), em vez das notas gravadas no histórico (fórmula antiga).
-- O organizador manda as médias ao abrir a votação (p_avgs: { "NOME": média }) e pode atualizá-las numa votação aberta.
-- Só nomes que já são participantes e valores de 0 a 10 são aceitos; votos e participantes não mudam.

create or replace function skalama_private.vote_apply_avgs(p_part jsonb, p_avgs jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(case
      when jsonb_typeof(p_avgs -> (p->>'name')) = 'number' and (p_avgs ->> (p->>'name'))::numeric between 0 and 10
        then p || jsonb_build_object('avg', round((p_avgs ->> (p->>'name'))::numeric, 2))
      else p end), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_part, '[]'::jsonb)) p
$$;

drop function if exists public.vote_admin_open(text);
drop function if exists skalama_private.vote_admin_open(text);
create or replace function skalama_private.vote_admin_open(p_key text, p_avgs jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_part jsonb;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_key is null or p_key !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'round_format'); end if;
  v_part := skalama_private.night_participants(p_key);
  if jsonb_array_length(v_part) < 2 then return jsonb_build_object('ok', false, 'error', 'no_games'); end if;
  if p_avgs is not null and jsonb_typeof(p_avgs) = 'object' then v_part := skalama_private.vote_apply_avgs(v_part, p_avgs); end if;
  insert into public.night_vote_rounds (round_key, opens_at, closes_at, open, participants)
  values (p_key, now(), now() + interval '24 hours', true, v_part)
  on conflict (round_key) do update set opens_at = now(), closes_at = now() + interval '24 hours', open = true, participants = excluded.participants,
    results = null, winner_name = null, winner_votes = null, total_voters = null, updated_at = now();
  delete from public.night_votes v where v.round_key = p_key
    and (not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.voter_name)
      or not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.candidate_name));
  return jsonb_build_object('ok', true, 'view', skalama_private.vote_view(p_key));
end;
$$;

create or replace function skalama_private.vote_admin_set_avgs(p_key text, p_avgs jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  vr public.night_vote_rounds%rowtype;
begin
  if not skalama_private.is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_avgs is null or jsonb_typeof(p_avgs) <> 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  select * into vr from public.night_vote_rounds where round_key = p_key for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_round'); end if;
  if not vr.open then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  update public.night_vote_rounds set participants = skalama_private.vote_apply_avgs(vr.participants, p_avgs), updated_at = now() where round_key = p_key;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.vote_admin_open(p_key text, p_avgs jsonb default null) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_admin_open(p_key, p_avgs) $$;
create or replace function public.vote_admin_set_avgs(p_key text, p_avgs jsonb) returns jsonb
language sql volatile security invoker set search_path = '' as $$ select skalama_private.vote_admin_set_avgs(p_key, p_avgs) $$;

revoke all on function skalama_private.vote_apply_avgs(jsonb, jsonb) from public, anon, authenticated;
revoke all on function skalama_private.vote_admin_open(text, jsonb), skalama_private.vote_admin_set_avgs(text, jsonb) from public;
grant execute on function skalama_private.vote_admin_open(text, jsonb), skalama_private.vote_admin_set_avgs(text, jsonb) to anon, authenticated;
revoke all on function public.vote_admin_open(text, jsonb), public.vote_admin_set_avgs(text, jsonb) from public;
grant execute on function public.vote_admin_open(text, jsonb), public.vote_admin_set_avgs(text, jsonb) to anon, authenticated;
