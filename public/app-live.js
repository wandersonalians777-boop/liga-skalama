(() => {
  const $ = (id) => document.getElementById(id);
  const teamColors = [
    { name: "Águia", color: "#f28c28", ink: "#14120a" },
    { name: "Sol", color: "#ffc400", ink: "#14120a" },
    { name: "Lobo", color: "#2b8a50", ink: "#ffffff" },
    { name: "Azul", color: "#334fa0", ink: "#ffffff" },
  ];
  // 10–15 formam 2 ou 3 times; 16–19 formam 4 times com todos os jogadores; a partir de 20, quatro times titulares e reservas.
  const MIN_PLAYERS = 10;
  // Cadastro do Elenco: até 80 nomes; só os ativos (até 32) entram no sorteio.
  const ROSTER_MAX = 80,
    ACTIVE_MAX = 32;
  const SCORE_RULES = Object.freeze({ assist: 0.5 });
  // Mínimo de jogos no gol para entrar nos destaques de goleiro (mês e noite).
  const MIN_KEEPER_GAMES = 3;
  const startersFor = (total) => total >= 16 ? Math.min(20, total) : Math.floor(Math.max(total, MIN_PLAYERS) / 5) * 5;
  // O nome interno ("Time Águia") segue como chave; o apelido é só exibição.
  // Nome padrão exibido de cada time do Modo Liga. O nome interno continua o mesmo ("Time Verde"),
  // para não quebrar histórico, gols e escalações já salvos.
  const DEFAULT_TEAM_LABELS = { "Time Verde": "Time Lobo" };
  const defaultTeamLabel = (name) => DEFAULT_TEAM_LABELS[name] || name;
  const teamLabel = (name) => superTeam(name)?.name || state?.teamLabels?.[name] || defaultTeamLabel(name);
  // Super Liga: até 8 times, cada um com uma cor (as 4 do site e mais 4).
  const SUPER_COLORS = [
    ...teamColors,
    { name: "Vermelho", color: "#d43d3d", ink: "#ffffff" },
    { name: "Roxo", color: "#7a4fc4", ink: "#ffffff" },
    { name: "Rosa", color: "#e0589a", ink: "#14120a" },
    { name: "Cinza", color: "#6c7078", ink: "#ffffff" },
  ];
  const SUPER_MIN_TEAMS = 2,
    SUPER_MAX_TEAMS = 8,
    SUPER_MAX_PLAYERS = 16;
  const historyWinner = (game) =>
    (game.winner === game.home ? gameTeamLabel(game, "home") : game.winner === game.away ? gameTeamLabel(game, "away") : "") || game.winner;

  let client = null,
    shared = false,
    adminSession = null,
    canManageShared = false,
    state = null,
    goals = [],
    toastTimer = 0,
    sharedStatePoll = null, stateChannel = null,
    goalSubmitting = false,
    substituting = false,
    starterChoice = {},
    shootoutBusy = false,
    incidentSubmitting = false,
    suspensionSignature = "",
    gameFinishing = false;

  function nextMonday() {
    const date = new Date();
    const days = (8 - date.getDay()) % 7 || 0;
    date.setDate(date.getDate() + days);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }
  function initialState() {
    return {
      venue: "Quadra do Jemb",
      matchDate: nextMonday(),
      startTime: "",
      timerMode: "liga",
      durationMinutes: 8,
      scoreRules: { assist: SCORE_RULES.assist },
      roundId: null,
      lineups: null,
      absentPlayers: {},
      reservePlayers: [],
      roster: [],
      teams: [],
      matches: [],
      currentMatch: 0,
      incidents: [],
      currentGame: null,
      pendingMatch: null,
      challengeQueue: [],
      gameHistory: [],
      keeperRatings: [],
      superLiga: null,
      inactivePlayers: [],
      timer: {
        mode: "liga",
        duration: 480,
        endsAt: null,
        runningSince: null,
        elapsedBeforeRun: 0,
        remainingAtPause: null,
        pauseStartedAt: null,
        pauseUsedMs: 0,
      },
    };
  }
  // Rótulo de time igual ao nome de um jogador do elenco ou dos times não vale (volta o nome padrão).
  function isPlayerNameLabel(value, source = state) {
    const norm = (name) => String(name || "").replace(/\*+$/, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
    const target = norm(value);
    if (!target) return false;
    const players = [...(source?.roster || []), ...(source?.teams || []).flatMap((team) => team.players || []), ...Object.values(source?.lineups || {}).flat()];
    return players.some((name) => norm(name) === target);
  }
  function normalizeState(raw) {
    const next = { ...initialState(), ...(raw || {}) };
    if (next.teamLabels && typeof next.teamLabels === "object")
      next.teamLabels = Object.fromEntries(Object.entries(next.teamLabels).filter(([, label]) => typeof label === "string" && !isPlayerNameLabel(label, next)));
    const names = ["Time Águia", "Time Sol", "Time Verde", "Time Azul"];
    const rename = (name) => (name === "Time Água" ? "Time Águia" : name);
    if (next.teams?.length === 4)
      next.teams = next.teams.map((team, index) => ({
        ...team,
        name: names[index],
      }));
    if (next.currentGame)
      next.currentGame = {
        ...next.currentGame,
        home: rename(next.currentGame.home),
        away: rename(next.currentGame.away),
      };
    if (next.pendingMatch)
      next.pendingMatch = {
        ...next.pendingMatch,
        home: rename(next.pendingMatch.home),
        away: rename(next.pendingMatch.away),
      };
    next.challengeQueue = (next.challengeQueue || []).map(rename);
    next.gameHistory = (next.gameHistory || []).map((game) => ({
      ...game,
      home: rename(game.home),
      away: rename(game.away),
      winner: rename(game.winner),
      goals: (game.goals || []).map((goal) => ({
        ...goal,
        team: rename(goal.team),
      })),
    }));
    if (next.teams?.length >= 2 && !next.pendingMatch && !next.currentGame) {
      next.pendingMatch = { home: names[0], away: names[1] };
      next.challengeQueue = names.slice(2, next.teams.length);
    }
    return next;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function notify(message, error = false) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.toggle("error", error);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }
  function showMode(message, isError = false) {
    const box = $("modeNotice");
    box.textContent = message;
    box.classList.remove("hidden");
    if (isError) box.classList.add("error");
  }
  function setConnection(label, connected) {
    $("connectionLabel").textContent = label;
    $("connectionLabel").parentElement.classList.toggle(
      "connected",
      !!connected,
    );
  }
  function updateAccessUI() {
    const button = $("adminAccessButton"),
      label = $("accessLabel"),
      online = shared && !!client;
    setConnection(
      online
        ? canManageShared
          ? "Banco online · organizador"
          : "Banco online · leitura pública"
        : "Aguardando banco compartilhado",
      online,
    );
    // Visitante (sem login): cabeçalho limpo; o acesso do organizador fica no rodapé.
    document.body.classList.toggle("visitor-header", online && !adminSession);
    const footerButton = $("footerAdminButton");
    if (footerButton) footerButton.hidden = !online || !!adminSession;
    if (!button || !label) return;
    if (!online) {
      const publicOnly = window.LIGA_CONFIG?.publicReadOnly === true;
      button.hidden = true;
      label.hidden = !publicOnly;
      label.textContent = publicOnly
        ? "Aguardando banco compartilhado"
        : "Modo local";
      return;
    }
    button.hidden = !adminSession;
    label.hidden = !adminSession;
    label.textContent = canManageShared
      ? "Edição autorizada"
      : "Visualização pública";
    button.textContent = adminSession
      ? "Sair do modo organizador"
      : "Entrar como organizador";
  }
  function applyEditLock() {
    const locked = (shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
    document.body.classList.toggle("public-read-only", locked);
    document.querySelectorAll("[data-organizer-only]").forEach((element) => { element.hidden = locked; });
    const publicTeams = $("publicTeamsSection");
    if (publicTeams) publicTeams.hidden = !locked || !(state?.teams || []).length;
    document.querySelectorAll("button,input,select,textarea").forEach((element) => {
      if (element.id === "themeToggle" || element.id === "adminAccessButton" || element.id === "footerAdminButton" || element.closest(".home-top") || element.closest("#historico") || element.closest("#adminLogin") || element.closest("#artStudio") || element.closest("#newsPublic") || element.closest("#newsPush") || element.hasAttribute("data-view-button")) return;
      if (locked) {
        if (!element.hasAttribute("data-access-locked")) { element.dataset.accessWasDisabled = String(element.disabled); element.setAttribute("data-access-locked", ""); }
        element.disabled = true;
      } else if (element.hasAttribute("data-access-locked")) {
        element.disabled = element.dataset.accessWasDisabled === "true";
        delete element.dataset.accessWasDisabled;
        element.removeAttribute("data-access-locked");
      }
    });
    updateAccessUI();
  }
  async function refreshSharedState() {
    if (!shared || !client) return;
    const table = canManageShared ? "league_night" : "league_public";
    const { data, error } = await client.from(table).select("state").eq("id", 1).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("O registro da rodada ainda não foi criado no banco.");
    const next = normalizeState(data.state);
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; renderAll(); }
  }
  async function refreshAdminAccess(session) {
    adminSession = session || null;
    canManageShared = false;
    if (shared && adminSession?.user?.id) {
      const { data, error } = await client.from("league_admins").select("user_id").eq("user_id", adminSession.user.id).maybeSingle();
      if (error) throw error;
      canManageShared = !!data;
    }
    newsLoadedAt = 0;
    newsDraft = null;
    await refreshSharedState();
    renderAll();
    if (localStorage.getItem("liga-skalama-view") === "news") loadNews(true);
  }
  async function requestAdminAccess() {
    if (!shared || !client?.auth) {
      notify(
        "O acesso do organizador só funciona depois de configurar o banco online.",
        true,
      );
      return;
    }
    if (adminSession) {
      const { error } = await client.auth.signOut();
      if (error) {
        notify("Não foi possível sair: " + error.message, true);
        return;
      }
      adminSession = null;
      canManageShared = false;
      renderAll();
      notify("Você saiu do modo organizador.");
      return;
    }
    const dialog = $("adminLogin"),
      password = $("adminPassword");
    password.value = "";
    dialog.returnValue = "";
    dialog.showModal();
    if (
      (await new Promise((resolve) =>
        dialog.addEventListener("close", () => resolve(dialog.returnValue), {
          once: true,
        }),
      )) !== "ok"
    )
      return;
    const { error } = await client.auth.signInWithPassword({
      email: $("adminEmail").value.trim(),
      password: password.value,
    });
    password.value = "";
    if (error) {
      notify(
        "Não foi possível entrar: " +
          (error.message === "Invalid login credentials"
            ? "e-mail ou senha incorretos."
            : error.message),
        true,
      );
      return;
    }
    notify("Acesso feito. Só contas autorizadas podem editar.");
  }
  function localLoad() {
    try {
      const saved = JSON.parse(
        localStorage.getItem("liga-skalama-local") || "null",
      );
      return saved?.state
        ? saved
        : { state: initialState(), goals: [] };
    } catch {
      return { state: initialState(), goals: [] };
    }
  }
  function localSave() {
    localStorage.setItem(
      "liga-skalama-local",
      JSON.stringify({ state, goals }),
    );
  }
  function keeper(name) {
    return /\*\s*$/.test(String(name));
  }
  function displayName(name) {
    return String(name || "")
      .replace(/\*\s*$/, "")
      .trim();
  }
  function playerKey(name) {
    return displayName(name).toLocaleLowerCase("pt-BR");
  }
  function isInactive(name) {
    return (state.inactivePlayers || []).some((item) => playerKey(item) === playerKey(name));
  }
  function activeRoster() {
    return (state.roster || []).filter((name) => !isInactive(name));
  }
  function normalizePlayer(value) {
    const raw = value.trim(),
      isKeeper = /\*\s*$/.test(raw),
      name = raw.replace(/\*+\s*$/, "").trim();
    if (!name) throw new Error("Digite o nome do jogador.");
    return name + (isKeeper ? "*" : "");
  }
  function validateRoster(names) {
    if (names.length > 32)
      throw new Error(
        "A lista pode ter no máximo 32 jogadores.",
      );
    if (new Set(names.map(playerKey)).size !== names.length)
      throw new Error("Esse jogador já foi adicionado.");
    if (names.filter(keeper).length > 4)
      throw new Error(
        "Há mais goleiros do que times. O máximo é 4 para deixar um em cada time.",
      );
    return names;
  }
  function randomize(items) {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const bytes = new Uint32Array(1);
      crypto.getRandomValues(bytes);
      const j = bytes[0] % (i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  function selectedTeams() {
    const game = state.currentGame,
      pending = state.pendingMatch;
    const homeName = game?.home || pending?.home,
      awayName = game?.away || pending?.away;
    return {
      home: homeName ? { players: lineupForTeam(homeName, game) } : null,
      away: awayName ? { players: lineupForTeam(awayName, game) } : null,
    };
  }
  function gameNumber() {
    return state.currentGame?.number || (state.gameHistory || []).length + 1;
  }
  async function saveState(patch, successMessage = "Alteração salva.") {
    if ((shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true)) {
      notify("Somente o organizador autorizado pode alterar os dados.", true); return false;
    }
    const next = { ...state, ...patch };
    if (!shared) {
      state = next; renderAll(); localSave(); notify(successMessage + " (somente neste navegador)"); return true;
    }
    const { error } = await client.from("league_night").upsert({ id: 1, state: next, updated_at: new Date().toISOString() });
    if (!error) stateChannel?.send({ type: "broadcast", event: "state", payload: { at: nowMs() } }).catch?.(() => {});
    if (error) { notify("Não foi possível salvar no banco compartilhado: " + error.message, true); return false; }
    state = next; renderAll(); notify(successMessage); return true;
  }
  async function refreshGoals() {
    if (!shared) return;
    const { data, error } = await client
      .from("goals")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) {
      notify("Erro ao carregar gols: " + error.message, true);
      return;
    }
    goals = (data || []).map((goal) => ({
      ...goal,
      team_name: goal.team_name === "Time Água" ? "Time Águia" : goal.team_name,
      score_team_name:
        goal.score_team_name === "Time Água"
          ? "Time Águia"
          : goal.score_team_name ||
            (goal.team_name === "Time Água" ? "Time Águia" : goal.team_name),
      own_goal: !!goal.own_goal,
    }));
    renderGoals();
    renderTimer();
    renderGoalOptions();
  }
  async function setupShared() {
    const config = window.LIGA_CONFIG || {};
    if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) return false;
    client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data: sessionInfo } = await client.auth.getSession();
    adminSession = sessionInfo?.session || null;
    if (adminSession?.user?.id) {
      const { data: admin, error: adminError } = await client.from("league_admins").select("user_id").eq("user_id", adminSession.user.id).maybeSingle();
      if (adminError) throw adminError;
      canManageShared = !!admin;
    }
    shared = true;
    const source = canManageShared ? "league_night" : "league_public";
    let { data, error } = await client.from(source).select("state").eq("id", 1).maybeSingle();
    if (error) throw error;
    if (data) state = normalizeState(data.state);
    else if (canManageShared) {
      const { error: insertError } = await client.from("league_night").insert({ id: 1, state: initialState() });
      if (insertError && insertError.code !== "23505") throw insertError;
      const result = await client.from("league_night").select("state").eq("id", 1).single();
      if (result.error) throw result.error;
      state = normalizeState(result.data.state);
    } else throw new Error("O banco ainda não foi inicializado. O administrador precisa criar o registro inicial.");
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => refreshAdminAccess(session).catch((error) => {
        canManageShared = false;
        notify("Não foi possível validar o acesso de edição: " + error.message, true);
        renderAll();
      }), 0);
    });
    updateAccessUI();
    await refreshGoals();
    client.channel("liga-skalama-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "goals" }, refreshGoals)
      .subscribe((status) => { if (status === "SUBSCRIBED") updateAccessUI(); });
    // Aviso imediato: quando o organizador grava, os espectadores buscam o estado na hora (canal de broadcast, sem dados).
    stateChannel = client.channel("liga-skalama-state", { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "state" }, () => refreshSharedState().catch((error) => console.warn("Falha ao atualizar a rodada compartilhada:", error)))
      .subscribe();
    // Busca de segurança: a cada 2 s com jogo rolando, a cada 6 s sem jogo.
    if (sharedStatePoll) clearTimeout(sharedStatePoll);
    const poll = () => {
      sharedStatePoll = setTimeout(async () => {
        try { await refreshSharedState(); } catch (error) { console.warn("Falha ao atualizar a rodada compartilhada:", error); }
        poll();
      }, state?.currentGame ? 2000 : 6000);
    };
    poll();
    renderAll();
    return true;
  }
  function namesForSelect(select, names, placeholder, labelFor = displayName) {
    const current = select.value;
    select.innerHTML =
      '<option value="">' + escapeHtml(placeholder) + '</option>' +
      names.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(labelFor(name)) + (keeper(name) ? " · Goleiro" : "") + "</option>").join("");
    if (names.includes(current)) select.value = current;
    select.disabled = names.length === 0;
  }
  function lineupForTeam(teamName, game = null) {
    const base = () =>
      superTeam(teamName)?.players ||
      state.teams?.find((team) => team.name === teamName)?.players ||
      [];
    if (game && game.home === teamName) return game.homePlayers || base();
    if (game && game.away === teamName) return game.awayPlayers || base();
    return (!superTeam(teamName) && state.lineups?.[teamName]) || base();
  }
  // ---------- Super Liga: times próprios, tabela todos contra todos e final ----------
  function superTeam(key) {
    return (key && state?.superLiga?.teams?.find((team) => team.key === key)) || null;
  }
  function isEditLocked() {
    return (shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
  }
  // Vale o modo da partida em andamento; sem partida, o modo escolhido na aba.
  function isSuperMode() {
    return (state?.currentGame?.timerMode || state?.timerMode || "liga") === "coca";
  }
  // Times que podem jogar no modo atual.
  function modeTeams() {
    if (!isSuperMode()) return state.teams || [];
    const sl = state.superLiga;
    return sl && (sl.status === "running" || superOpenFriendly(sl)) ? sl.teams.map((team) => ({ name: team.key, players: team.players })) : [];
  }
  function superFixture(id) {
    return (id && state.superLiga?.fixtures?.find((fixture) => fixture.id === id)) || null;
  }
  // Amistoso ainda não disputado de uma Super Liga encerrada.
  function superOpenFriendly(sl = state.superLiga) {
    return (sl?.status === "finished" && (sl.fixtures || []).find((fixture) => fixture.stage === "amistoso" && !fixture.gameId)) || null;
  }
  function superNextFixture() {
    const sl = state.superLiga;
    if (!sl || (sl.status !== "running" && !superOpenFriendly(sl))) return null;
    const chosen = superFixture(sl.pending?.fixtureId);
    if (chosen && !chosen.gameId) return chosen;
    return (sl.fixtures || []).find((fixture) => !fixture.gameId) || null;
  }
  // Próximo jogo: no Modo Liga vem da fila de desafiantes; na Super Liga, da tabela sorteada.
  function currentPending() {
    if (!isSuperMode()) return state.pendingMatch;
    const fixture = superNextFixture();
    if (!fixture) return null;
    const pending = state.superLiga.pending;
    return { home: fixture.home, away: fixture.away, fixtureId: fixture.id, prepared: !!pending?.prepared && pending.fixtureId === fixture.id };
  }
  function pendingPatch(next) {
    if (!isSuperMode()) return { pendingMatch: next };
    const fixtureId = currentPending()?.fixtureId || null;
    return { superLiga: { ...state.superLiga, pending: fixtureId ? { fixtureId, prepared: !!next?.prepared } : null } };
  }
  function teamForPlayer(player) {
    const game = state.currentGame;
    return (
      [game?.home, game?.away].find(
        (name) => name && lineupForTeam(name, game).includes(player),
      ) ||
      (state.teams || []).find((team) =>
        lineupForTeam(team.name).includes(player),
      )?.name ||
      ""
    );
  }
  function isPlayerSuspended(player, game = state.currentGame) {
    if (!player || !game) return false;
    return (state.incidents || []).some((item) => item.gameId === game.id && item.type === "hand" && item.player === player && Number(item.expiresAt) > nowMs());
  }
  function gameTeamLabel(game, side) {
    const name = game && game[side];
    if (!name) return "";
    if (superTeam(name)) return superTeam(name).name;
    return game.roundId && game.roundId === state.roundId ? teamLabel(name) : (game[side + "Label"] || teamLabel(name));
  }
  // Converte o nome interno do time ("Time Sol") no apelido exibido daquela partida.
  function goalTeamLabel(game, name) {
    if (!name) return "";
    if (game && name === game.home) return gameTeamLabel(game, "home");
    if (game && name === game.away) return gameTeamLabel(game, "away");
    return teamLabel(name);
  }
  function renderLoanControls() {
    const home = $("matchHome").value, away = $("matchAway").value, superMode = isSuperMode(), teams = superMode ? [] : state.teams || [];
    for (const side of ["home", "away"]) {
      const select = $("loan" + side[0].toUpperCase() + side.slice(1) + "Player");
      const destination = side === "home" ? home : away;
      const roster = lineupForTeam(destination);
      const needed = !superMode && !state.currentGame && !!destination && roster.length === 4;
      select.hidden = !needed;
      select.parentElement.hidden = !needed;
      select.disabled = !needed;
      if (!needed) { select.value = ""; continue; }
      const otherLoan = $("loan" + (side === "home" ? "Away" : "Home") + "Player").value;
      const candidates = teams.filter((team) => team.name !== home && team.name !== away)
        .flatMap((team) => lineupForTeam(team.name).filter((player) => !(state.absentPlayers || {})[player] && player !== otherLoan).map((player) => ({ player, source: team.name })));
      const previous = select.value;
      select.innerHTML = '<option value="">Sem empréstimo</option>' + candidates.map((item) => '<option value="' + escapeHtml(item.player) + '">' + escapeHtml(displayName(item.player) + " · de " + teamLabel(item.source)) + '</option>').join("");
      if (candidates.some((item) => item.player === previous)) select.value = previous;
    }
    const wrap = $("loanPlayerControls");
    wrap.hidden = $("loanHomePlayer").hidden && $("loanAwayPlayer").hidden;
    const note = $("loanHelp");
    if (note) note.textContent = wrap.hidden ? "" : "Empréstimo válido só nesta partida. A escalação original continua igual.";
  }

  let swapPick = null;
  const swapCapacity = () => 5;
  const swapPlaying = () => new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean));
  const swapLocked = (teamName) => swapPlaying().has(teamName);
  const SWAP_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M8 4 2 8l6 4V9.5h12v-3H8Z"/><path d="m16 12 6 4-6 4v-2.5H4v-3h12Z"/></svg>';
  function swapButton(team, player, locked) {
    const selected = swapPick && swapPick.team === team && swapPick.player === player;
    const label = selected ? "Cancelar troca de " + displayName(player) : swapPick && swapPick.team !== team ? "Trocar com " + displayName(player) : "Trocar " + displayName(player) + " de time";
    return '<button type="button" class="swap-btn" data-swap-team="' + escapeHtml(team) + '" data-swap-player="' + escapeHtml(player) + '" title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '" aria-pressed="' + (selected ? "true" : "false") + '"' + (locked ? " disabled" : "") + '>' + SWAP_ICON + '</button>';
  }
  function swapHintMarkup() {
    if (swapPick) return '<div class="swap-hint active el-swapbar" role="status"><span>⇄ Trocando <b>' + escapeHtml(displayName(swapPick.player)) + '</b> (' + escapeHtml(swapPick.team === "__reservas" ? "Reservas" : teamLabel(swapPick.team)) + '), toque no ⇄ de outro jogador para trocar os dois</span><button type="button" class="el-btn el-white el-small" data-swap-cancel>Cancelar troca</button></div>';
    return '<p class="el-swaptip">Para trocar alguém de time, toque no ⇄ ao lado do nome.</p>';
    const text = !swapPick
      ? "Quer trocar alguém de time? Toque no botão ⇄ ao lado de um jogador e depois no ⇄ de outro jogador de outro time para trocar os dois, ou em \"Mover para cá\" para passá-lo a um time com vaga."
      : "Selecionado: " + displayName(swapPick.player) + " (" + (swapPick.team === "__reservas" ? "Reservas" : teamLabel(swapPick.team)) + "). Toque no ⇄ de outro jogador para trocar, ou escolha um time com vaga.";
    return '<div class="swap-hint' + (swapPick ? ' active' : '') + '"><span>' + escapeHtml(text) + '</span>' + (swapPick ? '<button type="button" class="button button-outline button-small" data-swap-cancel>Cancelar seleção</button>' : '') + '</div>';
  }
  function swapReservesMarkup() {
    const reserves = state.reservePlayers || [];
    if (!reserves.length && !swapPick) return "";
    const chips = reserves.map((name) => '<span class="swap-chip swap-row' + (swapPick && swapPick.team === "__reservas" && swapPick.player === name ? ' selected' : '') + (swapPick && swapPick.team !== "__reservas" ? ' swap-target' : '') + '"><span class="swap-name">' + escapeHtml(displayName(name)) + (keeper(name) ? ' <b class="el-g" title="Goleiro" aria-label="Goleiro">G</b>' : '') + '</span>' + swapButton("__reservas", name, false) + '</span>').join("");
    const toBench = swapPick && swapPick.team !== "__reservas" ? '<button type="button" class="swap-drop" data-swap-drop="__reservas">Mandar ' + escapeHtml(displayName(swapPick.player)) + ' para as reservas</button>' : "";
    return '<section class="swap-reserves"><strong>Reservas do sorteio (' + reserves.length + ')</strong>' + toBench + '<div class="swap-chips">' + (chips || '<span class="help-text">Nenhuma reserva.</span>') + '</div></section>';
  }
  function swapLineups() {
    return Object.fromEntries((state.teams || []).map((team) => [team.name, [...lineupForTeam(team.name)]]));
  }
  function swapApply(lineups, reserves, message) {
    swapPick = null;
    saveState({ lineups, reservePlayers: reserves }, message);
    renderTeams();
  }
  function swapClickPlayer(team, player) {
    if (state.currentGame && swapLocked(team)) { notify("Esse time está jogando agora. Troque depois da partida.", true); return; }
    if (!swapPick || (swapPick.team === team && swapPick.player === player)) {
      swapPick = swapPick && swapPick.team === team && swapPick.player === player ? null : { team, player };
      renderTeams();
      return;
    }
    if (swapPick.team === team) { swapPick = { team, player }; renderTeams(); return; }
    const a = swapPick, lineups = swapLineups(), reserves = [...(state.reservePlayers || [])];
    const listOf = (t) => (t === "__reservas" ? reserves : lineups[t]);
    const la = listOf(a.team), lb = listOf(team);
    if (!la || !lb || !la.includes(a.player) || !lb.includes(player)) { swapPick = null; renderTeams(); return; }
    la[la.indexOf(a.player)] = player;
    lb[lb.indexOf(player)] = a.player;
    for (const t of [a.team, team]) {
      if (t !== "__reservas" && lineups[t].filter(keeper).length > 1) { notify("Essa troca deixaria " + teamLabel(t) + " com dois goleiros (*).", true); return; }
    }
    const nameOf = (t) => (t === "__reservas" ? "as reservas" : teamLabel(t));
    swapApply(lineups, reserves, displayName(a.player) + " foi para " + nameOf(team) + " e " + displayName(player) + " foi para " + nameOf(a.team) + ".");
  }
  function swapDrop(target) {
    const a = swapPick;
    if (!a || a.team === target) return;
    const lineups = swapLineups(), reserves = [...(state.reservePlayers || [])];
    if (target !== "__reservas" && (swapLocked(target) || lineups[target].length >= swapCapacity())) { notify("Esse time está completo ou jogando agora.", true); return; }
    if (target !== "__reservas" && keeper(a.player) && lineups[target].some(keeper)) { notify("Esse time já tem um goleiro (*).", true); return; }
    if (a.team === "__reservas") reserves.splice(reserves.indexOf(a.player), 1); else lineups[a.team] = lineups[a.team].filter((name) => name !== a.player);
    if (target === "__reservas") reserves.push(a.player); else lineups[target].push(a.player);
    swapApply(lineups, reserves, displayName(a.player) + " foi para " + (target === "__reservas" ? "as reservas" : teamLabel(target)) + ".");
  }
  function bindSwapGrid() {
    $("teamsGrid").addEventListener("click", (event) => {
      const player = event.target.closest("[data-swap-player]"), drop = event.target.closest("[data-swap-drop]"), cancel = event.target.closest("[data-swap-cancel]");
      if (player) swapClickPlayer(player.dataset.swapTeam, player.dataset.swapPlayer);
      else if (drop) swapDrop(drop.dataset.swapDrop);
      else if (cancel) { swapPick = null; renderTeams(); }
    });
  }
  function renderTeams() {
    const grid = $("teamsGrid"), publicGrid = $("publicTeamsGrid"), teams = state.teams || [];
    if (!teams.length) {
      grid.innerHTML = '<p class="el-empty">Os times aparecem aqui depois do sorteio.</p>';
      if (publicGrid) publicGrid.innerHTML = '<p class="empty-state">Os times aparecerão depois do sorteio.</p>';
      return;
    }
    const markup = teams.map((team, index) => {
      const color = teamColors[index] || teamColors[0], players = lineupForTeam(team.name), short = players.length === 4;
      const locked = swapLocked(team.name), canDrop = !!swapPick && swapPick.team !== team.name && !locked && players.length < swapCapacity();
      const items = players.map((name) => '<li class="swap-row' + (swapPick && swapPick.team === team.name && swapPick.player === name ? ' selected' : '') + (swapPick && swapPick.team !== team.name && !locked ? ' swap-target' : '') + '"><span class="swap-name">' + escapeHtml(displayName(name)) + (keeper(name) ? ' <b class="el-g" title="Goleiro" aria-label="Goleiro">G</b>' : '') + '</span>' + swapButton(team.name, name, locked) + '</li>').join('');
      const [head, ink] = EL_HEAD[team.name] || [color.color, color.ink], naming = elUI.naming[team.name] || !!state.teamLabels?.[team.name];
      return '<article class="team-card el-team' + (short ? ' team-card-short' : '') + '"><header class="team-head el-team-head" style="--team-color:' + head + ';--team-ink:' + ink + '">' + elCrest(team.name, "m") + '<strong>' + escapeHtml(teamLabel(team.name)) + '</strong>' + (players.length < 5 ? '<small>' + (players.length < 4 ? 'INCOMPLETO' : 'VAGA') + '</small>' : '') + '</header>' + (canDrop ? '<button type="button" class="swap-drop" data-swap-drop="' + escapeHtml(team.name) + '">Mover ' + escapeHtml(displayName(swapPick.player)) + ' para cá</button>' : '') + '<ol>' + items + '</ol>' + (naming ? '<label class="el-team-name">Nome do time<input class="team-label-input" name="nome-do-time" autocomplete="off" data-team-label="' + escapeHtml(team.name) + '" maxlength="30" placeholder="Nome do time (opcional)" value="' + escapeHtml(state.teamLabels?.[team.name] || '') + '"></label>' : '<button type="button" class="el-name-btn" data-el-name-team="' + escapeHtml(team.name) + '">✎ Dar nome ao time</button>') + '</article>';
    }).join('');
    grid.innerHTML = swapHintMarkup() + markup + swapReservesMarkup();
    if (publicGrid) {
      const sizes = teams.map((team) => lineupForTeam(team.name).length), min = Math.min(...sizes), max = Math.max(...sizes);
      publicGrid.innerHTML = teams.map((team) => {
        const players = lineupForTeam(team.name);
        const crest = crestFor(team.name);
        return '<article class="home-team-card"><header><strong>' + (crest ? '<span class="home-team-crest"><img src="' + escapeHtml(crest) + '" alt=""></span>' : '') + escapeHtml(teamLabel(team.name)) + '</strong><span>' + players.length + (players.length === 1 ? ' JOGADOR' : ' JOGADORES') + '</span></header><ol>' + players.map((name) => '<li><span>' + escapeHtml(displayName(name)) + '</span>' + (keeper(name) ? '<b class="home-keeper" title="Goleiro" aria-label="Goleiro">G</b>' : '') + '</li>').join('') + '</ol></article>';
      }).join('');
      const count = $("publicTeamsCount");
      if (count) count.textContent = teams.length + (teams.length === 1 ? " time" : " times") + " · " + (min === max ? max + (max === 1 ? " jogador" : " jogadores") + " cada" : min + " a " + max + " jogadores");
    }
  }
  function renderLineupAdjustments() {
    const details = $("lineupAdjustDetails"),
      grid = $("lineupAdjustGrid"),
      absentBox = $("absentPlayersList"),
      teams = state.teams || [],
      capacity = 5;
    // Na Super Liga os jogadores ficam no painel da própria Super Liga.
    details.hidden = !teams.length || isSuperMode();
    const lineups = Object.fromEntries(
        teams.map((team) => [team.name, [...lineupForTeam(team.name)]]),
      ),
      absent = state.absentPlayers || {},
      playing = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean));
    if (!teams.length) {
      grid.innerHTML =
        '<p class="empty-state">Sorteie os times para ajustar as escalações.</p>';
      absentBox.innerHTML = "";
      return;
    }
    grid.innerHTML = teams
      .map((team) => {
        const players = lineups[team.name],
          pool = teams
            .filter(
              (other) =>
                other.name !== team.name && !playing.has(other.name) && lineups[other.name].length > 0,
            )
            .flatMap((other) => lineups[other.name])
            .filter(
              (name) =>
                !absent[name] && (!keeper(name) || !players.some(keeper)),
            );
        return (
          '<article class="lineup-team-card"><header><strong>' +
          escapeHtml(teamLabel(team.name)) +
          "</strong><span>" +
          players.length +
          "/" +
          capacity +
          "</span></header><ul>" +
          players
            .map(
              (name) =>
                "<li><span>" +
                escapeHtml(displayName(name)) +
                (keeper(name)
                  ? ' <b class="keeper-mark">* · Goleiro</b>'
                  : "") +
                '</span><button type="button" class="lineup-remove-player" data-absence-team="' +
                escapeHtml(team.name) +
                '" data-absence-player="' +
                escapeHtml(name) +
                '" ' +
                (playing.has(team.name) ? "disabled" : "") +
                ">Ausente</button></li>",
            )
            .join("") +
          '</ul><div class="lineup-transfer"><select data-transfer-player="' +
          escapeHtml(team.name) +
          '" ' +
          (playing.has(team.name) || players.length >= capacity || !pool.length
            ? "disabled"
            : "") +
          '><option value="">' +
          (players.length >= capacity
            ? "Time completo"
            : pool.length
              ? "Escolha alguém de outro time"
              : "Sem jogador disponível") +
          "</option>" +
          pool
            .map(
              (name) =>
                '<option value="' +
                escapeHtml(name) +
                '">' +
                escapeHtml(displayName(name)) +
                (keeper(name) ? " · Goleiro" : "") +
                "</option>",
            )
            .join("") +
          '</select><button type="button" class="button button-outline" data-transfer-to="' +
          escapeHtml(team.name) +
          '" ' +
          (playing.has(team.name) || players.length >= capacity || !pool.length
            ? "disabled"
            : "") +
          ">Puxar jogador</button></div></article>"
        );
      })
      .join("");
    const absentRows = Object.entries(absent),
      openTeams = teams.filter((team) => !playing.has(team.name) && lineups[team.name].length < capacity);
    absentBox.innerHTML = absentRows.length
      ? "<p>Jogadores fora da escalação: " +
        absentRows
          .map(
            ([name, team]) =>
              '<span class="absent-chip"><span>' +
              escapeHtml(displayName(name)) +
              " · saiu de " +
              escapeHtml(teamLabel(team)) +
              '</span><select data-return-team="' +
              escapeHtml(name) +
              '" ' +
              (!openTeams.length ? "disabled" : "") +
              '><option value="">' +
              (openTeams.length ? "Escolha uma vaga" : "Sem vaga aberta") +
              "</option>" +
              openTeams
                .map(
                  (target) =>
                    '<option value="' +
                    escapeHtml(target.name) +
                    '">' +
                    target.name +
                    " · " +
                    lineups[target.name].length +
                    "/" +
                    capacity +
                    "</option>",
                )
                .join("") +
              '</select><button type="button" data-restore-player="' +
              escapeHtml(name) +
              '" ' +
              (!openTeams.length ? "disabled" : "") +
              ">Preencher vaga</button></span>",
          )
          .join("") +
        "</p>"
      : '<p class="help-text">Cada equipe pode iniciar com quatro ou cinco jogadores. Na Super Liga SKALAMA, pode chegar a nove convocados.</p>';
    grid.querySelectorAll("[data-transfer-to]").forEach((button) =>
      button.addEventListener("click", () => {
        const target = button.dataset.transferTo,
          select = [...grid.querySelectorAll("[data-transfer-player]")].find(
            (item) => item.dataset.transferPlayer === target,
          ),
          player = select?.value;
        if (!player) return;
        const next = Object.fromEntries(
          teams.map((team) => [team.name, [...lineups[team.name]]]),
        );
        const source = teams.find((team) => next[team.name].includes(player));
        if (
          !source ||
          next[target].length >= capacity ||
          playing.has(source.name) ||
          playing.has(target) ||
          teams.reduce((count, team) => count + next[team.name].filter((name) => name === player).length, 0) !== 1 ||
          (keeper(player) && next[target].some(keeper))
        )
          return;
        next[source.name] = next[source.name].filter((name) => name !== player);
        next[target].push(player);
        saveState(
          { lineups: next },
          displayName(player) +
            " foi para " +
            target +
            ". O time que cedeu ficou com " + (next[source.name].length ? next[source.name].length + " jogador(es)." : "nenhum jogador."),
        );
      }),
    );
    grid.querySelectorAll("[data-absence-player]").forEach((button) =>
      button.addEventListener("click", () => {
        const team = button.dataset.absenceTeam,
          player = button.dataset.absencePlayer,
          next = Object.fromEntries(
            teams.map((item) => [item.name, [...lineups[item.name]]]),
          );
        if (playing.has(team)) return;
        next[team] = next[team].filter((name) => name !== player);
        saveState(
          { lineups: next, absentPlayers: { ...absent, [player]: team } },
          displayName(player) + " marcado como ausente.",
        );
      }),
    );
    absentBox.querySelectorAll("[data-restore-player]").forEach((button) =>
      button.addEventListener("click", () => {
        const player = button.dataset.restorePlayer,
          target = [...absentBox.querySelectorAll("[data-return-team]")].find(
            (item) => item.dataset.returnTeam === player,
          )?.value;
        if (!target || playing.has(target) || lineups[target].length >= capacity)
          return;
        const next = Object.fromEntries(
          teams.map((item) => [item.name, [...lineups[item.name]]]),
        );
        next[target].push(player);
        const rest = { ...absent };
        delete rest[player];
        saveState(
          { lineups: next, absentPlayers: rest },
          displayName(player) + " preencheu uma vaga no " + target + ".",
        );
      }),
    );
  }
  async function addNewTeamPlayer() {
    const team = $("newTeamPlayerTeam").value,
      name = $("newTeamPlayer").value.trim().replace(/\s+/g, " "),
      capacity = (state.timerMode || "liga") === "coca" ? 9 : 5;
    if (!team || !(state.teams || []).some((item) => item.name === team)) { notify("Escolha o time que vai receber o jogador.", true); return; }
    if (state.currentGame && [state.currentGame.home, state.currentGame.away].includes(team)) { notify("Esse time está jogando agora. Inscreva o jogador depois da partida.", true); return; }
    if (!displayName(name)) { notify("Digite o nome do jogador.", true); return; }
    if (name.length > 50) { notify("O nome pode ter no máximo 50 caracteres.", true); return; }
    const lineups = Object.fromEntries((state.teams || []).map((item) => [item.name, [...lineupForTeam(item.name)]]));
    const everyone = [...(state.roster || []), ...Object.values(lineups).flat(), ...(state.reservePlayers || []), ...Object.keys(state.absentPlayers || {})];
    if (everyone.some((existing) => playerKey(existing) === playerKey(name))) { notify("Já existe um jogador com esse nome.", true); return; }
    if (lineups[team].length >= capacity) { notify(teamLabel(team) + " já está com " + capacity + " jogadores.", true); return; }
    if (keeper(name) && lineups[team].some(keeper)) { notify("Esse time já tem um goleiro marcado com *.", true); return; }
    lineups[team].push(name);
    $("newTeamPlayer").value = "";
    await saveState({ lineups }, displayName(name) + " foi inscrito no " + teamLabel(team) + ".");
  }
  function renderReserveControls() {
    const box = $("reserveControls"),
      capacity = (state.timerMode || "liga") === "coca" ? 9 : 5;
    box.hidden = !state.teams?.length || (state.timerMode || "liga") !== "coca";
    const playingNow = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean)),
      open = (state.teams || []).filter((team) => !playingNow.has(team.name) && lineupForTeam(team.name).length < capacity),
      keepTeam = $("newTeamPlayerTeam").value;
    namesForSelect($("newTeamPlayerTeam"), open.map((team) => team.name), "Escolha o time", teamLabel);
    if (open.some((team) => team.name === keepTeam)) $("newTeamPlayerTeam").value = keepTeam;
    $("newTeamPlayerTeam").disabled = !open.length;
    $("newTeamPlayer").disabled = !open.length;
    $("addNewTeamPlayer").disabled = !open.length;
  }
  // ---------- Elenco e sorteio: painel do organizador ----------
  // As regras continuam as mesmas (startersFor, drawTeams, troca livre, fila); aqui muda só a apresentação e o fluxo.
  const elUI = { filter: "all", showAll: false, menu: null, editing: null, naming: {}, reorder: false };
  const EL_PREVIEW = 12;
  const EL_HEAD = { "Time Águia": ["#c2560c", "#ffffff"], "Time Sol": ["#ffc400", "#0d0d0d"], "Time Verde": ["#1f6e3a", "#ffffff"], "Time Azul": ["#23439c", "#ffffff"] };
  // Mesma regra do sorteio: quantos times e quantos reservas saem com n confirmados.
  function elDrawPlan(n) {
    if (n < MIN_PLAYERS) return { ok: false, text: "faltam " + (MIN_PLAYERS - n) + " para fechar 2 times", teams: 0, sizes: [], reserves: 0 };
    const starters = startersFor(n), teams = Math.ceil(starters / 5), reserves = n - starters, exact = starters === teams * 5;
    const sizes = Array.from({ length: teams }, () => (exact ? "5" : "≤5"));
    const text = "dá " + teams + " times " + (exact ? "de 5" : "(até 5 por time)") + (reserves ? " + " + reserves + (reserves === 1 ? " reserva" : " reservas") : "");
    return { ok: true, text, teams, sizes, reserves, starters, exact };
  }
  function elCrest(key, size = "m") {
    const label = teamLabel(key), src = crestFor(key, label),
      initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return '<span class="el-crest el-crest-' + size + (src ? "" : " el-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
  }
  function elSteps() {
    const done = [
      !!(String(state.venue || "").trim() && state.matchDate && state.startTime),
      activeRoster().length >= MIN_PLAYERS,
      !!(state.teams || []).length,
      false,
    ];
    let current = done.findIndex((value) => !value);
    if (current < 0) current = 3;
    document.querySelectorAll("#elSteps li").forEach((li, index) => {
      li.classList.toggle("is-done", done[index] && index !== current);
      li.classList.toggle("is-current", index === current);
      if (index === current) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }
  function renderRoster() {
    const roster = state.roster || [], list = $("rosterList"), active = roster.filter((name) => !isInactive(name)), plan = elDrawPlan(active.length);
    $("rosterCount").innerHTML = "<b>" + active.length + '</b><span><strong>de ' + roster.length + " confirmados</strong><small>" + escapeHtml(plan.text) + "</small></span>";
    const counts = { all: roster.length, in: active.length, out: roster.length - active.length };
    $("elFilters").innerHTML = [["all", "Todos"], ["in", "Vão jogar"], ["out", "Não vão"]].map(([key, label]) => '<button type="button" class="el-filter' + (elUI.filter === key ? " is-on" : "") + '" data-el-filter="' + key + '" aria-pressed="' + (elUI.filter === key) + '">' + label + " <b>" + counts[key] + "</b></button>").join("");
    const rows = roster.map((name, index) => ({ name, index, off: isInactive(name) })).filter((row) => elUI.filter === "all" || (elUI.filter === "in" ? !row.off : row.off)),
      shown = elUI.showAll ? rows : rows.slice(0, EL_PREVIEW);
    list.innerHTML = shown.length
      ? shown.map(({ name, index, off }) => {
          const label = displayName(name), menuOpen = elUI.menu === index, editing = elUI.editing === index;
          return '<li class="el-player' + (off ? " is-off" : "") + '">' +
            (editing
              ? '<form class="el-edit" data-el-edit-form="' + index + '"><label class="sr-only" for="elEditName">Novo nome de ' + escapeHtml(label) + '</label><input id="elEditName" maxlength="50" value="' + escapeHtml(label) + '"><button type="submit" class="el-btn el-black el-small">Salvar</button><button type="button" class="el-btn el-white el-small" data-el-edit-cancel>Cancelar</button></form>'
              : '<span class="el-pname">' + escapeHtml(label) + (keeper(name) ? ' <b class="el-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</span>" +
                '<button type="button" class="el-switch' + (off ? "" : " is-on") + '" role="switch" aria-checked="' + !off + '" aria-label="' + escapeHtml(label) + ": " + (off ? "não vai jogar" : "vai jogar") + '" data-toggle-player="' + index + '"><i aria-hidden="true"></i><span>' + (off ? "Não vai" : "Vai jogar") + "</span></button>" +
                '<div class="el-menu-wrap"><button type="button" class="el-more" aria-haspopup="true" aria-expanded="' + menuOpen + '" aria-label="Mais opções para ' + escapeHtml(label) + '" data-el-menu="' + index + '">⋯</button>' +
                (menuOpen ? '<div class="el-menu" role="menu"><button type="button" role="menuitem" data-el-edit="' + index + '">✎ Editar nome</button><button type="button" role="menuitem" data-el-keeper="' + index + '">' + (keeper(name) ? "Desmarcar como goleiro" : "Marcar como goleiro") + '</button><button type="button" role="menuitem" class="is-danger" data-el-remove="' + index + '">Remover do cadastro</button></div>' : "") + "</div>") +
            "</li>";
        }).join("")
      : '<li class="el-empty">' + (roster.length ? "Ninguém neste filtro." : "Nenhum jogador cadastrado ainda.") + "</li>";
    $("elMore").innerHTML = rows.length > EL_PREVIEW ? '<button type="button" class="el-btn el-white" data-el-more>' + (elUI.showAll ? "Mostrar menos" : "Mostrar todos os " + rows.length + " jogadores") + "</button>" : "";
    if (elUI.editing !== null) { const input = $("elEditName"); if (input && document.activeElement !== input) { input.focus(); input.select(); } }
    $("newPlayer").disabled = roster.length >= ROSTER_MAX;
    $("addPlayer").disabled = roster.length >= ROSTER_MAX;
    $("drawTeams").disabled = active.length < MIN_PLAYERS;
    // Depois do sorteio vale o "↻ Sortear de novo" (embaixo dos times).
    $("drawTeams").hidden = !!(state.teams || []).length;
    // Aviso do sorteio, com um quadradinho por time
    $("elDrawInfo").innerHTML = '<div class="el-plan' + (plan.ok ? "" : " is-short") + '"><span class="el-plan-boxes" aria-hidden="true">' + plan.sizes.map((size) => "<i>" + size + "</i>").join("") + "</span><p>" +
      (plan.ok ? escapeHtml(active.length + " jogadores → " + plan.teams + " times " + (plan.exact ? "de 5" : "(até 5 por time)") + ".") + " Os goleiros ficam em times diferentes." + (plan.reserves ? " Os que sobram viram reservas." : "")
        : escapeHtml("Marque pelo menos " + MIN_PLAYERS + " jogadores para sortear (" + plan.text + ").")) + "</p></div>";
    elSteps();
  }
  async function elAddPlayer() {
    const input = $("newPlayer"), raw = input.value.trim().replace(/\*+\s*$/, "").trim();
    if (!raw) { notify("Digite o nome do jogador.", true); input.focus(); return; }
    input.value = raw + ($("newPlayerKeeper").checked ? "*" : "");
    const before = (state.roster || []).length;
    await addPlayer();
    if ((state.roster || []).length > before) $("newPlayerKeeper").checked = false;
    else input.value = raw;
  }
  // Troca o nome (ou a marca de goleiro) do jogador em todos os lugares da rodada atual.
  async function elReplacePlayer(index, next, message) {
    const roster = [...(state.roster || [])], old = roster[index];
    if (!old || old === next) return;
    if (roster.some((name, i) => i !== index && playerKey(name) === playerKey(next))) { notify("Já existe um jogador com esse nome.", true); return; }
    roster[index] = next;
    const swap = (list) => (list || []).map((name) => (name === old ? next : name));
    const patch = { roster, inactivePlayers: (state.inactivePlayers || []).map((name) => (playerKey(name) === playerKey(old) ? next : name)) };
    if ((state.teams || []).length) {
      patch.teams = state.teams.map((team) => ({ ...team, players: swap(team.players) }));
      if (state.lineups) patch.lineups = Object.fromEntries(Object.entries(state.lineups).map(([team, players]) => [team, swap(players)]));
      patch.reservePlayers = swap(state.reservePlayers);
      if (state.absentPlayers?.[old]) { const absent = { ...state.absentPlayers, [next]: state.absentPlayers[old] }; delete absent[old]; patch.absentPlayers = absent; }
    }
    if (swapPick?.player === old) swapPick = null;
    await saveState(patch, message);
  }
  function elKeeperFlag(name, on) {
    return displayName(name) + (on ? "*" : "");
  }
  function bindElenco() {
    const quem = $("elQuem");
    $("elAddForm").addEventListener("submit", (event) => { event.preventDefault(); elAddPlayer(); });
    quem.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const data = target.dataset;
      if (data.elFilter) { elUI.filter = data.elFilter; elUI.menu = null; renderRoster(); }
      else if ("elMore" in data) { elUI.showAll = !elUI.showAll; renderRoster(); }
      else if (data.togglePlayer) { elUI.menu = null; toggleActivePlayer(Number(data.togglePlayer)); }
      else if (data.elMenu) { const index = Number(data.elMenu); elUI.menu = elUI.menu === index ? null : index; renderRoster(); quem.querySelector('[data-el-menu="' + index + '"]')?.focus(); }
      else if (data.elEdit) { elUI.editing = Number(data.elEdit); elUI.menu = null; renderRoster(); }
      else if ("elEditCancel" in data) { elUI.editing = null; renderRoster(); }
      else if (data.elKeeper) {
        const index = Number(data.elKeeper), name = (state.roster || [])[index];
        elUI.menu = null;
        if (name) elReplacePlayer(index, elKeeperFlag(name, !keeper(name)), displayName(name) + (keeper(name) ? " não é mais goleiro." : " agora é goleiro."));
      }
      else if (data.elRemove) {
        const index = Number(data.elRemove), name = (state.roster || [])[index];
        elUI.menu = null;
        if (!name) return;
        const extra = state.teams?.length ? " Os times sorteados serão desfeitos." : "";
        askConfirm({ title: "Remover jogador?", message: "Remover " + displayName(name) + " do cadastro? Essa ação não pode ser desfeita." + extra, confirmText: "Remover", tone: "red" }).then((yes) => {
          if (!yes || (state.roster || [])[index] !== name) { renderRoster(); return; }
          removePlayer(index, true);
        });
      }
    });
    quem.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-el-edit-form]");
      if (!form) return;
      event.preventDefault();
      const index = Number(form.dataset.elEditForm), name = (state.roster || [])[index], value = ($("elEditName")?.value || "").trim().replace(/\*+\s*$/, "").trim();
      if (!name) return;
      if (!value) { notify("Digite o nome do jogador.", true); return; }
      elUI.editing = null;
      if (value === displayName(name)) { renderRoster(); return; }
      elReplacePlayer(index, elKeeperFlag(value, keeper(name)), "Nome atualizado: " + value + ".");
    });
    document.addEventListener("click", (event) => {
      if (elUI.menu !== null && !event.target.closest(".el-menu-wrap")) { elUI.menu = null; renderRoster(); }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && elUI.menu !== null) { const index = elUI.menu; elUI.menu = null; renderRoster(); $("rosterList").querySelector('[data-el-menu="' + index + '"]')?.focus(); }
    });
    // Sortear de novo, dar nome ao time
    $("elRedraw").addEventListener("click", async (event) => {
      if (!event.target.closest("[data-el-redraw]")) return;
      const manual = (state.teams || []).some((team) => JSON.stringify(lineupForTeam(team.name)) !== JSON.stringify(team.players));
      if (manual && !(await askConfirm({ title: "Sortear de novo?", message: "As trocas feitas à mão serão perdidas.", confirmText: "Sortear de novo", tone: "red" }))) return;
      drawTeams();
    });
    $("teamsGrid").addEventListener("click", (event) => {
      const button = event.target.closest("[data-el-name-team]");
      if (!button) return;
      const team = button.dataset.elNameTeam;
      elUI.naming[team] = true;
      renderTeams();
      $("teamsGrid").querySelector('[data-team-label="' + CSS.escape(team) + '"]')?.focus();
    });
    // Sequência: trocar ordem e confirmar
    $("elReorder").addEventListener("click", () => { elUI.reorder = !elUI.reorder; renderFixtures(); });
    $("elReorderBox").addEventListener("click", (event) => {
      const button = event.target.closest("[data-el-move]");
      if (!button || button.disabled) return;
      const order = elOrder(), index = Number(button.dataset.elIndex), to = index + (button.dataset.elMove === "up" ? -1 : 1);
      if (to < 0 || to >= order.length) return;
      [order[index], order[to]] = [order[to], order[index]];
      saveState({ pendingMatch: { home: order[0], away: order[1] }, challengeQueue: order.slice(2) }, "Nova ordem: " + teamLabel(order[0]) + " × " + teamLabel(order[1]) + " começam.");
    });
    $("elConfirm").addEventListener("click", async () => {
      if (!(state.teams || []).length) return;
      if (!state.currentGame && activeLiveMode() !== "liga") await saveState({ timerMode: "liga" }, "Modo Liga selecionado.");
      setView("live");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  // Ordem atual da fila: jogo 1 (casa, visitante) e depois os que esperam.
  function elOrder() {
    const pending = state.pendingMatch, teams = (state.teams || []).map((team) => team.name);
    const order = [pending?.home, pending?.away, ...(state.challengeQueue || []), ...teams];
    return order.filter((name, index) => name && teams.includes(name) && order.indexOf(name) === index);
  }
  function renderFixtures() {
    const list = $("fixturesList"), teams = state.teams || [], box = $("elReorderBox"), reorder = $("elReorder"), confirmBtn = $("elConfirm");
    confirmBtn.disabled = !teams.length;
    reorder.disabled = !teams.length || !!state.currentGame;
    if (!teams.length) { list.innerHTML = '<p class="el-empty">Sorteie os times para ver a sequência dos jogos.</p>'; box.hidden = true; $("elRedraw").innerHTML = ""; elSteps(); return; }
    const order = elOrder(), game = state.currentGame, [a, b, ...rest] = order;
    const blocks = [];
    if (game && !game.superLigaId) blocks.push('<li class="el-block is-first"><small>EM QUADRA</small><span class="el-block-teams">' + elCrest(game.home, "s") + "<strong>" + escapeHtml(teamLabel(game.home) + " × " + teamLabel(game.away)) + "</strong>" + elCrest(game.away, "s") + "</span></li>");
    else blocks.push('<li class="el-block is-first"><small>JOGO 1</small><span class="el-block-teams">' + elCrest(a, "s") + "<strong>" + escapeHtml(teamLabel(a) + " × " + teamLabel(b)) + "</strong>" + elCrest(b, "s") + "</span></li>");
    const waiting = game && !game.superLigaId ? lvWaiting(game) : rest;
    waiting.forEach((team, index) => blocks.push('<li class="el-block"><small>JOGO ' + (index + 2) + '</small><span class="el-block-teams"><strong>Vencedor ×</strong>' + elCrest(team, "s") + "<strong>" + escapeHtml(teamLabel(team)) + "</strong></span></li>"));
    if (!waiting.length) blocks.push('<li class="el-block"><small>JOGO 2</small><span class="el-block-teams"><strong>Vencedor × Perdedor</strong></span></li>');
    blocks.push('<li class="el-block is-after"><small>DEPOIS</small><span class="el-block-teams"><strong>Perdedores entram na fila</strong></span></li>');
    list.innerHTML = '<ol class="el-chain">' + blocks.join('<li class="el-arrow" aria-hidden="true">→</li>') + "</ol>";
    box.hidden = !elUI.reorder || !!state.currentGame;
    reorder.textContent = elUI.reorder ? "✓ Pronto" : "⇅ Trocar ordem";
    box.innerHTML = '<p class="el-lead">Use as setas para escolher quem começa. Os dois primeiros fazem o jogo 1.</p><ol>' + order.map((team, index) => '<li><span class="el-pos">' + (index + 1) + "</span>" + elCrest(team, "s") + "<strong>" + escapeHtml(teamLabel(team)) + '</strong><button type="button" class="el-btn el-white el-small" data-el-move="up" data-el-index="' + index + '" aria-label="Subir ' + escapeHtml(teamLabel(team)) + '"' + (index === 0 ? " disabled" : "") + '>↑</button><button type="button" class="el-btn el-white el-small" data-el-move="down" data-el-index="' + index + '" aria-label="Descer ' + escapeHtml(teamLabel(team)) + '"' + (index === order.length - 1 ? " disabled" : "") + ">↓</button></li>").join("") + "</ol>";
    $("elRedraw").innerHTML = '<button type="button" class="el-btn el-white" data-el-redraw>↻ Sortear de novo</button>';
    elSteps();
  }

  function clockText(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  // ---------- Hora do servidor: organizador e espectador contam o tempo pelo mesmo relógio ----------
  // O cronômetro guarda horários absolutos; cada aparelho tem o relógio um pouco diferente. Medimos a diferença
  // para o servidor do site (cabeçalho Date, com várias amostras para chegar a ~décimos de segundo) e usamos nowMs().
  let clockOffset = 0, clockSyncing = false;
  const nowMs = () => Date.now() + clockOffset;
  async function syncServerClock() {
    if (clockSyncing || typeof fetch !== "function") return;
    clockSyncing = true;
    try {
      let low = -Infinity, high = Infinity, got = 0;
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now();
        const res = await fetch("./manifest.webmanifest?clock=" + t0 + "-" + i, { method: "HEAD", cache: "no-store" }).catch(() => null);
        const t1 = Date.now(), header = res?.headers?.get("date"), server = header ? Date.parse(header) : NaN;
        if (Number.isFinite(server) && t1 - t0 < 3000) {
          // O servidor gerou a resposta entre t0 e t1; o cabeçalho corta os milissegundos (server <= real < server + 1000).
          low = Math.max(low, server - t1);
          high = Math.min(high, server + 1000 - t0);
          got++;
          // Já vale desde a primeira resposta e fica mais precisa a cada amostra.
          if (low <= high) clockOffset = Math.round((low + high) / 2);
        }
        if (i < 5) await new Promise((resolve) => setTimeout(resolve, 170 + Math.random() * 60));
      }
      if (got && low <= high) clockOffset = Math.round((low + high) / 2);
      else if (got && Number.isFinite(low)) clockOffset = Math.round(low);
    } finally { clockSyncing = false; }
  }
  function pauseLimitMs(timer = state.timer || {}) {
    return timer.mode === "coca" ? 120000 : 60000;
  }
  function pauseBudgetUsed(timer = state.timer || {}) {
    const limit = pauseLimitMs(timer),
      used = timer.pauseUsedMs || 0;
    return Math.min(
      limit,
      used +
        (timer.pauseStartedAt
          ? Math.max(0, nowMs() - timer.pauseStartedAt)
          : 0),
    );
  }
  function isPauseActive(timer = state.timer || {}) {
    return (
      !!timer.pauseStartedAt &&
      nowMs() <
        timer.pauseStartedAt +
          Math.max(0, pauseLimitMs(timer) - (timer.pauseUsedMs || 0))
    );
  }
  function timerRemaining(timer = state.timer || {}) {
    const now = nowMs();
    if (timer.endsAt)
      return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
    if (timer.pauseStartedAt && timer.remainingAtPause != null) {
      const resumeAt =
        timer.pauseStartedAt +
        Math.max(0, pauseLimitMs(timer) - (timer.pauseUsedMs || 0));
      if (now < resumeAt) return timer.remainingAtPause;
      return Math.max(
        0,
        Math.ceil((resumeAt + timer.remainingAtPause * 1000 - now) / 1000),
      );
    }
    return timer.duration || 480;
  }
  function timerElapsed(timer = state.timer || {}) {
    return Math.max(0, (timer.duration || 480) - timerRemaining(timer));
  }
  function scoreTeam(goal, game = state.currentGame) {
    if (!goal.own_goal) return goal.score_team_name || goal.team_name;
    return goal.team_name === game?.home ? game.away : game?.home;
  }
  function currentScore(teamName, game = state.currentGame) {
    return game
      ? goals.filter(
          (g) => g.game_id === game.id && scoreTeam(g, game) === teamName,
        ).length
      : 0;
  }
  function renderMatchPreview() {
    const home = $("matchHome")?.value || state.currentGame?.home || currentPending()?.home;
    const away = $("matchAway")?.value || state.currentGame?.away || currentPending()?.away;
    const target = $("matchLineupPreview");
    if (!target) return;
    if (!home || !away || home === away) { target.innerHTML = '<p class="empty-state">Escolha dois times diferentes para ver a escalação.</p>'; return; }
    target.innerHTML = [home, away].map((name, index) => {
      const side = index === 0 ? "home" : "away", players = [...lineupForTeam(name, state.currentGame)];
      const loan = state.currentGame ? null : $("loan" + side[0].toUpperCase() + side.slice(1) + "Player").value;
      if (loan && !players.includes(loan)) players.push(loan);
      return '<div class="match-preview-team" style="--team-color:' + colorOf(name).color + ';--team-ink:' + colorOf(name).ink + '"><strong>' + escapeHtml(teamLabel(name)) + '</strong><ul>' + players.map((player) => {
        const penalty = (state.incidents || []).find((item) => item.type === "hand" && item.gameId === state.currentGame?.id && item.player === player && Number(item.expiresAt) > nowMs());
        const countdown = penalty ? '<b class="suspension-badge">FORA · ' + clockText(Math.ceil((Number(penalty.expiresAt) - nowMs()) / 1000)) + '</b>' : "";
        return '<li>' + escapeHtml(displayName(player)) + (keeper(player) ? ' · Goleiro' : '') + (player === loan ? ' · emprestado' : '') + countdown + '</li>';
      }).join('') + '</ul></div>';
    }).join('');
  }
  function renderQueueControls() {
    const current = state.currentGame, pending = currentPending(), superMode = isSuperMode();
    const allTeams = modeTeams().map((team) => team.name);
    const homeSelect = $("matchHome"), awaySelect = $("matchAway");
    for (const [select, chosen, label] of [[homeSelect, current?.home || pending?.home, "Escolha o primeiro time"], [awaySelect, current?.away || pending?.away, "Escolha o segundo time"]]) {
      const selected = select.value;
      namesForSelect(select, allTeams, label, teamLabel);
      // Na Super Liga o confronto vem da tabela (o organizador pode trocar por outro jogo da tabela); no Modo Liga, da fila.
      const value = !current && !superMode && allTeams.includes(selected) ? selected : chosen;
      if (value && allTeams.includes(value)) select.value = value;
      else if (superMode) select.value = "";
      select.disabled = !!current || allTeams.length < 2;
    }
    const home = homeSelect.value, away = awaySelect.value;
    const matchPrepared = !!pending?.prepared && !current;
    $("preparedBtn").disabled = !!current || !pending || !home || !away || home === away || allTeams.length < 2;
    $("preparedBtn").setAttribute("aria-pressed", String(matchPrepared));
    $("preparedBtn").classList.toggle("is-on", matchPrepared);
    $("beginGame").disabled = !!current || !pending || !home || !away || home === away || allTeams.length < 2 || !matchPrepared;
    const mode = state.timerMode || "liga", duration = Math.min(180, Math.max(1, Number(state.durationMinutes) || 8));
    $("durationMinutes").value = String(duration);
    $("durationMinutes").disabled = !!current;
    // Na Super Liga os titulares por time são definidos no painel da Super Liga.
    $("onCourtLabel").hidden = true;
    $("onCourtCount").value = String(cocaOnCourtCount());
    $("onCourtCount").disabled = !!current;
    $("beginGame").textContent = "Começar jogo · " + clockText(duration * 60);
    const fixture = superMode ? superFixture(pending?.fixtureId) : null;
    $("nextMatchPreview").textContent = superMode
      ? fixture
        ? (fixture.stage === "final" ? (state.superLiga.teams.length === 2 ? "Super Liga · Jogo único: " : "Final da Super Liga: ") : fixture.stage === "amistoso" ? "Super Liga · Amistoso (conta para o ranking): " : "Super Liga · Rodada " + fixture.round + ": ") + teamLabel(fixture.home) + " × " + teamLabel(fixture.away)
        : "Monte a Super Liga e sorteie a ordem dos jogos no painel abaixo."
      : home && away && home !== away ? "Confronto escolhido: " + teamLabel(home) + " × " + teamLabel(away) : pending ? "Escolha dois times diferentes para preparar a partida." : "Sorteie os times para preparar a partida.";
    renderLoanControls();
    renderMatchPreview();
    renderKeeperChoices();
    renderStarterPicks();
  }
  function renderScoreGoalList(teamName, game) {
    if (!game) return "";
    return goals
      .filter((goal) => goal.game_id === game.id && scoreTeam(goal, game) === teamName)
      .map((goal) => {
        const player = escapeHtml(displayName(goal.player_name || "Jogador"));
        const minute = Math.max(0, Number(goal.minute) || 0);
        const ownGoal = goal.own_goal ? '<b class="own-goal-mark" aria-label="Gol contra" title="Gol contra">C</b>' : "";
        return '<span class="score-goal-item"><span class="score-goal-player">' + player + '</span><time>' + minute + '′</time>' + ownGoal + '</span>';
      })
      .join("");
  }
  function renderTimer() {
    const timer = state.timer || freshTimer(state.timerMode),
      mode = state.currentGame
        ? timer.mode || "liga"
        : state.timerMode || timer.mode || "liga",
      remaining = timerRemaining(timer),
      elapsed = timerElapsed(timer),
      activePause = isPauseActive(timer),
      used = pauseBudgetUsed({ ...timer, mode }),
      limit = mode === "coca" ? 120000 : 60000,
      pendingNow = currentPending(),
      home =
        state.currentGame?.home || pendingNow?.home || "Time Águia",
      away = state.currentGame?.away || pendingNow?.away || "Time Sol",
      hasGame = !!state.currentGame;
    const prepared = !hasGame && !!pendingNow?.prepared;
    const shootNow = shootoutOf(state.currentGame);
    $("currentMatchTitle").textContent = hasGame
      ? "JOGO " + gameNumber() + " · " + teamLabel(home) + " × " + teamLabel(away)
      : prepared
        ? "Partida preparada · " + teamLabel(home) + " × " + teamLabel(away)
        : "Partida em preparação";
    $("scoreHomeName").textContent = hasGame || prepared ? teamLabel(home) : "Time da casa";
    $("scoreAwayName").textContent = hasGame || prepared ? teamLabel(away) : "Time visitante";
    $("scoreHome").textContent = hasGame ? currentScore(home) : 0;
    $("scoreAway").textContent = hasGame ? currentScore(away) : 0;
    $("scoreHomeGoals").innerHTML = renderScoreGoalList(home, state.currentGame);
    $("scoreAwayGoals").innerHTML = renderScoreGoalList(away, state.currentGame);
    const idleSeconds = Math.min(180, Math.max(1, Number(state.durationMinutes) || 8)) * 60;
    $("timerDisplay").textContent = clockText(
      !hasGame ? idleSeconds : remaining,
    );
    let status = hasGame
      ? mode === "coca"
        ? "Modo Super Liga SKALAMA · partida em andamento"
        : "Modo Liga · partida em andamento"
      : prepared
        ? "Partida preparada. Toque em Começar jogo."
        : "A sequência é definida automaticamente pela fila.";
    if (hasGame && activePause)
      status = "Pausa · saldo " + clockText(Math.ceil((limit - used) / 1000));
    else if (hasGame && used >= limit && timer.pauseStartedAt)
      status = "Pausa acumulada esgotada · tempo retomado";
    else if (hasGame && remaining === 0)
      status = currentScore(home) === currentScore(away)
        ? "Tempo encerrado · empate: escolha Pênaltis ou Encerrar partida"
        : "Tempo encerrado · encerre o jogo para salvar o histórico";
    if (hasGame && shootNow && !shootNow.finished) {
      const sc = shootoutScores(shootNow, state.currentGame);
      status = "Disputa de pênaltis · " + teamLabel(home) + " " + sc.home + " × " + sc.away + " " + teamLabel(away);
    }
    $("timerStatus").textContent = status;
    $("pauseBudget").textContent =
      "Pausa acumulada: " +
      clockText(Math.ceil(used / 1000)) +
      " / " +
      (mode === "coca" ? "02:00" : "01:00");
    const running = !!timer.endsAt;
    $("pauseTimer").disabled =
      !hasGame ||
      remaining === 0 ||
      (!activePause && (!running || used >= limit));
    $("pauseTimer").textContent = activePause
      ? "Retomar agora"
      : "Pausar · saldo " +
        clockText(Math.floor(Math.max(0, limit - used) / 1000));
    $("finishGame").disabled = !hasGame || gameFinishing;
    const tied = hasGame && currentScore(home) === currentScore(away);
    const shoot = shootoutOf(state.currentGame);
    $("finishGame").textContent = tied ? "Encerrar partida (empate)" : "Encerrar jogo e salvar placar";
    $("openShootout").hidden = !tied;
    $("openShootout").disabled = gameFinishing;
    $("openShootout").textContent = shoot && !shoot.finished ? "Continuar pênaltis" : "Pênaltis";
    renderShootout();
    // Pênaltis só quando há exatamente um time esperando; nos outros empates o jogo encerra direto.
    $("tieBreakerLabel").classList.toggle(
      "hidden",
      true,
    );
    const choice = $("winnerChoice"),
      selected = choice.value,
      markup =
        '<option value="">Quem venceu nos pênaltis?</option><option value="' +
        escapeHtml(home) +
        '">' +
        escapeHtml(teamLabel(home)) +
        '</option><option value="' +
        escapeHtml(away) +
        '">' +
        escapeHtml(teamLabel(away)) +
        "</option>";
    if (choice.innerHTML !== markup) choice.innerHTML = markup;
    if (selected === home || selected === away) choice.value = selected;
    renderLive();
  }
  function renderGoalOptions() {
    const game = state.currentGame, teamSelect = $("goalTeam"), scorerSelect = $("goalScorer"), assistSelect = $("goalAssist");
    const currentTeam = teamSelect.value;
    namesForSelect(teamSelect, game ? [game.home, game.away] : [], game ? "Time que recebe o ponto" : "Comece um jogo primeiro", teamLabel);
    if (game) teamSelect.value = [game.home, game.away].includes(currentTeam) ? currentTeam : game.home;
    const scoringTeam = teamSelect.value, authorTeam = $("ownGoal").checked ? (scoringTeam === game?.home ? game.away : game?.home) : scoringTeam;
    const scorerNames = game ? lineupForTeam(authorTeam, game).filter((name) => !isPlayerSuspended(name, game)) : [];
    const previousScorer = scorerSelect.value;
    namesForSelect(scorerSelect, scorerNames, game ? "Escolha quem fez o gol" : "Comece um jogo primeiro");
    if (scorerNames.includes(previousScorer)) scorerSelect.value = previousScorer;
    $("ownGoal").disabled = !game;
    const assistNames = game && !$("ownGoal").checked ? lineupForTeam(scoringTeam, game).filter((name) => name !== scorerSelect.value && !isPlayerSuspended(name, game)) : [];
    const previousAssist = assistSelect.value;
    namesForSelect(assistSelect, assistNames, assistNames.length ? "Assistência (opcional)" : "Sem assistência");
    if (assistNames.includes(previousAssist)) assistSelect.value = previousAssist;
    const players = game ? [...lineupForTeam(game.home, game), ...lineupForTeam(game.away, game)] : [];
    namesForSelect($("incidentPlayer"), players, game ? "Escolha o jogador envolvido" : "Comece um jogo primeiro");
    const goalButton = $("addGoal");
    if (goalButton) goalButton.disabled = !game || !scorerSelect.value || goalSubmitting || isPlayerSuspended(scorerSelect.value, game);
    $("removeGoal").disabled = !game || !scorerSelect.value || !goals.some((g) => g.player_name === scorerSelect.value && g.game_id === game.id);
    $("openGoalDialog").disabled = !game;
    $("addIncident").disabled = !game || incidentSubmitting;
    renderSubstitutions();
  }
  function updateBeginGameAvailability() {
    const home = $("matchHome").value, away = $("matchAway").value, teams = modeTeams(), pending = currentPending();
    const validMatch = !state.currentGame && !!pending && home && away && home !== away && teams.some((team) => team.name === home) && teams.some((team) => team.name === away);
    const homePlayers = [...lineupForTeam(home)], awayPlayers = [...lineupForTeam(away)];
    const homeLoan = $("loanHomePlayer").value, awayLoan = $("loanAwayPlayer").value;
    if (homePlayers.length === 4 && homeLoan && !homePlayers.includes(homeLoan)) homePlayers.push(homeLoan);
    if (awayPlayers.length === 4 && awayLoan && !awayPlayers.includes(awayLoan)) awayPlayers.push(awayLoan);
    const keepersSelected = homePlayers.includes($("keeperHome").value) && awayPlayers.includes($("keeperAway").value);
    $("beginGame").disabled = !validMatch || !keepersSelected || !pending?.prepared;
    $("preparedBtn").disabled = !validMatch || !keepersSelected;
  }
  function renderKeeperChoices() {
    const game = state.currentGame;
    for (const [side, selectId, labelId] of [["home", "keeperHome", "keeperHomeLabel"], ["away", "keeperAway", "keeperAwayLabel"]]) {
      const select = $(selectId), label = $(labelId), teamName = game?.[side] || $(side === "home" ? "matchHome" : "matchAway").value || currentPending()?.[side];
      const players = game ? lineupForTeam(teamName, game) : [...lineupForTeam(teamName)];
      if (!game && players.length === 4) {
        const loan = $("loan" + side[0].toUpperCase() + side.slice(1) + "Player").value;
        if (loan && !players.includes(loan)) players.push(loan);
      }
      const preferred = players.find(keeper), current = game?.[side + "Keeper"];
      label.firstChild.textContent = "Goleiro · " + teamLabel(teamName || (side === "home" ? "Time 1" : "Time 2"));
      namesForSelect(select, players.filter((player) => !isPlayerSuspended(player, game)), players.length ? "Escolha quem vai para o gol" : "Escolha os times primeiro");
      const selected = current || (players.includes(select.value) ? select.value : preferred);
      if (selected && players.includes(selected) && !isPlayerSuspended(selected, game)) select.value = selected;
      select.disabled = !!game || !players.length;
    }
    updateBeginGameAvailability();
  }
  // ---------- Gol sofrido vai para quem estava no gol na hora ----------
  // Horário de uma troca: o próprio registro ou o item "sub" guardado em incidents (mesmo id).
  function subMoment(game, sub) {
    return sub.createdAt || (game.incidents || []).find((item) => item.id === sub.id)?.createdAt || null;
  }
  // Goleiros de um lado, em ordem: o titular e cada troca de goleiro (keeper: true ou saída de quem estava no gol).
  function keeperSpells(game, side) {
    const team = game[side];
    let current = game[side + "KeeperStart"] || game[side + "Keeper"] || null;
    const spells = current ? [{ player: current, minute: 0, at: null }] : [];
    (game.substitutions || [])
      .map((sub, index) => ({ sub, index }))
      .filter(({ sub }) => sub.team === team)
      .sort((a, b) => (Number(a.sub.minute) || 0) - (Number(b.sub.minute) || 0) || a.index - b.index)
      .forEach(({ sub }) => {
        if (sub.keeper || (current && sub.out === current)) {
          current = sub.keeperIn || sub.in;
          spells.push({ player: current, minute: Number(sub.minute) || 0, at: subMoment(game, sub), out: sub.out });
        }
      });
    return spells;
  }
  // Quem estava no gol quando saiu o gol. No mesmo minuto, compara os horários; sem horário, a troca vale antes do gol.
  function keeperAtGoal(spells, goal) {
    const minute = Number(goal.minute) || 0, at = goal.created_at || goal.createdAt || null;
    let current = spells[0]?.player || null;
    for (const spell of spells.slice(1)) {
      if (spell.minute < minute) current = spell.player;
      else if (spell.minute === minute && (!spell.at || !at || new Date(spell.at) <= new Date(at))) current = spell.player;
    }
    return current;
  }
  // Score individual com a regra nova: cada goleiro fica só com os gols sofridos enquanto estava no gol,
  // e quem foi para o gol em parte do jogo conta como goleiro naquele jogo. Os dados salvos não são alterados.
  const perfCache = new WeakMap();
  function gamePerformance(game) {
    if (!game) return [];
    const stored = game.performance || [];
    if (!stored.length) return stored;
    const cached = perfCache.get(game);
    if (cached) return cached;
    const assist = Math.max(0, Number(state?.scoreRules?.assist ?? SCORE_RULES.assist)),
      rows = stored.map((row) => ({ ...row }));
    for (const side of ["home", "away"]) {
      const team = game[side], other = game[side === "home" ? "away" : "home"], spells = keeperSpells(game, side);
      if (!spells.length) continue;
      const against = new Map(spells.map((spell) => [spell.player, 0]));
      for (const goal of game.goals || []) {
        if ((goal.scoringTeam || goal.team) !== other) continue;
        const who = keeperAtGoal(spells, goal);
        if (who) against.set(who, (against.get(who) || 0) + 1);
      }
      for (const row of rows) {
        if (row.team !== team || !against.has(row.player)) continue;
        const goalsAgainst = against.get(row.player);
        if (row.role === "goleiro" && Number(row.goalsAgainst) === goalsAgainst) continue;
        const delta = row.result === "vitória" ? 1.5 : row.result === "derrota" ? -1.5 : 0.5;
        row.role = "goleiro";
        row.goalsAgainst = goalsAgainst;
        row.score = Number(Math.max(0, Math.min(10, 7 + delta + (Number(row.goalsFor) || 0) + (Number(row.assists) || 0) * assist - 1.5 * Math.min(goalsAgainst, 2) - 2 * (Number(row.ownGoals) || 0))).toFixed(1));
      }
    }
    perfCache.set(game, rows);
    return rows;
  }
  function performanceForGame(game, homeScore, awayScore, gameGoals) {
    const stats = [], assistPoints = Math.max(0, Number(state.scoreRules?.assist ?? SCORE_RULES.assist));
    for (const team of [game.home, game.away].filter(Boolean).map((name) => ({ name }))) {
      const isHome = team.name === game.home, teamPlayers = [...new Set([...((isHome ? game.homeStart : game.awayStart) || []), ...lineupForTeam(team.name, game), ...(game.substitutions || []).filter((item) => item.team === team.name).map((item) => item.in)])], goalsFor = isHome ? homeScore : awayScore, goalsAgainst = isHome ? awayScore : homeScore;
      const result = goalsFor > goalsAgainst ? "vitória" : goalsFor < goalsAgainst ? "derrota" : "empate", delta = result === "vitória" ? 1.5 : result === "derrota" ? -1.5 : 0.5, goalie = isHome ? game.homeKeeper : game.awayKeeper;
      for (const player of teamPlayers) {
        const isKeeper = player === goalie || player === (isHome ? game.homeKeeperStart : game.awayKeeperStart), scored = gameGoals.filter((goal) => goal.player === player && !goal.ownGoal).length, ownGoals = gameGoals.filter((goal) => goal.player === player && goal.ownGoal).length, assists = gameGoals.filter((goal) => (goal.assistedBy || goal.assisted_by) === player).length;
        const score = Math.max(0, Math.min(10, 7 + delta + (isKeeper ? scored : Math.min(scored, 2)) + assists * assistPoints - (isKeeper ? 1.5 * Math.min(goalsAgainst, 2) : 0.5 * goalsAgainst) - 2 * ownGoals));
        stats.push({ player, team: team.name, role: isKeeper ? "goleiro" : "linha", score: Number(score.toFixed(1)), result, goalsFor: scored, assists, goalsAgainst, ownGoals });
      }
    }
    return stats;
  }
  function standingsForGames(games, teamMeta = new Map()) {
    const rows = new Map(), seen = new Set();
    const ensure = (name, label) => {
      if (!rows.has(name)) rows.set(name, { name, label: label || name, points: 0, wins: 0, draws: 0, losses: 0, played: 0, gf: 0, ga: 0 });
      else if (label) rows.get(name).label = label;
      return rows.get(name);
    };
    for (const game of games || []) {
      const identity = game.id || game.number + '|' + game.home + '|' + game.away + '|' + game.finishedAt;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const home = ensure(game.home, teamMeta.get(game.home) || gameTeamLabel(game, "home")), away = ensure(game.away, teamMeta.get(game.away) || gameTeamLabel(game, "away"));
      const hs = Number(game.homeScore) || 0, as = Number(game.awayScore) || 0;
      home.played++; away.played++; home.gf += hs; home.ga += as; away.gf += as; away.ga += hs;
      if (hs > as) { home.wins++; home.points += 3; away.losses++; }
      else if (as > hs) { away.wins++; away.points += 3; home.losses++; }
      else { home.draws++; away.draws++; home.points++; away.points++; }
    }
    return [...rows.values()].map((row) => ({ ...row, gd: row.gf - row.ga })).sort((a,b) => b.points-a.points || b.gd-a.gd || b.gf-a.gf || a.label.localeCompare(b.label,'pt-BR'));
  }
  function standingsTable(rows, emptyText) {
    if (!rows.length) return '<p class="empty-state">' + emptyText + '</p>';
    return '<div class="table-scroll"><table class="standings-table"><thead><tr><th>#</th><th>Time</th><th>Pts</th><th>V</th><th>E</th><th>D</th><th>J</th><th>SG</th></tr></thead><tbody>' + rows.map((row,index) => '<tr class="' + (index < 3 ? 'standings-top standings-top-' + (index+1) : '') + '"><td>' + (index+1) + '</td><th>' + escapeHtml(row.label) + '</th><td>' + row.points + '</td><td>' + row.wins + '</td><td>' + row.draws + '</td><td>' + row.losses + '</td><td>' + row.played + '</td><td>' + (row.gd > 0 ? '+' : '') + row.gd + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function renderStandings() {
    const roundId = state.roundId || state.currentGame?.roundId;
    const games = roundId ? (state.gameHistory || []).filter((game) => game.roundId === roundId) : [];
    const rows = standingsForGames(games, new Map((state.teams || []).map((team) => [team.name, teamLabel(team.name)])));
    $("roundStandings").innerHTML = standingsTable(rows, "A classificação será atualizada após a primeira partida concluída.");
  }
  function renderHistoricalStandings() {
    const host = $("pastRoundStandings");
    if (!host) return;
    const groups = new Map();
    for (const game of state.gameHistory || []) {
      const key = game.roundId || 'legacy-' + (game.matchDate || 'sem-data');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(game);
    }
    const entries = [...groups.entries()].reverse();
    host.innerHTML = entries.length ? entries.map(([key, games], index) => {
      const date = games.map((game) => game.matchDate).find(Boolean);
      const rows = standingsForGames(games);
      return '<details class="past-round hx-round"><summary><span>' + (date ? new Date(date + 'T12:00:00').toLocaleDateString('pt-BR') : 'Rodada anterior ' + (entries.length-index)) + ' · ' + games.length + (games.length === 1 ? ' partida' : ' partidas') + '</span>' + HX_CHEVRON + '</summary>' + standingsTable(rows, 'Sem resultados finalizados nesta rodada.') + '</details>';
    }).join('') : '<p class="empty-state">As classificações das rodadas anteriores aparecerão aqui.</p>';
  }
  // Rankings da Tela principal: só jogos do Modo Liga (a Super Liga tem os seus na própria aba).
  function ligaGames() {
    return (state.gameHistory || []).filter((game) => !game.superLigaId);
  }
  function renderScoreRankings() {
    const all = ligaGames().flatMap(
        (game) => gamePerformance(game),
      ),
      players = all.filter((p) => p.role === "linha"),
      keepers = all.filter((p) => p.role === "goleiro");
    function averageRows(rows) {
      const map = new Map();
      for (const p of rows) {
        let x = map.get(p.player);
        if (!x) map.set(p.player, (x = { sum: 0, games: 0, team: p.team }));
        x.sum += Number(p.score);
        x.games++;
        x.team = p.team;
      }
      return [...map.entries()]
        .map(([name, x]) => ({
          name,
          average: x.sum / x.games,
          games: x.games,
          team: x.team,
        }))
        .sort(
          (a, b) =>
            b.average - a.average || a.name.localeCompare(b.name, "pt-BR"),
        );
    }
    const paint = (id, rows, empty) =>
      ($(id).innerHTML = rows.length
        ? rows
            .slice(0, 11)
            .map(
              (r, i) =>
                '<div class="ranking-row' +
                (i < 3 ? " top-rank top-rank-" + (i + 1) : "") +
                '"><span class="rank">' +
                String(i + 1).padStart(2, "0") +
                "</span><span>" +
                escapeHtml(displayName(r.name)) +
                " <small>" +
                r.games +
                " " +
                (r.games === 1 ? "jogo" : "jogos") +
                "</small></span><strong>" +
                r.average.toFixed(1).replace(".", ",") +
                "</strong></div>",
            )
            .join("")
        : '<p class="empty-state">' + empty + "</p>");
    paint(
      "playerScoreRanking",
      averageRows(players),
      "O score aparece após os jogos.",
    );
    paint(
      "keeperRanking",
      averageRows(keepers),
      "O score aparece após os jogos.",
    );
    const conceded = new Map();
    for (const p of keepers) {
      const x = conceded.get(p.player) || { goals: 0, games: 0, team: p.team };
      x.goals += p.goalsAgainst;
      x.games++;
      conceded.set(p.player, x);
    }
    const rows = [...conceded.entries()]
      .map(([name, x]) => ({ name, ...x }))
      .sort(
        (a, b) => a.goals - b.goals || a.name.localeCompare(b.name, "pt-BR"),
      );
    $("keeperConcededRanking").innerHTML = rows.length
      ? rows
          .slice(0, 11)
          .map(
            (r, i) =>
              '<div class="ranking-row' +
              (i < 3 ? " top-rank top-rank-" + (i + 1) : "") +
              '"><span class="rank">' +
              String(i + 1).padStart(2, "0") +
              "</span><span>" +
              escapeHtml(displayName(r.name)) +
              " <small>" +
              r.games +
              " " +
              (r.games === 1 ? "jogo" : "jogos") +
              "</small></span><strong>" +
              r.goals +
              " " +
              (r.goals === 1 ? "gol" : "gols") +
              "</strong></div>",
          )
          .join("")
      : '<p class="empty-state">Os gols sofridos aparecem após os jogos.</p>';
  }
  function renderNightHighlights() {
    const roundId = state.roundId || state.currentGame?.roundId,
      games = roundId
        ? (state.gameHistory || []).filter((game) => game.roundId === roundId)
        : [];
    const status = $("nightHighlightsStatus");
    if (!roundId)
      status.textContent = state.teams?.length
        ? "Faça um novo sorteio para iniciar os destaques desta rodada."
        : "Os destaques começam após o sorteio e as partidas.";
    else
      status.textContent =
        games.length +
        " " +
        (games.length === 1 ? "partida concluída" : "partidas concluídas") +
        " nesta rodada.";
    const totals = new Map();
    for (const game of games)
      for (const player of gamePerformance(game)) {
        const role = player.role,
          key = role + "|" + player.player;
        let row = totals.get(key);
        if (!row)
          totals.set(
            key,
            (row = {
              player: player.player,
              role,
              sum: 0,
              games: 0,
              goals: 0,
              conceded: 0,
            }),
          );
        row.sum += Number(player.score) || 0;
        row.games++;
        row.goals += Number(player.goalsFor) || 0;
        row.conceded += Number(player.goalsAgainst) || 0;
      }
    const leaders = (role) => {
      const rows = [...totals.values()]
        .filter((row) => row.role === role && (role !== "goleiro" || row.games >= MIN_KEEPER_GAMES))
        .map((row) => ({ ...row, average: row.sum / row.games }))
        .sort(
          (a, b) =>
            b.average - a.average || a.player.localeCompare(b.player, "pt-BR"),
        );
      if (!rows.length) return null;
      const best = rows[0].average;
      return {
        rows: rows.filter((row) => Math.abs(row.average - best) < 0.0001),
        best,
      };
    };
    const player = leaders("linha"),
      goalie = leaders("goleiro");
    const paint = (result, nameId, statsId, type) => {
      if (!result) {
        const keeperShort = type === "keeper" && games.length && [...totals.values()].some((row) => row.role === "goleiro");
        $(nameId).textContent = keeperShort
          ? "Ainda sem goleiro elegível"
          : games.length
          ? "Sem dados individuais"
          : "Aguardando jogos";
        $(statsId).textContent = keeperShort
          ? "É preciso ter pelo menos " + MIN_KEEPER_GAMES + " jogos no gol para entrar no destaque."
          : games.length
          ? "Não há score registrado para esta posição."
          : "O score será calculado após as partidas.";
        return;
      }
      $(nameId).textContent = result.rows
        .map((row) => displayName(row.player))
        .join(" · ");
      const row = result.rows[0],
        score = row.average.toFixed(1).replace(".", ",");
      $(statsId).textContent =
        "Score médio " +
        score +
        " · " +
        row.games +
        " " +
        (row.games === 1 ? "jogo" : "jogos") +
        (type === "keeper"
          ? " · " + row.conceded + (row.conceded === 1 ? " gol sofrido" : " gols sofridos")
          : " · " + row.goals + (row.goals === 1 ? " gol" : " gols"));
    };
    paint(player, "nightPlayerLeader", "nightPlayerStats", "player");
    paint(goalie, "nightKeeperLeader", "nightKeeperStats", "keeper");
  }
  function renderSeasonHighlights() {
    const now = new Date(),
      monthKey =
        now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    $("seasonMonth").textContent = now.toLocaleDateString("pt-BR", {
      month: "long",
      year: "numeric",
    });
    const games = ligaGames().filter((game) => {
      const date = new Date(game.finishedAt);
      return (
        Number.isFinite(date.getTime()) &&
        date.getFullYear() +
          "-" +
          String(date.getMonth() + 1).padStart(2, "0") ===
          monthKey
      );
    });
    const goalsByPlayer = new Map(),
      scores = new Map();
    for (const game of games) {
      (game.goals || [])
        .filter((goal) => !goal.ownGoal)
        .forEach((goal) =>
          goalsByPlayer.set(
            goal.player,
            (goalsByPlayer.get(goal.player) || 0) + 1,
          ),
        );
      gamePerformance(game).forEach((p) => {
        const key = p.role + "|" + p.player,
          entry = scores.get(key) || {
            player: p.player,
            role: p.role,
            sum: 0,
            games: 0,
            conceded: 0,
          };
        entry.sum += Number(p.score) || 0;
        entry.games++;
        entry.conceded += Number(p.goalsAgainst) || 0;
        scores.set(key, entry);
      });
    }
    const goalRows = [...goalsByPlayer.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"),
    );
    const scoreRows = [...scores.values()].map((row) => ({
        ...row,
        average: row.sum / row.games,
      })),
      lineRows = scoreRows
        .filter((row) => row.role === "linha")
        .sort(
          (a, b) =>
            b.average - a.average || a.player.localeCompare(b.player, "pt-BR"),
        ),
      keeperRows = scoreRows
        .filter((row) => row.role === "goleiro" && row.games >= MIN_KEEPER_GAMES)
        .sort(
          (a, b) =>
            b.average - a.average || a.player.localeCompare(b.player, "pt-BR"),
        );
    const goalLeaders = goalRows.length
      ? goalRows
          .filter((row) => row[1] === goalRows[0][1])
          .map((row) => escapeHtml(displayName(row[0])))
          .join(" · ")
      : "—";
    const scoreLeaders = (rows) =>
      rows.length
        ? rows
            .filter((row) => row.average === rows[0].average)
            .map((row) => escapeHtml(displayName(row.player)))
            .join(" · ")
        : "—";
    const scorerValue = goalRows.length
      ? goalRows[0][1] + " " + (goalRows[0][1] === 1 ? "gol" : "gols")
      : "Sem gols no mês";
    const lineValue = lineRows.length
      ? lineRows[0].average.toFixed(1).replace(".", ",") +
        " · " +
        lineRows[0].games +
        " " +
        (lineRows[0].games === 1 ? "jogo" : "jogos")
      : "Sem score registrado";
    const keeperValue = keeperRows.length
      ? keeperRows[0].average.toFixed(1).replace(".", ",") +
        " · " +
        keeperRows[0].games +
        " " +
        (keeperRows[0].games === 1 ? "jogo" : "jogos")
      : "Nenhum goleiro com " + MIN_KEEPER_GAMES + " jogos ou mais";
    $("seasonHighlights").innerHTML = games.length
      ? '<article class="season-highlight-card season-scorer"><span class="season-kicker">ARTILHEIRO DO MÊS</span><strong>' +
        goalLeaders +
        "</strong><small>" +
        scorerValue +
        '</small></article><article class="season-highlight-card season-line"><span class="season-kicker">DESTAQUE DE LINHA · SCORE MÉDIO</span><strong>' +
        scoreLeaders(lineRows) +
        "</strong><small>" +
        lineValue +
        '</small></article><article class="season-highlight-card season-keeper"><span class="season-kicker">GOLEIRO DO MÊS · SCORE MÉDIO</span><strong>' +
        scoreLeaders(keeperRows) +
        "</strong><small>" +
        keeperValue +
        (keeperRows.length
          ? " · " + keeperRows[0].conceded + (keeperRows[0].conceded === 1 ? " gol sofrido" : " gols sofridos")
          : "") +
        "</small></article>"
      : '<p class="empty-state season-empty">Ainda não há partidas finalizadas neste mês.</p>';
  }
  // Função pela maioria dos jogos; quem alternou mostra quantos jogos fez na outra posição.
  function roleSummary(row) {
    const keeper = row.keeperGames || 0, line = row.games - keeper;
    if (!keeper) return "linha";
    if (!line) return "goleiro";
    return keeper > line ? "goleiro · " + line + " na linha" : "linha · " + keeper + " no gol";
  }
  function renderIndividualStats() {
    const totals = new Map();
    const games = [...(state.gameHistory || [])].sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
    for (const game of games) for (const p of gamePerformance(game)) {
      const row = totals.get(p.player) || { player: p.player, role: p.role, keeperGames: 0, score: 0, games: 0, goals: 0, assists: 0, goalsAgainst: 0, wins: 0, draws: 0, losses: 0 };
      if (p.role === "goleiro") row.keeperGames++;
      row.score += Number(p.score) || 0; row.games++; row.goals += Number(p.goalsFor) || 0; row.assists += Number(p.assists) || 0; row.goalsAgainst += Number(p.goalsAgainst) || 0;
      if (p.result === "vitória") row.wins++; else if (p.result === "empate") row.draws++; else row.losses++;
      // Time do jogo mais recente do jogador.
      row.teamKey = p.team; row.teamLabel = teamName(game, p.team);
      totals.set(p.player, row);
    }
    const rows = [...totals.values()].map((row) => ({ ...row, avg: row.score / row.games })).sort((a, b) => b.avg - a.avg || a.player.localeCompare(b.player, "pt-BR"));
    if (!rows.length) { $("individualStats").innerHTML = '<p class="empty-state">As estatísticas individuais aparecem após as partidas finalizadas.</p>'; return; }
    const best = (field) => { const max = Math.max(...rows.map((row) => Number(row[field].toFixed ? row[field].toFixed(1) : row[field]))); return max > 0 ? max : null; },
      topAvg = best("avg"), topGoals = best("goals"), topAssists = best("assists"),
      lead = (value, top) => (top !== null && Number(value.toFixed ? value.toFixed(1) : value) === top ? " is-lead" : ""),
      roleText = (row) => { const r = roleSummary(row); return r.charAt(0).toUpperCase() + r.slice(1); };
    $("individualStats").innerHTML = '<table class="hx-stats"><thead><tr><th scope="col">Jogador</th><th scope="col">Jogos</th><th scope="col">Score médio</th><th scope="col">Gols</th><th scope="col">Assist.</th><th scope="col">Sofridos</th><th scope="col"><abbr title="Vitórias · Empates · Derrotas">V · E · D</abbr></th></tr></thead><tbody>' +
      rows.map((row) => {
        const isKeeper = row.keeperGames > row.games - row.keeperGames;
        return '<tr><th scope="row"><span class="hx-player">' + hxCrest(row.teamKey, row.teamLabel, "sm") + '<span class="hx-pinfo"><strong>' + escapeHtml(displayName(row.player)) + (isKeeper ? ' <b class="hx-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</strong><small>" + escapeHtml((row.teamLabel || "") + " · " + roleText(row)) + "</small></span></span></th>" +
          '<td class="hx-n">' + row.games + '</td><td class="hx-n' + lead(row.avg, topAvg) + '">' + row.avg.toFixed(1).replace(".", ",") + '</td><td class="hx-n' + lead(row.goals, topGoals) + '">' + row.goals + '</td><td class="hx-n' + lead(row.assists, topAssists) + '">' + row.assists + '</td><td class="hx-n">' + row.goalsAgainst + "</td>" +
          '<td><span class="hx-ved" aria-label="' + row.wins + " vitórias, " + row.draws + " empates, " + row.losses + ' derrotas"><i class="v">' + row.wins + '</i><i class="e">' + row.draws + '</i><i class="d">' + row.losses + "</i></span></td></tr>";
      }).join("") + "</tbody></table>";
  }
  // " · nos pênaltis (4 × 3)" quando o jogo terminou empatado e foi decidido nos pênaltis.
  function penaltySummary(game) {
    if (game.winner === "Empate" || Number(game.homeScore) !== Number(game.awayScore)) return "";
    const shoot = game.shootout && (game.shootout.kicks || []).length ? game.shootout : null;
    if (!shoot) return " · nos pênaltis";
    const winnerHome = game.winner === game.home;
    return " · nos pênaltis (" + (winnerHome ? shoot.homeScore : shoot.awayScore) + " × " + (winnerHome ? shoot.awayScore : shoot.homeScore) + ")";
  }
  function weekStart(date) {
    const result = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      ),
      offset = (result.getDay() + 6) % 7;
    result.setDate(result.getDate() - offset);
    return result;
  }
  function renderWeeklyPublications() {
    const weeks = new Map();
    for (const game of state.gameHistory || []) {
      const date = new Date(game.finishedAt);
      if (!Number.isFinite(date.getTime())) continue;
      const monday = weekStart(date),
        key = monday.toISOString().slice(0, 10);
      if (!weeks.has(key)) weeks.set(key, { monday, games: [] });
      weeks.get(key).games.push(game);
    }
    const items = [...weeks.values()]
      .sort((a, b) => b.monday - a.monday)
      .slice(0, 8);
    $("weeklyPublications").innerHTML = items.length
      ? items
          .map(
            (week) =>
              '<article class="weekly-publication"><header><strong>SEMANA DE ' +
              week.monday.toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "short",
              }) +
              "</strong><span>" +
              week.games.length +
              " " +
              (week.games.length === 1 ? "partida" : "partidas") +
              "</span></header><div>" +
              week.games
                .sort((a, b) => new Date(a.finishedAt) - new Date(b.finishedAt))
                .map(
                  (game) =>
                    "<p><span>" +
                    escapeHtml(gameTeamLabel(game, "home")) +
                    " <b>" +
                    game.homeScore +
                    " × " +
                    game.awayScore +
                    "</b> " +
                    escapeHtml(gameTeamLabel(game, "away")) +
                    "</span><small>" +
                    (game.winner === "Empate"
                      ? "Empate"
                      : "Vencedor: " + escapeHtml(historyWinner(game)) + penaltySummary(game)) +
                    "</small></p>",
                )
                .join("") +
              "</div></article>",
          )
          .join("")
      : '<p class="empty-state">Ainda não há partidas arquivadas para compor as publicações semanais.</p>';
  }
  // ---------- Aba Histórico ----------
  const historyOpenGames = new Set(), historyOpenPanels = new Set();
  const HX_BALL = '<svg class="hx-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="m12 7.2 3.4 2.5-1.3 4h-4.2l-1.3-4Z"/><path d="M12 7.2V3M15.4 9.7l4-1.4M14.1 13.7l2.5 3.4M9.9 13.7l-2.5 3.4M8.6 9.7l-4-1.4" stroke="currentColor" stroke-width="1.6"/></svg>',
    HX_SWAP = '<svg class="hx-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M7 4v13m0 0-3.5-3.5M7 17l3.5-3.5M17 20V7m0 0-3.5 3.5M17 7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    HX_CHEVRON = '<svg class="hx-chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function hxCrest(key, label, size) {
    const src = crestFor(key, label),
      initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return '<span class="hx-crest hx-crest-' + size + (src ? "" : " hx-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
  }
  function hxTime(value) {
    const date = typeof value === "number" || /^\d+$/.test(String(value || "")) ? new Date(Number(value)) : new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
  }
  function hxClock(date) {
    return date ? date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  }
  function hxDayKey(game) {
    const date = hxTime(game.finishedAt);
    return date ? date.toLocaleDateString("pt-BR") : "sem-data";
  }
  function hxDayLabel(game) {
    const date = game.matchDate ? new Date(game.matchDate + "T12:00:00") : hxTime(game.finishedAt);
    if (!date || !Number.isFinite(date.getTime())) return "";
    const weekday = date.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0];
    return weekday.charAt(0).toUpperCase() + weekday.slice(1) + ", " + date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }
  // Jogo que decide a Super Liga daquele jogo (o primeiro com stage "final").
  function hxIsTitleGame(game) {
    if (!game.superLigaId || game.stage !== "final") return false;
    const finals = (state.gameHistory || []).filter((item) => item.superLigaId === game.superLigaId && item.stage === "final").sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
    return finals[0]?.id === game.id;
  }
  // Lances do jogo: gols e substituições juntos, por minuto e, no mesmo minuto, pela ordem em que foram registrados.
  function hxEvents(game) {
    const sideOf = (team) => (team === game.home ? "home" : team === game.away ? "away" : null),
      spells = { home: keeperSpells(game, "home"), away: keeperSpells(game, "away") },
      items = [];
    (game.goals || []).forEach((goal, index) => items.push({ kind: "goal", side: sideOf(goal.scoringTeam || goal.team) || "home", minute: Number(goal.minute) || 0, at: goal.created_at || goal.createdAt || null, index, goal }));
    (game.substitutions || []).forEach((sub, index) => items.push({ kind: "sub", side: sideOf(sub.team) || "home", minute: Number(sub.minute) || 0, at: subMoment(game, sub), index: 1000 + index, sub }));
    items.sort((a, b) => a.minute - b.minute || (a.at && b.at ? new Date(a.at) - new Date(b.at) : 0) || a.index - b.index);
    // Vários gols do mesmo jogador no mesmo minuto viram uma linha só.
    const merged = [];
    for (const item of items) {
      const last = merged[merged.length - 1];
      if (item.kind === "goal" && last?.kind === "goal" && last.minute === item.minute && last.side === item.side && last.goal.player === item.goal.player && !!last.goal.ownGoal === !!item.goal.ownGoal) {
        last.count = (last.count || 1) + 1;
        if (item.goal.assistedBy) last.assists = [...new Set([...(last.assists || []), item.goal.assistedBy])];
        continue;
      }
      merged.push({ ...item, count: 1, assists: item.kind === "goal" && item.goal.assistedBy ? [item.goal.assistedBy] : [] });
    }
    return merged.map((item) => {
      if (item.kind === "goal") {
        const goal = item.goal, times = item.count > 1 ? " ×" + item.count + (item.count === 3 ? " · hat-trick" : "") : "";
        return { ...item, html: '<span class="hx-ev hx-ev-goal">' + HX_BALL + '<span><span class="sr-only">Gol: </span><strong>' + escapeHtml(displayName(goal.player || "Gol")) + escapeHtml(times) + "</strong>" + (goal.ownGoal ? ' <em class="hx-own">contra</em>' : "") + (item.assists.length ? '<small>assist. ' + item.assists.map((name) => escapeHtml(displayName(name))).join(", ") + "</small>" : "") + "</span></span>" };
      }
      const sub = item.sub, sideSpells = spells[item.side], goalie = sub.keeperIn || sub.in, toGoal = sub.keeper || sideSpells.some((spell) => spell.player === goalie && spell.minute === (Number(sub.minute) || 0) && spell.out === sub.out),
        wasKeeper = toGoal && sideSpells.some((spell) => spell.player === goalie && spell.minute < (Number(sub.minute) || 0)),
        goalText = toGoal ? (wasKeeper ? " volta pro gol" : " vai pro gol") : "",
        inText = displayName(sub.in) + (goalie === sub.in ? goalText : "");
      return { ...item, html: '<span class="hx-ev hx-ev-sub">' + HX_SWAP + '<span><span class="sr-only">Substituição: </span><strong class="hx-in"><span aria-hidden="true">↑ </span><span class="sr-only">entra </span>' + escapeHtml(inText) + '</strong><strong class="hx-out"><span aria-hidden="true">↓ </span><span class="sr-only">sai </span>' + escapeHtml(displayName(sub.out)) + "</strong>" + (goalie !== sub.in && toGoal ? "<small><b class=\"hx-g\" title=\"Goleiro\" aria-label=\"Goleiro\">G</b> " + escapeHtml(displayName(goalie)) + goalText + "</small>" : "") + "</span></span>" };
    });
  }
  function hxPanel(game, key, title, html) {
    const id = "hx-" + game.id + "-" + key, open = historyOpenPanels.has(id);
    return { button: '<button type="button" class="hx-pbtn" data-hx-panel="' + id + '" aria-expanded="' + open + '" aria-controls="' + id + '">' + title + HX_CHEVRON + "</button>", panel: '<div class="hx-panel" id="' + id + '" role="region" aria-label="' + escapeHtml(title) + '"' + (open ? "" : " hidden") + '><h4 class="hx-panel-title">' + title + "</h4>" + html + "</div>" };
  }
  function hxGameCard(game) {
    const home = gameTeamLabel(game, "home"), away = gameTeamLabel(game, "away"),
      hs = Number(game.homeScore) || 0, as = Number(game.awayScore) || 0,
      winSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null,
      title = hxIsTitleGame(game), friendly = game.stage === "amistoso",
      competition = game.superLigaId || game.timerMode === "coca" ? "Super Liga" : "Modo Liga",
      tag = title ? '<span class="hx-tag hx-tag-final">FINAL · VALE O TÍTULO</span>'
        : friendly ? '<span class="hx-tag hx-tag-line">AMISTOSO · CONTA PARA O RANKING</span>'
        : game.superLigaId && game.stage === "group" ? '<span class="hx-tag hx-tag-line">RODADA ' + escapeHtml(String(game.round || "")) + "</span>"
        : game.superLigaId && game.stage === "final" ? '<span class="hx-tag hx-tag-line">FINAL</span>'
        : '<span class="hx-tag hx-tag-line">' + (game.superLigaId ? "SUPER LIGA" : "MODO LIGA") + "</span>",
      start = hxTime(game.startedAt), end = hxTime(game.finishedAt),
      minutes = game.durationSeconds ? Math.round(game.durationSeconds / 60) : game.durationMinutes || null,
      timeText = [start && end ? hxClock(start) + " – " + hxClock(end) : hxClock(end), minutes ? minutes + " min" : ""].filter(Boolean).join(" · "),
      winnerName = winSide ? gameTeamLabel(game, winSide) : "",
      result = !winSide ? "Empate"
        : title ? "🏆 " + winnerName + " campeão da Super Liga"
        : hs === as && shoot ? winnerName + " venceu nos pênaltis (" + shoot[winSide + "Score"] + " × " + shoot[(winSide === "home" ? "away" : "home") + "Score"] + ")"
        : "Vencedor: " + winnerName,
      goalsCount = (game.goals || []).length, subsCount = (game.substitutions || []).length,
      openText = "Ver lance a lance · " + goalsCount + (goalsCount === 1 ? " gol" : " gols") + " · " + subsCount + (subsCount === 1 ? " troca" : " trocas"),
      team = (side, key, label) => '<span class="hx-team hx-' + side + (winSide && winSide !== side ? " is-lose" : "") + '">' + hxCrest(key, label, "lg") + '<span class="hx-tname">' + escapeHtml(label) + "</span></span>",
      num = (side, value) => '<b class="' + (winSide === side ? "is-win" : winSide ? "is-lose" : "") + '">' + value + "</b>";
    const events = hxEvents(game),
      timeline = events.length
        ? '<ol class="hx-timeline">' + events.map((item) => '<li class="hx-row"><span class="hx-cell hx-left">' + (item.side === "home" ? item.html : "") + '</span><span class="hx-min">' + item.minute + '′</span><span class="hx-cell hx-right">' + (item.side === "away" ? item.html : "") + "</span></li>").join("") + "</ol>"
        : '<p class="empty-state">Sem gols nem substituições registrados.</p>';
    // Conteúdo que já existia: escalações e goleiros, score individual e advertências.
    const keeperLine = (side) => {
      const spells = keeperSpells(game, side);
      if (!spells.length) return "não registrado";
      return spells.map((spell, index) => displayName(spell.player) + (spells.length > 1 ? " (" + spell.minute + "′–" + (spells[index + 1] ? spells[index + 1].minute + "′" : "fim") + ")" : "")).join(" · ");
    };
    const roster = (side) => {
      const players = [...new Set([...(game[side + "Start"] || []), ...(game[side + "Players"] || []), ...(game[side + "Bench"] || [])])];
      return '<div class="hx-lineup"><p><strong>' + escapeHtml(gameTeamLabel(game, side)) + "</strong></p><p class=\"hx-keepers\">Goleiro: " + escapeHtml(keeperLine(side)) + '</p><ul>' + players.map((name) => "<li>" + escapeHtml(displayName(name)) + ((game.loans || []).some((loan) => loan.player === name) ? " · emprestado" : "") + "</li>").join("") + "</ul></div>";
    };
    const perf = gamePerformance(game),
      scoreRows = perf.length
        ? '<ul class="hx-score-list">' + [...perf].sort((a, b) => Number(b.score) - Number(a.score)).map((p) => '<li><span><strong>' + escapeHtml(displayName(p.player)) + "</strong><small>" + escapeHtml(teamName(game, p.team) + " · " + (p.role === "goleiro" ? "goleiro · sofreu " + p.goalsAgainst : "linha") + " · " + p.result + (Number(p.goalsFor) ? " · " + p.goalsFor + (Number(p.goalsFor) === 1 ? " gol" : " gols") : "") + (Number(p.assists) ? " · " + p.assists + " assist." : "") + (Number(p.ownGoals) ? " · " + p.ownGoals + " contra" : "")) + "</small></span><b>" + Number(p.score).toFixed(1).replace(".", ",") + "</b></li>").join("") + "</ul>"
        : '<p class="empty-state">Sem score individual registrado.</p>',
      warnings = (game.incidents || []).filter((item) => item.type !== "sub" && (!item.gameId || item.gameId === game.id)),
      warningRows = warnings.length
        ? '<ul class="hx-warn-list">' + warnings.map((item) => "<li><span>" + escapeHtml(item.type === "warning" ? item.warningType || "Advertência" : incidentLabels[item.type] || item.type) + " · " + escapeHtml(displayName(item.player || "")) + (item.note ? ' <small>' + escapeHtml(item.note) + "</small>" : "") + "</span><b>" + (Number(item.minute) || 0) + "′</b></li>").join("") + "</ul>"
        : '<p class="empty-state">Sem advertências ou ocorrências registradas.</p>',
      shootRows = shoot && (shoot.kicks || []).length ? '<ul class="hx-warn-list">' + shoot.kicks.map((kick, index) => "<li><span>" + (index + 1) + ". " + escapeHtml(teamName(game, kick.team)) + " · " + escapeHtml(kick.player ? displayName(kick.player) : "Batedor não identificado") + "</span><b>" + (kick.scored ? "✓ Gol" : "✗ Errou") + "</b></li>").join("") + "</ul>" : "",
      panels = [hxPanel(game, "lineups", "Escalações e goleiros", '<div class="hx-lineups">' + roster("home") + roster("away") + "</div>"), hxPanel(game, "score", "Score individual", scoreRows), hxPanel(game, "warnings", "Advertências", warningRows), ...(shootRows ? [hxPanel(game, "shootout", "Pênaltis", shootRows)] : [])];
    return '<details class="hx-game' + (title ? " is-final" : "") + '" data-hx-game="' + escapeHtml(game.id) + '"' + (historyOpenGames.has(game.id) ? " open" : "") + "><summary>" +
      '<span class="hx-strip"><b class="hx-num">JOGO ' + game.number + '</b><span class="hx-comp">' + competition + "</span>" + tag + (timeText ? '<span class="hx-time">' + escapeHtml(timeText) + "</span>" : "") + "</span>" +
      '<span class="hx-board">' + team("home", game.home, home) + '<span class="hx-score" aria-label="' + escapeHtml(home + " " + hs + " a " + as + " " + away) + '">' + num("home", hs) + '<i aria-hidden="true">×</i>' + num("away", as) + "</span>" + team("away", game.away, away) + "</span>" +
      '<span class="hx-result">' + escapeHtml(result) + "</span>" +
      '<span class="hx-toggle"><span class="hx-when-closed">' + escapeHtml(openText) + '</span><span class="hx-when-open">Minimizar</span>' + HX_CHEVRON + "</span></summary>" +
      '<div class="hx-body"><p class="hx-legend"><span>' + HX_BALL + 'gol</span><span>' + HX_SWAP + 'substituição: <b class="hx-in">↑ entra</b> <b class="hx-out">↓ sai</b></span></p>' +
      '<h3 class="hx-body-title">LANCE A LANCE</h3>' + timeline +
      '<div class="hx-pbtns">' + panels.map((item) => item.button).join("") + "</div>" + panels.map((item) => item.panel).join("") + "</div></details>";
  }
  function teamName(game, key) {
    return key === game.home ? gameTeamLabel(game, "home") : key === game.away ? gameTeamLabel(game, "away") : teamLabel(key);
  }
  function bindHistory() {
    const list = $("gameHistory");
    list.addEventListener("toggle", (event) => {
      const id = event.target.dataset?.hxGame;
      if (id) { if (event.target.open) historyOpenGames.add(id); else historyOpenGames.delete(id); list.dataset.markup = ""; }
    }, true);
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-hx-panel]");
      if (!button) return;
      const id = button.dataset.hxPanel, panel = document.getElementById(id), open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      if (panel) panel.hidden = !open;
      if (open) historyOpenPanels.add(id); else historyOpenPanels.delete(id);
      list.dataset.markup = "";
    });
    // Atalhos do topo: levam à seção e acendem conforme a rolagem.
    const links = [...document.querySelectorAll("[data-hx-link]")];
    const mark = (id) => links.forEach((link) => { if (link.dataset.hxLink === id) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current"); });
    links.forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = document.getElementById(link.dataset.hxLink);
      if (!target) return;
      mark(link.dataset.hxLink);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      link.scrollIntoView({ block: "nearest", inline: "nearest" });
    }));
    let ticking = false;
    window.addEventListener("scroll", () => {
      if (ticking || $("historico")?.classList.contains("view-hidden")) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        let current = links[0]?.dataset.hxLink;
        for (const link of links) { const section = document.getElementById(link.dataset.hxLink); if (section && section.getBoundingClientRect().top <= 160) current = link.dataset.hxLink; }
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = links[links.length - 1]?.dataset.hxLink;
        mark(current);
      });
    }, { passive: true });
  }
  function renderHistory() {
    const list = $("gameHistory"),
      history = [...(state.gameHistory || [])].sort((a, b) => (hxTime(b.finishedAt)?.getTime() || 0) - (hxTime(a.finishedAt)?.getTime() || 0)),
      night = $("historyNight");
    if (!history.length) {
      if (night) night.textContent = "";
      list.innerHTML = '<p class="empty-state">Nenhum jogo encerrado ainda.</p>';
      return;
    }
    const groups = [];
    for (const game of history) {
      const key = hxDayKey(game), last = groups[groups.length - 1];
      if (last && last.key === key) last.games.push(game);
      else groups.push({ key, games: [game] });
    }
    const summary = (games) => [hxDayLabel(games[0]), String(games[0].venue || state.venue || "").trim(), games.length + (games.length === 1 ? " jogo" : " jogos")].filter(Boolean).join(" · ");
    if (night) night.textContent = summary(groups[0].games) + " · toque no jogo para abrir";
    const markup = groups.map((group, index) => (index ? '<h3 class="hx-day">' + escapeHtml(summary(group.games)) + "</h3>" : "") + group.games.map(hxGameCard).join("")).join("");
    if (list.dataset.markup !== markup) { list.dataset.markup = markup; list.innerHTML = markup; }
  }
  function renderGoals() {
    const totals = new Map(),
      superGameIds = new Set([
        ...(state.gameHistory || []).filter((game) => game.superLigaId).map((game) => game.id),
        ...(state.currentGame?.superLigaId ? [state.currentGame.id] : []),
      ]);
    goals
      .filter((goal) => !goal.own_goal && !superGameIds.has(goal.game_id))
      .forEach((goal) =>
        totals.set(goal.player_name, (totals.get(goal.player_name) || 0) + 1),
      );
    const ranking = [...totals.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"),
    );
    $("goalRanking").innerHTML = ranking.length
      ? ranking
          .slice(0, 11)
          .map(([name, count], index) => {
            const past = ligaGames().filter(
              (game) =>
                gamePerformance(game).some((p) => p.player === name) ||
                (!gamePerformance(game).length &&
                  (game.goals || []).some((g) => g.player === name)),
            ).length;
            const teams = selectedTeams(),
              current =
                state.currentGame &&
                !state.currentGame.superLigaId &&
                [
                  ...(teams.home?.players || []),
                  ...(teams.away?.players || []),
                ].includes(name)
                  ? 1
                  : 0,
              played = past + current;
            return (
              '<div class="ranking-row' +
              (index < 3 ? " top-rank top-rank-" + (index + 1) : "") +
              '"><span class="rank">' +
              String(index + 1).padStart(2, "0") +
              "</span><span>" +
              escapeHtml(displayName(name)) +
              " <small>" +
              played +
              " " +
              (played === 1 ? "jogo" : "jogos") +
              "</small></span><strong>" +
              count +
              " " +
              (count === 1 ? "gol" : "gols") +
              "</strong></div>"
            );
          })
          .join("")
      : '<p class="empty-state">Nenhum gol registrado.</p>';
  }
  const incidentLabels = { foul: "Falta", penalty: "Pênalti", hand: "Mão intencional · 1 minuto fora", keeper: "Bola recuada para o goleiro", other: "Outra ocorrência", warning: "Advertência", sub: "Substituição" };
  function renderIncidents() {
    const list = $("incidentList"), entries = state.incidents || [];
    if (!entries.length) { suspensionSignature = ""; list.innerHTML = '<p class="empty-state">Nenhuma ocorrência registrada nesta partida.</p>'; return; }
    list.innerHTML = [...entries].filter((item) => !state.currentGame || !item.gameId || item.gameId === state.currentGame.id).reverse().map((item) => {
      const active = item.type === "hand" && item.gameId === state.currentGame?.id && Number(item.expiresAt) > nowMs();
      const left = active ? Math.ceil((Number(item.expiresAt) - nowMs()) / 1000) : 0;
      const status = item.type === "hand" ? active ? "Retorno em " + clockText(left) : "Liberado para retornar" : "Registrado";
      const label = item.type === "warning" ? (item.warningType || "Advertência") : (incidentLabels[item.type] || item.type);
      const time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : "—";
      return '<article class="incident-row"><div><strong>' + escapeHtml(label) + " · " + escapeHtml(displayName(item.player || "Sem jogador associado")) + '</strong><small>' + escapeHtml(item.note || "Minuto " + (item.minute || 0)) + " · " + time + '</small></div><span class="incident-status ' + (item.type === "hand" && !active ? "done" : "") + '">' + status + '</span></article>';
    }).join("");
    if (state.currentGame && (state.incidents || []).some((item) => item.type === "hand" && item.gameId === state.currentGame.id)) renderMatchPreview();
    const suspended = (state.incidents || []).filter((item) => item.type === "hand" && item.gameId === state.currentGame?.id && Number(item.expiresAt) > nowMs()).map((item) => item.player).sort().join("|");
    if (suspended !== suspensionSignature) { suspensionSignature = suspended; renderGoalOptions(); renderKeeperChoices(); }
  }
  async function addIncident() {
    if (incidentSubmitting) return;
    const selectedType = $("incidentType").value, player = $("incidentPlayer").value, game = state.currentGame;
    const warningTypes = { warning_verbal: "Advertência verbal", warning_yellow: "Cartão amarelo", warning_red: "Cartão vermelho" };
    const type = warningTypes[selectedType] ? "warning" : selectedType;
    if (!game || !player || ![...(game.homePlayers || []), ...(game.awayPlayers || [])].includes(player)) { notify("Escolha um jogador da partida em andamento.", true); return; }
    const item = { id: crypto.randomUUID(), gameId: game.id, minute: Math.max(1, Math.ceil(timerElapsed()/60)), type, player, note: $("incidentNote").value.trim(), createdAt: new Date().toISOString(), expiresAt: type === "hand" ? nowMs() + 60000 : null };
    if (type === "warning") item.warningType = warningTypes[selectedType];
    incidentSubmitting = true; $("addIncident").disabled = true;
    try {
      const saved = await saveState({ incidents: [...(state.incidents || []), item] }, type === "hand" ? displayName(player) + " ficará fora por 1 minuto." : type === "warning" ? item.warningType + " registrada." : "Ocorrência registrada no minuto " + item.minute + ".");
      if (saved) $("incidentNote").value = "";
    } finally { incidentSubmitting = false; renderGoalOptions(); }
  }

  // ---------- Painel da Super Liga ----------
  function superStandings(sl = state.superLiga, history = state.gameHistory || []) {
    if (!sl) return [];
    const ids = new Set((sl.fixtures || []).filter((fixture) => fixture.stage === "group" && fixture.gameId).map((fixture) => fixture.gameId));
    const rows = standingsForGames(history.filter((game) => ids.has(game.id)), new Map(sl.teams.map((team) => [team.key, team.name])));
    for (const team of sl.teams)
      if (!rows.some((row) => row.name === team.key))
        rows.push({ name: team.key, label: team.name, points: 0, wins: 0, draws: 0, losses: 0, played: 0, gf: 0, ga: 0, gd: 0 });
    return rows
      .map((row) => ({ ...row, label: superTeam(row.name)?.name || row.label }))
      .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.label.localeCompare(b.label, "pt-BR"));
  }
  // Depois de cada jogo: marca o jogo na tabela, cria a final quando todos se enfrentaram e define o campeão.
  function superAfterGame(sl, game, entry, history) {
    let fixtures = sl.fixtures.map((fixture) => (fixture.id === game.fixtureId ? { ...fixture, gameId: entry.id } : fixture)),
      status = sl.status,
      champion = sl.champion || null;
    if (game.stage === "amistoso") {
      // Amistoso: só entra nos rankings; campeão e situação da Super Liga continuam iguais.
    } else if (game.stage === "final") {
      status = "finished";
      champion = entry.winner;
    } else if (!fixtures.some((fixture) => fixture.stage === "group" && !fixture.gameId) && !fixtures.some((fixture) => fixture.stage === "final")) {
      const table = superStandings({ ...sl, fixtures }, history);
      if (table.length >= 2) fixtures = [...fixtures, { id: crypto.randomUUID(), stage: "final", round: null, home: table[0].name, away: table[1].name, gameId: null }];
    }
    return { ...sl, fixtures, status, champion, pending: null };
  }
  // Todos contra todos (método do círculo), com ordem das rodadas, dos jogos e do mando sorteados.
  function superRoundRobin(keys) {
    const list = randomize(keys);
    if (list.length % 2) list.push(null);
    const n = list.length,
      rounds = [];
    let ring = [...list];
    for (let r = 0; r < n - 1; r++) {
      const games = [];
      for (let i = 0; i < n / 2; i++) {
        const a = ring[i], b = ring[n - 1 - i];
        if (a && b) games.push(randomize([a, b]));
      }
      rounds.push(games);
      ring = [ring[0], ring[n - 1], ...ring.slice(1, n - 1)];
    }
    const fixtures = [];
    let last = [];
    randomize(rounds).forEach((games, index) => {
      // Evita, quando dá, que um time jogue duas vezes seguidas na virada da rodada.
      const ordered = randomize(games).sort((x, y) => x.some((team) => last.includes(team)) - y.some((team) => last.includes(team)));
      ordered.forEach(([home, away]) => fixtures.push({ id: crypto.randomUUID(), stage: "group", round: index + 1, home, away, gameId: null }));
      last = ordered.length ? ordered[ordered.length - 1] : last;
    });
    return fixtures;
  }
  function superFreeColor(teams) {
    const used = new Set(teams.map((team) => team.color));
    const free = SUPER_COLORS.findIndex((_, index) => !used.has(index));
    return free < 0 ? 0 : free;
  }
  function superNewTeam(teams) {
    return { key: "sl-" + crypto.randomUUID().slice(0, 8), name: "Time " + (teams.length + 1), color: superFreeColor(teams), players: [], starters: [] };
  }
  function saveSuper(changes, message) {
    return saveState({ superLiga: { ...state.superLiga, ...changes } }, message);
  }
  function superTeamsWith(key, change) {
    return state.superLiga.teams.map((team) => (team.key === key ? { ...team, ...change(team) } : team));
  }
  function superTeamBusy(key) {
    return !!state.currentGame && [state.currentGame.home, state.currentGame.away].includes(key);
  }
  async function superCreate() {
    const count = Math.min(SUPER_MAX_TEAMS, Math.max(SUPER_MIN_TEAMS, Number($("slTeamCount")?.value) || 4)),
      starters = Math.min(9, Math.max(4, Number($("slStarters")?.value) || 5)),
      teams = [];
    while (teams.length < count) teams.push(superNewTeam(teams));
    await saveState(
      { superLiga: { id: crypto.randomUUID(), status: "setup", starters, teams, fixtures: [], pending: null, champion: null, createdAt: new Date().toISOString() }, timerMode: "coca" },
      "Super Liga criada com " + count + " times. Agora dê nome aos times e adicione os jogadores.",
    );
  }
  async function superSetCount(value) {
    const sl = state.superLiga;
    if (!sl || sl.status !== "setup") return;
    const count = Math.min(SUPER_MAX_TEAMS, Math.max(SUPER_MIN_TEAMS, Number(value) || sl.teams.length));
    let teams = [...sl.teams];
    if (count < teams.length) {
      const removed = teams.slice(count).filter((team) => team.players.length);
      if (removed.length && !(await askConfirm({ title: "Remover times?", message: "Remover " + removed.map((team) => team.name).join(", ") + "? Os jogadores desses times saem da Super Liga.", confirmText: "Remover", tone: "red" }))) { superMarkup = ""; renderSuperLiga(); return; }
      teams = teams.slice(0, count);
    }
    while (teams.length < count) teams.push(superNewTeam(teams));
    await saveSuper({ teams }, "Super Liga com " + count + " times.");
  }
  async function superSetStarters(value) {
    const sl = state.superLiga;
    if (!sl || sl.status !== "setup") return;
    const starters = Math.min(9, Math.max(4, Number(value) || sl.starters));
    await saveSuper({ starters, teams: sl.teams.map((team) => ({ ...team, starters: team.starters.slice(0, starters) })) }, starters + " titulares por time.");
  }
  async function superAddPlayer(key, raw) {
    const sl = state.superLiga, team = superTeam(key);
    if (!sl || !team) return;
    if (superTeamBusy(key)) { notify(team.name + " está jogando agora. Adicione jogadores depois da partida.", true); return; }
    let name;
    try { name = normalizePlayer(raw); } catch (error) { notify(error.message, true); return; }
    if (name.length > 50) { notify("O nome pode ter no máximo 50 caracteres.", true); return; }
    if (sl.teams.some((item) => item.players.some((player) => playerKey(player) === playerKey(name)))) { notify("Já existe um jogador com esse nome na Super Liga.", true); return; }
    if (team.players.length >= SUPER_MAX_PLAYERS) { notify(team.name + " já tem " + SUPER_MAX_PLAYERS + " jogadores.", true); return; }
    const starter = team.starters.length < sl.starters;
    await saveSuper(
      { teams: superTeamsWith(key, (item) => ({ players: [...item.players, name], starters: starter ? [...item.starters, name] : item.starters })) },
      displayName(name) + " entrou no " + team.name + " como " + (starter ? "titular" : "reserva") + ".",
    );
  }
  async function superToggleRole(key, index) {
    const sl = state.superLiga, team = superTeam(key), player = team?.players[index];
    if (!player) return;
    if (superTeamBusy(key)) { notify(team.name + " está jogando agora.", true); return; }
    const isStarter = team.starters.includes(player);
    if (!isStarter && team.starters.length >= sl.starters) { notify(team.name + " já tem " + sl.starters + " titulares. Passe um titular para reserva antes.", true); return; }
    await saveSuper(
      { teams: superTeamsWith(key, (item) => ({ starters: isStarter ? item.starters.filter((name) => name !== player) : [...item.starters, player] })) },
      displayName(player) + (isStarter ? " agora é reserva." : " agora é titular."),
    );
  }
  async function superRemovePlayer(key, index) {
    const team = superTeam(key), player = team?.players[index];
    if (!player) return;
    if (superTeamBusy(key)) { notify(team.name + " está jogando agora.", true); return; }
    await saveSuper(
      { teams: superTeamsWith(key, (item) => ({ players: item.players.filter((name) => name !== player), starters: item.starters.filter((name) => name !== player) })) },
      displayName(player) + " saiu do " + team.name + ".",
    );
  }
  async function superRename(key, value) {
    const team = superTeam(key), name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 30);
    if (!team || name === team.name) return;
    if (!name) { notify("O time precisa de um nome.", true); superMarkup = ""; renderSuperLiga(); return; }
    if (state.superLiga.teams.some((item) => item.key !== key && item.name.toLocaleLowerCase("pt-BR") === name.toLocaleLowerCase("pt-BR"))) { notify("Já existe um time com esse nome.", true); superMarkup = ""; renderSuperLiga(); return; }
    await saveSuper({ teams: superTeamsWith(key, () => ({ name })) }, team.name + " agora se chama " + name + ".");
  }
  async function superSetColor(key, value) {
    const team = superTeam(key), color = Number(value);
    if (!team || !SUPER_COLORS[color] || color === team.color) return;
    // Se outro time já usa a cor, os dois trocam.
    const other = state.superLiga.teams.find((item) => item.key !== key && item.color === color);
    await saveSuper({ teams: state.superLiga.teams.map((item) => (item.key === key ? { ...item, color } : other && item.key === other.key ? { ...item, color: team.color } : item)) }, team.name + " agora é " + SUPER_COLORS[color].name.toLowerCase() + ".");
  }
  async function superDraw() {
    const sl = state.superLiga;
    if (!sl || sl.status !== "setup") return;
    const names = new Set();
    for (const team of sl.teams) {
      const key = team.name.trim().toLocaleLowerCase("pt-BR");
      if (!key || names.has(key)) { notify("Cada time precisa de um nome diferente.", true); return; }
      names.add(key);
      if (team.starters.length !== sl.starters) { notify(team.name + " precisa de " + sl.starters + " titulares (tem " + team.starters.length + ").", true); return; }
    }
    // Com 2 times é jogo único: quem vencer é o campeão (empate vai para os pênaltis).
    const single = sl.teams.length === 2,
      fixtures = single
        ? [(([home, away]) => ({ id: crypto.randomUUID(), stage: "final", round: null, home, away, gameId: null }))(randomize(sl.teams.map((team) => team.key)))]
        : superRoundRobin(sl.teams.map((team) => team.key)),
      first = fixtures[0];
    await saveState(
      { superLiga: { ...sl, status: "running", fixtures, pending: null, champion: null }, timerMode: "coca" },
      single
        ? "Jogo único: " + teamLabel(first.home) + " × " + teamLabel(first.away) + ". Quem vencer é o campeão."
        : "Ordem dos jogos sorteada: " + fixtures.length + " jogos e depois a final. Primeiro jogo: " + teamLabel(first.home) + " × " + teamLabel(first.away) + ".",
    );
  }
  async function superPlay(fixtureId) {
    const fixture = superFixture(fixtureId);
    if (!fixture || fixture.gameId || state.currentGame) return;
    const saved = await saveSuper({ pending: { fixtureId, prepared: false } }, "Próximo jogo: " + teamLabel(fixture.home) + " × " + teamLabel(fixture.away) + ". Prepare a partida acima.");
    if (saved) $("jogo").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // Troca o confronto pelos seletores de Preparar partida: vale qualquer jogo da tabela que ainda não foi disputado.
  async function superChooseTeams(changedSide) {
    const sl = state.superLiga;
    let home = $("matchHome").value, away = $("matchAway").value;
    // Amistoso: vale qualquer par de times.
    const friendly = superOpenFriendly(sl);
    if (friendly && !state.currentGame) {
      if (!home || !away || home === away) { notify("Escolha dois times diferentes para o amistoso.", true); renderQueueControls(); return; }
      await saveState({ superLiga: { ...sl, fixtures: sl.fixtures.map((item) => (item.id === friendly.id ? { ...item, home, away } : item)), pending: { fixtureId: friendly.id, prepared: false } } }, "Amistoso: " + teamLabel(home) + " × " + teamLabel(away) + ".");
      return;
    }
    if (!sl || sl.status !== "running" || state.currentGame) { renderQueueControls(); return; }
    const open = (sl.fixtures || []).filter((fixture) => !fixture.gameId),
      finalOpen = open.find((fixture) => fixture.stage === "final"),
      pool = finalOpen ? [finalOpen] : open,
      find = (a, b) => pool.find((fixture) => (fixture.home === a && fixture.away === b) || (fixture.home === b && fixture.away === a));
    // Escolher num lado o time que estava no outro inverte o mando do mesmo jogo.
    const before = currentPending();
    if (home && home === away && before) {
      if (changedSide === "home") away = before.home;
      else home = before.away;
    }
    let fixture = home && away && home !== away ? find(home, away) : null;
    // Ao trocar o time da casa, procura um adversário que ele ainda não enfrentou.
    if (!fixture && changedSide === "home" && home) {
      fixture = pool.find((item) => item.home === home || item.away === home) || null;
      if (fixture) away = fixture.home === home ? fixture.away : fixture.home;
    }
    if (!fixture) {
      const message = !home || !away
        ? "Escolha os dois times."
        : home === away
          ? "Escolha dois times diferentes."
          : finalOpen
            ? "Agora só falta a final: " + teamLabel(finalOpen.home) + " × " + teamLabel(finalOpen.away) + "."
            : teamLabel(home) + (open.some((item) => item.home === home || item.away === home) ? " e " + teamLabel(away) + " já se enfrentaram nesta Super Liga." : " já fez todos os seus jogos nesta Super Liga.");
      notify(message, true);
      renderQueueControls();
      renderKeeperChoices();
      return;
    }
    const fixtures = sl.fixtures.map((item) => (item.id === fixture.id ? { ...item, home, away } : item));
    await saveState(
      { superLiga: { ...sl, fixtures, pending: { fixtureId: fixture.id, prepared: false } } },
      "Próximo jogo: " + teamLabel(home) + " × " + teamLabel(away) + (fixture.stage === "group" ? " (rodada " + fixture.round + ")." : "."),
    );
  }
  // Novo jogo numa Super Liga que já teve final: amistoso (conta para o ranking, não muda o campeão).
  async function superFriendly() {
    const sl = state.superLiga;
    if (!sl || sl.status !== "finished" || state.currentGame || superOpenFriendly(sl)) return;
    const final = superFinalGame(sl), [home, away] = final ? [final.home, final.away] : sl.teams.map((team) => team.key);
    const fixture = { id: crypto.randomUUID(), stage: "amistoso", round: null, home, away, gameId: null };
    const saved = await saveState({ superLiga: { ...sl, fixtures: [...(sl.fixtures || []), fixture], pending: { fixtureId: fixture.id, prepared: false } }, timerMode: "coca" }, "Amistoso: " + teamLabel(home) + " × " + teamLabel(away) + ". Conta para o ranking e não muda o campeão. Prepare a partida acima.");
    if (saved) $("jogo").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function superFriendlyCancel() {
    const sl = state.superLiga, open = superOpenFriendly(sl);
    if (!open || state.currentGame) return;
    await saveState({ superLiga: { ...sl, fixtures: sl.fixtures.filter((item) => item.id !== open.id), pending: null } }, "Amistoso cancelado.");
  }
  async function superRestart() {
    const sl = state.superLiga;
    if (!sl) return;
    if (state.currentGame?.superLigaId) { notify("Encerre a partida em andamento antes de começar uma nova Super Liga.", true); return; }
    if (!(await askConfirm({ title: "Nova Super Liga?", message: "Começar uma nova Super Liga? A tabela de jogos e a classificação atuais são apagadas. Os times, os jogadores e os rankings da Super Liga continuam, e os jogos já disputados ficam no Histórico.", confirmText: "Começar nova Super Liga", tone: "red" }))) return;
    if (state.currentGame?.superLigaId || state.superLiga?.id !== sl.id) return;
    await saveState({ superLiga: { ...sl, id: crypto.randomUUID(), status: "setup", fixtures: [], pending: null, champion: null, createdAt: new Date().toISOString() } }, "Nova Super Liga: ajuste os times e sorteie a ordem dos jogos.");
  }
  function superChip(key) {
    const color = colorOf(key);
    return '<i class="sl-chip" style="--team-color:' + color.color + '" aria-hidden="true"></i>';
  }
  function superFixtureRow(fixture, next, locked) {
    const game = fixture.gameId ? (state.gameHistory || []).find((item) => item.id === fixture.gameId) : null,
      live = state.currentGame?.fixtureId === fixture.id,
      isNext = !game && !live && next?.id === fixture.id,
      shoot = game?.shootout && Number.isFinite(game.shootout.homeScore) ? " · pên. " + game.shootout.homeScore + "×" + game.shootout.awayScore : "",
      score = game ? game.homeScore + " × " + game.awayScore : live ? currentScore(fixture.home) + " × " + currentScore(fixture.away) : "×",
      stateText = game ? "Encerrado" + shoot : live ? "Ao vivo" : isNext ? "Próximo" : "",
      canPlay = !locked && !game && !live && !isNext && !state.currentGame;
    return '<li class="sl-fixture' + (game ? " is-done" : "") + (live ? " is-live" : "") + (isNext ? " is-next" : "") + '">' +
      '<span class="sl-side sl-home">' + superChip(fixture.home) + escapeHtml(teamLabel(fixture.home)) + "</span>" +
      '<b class="sl-score">' + score + "</b>" +
      '<span class="sl-side sl-away">' + escapeHtml(teamLabel(fixture.away)) + superChip(fixture.away) + "</span>" +
      '<span class="sl-state">' + stateText + (canPlay ? '<button type="button" class="text-button" data-sl-play="' + escapeHtml(fixture.id) + '">Jogar agora</button>' : "") + "</span></li>";
  }
  // As 4 primeiras cores da Super Liga usam o mesmo cabeçalho dos times fixos do Elenco.
  function superHead(team) {
    const fixed = [EL_HEAD["Time Águia"], EL_HEAD["Time Sol"], EL_HEAD["Time Verde"], EL_HEAD["Time Azul"]][team.color], color = SUPER_COLORS[team.color];
    return fixed || (color ? [color.color, color.ink] : ["#0d0d0d", "#ffffff"]);
  }
  function superTeamCard(team, sl, editable) {
    // Jogadores já cadastrados no Elenco que ainda não estão em nenhum time da Super Liga.
    const available = (state.roster || []).filter((name) => !sl.teams.some((item) => item.players.some((player) => playerKey(player) === playerKey(name)))),
      color = colorOf(team.key),
      players = team.players.map((player, index) => {
        const starter = team.starters.includes(player);
        return '<li><span class="sl-player">' + escapeHtml(displayName(player)) + (keeper(player) ? ' <b class="keeper-mark" title="Goleiro">G</b>' : "") + "</span>" +
          (editable
            ? '<button type="button" class="sl-role' + (starter ? " is-starter" : "") + '" data-sl-role="' + escapeHtml(team.key) + '" data-sl-index="' + index + '" aria-label="' + escapeHtml(displayName(player)) + ": " + (starter ? "titular, tocar para passar a reserva" : "reserva, tocar para passar a titular") + '">' + (starter ? "Titular" : "Reserva") + '</button><button type="button" class="text-button sl-remove" data-sl-remove="' + escapeHtml(team.key) + '" data-sl-index="' + index + '" aria-label="Remover ' + escapeHtml(displayName(player)) + '">Remover</button>'
            : '<small class="sl-role-text">' + (starter ? "Titular" : "Reserva") + "</small>") +
          "</li>";
      }).join("");
    const reserves = team.players.length - team.starters.length;
    return '<article class="sl-team" style="--team-color:' + color.color + ";--team-ink:" + color.ink + '"><header class="sl-team-head">' +
      (editable
        ? '<input class="sl-team-name" data-sl-name="' + escapeHtml(team.key) + '" data-focus-key="name-' + escapeHtml(team.key) + '" maxlength="30" value="' + escapeHtml(team.name) + '" aria-label="Nome do time">' +
          '<select class="sl-team-color" data-sl-color="' + escapeHtml(team.key) + '" aria-label="Cor do ' + escapeHtml(team.name) + '">' + SUPER_COLORS.map((item, index) => '<option value="' + index + '"' + (index === team.color ? " selected" : "") + ">" + item.name + "</option>").join("") + "</select>"
        : "<strong>" + escapeHtml(team.name) + "</strong>") +
      '</header><ol class="sl-players">' + (players || '<li class="sl-empty">Nenhum jogador ainda.</li>') + "</ol>" +
      (editable && available.length
        ? '<label class="sl-pick"><select data-sl-pick="' + escapeHtml(team.key) + '" aria-label="Escolher jogador do Elenco para o ' + escapeHtml(team.name) + '"><option value="">+ Jogador do Elenco…</option>' + available.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + (keeper(name) ? " · goleiro" : "") + "</option>").join("") + "</select></label>"
        : "") +
      (editable
        ? '<form class="sl-add" data-sl-add="' + escapeHtml(team.key) + '"><input data-focus-key="add-' + escapeHtml(team.key) + '" maxlength="50" placeholder="Ou digite um nome novo (* = goleiro)" aria-label="Adicionar jogador ao ' + escapeHtml(team.name) + '"><button type="submit" class="button button-primary button-small">Adicionar</button></form>'
        : "") +
      '<small class="sl-count' + (team.starters.length === sl.starters ? "" : " is-short") + '">' + team.starters.length + "/" + sl.starters + " titulares · " + reserves + (reserves === 1 ? " reserva" : " reservas") + "</small></article>";
  }
  // Rankings só da Super Liga atual (fase de todos contra todos e final).
  function superRankingRow(index, name, detail, value) {
    return '<div class="ranking-row' + (index < 3 ? " top-rank top-rank-" + (index + 1) : "") + '"><span class="rank">' + String(index + 1).padStart(2, "0") + "</span><span>" + escapeHtml(displayName(name)) + " <small>" + escapeHtml(detail) + "</small></span><strong>" + value + "</strong></div>";
  }
  function superRankingData() {
    const games = (state.gameHistory || []).filter((game) => game.superLigaId),
      plural = (n, one, many) => n + " " + (n === 1 ? one : many),
      teamOf = (key) => superTeam(key)?.name || teamLabel(key);
    const scorers = new Map();
    for (const game of games)
      for (const goal of game.goals || []) {
        if (goal.ownGoal || !goal.player) continue;
        const row = scorers.get(goal.player) || { goals: 0, team: goal.team };
        row.goals++;
        row.team = goal.team || row.team;
        scorers.set(goal.player, row);
      }
    const average = (role) => {
      const map = new Map();
      for (const game of games)
        for (const p of gamePerformance(game)) {
          if (p.role !== role) continue;
          const row = map.get(p.player) || { sum: 0, games: 0, against: 0, team: p.team };
          row.sum += Number(p.score) || 0;
          row.games++;
          row.against += Number(p.goalsAgainst) || 0;
          row.team = p.team;
          map.set(p.player, row);
        }
      return [...map.entries()].map(([name, row]) => ({ name, ...row, average: row.sum / row.games }));
    };
    const scorerRows = [...scorers.entries()].map(([name, row]) => ({ name, ...row })).sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "pt-BR")).slice(0, 10),
      keeperRows = average("goleiro").sort((a, b) => b.average - a.average || a.against - b.against || a.name.localeCompare(b.name, "pt-BR")).slice(0, 10),
      playerRows = average("linha").sort((a, b) => b.average - a.average || a.name.localeCompare(b.name, "pt-BR")).slice(0, 10);
    return { scorerRows, keeperRows, playerRows, teamOf, plural };
  }
  function superRankings(sl) {
    const { scorerRows, keeperRows, playerRows, teamOf, plural } = superRankingData(),
      empty = '<p class="empty-state">Aparece depois do primeiro jogo da Super Liga.</p>',
      score = (value) => value.toFixed(1).replace(".", ",");
    return '<div class="sl-rankings-head"><h3>Rankings da Super Liga</h3><p class="help-text">Somam todas as Super Ligas já disputadas. Não zeram com "Nova Super Liga".</p></div><div class="sl-rankings">' +
      '<div class="sl-block"><h3>Artilheiros</h3>' + (scorerRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team), plural(r.goals, "gol", "gols"))).join("") || empty) + "</div>" +
      '<div class="sl-block"><h3>Melhores goleiros</h3>' + (keeperRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team) + " · " + plural(r.games, "jogo", "jogos") + " · " + plural(r.against, "gol sofrido", "gols sofridos"), score(r.average))).join("") || empty) + "</div>" +
      '<div class="sl-block"><h3>Score dos jogadores</h3>' + (playerRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team) + " · " + plural(r.games, "jogo", "jogos"), score(r.average))).join("") || empty) + "</div>" +
      "</div>";
  }
  // ---------- Super Liga encerrada: campeão em destaque ----------
  // O título é decidido pelo primeiro jogo com stage "final" desta Super Liga (nunca pelo último jogo disputado).
  function superFinalGame(sl = state.superLiga) {
    if (!sl) return null;
    const history = state.gameHistory || [],
      finals = history.filter((game) => game.superLigaId === sl.id && game.stage === "final").sort((a, b) => new Date(a.finishedAt || 0) - new Date(b.finishedAt || 0));
    if (finals[0]) return finals[0];
    const fixture = (sl.fixtures || []).find((item) => item.stage === "final" && item.gameId);
    return (fixture && history.find((game) => game.id === fixture.gameId)) || null;
  }
  function slxCrest(key, size) {
    const label = teamLabel(key), src = crestFor(key, label),
      initials = label.replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return '<span class="slx-crest slx-crest-' + size + (src ? "" : " slx-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
  }
  // Escalação no apito inicial: titulares (Start) e reservas (Bench), desfazendo as substituições.
  function slxLineup(game, side) {
    const team = game[side],
      start = [...(game[side + "Start"] || game[side + "Players"] || [])],
      subs = (game.substitutions || []).filter((item) => item.team === team).sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0)),
      entered = [...new Set(subs.map((item) => item.in).filter((name) => name && !start.includes(name)))],
      bench = [...entered, ...(game[side + "Bench"] || []).filter((name) => !start.includes(name) && !entered.includes(name))],
      keeperName = game[side + "KeeperStart"] || game[side + "Keeper"] || start.find(keeper) || null,
      events = (name) => subs.flatMap((item) => [
        ...(item.out === name ? [{ kind: "out", minute: item.minute }] : []),
        ...(item.in === name ? [{ kind: "in", minute: item.minute }] : []),
      ]),
      played = [...start, ...entered];
    return { team, start, bench, subs, keeperName, events, played };
  }
  function slxMinute(value) {
    return (Number(value) || 0) + "′";
  }
  function slxGoalList(game, key) {
    const goals = (game.goals || []).filter((goal) => (goal.scoringTeam || goal.team) === key).sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0));
    return goals.length
      ? goals.map((goal) => "<li><b>" + slxMinute(goal.minute) + "</b> " + escapeHtml(displayName(goal.player || "Gol")) + (goal.ownGoal ? " <small>(contra)</small>" : "") + "</li>").join("")
      : '<li class="slx-nogoal">Sem gols</li>';
  }
  function slxPlayerRow(name, role, lineup) {
    const isKeeper = name === lineup.keeperName || keeper(name),
      marks = lineup.events(name).map((item) => item.kind === "out"
        ? '<span class="slx-ev slx-ev-out">↓ saiu ' + slxMinute(item.minute) + "</span>"
        : '<span class="slx-ev slx-ev-in">↑ entrou ' + slxMinute(item.minute) + "</span>").join("");
    return '<li><span class="slx-pname">' + escapeHtml(displayName(name)) + (isKeeper ? ' <b class="slx-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</span>" + marks +
      '<span class="slx-role ' + (role === "titular" ? "is-tit" : "is-res") + '">' + (role === "titular" ? "TITULAR" : "RESERVA") + "</span></li>";
  }
  function slxTeamCard(game, side, isChampion) {
    const lineup = slxLineup(game, side), key = game[side],
      subsText = lineup.subs.length
        ? lineup.subs.length + (lineup.subs.length === 1 ? " substituição" : " substituições") + " (" + lineup.subs.map((item) => slxMinute(item.minute) + ": sai " + displayName(item.out) + ", entra " + displayName(item.in)).join("; ") + ")"
        : "sem substituições";
    return '<article class="slx-team' + (isChampion ? " is-champ" : "") + '"><header>' + slxCrest(key, "sm") + "<strong>" + escapeHtml(teamLabel(key)) + "</strong>" +
      '<span class="slx-badge">' + (isChampion ? "CAMPEÃO" : "VICE") + "</span></header>" +
      '<p class="slx-sec">TITULARES</p><ul class="slx-plist">' + lineup.start.map((name) => slxPlayerRow(name, "titular", lineup)).join("") + "</ul>" +
      (lineup.bench.length ? '<p class="slx-sec">RESERVAS</p><ul class="slx-plist">' + lineup.bench.map((name) => slxPlayerRow(name, "reserva", lineup)).join("") + "</ul>" : "") +
      '<footer>' + lineup.start.length + (lineup.start.length === 1 ? " titular" : " titulares") + " · " + lineup.bench.length + (lineup.bench.length === 1 ? " reserva" : " reservas") + " · " + escapeHtml(subsText) + "</footer></article>";
  }
  function slxRankCard(title, rows, detail, value) {
    if (!rows.length) return '<article class="slx-rank-card"><h4>' + title + '</h4><p class="empty-state">Aparece depois do primeiro jogo da Super Liga.</p></article>';
    return '<article class="slx-rank-card"><h4>' + title + '</h4><ol class="slx-rank-list">' + rows.map((row, index) =>
      '<li class="slx-rank-' + (index < 3 ? index + 1 : "n") + '"><span class="slx-pos">' + (index + 1) + '</span><span class="slx-who"><strong>' + escapeHtml(displayName(row.name)) + "</strong><small>" + escapeHtml(detail(row)) + '</small></span><b class="slx-val">' + value(row) + "</b></li>").join("") + "</ol></article>";
  }
  function slxDateText(game) {
    const date = game.matchDate ? new Date(game.matchDate + "T12:00:00") : new Date(game.finishedAt || 0);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";
  }
  function renderSuperFinished(sl, locked, note = "") {
    const final = superFinalGame(sl),
      champion = final ? (final.winner === final.home || final.winner === final.away ? final.winner : sl.champion) : sl.champion,
      single = sl.teams.length === 2;
    let html = '<div class="slx-top"><div><p class="eyebrow">MODO SUPER LIGA</p><h2 id="slTitle" class="slx-title">SUPER LIGA SKALAMA</h2></div><span class="slx-status"><i aria-hidden="true"></i>Encerrada</span></div>' + note;
    if (champion) {
      const champSide = final ? (final.home === champion ? "home" : "away") : null,
        oppSide = champSide === "home" ? "away" : "home",
        shoot = final?.shootout && Number.isFinite(final.shootout.homeScore) ? final.shootout : null,
        cs = final ? Number(final[champSide + "Score"]) || 0 : 0, os = final ? Number(final[oppSide + "Score"]) || 0 : 0,
        place = String(final?.venue || state.venue || "").trim(),
        how = final ? (shoot ? "Venceu a final nos pênaltis (" + shoot[champSide + "Score"] + " a " + shoot[oppSide + "Score"] + ") após " + cs + " a " + os : "Venceu a final por " + cs + " a " + os) : "",
        sub = [how, final ? slxDateText(final) : "", place].filter(Boolean).join(" · ");
      html += '<section class="slx-champ" aria-labelledby="slxChampName"><div class="slx-champ-row"><div class="slx-champ-main">' +
        '<div class="slx-champ-crest">' + slxCrest(champion, "xl") + '<span class="slx-trophy" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" focusable="false"><path fill="currentColor" d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V17h3v3H8v-3h3v-2.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V5h3V3Zm0 4H6v1a2 2 0 0 0 1 1.7V7Zm10 0v2.7A2 2 0 0 0 18 8V7h-1Z"/></svg></span></div>' +
        '<div class="slx-champ-text"><p class="slx-kicker">CAMPEÃO DA SUPER LIGA</p><h3 id="slxChampName" class="slx-champ-name">' + escapeHtml(teamLabel(champion)) + "</h3>" + (sub ? '<p class="slx-champ-sub">' + escapeHtml(sub) + "</p>" : "") + "</div></div>";
      if (final) {
        html += '<div class="slx-final"><p class="slx-final-tag">' + (single ? "FINAL · JOGO ÚNICO" : "FINAL") + "</p>" +
          '<div class="slx-board" role="img" aria-label="' + escapeHtml("Final: " + teamLabel(final[champSide]) + " " + cs + " a " + os + " " + teamLabel(final[oppSide])) + '">' +
          '<div class="slx-bteam">' + slxCrest(final[champSide], "md") + "<span>" + escapeHtml(teamLabel(final[champSide])) + "</span></div>" +
          '<div class="slx-bscore"><b class="is-win">' + cs + '</b><i aria-hidden="true">×</i><b class="is-lose">' + os + "</b>" + (shoot ? "<small>Pênaltis " + shoot[champSide + "Score"] + " × " + shoot[oppSide + "Score"] + "</small>" : "") + "</div>" +
          '<div class="slx-bteam">' + slxCrest(final[oppSide], "md") + "<span>" + escapeHtml(teamLabel(final[oppSide])) + "</span></div></div>" +
          '<div class="slx-fgoals"><ul aria-label="' + escapeHtml("Gols do " + teamLabel(final[champSide])) + '">' + slxGoalList(final, final[champSide]) + '</ul><ul aria-label="' + escapeHtml("Gols do " + teamLabel(final[oppSide])) + '">' + slxGoalList(final, final[oppSide]) + "</ul></div></div>";
      }
      html += "</div>";
      if (final) {
        const lineup = slxLineup(final, champSide);
        html += '<div class="slx-squad"><p class="slx-squad-title">QUEM JOGOU A FINAL</p><ul class="slx-chips">' + lineup.played.map((name) => "<li>" + escapeHtml(displayName(name)) + (name === lineup.keeperName || keeper(name) ? ' <b class="slx-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</li>").join("") + "</ul></div>";
      }
      html += "</section>";
    }
    // Rankings: somam todas as Super Ligas, inclusive amistosos.
    const { scorerRows, keeperRows, playerRows, teamOf, plural } = superRankingData(), score = (value) => value.toFixed(1).replace(".", ",");
    html += '<section class="slx-ranks" aria-labelledby="slxRanksTitle"><div class="slx-sec-head"><h3 id="slxRanksTitle">RANKINGS DA SUPER LIGA</h3><p>Somam todas as Super Ligas, inclusive os amistosos.</p></div><div class="slx-rank-grid">' +
      slxRankCard("Artilheiros", scorerRows, (row) => teamOf(row.team), (row) => row.goals + '<small>' + (row.goals === 1 ? "gol" : "gols") + "</small>") +
      slxRankCard("Melhores goleiros", keeperRows, (row) => teamOf(row.team) + " · " + plural(row.games, "jogo", "jogos") + " · " + plural(row.against, "gol sofrido", "gols sofridos"), (row) => score(row.average)) +
      slxRankCard("Score dos jogadores", playerRows, (row) => teamOf(row.team) + " · " + plural(row.games, "jogo", "jogos"), (row) => score(row.average)) +
      "</div></section>";
    if (final && champion) {
      const champSide = final.home === champion ? "home" : "away";
      html += '<section class="slx-lineups" aria-labelledby="slxLineupTitle"><div class="slx-sec-head"><h3 id="slxLineupTitle">ESCALAÇÃO DA FINAL</h3></div><div class="slx-lineup-grid">' +
        slxTeamCard(final, champSide, true) + slxTeamCard(final, champSide === "home" ? "away" : "home", false) + "</div></section>";
    }
    // Outros jogos desta Super Liga (fora a final).
    const others = (state.gameHistory || []).filter((game) => game.superLigaId === sl.id && game.id !== final?.id).sort((a, b) => new Date(a.finishedAt || 0) - new Date(b.finishedAt || 0));
    if (others.length)
      html += '<section class="slx-others" aria-labelledby="slxOthersTitle"><div class="slx-sec-head"><h3 id="slxOthersTitle">OUTROS JOGOS DA SUPER LIGA</h3></div><ul class="slx-other-list">' + others.map((game) => {
        const tag = game.stage === "amistoso" ? "AMISTOSO · conta para o ranking" : game.stage === "group" ? "FASE DE GRUPOS · Rodada " + (game.round || "") : "JOGO",
          open = superOpenSumulas.has(game.id),
          shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? '<small class="slx-open">Pênaltis ' + game.shootout.homeScore + " × " + game.shootout.awayScore + "</small>" : "";
        return '<li class="slx-other"><div class="slx-other-row"><span class="slx-tag">' + escapeHtml(tag) + "</span>" +
          '<div class="slx-other-game"><span class="slx-oteam">' + slxCrest(game.home, "xs") + escapeHtml(gameTeamLabel(game, "home")) + '</span><b class="slx-oscore">' + (Number(game.homeScore) || 0) + " × " + (Number(game.awayScore) || 0) + '</b><span class="slx-oteam is-away">' + escapeHtml(gameTeamLabel(game, "away")) + slxCrest(game.away, "xs") + "</span>" + shoot + "</div></div>" +
          '<details class="slx-sumula" data-sumula="' + escapeHtml(game.id) + '"' + (open ? " open" : "") + '><summary>Ver súmula <span class="sr-only">de ' + escapeHtml(gameTeamLabel(game, "home") + " × " + gameTeamLabel(game, "away")) + "</span></summary>" + newsMatchReport({ match_id: game.id }).details + "</details></li>";
      }).join("") + "</ul></section>";
    if (!locked) {
      const friendly = superOpenFriendly(sl), liveFriendly = state.currentGame?.stage === "amistoso";
      html += '<div class="slx-org"><p class="help-text">' + (friendly ? "Amistoso preparado: " + escapeHtml(teamLabel(friendly.home) + " × " + teamLabel(friendly.away)) + ". Prepare e comece a partida no card acima. Ele conta para o ranking e não muda o campeão." : liveFriendly ? "Amistoso em andamento: conta para o ranking e não muda o campeão." : "Quer jogar de novo? Um novo jogo nesta Super Liga entra como amistoso: conta para o ranking e não muda o campeão.") + "</p>" +
        '<div class="button-row sl-actions">' +
        (friendly ? '<button type="button" class="button button-outline" data-sl-action="friendly-cancel">Cancelar amistoso</button>' : '<button type="button" class="button button-primary" data-sl-action="friendly"' + (state.currentGame ? " disabled" : "") + ">Amistoso (conta para o ranking)</button>") +
        '<button type="button" class="button button-outline" data-sl-action="restart"' + (state.currentGame?.superLigaId ? " disabled" : "") + ">Nova Super Liga</button></div></div>";
    }
    return html;
  }
  const superOpenSumulas = new Set();
  let superMarkup = "",
    superTeamsOpen = false;
  function renderSuperLiga() {
    const box = $("superLigaPanel");
    if (!box) return;
    const show = shownLiveMode() === "coca",
      sl = state.superLiga,
      otherMode = shownLiveMode() !== activeLiveMode();
    box.hidden = !show;
    // O cartão da partida mostra o modo ativo; quem está olhando a outra aba não o vê.
    // Sem tabela sorteada não há jogo para preparar: o painel da Super Liga vem primeiro.
    $("jogo").hidden = otherMode || (show && !state.currentGame && sl?.status !== "running" && !superOpenFriendly(sl));
    renderLigaPublicTeams(otherMode);
    if (!show) return;
    const locked = isEditLocked(),
      status = sl?.status || "none",
      statusText = { none: "A MONTAR", setup: "MONTANDO TIMES", running: "EM ANDAMENTO", finished: "ENCERRADA" }[status];
    box.classList.toggle("is-finished", status === "finished");
    let html = status === "finished" ? "" : '<div class="section-heading"><div><p class="eyebrow">MODO SUPER LIGA</p><h2 id="slTitle">Super Liga SKALAMA</h2></div><span class="season-badge">' + statusText + "</span></div>";
    if (otherMode && state.currentGame) html += '<p class="notice sl-mode-note">Agora está rolando um jogo do Modo Liga. Veja o placar na aba Modo Liga.</p>';
    if (!sl) {
      html += locked
        ? '<p class="empty-state">O organizador ainda não montou a Super Liga.</p>'
        : '<p class="help-text sl-intro">A Super Liga é separada do Elenco e sorteio: aqui você define os times, os jogadores de cada um e os titulares. Depois, o site sorteia a ordem dos jogos para que todos enfrentem todos.</p>' +
          '<div class="fields two sl-settings"><label>Quantos times<select id="slTeamCount">' + Array.from({ length: SUPER_MAX_TEAMS - SUPER_MIN_TEAMS + 1 }, (_, i) => i + SUPER_MIN_TEAMS).map((n) => '<option value="' + n + '"' + (n === 4 ? " selected" : "") + ">" + n + " times</option>").join("") + '</select></label><label>Titulares por time<input id="slStarters" type="number" inputmode="numeric" min="4" max="9" step="1" value="5"></label></div>' +
          '<div class="button-row"><button type="button" class="button button-primary" data-sl-action="create">Montar times</button></div>';
    } else {
      const teams = sl.teams,
        fixtures = sl.fixtures || [],
        groupGames = fixtures.filter((fixture) => fixture.stage === "group"),
        final = fixtures.find((fixture) => fixture.stage === "final"),
        next = superNextFixture();
      if (status === "finished") {
        html += renderSuperFinished(sl, locked, otherMode && state.currentGame ? '<p class="notice sl-mode-note">Agora está rolando um jogo do Modo Liga. Veja o placar na aba Modo Liga.</p>' : "");
        if (!locked) {
          const playing = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean));
          html += '<details class="sl-teams-details"' + (superTeamsOpen ? " open" : "") + "><summary>Times e jogadores · " + teams.length + " times · " + sl.starters + ' titulares por time</summary><div class="sl-teams">' + teams.map((team) => superTeamCard(team, sl, !playing.has(team.key))).join("") + "</div></details>";
        }
      } else {
      if (status === "setup") {
        html += locked
          ? '<p class="help-text">O organizador está montando os times da Super Liga.</p>'
          : '<div class="fields two sl-settings"><label>Quantos times<select id="slTeamCount">' + Array.from({ length: SUPER_MAX_TEAMS - SUPER_MIN_TEAMS + 1 }, (_, i) => i + SUPER_MIN_TEAMS).map((n) => '<option value="' + n + '"' + (n === teams.length ? " selected" : "") + ">" + n + " times</option>").join("") + '</select></label><label>Titulares por time<input id="slStarters" type="number" inputmode="numeric" min="4" max="9" step="1" value="' + sl.starters + '"></label></div>' +
            '<p class="help-text">Dê nome e cor a cada time e adicione os jogadores. Os primeiros ' + sl.starters + " de cada time entram como titulares e os demais como reservas; toque em Titular ou Reserva para trocar.</p>";
      } else if (!groupGames.length && final) {
        html += '<div class="sl-block sl-single"><h3>Jogo único</h3><ol class="sl-fixtures">' + superFixtureRow(final, next, locked) + '</ol><p class="help-text">Com 2 times a Super Liga é decidida em um jogo só: quem vencer é o campeão. Se empatar, vai para os pênaltis.</p></div>';
        html += superRankings(sl);
      } else {
        html += '<div class="sl-columns"><div class="sl-block"><h3>Classificação</h3>' + standingsTable(superStandings(), "A classificação aparece depois do primeiro jogo.") + '<p class="help-text">Vitória 3 pontos, empate 1. Depois que todos se enfrentarem, os 2 primeiros fazem a final.</p></div>' +
          '<div class="sl-block"><h3>Jogos</h3>';
        const rounds = [...new Set(groupGames.map((fixture) => fixture.round))];
        html += rounds.map((round) => {
          const games = groupGames.filter((fixture) => fixture.round === round),
            playingTeams = new Set(games.flatMap((fixture) => [fixture.home, fixture.away])),
            rest = teams.filter((team) => !playingTeams.has(team.key));
          return '<div class="sl-round"><h4>Rodada ' + round + (rest.length ? ' <small>· folga: ' + rest.map((team) => escapeHtml(team.name)).join(", ") + "</small>" : "") + '</h4><ol class="sl-fixtures">' + games.map((fixture) => superFixtureRow(fixture, next, locked)).join("") + "</ol></div>";
        }).join("");
        html += final
          ? '<div class="sl-round sl-final-round"><h4>Final</h4><ol class="sl-fixtures">' + superFixtureRow(final, next, locked) + "</ol></div>"
          : '<div class="sl-round sl-final-round"><h4>Final</h4><p class="help-text">1º × 2º da classificação, depois que todos se enfrentarem.</p></div>';
        html += "</div></div>";
        html += superRankings(sl);
      }
      const playing = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean)), field = locked ? ptOnField(true) : null,
        cards = locked
          ? teams.map((team) => { const [head, ink] = superHead(team); return ptCard(team.key, team.name, head, ink, team.players.map((player) => [player, team.starters.includes(player) ? "" : "Reserva"]), field.has(team.key)); }).join("")
          : teams.map((team) => superTeamCard(team, sl, !playing.has(team.key))).join("");
      // Visitantes só veem os times depois que o organizador confirma (sorteio da ordem dos jogos).
      html += status === "setup"
        ? locked ? "" : '<div class="sl-teams">' + cards + "</div>"
        : '<details class="sl-teams-details"' + (superTeamsOpen || locked ? " open" : "") + "><summary>" + (locked ? "Escalação dos times" : "Times e jogadores") + " · " + teams.length + " times · " + sl.starters + " titulares por time</summary><div class=\"" + (locked ? "public-teams-grid pt-grid" : "sl-teams") + "\">" + cards + "</div></details>";
      if (!locked)
        html += '<div class="button-row sl-actions">' +
          (status === "setup" ? '<button type="button" class="button button-primary" data-sl-action="draw">' + (teams.length === 2 ? "Começar jogo único" : "Sortear ordem dos jogos") + "</button>" : "") +
          (status !== "setup" ? '<button type="button" class="button button-outline" data-sl-action="restart"' + (state.currentGame?.superLigaId ? " disabled" : "") + ">Nova Super Liga</button>" : "") +
          "</div>" +
          (status === "setup"
            ? teams.length === 2
              ? '<p class="help-text">Com 2 times é jogo único: quem vencer é o campeão. Se empatar, vai para os pênaltis.</p>'
              : '<p class="help-text">Com ' + teams.length + " times são " + (teams.length * (teams.length - 1)) / 2 + " jogos em que todos se enfrentam uma vez, em ordem sorteada, e depois a final.</p>"
            : "");
      // Os rankings acumulam todas as Super Ligas, então aparecem também enquanto os times são montados.
      if (status === "setup" && (state.gameHistory || []).some((game) => game.superLigaId)) html += superRankings(sl);
      }
    }
    if (html === superMarkup) return;
    const focusKey = box.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey : "";
    superMarkup = html;
    box.innerHTML = html;
    box.querySelectorAll(".pt-grid").forEach(ptFit);
    if (focusKey) box.querySelector('[data-focus-key="' + focusKey + '"]')?.focus();
  }
  // Escalação dos times (visitante): card com a cor e o escudo do time, igual ao Elenco e sorteio.
  function ptOnField(superMode) {
    const game = state.currentGame;
    if (game && !!game.superLigaId === superMode) return new Set([game.home, game.away]);
    if (game) return new Set();
    if (!superMode) { const p = state.pendingMatch; return new Set(p?.prepared ? [p.home, p.away] : []); }
    const fixture = superNextFixture(), pending = state.superLiga?.pending;
    return new Set(fixture && pending?.prepared && pending.fixtureId === fixture.id ? [fixture.home, fixture.away] : []);
  }
  function ptCard(key, label, head, ink, players, onField) {
    const src = crestFor(key, label),
      initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    const crest = '<span class="pt-crest' + (src ? "" : " pt-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
    return '<article class="pt-card' + (onField ? " is-on-field" : "") + '"><header class="pt-head" style="--team-color:' + head + ";--team-ink:" + ink + '">' + crest + '<strong class="pt-name">' + escapeHtml(label) + "</strong>" + (onField ? '<span class="pt-live">EM CAMPO</span>' : "") + '</header><ol class="pt-list">' +
      players.map(([name, extra], index) => '<li><span class="pt-num">' + (index + 1) + '</span><span class="pt-player">' + escapeHtml(displayName(name)) + "</span>" + (keeper(name) ? '<b class="pt-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + (extra ? '<small class="pt-extra">' + extra + "</small>" : "") + "</li>").join("") +
      "</ol></article>";
  }
  // Garantia extra: se um nome ainda não couber na linha, diminui a fonte até caber (nunca corta nem quebra).
  function ptFit(root) {
    // Selo EM CAMPO desce para baixo do nome quando os dois não cabem lado a lado.
    root.querySelectorAll(".pt-head").forEach((head) => {
      head.classList.remove("is-tight");
      const name = head.querySelector(".pt-name");
      name.style.fontSize = "";
      if (!head.querySelector(".pt-live")) return;
      let size = parseFloat(getComputedStyle(name).fontSize);
      while (name.scrollWidth > name.clientWidth + 0.5 && size > 16) { size = Math.max(16, size - 0.5); name.style.fontSize = size + "px"; }
      if (name.scrollWidth > name.clientWidth + 0.5) { name.style.fontSize = ""; head.classList.add("is-tight"); }
    });
    root.querySelectorAll(".pt-name, .pt-player").forEach((el) => {
      if (el.classList.contains("pt-player")) el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
      while (el.scrollWidth > el.clientWidth + 0.5 && size > 9 && guard++ < 20) { size -= 0.5; el.style.fontSize = size + "px"; }
    });
  }
  window.addEventListener("resize", () => document.querySelectorAll(".pt-grid").forEach(ptFit));
  function renderLigaPublicTeams(otherMode) {
    const section = $("ligaPublicTeams");
    if (!section) return;
    const teams = state.teams || [],
      show = isEditLocked() && shownLiveMode() === "liga" && teams.length > 0;
    section.hidden = !show;
    if (!show) return;
    const note = $("ligaPublicNote");
    note.hidden = !(otherMode && state.currentGame);
    note.textContent = "Agora está rolando um jogo da Super Liga. Veja o placar na aba Modo Super Liga.";
    const field = ptOnField(false);
    const markup = teams.map((team) => {
      const [head, ink] = EL_HEAD[team.name] || ["#0d0d0d", "#ffffff"];
      return ptCard(team.name, teamLabel(team.name), head, ink, lineupForTeam(team.name).map((name) => [name, ""]), field.has(team.name));
    }).join("");
    const grid = $("ligaPublicTeamsGrid");
    if (grid.dataset.markup !== markup) { grid.dataset.markup = markup; grid.innerHTML = markup; ptFit(grid); }
  }
  function bindSuperLiga() {
    const box = $("superLigaPanel");
    box.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const action = target.dataset.slAction;
      if (action === "create") superCreate();
      else if (action === "draw") superDraw();
      else if (action === "restart") superRestart();
      else if (action === "friendly") superFriendly();
      else if (action === "friendly-cancel") superFriendlyCancel();
      else if (target.dataset.slRole) superToggleRole(target.dataset.slRole, Number(target.dataset.slIndex));
      else if (target.dataset.slRemove) superRemovePlayer(target.dataset.slRemove, Number(target.dataset.slIndex));
      else if (target.dataset.slPlay) superPlay(target.dataset.slPlay);
    });
    box.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-sl-add]");
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector("input");
      if (input.value.trim()) superAddPlayer(form.dataset.slAdd, input.value);
    });
    box.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.slPick) { if (target.value) superAddPlayer(target.dataset.slPick, target.value); }
      else if (target.dataset.slName) superRename(target.dataset.slName, target.value);
      else if (target.dataset.slColor) superSetColor(target.dataset.slColor, target.value);
      else if (target.id === "slTeamCount" && state.superLiga) superSetCount(target.value);
      else if (target.id === "slStarters" && state.superLiga) superSetStarters(target.value);
    });
    // "toggle" não sobe pela página; escuta na captura para lembrar se a lista de times está aberta.
    box.addEventListener("toggle", (event) => {
      if (event.target.classList?.contains("sl-teams-details")) { superTeamsOpen = event.target.open; superMarkup = ""; }
      const sumula = event.target.dataset?.sumula;
      if (sumula) { if (event.target.open) superOpenSumulas.add(sumula); else superOpenSumulas.delete(sumula); superMarkup = ""; }
    }, true);
  }
  // ---------- SKALAMA News: portal de notícias da liga ----------
  // Com Supabase as notícias ficam nas tabelas news_*; no modo local, só neste navegador.
  const NEWS_LOCAL_KEY = "liga-skalama-news",
    NEWS_CATEGORIES = { resultado: "Resultado", destaque: "Destaque", anuncio: "Anúncio", comunidade: "Comunidade" },
    NEWS_STATUS = { draft: "Rascunho", published: "Publicada", scheduled: "Agendada", archived: "Arquivada" },
    NEWS_ROLES = { mentioned: "Citado", scorer: "Fez gol", player_of_the_night: "Craque da noite", goalkeeper_of_the_night: "Goleiro da noite" },
    NEWS_HIGHLIGHTS = { player_of_the_night: "Craque da noite", goalkeeper_of_the_night: "Goleiro da noite", top_scorer: "Artilheiro" },
    NEWS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let newsPosts = [],
    newsLoadedAt = 0,
    newsLoading = null,
    newsFilter = "todas",
    newsOpenSlug = null,
    newsDraft = null,
    newsJustPublished = null,
    newsError = "";
  function newsLocalRead() {
    try { return JSON.parse(localStorage.getItem(NEWS_LOCAL_KEY) || "[]"); } catch { return []; }
  }
  function newsLocalWrite(posts) {
    try { localStorage.setItem(NEWS_LOCAL_KEY, JSON.stringify(posts)); } catch { notify("Não foi possível guardar a notícia neste navegador (sem espaço).", true); }
  }
  // Publicada, ou agendada com horário já alcançado; nunca apagada.
  function newsIsPublic(post) {
    if (!post || post.deleted_at) return false;
    const now = Date.now();
    if (post.status === "published") return !post.published_at || new Date(post.published_at).getTime() <= now;
    if (post.status === "scheduled") return !!post.scheduled_for && new Date(post.scheduled_for).getTime() <= now;
    return false;
  }
  function newsDate(post) {
    return post.status === "scheduled" ? post.scheduled_for : post.published_at || post.created_at;
  }
  function newsSortTime(post) {
    return new Date(newsDate(post) || 0).getTime();
  }
  async function loadNews(force = false) {
    if (newsLoading) return newsLoading;
    if (!force && Date.now() - newsLoadedAt < 30000) return;
    newsLoading = (async () => {
      // Garante que newsLoading já guarde esta promessa antes de qualquer retorno (no modo local tudo é imediato).
      await Promise.resolve();
      try {
        if (shared && client) {
          const { data, error } = await client
            .from("news_posts")
            .select("*, news_post_players(*), news_media(*), news_highlights(*)")
            .is("deleted_at", null)
            .order("created_at", { ascending: false });
          if (error) throw error;
          newsPosts = data || [];
        } else {
          newsPosts = newsLocalRead().filter((post) => !post.deleted_at);
        }
        newsError = "";
        newsLoadedAt = Date.now();
      } catch (error) {
        newsError = /news_posts|relation|schema cache/i.test(error.message || "")
          ? "O SKALAMA News ainda não foi ativado no banco."
          : "Não deu para carregar as notícias agora: " + error.message;
      } finally {
        newsLoading = null;
        renderNews();
      }
    })();
    return newsLoading;
  }
  function newsVisible() {
    const locked = isEditLocked();
    return newsPosts
      .filter((post) => !post.deleted_at && (locked ? newsIsPublic(post) : true))
      .sort((a, b) => newsSortTime(b) - newsSortTime(a));
  }
  function newsWhen(value) {
    if (!value) return "";
    const date = new Date(value), diff = Date.now() - date.getTime(), hour = 3600000;
    if (diff >= 0 && diff < hour) return "há " + Math.max(1, Math.round(diff / 60000)) + " min";
    if (diff >= 0 && diff < 24 * hour) return "há " + Math.round(diff / hour) + " h";
    return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " · " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function newsParagraphs(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => "<p>" + escapeHtml(part).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>") + "</p>")
      .join("");
  }
  function newsSafeUrl(url) {
    const value = String(url || "").trim();
    return /^https:\/\//i.test(value) || /^data:image\//i.test(value) ? value : "";
  }
  function newsViews(post) {
    const n = Number(post.views_count) || 0;
    return n + (n === 1 ? " visualização" : " visualizações");
  }
  function newsBadge(post) {
    return '<span class="news-badge news-cat-' + escapeHtml(post.category) + '">' + escapeHtml(NEWS_CATEGORIES[post.category] || post.category) + "</span>";
  }
  function newsStatusChip(post) {
    if (isEditLocked() || newsIsPublic(post)) return "";
    const label = NEWS_STATUS[post.status] || post.status;
    return '<span class="news-status news-status-' + escapeHtml(post.status) + '">' + escapeHtml(label) + "</span>";
  }
  // Capa automática para notícia de jogo sem foto: escudos e placar.
  function newsMatchCover(post) {
    const game = post.match_id && (state.gameHistory || []).find((item) => item.id === post.match_id);
    if (!game) return "";
    const win = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null;
    return '<div class="news-cover news-cover-match" aria-hidden="true">' +
      '<span class="ncm-side' + (win === "home" ? " is-winner" : "") + '">' + newsCrest(game, "home", "md") + "<small>" + escapeHtml(gameTeamLabel(game, "home")) + "</small></span>" +
      '<b>' + game.homeScore + "<i>×</i>" + game.awayScore + "</b>" +
      '<span class="ncm-side' + (win === "away" ? " is-winner" : "") + '">' + newsCrest(game, "away", "md") + "<small>" + escapeHtml(gameTeamLabel(game, "away")) + "</small></span>" +
      (game.superLigaId && game.stage === "final" ? '<em class="ncm-tag">🏆 Final da Super Liga</em>' : "") + "</div>";
  }
  function newsCard(post, featured = false) {
    const cover = newsSafeUrl(post.cover_image_url);
    return '<article class="news-card' + (featured ? " news-featured" : "") + '">' +
      '<a class="news-card-link" href="#noticia-' + encodeURIComponent(post.slug) + '" data-news-open="' + escapeHtml(post.slug) + '">' +
      (cover ? '<img class="news-cover" src="' + escapeHtml(cover) + '" alt="" loading="lazy">' : newsMatchCover(post) || '<div class="news-cover news-cover-empty" aria-hidden="true"><span>SKALAMA <b>News</b></span></div>') +
      '<div class="news-card-body"><div class="news-meta">' + newsBadge(post) + newsStatusChip(post) + (post.is_featured ? '<span class="news-flag">Destaque</span>' : "") + '<small>' + escapeHtml(newsWhen(newsDate(post))) + "</small></div>" +
      "<h3>" + escapeHtml(post.title) + "</h3>" +
      (post.excerpt ? "<p>" + escapeHtml(post.excerpt) + "</p>" : post.subtitle ? "<p>" + escapeHtml(post.subtitle) + "</p>" : "") +
      '<small class="news-stats">' + newsViews(post) + (Number(post.shares_count) && !isEditLocked() ? " · " + post.shares_count + (Number(post.shares_count) === 1 ? " compartilhamento" : " compartilhamentos") : "") + "</small></div></a>" + newsShareTools(post, true) + "</article>";
  }
  // Escudos dos times, pelo nome (vale para Liga e Super Liga). Novos escudos: arquivo em public/assets/escudos/ e uma linha aqui.
  const TEAM_CRESTS = {
    skalama: "./assets/escudos/skalama.png",
    "2017fc": "./assets/escudos/2017-fc.png",
    // Time Sol (Modo Liga): escudo fixo, vale mesmo se o time ganhar outro nome na rodada.
    timesol: "./assets/escudos/time-sol.png",
    timeaguia: "./assets/escudos/time-aguia.png",
    // Time Azul: usa o escudo da SKALAMA.
    timeazul: "./assets/escudos/skalama.png",
    // Time Lobo (antigo Time Verde, que segue com esse nome interno).
    timelobo: "./assets/escudos/time-lobo.png",
    timeverde: "./assets/escudos/time-lobo.png",
  };
  // Escudo fixo do time (pela chave ou pelo nome); tem prioridade sobre o logo enviado no aparelho.
  function fixedCrest(teamKey, label) {
    const norm = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return TEAM_CRESTS[norm(teamKey)] || TEAM_CRESTS[norm(label)] || TEAM_CRESTS[norm(teamLabel(teamKey))] || "";
  }
  function crestFor(teamKey, label) {
    return fixedCrest(teamKey, label) || teamLogos[teamKey] || "";
  }
  function newsCrest(game, side, size = "lg") {
    const key = game[side], label = gameTeamLabel(game, side), src = crestFor(key, label), color = colorOf(key);
    const initials = label.replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return src
      ? '<span class="nm-crest nm-crest-' + size + '"><img src="' + escapeHtml(src) + '" alt="Escudo do ' + escapeHtml(label) + '"></span>'
      : '<span class="nm-crest nm-crest-' + size + ' nm-crest-empty" style="--team-color:' + color.color + ";--team-ink:" + color.ink + '" aria-hidden="true">' + escapeHtml(initials || "?") + "</span>";
  }
  function newsScoreClass(score) {
    return score >= 8 ? "is-great" : score >= 6.5 ? "is-good" : "is-low";
  }
  // Súmula completa do jogo ligado à notícia: placar, campeão, ficha, gols, números e escalações.
  function newsMatchReport(post) {
    const game = post.match_id && (state.gameHistory || []).find((item) => item.id === post.match_id);
    if (!game) return { top: "", details: "" };
    const sides = ["home", "away"],
      label = (side) => gameTeamLabel(game, side),
      score = { home: Number(game.homeScore) || 0, away: Number(game.awayScore) || 0 },
      shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null,
      winnerSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      isSuper = !!game.superLigaId,
      isFinal = isSuper && game.stage === "final",
      // Jogo único: Super Liga de 2 times (só dá para saber na edição atual; nas antigas aparece "Final").
      single = isFinal && state.superLiga?.id === game.superLigaId && (state.superLiga?.teams || []).length === 2,
      perf = gamePerformance(game),
      goals = [...(game.goals || [])].sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0)),
      subs = game.substitutions || [],
      incidents = (game.incidents || []).filter((item) => item.type !== "sub" && (!item.gameId || item.gameId === game.id)),
      finished = new Date(game.finishedAt || 0),
      sideOfTeam = (team) => (team === game.home ? "home" : team === game.away ? "away" : null),
      sideOfPlayer = (player) => {
        const p = perf.find((item) => item.player === player);
        if (p) return sideOfTeam(p.team);
        if ([...(game.homeStart || game.homePlayers || []), ...(game.homeBench || [])].includes(player)) return "home";
        if ([...(game.awayStart || game.awayPlayers || []), ...(game.awayBench || [])].includes(player)) return "away";
        return null;
      };
    // Ficha do jogo
    const facts = [
      isSuper ? (isFinal ? (single ? "Super Liga · Jogo único" : "Super Liga · Final") : game.stage === "amistoso" ? "Super Liga · Amistoso" : "Super Liga · Rodada " + (game.round || "")) : "Modo Liga",
      "Jogo " + game.number,
      Number.isFinite(finished.getTime()) ? finished.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " · " + finished.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "",
      game.durationSeconds ? Math.round(game.durationSeconds / 60) + " min de bola rolando" : "",
      state.venue || "",
    ].filter(Boolean);
    // Números por time
    const stat = (name, home, away, format = (v) => v) => {
      const total = home + away, pct = total > 0 ? Math.round((home / total) * 100) : 50;
      return '<div class="nm-stat"><b>' + format(home) + '</b><div class="nm-stat-mid"><span>' + name + '</span><div class="nm-bar"><i style="width:' + pct + '%"></i></div></div><b>' + format(away) + "</b></div>";
    };
    const goalsBy = (side) => goals.filter((goal) => sideOfTeam(goal.scoringTeam || goal.team) === side).length,
      assistsBy = (side) => goals.filter((goal) => goal.assistedBy && sideOfTeam(goal.scoringTeam || goal.team) === side && !goal.ownGoal).length,
      subsBy = (side) => subs.filter((item) => sideOfTeam(item.team) === side).length,
      incidentsBy = (side) => incidents.filter((item) => (item.team ? sideOfTeam(item.team) : sideOfPlayer(item.player)) === side).length,
      avgBy = (side) => { const rows = perf.filter((p) => sideOfTeam(p.team) === side); return rows.length ? rows.reduce((sum, p) => sum + Number(p.score || 0), 0) / rows.length : 0; };
    const stats =
      stat("Gols", goalsBy("home"), goalsBy("away")) +
      stat("Assistências", assistsBy("home"), assistsBy("away")) +
      (perf.length ? stat("Nota média", avgBy("home"), avgBy("away"), (v) => v.toFixed(1).replace(".", ",")) : "") +
      stat("Substituições", subsBy("home"), subsBy("away")) +
      (incidents.length ? stat("Ocorrências", incidentsBy("home"), incidentsBy("away")) : "");
    // Linha do tempo dos gols
    const timeline = goals.length
      ? '<ol class="nm-timeline">' + goals.map((goal) => {
          const side = sideOfTeam(goal.scoringTeam || goal.team) || "home";
          return '<li class="nm-goal nm-' + side + '"><span class="nm-minute">' + (Number(goal.minute) || "–") + "'</span><span class=\"nm-goal-text\"><strong>" + escapeHtml(displayName(goal.player || "Gol")) + "</strong>" + (goal.ownGoal ? " <em>(contra)</em>" : "") + (goal.assistedBy ? "<small>assist. " + escapeHtml(displayName(goal.assistedBy)) + "</small>" : "") + "</span></li>";
        }).join("") + "</ol>"
      : '<p class="empty-state">Jogo sem gols.</p>';
    // Escalações
    const lineup = (side) => {
      const team = game[side],
        starters = game[side + "Start"] || game[side + "Players"] || [],
        bench = game[side + "Bench"] || [],
        keeperName = game[side + "KeeperStart"] || game[side + "Keeper"],
        rowsFor = (names, benchRow) => names.map((name) => {
          const p = perf.find((item) => item.player === name), scored = goals.filter((goal) => goal.player === name && !goal.ownGoal).length, assists = goals.filter((goal) => goal.assistedBy === name).length,
            moves = subs.filter((item) => sideOfTeam(item.team) === side && (item.in === name || item.out === name)).sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0)),
            enteredAt = moves.find((item) => item.in === name);
          if (benchRow && !enteredAt && !p) return "";
          return '<li><span class="nm-player">' + escapeHtml(displayName(name)) + (name === keeperName || keeper(name) ? ' <b class="nm-tag">GOL</b>' : "") +
            (scored ? ' <span class="nm-icons" title="' + scored + ' gol(s)">' + "⚽".repeat(Math.min(scored, 5)) + "</span>" : "") +
            (assists ? ' <small class="nm-assist">' + assists + " assist.</small>" : "") +
            moves.map((item) => (item.in === name ? ' <small class="nm-sub-in">↑ ' : ' <small class="nm-sub-out">↓ ') + (item.minute || "") + "'</small>").join("") +
            "</span>" + (p ? '<span class="nm-rating ' + newsScoreClass(Number(p.score)) + '">' + Number(p.score).toFixed(1).replace(".", ",") + "</span>" : "") + "</li>";
        }).join("");
      // Quem entrou vem das substituições do time (e de quem tem nota sem ser titular); ninguém aparece duas vezes.
      const entered = [...new Set([
          ...subs.filter((item) => sideOfTeam(item.team) === side).map((item) => item.in),
          ...perf.filter((p) => sideOfTeam(p.team) === side).map((p) => p.player),
        ])].filter((name) => name && !starters.includes(name)),
        unused = bench.filter((name) => !starters.includes(name) && !entered.includes(name));
      return '<div class="nm-lineup' + (winnerSide === side ? " is-winner" : "") + '" style="--team-color:' + colorOf(team).color + '"><header>' + newsCrest(game, side, "sm") + "<strong>" + escapeHtml(label(side)) + '</strong></header><p class="nm-lineup-label">Titulares</p><ol>' + rowsFor(starters, false) + "</ol>" +
        (entered.length ? '<p class="nm-lineup-label">Entraram</p><ol>' + rowsFor(entered, false) + "</ol>" : "") +
        (unused.length ? '<p class="nm-bench">Banco: ' + unused.map((name) => escapeHtml(displayName(name))).join(", ") + "</p>" : "") + "</div>";
    };
    const champion = isFinal && winnerSide
      ? '<div class="nm-champion" style="--team-color:' + colorOf(game[winnerSide]).color + '">' + newsCrest(game, winnerSide, "md") + '<div><p>🏆 CAMPEÃO DA SUPER LIGA</p><strong>' + escapeHtml(label(winnerSide)) + "</strong><span>" + (single ? "Venceu o jogo único" : "Venceu a final") + " por " + Math.max(score.home, score.away) + " a " + Math.min(score.home, score.away) + (shoot ? " nos pênaltis (" + shoot.homeScore + "×" + shoot.awayScore + ")" : "") + "</span></div></div>"
      : "";
    const top = '<section class="nm-report" aria-label="Placar do jogo">' +
      '<div class="nm-board">' + sides.map((side, i) =>
        (i === 1 ? '<div class="nm-score"><b class="' + (winnerSide === "home" ? "is-win" : "") + '">' + score.home + '</b><span>×</span><b class="' + (winnerSide === "away" ? "is-win" : "") + '">' + score.away + "</b>" + (shoot ? '<small>pênaltis ' + shoot.homeScore + " × " + shoot.awayScore + "</small>" : winnerSide ? "" : "<small>empate</small>") + "</div>" : "") +
        '<div class="nm-side' + (winnerSide === side ? " is-winner" : winnerSide ? " is-loser" : "") + '">' + newsCrest(game, side) + "<strong>" + escapeHtml(label(side)) + "</strong>" + (winnerSide === side ? '<span class="nm-win">VENCEU</span>' : "") + "</div>"
      ).join("") + '</div><p class="nm-facts">' + facts.map((item) => "<span>" + escapeHtml(item) + "</span>").join("") + "</p>" +
      champion + "</section>";
    const details = '<section class="nm-report" aria-label="Súmula do jogo">' +
      '<div class="nm-grid"><div class="nm-block"><h3>Gols do jogo</h3>' + timeline + '</div><div class="nm-block"><h3>Números do jogo</h3><div class="nm-stats-head"><span>' + escapeHtml(label("home")) + "</span><span>" + escapeHtml(label("away")) + "</span></div>" + stats + "</div></div>" +
      '<div class="nm-block"><h3>Escalações e notas</h3><div class="nm-lineups">' + lineup("home") + lineup("away") + '</div><p class="nm-legend">Nota de 0 a 10 calculada pelo site · ⚽ gol · ↑ entrou · ↓ saiu</p></div>' +
      "</section>";
    return { top, details };
  }
  function renderNewsPost(post) {
    const report = newsMatchReport(post),
      cover = newsSafeUrl(post.cover_image_url),
      highlights = (post.news_highlights || []).filter((item) => item.player_name || item.label),
      players = post.news_post_players || [],
      media = [...(post.news_media || [])].sort((a, b) => (a.order_index || 0) - (b.order_index || 0)).filter((item) => newsSafeUrl(item.url));
    return '<div class="news-post-actions"><button type="button" class="button button-outline button-small" data-news-back>← Voltar para as notícias</button>' +
      (!isEditLocked() ? '<button type="button" class="button button-dark button-small news-edit-btn" data-news-edit="' + escapeHtml(post.id) + '">Editar</button>' : "") + "</div>" +
      newsShareTools(post) +
      '<article class="news-post">' +
      '<div class="news-meta">' + newsBadge(post) + newsStatusChip(post) + "<small>" + escapeHtml(newsWhen(newsDate(post))) + " · " + newsViews(post) + "</small></div>" +
      "<h2>" + escapeHtml(post.title) + "</h2>" +
      (post.subtitle ? '<p class="news-subtitle">' + escapeHtml(post.subtitle) + "</p>" : "") +
      (cover ? '<img class="news-post-cover" src="' + escapeHtml(cover) + '" alt="">' : "") +
      report.top +
      (highlights.length ? '<div class="news-highlights">' + highlights.map((item) => '<div class="news-highlight"><small>' + escapeHtml(item.label || NEWS_HIGHLIGHTS[item.type] || "Destaque") + "</small><strong>" + escapeHtml(displayName(item.player_name || "")) + "</strong>" + (item.value !== null && item.value !== undefined && item.value !== "" ? "<span>" + escapeHtml(String(item.value).replace(".", ",")) + (item.type === "top_scorer" ? " gol(s)" : "") + "</span>" : "") + "</div>").join("") + "</div>" : "") +
      '<div class="news-content">' + newsParagraphs(post.content) + "</div>" +
      report.details +
      (media.length ? '<div class="news-media">' + media.map((item) => '<figure><img src="' + escapeHtml(newsSafeUrl(item.url)) + '" alt="' + escapeHtml(item.caption || "") + '" loading="lazy">' + (item.caption ? "<figcaption>" + escapeHtml(item.caption) + "</figcaption>" : "") + "</figure>").join("") + "</div>" : "") +
      (players.length ? '<div class="news-players"><small>Na notícia</small>' + players.map((item) => '<span class="news-player">' + escapeHtml(displayName(item.player_name)) + (item.role && item.role !== "mentioned" ? " · " + escapeHtml(NEWS_ROLES[item.role] || item.role) : "") + (Number(item.goals) ? " · " + item.goals + " gol" + (item.goals > 1 ? "s" : "") : "") + "</span>").join("") + "</div>" : "") +
      '<div class="button-row"><button type="button" class="button button-primary" data-news-share="' + escapeHtml(post.id) + '">Compartilhar</button></div>' +
      "</article>";
  }
  // Botão do News na Tela principal: mostra a manchete mais recente publicada.
  // Tela principal: a notícia em destaque (ou a mais recente), com placar quando é de um jogo.
  function renderNewsHero() {
    const box = $("homeNews");
    if (!box) return;
    const posts = newsPosts.filter(newsIsPublic).sort((a, b) => newsSortTime(b) - newsSortTime(a)),
      post = posts.find((item) => item.is_featured) || posts[0];
    box.hidden = !post;
    box.closest(".home-top")?.classList.toggle("no-news", !post);
    if (!post) { box.innerHTML = ""; return; }
    const game = post.match_id && (state?.gameHistory || []).find((item) => item.id === post.match_id);
    let board = "";
    if (game) {
      const win = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
        shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null,
        side = (key) => {
          const label = gameTeamLabel(game, key), src = crestFor(game[key], label),
            initials = label.replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
          return '<div class="hn-team' + (win === key ? " is-winner" : win ? " is-loser" : "") + '">' +
            (src ? '<span class="hn-crest hn-crest-img"><img src="' + escapeHtml(src) + '" alt=""></span>' : '<span class="hn-crest hn-initials" aria-hidden="true">' + escapeHtml(initials || "?") + "</span>") +
            "<strong>" + escapeHtml(label) + "</strong></div>";
        },
        num = (key) => '<b class="' + (win === key ? "is-winner" : win ? "is-loser" : "") + '">' + (Number(game[key + "Score"]) || 0) + "</b>";
      board = '<div class="hn-board" role="img" aria-label="' + escapeHtml(gameTeamLabel(game, "home") + " " + (Number(game.homeScore) || 0) + " a " + (Number(game.awayScore) || 0) + " " + gameTeamLabel(game, "away")) + '">' +
        side("home") + '<div class="hn-score">' + num("home") + '<i aria-hidden="true">×</i>' + num("away") + (shoot ? "<small>Pênaltis " + shoot.homeScore + " × " + shoot.awayScore + "</small>" : "") + "</div>" + side("away") + "</div>";
    }
    box.innerHTML = '<p class="hn-kicker"><span class="hn-tag">SKALAMA NEWS</span><span>O jornal da pelada · última notícia</span></p>' +
      '<h2 class="hn-title">' + escapeHtml(post.title) + "</h2>" + (!game && post.excerpt ? '<p class="hn-excerpt">' + escapeHtml(post.excerpt) + "</p>" : "") + board +
      '<div class="hn-actions"><a class="hn-btn hn-btn-primary" href="#noticia-' + encodeURIComponent(post.slug) + '">Ler notícia</a><button type="button" class="hn-btn hn-btn-outline" data-home-news-all>Todas as notícias</button></div>';
  }
  // Tela principal: próximo jogo com os dados da rodada (linha sem dado não aparece).
  function renderHomeNext() {
    const box = $("homeNext");
    if (!box || !state) return;
    const date = state.matchDate ? new Date(state.matchDate + "T12:00:00") : null,
      validDate = date && Number.isFinite(date.getTime()),
      weekday = validDate ? date.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0].toUpperCase() : "",
      dayMonth = validDate ? date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "",
      teams = state.teams || [],
      players = teams.reduce((sum, team) => sum + lineupForTeam(team.name).length, 0),
      time = /^\d{2}:\d{2}/.test(state.startTime || "") ? state.startTime.slice(0, 5).replace(":00", "h").replace(":", "h") : "",
      venue = String(state.venue || "").trim(),
      icon = (path) => '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' + path + "</svg>",
      rows = [
        time && [icon('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'), time],
        venue && [icon('<path d="M12 22s7-6.6 7-12.2A7 7 0 0 0 5 9.8C5 15.4 12 22 12 22Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.8" r="2.6" fill="currentColor"/>'), venue],
        teams.length && players && [icon('<circle cx="9" cy="8" r="3.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 20c.6-3.6 3.2-5.6 6.5-5.6s5.9 2 6.5 5.6M15.5 4.8a3.4 3.4 0 0 1 0 6.4M18 14.6c2 .7 3.2 2.6 3.5 5.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'), teams.length + (teams.length === 1 ? " time · " : " times · ") + players + (players === 1 ? " jogador" : " jogadores")],
      ].filter(Boolean);
    box.innerHTML = '<p class="hx-kicker" id="homeNextTitle">PRÓXIMO JOGO</p>' +
      (weekday ? '<p class="hx-day">' + escapeHtml(weekday) + "</p>" : "") +
      (dayMonth ? '<p class="hx-date">' + escapeHtml(dayMonth) + "</p>" : "") +
      (rows.length ? '<ul class="hx-list">' + rows.map(([svg, text]) => "<li>" + svg + "<span>" + escapeHtml(text) + "</span></li>").join("") + "</ul>" : "") +
      (!weekday && !rows.length ? '<p class="hx-empty">A data da próxima rodada ainda vai ser definida.</p>' : "") +
      (teams.length ? '<button type="button" class="hx-btn" data-home-teams>Ver equipes</button>' : "");
    const footerVenue = $("footerVenue");
    if (footerVenue) footerVenue.textContent = venue || "Quadra do Jemb";
  }
  // Antes do primeiro jogo da rodada, os cards sem dados somem e aparece um aviso só.
  function renderHomeVisibility() {
    const roundId = state.roundId || state.currentGame?.roundId,
      roundGames = roundId ? (state.gameHistory || []).filter((game) => game.roundId === roundId).length : 0,
      empty = (id) => { const host = $(id); return !host || !host.children.length || (host.children.length === 1 && host.firstElementChild.classList.contains("empty-state")); },
      cards = [
        [$("homeGoalsCard"), empty("goalRanking")],
        [$("playerScoreRanking")?.closest(".panel"), empty("playerScoreRanking")],
        [$("keeperRanking")?.closest(".panel"), empty("keeperRanking")],
        [$("keeperConcededRanking")?.closest(".panel"), empty("keeperConcededRanking")],
      ];
    cards.forEach(([card, hide]) => { if (card) card.hidden = hide; });
    const grid = document.querySelector('.score-grid[data-view="home"]');
    if (grid) grid.hidden = cards.every(([, hide]) => hide);
    $("homeStandings").hidden = !roundGames;
    $("destaques-noite").hidden = !roundGames;
    $("seasonHighlights").closest(".panel").hidden = empty("seasonHighlights");
    const waiting = $("homeWaiting");
    waiting.hidden = !!roundGames;
    $("homeWaitingText").textContent = cards.every(([, hide]) => hide)
      ? "A rodada ainda não começou. Classificação, artilharia, rankings e destaques da noite aparecem aqui depois do primeiro jogo."
      : "A rodada ainda não começou. Classificação e destaques da noite aparecem aqui depois do primeiro jogo.";
    const badge = $("liveBadge");
    if (badge) badge.hidden = !state.currentGame;
  }
  function renderNews() {
    renderNewsHero();
    const box = $("newsPublic"), editor = $("newsEditor");
    if (!box || !editor) return;
    const locked = isEditLocked();
    if (newsDraft && !locked) {
      box.hidden = true;
      editor.hidden = false;
      renderNewsEditor();
      return;
    }
    editor.hidden = true;
    editor.innerHTML = "";
    box.hidden = false;
    const posts = newsVisible();
    if (newsOpenSlug) {
      const post = posts.find((item) => item.slug === newsOpenSlug);
      if (post) { box.innerHTML = renderNewsPost(post); return; }
      if (newsLoadedAt) box.innerHTML = '<div class="news-post-actions"><button type="button" class="button button-outline button-small" data-news-back>← Voltar para as notícias</button></div><p class="empty-state">Essa notícia não existe ou ainda não foi publicada.</p>';
      else box.innerHTML = '<p class="empty-state">Carregando a notícia…</p>';
      return;
    }
    const filtered = posts.filter((post) => newsFilter === "todas" || post.category === newsFilter),
      featured = newsFilter === "todas" ? filtered.find((post) => post.is_featured && (locked || newsIsPublic(post))) : null,
      rest = filtered.filter((post) => post !== featured);
    box.innerHTML =
      '<div class="news-toolbar"><div class="news-filters" role="group" aria-label="Filtrar por categoria">' +
      [["todas", "Todas"], ...Object.entries(NEWS_CATEGORIES)].map(([key, label]) => '<button type="button" class="news-filter' + (newsFilter === key ? " active" : "") + '" data-news-filter="' + key + '" aria-pressed="' + (newsFilter === key) + '">' + label + "</button>").join("") +
      "</div>" + (!locked ? '<button type="button" class="button button-primary button-small" data-news-new>+ Nova notícia</button>' : "") + "</div>" +
      (newsError ? '<p class="notice">' + escapeHtml(newsError) + "</p>" : "") +
      (featured ? newsCard(featured, true) : "") +
      (rest.length ? '<div class="news-grid">' + rest.map((post) => newsCard(post)).join("") + "</div>" : !featured ? '<p class="empty-state">' + (newsLoadedAt || newsError ? (newsFilter === "todas" ? "Nenhuma notícia ainda. A primeira resenha da pelada vem aí!" : "Nada nessa categoria por enquanto.") : "Carregando as notícias…") + "</p>" : "");
  }
  function openNewsPost(slug, push = true) {
    newsOpenSlug = slug;
    newsDraft = null;
    if (push && location.hash !== "#noticia-" + slug) history.pushState(null, "", "#noticia-" + encodeURIComponent(slug));
    renderNews();
    $("news")?.scrollIntoView({ behavior: "smooth", block: "start" });
    const post = newsPosts.find((item) => item.slug === slug);
    if (post) newsCount(post, "view");
  }
  function closeNewsPost() {
    newsOpenSlug = null;
    newsJustPublished = null;
    if (location.hash.startsWith("#noticia-")) history.pushState(null, "", location.pathname + location.search);
    renderNews();
  }
  // Uma visualização por notícia a cada sessão do navegador.
  async function newsCount(post, kind) {
    if (!newsIsPublic(post)) return;
    const key = "liga-skalama-news-" + kind + "-" + post.id;
    try { if (kind === "view" && sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch {}
    const field = kind === "view" ? "views_count" : "shares_count";
    post[field] = (Number(post[field]) || 0) + 1;
    if (shared && client) client.rpc(kind === "view" ? "news_register_view" : "news_register_share", { p_post: post.id }).then(({ error }) => error && console.warn(error));
    else newsLocalWrite(newsLocalRead().map((item) => (item.id === post.id ? { ...item, [field]: post[field] } : item)));
    renderNews();
  }
  // ---------- Divulgação (WhatsApp: canal e grupos) ----------
  function newsShareUrl(post) {
    return "https://skalama.com.br/#noticia-" + encodeURIComponent(post.slug);
  }
  // Mensagem pronta para o WhatsApp (*texto* = negrito). Sem resumo, a linha é pulada.
  function newsShareText(post) {
    return [
      "📰 *SKALAMA News*",
      "*" + String(post.title || "").trim() + "*",
      String(post.excerpt || "").trim(),
      "👉 " + newsShareUrl(post),
    ].filter(Boolean).join("\n");
  }
  function newsIsMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  async function newsCopyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Navegadores sem acesso à área de transferência: cópia pelo jeito antigo.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch {}
      area.remove();
      return ok;
    }
  }
  // channel: "auto" (botão Compartilhar da notícia), "whatsapp" (Enviar pro WhatsApp) ou "copy" (Copiar mensagem).
  // Todos somam no contador de compartilhamentos.
  async function shareNews(id, channel = "auto") {
    const post = newsPosts.find((item) => item.id === id);
    if (!post) return;
    const url = location.origin + location.pathname + "#noticia-" + encodeURIComponent(post.slug),
      text = post.title + (post.excerpt ? " — " + post.excerpt : ""),
      message = newsShareText(post),
      openWhatsApp = () => window.open("https://wa.me/?text=" + encodeURIComponent(message), "_blank", "noopener");
    try {
      if (channel === "copy") {
        if (!(await newsCopyText(message))) { notify("Não deu para copiar. Segure o dedo no texto da notícia para copiar.", true); return; }
        notify("Mensagem copiada");
      } else if (channel === "whatsapp") {
        // No celular, o compartilhamento nativo vem primeiro (dá para escolher grupo ou canal); se não houver, wa.me.
        if (newsIsMobile() && navigator.share) {
          try {
            await navigator.share({ text: message });
          } catch (error) {
            if (error?.name === "AbortError") return;
            openWhatsApp();
          }
        } else openWhatsApp();
      } else if (navigator.share) await navigator.share({ title: "SKALAMA News", text, url });
      else { await navigator.clipboard.writeText(url); notify("Link da notícia copiado."); }
      newsCount(post, "share");
    } catch (error) {
      if (error?.name !== "AbortError") notify("Não deu para compartilhar. Copie o endereço da página.", true);
    }
  }
  const NEWS_WA_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 2s.8 2.3.9 2.5c.1.2 1.6 2.5 4 3.5 1.5.6 2 .7 2.8.6.4-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3Z"/></svg>',
    NEWS_COPY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H6a2 2 0 0 0-2 2v12h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16h-9V7h9v14Z"/></svg>';
  // Botões de divulgação (só organizador, só notícia publicada).
  function newsShareTools(post, compact = false) {
    if (isEditLocked() || !newsIsPublic(post)) return "";
    const buttons = '<div class="news-share-buttons"><button type="button" class="news-share-btn news-share-wa" data-news-wa="' + escapeHtml(post.id) + '">' + NEWS_WA_ICON + "<span>Enviar pro WhatsApp</span></button>" +
      '<button type="button" class="news-share-btn news-share-copy" data-news-copy="' + escapeHtml(post.id) + '">' + NEWS_COPY_ICON + "<span>Copiar mensagem</span></button></div>";
    if (compact) return '<div class="news-card-share">' + buttons + "</div>";
    const fresh = newsJustPublished === post.id;
    return '<section class="news-share-tools' + (fresh ? " is-fresh" : "") + '" aria-label="Divulgar no WhatsApp">' +
      "<p><strong>" + (fresh ? "✅ Notícia publicada! Agora é só divulgar no WhatsApp:" : "📣 Divulgar no WhatsApp") + "</strong></p>" + buttons +
      '<small>Grupos: use <b>Enviar pro WhatsApp</b>. Canal: toque em <b>Copiar mensagem</b> e cole no canal.</small>' +
      '<pre class="news-share-preview" aria-label="Prévia da mensagem">' + escapeHtml(newsShareText(post)) + "</pre></section>";
  }
  function openNewsFromHash() {
    const match = location.hash.match(/^#noticia-(.+)$/);
    if (!match) return false;
    setView("news");
    newsOpenSlug = decodeURIComponent(match[1]);
    renderNews();
    loadNews(true).then(() => { const post = newsPosts.find((item) => item.slug === newsOpenSlug); if (post) newsCount(post, "view"); });
    return true;
  }

  // ---------- Editor (só organizador) ----------
  function newsSlug(title) {
    const base = String(title || "noticia").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "noticia";
    return base + "-" + crypto.randomUUID().slice(0, 4);
  }
  function newsKnownPlayers() {
    const names = new Map();
    const add = (name) => { if (name && !names.has(playerKey(name))) names.set(playerKey(name), name); };
    (state.roster || []).forEach(add);
    (state.superLiga?.teams || []).forEach((team) => team.players.forEach(add));
    (state.gameHistory || []).forEach((game) => [...(game.homePlayers || []), ...(game.awayPlayers || []), ...(game.homeBench || []), ...(game.awayBench || [])].forEach(add));
    return [...names.values()].sort((a, b) => displayName(a).localeCompare(displayName(b), "pt-BR"));
  }
  function newsLocalInput(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function newsStartDraft(post = null) {
    newsDraft = post
      ? JSON.parse(JSON.stringify({ ...post, players: post.news_post_players || [], highlights: post.news_highlights || [], media: post.news_media || [], isNew: false }))
      : { id: crypto.randomUUID(), slug: "", title: "", subtitle: "", excerpt: "", content: "", category: "resultado", status: "draft", is_featured: false, scheduled_for: null, published_at: null, cover_image_url: "", match_id: null, round_id: null, views_count: 0, shares_count: 0, players: [], highlights: [], media: [], isNew: true };
    newsOpenSlug = null;
    renderNews();
    $("news")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // Lê o formulário para o rascunho antes de redesenhar ou salvar.
  function newsCollect() {
    if (!newsDraft) return;
    const value = (id) => $(id)?.value ?? "";
    Object.assign(newsDraft, {
      title: value("newsTitle").trim(),
      subtitle: value("newsSubtitle").trim(),
      excerpt: value("newsExcerpt").trim(),
      content: value("newsContent"),
      category: value("newsCategory") || "resultado",
      status: value("newsStatus") || "draft",
      is_featured: !!$("newsFeatured")?.checked,
      scheduled_for: value("newsSchedule") ? new Date(value("newsSchedule")).toISOString() : null,
      cover_image_url: value("newsCover").trim(),
      match_id: value("newsMatch") || null,
    });
    const rows = (selector, map) => [...document.querySelectorAll(selector)].map(map);
    newsDraft.players = rows("[data-news-player-row]", (row) => ({ player_name: row.querySelector("[data-f=name]").value.trim(), role: row.querySelector("[data-f=role]").value, goals: Math.max(0, Number(row.querySelector("[data-f=goals]").value) || 0) }));
    newsDraft.highlights = rows("[data-news-highlight-row]", (row) => ({ type: row.querySelector("[data-f=type]").value, player_name: row.querySelector("[data-f=name]").value.trim(), value: row.querySelector("[data-f=value]").value === "" ? null : Number(String(row.querySelector("[data-f=value]").value).replace(",", ".")), label: row.querySelector("[data-f=label]").value.trim() }));
    newsDraft.media = rows("[data-news-media-row]", (row, index) => ({ url: row.querySelector("[data-f=url]").value.trim(), caption: row.querySelector("[data-f=caption]").value.trim(), type: "image", order_index: index }));
  }
  function renderNewsEditor() {
    const editor = $("newsEditor"), d = newsDraft;
    const option = (value, label, current) => '<option value="' + escapeHtml(value) + '"' + (String(current) === String(value) ? " selected" : "") + ">" + escapeHtml(label) + "</option>";
    const games = [...(state.gameHistory || [])].sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
    const known = newsKnownPlayers();
    editor.innerHTML =
      '<div class="news-post-actions"><button type="button" class="button button-outline button-small" data-news-cancel>← Cancelar</button></div>' +
      '<form class="news-form" id="newsForm" novalidate>' +
      "<h3>" + (d.isNew ? "Nova notícia" : "Editar notícia") + "</h3>" +
      '<div class="news-generate"><label>Jogo relacionado (opcional)<select id="newsMatch"><option value="">Nenhum</option>' + games.map((game) => option(game.id, "Jogo " + game.number + " · " + gameTeamLabel(game, "home") + " " + game.homeScore + " × " + game.awayScore + " " + gameTeamLabel(game, "away") + (game.superLigaId ? " · Super Liga" : ""), d.match_id || "")).join("") + '</select></label><button type="button" class="button button-dark button-small" data-news-generate' + (games.length ? "" : " disabled") + '>Gerar texto do jogo</button></div>' +
      '<div class="fields two"><label>Título<input id="newsTitle" maxlength="140" required value="' + escapeHtml(d.title) + '" placeholder="Ex.: Águia atropela o Sol e segue no topo"></label><label>Subtítulo<input id="newsSubtitle" maxlength="200" value="' + escapeHtml(d.subtitle || "") + '"></label></div>' +
      '<label class="news-field">Resumo (aparece no card)<textarea id="newsExcerpt" maxlength="280" rows="2">' + escapeHtml(d.excerpt || "") + "</textarea></label>" +
      '<label class="news-field">Texto da notícia<textarea id="newsContent" rows="10" placeholder="Deixe uma linha em branco entre os parágrafos. **Assim** fica em negrito.">' + escapeHtml(d.content || "") + "</textarea></label>" +
      '<div class="fields three"><label>Categoria<select id="newsCategory">' + Object.entries(NEWS_CATEGORIES).map(([key, label]) => option(key, label, d.category)).join("") + '</select></label><label>Situação<select id="newsStatus">' + Object.entries(NEWS_STATUS).map(([key, label]) => option(key, label, d.status)).join("") + '</select></label><label>Agendar para<input id="newsSchedule" type="datetime-local" value="' + escapeHtml(newsLocalInput(d.scheduled_for)) + '"></label></div>' +
      '<div class="fields two"><label>Imagem de capa (endereço https://, opcional)<input id="newsCover" type="url" inputmode="url" value="' + escapeHtml(d.cover_image_url || "") + '" placeholder="https://…"></label><label class="news-check"><input id="newsFeatured" type="checkbox"' + (d.is_featured ? " checked" : "") + "> Destaque da capa do News</label></div>" +
      '<datalist id="newsPlayersList">' + known.map((name) => '<option value="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + "</option>").join("") + "</datalist>" +
      '<fieldset class="news-rows"><legend>Jogadores na notícia</legend>' + d.players.map((p, i) => '<div class="news-row" data-news-player-row><input data-f="name" list="newsPlayersList" placeholder="Nome" value="' + escapeHtml(p.player_name || "") + '" aria-label="Jogador"><select data-f="role" aria-label="Papel">' + Object.entries(NEWS_ROLES).map(([key, label]) => option(key, label, p.role || "mentioned")).join("") + '</select><input data-f="goals" type="number" min="0" max="20" value="' + (Number(p.goals) || 0) + '" aria-label="Gols"><button type="button" class="text-button" data-news-remove="players" data-index="' + i + '">Remover</button></div>').join("") + '<button type="button" class="button button-outline button-small" data-news-add="players">+ Jogador</button></fieldset>' +
      '<fieldset class="news-rows"><legend>Destaques (cards na notícia)</legend>' + d.highlights.map((h, i) => '<div class="news-row" data-news-highlight-row><select data-f="type" aria-label="Tipo">' + Object.entries(NEWS_HIGHLIGHTS).map(([key, label]) => option(key, label, h.type || "player_of_the_night")).join("") + '</select><input data-f="name" list="newsPlayersList" placeholder="Jogador" value="' + escapeHtml(h.player_name || "") + '" aria-label="Jogador"><input data-f="value" inputmode="decimal" placeholder="Nota ou gols" value="' + escapeHtml(h.value ?? "") + '" aria-label="Valor"><input data-f="label" placeholder="Título do card (opcional)" value="' + escapeHtml(h.label || "") + '" aria-label="Título"><button type="button" class="text-button" data-news-remove="highlights" data-index="' + i + '">Remover</button></div>').join("") + '<button type="button" class="button button-outline button-small" data-news-add="highlights">+ Destaque</button></fieldset>' +
      '<fieldset class="news-rows"><legend>Fotos (endereços https://)</legend>' + d.media.map((m, i) => '<div class="news-row" data-news-media-row><input data-f="url" type="url" placeholder="https://…" value="' + escapeHtml(m.url || "") + '" aria-label="Endereço da foto"><input data-f="caption" placeholder="Legenda (opcional)" value="' + escapeHtml(m.caption || "") + '" aria-label="Legenda"><button type="button" class="text-button" data-news-remove="media" data-index="' + i + '">Remover</button></div>').join("") + '<button type="button" class="button button-outline button-small" data-news-add="media">+ Foto</button></fieldset>' +
      '<div class="button-row news-form-actions"><button type="submit" class="button button-primary">Salvar notícia</button>' +
      (!d.isNew ? '<button type="button" class="button button-outline" data-news-archive>' + (d.status === "archived" ? "Tirar do arquivo" : "Arquivar") + '</button><button type="button" class="button button-danger" data-news-delete>Apagar</button>' : "") +
      "</div></form>";
  }
  // Rascunho em tom de resenha da pelada, a partir de um jogo do histórico.
  function newsGenerateFromGame() {
    newsCollect();
    const game = (state.gameHistory || []).find((item) => item.id === newsDraft.match_id);
    if (!game) { notify("Escolha um jogo para gerar o texto.", true); return; }
    const home = gameTeamLabel(game, "home"), away = gameTeamLabel(game, "away"),
      hs = Number(game.homeScore) || 0, as = Number(game.awayScore) || 0,
      shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null,
      winnerSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      winner = winnerSide ? gameTeamLabel(game, winnerSide) : "", loser = winnerSide === "home" ? away : winnerSide === "away" ? home : "",
      where = state.venue || "na quadra", mode = game.superLigaId ? (game.stage === "final" ? "na final da Super Liga" : game.stage === "amistoso" ? "no amistoso da Super Liga" : "pela Super Liga") : "na Liga",
      goalsList = (game.goals || []).filter((goal) => goal.player && !goal.ownGoal),
      byPlayer = new Map();
    for (const goal of goalsList) byPlayer.set(goal.player, (byPlayer.get(goal.player) || 0) + 1);
    const scorers = [...byPlayer.entries()].sort((a, b) => b[1] - a[1]),
      perf = gamePerformance(game),
      best = [...perf].filter((p) => p.role === "linha").sort((a, b) => b.score - a.score)[0],
      gk = [...perf].filter((p) => p.role === "goleiro").sort((a, b) => b.score - a.score)[0];
    const title = !winnerSide
      ? home + " e " + away + " ficam no " + hs + " a " + as
      : hs === as
        ? winner + " leva a melhor nos pênaltis contra " + loser
        : Math.abs(hs - as) >= 3
          ? winner + " atropela " + loser + ": " + Math.max(hs, as) + " a " + Math.min(hs, as)
          : winner + " vence " + loser + " por " + Math.max(hs, as) + " a " + Math.min(hs, as);
    const excerpt = "Jogo " + game.number + " " + mode + ", " + where + ". " + (scorers.length ? "Gols de " + scorers.map(([name, n]) => displayName(name) + (n > 1 ? " (" + n + ")" : "")).join(", ") + "." : "Placar sem gols, mas com muita disputa.");
    const paragraphs = [
      !winnerSide
        ? "Ninguém quis sair perdendo: **" + home + "** e **" + away + "** empataram em " + hs + " a " + as + " " + mode + ". Jogo pegado do começo ao fim."
        : hs === as
          ? "Foi no sufoco! Depois do " + hs + " a " + as + " no tempo normal, **" + winner + "** levou a melhor nos pênaltis (" + shoot.homeScore + " × " + shoot.awayScore + ") e despachou o " + loser + "."
          : "**" + winner + "** fez a festa " + mode + " e passou pelo " + loser + " por " + Math.max(hs, as) + " a " + Math.min(hs, as) + ". " + (Math.abs(hs - as) >= 3 ? "Passeio de bola, sem dó." : "Vitória suada, decidida nos detalhes."),
      scorers.length ? "Na rede: " + scorers.map(([name, n]) => "**" + displayName(name) + "**" + (n > 1 ? " (" + n + " gols)" : "")).join(", ") + "." : "",
      best ? "O craque do jogo foi **" + displayName(best.player) + "**, com nota " + Number(best.score).toFixed(1).replace(".", ",") + ". Jogou muita bola!" : "",
      gk ? "Debaixo das traves, **" + displayName(gk.player) + "** fechou o gol e levou nota " + Number(gk.score).toFixed(1).replace(".", ",") + "." : "",
      "Semana que vem tem mais. Bora, SKALAMA!",
    ].filter(Boolean);
    Object.assign(newsDraft, {
      title,
      excerpt,
      content: paragraphs.join("\n\n"),
      category: "resultado",
      round_id: NEWS_UUID.test(String(game.roundId || "")) ? game.roundId : null,
      players: [
        ...scorers.map(([name, n]) => ({ player_name: name, role: "scorer", goals: n })),
        ...(best && !byPlayer.has(best.player) ? [{ player_name: best.player, role: "player_of_the_night", goals: 0 }] : []),
        ...(gk ? [{ player_name: gk.player, role: "goalkeeper_of_the_night", goals: 0 }] : []),
      ],
      highlights: [
        ...(best ? [{ type: "player_of_the_night", player_name: best.player, value: Number(best.score), label: "Craque do jogo" }] : []),
        ...(gk ? [{ type: "goalkeeper_of_the_night", player_name: gk.player, value: Number(gk.score), label: "Paredão" }] : []),
        ...(scorers.length ? [{ type: "top_scorer", player_name: scorers[0][0], value: scorers[0][1], label: "Artilheiro do jogo" }] : []),
      ],
    });
    renderNewsEditor();
    notify("Texto gerado. Revise, ajuste do seu jeito e salve.");
  }
  async function saveNews(changes = {}, message) {
    newsCollect();
    const d = { ...newsDraft, ...changes };
    if (!d.title) { notify("A notícia precisa de um título.", true); $("newsTitle")?.focus(); return; }
    if (d.status === "scheduled" && !d.scheduled_for) { notify("Escolha a data e o horário do agendamento.", true); $("newsSchedule")?.focus(); return; }
    if (d.cover_image_url && !newsSafeUrl(d.cover_image_url)) { notify("A imagem de capa precisa de um endereço que comece com https://.", true); return; }
    if (d.media.some((m) => m.url && !newsSafeUrl(m.url))) { notify("Os endereços das fotos precisam começar com https://.", true); return; }
    const now = new Date().toISOString();
    const row = {
      id: d.id,
      slug: d.slug || newsSlug(d.title),
      title: d.title,
      subtitle: d.subtitle || null,
      excerpt: d.excerpt || null,
      content: d.content || null,
      category: d.category,
      status: d.status,
      is_featured: !!d.is_featured,
      scheduled_for: d.status === "scheduled" ? d.scheduled_for : null,
      published_at: d.status === "published" ? d.published_at || now : d.status === "scheduled" ? d.scheduled_for : d.published_at || null,
      cover_image_url: d.cover_image_url || null,
      match_id: NEWS_UUID.test(String(d.match_id || "")) ? d.match_id : null,
      round_id: NEWS_UUID.test(String(d.round_id || "")) ? d.round_id : null,
      deleted_at: d.deleted_at || null,
    };
    const players = d.players.filter((p) => p.player_name).map((p) => ({ post_id: row.id, player_name: p.player_name, role: p.role || "mentioned", goals: Number(p.goals) || 0 })),
      highlights = d.highlights.filter((h) => h.player_name || h.label).map((h) => ({ post_id: row.id, player_name: h.player_name || null, type: h.type, value: Number.isFinite(h.value) ? h.value : null, label: h.label || null })),
      media = d.media.filter((m) => m.url).map((m, i) => ({ post_id: row.id, url: m.url, type: "image", caption: m.caption || null, order_index: i }));
    if (isEditLocked()) { notify("Somente o organizador autorizado pode alterar as notícias.", true); return; }
    try {
      if (shared && client) {
        const { error } = await client.from("news_posts").upsert(row);
        if (error) throw error;
        for (const [table, items] of [["news_post_players", players], ["news_highlights", highlights], ["news_media", media]]) {
          const removed = await client.from(table).delete().eq("post_id", row.id);
          if (removed.error) throw removed.error;
          if (items.length) { const added = await client.from(table).insert(items); if (added.error) throw added.error; }
        }
      } else {
        const local = newsLocalRead().filter((item) => item.id !== row.id);
        const previous = newsLocalRead().find((item) => item.id === row.id);
        local.push({ ...row, views_count: previous?.views_count || 0, shares_count: previous?.shares_count || 0, created_at: previous?.created_at || now, updated_at: now, news_post_players: players, news_highlights: highlights, news_media: media });
        newsLocalWrite(local);
      }
    } catch (error) {
      notify("Não deu para salvar a notícia: " + (error.message || error), true);
      return;
    }
    newsDraft = null;
    newsJustPublished = row.status === "published" && !row.deleted_at ? row.id : null;
    await loadNews(true);
    notify(message || (row.status === "published" ? "Notícia publicada." : row.status === "scheduled" ? "Notícia agendada para " + newsWhen(row.scheduled_for) + "." : row.status === "archived" ? "Notícia arquivada." : "Rascunho salvo.") + (shared ? "" : " (somente neste navegador)"));
    if (!row.deleted_at && row.status !== "archived") openNewsPost(row.slug);
  }
  async function deleteNews() {
    if (!newsDraft || newsDraft.isNew) return;
    if (!(await askConfirm({ title: "Apagar notícia?", message: "Ela some do SKALAMA News para todo mundo.", confirmText: "Apagar", tone: "red" }))) return;
    await saveNews({ deleted_at: new Date().toISOString() }, "Notícia apagada.");
    closeNewsPost();
  }
  // ---------- Notificações push do SKALAMA News ----------
  // A permissão só é pedida quando a pessoa toca em "Receber notícias".
  const pushInfo = { reg: null, sub: null, busy: false, checked: false };
  function pushIsIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function pushStandalone() {
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  }
  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }
  function pushAvailable() {
    return !!(shared && client && window.LIGA_CONFIG?.vapidPublicKey);
  }
  function pushKey() {
    const key = window.LIGA_CONFIG.vapidPublicKey, pad = "=".repeat((4 - (key.length % 4)) % 4);
    const raw = atob((key + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }
  async function savePushSubscription(sub) {
    const data = sub.toJSON();
    const { error } = await client.rpc("subscribe_push", { p_endpoint: data.endpoint, p_p256dh: data.keys.p256dh, p_auth: data.keys.auth, p_user_agent: navigator.userAgent.slice(0, 300) });
    if (error) throw error;
  }
  // Toque na notificação com o site já aberto: o service worker pede para abrir a notícia.
  function openUrlFromPush(url) {
    try {
      const target = new URL(url, location.href);
      if (target.hash.startsWith("#noticia-")) {
        if (location.hash === target.hash) openNewsFromHash();
        else location.hash = target.hash;
      }
    } catch {}
  }
  async function initPush() {
    if (pushAvailable() && pushSupported()) {
      navigator.serviceWorker.addEventListener("message", (event) => { if (event.data?.type === "skalama-open-url") openUrlFromPush(event.data.url); });
      try {
        pushInfo.reg = await navigator.serviceWorker.register("/sw.js");
        pushInfo.sub = await pushInfo.reg.pushManager.getSubscription();
        // Mantém o servidor em dia (por exemplo, se a inscrição foi descartada depois de falhas).
        if (pushInfo.sub && Notification.permission === "granted") savePushSubscription(pushInfo.sub).catch(() => {});
      } catch (error) {
        console.warn("Notificações indisponíveis:", error);
      }
    }
    pushInfo.checked = true;
    renderNewsPush();
  }
  function renderNewsPush() {
    const box = $("newsPush");
    if (!box) return;
    const ios = pushIsIOS();
    let html = "";
    if (!pushAvailable()) html = "";
    else if (ios && !pushStandalone())
      html = '<p class="news-push-text">🔔 <strong>Quer receber as notícias no celular?</strong> No iPhone, toque em Compartilhar › Adicionar à Tela de Início e abra o site por lá para ativar.</p>';
    else if (!pushSupported() || !pushInfo.checked) html = "";
    else if (Notification.permission === "denied")
      html = '<p class="news-push-text">🔕 <strong>As notificações estão bloqueadas neste navegador.</strong> Para liberar, toque no cadeado (ou no ícone de configurações) ao lado do endereço do site, permita <b>Notificações</b> e recarregue a página.' +
        (ios ? " No iPhone, vá em Ajustes › Notificações › LIGA SKALAMA e ative Permitir Notificações." : " No celular Android, também dá em Configurações › Apps › Chrome › Notificações.") + "</p>";
    else if (pushInfo.sub)
      html = '<div class="news-push-on"><span>🔔 Notificações ativadas</span><button type="button" class="text-button" data-push-off' + (pushInfo.busy ? " disabled" : "") + ">Desativar</button>" +
        (!isEditLocked() ? '<button type="button" class="button button-outline button-small" data-push-test' + (pushInfo.busy ? " disabled" : "") + ">Enviar notificação de teste</button>" : "") + "</div>";
    else
      html = '<div class="news-push-off"><button type="button" class="button button-primary news-push-btn" data-push-on' + (pushInfo.busy ? " disabled" : "") + '>🔔 Receber notícias</button><p class="news-push-text">Avisamos no seu celular ou computador quando sair notícia nova.' +
        (!isEditLocked() ? " Depois de ativar, aparece o botão de notificação de teste." : "") + "</p></div>";
    box.hidden = !html;
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  async function enablePush() {
    if (pushInfo.busy) return;
    pushInfo.busy = true;
    renderNewsPush();
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        if (permission === "default") notify("Tudo bem, você pode ativar depois.");
        return;
      }
      pushInfo.reg = pushInfo.reg || (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const sub = (await pushInfo.reg.pushManager.getSubscription()) || (await pushInfo.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKey() }));
      try {
        await savePushSubscription(sub);
      } catch (error) {
        await sub.unsubscribe().catch(() => {});
        throw error;
      }
      pushInfo.sub = sub;
      notify("Pronto! Você vai receber as notícias da liga neste aparelho.");
    } catch (error) {
      notify("Não deu para ativar as notificações: " + (error.message || error), true);
    } finally {
      pushInfo.busy = false;
      renderNewsPush();
    }
  }
  async function disablePush() {
    if (pushInfo.busy || !pushInfo.sub) return;
    pushInfo.busy = true;
    renderNewsPush();
    try {
      await client.rpc("unsubscribe_push", { p_endpoint: pushInfo.sub.endpoint });
      await pushInfo.sub.unsubscribe();
      pushInfo.sub = null;
      notify("Notificações desativadas neste aparelho.");
    } catch (error) {
      notify("Não deu para desativar: " + (error.message || error), true);
    } finally {
      pushInfo.busy = false;
      renderNewsPush();
    }
  }
  // Organizador: manda um aviso só para este aparelho.
  async function sendTestPush() {
    if (pushInfo.busy || !pushInfo.sub || isEditLocked()) return;
    pushInfo.busy = true;
    renderNewsPush();
    try {
      const { data, error } = await client.functions.invoke("notify-news", { body: { test: true, endpoint: pushInfo.sub.endpoint } });
      if (error) {
        let message = error.message;
        try { message = (await error.context.json()).error || message; } catch {}
        throw new Error(message);
      }
      if (data?.ok) notify("Teste enviado. A notificação deve chegar em alguns segundos.");
      else notify("O serviço de notificação não aceitou este aparelho. Desative e ative de novo.", true);
    } catch (error) {
      notify("Não deu para enviar o teste: " + (error.message || error), true);
    } finally {
      pushInfo.busy = false;
      renderNewsPush();
    }
  }
  function bindNewsPush() {
    $("newsPush")?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-push-on],[data-push-off],[data-push-test]");
      if (!target || target.disabled) return;
      if ("pushOn" in target.dataset) enablePush();
      else if ("pushOff" in target.dataset) disablePush();
      else if ("pushTest" in target.dataset) sendTestPush();
    });
  }
  function bindNews() {
    const section = $("news");
    if (!section) return;
    section.addEventListener("click", (event) => {
      const target = event.target.closest("[data-news-open],[data-news-filter],[data-news-back],[data-news-new],[data-news-edit],[data-news-cancel],[data-news-share],[data-news-generate],[data-news-add],[data-news-remove],[data-news-archive],[data-news-delete],[data-news-wa],[data-news-copy]");
      if (!target || target.disabled) return;
      const data = target.dataset;
      if (data.newsOpen) { event.preventDefault(); openNewsPost(data.newsOpen); }
      else if (data.newsFilter) { newsFilter = data.newsFilter; renderNews(); }
      else if ("newsBack" in data) closeNewsPost();
      else if ("newsNew" in data) newsStartDraft();
      else if (data.newsEdit) newsStartDraft(newsPosts.find((post) => post.id === data.newsEdit));
      else if ("newsCancel" in data) { newsDraft = null; renderNews(); }
      else if (data.newsShare) shareNews(data.newsShare);
      else if (data.newsWa) shareNews(data.newsWa, "whatsapp");
      else if (data.newsCopy) shareNews(data.newsCopy, "copy");
      else if ("newsGenerate" in data) newsGenerateFromGame();
      else if (data.newsAdd) { newsCollect(); newsDraft[data.newsAdd].push(data.newsAdd === "players" ? { player_name: "", role: "mentioned", goals: 0 } : data.newsAdd === "highlights" ? { type: "player_of_the_night", player_name: "", value: null, label: "" } : { url: "", caption: "" }); renderNewsEditor(); }
      else if (data.newsRemove) { newsCollect(); newsDraft[data.newsRemove].splice(Number(data.index), 1); renderNewsEditor(); }
      else if ("newsArchive" in data) saveNews({ status: newsDraft.status === "archived" ? "draft" : "archived" }, newsDraft.status === "archived" ? "Notícia voltou para rascunho." : "Notícia arquivada.");
      else if ("newsDelete" in data) deleteNews();
    });
    section.addEventListener("submit", (event) => {
      if (event.target.id !== "newsForm") return;
      event.preventDefault();
      saveNews();
    });
    // Agendar uma data já muda a situação para "Agendada".
    section.addEventListener("change", (event) => {
      if (event.target.id === "newsSchedule" && event.target.value && $("newsStatus")) $("newsStatus").value = "scheduled";
    });
    window.addEventListener("hashchange", () => {
      if (!openNewsFromHash() && newsOpenSlug) { newsOpenSlug = null; renderNews(); }
    });
  }
  function renderAll() {
    if (!state) return;
    if (document.activeElement !== $("venue"))
      $("venue").value = state.venue || "";
    if (document.activeElement !== $("matchDate"))
      $("matchDate").value = state.matchDate || "";
    if (document.activeElement !== $("startTime"))
      $("startTime").value = state.startTime || "";
    if (document.activeElement !== $("assistScoreRule")) $("assistScoreRule").value = String(Number(state.scoreRules?.assist ?? SCORE_RULES.assist));
    document.querySelectorAll(".assist-rule-display").forEach((node) => { node.textContent = "+" + Number(state.scoreRules?.assist ?? SCORE_RULES.assist).toFixed(1); });
    renderRoster();
    renderTeams();
    renderFixtures();
    renderLineupAdjustments();
    renderReserveControls();
    renderQueueControls();
    renderGoalOptions();
    renderGoals();
    renderScoreRankings();
    renderStandings();
    renderKeeperChoices();
    renderHistory();
    renderHistoricalStandings();
    renderIncidents();
    renderSeasonHighlights();
    renderIndividualStats();
    renderWeeklyPublications();
    renderNightHighlights();
    renderTimer();
    renderArt();
    renderSuperLiga();
    if (!newsDraft) renderNews();
    renderNewsPush();
    renderNewsHero();
    renderHomeNext();
    renderHomeVisibility();
    markActiveTab();
    applyEditLock();
  }
  const artShield = new Image();
  artShield.src = "./assets/escudo-skalama-oficial.png";
  artShield.onload = () => drawArt(true);
  const TEAM_NAMES = ["Time Águia", "Time Sol", "Time Verde", "Time Azul"];
  const LOGO_KEY = "liga-skalama-team-logos";
  // Logos dos times ficam só neste aparelho (localStorage), por escolha do organizador.
  let teamLogos = {};
  try {
    teamLogos = JSON.parse(localStorage.getItem(LOGO_KEY) || "{}");
  } catch {
    teamLogos = {};
  }
  const logoImages = {};
  function logoImage(name) {
    const src = fixedCrest(name) || teamLogos[name];
    if (!src) return null;
    // Compara com o endereço pedido (image.src vira endereço completo e nunca bateria com "./assets/...").
    if (logoImages[name]?.dataset.source !== src) {
      const image = new Image();
      image.dataset.source = src;
      image.onload = () => drawArt(true);
      image.src = src;
      logoImages[name] = image;
    }
    return logoImages[name].complete && logoImages[name].naturalWidth
      ? logoImages[name]
      : null;
  }
  function saveTeamLogos() {
    try {
      localStorage.setItem(LOGO_KEY, JSON.stringify(teamLogos));
      return true;
    } catch {
      notify("Não foi possível guardar o logo neste aparelho (sem espaço).", true);
      return false;
    }
  }
  // Reduz o logo para 256px antes de guardar, para caber no localStorage.
  function uploadTeamLogo(team, file) {
    if (!file?.type.startsWith("image/")) {
      notify("Escolha um arquivo de imagem (PNG, JPG ou SVG).", true);
      return;
    }
    const url = URL.createObjectURL(file),
      image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 256 / Math.max(image.width, image.height)),
        canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      teamLogos = { ...teamLogos, [team]: canvas.toDataURL("image/png") };
      if (saveTeamLogos()) notify("Logo salvo neste aparelho.");
      renderAll();
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      notify("Não foi possível ler essa imagem.", true);
    };
    image.src = url;
  }
  function removeTeamLogo(team) {
    const { [team]: _removed, ...rest } = teamLogos;
    teamLogos = rest;
    saveTeamLogos();
    renderAll();
  }
  // ---------- Divulgação: artes para redes ----------
  // Painel em 3 passos; a arte é desenhada no canvas #artCanvas e baixada dele (toBlob), como antes.
  // Fontes (Anton e Inter, hospedadas no site) e escudos são carregados ANTES de desenhar.
  const ART = { type: "result", gameId: "", format: "story", goals: true, star: true, stripe: false, scope: "" };
  const AX_Y = "#ffc400", AX_DISPLAY = '"Anton", "Arial Narrow", Impact, sans-serif', AX_TEXT = '"Inter", system-ui, sans-serif';
  const AX_ICONS = {
    result: '<path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 5v14M8 10v4M16 10v4" stroke="currentColor" stroke-width="2"/>',
    teams: '<circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5M10.5 19c.5-3 2.7-5 5.5-5s5 2 5.5 5" fill="none" stroke="currentColor" stroke-width="2"/>',
    champion: '<path d="M7 4h10v3a5 5 0 0 1-10 0V4Zm-3 1h3v3a3 3 0 0 1-3-3Zm16 0h-3v3a3 3 0 0 0 3-3ZM12 12v4m-4 4h8m-6-4h4v4h-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    night: '<path d="m12 3 2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    scorers: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="m12 7.5 3.2 2.3-1.2 3.8h-4l-1.2-3.8Z"/>',
    next: '<rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2"/>',
  };
  const AX_TYPES = [["result", "Resultado de jogo"], ["teams", "Times sorteados"], ["champion", "Campeão"], ["night", "Destaques da noite"], ["scorers", "Artilharia"], ["next", "Próximo jogo"]];
  let artKey = "", artToken = 0, artDone = Promise.resolve(), axFontsPromise = null;
  const axImages = new Map();
  function colorOf(name) {
    const sl = superTeam(name);
    if (sl) return SUPER_COLORS[sl.color] || SUPER_COLORS[0];
    const index = TEAM_NAMES.indexOf(name);
    if (index >= 0) return teamColors[index];
    const past = (state?.gameHistory || []).find((game) => (game.home === name && game.homeColor) || (game.away === name && game.awayColor));
    return (past && (past.home === name ? past.homeColor : past.awayColor)) || teamColors[0];
  }
  function artGames() {
    return [...(state?.gameHistory || [])].sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  }
  // ---------- Carregamento: fontes e imagens antes de desenhar ----------
  function axFontsReady() {
    if (!axFontsPromise) {
      axFontsPromise = document.fonts?.load
        ? Promise.all(['400 100px "Anton"', '600 40px "Inter"', '700 40px "Inter"', '800 40px "Inter"'].map((font) => document.fonts.load(font))).then(() => document.fonts.ready).catch(() => {})
        : Promise.resolve();
    }
    return axFontsPromise;
  }
  function axLoadImage(src) {
    if (!src) return Promise.resolve(null);
    if (!axImages.has(src)) {
      axImages.set(src, new Promise((resolve) => {
        const image = new Image();
        image.onload = () => (image.decode ? image.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(image));
        image.onerror = () => resolve(null);
        image.src = src;
      }).then((image) => { axImages.set(src, image); return image; }));
    }
    return Promise.resolve(axImages.get(src));
  }
  function axImg(src) {
    const image = src && axImages.get(src);
    return image && !(image instanceof Promise) && image.naturalWidth ? image : null;
  }
  const AX_SHIELD = "./assets/escudo-skalama-oficial.png";
  function axCrestSrc(key, label) {
    return key ? crestFor(key, label || teamLabel(key)) : "";
  }
  // ---------- Dados de cada arte ----------
  function axVenueShort() {
    return String(state?.venue || "").replace(/^(quadra|campo|arena)\s+(do|da|de|dos|das)\s+/i, "").trim().toUpperCase();
  }
  function axDate(value) {
    const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T12:00:00") : new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date : null;
  }
  function axDayMonth(value) {
    const date = axDate(value);
    return date ? date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "";
  }
  function axScorerRows(scope) {
    const games = (state.gameHistory || []).filter((game) =>
      scope === "superliga" ? !!game.superLigaId : scope === "temporada" ? !game.superLigaId : !game.superLigaId && !!state.roundId && game.roundId === state.roundId);
    const rows = new Map();
    for (const game of games)
      for (const goal of game.goals || []) {
        if (goal.ownGoal || !goal.player) continue;
        const row = rows.get(goal.player) || { name: goal.player, goals: 0, team: goal.team, teamLabel: teamName(game, goal.team) };
        row.goals++;
        row.team = goal.team; row.teamLabel = teamName(game, goal.team);
        rows.set(goal.player, row);
      }
    return [...rows.values()].sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name, "pt-BR")).slice(0, 5);
  }
  const AX_SCOPES = [["rodada", "Rodada"], ["temporada", "Temporada (Modo Liga)"], ["superliga", "Super Liga"]];
  function axNight() {
    const roundId = state.roundId || state.currentGame?.roundId,
      games = roundId ? (state.gameHistory || []).filter((game) => game.roundId === roundId) : [];
    if (!games.length) return null;
    const totals = new Map();
    for (const game of games)
      for (const p of gamePerformance(game)) {
        const key = p.role + "|" + p.player, row = totals.get(key) || { player: p.player, role: p.role, team: p.team, teamLabel: teamName(game, p.team), sum: 0, games: 0, goals: 0, conceded: 0 };
        row.sum += Number(p.score) || 0; row.games++; row.goals += Number(p.goalsFor) || 0; row.conceded += Number(p.goalsAgainst) || 0;
        totals.set(key, row);
      }
    const best = (role) => [...totals.values()].filter((row) => row.role === role && (role !== "goleiro" || row.games >= MIN_KEEPER_GAMES)).map((row) => ({ ...row, average: row.sum / row.games })).sort((a, b) => b.average - a.average || a.player.localeCompare(b.player, "pt-BR"))[0] || null;
    return { player: best("linha"), keeper: best("goleiro"), games: games.length };
  }
  function axData() {
    const type = ART.type;
    if (type === "result") {
      const games = artGames(), game = games.find((item) => item.id === ART.gameId) || games[0];
      return game ? { type, game } : { warn: "As artes de resultado aparecem depois do primeiro jogo encerrado." };
    }
    if (type === "teams") {
      const teams = (state.teams || []).map((team) => ({ key: team.name, label: teamLabel(team.name), players: lineupForTeam(team.name) }));
      return teams.length ? { type, teams, date: state.matchDate, venue: state.venue } : { warn: "Sorteie os times em Elenco e sorteio para gerar esta arte." };
    }
    if (type === "champion") {
      const sl = state.superLiga, final = sl?.status === "finished" ? superFinalGame(sl) : null;
      if (!final) return { warn: "A arte do campeão aparece quando uma Super Liga é encerrada." };
      const champion = final.winner === final.home || final.winner === final.away ? final.winner : sl.champion;
      if (!champion) return { warn: "A final ainda não tem campeão definido." };
      const side = final.home === champion ? "home" : "away";
      return { type, final, champion, side, played: slxLineup(final, side).played, keeperName: slxLineup(final, side).keeperName };
    }
    if (type === "night") {
      const night = axNight();
      return night && night.player ? { type, ...night } : { warn: "Os destaques da noite aparecem depois do primeiro jogo da rodada (Modo Liga)." };
    }
    if (type === "scorers") {
      const scope = ART.scope || "rodada", rows = axScorerRows(scope);
      return rows.length ? { type, scope, rows } : { warn: "Ainda não há gols em " + (AX_SCOPES.find(([key]) => key === scope)?.[1] || "rodada").toLowerCase() + ". Escolha outro período." };
    }
    if (type === "next") {
      if (!state.matchDate) return { warn: "Defina a data do próximo jogo em Elenco e sorteio para gerar esta arte." };
      // Vagas: lugares livres nos times sorteados (5 por time); sem sorteio, pela lista de ativos (até 20).
      const teams = (state.teams || []).map((team) => ({ key: team.name, label: teamLabel(team.name) })),
        spots = teams.length ? teams.reduce((sum, team) => sum + Math.max(0, 5 - lineupForTeam(team.key).length), 0) : Array.isArray(state.roster) && state.roster.length ? Math.max(0, 20 - activeRoster().length) : 0;
      return { type, date: state.matchDate, time: state.startTime || "", venue: state.venue || "", teams, spots };
    }
    return { warn: "Escolha o que divulgar." };
  }
  function axImagesFor(info) {
    const list = [AX_SHIELD], add = (key, label) => list.push(axCrestSrc(key, label));
    if (info.game) { add(info.game.home, gameTeamLabel(info.game, "home")); add(info.game.away, gameTeamLabel(info.game, "away")); }
    if (info.final) { add(info.final.home, gameTeamLabel(info.final, "home")); add(info.final.away, gameTeamLabel(info.final, "away")); }
    (info.teams || []).forEach((team) => add(team.key, team.label));
    (info.rows || []).forEach((row) => add(row.team, row.teamLabel));
    if (info.player) add(info.player.team, info.player.teamLabel);
    if (info.keeper) add(info.keeper.team, info.keeper.teamLabel);
    return [...new Set(list.filter(Boolean))];
  }
  // ---------- Desenho: peças comuns ----------
  function axFont(ctx, weight, size, display) {
    ctx.font = (display ? "400 " : weight + " ") + size + "px " + (display ? AX_DISPLAY : AX_TEXT);
  }
  function axSpacing(ctx, px) {
    if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px";
  }
  function axFit(ctx, text, weight, size, maxWidth, display, min = 14) {
    let s = size;
    do axFont(ctx, weight, s, display); while (ctx.measureText(text).width > maxWidth && --s > min);
    return s;
  }
  function axRound(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  }
  function axBackground(ctx, W, H) {
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.strokeStyle = "rgba(255,196,0,0.045)";
    ctx.lineWidth = 16;
    for (let x = -H; x < W + H; x += 64) { ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x + H, 0); ctx.stroke(); }
    if (ART.stripe) {
      // Faixa diagonal amarela atrás do conteúdo (como no escudo do lobo), translúcida para não atrapalhar a leitura.
      const grad = ctx.createLinearGradient(0, H, W, 0);
      grad.addColorStop(0, "rgba(255,196,0,0.30)"); grad.addColorStop(1, "rgba(255,196,0,0.16)");
      ctx.fillStyle = grad;
      const band = W * 0.34;
      ctx.beginPath(); ctx.moveTo(-band, H * 0.78); ctx.lineTo(W, H * 0.78 - W - band * 0.2); ctx.lineTo(W + band, H * 0.78 - W + band * 0.4); ctx.lineTo(0, H * 0.78 + band * 1.1); ctx.closePath(); ctx.fill();
    }
    const vignette = ctx.createRadialGradient(W / 2, H * 0.32, 40, W / 2, H * 0.32, H * 0.9);
    vignette.addColorStop(0, "rgba(255,196,0,0.08)"); vignette.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = vignette; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  // Marca: escudo da liga + frase + LIGA SKALAMA. Devolve o y abaixo.
  function axBrand(ctx, W, top, story) {
    const shield = axImg(AX_SHIELD), size = story ? 132 : 96;
    if (shield) { const w = (size * shield.naturalWidth) / shield.naturalHeight; ctx.drawImage(shield, (W - w) / 2, top, w, size); }
    let y = top + size + (story ? 44 : 34);
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#c9c9c1";
    axFont(ctx, 700, story ? 24 : 20); axSpacing(ctx, 6);
    ctx.fillText("FUTEBOL · AMIZADE · COMPETIÇÃO", W / 2, y);
    axSpacing(ctx, 2);
    y += story ? 92 : 72;
    axFont(ctx, 0, story ? 92 : 70, true);
    const a = "LIGA ", b = "SKALAMA", wa = ctx.measureText(a).width, wb = ctx.measureText(b).width, x0 = W / 2 - (wa + wb) / 2;
    ctx.textAlign = "left"; ctx.fillStyle = "#ffffff"; ctx.fillText(a, x0, y); ctx.fillStyle = AX_Y; ctx.fillText(b, x0 + wa, y);
    ctx.textAlign = "center"; axSpacing(ctx, 0);
    return y + (story ? 34 : 26);
  }
  // Etiquetas de contexto em pílulas: { text, style: "white" | "yellow" | "outline" }.
  function axPills(ctx, W, y, pills, story) {
    const h = story ? 58 : 48, gap = 14, size = story ? 24 : 20;
    axFont(ctx, 800, size); axSpacing(ctx, 2);
    const widths = pills.map((pill) => ctx.measureText(pill.text).width + (story ? 48 : 40)), total = widths.reduce((s, w) => s + w, 0) + gap * (pills.length - 1);
    let x = (W - total) / 2;
    pills.forEach((pill, index) => {
      const w = widths[index];
      axRound(ctx, x, y, w, h, h / 2);
      if (pill.style === "outline") { ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 3; ctx.stroke(); ctx.fillStyle = "#ffffff"; }
      else { ctx.fillStyle = pill.style === "yellow" ? AX_Y : "#ffffff"; ctx.fill(); ctx.fillStyle = "#0b0b0b"; }
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(pill.text, x + w / 2, y + h / 2 + 1);
      x += w + gap;
    });
    ctx.textBaseline = "alphabetic"; axSpacing(ctx, 0);
    return y + h;
  }
  function axCrest(ctx, key, label, cx, cy, size, dim = false) {
    const image = axImg(axCrestSrc(key, label));
    ctx.save();
    if (dim) { ctx.globalAlpha = 0.55; if ("filter" in ctx) ctx.filter = "grayscale(0.5)"; }
    if (image) {
      const ratio = image.naturalWidth / image.naturalHeight, w = ratio >= 1 ? size : size * ratio, h = ratio >= 1 ? size / ratio : size;
      ctx.drawImage(image, cx - w / 2, cy - h / 2, w, h);
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, size / 2 - 4, 0, Math.PI * 2); ctx.fillStyle = "#222"; ctx.fill();
      ctx.lineWidth = Math.max(3, size / 40); ctx.strokeStyle = dim ? "#555" : AX_Y; ctx.stroke();
      const initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "?";
      ctx.fillStyle = "#ffffff"; axFont(ctx, 0, Math.round(size * 0.36), true); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(initials, cx, cy + 2); ctx.textBaseline = "alphabetic";
    }
    ctx.restore();
  }
  function axFooter(ctx, W, y) {
    ctx.textAlign = "center"; ctx.fillStyle = "#9a9a92"; axFont(ctx, 700, 24); axSpacing(ctx, 5);
    ctx.fillText("#LIGASKALAMA · SKALAMA.COM.BR", W / 2, y); axSpacing(ctx, 0);
  }
  function axBand(ctx, W, y, text, story, color = AX_Y, ink = "#0b0b0b") {
    const h = story ? 92 : 78, pad = story ? 70 : 70;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(pad + 20, y); ctx.lineTo(W - pad, y); ctx.lineTo(W - pad - 20, y + h); ctx.lineTo(pad, y + h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    axFit(ctx, text, 0, story ? 52 : 44, W - pad * 2 - 80, true);
    axSpacing(ctx, 1); ctx.fillText(text, W / 2, y + h / 2 + 2); axSpacing(ctx, 0);
    ctx.restore();
    return y + h;
  }
  function axStar(ctx, cx, cy, r, color = AX_Y) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) { const angle = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(cx + rr * Math.cos(angle), cy + rr * Math.sin(angle)); }
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  }
  function axTrophy(ctx, cx, cy, r) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = AX_Y; ctx.fill(); ctx.lineWidth = r * 0.12; ctx.strokeStyle = "#0b0b0b"; ctx.stroke();
    const s = r / 24; ctx.fillStyle = "#0b0b0b";
    ctx.beginPath(); ctx.moveTo(cx - 10 * s, cy - 12 * s); ctx.lineTo(cx + 10 * s, cy - 12 * s); ctx.lineTo(cx + 9 * s, cy - 2 * s); ctx.quadraticCurveTo(cx, cy + 7 * s, cx - 9 * s, cy - 2 * s); ctx.closePath(); ctx.fill();
    ctx.fillRect(cx - 2.5 * s, cy + 3 * s, 5 * s, 6 * s); ctx.fillRect(cx - 7 * s, cy + 9 * s, 14 * s, 4 * s);
    ctx.lineWidth = 3 * s; ctx.strokeStyle = "#0b0b0b";
    ctx.beginPath(); ctx.arc(cx - 11 * s, cy - 7 * s, 4 * s, Math.PI * 0.5, Math.PI * 1.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + 11 * s, cy - 7 * s, 4 * s, -Math.PI * 0.5, Math.PI * 0.5); ctx.stroke();
  }
  // Gols agrupados por jogador: "Luy Hick ×3 20′ 26′ 30′"; minuto repetido aparece uma vez.
  function axGoalLines(game, key) {
    const groups = [];
    for (const goal of [...(game.goals || [])].sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0))) {
      if ((goal.scoringTeam || goal.team) !== key) continue;
      let group = groups.find((item) => item.player === goal.player && item.own === !!goal.ownGoal);
      if (!group) groups.push((group = { player: goal.player, own: !!goal.ownGoal, minutes: [] }));
      group.minutes.push(Number(goal.minute) || 0);
    }
    return groups.map((group) => ({ name: displayName(group.player || "Gol") + (group.minutes.length > 1 ? " ×" + group.minutes.length : "") + (group.own ? " (contra)" : ""), minutes: [...new Set(group.minutes)].map((m) => m + "′").join(" ") }));
  }
  function axDrawGoals(ctx, W, top, bottom, game, story) {
    const pad = story ? 80 : 70, mid = W / 2, colW = mid - pad - 28;
    ctx.textAlign = "center"; ctx.fillStyle = AX_Y; axFont(ctx, 800, story ? 26 : 22); axSpacing(ctx, 6);
    ctx.fillText("GOLS DA PARTIDA", mid, top + 26); axSpacing(ctx, 0);
    const home = axGoalLines(game, game.home), away = axGoalLines(game, game.away), rows = Math.max(home.length, away.length, 1),
      areaTop = top + (story ? 62 : 54), avail = bottom - areaTop;
    let size = Math.min(story ? 40 : 34, Math.floor(avail / rows / 1.32));
    size = Math.max(16, size);
    const lineH = Math.round(size * 1.32);
    ctx.strokeStyle = "rgba(255,255,255,0.14)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mid, areaTop - 6); ctx.lineTo(mid, areaTop + Math.min(avail, rows * lineH) - 8); ctx.stroke();
    const draw = (lines, alignRight) => {
      if (!lines.length) { ctx.fillStyle = "#8f8f88"; axFont(ctx, 600, size); ctx.textAlign = alignRight ? "right" : "left"; ctx.fillText("Sem gols", alignRight ? mid - 28 : mid + 28, areaTop + size); return; }
      lines.forEach((line, index) => {
        const y = areaTop + size + index * lineH;
        let s = size;
        const measure = () => { axFont(ctx, 800, s); const a = ctx.measureText(line.name + "  ").width; axFont(ctx, 600, s); return a + ctx.measureText(line.minutes).width; };
        while (measure() > colW && s > 12) s--;
        axFont(ctx, 800, s); const nameW = ctx.measureText(line.name + "  ").width; axFont(ctx, 600, s); const minW = ctx.measureText(line.minutes).width;
        const x0 = alignRight ? mid - 28 - (nameW + minW) : mid + 28;
        ctx.textAlign = "left"; ctx.fillStyle = "#ffffff"; axFont(ctx, 800, s); ctx.fillText(line.name, x0, y);
        ctx.fillStyle = AX_Y; axFont(ctx, 600, s); ctx.fillText(line.minutes, x0 + nameW, y);
      });
    };
    draw(home, true); draw(away, false);
    ctx.textAlign = "center";
    return areaTop + rows * lineH;
  }
  function axBestOfGame(game) {
    return [...gamePerformance(game)].sort((a, b) => Number(b.score) - Number(a.score) || ((Number(b.goalsFor) || 0) + (Number(b.assists) || 0)) - ((Number(a.goalsFor) || 0) + (Number(a.assists) || 0)) || (Number(b.goalsFor) || 0) - (Number(a.goalsFor) || 0))[0] || null;
  }
  function axIsTitle(game) {
    return typeof hxIsTitleGame === "function" ? hxIsTitleGame(game) : game.stage === "final";
  }
  // ---------- Arte: Resultado de jogo (modelo para as outras) ----------
  function axDrawResult(ctx, W, H, story, game) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70;
    let y = axBrand(ctx, W, top, story);
    const title = axIsTitle(game), friendly = game.stage === "amistoso", pills = [{ text: game.superLigaId ? "SUPER LIGA" : "MODO LIGA", style: "white" }];
    if (title || (game.superLigaId && game.stage === "final")) pills.push({ text: "FINAL", style: "yellow" });
    else if (friendly) pills.push({ text: "AMISTOSO", style: "outline" });
    const place = [axDayMonth(game.matchDate || game.finishedAt), axVenueShort()].filter(Boolean).join(" · ");
    if (place) pills.push({ text: place, style: "outline" });
    y = axPills(ctx, W, y + (story ? 6 : 0), pills, story) + (story ? 40 : 26);
    // Placar em 3 colunas
    const crest = story ? 300 : 230, colX = [W * 0.2, W / 2, W * 0.8], winSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      crestCy = y + crest / 2;
    for (const [side, cx] of [["home", colX[0]], ["away", colX[2]]]) {
      const lose = winSide && winSide !== side, label = gameTeamLabel(game, side);
      axCrest(ctx, game[side], label, cx, crestCy, crest, lose);
      ctx.fillStyle = lose ? "#8f8f88" : "#ffffff"; ctx.textAlign = "center";
      axFit(ctx, label.toUpperCase(), 0, story ? 50 : 40, W * 0.34, true);
      ctx.fillText(label.toUpperCase(), cx, crestCy + crest / 2 + (story ? 66 : 54));
    }
    const hs = Number(game.homeScore) || 0, as = Number(game.awayScore) || 0;
    // O placar diminui para caber entre os escudos (ex.: 10 × 4).
    let scoreSize = story ? 190 : 150;
    const room = colX[2] - crest / 2 - (colX[0] + crest / 2) - 36;
    const scoreWidth = (size) => { axFont(ctx, 0, size, true); const nums = ctx.measureText(String(hs)).width + ctx.measureText(String(as)).width; axFont(ctx, 0, size * 0.45, true); return nums + ctx.measureText("×").width + 44; };
    while (scoreWidth(scoreSize) > room && scoreSize > 70) scoreSize -= 4;
    axFont(ctx, 0, scoreSize, true); ctx.textBaseline = "middle";
    const sep = "×", sepW = (axFont(ctx, 0, scoreSize * 0.45, true), ctx.measureText(sep).width);
    axFont(ctx, 0, scoreSize, true);
    const hw = ctx.measureText(String(hs)).width, aw = ctx.measureText(String(as)).width, gap = 22, total = hw + aw + sepW + gap * 2, sx = colX[1] - total / 2;
    ctx.textAlign = "left";
    ctx.fillStyle = winSide === "home" ? AX_Y : winSide ? "#8f8f88" : "#ffffff"; ctx.fillText(String(hs), sx, crestCy + 8);
    ctx.fillStyle = winSide === "away" ? AX_Y : winSide ? "#8f8f88" : "#ffffff"; ctx.fillText(String(as), sx + hw + sepW + gap * 2, crestCy + 8);
    ctx.fillStyle = "#8f8f88"; axFont(ctx, 0, scoreSize * 0.45, true); ctx.fillText(sep, sx + hw + gap, crestCy + 8);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
    y = crestCy + crest / 2 + (story ? 110 : 84);
    // Faixa do resultado
    const shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null, winner = winSide ? gameTeamLabel(game, winSide).toUpperCase() : "";
    const result = !winSide ? "EMPATE" : title ? winner + " CAMPEÃO" : hs === as && shoot ? winner + " VENCE NOS PÊNALTIS (" + shoot[winSide + "Score"] + " × " + shoot[(winSide === "home" ? "away" : "home") + "Score"] + ")" : "VITÓRIA DO " + winner;
    y = axBand(ctx, W, y, result, story) + (story ? 50 : 36);
    // Destaque do jogo (só no Story) e gols
    const footerY = bottom - 6, best = story && ART.star ? axBestOfGame(game) : null, starH = best ? 168 : 0;
    const goalsBottom = footerY - 50 - (best ? starH + 34 : 0);
    if (ART.goals) y = axDrawGoals(ctx, W, y, goalsBottom, game, story) + 20;
    if (best) {
      const cardY = goalsBottom + 34, x = 110, w = W - 220;
      axRound(ctx, x, cardY, w, starH, 28); ctx.fillStyle = "#161616"; ctx.fill(); ctx.strokeStyle = "rgba(255,196,0,0.5)"; ctx.lineWidth = 3; ctx.stroke();
      axStar(ctx, x + 84, cardY + starH / 2, 44);
      ctx.textAlign = "left"; ctx.fillStyle = AX_Y; axFont(ctx, 800, 22); axSpacing(ctx, 5); ctx.fillText("DESTAQUE DO JOGO", x + 150, cardY + 50); axSpacing(ctx, 0);
      ctx.fillStyle = "#ffffff"; axFit(ctx, displayName(best.player).toUpperCase(), 0, 56, w - 190, true); ctx.fillText(displayName(best.player).toUpperCase(), x + 150, cardY + 112);
      const parts = [Number(best.goalsFor) ? best.goalsFor + (Number(best.goalsFor) === 1 ? " gol" : " gols") : "", Number(best.assists) ? best.assists + " assist." : "", best.role === "goleiro" ? "goleiro" : "", "nota " + Number(best.score).toFixed(1).replace(".", ",").replace(",0", "")].filter(Boolean).join(" · ");
      ctx.fillStyle = "#d6d6cd"; axFont(ctx, 600, 26); ctx.fillText(parts, x + 150, cardY + 148);
      ctx.textAlign = "center";
    }
    axFooter(ctx, W, footerY);
  }
  // ---------- Arte: Times sorteados ----------
  function axDrawTeams(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70;
    let y = axBrand(ctx, W, top, story);
    const place = [axDayMonth(info.date), axVenueShort()].filter(Boolean).join(" · ");
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "TIMES SORTEADOS", style: "white" }, ...(place ? [{ text: place, style: "outline" }] : [])], story) + (story ? 40 : 28);
    const teams = info.teams, cols = 2, rows = Math.ceil(teams.length / cols), pad = story ? 70 : 70, gap = story ? 26 : 22,
      areaBottom = bottom - 54, cardW = (W - pad * 2 - gap) / cols, cardH = Math.min(story ? 520 : 440, (areaBottom - y - gap * (rows - 1)) / rows);
    teams.forEach((team, index) => {
      const row = Math.floor(index / cols), alone = teams.length % 2 === 1 && index === teams.length - 1,
        x = alone ? (W - cardW) / 2 : pad + (index % cols) * (cardW + gap), cy = y + row * (cardH + gap);
      axRound(ctx, x, cy, cardW, cardH, 26); ctx.fillStyle = "#151515"; ctx.fill(); ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = AX_Y; ctx.fillRect(x + 24, cy + (story ? 132 : 112), cardW - 48, 4);
      const crest = story ? 96 : 80;
      axCrest(ctx, team.key, team.label, x + 24 + crest / 2, cy + 18 + crest / 2, crest);
      ctx.textAlign = "left"; ctx.fillStyle = "#ffffff"; axFit(ctx, team.label.toUpperCase(), 0, story ? 46 : 38, cardW - crest - 64, true);
      ctx.fillText(team.label.toUpperCase(), x + 40 + crest, cy + 18 + crest / 2 + 16);
      const listTop = cy + (story ? 176 : 150), lineH = Math.min(story ? 62 : 54, (cardH - (listTop - cy) - 16) / Math.max(5, team.players.length));
      team.players.forEach((name, i) => {
        const ly = listTop + i * lineH;
        ctx.fillStyle = "#8f8f88"; axFont(ctx, 800, Math.round(lineH * 0.42)); ctx.fillText(String(i + 1).padStart(2, "0"), x + 28, ly);
        ctx.fillStyle = "#ffffff"; axFit(ctx, displayName(name), 700, Math.round(lineH * 0.52), cardW - 140, false);
        ctx.fillText(displayName(name), x + 76, ly);
        if (keeper(name)) {
          const nameW = ctx.measureText(displayName(name)).width, r = Math.round(lineH * 0.26), gx = x + 76 + nameW + 14 + r, gy = ly - r * 0.8;
          ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fillStyle = AX_Y; ctx.fill();
          ctx.fillStyle = "#0b0b0b"; axFont(ctx, 0, Math.round(r * 1.25), true); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("G", gx, gy + 1); ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
        }
      });
    });
    ctx.textAlign = "center";
    axFooter(ctx, W, bottom - 6);
  }
  // ---------- Arte: Campeão ----------
  function axDrawChampion(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70, game = info.final, champ = info.champion, side = info.side, opp = side === "home" ? "away" : "home";
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "SUPER LIGA", style: "white" }, { text: "CAMPEÃO", style: "yellow" }, ...(axDayMonth(game.finishedAt) ? [{ text: [axDayMonth(game.finishedAt), axVenueShort()].filter(Boolean).join(" · "), style: "outline" }] : [])], story) + (story ? 30 : 16);
    const crest = story ? 400 : 250, cy = y + crest / 2;
    axCrest(ctx, champ, teamLabel(champ), W / 2, cy, crest);
    axTrophy(ctx, W / 2 + crest * 0.36, cy + crest * 0.36, story ? 52 : 38);
    y = cy + crest / 2 + (story ? 70 : 52);
    ctx.textAlign = "center"; ctx.fillStyle = AX_Y; axFont(ctx, 800, story ? 30 : 24); axSpacing(ctx, 8); ctx.fillText("CAMPEÃO DA SUPER LIGA", W / 2, y); axSpacing(ctx, 0);
    y += story ? 182 : 126;
    ctx.fillStyle = "#ffffff"; axFit(ctx, teamLabel(champ).toUpperCase(), 0, story ? 170 : 116, W - 160, true); ctx.fillText(teamLabel(champ).toUpperCase(), W / 2, y);
    y += story ? 46 : 30;
    const shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null,
      line = "FINAL · " + teamLabel(game[side]).toUpperCase() + " " + game[side + "Score"] + " × " + game[opp + "Score"] + " " + teamLabel(game[opp]).toUpperCase() + (shoot ? " (PÊN. " + shoot[side + "Score"] + " × " + shoot[opp + "Score"] + ")" : "");
    y = axBand(ctx, W, y, line, story) + (story ? 54 : 36);
    ctx.fillStyle = "#d6d6cd"; axFont(ctx, 800, story ? 24 : 20); axSpacing(ctx, 6); ctx.fillText("QUEM JOGOU A FINAL", W / 2, y); axSpacing(ctx, 0);
    y += story ? 26 : 20;
    // Nomes em linhas centralizadas
    const names = info.played.map((name) => displayName(name) + (name === info.keeperName || keeper(name) ? " (G)" : "")), size = story ? 34 : 28, rowH = size * 1.55, maxW = W - 160;
    axFont(ctx, 700, size);
    const rowsList = [[]];
    names.forEach((name) => { const row = rowsList[rowsList.length - 1], test = [...row, name].join("  ·  "); if (ctx.measureText(test).width > maxW && row.length) rowsList.push([name]); else row.push(name); });
    ctx.fillStyle = "#ffffff";
    rowsList.forEach((row, index) => ctx.fillText(row.join("  ·  "), W / 2, y + size + index * rowH));
    axFooter(ctx, W, bottom - 6);
  }
  // ---------- Arte: Destaques da noite ----------
  function axDrawNight(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70;
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "DESTAQUES DA NOITE", style: "white" }, ...(axDayMonth(state.matchDate) ? [{ text: [axDayMonth(state.matchDate), axVenueShort()].filter(Boolean).join(" · "), style: "outline" }] : [])], story) + (story ? 50 : 34);
    const cards = [["JOGADOR DA NOITE", info.player, "linha"], ["GOLEIRO DA NOITE", info.keeper, "goleiro"]], pad = 70, gap = story ? 34 : 26;
    const areaBottom = bottom - 54, cardH = story ? (areaBottom - y - gap) / 2 : areaBottom - y, cardW = story ? W - pad * 2 : (W - pad * 2 - gap) / 2;
    cards.forEach(([label, row, role], index) => {
      const x = story ? pad : pad + index * (cardW + gap), cy = story ? y + index * (cardH + gap) : y;
      axRound(ctx, x, cy, cardW, cardH, 30); ctx.fillStyle = "#151515"; ctx.fill(); ctx.strokeStyle = index ? "rgba(255,255,255,0.18)" : "rgba(255,196,0,0.55)"; ctx.lineWidth = 3; ctx.stroke();
      const cx = x + cardW / 2;
      axStar(ctx, cx, cy + (story ? 90 : 80), story ? 46 : 38, index ? "#d9d9d4" : AX_Y);
      ctx.textAlign = "center"; ctx.fillStyle = index ? "#d9d9d4" : AX_Y; axFont(ctx, 800, story ? 26 : 22); axSpacing(ctx, 6); ctx.fillText(label, cx, cy + (story ? 180 : 160)); axSpacing(ctx, 0);
      if (!row) { ctx.fillStyle = "#c9c9c1"; axFont(ctx, 600, story ? 30 : 24); ctx.fillText("Ainda sem goleiro com " + MIN_KEEPER_GAMES + " jogos no gol", cx, cy + cardH / 2 + 30); return; }
      ctx.fillStyle = "#ffffff"; axFit(ctx, displayName(row.player).toUpperCase(), 0, story ? 96 : 70, cardW - 80, true); ctx.fillText(displayName(row.player).toUpperCase(), cx, cy + (story ? 300 : 260));
      ctx.fillStyle = "#c9c9c1"; axFont(ctx, 700, story ? 28 : 22); ctx.fillText(row.teamLabel.toUpperCase(), cx, cy + (story ? 350 : 302));
      const stats = ["nota " + row.average.toFixed(1).replace(".", ","), row.games + (row.games === 1 ? " jogo" : " jogos"), role === "goleiro" ? row.conceded + (row.conceded === 1 ? " gol sofrido" : " gols sofridos") : row.goals + (row.goals === 1 ? " gol" : " gols")].join(" · ");
      ctx.fillStyle = AX_Y; axFit(ctx, stats, 800, story ? 34 : 26, cardW - 60, false); ctx.fillText(stats, cx, cy + (story ? 410 : 360));
    });
    axFooter(ctx, W, bottom - 6);
  }
  // ---------- Arte: Artilharia ----------
  function axDrawScorers(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70;
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "ARTILHARIA", style: "white" }, { text: (AX_SCOPES.find(([key]) => key === info.scope)?.[1] || "").toUpperCase().replace(" (MODO LIGA)", ""), style: "outline" }], story) + (story ? 50 : 34);
    const pad = 70, rowGap = story ? 22 : 16, areaBottom = bottom - 54, rowH = Math.min(story ? 170 : 150, (areaBottom - y - rowGap * 4) / 5);
    info.rows.forEach((row, index) => {
      const ry = y + index * (rowH + rowGap), first = index === 0;
      axRound(ctx, pad, ry, W - pad * 2, rowH, 26); ctx.fillStyle = first ? AX_Y : "#151515"; ctx.fill();
      if (!first) { ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 2; ctx.stroke(); }
      const ink = first ? "#0b0b0b" : "#ffffff", cyRow = ry + rowH / 2;
      ctx.beginPath(); ctx.arc(pad + 64, cyRow, rowH * 0.27, 0, Math.PI * 2); ctx.fillStyle = first ? "#0b0b0b" : index === 1 ? "#d9d9d4" : index === 2 ? "#e8c9a8" : "#2a2a2a"; ctx.fill();
      ctx.fillStyle = first ? AX_Y : index <= 2 ? "#0b0b0b" : "#ffffff"; axFont(ctx, 0, Math.round(rowH * 0.3), true); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(index + 1), pad + 64, cyRow + 2);
      axCrest(ctx, row.team, row.teamLabel, pad + 168, cyRow, rowH * 0.56);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = ink; axFit(ctx, displayName(row.name).toUpperCase(), 0, Math.round(rowH * (first ? 0.36 : 0.32)), W - pad * 2 - 420, true);
      ctx.fillText(displayName(row.name).toUpperCase(), pad + 230, cyRow + 4);
      ctx.fillStyle = first ? "#2d2d29" : "#b5b5ad"; axFont(ctx, 700, Math.round(rowH * 0.15)); ctx.fillText(row.teamLabel.toUpperCase(), pad + 232, cyRow + rowH * 0.3);
      ctx.textAlign = "right"; ctx.fillStyle = first ? "#0b0b0b" : AX_Y; axFont(ctx, 0, Math.round(rowH * 0.5), true); ctx.fillText(String(row.goals), W - pad - 120, cyRow + rowH * 0.18);
      ctx.fillStyle = ink; axFont(ctx, 800, Math.round(rowH * 0.15)); ctx.fillText(row.goals === 1 ? "GOL" : "GOLS", W - pad - 34, cyRow + rowH * 0.12);
    });
    ctx.textAlign = "center";
    axFooter(ctx, W, bottom - 6);
  }
  // ---------- Arte: Próximo jogo ----------
  function axDrawNext(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70, date = axDate(info.date);
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "PRÓXIMO JOGO", style: "yellow" }], story) + (story ? 40 : 24);
    const weekday = date ? date.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0].toUpperCase() : "";
    ctx.textAlign = "center"; ctx.fillStyle = "#ffffff"; axFit(ctx, weekday, 0, story ? 220 : 150, W - 140, true);
    y += story ? 200 : 136; ctx.fillText(weekday, W / 2, y);
    y += story ? 128 : 90; ctx.fillStyle = AX_Y; axFont(ctx, 0, story ? 96 : 70, true); ctx.fillText(axDayMonth(info.date), W / 2, y);
    const time = /^\d{2}:\d{2}/.test(info.time) ? info.time.slice(0, 5).replace(":00", "H").replace(":", "H") : "", line = [time, String(info.venue || "").toUpperCase()].filter(Boolean).join(" · ");
    if (line) { y += story ? 74 : 56; ctx.fillStyle = "#d6d6cd"; axFit(ctx, line, 800, story ? 40 : 32, W - 160, false); ctx.fillText(line, W / 2, y); }
    y += story ? 70 : 46;
    if (info.teams.length) {
      ctx.fillStyle = "#c9c9c1"; axFont(ctx, 800, story ? 24 : 20); axSpacing(ctx, 6); ctx.fillText("TIMES CONFIRMADOS", W / 2, y); axSpacing(ctx, 0);
      const n = info.teams.length, crest = story ? 150 : 112, slot = Math.min(240, (W - 140) / n);
      info.teams.forEach((team, index) => {
        const cx = W / 2 - (slot * (n - 1)) / 2 + index * slot, cy = y + 36 + crest / 2;
        axCrest(ctx, team.key, team.label, cx, cy, crest);
        ctx.fillStyle = "#ffffff"; axFit(ctx, team.label.toUpperCase(), 0, story ? 32 : 26, slot - 16, true); ctx.fillText(team.label.toUpperCase(), cx, cy + crest / 2 + (story ? 44 : 36));
      });
      y += 36 + crest + (story ? 80 : 60);
    }
    if (info.spots > 0 || !info.teams.length) {
      const text = "COLOQUE SEU NOME NA LISTA" + (info.spots > 0 ? " · " + info.spots + (info.spots === 1 ? " VAGA" : " VAGAS") : "");
      axBand(ctx, W, Math.min(y, bottom - 160), text, story);
    }
    axFooter(ctx, W, bottom - 6);
  }
  function axPaint(info) {
    const canvas = $("artCanvas"), story = ART.format === "story", W = 1080, H = story ? 1920 : 1350, ctx = canvas.getContext("2d");
    canvas.width = W; canvas.height = H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    axBackground(ctx, W, H);
    if (info.type === "result") axDrawResult(ctx, W, H, story, info.game);
    else if (info.type === "teams") axDrawTeams(ctx, W, H, story, info);
    else if (info.type === "champion") axDrawChampion(ctx, W, H, story, info);
    else if (info.type === "night") axDrawNight(ctx, W, H, story, info);
    else if (info.type === "scorers") axDrawScorers(ctx, W, H, story, info);
    else if (info.type === "next") axDrawNext(ctx, W, H, story, info);
    canvas.dataset.drawn = JSON.stringify([ART.type, ART.format]);
  }
  // Desenha só depois das fontes e dos escudos; descarta desenhos antigos se a escolha mudar no meio.
  function drawArt(force = false) {
    if (!state || !$("artCanvas")) return artDone;
    const info = axData();
    if (info.warn) return artDone;
    const key = JSON.stringify([ART, info, Object.keys(teamLogos)]);
    if (!force && key === artKey) return artDone;
    artKey = key;
    const token = ++artToken;
    artDone = (async () => {
      await axFontsReady();
      await Promise.all(axImagesFor(info).map(axLoadImage));
      if (token === artToken) axPaint(info);
    })().catch((error) => console.warn("Arte:", error));
    return artDone;
  }
  // ---------- Painel ----------
  function axTypeNeedsGame() { return ART.type === "result"; }
  function renderArt() {
    if (!$("artStudio") || !state) return;
    if (!ART.scope) ART.scope = ["rodada", "temporada", "superliga"].find((scope) => axScorerRows(scope).length) || "rodada";
    const info = axData(), games = artGames();
    if (ART.type === "result" && games.length && !games.some((game) => game.id === ART.gameId)) ART.gameId = games[0].id;
    $("axTypes").innerHTML = AX_TYPES.map(([key, label]) => '<button type="button" class="ax-type' + (ART.type === key ? " is-on" : "") + '" data-ax-type="' + key + '" aria-pressed="' + (ART.type === key) + '"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">' + AX_ICONS[key] + "</svg><span>" + label + "</span></button>").join("");
    // Passo 2: jogo (resultado) ou período (artilharia)
    const step2 = $("axStep2"), needsGame = axTypeNeedsGame(), needsScope = ART.type === "scorers";
    step2.hidden = !needsGame && !needsScope;
    $("axStep2Title").textContent = needsScope ? "QUAL PERÍODO?" : "QUAL JOGO?";
    $("axStep3Num").textContent = step2.hidden ? "2" : "3";
    if (needsGame) {
      const markup = games.length ? games.map((game) => {
        const tag = axIsTitle(game) || (game.superLigaId && game.stage === "final") ? '<span class="ax-tag ax-tag-final">FINAL</span>' : game.stage === "amistoso" ? '<span class="ax-tag ax-tag-line">AMISTOSO</span>' : "",
          end = game.finishedAt ? new Date(game.finishedAt) : null, when = [axDayMonth(game.finishedAt), end ? end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""].filter(Boolean).join(" · ");
        return '<button type="button" class="ax-game' + (ART.gameId === game.id ? " is-on" : "") + '" data-ax-game="' + escapeHtml(game.id) + '" aria-pressed="' + (ART.gameId === game.id) + '"><span class="ax-game-crests">' + axHtmlCrest(game.home, gameTeamLabel(game, "home")) + axHtmlCrest(game.away, gameTeamLabel(game, "away")) + '</span><span class="ax-game-info"><strong>' + escapeHtml(gameTeamLabel(game, "home") + " × " + gameTeamLabel(game, "away")) + "</strong><small>" + escapeHtml("Jogo " + game.number + (when ? " · " + when : "")) + "</small>" + tag + '</span><b class="ax-game-score">' + (Number(game.homeScore) || 0) + " × " + (Number(game.awayScore) || 0) + "</b></button>";
      }).join("") : '<p class="ax-empty">Nenhum jogo encerrado ainda.</p>';
      if ($("axGames").innerHTML !== markup) $("axGames").innerHTML = markup;
    } else if (needsScope) {
      $("axGames").innerHTML = '<div class="ax-seg">' + AX_SCOPES.map(([key, label]) => '<button type="button" class="ax-segbtn' + (ART.scope === key ? " is-on" : "") + '" data-ax-scope="' + key + '" aria-pressed="' + (ART.scope === key) + '">' + label + "</button>").join("") + "</div>";
    } else $("axGames").innerHTML = "";
    // Passo 3
    $("axFormats").innerHTML = [["story", "Story", "1080 × 1920"], ["feed", "Feed", "1080 × 1350"]].map(([key, label, size]) => '<button type="button" class="ax-segbtn ax-format' + (ART.format === key ? " is-on" : "") + '" data-ax-format="' + key + '" aria-pressed="' + (ART.format === key) + '"><strong>' + label + "</strong><small>" + size + "</small></button>").join("");
    const checks = [["goals", "Mostrar gols da partida", ART.type === "result"], ["star", "Mostrar destaque do jogo", ART.type === "result" && ART.format === "story"], ["stripe", "Fundo com faixa amarela", true]];
    $("axChecks").innerHTML = checks.filter(([, , show]) => show).map(([key, label]) => '<label class="ax-check"><input type="checkbox" data-ax-check="' + key + '"' + (ART[key] ? " checked" : "") + "><span>" + label + "</span></label>").join("") + (ART.type === "result" && ART.format === "feed" ? '<p class="ax-note">O destaque do jogo aparece só no Story.</p>' : "");
    // Escudos: oficiais automáticos; upload só para time sem escudo oficial.
    const teamsInArt = axTeamsOf(info), missing = teamsInArt.filter((team) => !fixedCrest(team.key, team.label));
    $("axCrests").innerHTML = teamsInArt.length
      ? '<div class="ax-crest-row">' + teamsInArt.map((team) => axHtmlCrest(team.key, team.label)).join("") + "<span>" + (missing.some((team) => !teamLogos[team.key]) ? "Escudos oficiais carregados automaticamente. Time sem escudo aparece com as iniciais." : "Escudos oficiais carregados automaticamente") + "</span></div>" +
        missing.map((team) => '<div class="ax-upload"><span>' + escapeHtml(team.label) + (teamLogos[team.key] ? " · escudo deste aparelho" : " não tem escudo oficial") + '</span><label class="ax-btn ax-white ax-small">' + (teamLogos[team.key] ? "Trocar escudo" : "Subir escudo") + '<input type="file" accept="image/*" hidden data-logo-team="' + escapeHtml(team.key) + '"></label>' + (teamLogos[team.key] ? '<button type="button" class="ax-btn ax-white ax-small" data-logo-remove="' + escapeHtml(team.key) + '">Remover</button>' : "") + "</div>").join("")
      : "";
    // Aviso, prévia e ações
    const warn = $("axWarn");
    warn.hidden = !info.warn;
    warn.textContent = info.warn || "";
    const ready = !info.warn;
    $("axCanvasWrap").hidden = !ready;
    $("axCanvasWrap").classList.toggle("is-feed", ART.format === "feed");
    for (const id of ["artDownload", "artShare", "artWhats"]) $(id).disabled = !ready;
    $("artFormatHelp").textContent = ART.format === "story" ? "Story com placar, escudos e gols longe das bordas que o Instagram cobre com o perfil e a caixa de resposta." : "Feed 1080 × 1350 (4:5), o formato que ocupa mais espaço no feed do Instagram.";
    if (ready) drawArt();
  }
  function axHtmlCrest(key, label) {
    const src = axCrestSrc(key, label), initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return '<span class="ax-crest' + (src ? "" : " ax-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
  }
  function axTeamsOf(info) {
    const list = [];
    const add = (key, label) => { if (key && !list.some((item) => item.key === key)) list.push({ key, label }); };
    if (info.game) { add(info.game.home, gameTeamLabel(info.game, "home")); add(info.game.away, gameTeamLabel(info.game, "away")); }
    if (info.final) { add(info.final.home, gameTeamLabel(info.final, "home")); add(info.final.away, gameTeamLabel(info.final, "away")); }
    (info.teams || []).forEach((team) => add(team.key, team.label));
    (info.rows || []).forEach((row) => add(row.team, row.teamLabel));
    if (info.player) add(info.player.team, info.player.teamLabel);
    if (info.keeper) add(info.keeper.team, info.keeper.teamLabel);
    return list;
  }
  function axFileName() {
    const info = axData(), part = info.type === "result" ? "jogo-" + (info.game?.number || "") : info.type;
    return "liga-skalama-" + part + "-" + ART.format + ".png";
  }
  async function artFile() {
    await drawArt();
    await artDone;
    return new Promise((resolve) => $("artCanvas").toBlob((blob) => resolve(new File([blob], axFileName(), { type: "image/png" })), "image/png"));
  }
  async function downloadArt() {
    const file = await artFile(), url = URL.createObjectURL(file), link = Object.assign(document.createElement("a"), { href: url, download: file.name });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function shareArt() {
    const file = await artFile();
    if (!navigator.canShare?.({ files: [file] })) {
      notify("Este navegador não compartilha imagens; a arte foi baixada.");
      return downloadArt();
    }
    try { await navigator.share({ files: [file], title: "Liga Skalama" }); }
    catch (error) { if (error.name !== "AbortError") notify("Não foi possível compartilhar: " + error.message, true); }
  }
  // WhatsApp: no celular, o compartilhamento nativo leva a imagem; sem ele, baixa a imagem e abre o wa.me com o texto.
  async function shareArtWhatsApp() {
    const file = await artFile(), text = "LIGA SKALAMA · skalama.com.br";
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text }); return; }
      catch (error) { if (error.name === "AbortError") return; }
    }
    await downloadArt();
    window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
    notify("A imagem foi baixada: anexe no WhatsApp que abriu.");
  }
  function bindArt() {
    const box = $("artStudio");
    box.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const data = target.dataset;
      if (data.axType) { ART.type = data.axType; renderArt(); }
      else if (data.axGame) { ART.gameId = data.axGame; renderArt(); }
      else if (data.axScope) { ART.scope = data.axScope; renderArt(); }
      else if (data.axFormat) { ART.format = data.axFormat; renderArt(); }
      else if (data.logoRemove) removeTeamLogo(data.logoRemove);
      else if (target.id === "artDownload") downloadArt();
      else if (target.id === "artShare") shareArt();
      else if (target.id === "artWhats") shareArtWhatsApp();
    });
    box.addEventListener("change", (event) => {
      const target = event.target;
      if (target.dataset.axCheck) { ART[target.dataset.axCheck] = target.checked; renderArt(); }
      else if (target.dataset.logoTeam) { uploadTeamLogo(target.dataset.logoTeam, target.files?.[0]); target.value = ""; }
    });
  }
  function setView(view) {
    const locked = (shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
    if (locked && view === "elenco") view = "home";
    document
      .querySelectorAll("[data-view]")
      .forEach((element) =>
        element.classList.toggle("view-hidden", element.dataset.view !== view),
      );
    markActiveTab(view);
    localStorage.setItem("liga-skalama-view", view);
    if (view === "news") { renderNews(); loadNews(); }
  }
  // Visitantes podem olhar qualquer uma das duas abas, sem mudar o modo escolhido pelo organizador.
  let viewerMode = null;
  function shownLiveMode() {
    return isEditLocked() && viewerMode ? viewerMode : activeLiveMode();
  }
  // Modo que vale agora: o da partida em andamento ou o escolhido para a próxima.
  function activeLiveMode() {
    return state?.currentGame?.timerMode || state?.timerMode || "liga";
  }
  const liveModeName = (mode) => (mode === "coca" ? "Modo Super Liga" : "Modo Liga");
  // As abas "Modo Liga" e "Modo Super Liga" abrem a mesma tela de jogo; fica acesa a do modo atual.
  function markActiveTab(view = localStorage.getItem("liga-skalama-view") || "home") {
    document
      .querySelectorAll("[data-view-button]")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          button.dataset.viewButton === view &&
            (!button.dataset.liveMode || button.dataset.liveMode === shownLiveMode()),
        ),
      );
    // Barra de abas que rola para o lado (celular): deixa a aba ativa à vista.
    const tabs = document.querySelector(".site-header .view-tabs"), active = tabs?.querySelector("button.active");
    if (tabs && active && tabs.scrollWidth > tabs.clientWidth) {
      const box = tabs.getBoundingClientRect(), item = active.getBoundingClientRect();
      if (item.left < box.left || item.right > box.right) tabs.scrollLeft += item.left - box.left - 12;
    }
  }
  function chooseLiveMode(mode) {
    const current = activeLiveMode();
    if (mode === current && !(isEditLocked() && viewerMode && viewerMode !== mode)) return;
    const locked = (shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
    if (locked) {
      // Visitante: só troca o que está vendo.
      viewerMode = mode;
      superMarkup = "";
      renderAll();
      return;
    }
    if (state.currentGame) {
      notify(`Partida em andamento no ${liveModeName(current)}. O modo pode ser trocado quando ela terminar.`, true);
      return;
    }
    saveState({ timerMode: mode }, `${liveModeName(mode)} selecionado.`);
    renderQueueControls();
    renderLineupAdjustments();
  }
  async function addPlayer() {
    try {
      const name = normalizePlayer($("newPlayer").value),
        current = state.roster || [];
      if (current.some((item) => playerKey(item) === playerKey(name))) throw new Error("Esse jogador já foi adicionado.");
      if (current.length >= ROSTER_MAX) throw new Error("O cadastro pode ter no máximo " + ROSTER_MAX + " jogadores. Remova alguém que não joga mais.");
      const roster = [...current, name],
        // Com 32 ativos, o novo jogador entra como inativo.
        startsInactive = activeRoster().length >= ACTIVE_MAX,
        inactivePlayers = startsInactive ? [...(state.inactivePlayers || []), name] : state.inactivePlayers || [],
        activeCount = roster.filter((item) => !inactivePlayers.some((off) => playerKey(off) === playerKey(item))).length;
      const reservePlayers =
        !startsInactive && state.teams?.length && activeCount > state.teams.length * 5
          ? [...(state.reservePlayers || []), name]
          : state.reservePlayers || [];
      await saveState(
        { roster, reservePlayers, inactivePlayers },
        startsInactive
          ? displayName(name) + " foi cadastrado como inativo, porque já há " + ACTIVE_MAX + " ativos."
          : `${activeCount} jogador${activeCount === 1 ? "" : "es"} ativo${activeCount === 1 ? "" : "s"} para o sorteio.`,
      );
      $("newPlayer").value = "";
      $("newPlayer").focus();
    } catch (error) {
      notify(error.message, true);
    }
  }
  async function removePlayer(index, confirmed = false) {
    const roster = [...(state.roster || [])];
    if (index < 0 || index >= roster.length) return;
    const removed = roster[index],
      hasDraw = !!state.teams?.length;
    if (
      hasDraw && !confirmed &&
      !(await askConfirm({ title: "Remover jogador?", message: `Remover ${displayName(removed)}? A escalação será encerrada e os times precisarão ser sorteados novamente. O histórico e a artilharia permanecem.`, confirmText: "Remover", tone: "red" }))
    )
      return;
    roster.splice(index, 1);
    await saveState(
      {
        roster,
        inactivePlayers: (state.inactivePlayers || []).filter((item) => playerKey(item) !== playerKey(removed)),
        teams: [],
        lineups: null,
        absentPlayers: {},
        reservePlayers: [],
        matches: [],
        currentGame: null,
        pendingMatch: null,
        challengeQueue: [],
        incidents: [],
        timer: freshTimer(),
      },
      "Jogador removido. Sorteie novamente quando a lista estiver pronta.",
    );
  }
  // Ativo/inativo não apaga o cadastro nem mexe nos times já sorteados: vale para o próximo sorteio.
  async function toggleActivePlayer(index) {
    const name = (state.roster || [])[index];
    if (!name) return;
    const inactive = isInactive(name);
    if (inactive && activeRoster().length >= ACTIVE_MAX) { notify("Já há " + ACTIVE_MAX + " jogadores ativos. Deixe alguém inativo antes.", true); return; }
    const inactivePlayers = inactive
      ? (state.inactivePlayers || []).filter((item) => playerKey(item) !== playerKey(name))
      : [...(state.inactivePlayers || []), name];
    await saveState({ inactivePlayers }, displayName(name) + (inactive ? " está ativo" : " está inativo") + ". Vale para o próximo sorteio.");
  }
  function freshTimer(mode = "liga", duration = 480) {
    return { mode, duration, endsAt: null, runningSince: null, elapsedBeforeRun: 0, remainingAtPause: null, pauseStartedAt: null, pauseUsedMs: 0 };
  }
  async function drawTeams() {
    const pool = activeRoster();
    try {
      validateRoster(pool);
    } catch (error) {
      notify(error.message, true);
      return;
    }
    if (pool.length < MIN_PLAYERS) {
      notify(
        "Deixe pelo menos " +
          MIN_PLAYERS +
          " jogadores ativos. Atualmente: " +
          pool.length +
          ".",
        true,
      );
      return;
    }
    if (
      state.currentGame &&
      !(await askConfirm({ title: "Sortear de novo?", message: "Sortear novamente vai encerrar a partida em andamento sem adicioná-la ao histórico.", confirmText: "Sortear e encerrar a partida", tone: "red" }))
    )
      return;
    swapPick = null;
    const starterTotal = startersFor(pool.length);
    const teams = ["Time Águia", "Time Sol", "Time Verde", "Time Azul"]
      .slice(0, Math.ceil(starterTotal / 5))
      .map((name) => ({ name, players: [] }));
    const starters = pool.slice(0, starterTotal),
      reserves = pool.slice(starterTotal),
      allKeepers = randomize(starters.filter(keeper)),
      keepers = allKeepers.slice(0, teams.length),
      // Goleiros além de um por time entram no sorteio como jogadores de linha.
      others = randomize([
        ...allKeepers.slice(teams.length),
        ...starters.filter((name) => !keeper(name)),
      ]),
      keeperSlots = randomize(teams.map((_, index) => index)).slice(
        0,
        keepers.length,
      );
    keepers.forEach((name, index) =>
      teams[keeperSlots[index]].players.push(name),
    );
    while (others.length) {
      const open = randomize(teams.filter((team) => team.players.length < 5));
      open[0].players.push(others.pop());
    }
    await saveState(
      {
        teams,
        teamLabels: {},
        lineups: Object.fromEntries(
          teams.map((team) => [team.name, [...team.players]]),
        ),
        absentPlayers: {},
        reservePlayers: reserves,
        roundId: crypto.randomUUID(),
        matches: [],
        currentMatch: 0,
        matchResults: [],
        currentGame: null,
        pendingMatch: { home: teams[0].name, away: teams[1].name },
        challengeQueue: teams.slice(2).map((team) => team.name),
        incidents: [],
        timer: freshTimer(),
      },
      "Times sorteados. A sequência começa com Águia × Sol.",
    );
  }
  function cocaOnCourtCount() { return Math.min(9, Math.max(4, Number(state.superLiga?.starters || state.cocaOnCourt) || 5)); }
  // Titulares iguais nos dois times: vale o número escolhido, limitado ao menor time do confronto.
  function effectiveOnCourt() {
    const sizes = [["matchHome", "home"], ["matchAway", "away"]].map(([id, side]) => [$(id).value, side]).filter(([team]) => team).map(([team, side]) => convocadosFor(team, side).length);
    return Math.max(1, Math.min(cocaOnCourtCount(), ...sizes));
  }
  function convocadosFor(teamName, side) {
    const players = [...lineupForTeam(teamName)];
    const loan = $(side === "home" ? "loanHomePlayer" : "loanAwayPlayer").value;
    if (players.length === 4 && loan && !players.includes(loan)) players.push(loan);
    return players;
  }
  function starterSelection(teamName, side) {
    const all = convocadosFor(teamName, side), count = effectiveOnCourt();
    if (starterChoice[teamName]) return starterChoice[teamName].filter((player) => all.includes(player)).slice(0, count);
    const chosen = [], gk = $(side === "home" ? "keeperHome" : "keeperAway").value;
    if (gk && all.includes(gk)) chosen.push(gk);
    // Super Liga: começa com os titulares definidos no time.
    for (const player of superTeam(teamName)?.starters || []) if (chosen.length < count && all.includes(player) && !chosen.includes(player)) chosen.push(player);
    for (const player of all) if (chosen.length < count && !chosen.includes(player)) chosen.push(player);
    return chosen;
  }
  function renderStarterPicks() {
    const box = $("starterPicks"), mode = state.timerMode || "liga", home = $("matchHome").value, away = $("matchAway").value;
    const show = mode === "coca" && !state.currentGame && !!home && !!away && home !== away;
    box.hidden = !show;
    if (!show) { box.innerHTML = ""; return; }
    const count = effectiveOnCourt(), asked = cocaOnCourtCount();
    box.innerHTML = (count < asked ? '<p class="help-text starter-note">Jogando com ' + count + ' titulares de cada lado, porque o menor time tem ' + count + ' convocados. O restante de cada time fica no banco; um time pode ter menos reservas que o outro, ou nenhuma.</p>' : '') + [[home, "home"], [away, "away"]].map(([team, side]) => {
      const all = convocadosFor(team, side), picked = starterSelection(team, side), full = picked.length >= count;
      return '<fieldset class="starter-team"><legend>Titulares · ' + escapeHtml(teamLabel(team)) + ' · ' + picked.length + '/' + count + '</legend>' +
        all.map((player) => '<label class="starter-option"><input type="checkbox" data-starter-team="' + escapeHtml(team) + '" data-starter-side="' + side + '" value="' + escapeHtml(player) + '"' + (picked.includes(player) ? " checked" : "") + (!picked.includes(player) && full ? " disabled" : "") + '><span>' + escapeHtml(displayName(player)) + (keeper(player) ? " · Goleiro" : "") + '</span></label>').join("") +
        '<small>' + Math.max(0, all.length - picked.length) + ' no banco</small></fieldset>';
    }).join("");
  }
  function substitutionPool(game, bench = []) {
    const onCourt = new Set([...(game.homePlayers || []), ...(game.awayPlayers || [])]), absent = state.absentPlayers || {};
    return (state.teams || []).filter((team) => team.name !== game.home && team.name !== game.away)
      .map((team) => ({ team: team.name, players: lineupForTeam(team.name).filter((player) => !onCourt.has(player) && !absent[player] && !bench.includes(player)) }))
      .filter((group) => group.players.length);
  }
  function renderSubstitutions() {
    const game = state.currentGame, teamSel = $("subTeam"), outSel = $("subOut"), inSel = $("subIn"), keepIn = inSel.value;
    namesForSelect(teamSel, game ? [game.home, game.away] : [], game ? "Escolha o time" : "Comece um jogo primeiro", teamLabel);
    if (game && !teamSel.value) teamSel.value = game.home;
    const side = game && teamSel.value === game.away ? "away" : "home";
    const onCourt = game && teamSel.value ? lineupForTeam(teamSel.value, game) : [];
    namesForSelect(outSel, onCourt, game ? "Quem sai" : "Comece um jogo primeiro");
    if (game) {
      const bench = game[side + "Bench"] || [], groups = [];
      if (bench.length) groups.push({ label: game.timerMode === "coca" ? "Banco do time" : "Já jogaram · podem voltar", players: bench });
      if (game.timerMode !== "coca") groups.push(...substitutionPool(game, bench).map((group) => ({ label: teamLabel(group.team), players: group.players })));
      inSel.innerHTML = '<option value="">' + (groups.length ? "Quem entra" : "Sem jogadores disponíveis") + '</option>' + groups.map((group) => '<optgroup label="' + escapeHtml(group.label) + '">' + group.players.map((player) => '<option value="' + escapeHtml(player) + '">' + escapeHtml(displayName(player)) + (keeper(player) ? " · Goleiro" : "") + '</option>').join("") + '</optgroup>').join("");
      inSel.disabled = !groups.length;
    } else namesForSelect(inSel, [], "Comece um jogo primeiro");
    if (keepIn && [...inSel.options].some((option) => option.value === keepIn)) inSel.value = keepIn;
    $("addSub").disabled = !game || !outSel.value || !inSel.value || substituting;
    $("subHelp").textContent = game && outSel.value && outSel.value === game[side + "Keeper"]
      ? "Quem sai é o goleiro: o jogador que entrar assumirá o gol."
      : game && game.timerMode === "coca"
        ? "Super Liga SKALAMA: quem entra vem do banco do mesmo time. Quem sai vai para o banco e pode voltar."
        : "Modo Liga: entra alguém dos outros times ou volta quem já saiu. Quem sai pode voltar depois.";
  }
  async function substitutePlayer(args) {
    if (substituting) return;
    const opts = args && args.team ? args : {};
    const game = state.currentGame, team = opts.team || $("subTeam").value, out = opts.out || $("subOut").value, inn = opts.inn || $("subIn").value;
    if (!game || ![game.home, game.away].includes(team)) { notify("Comece um jogo para fazer substituições.", true); return; }
    const side = team === game.home ? "home" : "away", playersKey = side + "Players", benchKey = side + "Bench", keeperKey = side + "Keeper";
    const players = [...(game[playersKey] || [])], bench = [...(game[benchKey] || [])], coca = game.timerMode === "coca";
    if (!out || !players.includes(out)) { notify("Escolha quem sai do time.", true); return; }
    if (!inn || [...(game.homePlayers || []), ...(game.awayPlayers || [])].includes(inn)) { notify("Escolha um jogador que não esteja em quadra.", true); return; }
    let source = null;
    const fromBench = bench.includes(inn);
    if (coca && !fromBench) { notify("Na Super Liga SKALAMA, quem entra precisa estar no banco do mesmo time.", true); return; }
    if (!coca && !fromBench) {
      source = (state.teams || []).find((item) => item.name !== game.home && item.name !== game.away && lineupForTeam(item.name).includes(inn));
      if (!source || (state.absentPlayers || {})[inn]) { notify("No modo Liga, quem entra precisa vir de um dos outros times ou já ter jogado nesta partida.", true); return; }
    }
    players[players.indexOf(out)] = inn;
    const keeperOut = out === game[keeperKey], minute = Math.max(1, Math.ceil(timerElapsed() / 60)), id = crypto.randomUUID();
    // Saiu o goleiro: vai pro gol quem entra ou alguém que já está em campo (keeperIn).
    const keeperTo = keeperOut && opts.keeperTo && players.includes(opts.keeperTo) ? opts.keeperTo : inn;
    const nextGame = { ...game, [playersKey]: players, substitutions: [...(game.substitutions || []), { id, team, out, in: inn, minute, keeper: keeperOut, ...(keeperOut && keeperTo !== inn ? { keeperIn: keeperTo } : {}) }] };
    nextGame[benchKey] = [...bench.filter((player) => player !== inn), out];
    if (!coca && !fromBench) nextGame.loans = [...(game.loans || []), { player: inn, fromTeam: source.name, toTeam: team, substitution: true }];
    if (keeperOut) nextGame[keeperKey] = keeperTo;
    const item = { id, gameId: game.id, minute, type: "sub", player: inn, outPlayer: out, team, note: "Sai " + displayName(out) + " · Entra " + displayName(inn) + (keeperOut ? " (" + displayName(keeperTo) + " assume o gol)" : ""), createdAt: new Date().toISOString(), expiresAt: null };
    substituting = true; renderSubstitutions();
    try {
      await saveState({ currentGame: nextGame, incidents: [...(state.incidents || []), item] }, "Substituição: sai " + displayName(out) + ", entra " + displayName(inn) + ".");
    } finally { substituting = false; renderGoalOptions(); renderKeeperChoices(); }
  }
  function shootoutOf(game) { return game && state.shootout && state.shootout.gameId === game.id ? state.shootout : null; }
  function shootoutScores(shoot, game) {
    const kicks = shoot?.kicks || [];
    return { home: kicks.filter((kick) => kick.team === game.home && kick.scored).length, away: kicks.filter((kick) => kick.team === game.away && kick.scored).length };
  }
  function shootoutTurn(shoot, game) {
    const kicks = shoot.kicks || [], hk = kicks.filter((kick) => kick.team === game.home).length, ak = kicks.length - hk, rounds = shoot.rounds || 5, sc = shootoutScores(shoot, game);
    const side = hk <= ak ? "home" : "away";
    let decided = null;
    if (hk >= rounds && ak >= rounds) { if (hk === ak && sc.home !== sc.away) decided = sc.home > sc.away ? "home" : "away"; }
    else if (sc.home > sc.away + Math.max(0, rounds - ak)) decided = "home";
    else if (sc.away > sc.home + Math.max(0, rounds - hk)) decided = "away";
    return { side, team: side === "home" ? game.home : game.away, hk, ak, rounds, sc, decided, round: Math.floor(kicks.length / 2) + 1, sudden: hk >= rounds && ak >= rounds };
  }
  function renderShootout() {
    const dialog = $("shootoutDialog"), game = state.currentGame, shoot = shootoutOf(game);
    if (!game || !shoot) { if (dialog.open) dialog.close(); return; }
    const info = shootoutTurn(shoot, game), kicks = shoot.kicks || [];
    $("soTitle").textContent = "Pênaltis · " + teamLabel(game.home) + " × " + teamLabel(game.away);
    $("soHomeName").textContent = teamLabel(game.home); $("soAwayName").textContent = teamLabel(game.away);
    $("soHomeScore").textContent = info.sc.home; $("soAwayScore").textContent = info.sc.away;
    if (document.activeElement !== $("soRounds")) $("soRounds").value = String(info.rounds);
    $("soStatus").textContent = info.decided
      ? "Decidido: " + teamLabel(info.decided === "home" ? game.home : game.away) + " vence os pênaltis. Toque em Encerrar pênaltis e partida."
      : info.sudden ? "Morte súbita · rodada " + info.round + " · vez de " + teamLabel(info.team)
      : "Rodada " + info.round + " de " + info.rounds + " · vez de " + teamLabel(info.team);
    $("soTeamLabel").textContent = teamLabel(info.team);
    const candidates = lineupForTeam(info.team, game), taken = kicks.filter((kick) => kick.team === info.team), size = candidates.length || 1;
    const used = taken.slice(taken.length - (taken.length % size)).map((kick) => kick.player);
    const available = candidates.filter((player) => !used.includes(player)), select = $("soShooter"), previous = select.value;
    select.innerHTML = '<option value="">Escolha o batedor</option>' + available.map((player) => '<option value="' + escapeHtml(player) + '">' + escapeHtml(displayName(player)) + "</option>").join("") + '<option value="__none">Não identificar</option>';
    if (previous && (available.includes(previous) || previous === "__none")) select.value = previous;
    $("soGoal").disabled = !!info.decided || shootoutBusy; $("soMiss").disabled = !!info.decided || shootoutBusy;
    $("soUndo").disabled = !kicks.length || shootoutBusy;
    $("soLog").innerHTML = [...kicks].map((kick, index) => "<li><span>" + (index + 1) + ". " + escapeHtml(teamLabel(kick.team)) + " · " + escapeHtml(kick.player ? displayName(kick.player) : "Não identificado") + "</span><b>" + (kick.scored ? "✓ Gol" : "✗ Errou") + "</b></li>").reverse().join("") || '<li class="empty-state">Nenhum pênalti batido ainda.</li>';
  }
  async function openShootout() {
    const game = state.currentGame;
    if (!game) return;
    if (currentScore(game.home) !== currentScore(game.away)) { notify("Os pênaltis só valem com a partida empatada.", true); return; }
    if (!shootoutOf(game)) {
      const saved = await saveState({ shootout: { gameId: game.id, rounds: 5, kicks: [], finished: false } }, "Disputa de pênaltis iniciada.");
      if (!saved) return;
    }
    renderShootout();
    if (!$("shootoutDialog").open) $("shootoutDialog").showModal();
  }
  async function recordKick(scored) {
    const game = state.currentGame, shoot = shootoutOf(game);
    if (!game || !shoot || shootoutBusy) return;
    const info = shootoutTurn(shoot, game), shooter = $("soShooter").value;
    if (info.decided) { notify("Os pênaltis já estão decididos. Encerre ou desfaça o último.", true); return; }
    if (!shooter) { notify("Escolha o batedor antes de registrar o pênalti.", true); return; }
    const kick = { id: crypto.randomUUID(), team: info.team, player: shooter === "__none" ? "" : shooter, scored: !!scored, round: info.round };
    shootoutBusy = true; renderShootout();
    try { await saveState({ shootout: { ...shoot, kicks: [...(shoot.kicks || []), kick] } }, scored ? "Pênalti convertido." : "Pênalti perdido."); }
    finally { shootoutBusy = false; renderShootout(); }
  }
  async function undoKick() {
    const game = state.currentGame, shoot = shootoutOf(game);
    if (!game || !shoot || !(shoot.kicks || []).length || shootoutBusy) return;
    shootoutBusy = true; renderShootout();
    try { await saveState({ shootout: { ...shoot, kicks: shoot.kicks.slice(0, -1) } }, "Último pênalti desfeito."); }
    finally { shootoutBusy = false; renderShootout(); }
  }
  async function changeShootoutRounds(event) {
    const game = state.currentGame, shoot = shootoutOf(game);
    if (!game || !shoot) return;
    const info = shootoutTurn(shoot, game), value = Math.min(20, Math.max(Math.max(1, info.hk, info.ak), Math.floor(Number(event.target.value) || 5)));
    await saveState({ shootout: { ...shoot, rounds: value } }, "Pênaltis por time: " + value + ".");
  }
  async function finishShootout() {
    const game = state.currentGame, shoot = shootoutOf(game);
    if (!game || !shoot || shootoutBusy) return;
    const sc = shootoutScores(shoot, game), kicks = shoot.kicks || [];
    const message = !kicks.length ? "Nenhum pênalti foi batido. Encerrar a partida como empate?"
      : sc.home === sc.away ? "Os pênaltis estão empatados (" + sc.home + " × " + sc.away + "). Encerrar a partida como empate?"
      : "Encerrar os pênaltis? " + teamLabel(sc.home > sc.away ? game.home : game.away) + " vence por " + Math.max(sc.home, sc.away) + " × " + Math.min(sc.home, sc.away) + ".";
    shootoutBusy = true; renderShootout();
    let yes = false;
    try { yes = await askConfirm({ title: kicks.length && sc.home !== sc.away ? "Encerrar os pênaltis?" : "Encerrar como empate?", message, confirmText: "Encerrar pênaltis e partida", tone: "red" }); }
    finally { if (!yes) { shootoutBusy = false; renderShootout(); } }
    if (!yes || state.currentGame?.id !== game.id) { shootoutBusy = false; renderShootout(); return; }
    try {
      const saved = await saveState({ shootout: { ...shoot, finished: true } }, "Pênaltis encerrados.");
      if (!saved) return;
      $("shootoutDialog").close();
      await finishGame();
    } finally { shootoutBusy = false; }
  }
  async function prepareMatch() {
    const pending = currentPending(), superMode = isSuperMode();
    if (state.currentGame || !pending) { notify(superMode ? "Sorteie a ordem dos jogos da Super Liga antes de preparar a partida." : "Sorteie os times antes de preparar a partida.", true); return; }
    if (pending.prepared) { await saveState(pendingPatch({ home: pending.home, away: pending.away }), "Preparação desfeita. Ajuste e toque em Partida preparada."); return; }
    const home = $("matchHome").value, away = $("matchAway").value, teams = modeTeams();
    if (!home || !away || home === away || !teams.some((team) => team.name === home) || !teams.some((team) => team.name === away)) { notify("Escolha dois times diferentes e válidos.", true); return; }
    for (const teamName of [home, away]) {
      const total = lineupForTeam(teamName).length;
      if (total < 4) { notify(teamLabel(teamName) + " tem só " + total + " jogador(es). " + (superMode ? "Adicione jogadores ao time no painel da Super Liga (mínimo 4)." : "Puxe jogadores de outros times em \"Ajustar jogadores antes do jogo\" (mínimo 4)."), true); return; }
    }
    if (!$("keeperHome").value || !$("keeperAway").value) { notify("Defina um goleiro para cada time antes de preparar a partida.", true); return; }
    const saved = await saveState(pendingPatch({ home, away, prepared: true }), "Partida preparada: " + teamLabel(home) + " × " + teamLabel(away) + ".");
    const setup = document.querySelector(".live-setup");
    if (saved && setup) setup.open = false;
  }
  function unprepareMatch() {
    const pending = currentPending();
    if (pending?.prepared && !state.currentGame) saveState(pendingPatch({ home: pending.home, away: pending.away }), "Os times mudaram. Toque em Partida preparada para confirmar.");
  }
  async function beginGame() {
    const pending = currentPending(), superMode = isSuperMode(), sl = state.superLiga;
    if (state.currentGame || !pending) { notify(superMode ? "Sorteie a ordem dos jogos da Super Liga antes de iniciar a partida." : "Sorteie os times antes de iniciar a partida.", true); return; }
    const home = $("matchHome").value, away = $("matchAway").value, teams = modeTeams();
    if (!home || !away || home === away || !teams.some((team) => team.name === home) || !teams.some((team) => team.name === away)) { notify("Escolha dois times diferentes e válidos.", true); return; }
    const homePlayers = [...lineupForTeam(home)], awayPlayers = [...lineupForTeam(away)], mode = state.timerMode || "liga", maxPlayers = superMode ? SUPER_MAX_PLAYERS : mode === "coca" ? 9 : 5;
    const homeLoan = $("loanHomePlayer").value, awayLoan = $("loanAwayPlayer").value;
    const loans = [];
    for (const [teamName, loan, players] of [[home, homeLoan, homePlayers], [away, awayLoan, awayPlayers]]) {
      if (!loan) continue;
      const source = (state.teams || []).find((team) => team.name !== home && team.name !== away && lineupForTeam(team.name).includes(loan));
      if (players.length !== 4 || !source || players.includes(loan) || (state.absentPlayers || {})[loan]) { notify("O empréstimo deve vir de um time fora do confronto e completar uma equipe com quatro jogadores.", true); return; }
      players.push(loan);
      loans.push({ player: loan, fromTeam: source.name, toTeam: teamName });
    }
    if (new Set([...homePlayers, ...awayPlayers]).size !== homePlayers.length + awayPlayers.length) { notify("Um jogador não pode estar nos dois times da partida.", true); return; }
    if (homePlayers.length < 4 || awayPlayers.length < 4 || homePlayers.length > maxPlayers || awayPlayers.length > maxPlayers) { notify("Cada time precisa ter de quatro a " + maxPlayers + " jogadores neste modo.", true); return; }
    let homeBench = [], awayBench = [], onCourt = null;
    if (mode === "coca") {
      onCourt = effectiveOnCourt();
      const homeStart = starterSelection(home, "home"), awayStart = starterSelection(away, "away");
      if (homeStart.length !== onCourt || awayStart.length !== onCourt) { notify("Escolha exatamente " + onCourt + " titulares em cada time.", true); return; }
      homeBench = homePlayers.filter((player) => !homeStart.includes(player));
      awayBench = awayPlayers.filter((player) => !awayStart.includes(player));
      homePlayers.splice(0, homePlayers.length, ...homeStart);
      awayPlayers.splice(0, awayPlayers.length, ...awayStart);
    }
    const homeKeeper = $("keeperHome").value, awayKeeper = $("keeperAway").value;
    if (!homeKeeper || !awayKeeper || !homePlayers.includes(homeKeeper) || !awayPlayers.includes(awayKeeper)) { notify("Defina um goleiro que esteja escalado em cada time.", true); return; }
    const durationMinutes = Number($("durationMinutes").value);
    if ((!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 180)) { notify("A duração deve ser de 1 a 180 minutos.", true); return; }
    const now = nowMs(), duration = durationMinutes * 60;
    const fixture = superMode ? superFixture(pending.fixtureId) : null;
    const currentGame = { id: crypto.randomUUID(), roundId: (fixture ? sl.id : state.roundId) || null, ...(fixture ? { superLigaId: sl.id, fixtureId: fixture.id, stage: fixture.stage, round: fixture.round } : {}), number: (state.gameHistory || []).length + 1, home, away, homePlayers, awayPlayers, homeStart: [...homePlayers], awayStart: [...awayPlayers], homeBench, awayBench, onCourt, substitutions: [], homeKeeper, awayKeeper, homeKeeperStart: homeKeeper, awayKeeperStart: awayKeeper, loans, timerMode: mode, durationMinutes: mode === "coca" ? null : durationMinutes, startedAt: now };
    const order = [...(state.challengeQueue || []), pending.home, pending.away, ...teams.map((team) => team.name)].filter((name,index,all) => name && name !== home && name !== away && all.indexOf(name) === index);
    const nextQueue = order;
    const nextPending = { home, away };
    const timer = { ...freshTimer(mode, duration), endsAt: now + duration * 1000 };
    // A Super Liga não mexe na fila do Modo Liga.
    const queuePatch = fixture ? { superLiga: { ...sl, pending: { fixtureId: fixture.id, prepared: false } } } : { pendingMatch: nextPending, challengeQueue: nextQueue };
    await saveState({ currentGame, timer, durationMinutes, ...queuePatch }, "Jogo " + currentGame.number + " iniciado: " + teamLabel(home) + " × " + teamLabel(away) + ".");
  }
  async function pauseTimer() {
    if (!state.currentGame) return;
    const timer = state.timer || freshTimer(state.currentGame.timerMode),
      now = nowMs(),
      limit = pauseLimitMs(timer);
    const pauseLog = (kind) => ({ ...state.currentGame, pauseLog: [...(state.currentGame.pauseLog || []), { kind, minute: Math.max(1, Math.ceil(timerElapsed(timer) / 60)), at: now }] });
    if (isPauseActive(timer)) {
      const used = pauseBudgetUsed(timer);
      await saveState(
        {
          currentGame: pauseLog("resume"),
          timer: {
            ...timer,
            endsAt: now + timerRemaining(timer) * 1000,
            remainingAtPause: null,
            pauseStartedAt: null,
            pauseUsedMs: used,
          },
        },
        "Cronômetro retomado; a pausa foi contabilizada.",
      );
      return;
    }
    const used = pauseBudgetUsed(timer);
    if (used >= limit) return;
    if (!timer.endsAt || timerRemaining() === 0) return;
    await saveState(
      {
        currentGame: pauseLog("pause"),
        timer: {
          ...timer,
          endsAt: null,
          remainingAtPause: timerRemaining(),
          pauseStartedAt: now,
          pauseUsedMs: used,
        },
      },
      "Pausa iniciada. Você pode retomar quando quiser; o limite total é " + (timer.mode === "coca" ? "2 minutos." : "1 minuto."),
    );
  }
  async function addGoal() {
    if (goalSubmitting) return;
    const game = state.currentGame, player = $("goalScorer").value, scoringTeam = $("goalTeam").value, assistedBy = $("goalAssist").value || null, ownGoal = $("ownGoal").checked;
    if (!game || !player || ![game.home, game.away].includes(scoringTeam)) { notify("Escolha o time e o autor do gol.", true); return; }
    const actualTeam = teamForPlayer(player), expectedAuthorTeam = ownGoal ? (scoringTeam === game.home ? game.away : game.home) : scoringTeam;
    if (isPlayerSuspended(player, game) || (assistedBy && isPlayerSuspended(assistedBy, game))) { notify("Jogador suspenso não pode participar do gol ou da assistência.", true); return; }
    if (actualTeam !== expectedAuthorTeam || (assistedBy && (ownGoal || assistedBy === player || !lineupForTeam(scoringTeam, game).includes(assistedBy)))) { notify("Confira o autor e a assistência do gol.", true); return; }
    if ((shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true)) { notify("Somente o organizador pode registrar gols.", true); return; }
    const elapsed = Math.max(0, Math.floor(timerElapsed())), minute = Math.max(1, Math.ceil(elapsed / 60));
    const goal = { id: crypto.randomUUID(), player_name: player, team_name: actualTeam, score_team_name: scoringTeam, own_goal: ownGoal, assisted_by: assistedBy, match_number: game.number, game_id: game.id, minute };
    goalSubmitting = true; $("addGoal").disabled = true;
    try {
      if (shared) {
        const { error } = await client.from("goals").insert(goal);
        if (error) throw error;
        await refreshGoals();
      } else {
        goals.push({ ...goal, created_at: new Date().toISOString() });
        localSave(); renderGoals(); renderTimer(); renderGoalOptions();
      }
      $("ownGoal").checked = false; $("goalAssist").value = "";
      if ($("goalDialog").open) $("goalDialog").close();
      notify((ownGoal ? "Gol contra de " : "Gol de ") + displayName(player) + (assistedBy ? " · assistência de " + displayName(assistedBy) : "") + " · ponto para " + teamLabel(scoringTeam) + " · " + minute + "′.");
    } catch (error) {
      notify("Não foi possível registrar o gol: " + error.message, true);
    } finally { goalSubmitting = false; renderGoalOptions(); }
  }
  async function removeSelectedGoal() {
    const player = $("goalScorer").value,
      game = state.currentGame;
    const goal = [...goals]
      .reverse()
      .find((g) => g.player_name === player && g.game_id === game?.id);
    if (goal) await deleteGoal(goal.id, false);
  }
  async function deleteGoal(id, ask = false) {
    if (
      (shared && !canManageShared) ||
      (!shared && window.LIGA_CONFIG?.publicReadOnly === true)
    ) {
      notify("Somente o organizador pode editar gols.", true);
      return;
    }
    if (shared) {
      const { error } = await client.from("goals").delete().eq("id", id);
      if (error) {
        notify("Não foi possível remover o gol: " + error.message, true);
        return;
      }
      await refreshGoals();
    } else {
      goals = goals.filter((g) => g.id !== id);
      localSave();
    }
    const gameHistory = (state.gameHistory || []).map((game) => ({
      ...game,
      goals: (game.goals || []).filter((goal) => goal.id !== id),
    }));
    await saveState({ gameHistory }, "Gol removido do placar e histórico.");
  }
  async function finishGame() {
    const current = state.currentGame;
    if (!current || gameFinishing) return;
    gameFinishing = true;
    $("finishGame").disabled = true;
    const homeScore = currentScore(current.home),
      awayScore = currentScore(current.away);
    // Empate: com 2+ times fora saem os dois; com 1 fora, pênaltis; sem ninguém fora, jogam de novo.
    const waiting = state.challengeQueue || [],
      tied = homeScore === awayScore,
      shoot = shootoutOf(current),
      shootScore = shoot ? shootoutScores(shoot, current) : null,
      shootWinner = tied && shoot && shoot.finished && shootScore.home !== shootScore.away
        ? (shootScore.home > shootScore.away ? current.home : current.away)
        : "",
      penalties = !!shootWinner;
    let winner = !tied
      ? homeScore > awayScore
        ? current.home
        : current.away
      : penalties
        ? shootWinner
        : "Empate";
    if (!winner) {
      notify("Empate: escolha quem venceu nos pênaltis para encerrar.", true);
      gameFinishing = false;
      renderTimer();
      return;
    }
    if (current.stage === "final" && winner === "Empate") {
      notify((state.superLiga?.teams?.length === 2 ? "Jogo único empatado" : "Final empatada") + ": decida nos pênaltis antes de encerrar.", true);
      gameFinishing = false;
      renderTimer();
      return;
    }
    const loser = winner === current.home ? current.away : current.home,
      gameGoals = goals
        .filter((g) => g.game_id === current.id)
        .map((g) => ({
          id: g.id,
          player: g.player_name,
          team: g.team_name,
          scoringTeam: scoreTeam(g, current),
          ownGoal: !!g.own_goal,
          assistedBy: g.assisted_by || null,
          minute: Number(g.minute) || 1,
          created_at: g.created_at,
        }));
    const performance = performanceForGame(
        current,
        homeScore,
        awayScore,
        gameGoals,
      ),
      durationSeconds = Math.floor(timerElapsed()),
      entry = {
        ...current,
        homeLabel: teamLabel(current.home),
        awayLabel: teamLabel(current.away),
        roundId: current.roundId || state.roundId || null,
        homeScore,
        awayScore,
        winner,
        goals: gameGoals,
        incidents: [...(state.incidents || [])],
        shootout: shoot ? { ...shoot, homeScore: shootScore.home, awayScore: shootScore.away } : null,
        performance,
        durationSeconds,
        finishedAt: new Date().toISOString(),
        ...(current.superLigaId ? { homeColor: colorOf(current.home), awayColor: colorOf(current.away) } : {}),
      };
    // Gols sofridos por quem estava no gol na hora de cada gol (trocas de goleiro).
    entry.performance = gamePerformance(entry);
    if (current.superLigaId) {
      try {
        const history = [...(state.gameHistory || []), entry],
          sl = state.superLiga,
          sameLeague = sl && sl.id === current.superLigaId,
          nextSl = sameLeague ? superAfterGame(sl, current, entry, history) : sl,
          final = nextSl?.fixtures?.find((fixture) => fixture.stage === "final"),
          finalCreated = sameLeague && final && !sl.fixtures.some((fixture) => fixture.stage === "final"),
          upcoming = sameLeague && nextSl.status === "running" ? (nextSl.fixtures || []).find((fixture) => !fixture.gameId) : null;
        const ending =
          current.stage === "amistoso"
            ? " Amistoso: conta para os rankings e não muda o campeão."
            : sameLeague && nextSl.status === "finished"
            ? " Campeão da Super Liga: " + teamLabel(nextSl.champion) + "!"
            : finalCreated
              ? " Todos já se enfrentaram. Final: " + teamLabel(final.home) + " × " + teamLabel(final.away) + "."
              : upcoming
                ? " Próximo: " + teamLabel(upcoming.home) + " × " + teamLabel(upcoming.away) + "."
                : "";
        await saveState(
          { gameHistory: history, currentGame: null, ...(sameLeague ? { superLiga: nextSl } : {}), timer: freshTimer("coca"), shootout: null, incidents: [] },
          "Jogo " + current.number + " encerrado" + (winner === "Empate" ? " empatado" : penalties ? " nos pênaltis" : "") + "." + ending,
        );
      } finally { gameFinishing = false; renderTimer(); }
      return;
    }
    let queue, next;
    if (winner !== "Empate") {
      queue = [...waiting, loser];
      next = { home: winner, away: queue.shift() };
    } else if (waiting.length >= 2) {
      queue = [...waiting, current.home, current.away];
      next = { home: queue.shift(), away: queue.shift() };
    } else {
      queue = [...waiting];
      next = { home: current.home, away: current.away };
    }
    try {
      $("matchHome").value = next.home || "";
      $("matchAway").value = next.away || "";
      await saveState(
      {
        gameHistory: [...(state.gameHistory || []), entry],
        currentGame: null,
        pendingMatch: next,
        challengeQueue: queue,
        timer: freshTimer(state.timerMode || current.timerMode),
        shootout: null,
        incidents: [],
      },
      "Jogo " +
        current.number +
        " encerrado" +
        (winner === "Empate" ? " empatado" : penalties ? " nos pênaltis" : "") +
        ". Próximo: " +
        teamLabel(next.home) +
        " × " +
        teamLabel(next.away) +
        ".",
      );
    } finally { gameFinishing = false; renderTimer(); }
  }
  const THEME_ICONS = {
    moon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.7 14.6A8.6 8.6 0 0 1 9.4 3.3a.8.8 0 0 0-1-1A10 10 0 1 0 21.7 15.6a.8.8 0 0 0-1-1Z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.6" fill="currentColor"/><path d="M12 1.8v2.6M12 19.6v2.6M4.8 4.8l1.8 1.8M17.4 17.4l1.8 1.8M1.8 12h2.6M19.6 12h2.6M4.8 19.2l1.8-1.8M17.4 6.6l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  // ---------- Confirmação dentro do site (substitui a janela de confirmação padrão do navegador) ----------
  // Navegadores dentro de apps (Instagram, WhatsApp) e páginas incorporadas bloqueiam essa janela e respondem "Cancelar" sozinhos.
  // askConfirm abre uma janela do próprio site e devolve uma Promise<boolean>; só uma de cada vez (um segundo pedido recebe false).
  const askUI = { dialog: null, resolve: null, openedAt: 0, returnFocus: null };
  function askConfirm({ title = "Confirmar", message = "", confirmText = "Confirmar", tone = "green" } = {}) {
    if (askUI.resolve) return Promise.resolve(false);
    let dialog = askUI.dialog;
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "askDialog";
      dialog.className = "lv-sheet ask-sheet";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "askTitle");
      dialog.setAttribute("aria-describedby", "askMessage");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", (event) => {
        // Toque duplo rápido: o segundo toque não pode responder a janela que acabou de abrir.
        if (Date.now() - askUI.openedAt < 450) { dialog.querySelector('[data-ask="yes"]')?.focus(); return; }
        if (event.target === dialog) { askFinish(false); return; }
        const button = event.target.closest("[data-ask]");
        if (button) askFinish(button.dataset.ask === "yes");
      });
      dialog.addEventListener("cancel", (event) => { event.preventDefault(); askFinish(false); });
      askUI.dialog = dialog;
    }
    askUI.returnFocus = document.activeElement;
    dialog.innerHTML = '<header class="lv-sheet-head"><h2 id="askTitle">' + escapeHtml(title) + '</h2></header><div class="lv-sheet-body"><p id="askMessage" class="ask-message">' + escapeHtml(message) + '</p></div>' +
      '<footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-big ' + (tone === "red" ? "lv-red" : "lv-green") + '" data-ask="yes">' + escapeHtml(confirmText) + '</button><button type="button" class="lv-btn lv-white" data-ask="no">Cancelar</button></footer>';
    askUI.openedAt = Date.now();
    return new Promise((resolve) => {
      askUI.resolve = resolve;
      try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
      dialog.querySelector('[data-ask="yes"]').focus();
    });
  }
  function askFinish(answer) {
    const resolve = askUI.resolve, dialog = askUI.dialog, back = askUI.returnFocus;
    if (!resolve) return;
    askUI.resolve = null;
    if (dialog.open) dialog.close();
    if (back && document.contains(back) && typeof back.focus === "function") back.focus();
    resolve(answer);
  }
  // ---------- Jogo ao vivo: placar do espectador e painel do organizador ----------
  // Os controles antigos (#liveEngine, escondidos) continuam sendo o "motor": a tela nova só preenche e aciona esses controles,
  // então as regras (duração, pausa, pênaltis, ajustes, substituições, histórico) não mudam.
  const lvUI = { sheet: null, prepOpen: false, endAutoFor: null, marks: {} };
  function lvCrest(key, size) {
    const label = teamLabel(key), src = crestFor(key, label),
      initials = String(label || "").replace(/^time\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    return '<span class="lv-crest lv-crest-' + size + (src ? "" : " lv-initials") + '" aria-hidden="true">' + (src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(initials || "?")) + "</span>";
  }
  // Cores do time no painel do organizador (mesma fonte do Elenco: EL_HEAD; Super Liga: superHead).
  function lvColors(key) {
    const sl = superTeam(key);
    let [bg, ink] = sl ? superHead(sl) : EL_HEAD[key] || ["#3a3a35", "#ffffff"];
    if (String(bg).toLowerCase() === "#0d0d0d") bg = "#3a3a35";
    // Cor clara: números e textos sobre fundo preto (time sem cor fixa: branco).
    const light = { "#c2560c": "#f07a2e", "#ffc400": "#ffc400", "#1f6e3a": "#3dba6e", "#23439c": "#7a9bff" }[String(bg).toLowerCase()] || "#ffffff";
    return { bg, ink, light, line: String(bg).toLowerCase() === "#ffc400" ? "#e0a800" : bg };
  }
  function lvTeamVars(key) {
    const c = lvColors(key);
    return "--tc:" + c.line + ";--tb:" + c.bg + ";--ti:" + c.ink + ";--tl:" + c.light;
  }
  // Nomes sempre numa linha só: diminui a fonte até caber (mesmo ajuste da Escalação dos times).
  function lvFit(root) {
    root?.querySelectorAll(".lv-fp-name, .lv-kname, .lv-oname, .lv-gname").forEach((el) => {
      el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
      const floor = el.classList.contains("lv-oname") ? 6 : 9;
      while (el.scrollWidth > el.clientWidth + 0.5 && size > floor && guard++ < 40) { size -= 0.5; el.style.fontSize = size + "px"; }
    });
  }
  window.addEventListener("resize", () => { lvFit($("lvBoard")); lvFit($("lvKeepers")); lvFit($("lvSpectator")); lvFit($("lvGoalsHome")); lvFit($("lvGoalsAway")); });
  // Goleiros: duas colunas de botões que escolhem no mesmo select de antes (#keeperHome / #keeperAway).
  function lvKeeperColumns() {
    const { home, away } = lvMatchTeams();
    lvUI.kOpen = lvUI.kOpen || {};
    return [["home", home, "keeperHome"], ["away", away, "keeperAway"]].map(([side, team, id]) => {
      const select = $(id), chosen = select.value, off = select.disabled, open = !!lvUI.kOpen[side] && !off,
        names = [...select.options].map((option) => option.value).filter(Boolean).sort((a, b) => keeper(b) - keeper(a));
      if (!team) return "";
      const label = teamLabel(team);
      // Fechada: mostra o time, o selo e o goleiro escolhido. Tocar abre a lista.
      return '<div class="lv-kcol' + (open ? " is-open" : "") + '" style="' + lvTeamVars(team) + '"><button type="button" class="lv-khead" data-lv-ktoggle="' + side + '" aria-expanded="' + open + '" aria-controls="lvKList-' + side + '"' + (off ? " disabled" : "") + ">" +
        '<span class="lv-ktop">' + lvCrest(team, "k") + '<strong id="lvK-' + side + '">' + escapeHtml(label) + "</strong>" + '<span class="lv-kchev" aria-hidden="true">' + (open ? "▴" : "▾") + "</span></span>" +
        '<span class="lv-kpick">' + (chosen ? '<span class="lv-kname">' + escapeHtml(displayName(chosen)) + '</span><b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b>' : '<span class="lv-kname lv-kmuted">' + (open ? "Escolha abaixo" : "Toque para escolher") + "</span>") + "</span>" +
        (chosen ? '<span class="lv-kstate is-ok">✓ ESCOLHIDO</span>' : '<span class="lv-kstate">FALTA ESCOLHER</span>') + "</button>" +
        '<div class="lv-klist" id="lvKList-' + side + '" role="radiogroup" aria-labelledby="lvKeepersTitle lvK-' + side + '"' + (open ? "" : " hidden") + ">" +
        (names.length ? names.map((name) => '<button type="button" class="lv-kbtn' + (chosen === name ? " is-on" : "") + '" role="radio" aria-checked="' + (chosen === name) + '" data-lv-keeper="' + side + '" data-name="' + escapeHtml(name) + '"' + (off ? " disabled" : "") + '><span class="lv-kname">' + escapeHtml(displayName(name)) + "</span>" + (chosen === name ? '<b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</button>").join("") : '<p class="lv-muted">Sem jogadores.</p>') +
        "</div></div>";
    }).join("");
  }

  function lvFieldColumn(game, s) {
    const team = game[s], keeperName = game[s + "Keeper"], players = [...lineupForTeam(team, game)].sort((a, b) => (b === keeperName) - (a === keeperName)),
      title = s === "home" ? lvCrest(team, "xs") + "<span>" + escapeHtml(teamLabel(team).toUpperCase()) + " · EM CAMPO</span>" : "<span>EM CAMPO · " + escapeHtml(teamLabel(team).toUpperCase()) + "</span>" + lvCrest(team, "xs");
    return '<div class="lv-fcol2 is-' + s + '" style="' + lvTeamVars(team) + '"><p class="lv-fhead">' + title + '</p><ul class="lv-fplist">' +
      (players.length ? players.map((name) => {
        const suspension = (state.incidents || []).find((item) => item.type === "hand" && item.gameId === game.id && item.player === name && Number(item.expiresAt) > nowMs());
        return '<li class="lv-fp' + (suspension ? " is-out" : "") + '"><span class="lv-fp-name">' + escapeHtml(displayName(name)) + "</span>" + (name === keeperName ? '<b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + (suspension ? "<small>fora</small>" : "") + "</li>";
      }).join("") : '<li class="lv-muted">Sem jogadores</li>') + "</ul></div>";
  }
  function lvSet(id, html) {
    const el = $(id);
    if (el && lvUI.marks[id] !== html) { lvUI.marks[id] = html; el.innerHTML = html; }
    return el;
  }
  function lvMinute() {
    return Math.max(1, Math.ceil(Math.max(0, Math.floor(timerElapsed())) / 60));
  }
  function lvModeName(mode) {
    return mode === "coca" ? "Modo Super Liga" : "Modo Liga";
  }
  function lvGameOfNight(game) {
    const same = (state.gameHistory || []).filter((item) => game.roundId ? item.roundId === game.roundId : !item.superLigaId).length;
    return same + 1;
  }
  function lvDurationMin(game) {
    const timer = state.timer || {};
    return game ? Math.round((timer.duration || (game.durationMinutes || 8) * 60) / 60) : Math.min(180, Math.max(1, Number(state.durationMinutes) || 8));
  }
  function lvKeeperOf(game, side) {
    return game ? game[side + "Keeper"] : $(side === "home" ? "keeperHome" : "keeperAway")?.value;
  }
  function lvChips(players, keeperName, game) {
    return players.length
      ? players.map((name) => {
          const suspension = game && (state.incidents || []).find((item) => item.type === "hand" && item.gameId === game.id && item.player === name && Number(item.expiresAt) > nowMs());
          return '<li class="lv-chip' + (suspension ? " is-out" : "") + '">' + escapeHtml(displayName(name)) + (name === keeperName ? ' <b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + (suspension ? ' <small>fora</small>' : "") + "</li>";
        }).join("")
      : '<li class="lv-muted">Sem jogadores</li>';
  }
  function lvScorers(game, team) {
    const list = goals.filter((goal) => goal.game_id === game.id && scoreTeam(goal, game) === team).sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0));
    return list.length
      ? list.map((goal) => "<li>⚽ " + escapeHtml(displayName(goal.player_name || "Gol")) + " " + (Number(goal.minute) || 0) + "′" + (goal.own_goal ? " <small>(contra)</small>" : "") + "</li>").join("")
      : '<li class="lv-muted">Sem gols</li>';
  }
  // Times na espera: na Liga, a fila de desafiantes; na Super Liga, os outros times.
  function lvWaiting(game) {
    const playing = new Set([game?.home, game?.away].filter(Boolean));
    if ((game?.timerMode || activeLiveMode()) === "coca") return (state.superLiga?.teams || []).map((team) => team.key).filter((key) => !playing.has(key));
    const order = [...(state.challengeQueue || []), ...(state.teams || []).map((team) => team.name)];
    return order.filter((name, index) => name && !playing.has(name) && order.indexOf(name) === index && (state.teams || []).some((team) => team.name === name));
  }
  // Último jogo encerrado do modo que está valendo agora (para o card ENCERRADO).
  function lvLastGame() {
    const mode = activeLiveMode(), history = state.gameHistory || [];
    const list = mode === "coca"
      ? history.filter((game) => game.superLigaId && game.superLigaId === state.superLiga?.id)
      : history.filter((game) => !game.superLigaId && (!state.roundId || game.roundId === state.roundId));
    return list[list.length - 1] || null;
  }
  function lvResultText(game) {
    const winSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null;
    if (!winSide) return "Empate";
    const name = gameTeamLabel(game, winSide);
    if (Number(game.homeScore) === Number(game.awayScore) && shoot) return name + " venceu nos pênaltis (" + shoot[winSide + "Score"] + " × " + shoot[(winSide === "home" ? "away" : "home") + "Score"] + ")";
    return "Vencedor: " + name;
  }
  function lvEndedCard(game) {
    const winSide = game.winner === game.home ? "home" : game.winner === game.away ? "away" : null,
      pending = currentPending(),
      nextTeams = pending ? [pending.home, pending.away].filter((team) => team && team !== game.home && team !== game.away) : [],
      nextLine = pending && pending.home && pending.away
        ? activeLiveMode() === "coca" ? "Próximo: " + teamLabel(pending.home) + " × " + teamLabel(pending.away)
          : nextTeams.length ? "Próximo: " + nextTeams.map(teamLabel).join(" e ") + (nextTeams.length > 1 ? " entram" : " entra") + " em quadra" : ""
        : "",
      col = (side) => '<div class="lv-fcol' + (winSide && winSide !== side ? " is-lose" : "") + '">' + lvCrest(game[side], "l") + "<strong>" + escapeHtml(gameTeamLabel(game, side)) + "</strong></div>";
    return '<section class="lv-card is-ended" aria-label="Jogo encerrado"><div class="lv-strip"><span class="lv-tag">ENCERRADO</span><span>' + lvModeName(game.timerMode) + " · Jogo " + game.number + "</span></div>" +
      '<div class="lv-final">' + col("home") + '<div class="lv-fscore"><b class="' + (winSide === "away" ? "is-lose" : "") + '">' + (Number(game.homeScore) || 0) + '</b><i aria-hidden="true">×</i><b class="' + (winSide === "home" ? "is-lose" : "") + '">' + (Number(game.awayScore) || 0) + "</b></div>" + col("away") + "</div>" +
      '<p class="lv-pill">' + escapeHtml(lvResultText(game)) + "</p>" + (nextLine ? '<p class="lv-nextline">' + escapeHtml(nextLine) + "</p>" : "") + "</section>";
  }
  function lvNextCard(home, away) {
    const minutes = lvDurationMin(null);
    return '<section class="lv-card is-next" aria-label="Próxima partida"><div class="lv-strip"><span class="lv-tag">PRÓXIMA PARTIDA</span><span>' + lvModeName(activeLiveMode()) + "</span>" + (state.venue ? '<span class="lv-strip-right">' + escapeHtml(state.venue) + "</span>" : "") + "</div>" +
      '<div class="lv-score"><div class="lv-side">' + lvCrest(home, "xl") + "<strong>" + escapeHtml(teamLabel(home)) + '</strong></div><div class="lv-mid"><div class="lv-vs" aria-hidden="true">×</div><div class="lv-idle-clock">' + clockText(minutes * 60) + '</div><small>Aguardando o início</small></div><div class="lv-side">' + lvCrest(away, "xl") + "<strong>" + escapeHtml(teamLabel(away)) + "</strong></div></div>" +
      '<p class="lv-vsline">' + escapeHtml(teamLabel(home) + " × " + teamLabel(away)) + "</p></section>";
  }
  function lvLiveCard(game) {
    const homeScore = currentScore(game.home), awayScore = currentScore(game.away), shoot = shootoutOf(game),
      shootLine = shoot ? (() => { const sc = shootoutScores(shoot, game); return '<p class="lv-shoot">Pênaltis ' + sc.home + " × " + sc.away + "</p>"; })() : "",
      waiting = lvWaiting(game),
      side = (key, cls) => '<div class="lv-side ' + cls + '">' + lvCrest(key, "xl") + "<strong>" + escapeHtml(teamLabel(key)) + "</strong></div>";
    return '<section class="lv-card is-live" aria-label="Jogo ao vivo"><div class="lv-strip"><span class="lv-live"><i aria-hidden="true"></i>AO VIVO</span><span>' + lvModeName(game.timerMode) + " · Jogo " + lvGameOfNight(game) + " da noite</span>" +
      '<span class="lv-strip-right">' + escapeHtml([state.venue, lvDurationMin(game) + " min"].filter(Boolean).join(" · ")) + "</span></div>" +
      '<div class="lv-score">' + side(game.home, "lv-home") +
      '<div class="lv-mid"><div class="lv-nums" aria-label="' + escapeHtml(teamLabel(game.home) + " " + homeScore + " a " + awayScore + " " + teamLabel(game.away)) + '"><b>' + homeScore + '</b><i aria-hidden="true">×</i><b>' + awayScore + "</b></div>" +
      '<div class="lv-clock-value" data-lv-clock>' + clockText(timerRemaining()) + '</div><div class="lv-bar" aria-hidden="true"><i data-lv-bar></i></div><small data-lv-clock-label>tempo restante</small>' + shootLine + "</div>" +
      side(game.away, "lv-away") + "</div>" +
      '<div class="lv-scorers"><ul aria-label="' + escapeHtml("Gols do " + teamLabel(game.home)) + '">' + lvScorers(game, game.home) + '</ul><ul aria-label="' + escapeHtml("Gols do " + teamLabel(game.away)) + '">' + lvScorers(game, game.away) + "</ul></div>" +
      '<div class="lv-field lv-field-cols"><div class="lv-ofield2">' + lvFieldColumn(game, "home") + lvFieldColumn(game, "away") + "</div></div></section>" +
      (waiting.length ? '<section class="lv-wait" aria-label="Na espera"><p class="lv-field-title">NA ESPERA</p><ul>' + waiting.map((key) => "<li>" + lvCrest(key, "s") + "<span>" + escapeHtml(teamLabel(key)) + "</span></li>").join("") + "</ul></section>" : "");
  }
  // Atualiza o relógio, a barra e o estado sem redesenhar o card inteiro.
  function lvTick(root, game) {
    if (!root || !game) return;
    const timer = state.timer || {}, remaining = timerRemaining(timer), duration = timer.duration || 480;
    const clock = root.querySelector("[data-lv-clock]"), bar = root.querySelector("[data-lv-bar]"), label = root.querySelector("[data-lv-clock-label]");
    if (clock) clock.textContent = clockText(remaining);
    if (bar) bar.style.width = Math.max(0, Math.min(100, (remaining / duration) * 100)) + "%";
    if (label) label.textContent = remaining === 0 ? "fim do tempo" : isPauseActive(timer) ? "⏸ pausado" : "tempo restante";
  }
  function renderSpectator() {
    const box = $("lvSpectator");
    if (!box) return;
    const locked = isEditLocked();
    box.hidden = !locked;
    if (!locked) return;
    const game = state.currentGame, pending = currentPending(), last = lvLastGame();
    let html;
    if (game) html = lvLiveCard(game);
    else if (pending?.home && pending?.away && (pending.prepared || !last)) html = lvNextCard(pending.home, pending.away);
    else if (last) html = lvEndedCard(last);
    else html = '<section class="lv-card is-next"><div class="lv-strip"><span class="lv-tag">PRÓXIMA PARTIDA</span><span>' + lvModeName(activeLiveMode()) + '</span></div><p class="lv-empty">Os jogos aparecem aqui quando o organizador preparar a partida.</p></section>';
    const changed = lvUI.marks.lvSpectator !== html;
    lvSet("lvSpectator", html);
    if (changed) lvFit(box);
    lvTick(box, game);
  }
  // ---------- Painel do organizador ----------
  function lvMatchTeams() {
    const game = state.currentGame, pending = currentPending();
    return { home: game?.home || $("matchHome").value || pending?.home || "", away: game?.away || $("matchAway").value || pending?.away || "" };
  }
  function lvConvocados(team, side) {
    return team ? convocadosFor(team, side) : [];
  }
  function lvMissingText() {
    const { home, away } = lvMatchTeams(), pending = currentPending(), superMode = isSuperMode();
    if (!pending) return superMode ? "Monte a Super Liga e sorteie a ordem dos jogos no painel abaixo." : "Sorteie os times em Elenco e sorteio para preparar a partida.";
    if (!home || !away) return "Escolha os dois times.";
    if (home === away) return "Escolha dois times diferentes.";
    for (const [team, side] of [[home, "home"], [away, "away"]]) {
      const count = lvConvocados(team, side).length;
      if (count < 4) return teamLabel(team) + " tem só " + count + (count === 1 ? " jogador" : " jogadores") + ": toque em Ajustar jogadores.";
    }
    const noKeeper = [[home, "keeperHome"], [away, "keeperAway"]].filter(([, id]) => !$(id).value).map(([team]) => teamLabel(team));
    if (noKeeper.length) return "Escolha o goleiro do " + noKeeper.join(" e do ") + " para liberar Partida preparada.";
    if (!pending.prepared) return "Tudo certo: toque em ✓ Partida preparada.";
    return "";
  }
  function lvStep() {
    const game = state.currentGame;
    if (!game) return "prep";
    return timerRemaining() === 0 || shootoutOf(game) ? "end" : "play";
  }
  function lvLogItems(game) {
    const items = [{ minute: 0, at: game.startedAt, html: "▶ Início do jogo", kind: "start" }];
    for (const entry of game.pauseLog || []) items.push({ minute: entry.minute, at: entry.at, html: entry.kind === "pause" ? "⏸ Pausa" : "▶ Jogo retomado", kind: "pause" });
    for (const goal of goals.filter((item) => item.game_id === game.id))
      items.push({ minute: Number(goal.minute) || 0, at: goal.created_at, kind: "goal", id: goal.id,
        html: "⚽ <strong>" + (goal.own_goal ? "Gol contra de " : "Gol de ") + escapeHtml(displayName(goal.player_name)) + "</strong> · " + escapeHtml(teamLabel(scoreTeam(goal, game))) + (goal.assisted_by ? " <small>assist. " + escapeHtml(displayName(goal.assisted_by)) + "</small>" : "") });
    for (const sub of game.substitutions || [])
      items.push({ minute: Number(sub.minute) || 0, at: subMoment(game, sub), kind: "sub", id: sub.id,
        html: "⇄ " + escapeHtml(teamLabel(sub.team)) + ': <b class="lv-in">↑ ' + escapeHtml(displayName(sub.in)) + '</b> <b class="lv-out">↓ ' + escapeHtml(displayName(sub.out)) + "</b>" + (sub.keeper ? ' <small><b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b> ' + escapeHtml(displayName(sub.keeperIn || sub.in)) + " vai pro gol</small>" : "") });
    for (const item of (state.incidents || []).filter((entry) => entry.gameId === game.id && entry.type !== "sub"))
      items.push({ minute: Number(item.minute) || 0, at: item.createdAt, kind: "incident", id: item.id,
        html: "⚠ <strong>" + escapeHtml(item.type === "warning" ? item.warningType || "Advertência" : incidentLabels[item.type] || item.type) + "</strong> · " + escapeHtml(displayName(item.player || "")) + (item.note ? " <small>" + escapeHtml(item.note) + "</small>" : "") });
    const time = (value) => { const date = typeof value === "number" ? new Date(value) : new Date(value || 0); return date.getTime() || 0; };
    items.forEach((item, index) => { item.seq = index; });
    // Mais recente primeiro; no mesmo minuto e horário, o último registrado fica em cima.
    return items.sort((a, b) => b.minute - a.minute || time(b.at) - time(a.at) || b.seq - a.seq);
  }
  function renderOrganizer() {
    const org = $("lvOrg");
    if (!org || isEditLocked()) return;
    const game = state.currentGame, pending = currentPending(), { home, away } = lvMatchTeams(), step = lvStep(), last = lvLastGame(),
      steps = ["prep", "play", "end"], stepIndex = steps.indexOf(step);
    org.querySelectorAll("#lvSteps li").forEach((li, index) => {
      li.classList.toggle("is-current", index === stepIndex);
      li.classList.toggle("is-done", index < stepIndex || (!game && index === 0 && !!pending?.prepared && false));
      if (index === stepIndex) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
    // Card ENCERRADO também para o organizador, até a próxima partida ser preparada.
    lvSet("lvOrgResult", !game && last && !pending?.prepared ? lvEndedCard(last) : "");
    const prepVisible = !game || lvUI.prepOpen;
    $("lvPrepare").hidden = !prepVisible;
    $("lvBeginWrap").hidden = !!game;
    $("lvPlay").hidden = !game;
    // Quem vai jogar
    const teamsDisabled = !!game || $("matchHome").disabled;
    lvSet("lvTeams", [["home", home, "Casa"], ["away", away, "Visitante"]].map(([side, team, word]) =>
      '<button type="button" class="lv-team-btn' + (team ? " has-team" : "") + '" data-lv-pick="' + side + '"' + (team ? ' style="' + lvTeamVars(team) + '"' : "") + (teamsDisabled ? " disabled" : "") + ">" + (team ? lvCrest(team, "m") : '<span class="lv-crest lv-crest-m lv-initials" aria-hidden="true">?</span>') +
      "<span><strong>" + escapeHtml(team ? teamLabel(team) : "Escolher time") + "</strong><small>" + word + (teamsDisabled ? "" : " · trocar") + "</small></span></button>").join('<span class="lv-x" aria-hidden="true">×</span>'));
    // Ajustar jogadores · contagem real
    const superMode = isSuperMode(), adjust = $("lvAdjustBtn");
    if (home && away) {
      const count = (team, side) => superMode ? starterSelection(team, side).length + "/" + effectiveOnCourt() : lvConvocados(team, side).length + "/5";
      adjust.textContent = "👥 Ajustar jogadores · " + count(home, "home") + " e " + count(away, "away");
    } else adjust.textContent = "👥 Ajustar jogadores";
    adjust.disabled = !!game || !(superMode ? home && away : (state.teams || []).length);
    // Duração
    const minutes = Math.min(180, Math.max(1, Number(state.durationMinutes) || 8)), custom = ![6, 8, 10].includes(minutes) || lvUI.customDuration;
    lvSet("lvDurations", [6, 8, 10].map((value) => '<button type="button" class="lv-seg' + (!custom && minutes === value ? " is-on" : "") + '" data-lv-duration="' + value + '" aria-pressed="' + (!custom && minutes === value) + '"' + (game ? " disabled" : "") + ">" + value + " min</button>").join("") +
      '<button type="button" class="lv-seg' + (custom ? " is-on" : "") + '" data-lv-duration="outro" aria-pressed="' + custom + '"' + (game ? " disabled" : "") + ">Outro</button>" +
      (custom ? '<label class="lv-other">Minutos<input type="number" inputmode="numeric" min="1" max="180" step="1" id="lvDurationOther" value="' + minutes + '"' + (game ? " disabled" : "") + "></label>" : ""));
    // Goleiros
    const keepersHtml = lvKeeperColumns();
    if (lvUI.marks.lvKeepers !== keepersHtml) { lvSet("lvKeepers", keepersHtml); lvFit($("lvKeepers")); }
    // Preparada
    const prepared = !!pending?.prepared && !game, preparedBtn = $("lvPrepared");
    preparedBtn.hidden = prepared;
    preparedBtn.disabled = $("preparedBtn").disabled;
    lvSet("lvPrepState", prepared ? '<div class="lv-ready"><strong>✓ Partida preparada</strong><span>' + escapeHtml(teamLabel(home) + " × " + teamLabel(away)) + '</span><button type="button" class="lv-link" data-lv-unprepare>Desfazer</button></div>' : "");
    const missing = game ? "" : lvMissingText();
    const missingEl = $("lvMissing");
    if (missingEl.textContent !== missing) missingEl.textContent = missing;
    $("lvBegin").disabled = $("beginGame").disabled;
    // Resumo depois de começar
    const summary = $("lvSummary");
    summary.hidden = !game;
    lvSet("lvSummary", game ? '<span>✓ ' + escapeHtml(teamLabel(game.home) + " × " + teamLabel(game.away) + " · " + lvDurationMin(game) + " min") + '</span><button type="button" class="lv-link" data-lv-alter>' + (lvUI.prepOpen ? "Fechar" : "Alterar") + "</button>" : "");
    // Placar
    const hs = game ? currentScore(game.home) : 0, as = game ? currentScore(game.away) : 0;
    lvSet("lvBoard", home && away
      ? '<div class="lv-oboard" style="' + (() => { const h = lvColors(home), a = lvColors(away); return "--hb:" + h.bg + ";--hi:" + h.ink + ";--hl:" + h.light + ";--ab:" + a.bg + ";--ai:" + a.ink + ";--al:" + a.light; })() + '"><div class="lv-oteam">' + lvCrest(home, "b") + '<strong class="lv-oname">' + escapeHtml(teamLabel(home)) + '</strong></div><div class="lv-onums" aria-label="Placar ' + hs + " a " + as + '"><b class="is-home">' + hs + '</b><i aria-hidden="true">×</i><b class="is-away">' + as + '</b></div><div class="lv-oteam is-away">' + lvCrest(away, "b") + '<strong class="lv-oname">' + escapeHtml(teamLabel(away)) + "</strong></div></div>"
      : '<p class="lv-muted lv-center">Escolha os times para ver o placar.</p>');
    if (lvUI.marks.lvBoardFit !== lvUI.marks.lvBoard) { lvUI.marks.lvBoardFit = lvUI.marks.lvBoard; lvFit($("lvBoard")); }
    // Autores dos gols ao lado do cronômetro: pílulas na cor do time que ganhou o gol (casa à esquerda, visitante à direita).
    const goalPills = (team) => {
      if (!game) return "";
      const c = lvColors(team);
      return goals.filter((goal) => goal.game_id === game.id && scoreTeam(goal, game) === team).sort((a, b) => (Number(a.minute) || 0) - (Number(b.minute) || 0))
        .map((goal) => '<li class="lv-gpill" style="--tb:' + c.bg + ";--ti:" + c.ink + '"><span class="lv-gname">⚽ ' + escapeHtml(displayName(goal.player_name || "Gol")) + (goal.own_goal ? " (contra)" : "") + "</span><small>" + (Number(goal.minute) || 0) + "′</small></li>").join("");
    };
    const gh = goalPills(game?.home), ga = goalPills(game?.away), gChanged = lvUI.marks.lvGoalsHome !== gh || lvUI.marks.lvGoalsAway !== ga;
    lvSet("lvGoalsHome", gh); lvSet("lvGoalsAway", ga);
    if (gChanged) { lvFit($("lvGoalsHome")); lvFit($("lvGoalsAway")); }
    // Cronômetro e estado
    const timer = state.timer || {}, remaining = game ? timerRemaining(timer) : minutes * 60, paused = !!game && isPauseActive(timer),
      used = pauseBudgetUsed({ ...timer, mode: game ? timer.mode || "liga" : state.timerMode || "liga" }), limitText = (game ? timer.mode : state.timerMode) === "coca" ? "02:00" : "01:00";
    const timerEl = $("lvTimer");
    if (timerEl.textContent !== clockText(remaining)) timerEl.textContent = clockText(remaining);
    timerEl.classList.toggle("is-paused", paused);
    const stateText = !game ? "AGUARDANDO INÍCIO" : shootoutOf(game) && !shootoutOf(game).finished ? "🥅 PÊNALTIS" : remaining === 0 ? "⏹ FIM DO TEMPO" : (paused ? "⏸ PAUSADO" : "● RODANDO") + " · PAUSA USADA " + clockText(Math.ceil(used / 1000)) + " / " + limitText;
    const stateEl = $("lvState");
    if (stateEl.textContent !== stateText) stateEl.textContent = stateText;
    stateEl.className = "lv-state" + (paused ? " is-paused" : game && remaining > 0 ? " is-running" : "");
    if (game) {
      $("lvGoal").disabled = $("openGoalDialog").disabled;
      const pauseBtn = $("lvPause");
      pauseBtn.disabled = $("pauseTimer").disabled;
      const pauseHtml = paused ? "<span>▶ Continuar</span><small>volta a contar</small>" : "<span>⏸ Pausar</span><small>congela o tempo</small>";
      if (lvUI.marks.pause !== pauseHtml) { lvUI.marks.pause = pauseHtml; pauseBtn.innerHTML = pauseHtml; }
      $("lvSub").disabled = !game;
      $("lvWarn").disabled = !game;
      $("lvFinish").disabled = $("finishGame").disabled;
      lvSet("lvLog", lvLogItems(game).map((item) => '<li class="lv-log-item lv-log-' + item.kind + '"><span class="lv-min">' + item.minute + "′</span><span class=\"lv-log-text\">" + item.html + "</span>" +
        (item.id ? '<button type="button" class="lv-undo" data-lv-undo="' + item.kind + '" data-id="' + escapeHtml(item.id) + '">Desfazer</button>' : "") + "</li>").join(""));
      // Fim do tempo: abre a decisão sozinho uma vez por jogo.
      if (remaining === 0 && lvUI.endAutoFor !== game.id && !shootoutOf(game) && !$("lvSheet").open && !$("shootoutDialog").open) { lvUI.endAutoFor = game.id; lvOpenSheet({ kind: "end", auto: true }); }
    }
    if (lvUI.sheet && $("lvSheet").open) lvRenderSheet();
  }
  function renderLive() {
    renderSpectator();
    renderOrganizer();
  }
  // ---------- Painéis (sobem de baixo) ----------
  function lvOpenSheet(sheet) {
    const dialog = $("lvSheet");
    lvUI.sheet = sheet;
    lvUI.marks.sheet = "";
    lvRenderSheet();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("[data-lv-first]")?.focus();
  }
  function lvCloseSheet() {
    const dialog = $("lvSheet");
    lvUI.sheet = null;
    if (dialog.open) dialog.close();
  }
  function lvSheetHead(title, sub = "") {
    return '<header class="lv-sheet-head"><h2 id="lvSheetTitle">' + title + "</h2>" + (sub ? "<p>" + sub + "</p>" : "") + '<button type="button" class="lv-close" data-lv-close aria-label="Fechar">✕</button></header>';
  }
  function lvTeamToggle(game, chosen, attr, colored = false) {
    return '<div class="lv-pick2">' + [game.home, game.away].map((team) => '<button type="button" class="lv-choice' + (colored ? " lv-tchoice" : "") + (chosen === team ? " is-on" : "") + '" aria-pressed="' + (chosen === team) + '" ' + attr + '="' + escapeHtml(team) + '"' + (colored ? ' style="' + lvTeamVars(team) + '"' : "") + ">" + lvCrest(team, "s") + "<span>" + escapeHtml(teamLabel(team)) + "</span></button>").join("") + "</div>";
  }
  function lvRenderSheet() {
    const sheet = lvUI.sheet, dialog = $("lvSheet");
    if (!sheet) return;
    const game = state.currentGame;
    let html = "";
    if (sheet.kind === "goal" && game) {
      const scoring = sheet.team || game.home, author = sheet.own ? (scoring === game.home ? game.away : game.home) : scoring,
        players = lineupForTeam(author, game).filter((name) => !isPlayerSuspended(name, game)),
        scorer = players.includes(sheet.scorer) ? sheet.scorer : "",
        mates = !sheet.own && scorer ? lineupForTeam(scoring, game).filter((name) => name !== scorer && !isPlayerSuspended(name, game)) : [],
        assist = mates.includes(sheet.assist) ? sheet.assist : "";
      html = lvSheetHead("REGISTRAR GOL · " + String(lvMinute()).padStart(2, "0") + "′", "O minuto é marcado sozinho pelo cronômetro.") +
        '<div class="lv-sheet-body"><p class="lv-step-title">1. DE QUAL TIME? <small>(time que ganha o gol)</small></p>' + lvTeamToggle(game, scoring, "data-lv-goal-team") +
        '<p class="lv-step-title">2. QUEM FEZ?</p><div class="lv-grid2">' + players.map((name) => '<button type="button" class="lv-choice' + (scorer === name ? " is-on" : "") + '" aria-pressed="' + (scorer === name) + '" data-lv-scorer="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + (name === game[(author === game.home ? "home" : "away") + "Keeper"] ? ' <b class="lv-g">G</b>' : "") + "</button>").join("") +
        '<button type="button" class="lv-choice lv-dashed' + (sheet.own ? " is-on" : "") + '" aria-pressed="' + !!sheet.own + '" data-lv-own>' + (sheet.own ? "✓ Gol contra (de um jogador do " + escapeHtml(teamLabel(author)) + ")" : "Gol contra") + "</button></div>" +
        (!sheet.own ? '<p class="lv-step-title">3. ASSISTÊNCIA <small>(opcional)</small></p><div class="lv-chips-pick"><button type="button" class="lv-chipbtn' + (!assist ? " is-on" : "") + '" aria-pressed="' + !assist + '" data-lv-assist="">Sem assistência</button>' + mates.map((name) => '<button type="button" class="lv-chipbtn' + (assist === name ? " is-on" : "") + '" aria-pressed="' + (assist === name) + '" data-lv-assist="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + "</button>").join("") + (!scorer ? '<span class="lv-muted">Escolha primeiro quem fez o gol.</span>' : "") + "</div>" : "") +
        '</div><footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-green lv-big" data-lv-confirm-goal' + (scorer && !goalSubmitting ? "" : " disabled") + ">" + (scorer ? "✓ Confirmar " + (sheet.own ? "gol contra de " : "gol de ") + escapeHtml(displayName(scorer)) : "✓ Confirmar gol") + '</button><button type="button" class="lv-btn lv-white" data-lv-close>Cancelar</button></footer>';
    } else if (sheet.kind === "sub" && game) {
      const team = sheet.team || game.home, side = team === game.home ? "home" : "away", onField = lineupForTeam(team, game),
        out = onField.includes(sheet.out) ? sheet.out : "", bench = game[side + "Bench"] || [], subs = game.substitutions || [],
        leftEarlier = bench.filter((name) => subs.some((item) => item.team === team && item.out === name)),
        groups = [];
      if (leftEarlier.length) groups.push({ label: "JÁ SAIU E PODE VOLTAR", back: true, team, players: leftEarlier });
      if (game.timerMode === "coca") { const rest = bench.filter((name) => !leftEarlier.includes(name)); if (rest.length) groups.push({ label: "RESERVAS DO " + teamLabel(team).toUpperCase(), team, players: rest }); }
      else { const rest = bench.filter((name) => !leftEarlier.includes(name)); if (rest.length) groups.push({ label: "BANCO", team, players: rest }); groups.push(...substitutionPool(game, bench).map((group) => ({ label: teamLabel(group.team).toUpperCase() + " (NA ESPERA)", team: group.team, players: group.players }))); }
      // De onde o jogador vem: o próprio time (já saiu) ou o time de origem no sorteio.
      const fromTeam = (group, name) => (group.back || superTeam(team) ? group.team : lvOriginalTeam(name) || group.team);
      const all = groups.flatMap((group) => group.players), inn = all.includes(sheet.in) ? sheet.in : "",
        keeperOut = out && out === game[side + "Keeper"], keeperOptions = keeperOut && inn ? [inn, ...onField.filter((name) => name !== out)] : [],
        keeperTo = keeperOptions.includes(sheet.keeperTo) ? sheet.keeperTo : inn,
        leftMinute = (name) => { const item = [...subs].reverse().find((entry) => entry.team === team && entry.out === name); return item ? item.minute : null; };
      html = lvSheetHead("TROCAR JOGADOR · " + String(lvMinute()).padStart(2, "0") + "′", "Quem sai pode voltar depois.") +
        '<div class="lv-sheet-body"><p class="lv-step-title">1. DE QUAL TIME?</p>' + lvTeamToggle(game, team, "data-lv-sub-team", true) +
        '<p class="lv-step-title">2. QUEM SAI?</p><div class="lv-grid2">' + onField.map((name) => '<button type="button" class="lv-choice lv-pchoice' + (out === name ? " is-out" : "") + '" style="' + lvTeamVars(team) + '" aria-pressed="' + (out === name) + '" data-lv-sub-out="' + escapeHtml(name) + '">' + (out === name ? "↓ " : "") + escapeHtml(displayName(name)) + (name === game[side + "Keeper"] ? ' <b class="lv-g">G</b>' : "") + "</button>").join("") + "</div>" +
        '<p class="lv-step-title">3. QUEM ENTRA?</p>' + (groups.length ? groups.map((group) => '<div class="lv-group lv-tgroup' + (group.back ? " is-back" : "") + '" style="' + lvTeamVars(group.team) + '"><p class="lv-tgroup-title">' + lvCrest(group.team, "xs") + "<span>" + escapeHtml(group.label) + '</span></p><div class="lv-grid2">' + group.players.map((name) => '<button type="button" class="lv-choice lv-pchoice' + (inn === name ? " is-in" : "") + '" style="' + lvTeamVars(fromTeam(group, name)) + '" aria-pressed="' + (inn === name) + '" data-lv-sub-in="' + escapeHtml(name) + '">' + (inn === name ? "↑ " : group.back ? "↺ " : "") + escapeHtml(displayName(name)) + (group.back && leftMinute(name) ? " <small>(saiu " + leftMinute(name) + "′)</small>" : "") + "</button>").join("") + "</div></div>").join("") : '<p class="lv-muted">Sem jogadores disponíveis para entrar.</p>') +
        (keeperOut ? '<div class="lv-group is-keeper"><p>QUEM VAI PRO GOL? <small>(o goleiro está saindo)</small></p>' + (inn ? '<div class="lv-grid2">' + keeperOptions.map((name) => '<button type="button" class="lv-choice' + (keeperTo === name ? " is-on" : "") + '" aria-pressed="' + (keeperTo === name) + '" data-lv-keeper-to="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + (name === inn ? " <small>(entra)</small>" : "") + (keeperTo === name ? ' <b class="lv-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</button>").join("") + "</div>" : '<p class="lv-muted">Escolha antes quem entra.</p>') + "</div>" : "") +
        '</div><footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-black lv-big" data-lv-confirm-sub' + (out && inn && !substituting ? "" : " disabled") + ">" + (out && inn ? "⇄ Confirmar: sai " + escapeHtml(displayName(out)) + ", entra " + escapeHtml(displayName(inn)) : "⇄ Confirmar troca") + '</button><button type="button" class="lv-btn lv-white" data-lv-close>Cancelar</button></footer>';
      sheet.keeperResolved = keeperOut ? keeperTo : null;
    } else if (sheet.kind === "warn" && game) {
      const types = [["warning_verbal", "Advertência verbal"], ["warning_yellow", "Cartão amarelo"], ["warning_red", "Cartão vermelho"], ["foul", "Falta"], ["penalty", "Pênalti"], ["hand", "Mão intencional · 1 min fora"], ["keeper", "Bola recuada para o goleiro"], ["other", "Outra ocorrência"]],
        type = sheet.type || "warning_verbal", players = [...lineupForTeam(game.home, game), ...lineupForTeam(game.away, game)], player = players.includes(sheet.player) ? sheet.player : "";
      html = lvSheetHead("ADVERTÊNCIA · " + String(lvMinute()).padStart(2, "0") + "′") +
        '<div class="lv-sheet-body"><p class="lv-step-title">1. O QUE ACONTECEU?</p><div class="lv-grid2">' + types.map(([value, label]) => '<button type="button" class="lv-choice' + (type === value ? " is-on" : "") + '" aria-pressed="' + (type === value) + '" data-lv-warn-type="' + value + '">' + label + "</button>").join("") + "</div>" +
        '<p class="lv-step-title">2. QUAL JOGADOR?</p>' + ["home", "away"].map((s) => '<div class="lv-group"><p>' + escapeHtml(teamLabel(game[s]).toUpperCase()) + '</p><div class="lv-grid2">' + lineupForTeam(game[s], game).map((name) => '<button type="button" class="lv-choice' + (player === name ? " is-on" : "") + '" aria-pressed="' + (player === name) + '" data-lv-warn-player="' + escapeHtml(name) + '">' + escapeHtml(displayName(name)) + "</button>").join("") + "</div></div>").join("") +
        '<label class="lv-field-input">Observação (opcional)<input id="lvWarnNote" maxlength="160" value="' + escapeHtml(sheet.note || "") + '"></label></div>' +
        '<footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-black lv-big" data-lv-confirm-warn' + (player && !incidentSubmitting ? "" : " disabled") + ">" + (player ? "✓ Registrar para " + escapeHtml(displayName(player)) : "✓ Registrar") + '</button><button type="button" class="lv-btn lv-white" data-lv-close>Cancelar</button></footer>';
    } else if (sheet.kind === "pick") {
      // Cada time com a cor e o escudo dele; o time do outro lado fica desabilitado (não dá para repetir).
      const teams = modeTeams().map((team) => team.name), current = $(sheet.side === "home" ? "matchHome" : "matchAway").value,
        other = $(sheet.side === "home" ? "matchAway" : "matchHome").value, suggested = currentPending()?.[sheet.side] || "";
      html = lvSheetHead(sheet.side === "home" ? "TIME DA CASA" : "TIME VISITANTE", "Toque no time que vai jogar.") +
        '<div class="lv-sheet-body"><div class="lv-grid2">' + teams.map((team) => {
          const on = current === team, taken = !on && other === team, note = taken ? (sheet.side === "home" ? "já é o visitante" : "já é o time da casa") : suggested === team ? "sugerido" : "";
          return '<button type="button" class="lv-choice lv-choice-team lv-pickteam' + (on ? " is-on" : "") + (taken ? " is-taken" : "") + '" style="' + lvTeamVars(team) + '" aria-pressed="' + on + '" data-lv-pick-team="' + escapeHtml(team) + '"' + (taken ? " disabled" : "") + ">" + lvCrest(team, "s") +
            "<span><strong>" + escapeHtml(teamLabel(team)) + "</strong>" + (note ? "<small>" + note + "</small>" : "") + "</span>" + (on ? '<b class="lv-check" aria-hidden="true">✓</b>' : "") + "</button>";
        }).join("") + '</div></div><footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-white" data-lv-close>Cancelar</button></footer>';
    } else if (sheet.kind === "adjust") {
      html = lvAdjustSheet(sheet);
    } else if (sheet.kind === "end" && game) {
      const hs = currentScore(game.home), as = currentScore(game.away), tied = hs === as, shoot = shootoutOf(game), over = timerRemaining() === 0,
        board = '<div class="lv-endboard">' + lvCrest(game.home, "m") + "<b>" + hs + ' × ' + as + "</b>" + lvCrest(game.away, "m") + "</div>";
      if (tied && !(shoot && shoot.finished)) {
        const custom = !!sheet.customRounds, rounds = shoot ? shoot.rounds || 3 : custom ? sheet.otherBase || 5 : sheet.rounds || 3,
          plural = (n) => n + (n === 1 ? " cobrança" : " cobranças");
        html = lvSheetHead((over ? "TERMINOU " : "ESTÁ ") + hs + " × " + as) + '<div class="lv-sheet-body">' + board + '<p class="lv-step-title lv-center">Como você quer decidir?</p>' +
          (shoot ? "" : '<div class="lv-durations">' + [1, 3].map((value) => '<button type="button" class="lv-seg' + (!custom && rounds === value ? " is-on" : "") + '" aria-pressed="' + (!custom && rounds === value) + '" data-lv-rounds="' + value + '">' + plural(value) + "</button>").join("") + '<button type="button" class="lv-seg' + (custom ? " is-on" : "") + '" aria-pressed="' + custom + '" data-lv-rounds="outro">Outro</button>' + (custom ? '<label class="lv-other">Quantas cobranças para cada time?<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" autocomplete="off" id="lvRoundsOther" value="' + rounds + '" aria-describedby="lvRoundsHelp"></label>' : "") + "</div>" +
            '<p class="lv-help" id="lvRoundsHelp">Se continuar empatado depois das cobranças, segue alternado (uma para cada lado) até alguém errar e o outro converter.</p>') +
          '<button type="button" class="lv-btn lv-yellow lv-big" data-lv-penalties data-lv-first>' + (shoot ? "Continuar os pênaltis" : "Ir para os pênaltis") + " · " + plural(rounds) + "</button>" +
          (game.stage === "final" ? '<p class="lv-help">Final da Super Liga: o título precisa ser decidido nos pênaltis.</p>' : '<button type="button" class="lv-btn lv-white" data-lv-draw>Encerrar com empate</button>') +
          '<button type="button" class="lv-link lv-center" data-lv-close>Voltar ao jogo</button></div>';
      } else {
        html = lvSheetHead(over ? "FIM DO TEMPO" : "ENCERRAR JOGO?") + '<div class="lv-sheet-body">' + board + '<p class="lv-center">Encerrar ' + escapeHtml(teamLabel(game.home) + " " + hs + " × " + as + " " + teamLabel(game.away)) + "?</p>" +
          '<button type="button" class="lv-btn lv-red lv-big" data-lv-finish data-lv-first>■ Encerrar jogo</button><button type="button" class="lv-link lv-center" data-lv-close>Voltar ao jogo</button></div>';
      }
    } else { lvCloseSheet(); return; }
    if (lvUI.marks.sheet !== html) {
      const scroll = dialog.querySelector(".lv-sheet-body")?.scrollTop || 0, focusKey = document.activeElement && dialog.contains(document.activeElement) ? [...document.activeElement.attributes].filter((attr) => attr.name.startsWith("data-lv")).map((attr) => "[" + attr.name + '="' + CSS.escape(attr.value) + '"]').join("") : "";
      lvUI.marks.sheet = html;
      dialog.innerHTML = html;
      const body = dialog.querySelector(".lv-sheet-body");
      if (body) body.scrollTop = scroll;
      if (focusKey) dialog.querySelector(focusKey)?.focus();
    } else {
      const title = dialog.querySelector("#lvSheetTitle");
      if (title && (sheet.kind === "goal" || sheet.kind === "sub" || sheet.kind === "warn")) {
        const text = title.textContent.replace(/\d+′$/, String(lvMinute()).padStart(2, "0") + "′");
        if (title.textContent !== text) title.textContent = text;
      }
    }
  }
  // ---------- Ajustar jogadores ----------
  function lvOriginalTeam(player) {
    return (state.teams || []).find((team) => (team.players || []).includes(player))?.name || "";
  }
  function lvAdjustSheet(sheet) {
    const { home, away } = lvMatchTeams(), superMode = isSuperMode(), team = sheet.team || home || (state.teams || [])[0]?.name, side = team === away ? "away" : "home",
      playing = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean)), choices = [home, away].filter(Boolean);
    const toggle = '<div class="lv-pick2">' + choices.map((name, index) => {
      const s = index === 0 ? "home" : "away", count = superMode ? starterSelection(name, s).length + " / " + effectiveOnCourt() : lvConvocados(name, s).length + " / 5";
      return '<button type="button" class="lv-choice lv-tchoice' + (team === name ? " is-on" : "") + '" style="' + lvTeamVars(name) + '" aria-pressed="' + (team === name) + '" data-lv-adjust-team="' + escapeHtml(name) + '">' + lvCrest(name, "s") + "<span>" + escapeHtml(teamLabel(name)) + "<small>" + (superMode ? "Titulares " : "Jogadores para este jogo ") + count + "</small></span></button>";
    }).join("") + "</div>";
    let body = "";
    if (superMode) {
      const all = lvConvocados(team, side), picked = starterSelection(team, side), count = effectiveOnCourt(), keeperName = $(side === "home" ? "keeperHome" : "keeperAway").value;
      body = '<p class="lv-step-title">' + escapeHtml(teamLabel(team).toUpperCase()) + " · TITULARES " + picked.length + " / " + count + '</p><ul class="lv-adjust-list">' + all.map((name) => {
        const starter = picked.includes(name);
        return '<li class="lv-acard" style="' + lvTeamVars(team) + '"><span>' + escapeHtml(displayName(name)) + (name === keeperName || keeper(name) ? ' <b class="lv-g">G</b>' : "") + '</span><button type="button" class="lv-mini' + (starter ? " is-on" : "") + '" data-lv-starter="' + escapeHtml(name) + '" aria-pressed="' + starter + '"' + (!starter && picked.length >= count ? " disabled" : "") + ">" + (starter ? "Titular" : "Reserva") + "</button></li>";
      }).join("") + "</ul>" +
        (sheet.adding ? '<form class="lv-add" data-lv-add-form><label>Nome do jogador novo<input id="lvNewPlayer" maxlength="50" placeholder="Use * no fim para goleiro"></label><button type="submit" class="lv-btn lv-black">Inscrever</button></form>' : '<button type="button" class="lv-btn lv-white" data-lv-adding>＋ Inscrever jogador novo</button>') +
        '<p class="lv-help">Na Super Liga, basta a mesma quantidade de titulares dos dois lados. Quem não for titular fica no banco e pode entrar durante o jogo.</p>';
    } else {
      const lineup = lineupForTeam(team), absent = Object.entries(state.absentPlayers || {}).filter(([, from]) => from === team).map(([name]) => name),
        locked = playing.has(team), full = lineup.length >= 5,
        pool = (state.teams || []).filter((other) => other.name !== team && !playing.has(other.name)).flatMap((other) => lineupForTeam(other.name).map((name) => ({ name, from: other.name }))).filter((item) => !(state.absentPlayers || {})[item.name] && (!keeper(item.name) || !lineup.some(keeper)));
      body = '<ul class="lv-adjust-list">' + lineup.map((name) => {
        const origin = lvOriginalTeam(name), borrowed = origin && origin !== team;
        return '<li class="lv-acard" style="' + lvTeamVars(team) + '"><span>' + escapeHtml(displayName(name)) + (keeper(name) ? ' <b class="lv-g">G</b>' : "") + (borrowed ? ' <small class="lv-from"><i class="lv-dot" style="' + lvTeamVars(origin) + '" aria-hidden="true"></i>· veio do ' + escapeHtml(teamLabel(origin)) + "</small>" : "") + "</span>" +
          (borrowed ? '<button type="button" class="lv-mini lv-mini-origin" style="' + lvTeamVars(origin) + '" data-lv-return="' + escapeHtml(name) + '"' + (locked || playing.has(origin) || lineupForTeam(origin).length >= 5 ? " disabled" : "") + ">Devolver</button>" : '<button type="button" class="lv-mini" data-lv-absent="' + escapeHtml(name) + '"' + (locked ? " disabled" : "") + ">Ausente</button>") + "</li>";
      }).join("") + absent.map((name) => '<li class="lv-acard is-absent" style="' + lvTeamVars(team) + '"><span><s>' + escapeHtml(displayName(name)) + "</s> <small>· ausente</small></span><button type=\"button\" class=\"lv-mini\" data-lv-back=\"" + escapeHtml(name) + '"' + (locked || full ? " disabled" : "") + ">Voltar</button></li>").join("") + "</ul>" +
        (sheet.pulling ? '<div class="lv-group"><p>PUXAR DE OUTRO TIME</p>' + (full ? '<p class="lv-muted">' + escapeHtml(teamLabel(team)) + " já está com 5.</p>" : pool.length ? '<div class="lv-grid2">' + pool.map((item) => '<button type="button" class="lv-choice lv-pchoice" style="' + lvTeamVars(item.from) + '" data-lv-pull="' + escapeHtml(item.name) + '">' + escapeHtml(displayName(item.name)) + " <small>· " + escapeHtml(teamLabel(item.from)) + "</small></button>").join("") + "</div>" : '<p class="lv-muted">Sem jogador disponível em outro time.</p>') + "</div>" : '<button type="button" class="lv-btn lv-white" data-lv-pulling' + (locked || full ? " disabled" : "") + ">⇄ Puxar jogador de outro time</button>") +
        '<p class="lv-help">Limite de 5 por time. Um time pode ficar com 0 a 4 e ser completado depois. Na Super Liga, basta a mesma quantidade de titulares dos dois lados.</p>';
    }
    return lvSheetHead("AJUSTAR JOGADORES", "Antes do jogo.") + '<div class="lv-sheet-body">' + (choices.length ? toggle : "") + body + '</div><footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-green lv-big" data-lv-save-adjust>✓ Salvar ajustes</button></footer>';
  }
  async function lvAdjustAction(kind, player) {
    const sheet = lvUI.sheet, team = sheet?.team || lvMatchTeams().home, teams = state.teams || [];
    const playing = new Set([state.currentGame?.home, state.currentGame?.away].filter(Boolean));
    const lineups = Object.fromEntries(teams.map((item) => [item.name, [...lineupForTeam(item.name)]]));
    if (playing.has(team)) { notify("Esse time está jogando agora. Ajuste depois da partida.", true); return; }
    if (kind === "absent") {
      lineups[team] = lineups[team].filter((name) => name !== player);
      await saveState({ lineups, absentPlayers: { ...(state.absentPlayers || {}), [player]: team } }, displayName(player) + " marcado como ausente.");
    } else if (kind === "back") {
      if (lineups[team].length >= 5) { notify(teamLabel(team) + " já está com 5 jogadores.", true); return; }
      lineups[team].push(player);
      const rest = { ...(state.absentPlayers || {}) };
      delete rest[player];
      await saveState({ lineups, absentPlayers: rest }, displayName(player) + " voltou para o " + teamLabel(team) + ".");
    } else if (kind === "pull" || kind === "return") {
      const target = kind === "pull" ? team : lvOriginalTeam(player), source = teams.find((item) => lineups[item.name].includes(player))?.name;
      if (!source || !target || source === target || playing.has(source) || playing.has(target)) return;
      if (lineups[target].length >= 5) { notify(teamLabel(target) + " já está com 5 jogadores.", true); return; }
      if (keeper(player) && lineups[target].some(keeper)) { notify(teamLabel(target) + " já tem um goleiro marcado com *.", true); return; }
      lineups[source] = lineups[source].filter((name) => name !== player);
      lineups[target].push(player);
      await saveState({ lineups }, displayName(player) + (kind === "pull" ? " veio do " + teamLabel(source) + " para o " : " voltou para o ") + teamLabel(target) + ".");
      if (sheet) sheet.pulling = false;
    }
  }
  // ---------- Ações ----------
  function lvTrigger(id) {
    const el = $(id);
    if (el && !el.disabled) el.click();
  }
  async function lvConfirmGoal() {
    const sheet = lvUI.sheet, game = state.currentGame;
    if (!sheet || !game || !sheet.scorer || goalSubmitting) return;
    $("goalTeam").value = sheet.team || game.home;
    $("ownGoal").checked = !!sheet.own;
    renderGoalOptions();
    $("goalScorer").value = sheet.scorer;
    renderGoalOptions();
    $("goalAssist").value = sheet.own ? "" : sheet.assist || "";
    const before = goals.length;
    await addGoal();
    if (goals.length > before) lvCloseSheet();
  }
  async function lvConfirmSub() {
    const sheet = lvUI.sheet, game = state.currentGame;
    if (!sheet || !game || !sheet.out || !sheet.in || substituting) return;
    const before = (game.substitutions || []).length;
    await substitutePlayer({ team: sheet.team || game.home, out: sheet.out, inn: sheet.in, keeperTo: sheet.keeperResolved || null });
    if ((state.currentGame?.substitutions || []).length > before) lvCloseSheet();
  }
  async function lvConfirmWarn() {
    const sheet = lvUI.sheet;
    if (!sheet || !sheet.player || incidentSubmitting) return;
    renderGoalOptions();
    $("incidentType").value = sheet.type || "warning_verbal";
    $("incidentPlayer").value = sheet.player;
    $("incidentNote").value = ($("lvWarnNote")?.value || "").trim();
    const before = (state.incidents || []).length;
    await addIncident();
    if ((state.incidents || []).length > before) lvCloseSheet();
  }
  // Desfazer uma troca: volta quem saiu, devolve quem entrou e corrige o goleiro.
  async function lvUndoSub(id) {
    const game = state.currentGame, subs = game?.substitutions || [], index = subs.findIndex((item) => item.id === id), sub = subs[index];
    if (!game || !sub) return;
    if (subs.slice(index + 1).some((item) => item.team === sub.team && [item.in, item.out, item.keeperIn].some((name) => name && [sub.in, sub.out].includes(name)))) { notify("Desfaça antes a troca mais recente que envolve " + displayName(sub.in) + " ou " + displayName(sub.out) + ".", true); return; }
    const side = sub.team === game.home ? "home" : "away", players = [...(game[side + "Players"] || [])];
    if (!players.includes(sub.in)) { notify(displayName(sub.in) + " não está mais em campo.", true); return; }
    if (!(await askConfirm({ title: "Desfazer a troca?", message: "Volta " + displayName(sub.out) + " e sai " + displayName(sub.in) + ".", confirmText: "Desfazer troca", tone: "green" }))) return;
    if (!(state.currentGame?.substitutions || []).some((item) => item.id === id)) return;
    players[players.indexOf(sub.in)] = sub.out;
    const loanIndex = (game.loans || []).findIndex((loan) => loan.substitution && loan.player === sub.in && loan.toTeam === sub.team),
      bench = (game[side + "Bench"] || []).filter((name) => name !== sub.out),
      nextGame = { ...game, [side + "Players"]: players, [side + "Bench"]: loanIndex >= 0 ? bench : [...bench, sub.in], substitutions: subs.filter((item) => item.id !== id) };
    if (loanIndex >= 0) nextGame.loans = game.loans.filter((_, i) => i !== loanIndex);
    if (sub.keeper) nextGame[side + "Keeper"] = sub.out;
    await saveState({ currentGame: nextGame, incidents: (state.incidents || []).filter((item) => item.id !== id) }, "Troca desfeita.");
  }
  async function lvUndo(kind, id) {
    const game = state.currentGame;
    if (!game) return;
    if (kind === "goal") {
      const goal = goals.find((item) => item.id === id);
      if (!goal || !(await askConfirm({ title: "Desfazer o gol?", message: "Desfazer o gol de " + displayName(goal.player_name) + " (" + goal.minute + "′)? O placar volta sozinho.", confirmText: "Desfazer gol", tone: "green" }))) return;
      if (!goals.some((item) => item.id === id)) return;
      await deleteGoal(id, false);
    } else if (kind === "sub") await lvUndoSub(id);
    else if (kind === "incident") {
      const item = (state.incidents || []).find((entry) => entry.id === id);
      if (!item || !(await askConfirm({ title: "Desfazer ocorrência?", message: "Desfazer esta ocorrência de " + displayName(item.player || "") + "?", confirmText: "Desfazer", tone: "green" }))) return;
      if (!(state.incidents || []).some((entry) => entry.id === id)) return;
      await saveState({ incidents: (state.incidents || []).filter((entry) => entry.id !== id) }, "Ocorrência desfeita.");
    }
  }
  async function lvPenalties(rounds) {
    const game = state.currentGame;
    if (!game) return;
    lvCloseSheet();
    await openShootout();
    const shoot = shootoutOf(state.currentGame);
    if (shoot && !(shoot.kicks || []).length && shoot.rounds !== rounds) await saveState({ shootout: { ...shoot, rounds } }, "Pênaltis: " + rounds + " cobranças por time.");
  }
  function bindLive() {
    const org = $("lvOrg"), dialog = $("lvSheet");
    org.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const data = target.dataset;
      if (data.lvPick) lvOpenSheet({ kind: "pick", side: data.lvPick });
      else if (target.id === "lvAdjustBtn") lvOpenSheet({ kind: "adjust", team: lvMatchTeams().home });
      else if (data.lvDuration) {
        if (data.lvDuration === "outro") { lvUI.customDuration = true; lvUI.marks.lvDurations = ""; renderOrganizer(); $("lvDurationOther")?.focus(); return; }
        lvUI.customDuration = false;
        $("durationMinutes").value = data.lvDuration;
        $("durationMinutes").dispatchEvent(new Event("change"));
      }
      else if (data.lvKtoggle) {
        lvUI.kOpen = lvUI.kOpen || {};
        lvUI.kOpen[data.lvKtoggle] = !lvUI.kOpen[data.lvKtoggle];
        renderOrganizer();
        org.querySelector('[data-lv-ktoggle="' + data.lvKtoggle + '"]')?.focus();
      }
      else if (data.lvKeeper) {
        const side = data.lvKeeper, select = $(side === "home" ? "keeperHome" : "keeperAway");
        if (select.disabled) return;
        if (select.value !== data.name) { select.value = data.name; select.dispatchEvent(new Event("change")); }
        // Escolheu: a janela fecha e mostra o goleiro no cabeçalho.
        lvUI.kOpen = { ...(lvUI.kOpen || {}), [side]: false };
        renderOrganizer();
        org.querySelector('[data-lv-ktoggle="' + side + '"]')?.focus();
      }
      else if (target.id === "lvPrepared") lvTrigger("preparedBtn");
      else if ("lvUnprepare" in data) lvTrigger("preparedBtn");
      else if (target.id === "lvBegin") { lvUI.prepOpen = false; lvTrigger("beginGame"); }
      else if ("lvAlter" in data) {
        if (lvUI.prepOpen) { lvUI.prepOpen = false; renderOrganizer(); return; }
        askConfirm({ title: "Abrir a preparação?", message: "O jogo já está rolando. Times e duração só mudam depois do fim do jogo.", confirmText: "Abrir preparação", tone: "green" }).then((yes) => { if (yes) { lvUI.prepOpen = true; renderOrganizer(); } });
      }
      else if (target.id === "lvGoal") lvOpenSheet({ kind: "goal", team: state.currentGame?.home });
      else if (target.id === "lvPause") lvTrigger("pauseTimer");
      else if (target.id === "lvSub") lvOpenSheet({ kind: "sub", team: state.currentGame?.home });
      else if (target.id === "lvWarn") lvOpenSheet({ kind: "warn" });
      else if (target.id === "lvFinish") lvOpenSheet({ kind: "end" });
      else if (data.lvUndo) lvUndo(data.lvUndo, data.id);
    });
    org.addEventListener("change", (event) => {
      if (event.target.id === "lvDurationOther") {
        $("durationMinutes").value = event.target.value;
        $("durationMinutes").dispatchEvent(new Event("change"));
      }
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) { lvCloseSheet(); return; }
      const target = event.target.closest("button");
      if (!target || target.disabled) return;
      const sheet = lvUI.sheet, data = target.dataset;
      if (!sheet) return;
      if ("lvClose" in data) { lvCloseSheet(); return; }
      if (data.lvGoalTeam) { sheet.team = data.lvGoalTeam; sheet.scorer = ""; sheet.assist = ""; }
      else if (data.lvScorer) { sheet.scorer = data.lvScorer; sheet.assist = ""; }
      else if ("lvOwn" in data) { sheet.own = !sheet.own; sheet.scorer = ""; sheet.assist = ""; }
      else if ("lvAssist" in data) sheet.assist = data.lvAssist;
      else if ("lvConfirmGoal" in data) { lvConfirmGoal(); return; }
      else if (data.lvSubTeam) { sheet.team = data.lvSubTeam; sheet.out = ""; sheet.in = ""; sheet.keeperTo = ""; }
      else if (data.lvSubOut) { sheet.out = data.lvSubOut; sheet.keeperTo = ""; }
      else if (data.lvSubIn) { sheet.in = data.lvSubIn; sheet.keeperTo = ""; }
      else if (data.lvKeeperTo) sheet.keeperTo = data.lvKeeperTo;
      else if ("lvConfirmSub" in data) { lvConfirmSub(); return; }
      else if (data.lvWarnType) { sheet.note = $("lvWarnNote")?.value || ""; sheet.type = data.lvWarnType; }
      else if (data.lvWarnPlayer) { sheet.note = $("lvWarnNote")?.value || ""; sheet.player = data.lvWarnPlayer; }
      else if ("lvConfirmWarn" in data) { lvConfirmWarn(); return; }
      else if (data.lvPickTeam) {
        const select = $(sheet.side === "home" ? "matchHome" : "matchAway");
        if ($(sheet.side === "home" ? "matchAway" : "matchHome").value === data.lvPickTeam) return;
        select.value = data.lvPickTeam;
        lvCloseSheet();
        select.dispatchEvent(new Event("change"));
        return;
      }
      else if (data.lvAdjustTeam) { sheet.team = data.lvAdjustTeam; sheet.pulling = false; sheet.adding = false; }
      else if (data.lvAbsent) { lvAdjustAction("absent", data.lvAbsent); return; }
      else if (data.lvBack) { lvAdjustAction("back", data.lvBack); return; }
      else if (data.lvReturn) { lvAdjustAction("return", data.lvReturn); return; }
      else if (data.lvPull) { lvAdjustAction("pull", data.lvPull); return; }
      else if ("lvPulling" in data) sheet.pulling = true;
      else if ("lvAdding" in data) { sheet.adding = true; lvUI.marks.sheet = ""; lvRenderSheet(); $("lvNewPlayer")?.focus(); return; }
      else if (data.lvStarter) {
        const team = sheet.team, side = team === lvMatchTeams().away ? "away" : "home", current = new Set(starterSelection(team, side));
        if (current.has(data.lvStarter)) current.delete(data.lvStarter); else current.add(data.lvStarter);
        starterChoice[team] = [...current];
        renderStarterPicks();
        renderOrganizer();
      }
      else if ("lvSaveAdjust" in data) { lvCloseSheet(); renderAll(); notify("Ajustes salvos."); return; }
      else if (data.lvRounds) {
        if (data.lvRounds === "outro") { sheet.customRounds = true; sheet.otherBase = sheet.otherRounds || 5; lvRenderSheet(); $("lvRoundsOther")?.focus(); return; }
        sheet.customRounds = false; sheet.rounds = Number(data.lvRounds);
      }
      else if ("lvPenalties" in data) {
        const shoot = shootoutOf(state.currentGame), raw = sheet.customRounds ? Number($("lvRoundsOther")?.value) : sheet.rounds || 3;
        if (!shoot && sheet.customRounds && !(raw >= 1 && raw <= 20)) { notify("Escolha de 1 a 20 cobranças para cada time.", true); $("lvRoundsOther")?.focus(); return; }
        lvPenalties(shoot ? shoot.rounds || 3 : Math.min(20, Math.max(1, Math.floor(raw) || 3))); return;
      }
      else if ("lvDraw" in data) {
        const gameId = state.currentGame?.id;
        askConfirm({ title: "Encerrar com empate?", message: "Encerrar o jogo empatado?", confirmText: "Encerrar com empate", tone: "red" }).then((yes) => {
          if (!yes || !gameId || state.currentGame?.id !== gameId) return;
          lvCloseSheet(); finishGame();
        });
        return;
      }
      else if ("lvFinish" in data) { lvCloseSheet(); finishGame(); return; }
      lvRenderSheet();
    });
    dialog.addEventListener("change", (event) => {
      // Sem redesenhar o painel (o toque no botão logo depois não se perde).
      if (event.target.id === "lvRoundsOther" && lvUI.sheet) { const value = Math.min(20, Math.max(1, Math.floor(Number(event.target.value)) || 5)); lvUI.sheet.otherRounds = value; event.target.value = value; const button = dialog.querySelector("[data-lv-penalties]"); if (button) button.textContent = "Ir para os pênaltis · " + value + (value === 1 ? " cobrança" : " cobranças"); }
    });
    // "Outro": só números (1 a 20); o botão amarelo acompanha enquanto digita, sem redesenhar o painel.
    dialog.addEventListener("input", (event) => {
      if (event.target.id !== "lvRoundsOther") return;
      const clean = event.target.value.replace(/\D/g, "").slice(0, 2);
      if (clean !== event.target.value) event.target.value = clean;
      const value = Number(clean), button = dialog.querySelector("[data-lv-penalties]");
      if (value >= 1 && value <= 20 && lvUI.sheet) lvUI.sheet.otherRounds = value;
      if (button && value >= 1 && value <= 20) button.textContent = "Ir para os pênaltis · " + value + (value === 1 ? " cobrança" : " cobranças");
    });
    dialog.addEventListener("submit", async (event) => {
      if (!event.target.closest("[data-lv-add-form]")) return;
      event.preventDefault();
      const sheet = lvUI.sheet, name = $("lvNewPlayer")?.value || "";
      if (!sheet || !name.trim()) return;
      await superAddPlayer(sheet.team, name);
      sheet.adding = false;
      lvUI.marks.sheet = "";
      lvRenderSheet();
    });
    dialog.addEventListener("close", () => { lvUI.sheet = null; lvUI.marks.sheet = ""; });
  }
  function setTheme(theme) {
    const light = theme === "light";
    document.body.classList.toggle("light-theme", light);
    const toggle = $("themeToggle");
    toggle.innerHTML = light ? THEME_ICONS.moon : THEME_ICONS.sun;
    toggle.setAttribute("aria-label", light ? "Ativar fundo escuro" : "Ativar fundo claro");
    toggle.title = light ? "Fundo escuro" : "Fundo claro";
    localStorage.setItem("liga-skalama-theme-v2", light ? "light" : "dark");
  }
  function bindEvents() {
    bindElenco();
    $("drawTeams").addEventListener("click", drawTeams);
    bindArt();
    bindSuperLiga();
    bindNews();
    bindNewsPush();
    bindSwapGrid();
    $("teamsGrid").addEventListener("change", (event) => {
      const team = event.target.dataset?.teamLabel;
      if (!team) return;
      const value = event.target.value.trim().slice(0, 30);
      // O nome do time nunca pode ser o nome de um jogador (ex.: campo preenchido sozinho pelo navegador).
      if (value && isPlayerNameLabel(value)) { event.target.value = state.teamLabels?.[team] || ""; notify("Esse é o nome de um jogador. Digite outro nome para o time.", true); return; }
      const teamLabels = { ...(state.teamLabels || {}), [team]: value };
      const gameHistory = (state.gameHistory || []).map((game) => game.roundId === state.roundId ? { ...game, homeLabel: teamLabels[game.home] || defaultTeamLabel(game.home), awayLabel: teamLabels[game.away] || defaultTeamLabel(game.away) } : game);
      saveState(
        { teamLabels, gameHistory },
        value ? "Nome do time salvo." : "Nome do time removido.",
      );
    });
    $("venue").addEventListener("change", (e) =>
      saveState({ venue: e.target.value.trim() }, "Local do jogo atualizado."),
    );
    $("matchDate").addEventListener("change", (e) =>
      saveState({ matchDate: e.target.value }, "Data atualizada."),
    );
    $("startTime").addEventListener("change", (e) =>
      saveState({ startTime: e.target.value }, "Horário atualizado."),
    );
    document
      .querySelectorAll("[data-view-button]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          if (button.dataset.liveMode) chooseLiveMode(button.dataset.liveMode);
          setView(button.dataset.viewButton);
        }),
      );
    $("themeToggle").addEventListener("click", () =>
      setTheme(
        document.body.classList.contains("light-theme") ? "dark" : "light",
      ),
    );
    $("beginGame").addEventListener("click", beginGame);
    $("preparedBtn").addEventListener("click", prepareMatch);
    $("openShootout").addEventListener("click", openShootout);
    $("soClose").addEventListener("click", () => $("shootoutDialog").close());
    $("soGoal").addEventListener("click", () => recordKick(true));
    $("soMiss").addEventListener("click", () => recordKick(false));
    $("soUndo").addEventListener("click", undoKick);
    $("soFinish").addEventListener("click", finishShootout);
    $("soRounds").addEventListener("change", changeShootoutRounds);
    $("durationMinutes").addEventListener("input", (event) => {
      const minutes = Number(event.target.value);
      if (!state.currentGame && Number.isInteger(minutes) && minutes >= 1 && minutes <= 180) $("timerDisplay").textContent = clockText(minutes * 60);
    });
    $("durationMinutes").addEventListener("change", (event) => {
      if (state.currentGame) return;
      const minutes = Number(event.target.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) { notify("A duração deve ser de 1 a 180 minutos.", true); renderQueueControls(); renderTimer(); return; }
      saveState({ durationMinutes: minutes }, "Duração da partida: " + minutes + " min.");
    });
    $("addSub").addEventListener("click", substitutePlayer);
    $("addNewTeamPlayer").addEventListener("click", addNewTeamPlayer);
    $("newTeamPlayer").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addNewTeamPlayer(); } });
    ["subTeam", "subOut", "subIn"].forEach((id) => $(id).addEventListener("change", renderSubstitutions));
    $("onCourtCount").addEventListener("change", (event) => { starterChoice = {}; saveState({ cocaOnCourt: Math.min(9, Math.max(4, Number(event.target.value) || 5)) }, "Jogadores em quadra atualizado."); });
    $("starterPicks").addEventListener("change", (event) => {
      const input = event.target.closest("[data-starter-team]");
      if (!input) return;
      const team = input.dataset.starterTeam, side = input.dataset.starterSide, current = new Set(starterSelection(team, side));
      if (input.checked) current.add(input.value); else current.delete(input.value);
      starterChoice[team] = [...current];
      renderStarterPicks();
    });
    $("matchHome").addEventListener("change", () => { if (isSuperMode()) { superChooseTeams("home"); return; } unprepareMatch(); renderQueueControls(); renderKeeperChoices(); });
    $("matchAway").addEventListener("change", () => { if (isSuperMode()) { superChooseTeams("away"); return; } unprepareMatch(); renderQueueControls(); renderKeeperChoices(); });
    $("loanHomePlayer").addEventListener("change", () => { renderLoanControls(); renderMatchPreview(); renderKeeperChoices(); });
    $("loanAwayPlayer").addEventListener("change", () => { renderLoanControls(); renderMatchPreview(); renderKeeperChoices(); });
    $("pauseTimer").addEventListener("click", pauseTimer);
    $("openGoalDialog").addEventListener("click", () => { renderGoalOptions(); if (state.currentGame) $("goalDialog").showModal(); });
    $("goalTeam").addEventListener("change", renderGoalOptions);
    $("ownGoal").addEventListener("change", renderGoalOptions);
    $("addGoal").addEventListener("click", addGoal);
    $("removeGoal").addEventListener("click", removeSelectedGoal);
    $("goalScorer").addEventListener("change", renderGoalOptions);
    $("keeperHome").addEventListener("change", () => {
      renderQueueControls();
      renderKeeperChoices();
    });
    $("keeperAway").addEventListener("change", () => {
      renderQueueControls();
      renderKeeperChoices();
    });
    $("finishGame").addEventListener("click", finishGame);
    $("addIncident").addEventListener("click", addIncident);
    $("adminAccessButton").addEventListener("click", requestAdminAccess);
    $("footerAdminButton").addEventListener("click", requestAdminAccess);
    bindLive();
    bindHistory();
    $("liveBadge").addEventListener("click", (event) => {
      event.preventDefault();
      if (isEditLocked()) { viewerMode = activeLiveMode(); superMarkup = ""; renderAll(); }
      setView("live");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.querySelector(".home-top").addEventListener("click", (event) => {
      if (event.target.closest("[data-home-news-all]")) {
        newsOpenSlug = null;
        if (location.hash.startsWith("#noticia-")) history.pushState(null, "", location.pathname + location.search);
        setView("news");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (event.target.closest("[data-home-teams]")) {
        const section = $("publicTeamsSection");
        if (section && !section.hidden) section.scrollIntoView({ behavior: "smooth", block: "start" });
        else { setView("elenco"); setTimeout(() => $("teamsGrid")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }
      }
    });
    document.querySelectorAll("[data-shortcut]").forEach((link) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.querySelector(link.getAttribute("href"));
        if (!target) return;
        setView(link.dataset.shortcut);
        window.history.replaceState(null, "", "#" + target.id);
        setTimeout(
          () => target.scrollIntoView({ behavior: "smooth", block: "start" }),
          0,
        );
      }),
    );
  }
  async function boot() {
    bindEvents();
    try {
      const connected = await setupShared();
      if (!connected) {
        const publicOnly = window.LIGA_CONFIG?.publicReadOnly === true,
          saved = publicOnly
            ? { state: initialState(), goals: [] }
            : localLoad();
        state = normalizeState(saved.state);
        goals = (saved.goals || []).map((goal) => ({
          ...goal,
          team_name:
            goal.team_name === "Time Água" ? "Time Águia" : goal.team_name,
          score_team_name:
            goal.score_team_name === "Time Água"
              ? "Time Águia"
              : goal.score_team_name ||
                (goal.team_name === "Time Água"
                  ? "Time Águia"
                  : goal.team_name),
          own_goal: !!goal.own_goal,
        }));
        setConnection(
          publicOnly ? "Aguardando banco compartilhado" : "Modo local",
          false,
        );
        showMode(
          publicOnly
            ? "Site publicado em modo somente leitura. O organizador ainda precisa conectar o banco compartilhado."
            : "Modo local: os dados ficam somente neste navegador. Para compartilhar a noite entre dispositivos, configure o Supabase conforme README.md.",
        );
      }
    } catch (error) {
      shared = false;
      client = null;
      adminSession = null;
      canManageShared = false;
      const publicOnly = window.LIGA_CONFIG?.publicReadOnly === true,
        saved = publicOnly
          ? { state: initialState(), goals: [] }
          : localLoad();
      state = normalizeState(saved.state);
      goals = (saved.goals || []).map((goal) => ({
        ...goal,
        team_name:
          goal.team_name === "Time Água" ? "Time Águia" : goal.team_name,
        score_team_name:
          goal.score_team_name === "Time Água"
            ? "Time Águia"
            : goal.score_team_name ||
              (goal.team_name === "Time Água" ? "Time Águia" : goal.team_name),
        own_goal: !!goal.own_goal,
      }));
      setConnection(
        publicOnly
          ? "Aguardando banco compartilhado"
          : "Sem conexão compartilhada",
        false,
      );
      showMode(
        publicOnly
          ? "Site publicado em modo somente leitura. O organizador ainda precisa conectar o banco compartilhado."
          : "Não foi possível conectar ao Supabase. Confira a configuração; os dados locais ficam somente neste navegador.",
        !publicOnly,
      );
      console.error(error);
    }
    renderAll();
    setView(localStorage.getItem("liga-skalama-view") || "home");
    // Link direto de notícia (#noticia-slug) abre o SKALAMA News; senão, carrega a manchete da Tela principal.
    if (!openNewsFromHash()) loadNews();
    initPush();
    setTheme(localStorage.getItem("liga-skalama-theme-v2") || "light");
    syncServerClock();
    setInterval(syncServerClock, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncServerClock(); });
    setInterval(() => {
      renderTimer();
      renderIncidents();
    }, 250);
    setInterval(() => {
      renderSeasonHighlights();
    }, 30000);
  }
  boot();
})();
