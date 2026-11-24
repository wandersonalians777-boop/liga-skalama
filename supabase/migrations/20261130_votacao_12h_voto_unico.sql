-- Craque da noite: votação aberta por 12 horas e voto único (quem votou não troca).
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
  values (p_key, now(), now() + interval '12 hours', true, v_part)
  on conflict (round_key) do update set opens_at = now(), closes_at = now() + interval '12 hours', open = true, participants = excluded.participants,
    results = null, winner_name = null, winner_votes = null, total_voters = null, updated_at = now();
  delete from public.night_votes v where v.round_key = p_key
    and (not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.voter_name)
      or not exists (select 1 from jsonb_array_elements(v_part) p where p->>'name' = v.candidate_name));
  return jsonb_build_object('ok', true, 'view', skalama_private.vote_view(p_key));
end;
$$;

create or replace function skalama_private.vote_cast(p_key text, p_voter text, p_pin text, p_candidate text) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
  -- voto único: quem já votou não troca (só depois do PIN certo, para não revelar quem votou)
  insert into public.night_votes (round_key, voter_name, candidate_name) values (p_key, v_voter, v_cand)
  on conflict (round_key, voter_name) do nothing;
  if not found then return jsonb_build_object('ok', false, 'error', 'already_voted'); end if;
  return jsonb_build_object('ok', true, 'created', (v_pin->>'created')::boolean, 'mine', v_cand, 'view', skalama_private.vote_view(p_key));
end;
$$;
