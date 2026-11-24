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
  const SCORE_RULES = Object.freeze({ assist: 0.6 });
  // Mínimo de jogos no gol para entrar em qualquer estatística de goleiro (rankings, mês, noite e Super Liga).
  const MIN_KEEPER_GAMES = 3;
  const startersFor = (total) => total >= 16 ? Math.min(20, total) : Math.floor(Math.max(total, MIN_PLAYERS) / 5) * 5;
  // O nome interno ("Time Águia") segue como chave; o apelido é só exibição.
  // Nome padrão exibido de cada time do Modo Liga. O nome interno continua o mesmo ("Time Verde"),
  // para não quebrar histórico, gols e escalações já salvos.
  const DEFAULT_TEAM_LABELS = { "Time Verde": "Time Lobo" };
  const defaultTeamLabel = (name) => DEFAULT_TEAM_LABELS[name] || name;
  // Nome do time como foi gravado (para gravar de novo) e como aparece na tela (sem ponto(s) no fim: "LUÍS FELIPE." → "LUÍS FELIPE").
  const teamLabelRaw = (name) => superTeam(name)?.name || state?.teamLabels?.[name] || defaultTeamLabel(name);
  const teamDisplayName = (label) => { const raw = String(label || ""), clean = raw.replace(/[\s.]*\.+\s*$/, "").trim(); return clean || raw; };
  const teamLabel = (name) => teamDisplayName(teamLabelRaw(name));
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
      trainingMode: false,
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
  // Visitante: nunca recebe jogo de treino (a view já filtra; aqui é a segunda trava).
  function publicState(raw) {
    const next = normalizeState(raw);
    next.gameHistory = (next.gameHistory || []).filter((game) => !game.training);
    if (next.currentGame?.training) { next.currentGame = null; next.shootout = null; next.incidents = []; next.timer = freshTimer(next.timerMode); }
    delete next.trainingMode;
    return next;
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
      if (element.id === "themeToggle" || element.id === "adminAccessButton" || element.id === "footerAdminButton" || element.closest(".home-top") || element.closest("#historico") || element.closest("#estatisticas") || element.closest("#adminLogin") || element.closest("#artStudio") || element.closest("#pushBox") || element.closest("#cartas") || element.closest("#jogador") || element.hasAttribute("data-view-button") || element.matches(".home-tab,.home-more,.home-link")) return;
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
    const next = canManageShared ? normalizeState(data.state) : publicState(data.state);
    const namesChanged = await loadDisplayNames();
    if (JSON.stringify(next) !== JSON.stringify(state)) { state = next; renderAll(); }
    else if (namesChanged) renderAll();
  }
  async function refreshAdminAccess(session) {
    adminSession = session || null;
    canManageShared = false;
    if (shared && adminSession?.user?.id) {
      const { data, error } = await client.from("league_admins").select("user_id").eq("user_id", adminSession.user.id).maybeSingle();
      if (error) throw error;
      canManageShared = !!data;
    }
    await refreshSharedState();
    renderAll();
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
  // Nome original (a chave de tudo): só tira o * de goleiro. Use para contas, filtros, ligações e comparações.
  function baseName(name) {
    return String(name || "")
      .replace(/\*\s*$/, "")
      .trim();
  }
  // Nome para MOSTRAR: o nome de exibição aprovado (player_display_names) ou o original sem o *.
  // Nunca use para comparar ou ligar dados: para isso é baseName/playerKey.
  const DN = { map: new Map(), at: 0, busy: false };
  function displayName(name) {
    const base = baseName(name);
    return (base && DN.map.get(base.toLocaleUpperCase("pt-BR"))) || base;
  }
  function playerKey(name) {
    return baseName(name).toLocaleLowerCase("pt-BR");
  }
  // Busca os nomes aprovados (leitura pública: só nome original -> nome de exibição). Redesenha se mudou.
  async function loadDisplayNames(force = false) {
    if (!shared || !client || DN.busy || (!force && Date.now() - DN.at < 30000)) return false;
    DN.busy = true;
    try {
      const { data, error } = await client.rpc("display_names_public");
      if (error || !Array.isArray(data)) return false;
      DN.at = Date.now();
      const next = new Map(data.filter((r) => r && r.name && r.display_name).map((r) => [baseName(r.name).toLocaleUpperCase("pt-BR"), String(r.display_name)]));
      const changed = next.size !== DN.map.size || [...next].some(([k, v]) => DN.map.get(k) !== v);
      DN.map = next;
      return changed;
    } catch { return false; } finally { DN.busy = false; }
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
  // Modo treino: jogos com training: true não contam em nada e não vão para visitantes.
  // officialGames() é a fonte única dos jogos que valem (histórico, rankings, Super Liga, Divulgação, News...).
  function officialGames() {
    return (state?.gameHistory || []).filter((game) => !game.training);
  }
  function trainingGames() {
    return (state?.gameHistory || []).filter((game) => game.training);
  }
  function trainingGameIds() {
    const ids = new Set(trainingGames().map((game) => game.id));
    if (state?.currentGame?.training) ids.add(state.currentGame.id);
    return ids;
  }
  function isTrainingGoal(goal) {
    return !!goal.training || trainingGameIds().has(goal.game_id);
  }
  function gameNumber() {
    return state.currentGame?.number || (state.trainingMode ? trainingGames() : officialGames()).length + 1;
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
    if (data) state = canManageShared ? normalizeState(data.state) : publicState(data.state);
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
      .on("broadcast", { event: "state" }, () => { DN.at = 0; return refreshSharedState().catch((error) => console.warn("Falha ao atualizar a rodada compartilhada:", error)); })
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
    await loadDisplayNames(true);
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
    return game.roundId && game.roundId === state.roundId ? teamLabel(name) : teamDisplayName(game[side + "Label"] || teamLabel(name));
  }
  // Converte o nome interno do time ("Time Sol") no apelido exibido daquela partida.
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
    if (!baseName(name)) { notify("Digite o nome do jogador.", true); return; }
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
              ? '<form class="el-edit" data-el-edit-form="' + index + '"><label class="sr-only" for="elEditName">Novo nome de ' + escapeHtml(label) + '</label><input id="elEditName" maxlength="50" value="' + escapeHtml(baseName(name)) + '"><button type="submit" class="el-btn el-black el-small">Salvar</button><button type="button" class="el-btn el-white el-small" data-el-edit-cancel>Cancelar</button></form>'
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
    return baseName(name) + (on ? "*" : "");
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
      if (value === baseName(name)) { renderRoster(); return; }
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
    $("elRedraw").innerHTML = '<button type="button" class="el-btn el-white" data-el-redraw>' + (drawMode() === "balanced" ? "↻ Sortear de novo (equilibrado)" : "↻ Sortear de novo") + "</button>";
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
  // Pausa sem limite: o tempo fica congelado até o organizador tocar em Continuar (nunca volta sozinho).
  // Pausas gravadas antes desta regra (sem pauseNoLimit) seguem a regra antiga só para não pular nem congelar errado:
  // se o limite antigo (60 s Liga / 120 s Super Liga, somando as pausas) já tinha acabado, o jogo voltou nesse instante.
  function legacyResumeAt(timer) {
    if (!timer.pauseStartedAt || timer.pauseNoLimit) return null;
    return timer.pauseStartedAt + Math.max(0, (timer.mode === "coca" ? 120000 : 60000) - (timer.pauseUsedMs || 0));
  }
  function isPauseActive(timer = state.timer || {}) {
    if (!timer.pauseStartedAt) return false;
    const legacy = legacyResumeAt(timer);
    return legacy == null || nowMs() < legacy;
  }
  function timerRemaining(timer = state.timer || {}) {
    const now = nowMs();
    if (timer.endsAt)
      return Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
    if (timer.pauseStartedAt && timer.remainingAtPause != null) {
      const legacy = legacyResumeAt(timer);
      if (legacy == null || now < legacy) return timer.remainingAtPause;
      return Math.max(0, Math.ceil((legacy + timer.remainingAtPause * 1000 - now) / 1000));
    }
    return timer.duration || 480;
  }
  // Pausa antiga no estado: o organizador grava uma vez na regra nova (passou do limite antigo = retomado naquele instante;
  // dentro do limite = continua pausado, agora sem limite).
  let legacyPauseFixing = false;
  async function fixLegacyPause() {
    const timer = state.timer;
    if (legacyPauseFixing || !state.currentGame || !timer?.pauseStartedAt || timer.pauseNoLimit) return;
    if ((shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true)) return;
    legacyPauseFixing = true;
    try {
      const legacy = legacyResumeAt(timer), now = nowMs();
      const next = now >= legacy
        ? { ...timer, endsAt: legacy + (timer.remainingAtPause || 0) * 1000, remainingAtPause: null, pauseStartedAt: null, pauseUsedMs: (timer.pauseUsedMs || 0) + (legacy - timer.pauseStartedAt) }
        : { ...timer, pauseNoLimit: true };
      const game = now >= legacy ? { ...state.currentGame, pauseLog: [...(state.currentGame.pauseLog || []), { kind: "resume", minute: Math.max(1, Math.ceil(((timer.duration || 480) - (timer.remainingAtPause || 0)) / 60)), at: legacy }] } : state.currentGame;
      await saveState({ timer: next, currentGame: game });
    } finally { legacyPauseFixing = false; }
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
      status = "Pausado · toque em Continuar para voltar a contar";
    else if (hasGame && remaining === 0)
      status = currentScore(home) === currentScore(away)
        ? "Tempo encerrado · empate: escolha Pênaltis ou Encerrar partida"
        : "Tempo encerrado · encerre o jogo para salvar o histórico";
    if (hasGame && shootNow && !shootNow.finished) {
      const sc = shootoutScores(shootNow, state.currentGame);
      status = "Disputa de pênaltis · " + teamLabel(home) + " " + sc.home + " × " + sc.away + " " + teamLabel(away);
    }
    $("timerStatus").textContent = status;
    $("pauseBudget").textContent = "";
    // Pausar só fica desabilitado sem jogo, com o tempo zerado ou na disputa de pênaltis (nunca por saldo).
    $("pauseTimer").disabled = !hasGame || remaining === 0 || !!(shootNow && !shootNow.finished);
    $("pauseTimer").textContent = activePause ? "▶ Continuar" : "Pausar";
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
  // ---------- Nota de cada jogo (score), fórmula aprovada pelo dono ----------
  // Base 6,5 · resultado: vitória +1,5 · vitória nos pênaltis +1,0 · empate +0,5 · derrota: −castigo (nunca dá ponto)
  // Castigo da derrota: 0,5 (por 1 gol ou nos pênaltis) ou 1,0 (por 2+); linha: −0,5 por gol e por assistência dele;
  // goleiro: −0,5 se sofreu no máximo 1 gol na vez dele; o castigo nunca fica abaixo de 0.
  // Gols: +1,0 por gol até o 3º, +0,5 do 4º em diante · Assistência: +0,6 cada (state.scoreRules.assist manda, se existir)
  // Linha: time sem sofrer gol +0,3; cada gol sofrido pelo time −0,25 (no máximo −1,0)
  // Goleiro (quem estava no gol: keeperSpells/keeperAtGoal): sem sofrer gol +1,5; cada gol sofrido −0,75 (no máximo −2,25)
  // Gol contra −2,0 cada · Advertência (verbal, amarelo ou vermelho) −1,0 cada · Resultado entre 0 e 10, uma casa decimal.
  const scoreAssist = () => Math.max(0, Number(state?.scoreRules?.assist ?? SCORE_RULES.assist));
  function scoreFor(row, ctx) {
    const scored = Number(row.goalsFor) || 0, assists = Number(row.assists) || 0, own = Number(row.ownGoals) || 0;
    const kind = ctx.results[row.team];
    const conceded = row.role === "goleiro" ? Number(row.goalsAgainst) || 0 : ctx.against[row.team] || 0;
    let result = { win: 1.5, penWin: 1.0, draw: 0.5 }[kind] ?? 0;
    if (kind === "loss" || kind === "penLoss") {
      let penalty = kind === "penLoss" || (ctx.margin[row.team] || 0) <= 1 ? 0.5 : 1.0;
      penalty -= row.role === "goleiro" ? (conceded <= 1 ? 0.5 : 0) : 0.5 * (scored + assists);
      result = -Math.max(0, penalty);
    }
    const goals = Math.min(scored, 3) * 1.0 + Math.max(0, scored - 3) * 0.5;
    const defense = row.role === "goleiro" ? (conceded ? -Math.min(0.75 * conceded, 2.25) : 1.5) : conceded ? -Math.min(0.25 * conceded, 1.0) : 0.3;
    const warnings = ctx.warnings.get(playerKey(row.player)) || 0;
    const raw = 6.5 + result + goals + assists * ctx.assist + defense - 2.0 * own - 1.0 * warnings;
    return Math.round(Math.max(0, Math.min(10, raw)) * 10 + 1e-9) / 10;
  }
  // Contexto do jogo: resultado de cada time (pênaltis = placar igual e winner = um dos times, como em penaltySummary),
  // gols sofridos por time e advertências de cada jogador NESTE jogo.
  function scoreContext(game) {
    const hs = Number(game.homeScore) || 0, as = Number(game.awayScore) || 0, results = {}, against = { [game.home]: as, [game.away]: hs };
    const pens = hs === as && game.winner && game.winner !== "Empate" && (game.winner === game.home || game.winner === game.away);
    for (const [team, gf, ga] of [[game.home, hs, as], [game.away, as, hs]]) {
      results[team] = pens ? (game.winner === team ? "penWin" : "penLoss") : gf > ga ? "win" : gf < ga ? "loss" : "draw";
    }
    const warnings = new Map();
    for (const item of game.incidents || []) {
      if (item.type !== "warning" || !item.player || (item.gameId && game.id && item.gameId !== game.id)) continue;
      const key = playerKey(item.player);
      warnings.set(key, (warnings.get(key) || 0) + 1);
    }
    return { results, against, margin: { [game.home]: Math.abs(hs - as), [game.away]: Math.abs(hs - as) }, warnings, assist: scoreAssist() };
  }
  // Recalcula as notas de um jogo (salvo ou recém-encerrado) sem alterar os dados gravados: goleiro = quem estava no gol
  // (cada um só com os gols sofridos enquanto estava lá; quem foi ao gol em parte do jogo conta como goleiro nesse jogo).
  function scoreRows(game, stored) {
    const rows = stored.map((row) => ({ ...row })), ctx = scoreContext(game);
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
        row.role = "goleiro";
        row.goalsAgainst = against.get(row.player);
      }
    }
    for (const row of rows) {
      if (row.role !== "goleiro") row.goalsAgainst = ctx.against[row.team] || 0;
      row.score = scoreFor(row, ctx);
    }
    return rows;
  }
  // Todas as telas leem a nota daqui (nunca de game.performance[].score direto). Cache por jogo.
  const perfCache = new WeakMap();
  function gamePerformance(game) {
    if (!game) return [];
    const stored = game.performance || [];
    if (!stored.length) return stored;
    const cached = perfCache.get(game);
    if (cached && cached.assist === scoreAssist()) return cached.rows;
    const rows = scoreRows(game, stored);
    perfCache.set(game, { rows, assist: scoreAssist() });
    return rows;
  }
  function performanceForGame(game, homeScore, awayScore, gameGoals, winner, incidents) {
    const stats = [];
    for (const team of [game.home, game.away].filter(Boolean).map((name) => ({ name }))) {
      const isHome = team.name === game.home, teamPlayers = [...new Set([...((isHome ? game.homeStart : game.awayStart) || []), ...lineupForTeam(team.name, game), ...(game.substitutions || []).filter((item) => item.team === team.name).map((item) => item.in)])], goalsFor = isHome ? homeScore : awayScore, goalsAgainst = isHome ? awayScore : homeScore;
      const result = goalsFor > goalsAgainst ? "vitória" : goalsFor < goalsAgainst ? "derrota" : "empate", goalie = isHome ? game.homeKeeper : game.awayKeeper;
      for (const player of teamPlayers) {
        const isKeeper = player === goalie || player === (isHome ? game.homeKeeperStart : game.awayKeeperStart), scored = gameGoals.filter((goal) => goal.player === player && !goal.ownGoal).length, ownGoals = gameGoals.filter((goal) => goal.player === player && goal.ownGoal).length, assists = gameGoals.filter((goal) => (goal.assistedBy || goal.assisted_by) === player).length;
        stats.push({ player, team: team.name, role: isKeeper ? "goleiro" : "linha", score: 0, result, goalsFor: scored, assists, goalsAgainst, ownGoals });
      }
    }
    // A nota sai da mesma conta usada na leitura (scoreRows), com o resultado, os gols e as advertências deste jogo.
    return scoreRows({ ...game, homeScore, awayScore, winner, goals: gameGoals, incidents: incidents || [] }, stats);
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
  // Classificação (Tela principal, Rodadas anteriores e Super Liga): uma linha-cartão por time (prévia aprovada pelo dono).
  function standingsTable(rows, emptyText) {
    if (!rows.length) return '<p class="empty-state">' + emptyText + '</p>';
    const pill = (cls, n, word) => '<i class="' + cls + '">' + n + '<span class="sr-only"> ' + word + "</span></i>";
    const sg = (gd) => '<span class="stx-sg' + (gd > 0 ? " is-pos" : gd < 0 ? " is-neg" : "") + '" role="cell">' + (gd > 0 ? "+" + gd : gd < 0 ? "−" + Math.abs(gd) : "0") + "</span>";
    return '<div class="stx" role="table" aria-label="Classificação"><div class="stx-hd" role="row"><span role="columnheader">#</span><span role="columnheader">TIME</span><span role="columnheader"><abbr title="jogos">J</abbr></span><span role="columnheader">PTS</span><span role="columnheader">V · E · D</span><span role="columnheader">SG</span></div>' +
      rows.map((row, index) => { const label = teamDisplayName(row.label); return '<div class="stx-tr' + (index === 0 ? " is-lead" : "") + '" role="row"><span class="stx-pos" role="cell">' + (index + 1) + '</span><span class="stx-tm" role="cell">' + hxCrest(row.name, row.label, "sm") + '<span class="stx-tx"><b class="stx-nm dx-fit">' + escapeHtml(label) + "</b>" + (index === 0 ? '<small>👑 líder</small>' : "") + '</span></span><span class="stx-j" role="cell">' + row.played + '</span><span class="stx-pts" role="cell">' + row.points + '</span><span class="stx-ved" role="cell">' + pill("v", row.wins, row.wins === 1 ? "vitória" : "vitórias") + pill("e", row.draws, row.draws === 1 ? "empate" : "empates") + pill("d", row.losses, row.losses === 1 ? "derrota" : "derrotas") + "</span>" + sg(row.gd) + "</div>"; }).join("") +
      '</div><p class="stx-leg">J = jogos · verde = vitórias · cinza = empates · vermelho = derrotas</p>';
  }
  // Nomes numa linha só: diminui a fonte até caber (nunca corta, nunca reticências).
  function dxFit(root = document) {
    root.querySelectorAll?.(".dx-fit").forEach((el) => {
      if (!el.offsetParent) return;
      el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
      while (el.scrollWidth > el.clientWidth + 0.5 && size > 10 && guard++ < 60) { size -= 0.5; el.style.fontSize = size + "px"; }
    });
  }
  window.addEventListener("resize", () => dxFit());
  document.addEventListener("click", (event) => { if (event.target.closest?.('[role="tab"], summary')) requestAnimationFrame(() => requestAnimationFrame(() => dxFit())); });
  document.addEventListener("toggle", () => requestAnimationFrame(() => dxFit()), true);
  // Avatar redondo dos destaques: foto fixa do jogador (PLAYER_PHOTO_FILES) ou silhueta, com o escudo do time no canto.
  const DX_SIL = '<svg class="dx-sil" viewBox="0 0 60 60" aria-hidden="true" focusable="false"><circle cx="30" cy="22" r="12"/><path d="M6 60c2-16 12-24 24-24s22 8 24 24Z"/></svg>';
  function dxAvatar(name, team, label, big) {
    const photo = name ? cardPhotoUrl(pSlug(name)) : "", crest = team ? crestFor(team, label) : "";
    return '<span class="dx-av' + (big ? " is-big" : "") + '" aria-hidden="true"><span class="dx-circle">' + (photo ? '<img class="dx-ph" src="' + escapeHtml(photo) + '" alt="" loading="lazy" decoding="async" width="' + (PLAYER_PHOTO_SIZE[photo]?.[0] || 400) + '" height="' + (PLAYER_PHOTO_SIZE[photo]?.[1] || 400) + '">' : DX_SIL) + "</span>" +
      (crest ? '<img class="dx-cr" src="' + escapeHtml(crest) + '" alt="" width="26" height="26">' : "") + "</span>";
  }
  // Card preto de destaque (Jogador/Goleiro da noite, destaques do mês): nome, time, nota grande e números ao lado.
  function dxMini(kicker, rows, big, lines, wide) {
    const first = rows[0], names = rows.map((r) => displayName(r.player)).join(" · ");
    const who = first ? '<a class="dx-who" href="#jogador/' + pSlug(first.player) + '" aria-label="' + escapeHtml("Abrir a carta de " + names) + '">' + dxAvatar(first.player, first.team, first.label) + '<span class="dx-nm dx-fit">' + escapeHtml(names) + "</span></a>" + (first.label ? '<p class="dx-team">time ' + escapeHtml(teamDisplayName(first.label)) + "</p>" : "") : "";
    return '<article class="dx-mini' + (wide ? " is-wide" : "") + '"><p class="dx-k">' + escapeHtml(kicker) + "</p>" + (first ? who + '<div class="dx-sc"><b>' + escapeHtml(big) + "</b><span>" + lines.map(([n, w]) => "<strong>" + escapeHtml(String(n)) + "</strong> " + escapeHtml(w)).join("<br>") + "</span></div>" : '<p class="dx-empty">' + escapeHtml(lines) + "</p>") + "</article>";
  }
  // Time de um jogador num conjunto de jogos: o da última partida dele.
  function dxTeamOf(games, player) {
    let out = null;
    for (const game of games) for (const p of gamePerformance(game)) if (p.player === player) out = { team: p.team, label: gameTeamLabel(game, p.team === game.home ? "home" : "away") };
    return out || {};
  }
  function renderStandings() {
    const roundId = state.roundId || state.currentGame?.roundId;
    const games = roundId ? officialGames().filter((game) => game.roundId === roundId) : [];
    const rows = standingsForGames(games, new Map((state.teams || []).map((team) => [team.name, teamLabel(team.name)])));
    $("roundStandings").innerHTML = standingsTable(rows, "A classificação será atualizada após a primeira partida concluída.");
  }
  function renderHistoricalStandings() {
    const host = $("pastRoundStandings");
    if (!host) return;
    const groups = new Map();
    for (const game of officialGames()) {
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
    return officialGames().filter((game) => !game.superLigaId);
  }
  // ----- Rankings da Tela principal (prévia aprovada pelo dono): pódio com a melhor carta, lista com barra V/E/D -----
  // Empate no valor mostrado divide a posição (1, 2, 3, 3, 5...); a ordem dentro do empate vem de quem chama.
  const RK_TIER = { prata: "🥈 Prata", ouro: "🥇 Ouro", dia: "💎 Diamante", elite: "🔮 Elite", lend: "👑 Lendário" };
  const RK_HTML = new WeakMap();
  // Vitória/derrota nos pênaltis contam como vitória/derrota (mesma regra da classificação).
  function rkResult(game, team) { const k = scoreContext(game).results[team]; return k === "win" || k === "penWin" ? "v" : k === "draw" ? "e" : "d"; }
  // Jogos oficiais do Modo Liga do jogador (role: só os jogos naquela função, ex.: goleiro = só no gol).
  function rkStats(name, role) {
    const s = { v: 0, e: 0, d: 0, games: 0, sum: 0, conceded: 0, team: "", label: "" };
    for (const game of ligaGames()) for (const p of gamePerformance(game)) {
      if (p.player !== name || (role && p.role !== role)) continue;
      s[rkResult(game, p.team)]++; s.games++; s.sum += Number(p.score) || 0; s.conceded += Number(p.goalsAgainst) || 0;
      s.team = p.team; s.label = gameTeamLabel(game, p.team === game.home ? "home" : "away");
    }
    return s;
  }
  // Componente único de vitórias/empates/derrotas (Rankings e Estatísticas individuais): três pílulas "3 V · 1 E · 2 D" e a barra.
  function vedHtml(v, e, d) {
    const word = (n, one, many) => n + " " + (n === 1 ? one : many), part = (cls, n) => (n ? '<i class="' + cls + '" style="flex:' + n + '"></i>' : "");
    return '<span class="vd" role="img" aria-label="' + word(v, "vitória", "vitórias") + ", " + word(e, "empate", "empates") + ", " + word(d, "derrota", "derrotas") + '">' +
      '<span class="vd-p"><span class="cv">' + v + "<small>V</small></span><span class=\"ce\">" + e + "<small>E</small></span><span class=\"cd\">" + d + "<small>D</small></span></span>" +
      '<span class="vd-bar">' + part("v", v) + part("e", e) + part("d", d) + "</span></span>";
  }
  function rkBar(st) { return vedHtml(st.v, st.e, st.d); }
  function rkPositions(rows) { let pos = 0, last; return rows.map((r, i) => { if (i === 0 || r.value !== last) { pos = i + 1; last = r.value; } return pos; }); }
  // Melhor carta do jogador: a especial do mês (mesma prioridade da coleção), senão a de nível; sem carta = avatar.
  function rkCard(name, stats, big) {
    const data = cardsData(), slug = pSlug(name), base = data.bySlug.get(slug);
    if (base?.eligible) {
      const sp = cardSpecialOf(slug, data), info = cardInfo(slug, sp, data);
      if (info) return { html: '<div class="skc-fit rk-cw' + (big ? " is-big" : "") + '">' + cardHtml(info, "link") + "</div>", type: sp ? CARD_SP[sp.type][1] + " " + CARD_SP[sp.type][0] : RK_TIER[info.cls] || "" };
    }
    return { html: '<div class="rk-avw">' + dxAvatar(name, stats.team, stats.label, true) + "</div>", type: "Sem carta ainda" };
  }
  function rkRender(id, rows, opt) {
    const box = $(id);
    if (!box) return;
    let html;
    if (!rows.length) html = '<p class="empty-state">' + escapeHtml(opt.empty) + "</p>";
    else {
      const pos = rkPositions(rows), games = (n) => n + (n === 1 ? " jogo" : " jogos");
      const value = (r, cls) => '<span class="' + cls + '">' + escapeHtml(opt.text(r.value)) + "<small>" + escapeHtml(opt.unit(r.value)) + "</small></span>";
      const pod = (i, cls) => { const r = rows[i]; if (!r) return ""; const c = rkCard(r.name, r.stats, i === 0);
        return '<div class="rk-item rk-pp ' + cls + '">' + c.html + '<span class="rk-type">' + escapeHtml(c.type) + '</span><a class="rk-pn dx-fit" href="#jogador/' + pSlug(r.name) + '">' + escapeHtml(displayName(r.name)) + "</a>" + value(r, "rk-pv") + '<span class="rk-pj">' + games(r.games) + "</span>" + rkBar(r.stats) + '<span class="rk-step" aria-label="' + pos[i] + 'º lugar">' + pos[i] + "</span></div>"; };
      const line = (r, i) => '<div class="rk-item rk-row"><span class="rk-pos">' + pos[i] + 'º</span>' + dxAvatar(r.name, "", "", false) + '<span class="rk-who"><a class="rk-nm" href="#jogador/' + pSlug(r.name) + '">' + escapeHtml(displayName(r.name)) + "</a>" + rkBar(r.stats) + '</span><span class="rk-val"><b>' + escapeHtml(opt.text(r.value)) + "</b><small>" + games(r.games) + "</small></span></div>";
      html = opt.list ? '<div class="rk-list is-all">' + rows.map(line).join("") + "</div>"
        : '<div class="rk-pod' + (rows.length === 1 ? " is-one" : "") + '">' + pod(1, "rk-p2") + pod(0, "rk-p1") + pod(2, "rk-p3") + "</div>" + (rows.length > 3 ? '<div class="rk-list">' + rows.slice(3).map((r, k) => line(r, k + 3)).join("") + "</div>" : "");
    }
    if (RK_HTML.get(box) === html) return;
    RK_HTML.set(box, html);
    cardsUnobserve(box);
    box.innerHTML = html;
    if (box.querySelector(".skc") && !$("homeLayout")?.classList.contains("view-hidden")) cardsAfterRender(box);
    rkFit(box); dxFit(box);
  }
  // Escala da carta no pódio: a da prévia (celular .42/.36, PC .66/.56), mas nunca maior que a coluna.
  function rkFit(root = document) {
    const wide = innerWidth >= 700;
    root.querySelectorAll?.(".rk-cw").forEach((cw) => {
      const w = cw.clientWidth;
      if (!w) return;
      const max = cw.classList.contains("is-big") ? (wide ? 0.66 : 0.42) : (wide ? 0.56 : 0.36), k = String(Math.min(max, (w - 2) / 300));
      if (cw.style.getPropertyValue("--k") === k) return;
      cw.style.setProperty("--k", k);
      cw.firstElementChild?.style.setProperty("--k", k);
    });
  }
  window.addEventListener("resize", () => rkFit());
  document.addEventListener("click", (event) => { if (event.target.closest?.('.home-tabs [role="tab"]')) requestAnimationFrame(() => rkFit()); });
  // Ao sair da Tela principal, os observers das cartas do pódio são desligados; ao voltar, religados.
  function rkObserve(on) {
    ["goalRanking", "playerScoreRanking", "keeperRanking"].forEach((id) => { const box = $(id); if (!box) return; if (on && box.querySelector(".skc")) { cardsAfterRender(box); rkFit(box); } else cardsUnobserve(box); });
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
    // Score (linha): empate na nota divide a posição; dentro do empate, mais jogos, depois nome.
    const r1 = (v) => Math.round(v * 10) / 10;
    const scoreRows = averageRows(players).map((r) => ({ name: r.name, value: r1(r.average), games: r.games, stats: rkStats(r.name, "linha") }))
      .sort((a, b) => b.value - a.value || b.games - a.games || a.name.localeCompare(b.name, "pt-BR"));
    rkRender("playerScoreRanking", scoreRows.slice(0, 11), { unit: () => "nota", text: fmt1, empty: "O score aparece após os jogos." });
    // Goleiros (só os jogos no gol, mínimo MIN_KEEPER_GAMES): dentro do empate, menos gols sofridos por jogo, depois mais jogos, depois nome.
    const keeperRows = averageRows(keepers).filter((r) => r.games >= MIN_KEEPER_GAMES).map((r) => { const stats = rkStats(r.name, "goleiro"); return { name: r.name, value: r1(r.average), games: r.games, stats, gpg: stats.games ? stats.conceded / stats.games : 0 }; })
      .sort((a, b) => b.value - a.value || a.gpg - b.gpg || b.games - a.games || a.name.localeCompare(b.name, "pt-BR"));
    rkRender("keeperRanking", keeperRows.slice(0, 11), { unit: () => "nota", text: fmt1, empty: keepers.length ? "Entra no ranking quem tiver " + MIN_KEEPER_GAMES + " jogos ou mais no gol." : "O score aparece após os jogos." });
    const conceded = new Map();
    for (const p of keepers) {
      const x = conceded.get(p.player) || { goals: 0, games: 0, team: p.team };
      x.goals += p.goalsAgainst;
      x.games++;
      conceded.set(p.player, x);
    }
    const rows = [...conceded.entries()]
      .map(([name, x]) => ({ name, ...x }))
      .filter((r) => r.games >= MIN_KEEPER_GAMES)
      .sort(
        (a, b) => a.goals - b.goals || a.name.localeCompare(b.name, "pt-BR"),
      );
    rkRender("keeperConcededRanking", rows.slice(0, 11).map((r) => ({ name: r.name, value: r.goals, games: r.games, stats: rkStats(r.name, "goleiro") })), { unit: (v) => (v === 1 ? "sofrido" : "sofridos"), text: (v) => String(v), list: true, empty: keepers.length ? "Entra no ranking quem tiver " + MIN_KEEPER_GAMES + " jogos ou mais no gol." : "Os gols sofridos aparecem após os jogos." });
  }
  let NIGHT_LEADERS = [];
  const DX_HTML = new WeakMap();
  function renderNightHighlights() {
    const roundId = state.roundId || state.currentGame?.roundId,
      games = roundId
        ? officialGames().filter((game) => game.roundId === roundId)
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
        " nesta rodada · toque no jogador para ver a carta";
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
    const paint = (result, type) => {
      const keeper = type === "keeper", kicker = keeper ? "GOLEIRO DA NOITE" : "JOGADOR DA NOITE";
      if (!result) {
        const keeperShort = keeper && games.length && [...totals.values()].some((row) => row.role === "goleiro");
        return dxMini(kicker, [], "", keeperShort ? "É preciso ter pelo menos " + MIN_KEEPER_GAMES + " jogos no gol para entrar no destaque." : games.length ? "Não há score registrado para esta posição." : "O score será calculado após as partidas.");
      }
      const rows = result.rows.map((row) => ({ ...row, ...dxTeamOf(games, row.player) })), row = rows[0];
      return dxMini(kicker, rows, fmt1(row.average), [[row.games, row.games === 1 ? "jogo" : "jogos"], keeper ? [row.conceded, row.conceded === 1 ? "sofrido" : "sofridos"] : [row.goals, row.goals === 1 ? "gol" : "gols"]]);
    };
    NIGHT_LEADERS = [...(player?.rows || []), ...(goalie?.rows || [])].map((row) => pSlug(row.player));
    const duo = $("nightDuo"), html = paint(player, "player") + paint(goalie, "keeper");
    if (duo && DX_HTML.get(duo) !== html) { DX_HTML.set(duo, html); duo.innerHTML = html; dxFit(duo); }
    renderNightVoteCard();
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
    // Mesmo estilo dos destaques da noite: cards pretos com nota/gols grandes em amarelo, avatar e escudo do time.
    const gamesOf = (player) => [...scores.values()].filter((row) => row.player === player).reduce((sum, row) => sum + row.games, 0);
    const lead = (rows) => rows.length ? rows.filter((row) => row.average === rows[0].average).map((row) => ({ ...row, ...dxTeamOf(games, row.player) })) : [];
    const scorers = goalRows.length ? goalRows.filter((row) => row[1] === goalRows[0][1]).map(([player, n]) => ({ player, n, ...dxTeamOf(games, player) })) : [];
    const lineLead = lead(lineRows), keeperLead = lead(keeperRows);
    const html = games.length
      ? '<div class="dx-duo">' +
        dxMini("ARTILHEIRO DO MÊS", scorers, scorers.length ? String(scorers[0].n) : "", scorers.length ? [["", scorers[0].n === 1 ? "gol no mês" : "gols no mês"], [gamesOf(scorers[0].player), gamesOf(scorers[0].player) === 1 ? "jogo" : "jogos"]] : "Sem gols no mês.") +
        dxMini("DESTAQUE DE LINHA", lineLead, lineLead.length ? fmt1(lineLead[0].average) : "", lineLead.length ? [[lineLead[0].games, lineLead[0].games === 1 ? "jogo" : "jogos"], [goalsByPlayer.get(lineLead[0].player) || 0, (goalsByPlayer.get(lineLead[0].player) || 0) === 1 ? "gol" : "gols"]] : "Sem score registrado.") +
        "</div>" +
        dxMini("GOLEIRO DO MÊS", keeperLead, keeperLead.length ? fmt1(keeperLead[0].average) : "", keeperLead.length ? [[keeperLead[0].games, keeperLead[0].games === 1 ? "jogo" : "jogos"], [keeperLead[0].conceded, keeperLead[0].conceded === 1 ? "sofrido" : "sofridos"]] : "Nenhum goleiro com " + MIN_KEEPER_GAMES + " jogos ou mais.", true)
      : '<p class="empty-state season-empty">Ainda não há partidas finalizadas neste mês.</p>';
    const box = $("seasonHighlights");
    if (DX_HTML.get(box) !== html) { DX_HTML.set(box, html); box.innerHTML = html; dxFit(box); }
  }
  // Função pela maioria dos jogos; quem alternou mostra quantos jogos fez na outra posição.
  function roleSummary(row) {
    const keeper = row.keeperGames || 0, line = row.games - keeper;
    if (!keeper) return "linha";
    if (!line) return "goleiro";
    return keeper > line ? "goleiro · " + line + " na linha" : "linha · " + keeper + " no gol";
  }
  // ----- Estatísticas individuais (aba Histórico; prévia aprovada pelo dono): filtro, ordenação, score com a cor da carta -----
  // Filtro e ordem ficam só na memória da página. Empate no critério ordenado divide a posição.
  const ST_UI = { filter: "all", sort: "score" }, ST_HTML = new WeakMap();
  const ST_TIER_ICON = { prata: "🥈", ouro: "🥇", dia: "💎", elite: "🔮", lend: "👑" };
  function renderIndividualStats() {
    const totals = new Map();
    const games = [...officialGames()].sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
    for (const game of games) for (const p of gamePerformance(game)) {
      const row = totals.get(p.player) || { player: p.player, role: p.role, keeperGames: 0, score: 0, games: 0, goals: 0, assists: 0, goalsAgainst: 0, wins: 0, draws: 0, losses: 0 };
      if (p.role === "goleiro") row.keeperGames++;
      row.score += Number(p.score) || 0; row.games++; row.goals += Number(p.goalsFor) || 0; row.assists += Number(p.assists) || 0; row.goalsAgainst += Number(p.goalsAgainst) || 0;
      // Pênaltis contam como vitória/derrota (mesma regra da classificação).
      const res = rkResult(game, p.team); if (res === "v") row.wins++; else if (res === "e") row.draws++; else row.losses++;
      // Time do jogo mais recente do jogador.
      row.teamKey = p.team; row.teamLabel = teamDisplayName(teamName(game, p.team));
      totals.set(p.player, row);
    }
    const all = [...totals.values()].map((row) => ({ ...row, avg: row.score / row.games, avg1: Math.round((row.score / row.games) * 10) / 10, keeper: row.keeperGames > row.games - row.keeperGames }));
    const box = $("individualStats");
    stControlsSync();
    let html;
    if (!all.length) html = '<p class="empty-state">As estatísticas individuais aparecem após as partidas finalizadas.</p>';
    else {
      const key = { score: (r) => r.avg1, goals: (r) => r.goals, assists: (r) => r.assists, games: (r) => r.games }[ST_UI.sort];
      const rows = all.filter((r) => ST_UI.filter === "all" || (ST_UI.filter === "gk" ? r.keeper : !r.keeper))
        .sort((a, b) => key(b) - key(a) || b.avg - a.avg || a.player.localeCompare(b.player, "pt-BR"));
      let pos = 0, last;
      const ps = rows.map((r, i) => { const k = key(r); if (i === 0 || k !== last) { pos = i + 1; last = k; } return pos; });
      const maxG = Math.max(0, ...rows.map((r) => r.goals)), maxA = Math.max(0, ...rows.map((r) => r.assists));
      const num = (v, max) => '<span class="st-num' + (max > 0 && v === max ? ' is-best" title="Melhor da coluna' : "") + '">' + v + (max > 0 && v === max ? '<span class="st-crown" aria-hidden="true">👑</span>' : "") + "</span>";
      const chip = (r) => { const t = cardTier(r.avg); return '<span class="st-chip t-' + t + '"><i aria-hidden="true">' + ST_TIER_ICON[t] + "</i>" + fmt1(r.avg) + "</span>"; };
      const roleText = (r) => { const t = roleSummary(r); return t.charAt(0).toUpperCase() + t.slice(1); };
      const who = (r) => '<span class="st-who">' + dxAvatar(r.player, r.teamKey, r.teamLabel, false) + '<span class="st-nmw"><a class="st-nm" href="#jogador/' + pSlug(r.player) + '">' + escapeHtml(displayName(r.player)) + "</a>" + (r.keeper ? '<b class="st-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "<small>" + escapeHtml((r.teamLabel ? r.teamLabel + " · " : "") + roleText(r)) + "</small></span></span>";
      const conc = (r) => (r.keeper ? '<span class="st-conc">' + r.goalsAgainst + "</span>" : '<span class="st-conc is-team" title="Gols que o time sofreu nos jogos dele">' + r.goalsAgainst + '<span class="sr-only"> (gols que o time sofreu)</span></span>');
      const th = (k, label) => '<th scope="col" aria-sort="' + (ST_UI.sort === k ? "descending" : "none") + '"' + (ST_UI.sort === k ? ' class="is-sorted"' : "") + '><button type="button" data-st-sort="' + k + '">' + label + ' <span class="st-ar" aria-hidden="true">↓</span></button></th>';
      html = '<table class="st-table"><thead><tr><th scope="col">#</th><th scope="col">JOGADOR</th>' + th("games", "JOGOS") + th("score", "SCORE") + th("goals", "GOLS") + th("assists", "ASSIST.") + '<th scope="col" title="Goleiro: gols sofridos por ele. Linha: gols que o time sofreu.">SOFRIDOS</th><th scope="col">VITÓRIAS · EMPATES · DERROTAS</th></tr></thead><tbody>' +
        rows.map((r, i) => '<tr' + (ps[i] === 1 ? ' class="is-top"' : "") + '><td class="st-pos">' + ps[i] + 'º</td><th scope="row">' + who(r) + "</th><td>" + r.games + "</td><td>" + chip(r) + "</td><td>" + num(r.goals, maxG) + "</td><td>" + num(r.assists, maxA) + "</td><td>" + conc(r) + "</td><td>" + vedHtml(r.wins, r.draws, r.losses) + "</td></tr>").join("") + "</tbody></table>" +
        '<ol class="st-cards">' + rows.map((r, i) => '<li class="st-card' + (ps[i] === 1 ? " is-top" : "") + '"><span class="st-pos">' + ps[i] + 'º</span><span class="st-mid">' + who(r) +
          '<span class="st-line"><span><b>' + r.games + "</b> " + (r.games === 1 ? "jogo" : "jogos") + "</span><span><b>" + num(r.goals, maxG) + "</b> " + (r.goals === 1 ? "gol" : "gols") + "</span><span><b>" + num(r.assists, maxA) + "</b> assist.</span>" + (r.keeper ? "<span><b>" + r.goalsAgainst + "</b> " + (r.goalsAgainst === 1 ? "sofrido" : "sofridos") + "</span>" : "") + "</span>" +
          vedHtml(r.wins, r.draws, r.losses) + "</span>" + chip(r) + "</li>").join("") + "</ol>";
    }
    if (ST_HTML.get(box) === html) return;
    ST_HTML.set(box, html);
    const focused = document.activeElement?.dataset?.stSort;
    box.innerHTML = html;
    if (focused) box.querySelector('[data-st-sort="' + focused + '"]')?.focus();
  }
  function stControlsSync() {
    document.querySelectorAll("#statsControls [data-st-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.stFilter === ST_UI.filter)));
    document.querySelectorAll("#statsControls [data-st-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.stSort === ST_UI.sort)));
  }
  document.addEventListener("click", (event) => {
    const f = event.target.closest?.("[data-st-filter]"), o = event.target.closest?.("[data-st-sort]");
    if (f) { ST_UI.filter = f.dataset.stFilter; renderIndividualStats(); }
    else if (o) { ST_UI.sort = o.dataset.stSort; renderIndividualStats(); }
  });
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
    for (const game of officialGames()) {
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
    const finals = officialGames().filter((item) => item.superLigaId === game.superLigaId && item.stage === "final").sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
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
        return { ...item, html: '<span class="hx-ev hx-ev-goal">' + HX_BALL + '<span><span class="sr-only">Gol: </span><strong>' + plink(goal.player || "Gol") + escapeHtml(times) + "</strong>" + (goal.ownGoal ? ' <em class="hx-own">contra</em>' : "") + (item.assists.length ? '<small>assist. ' + item.assists.map((name) => plink(name)).join(", ") + "</small>" : "") + "</span></span>" };
      }
      const sub = item.sub, sideSpells = spells[item.side], goalie = sub.keeperIn || sub.in, toGoal = sub.keeper || sideSpells.some((spell) => spell.player === goalie && spell.minute === (Number(sub.minute) || 0) && spell.out === sub.out),
        wasKeeper = toGoal && sideSpells.some((spell) => spell.player === goalie && spell.minute < (Number(sub.minute) || 0)),
        goalText = toGoal ? (wasKeeper ? " volta pro gol" : " vai pro gol") : "",
        inText = displayName(sub.in) + (goalie === sub.in ? goalText : "");
      return { ...item, html: '<span class="hx-ev hx-ev-sub">' + HX_SWAP + '<span><span class="sr-only">Substituição: </span><strong class="hx-in"><span aria-hidden="true">↑ </span><span class="sr-only">entra </span>' + plink(sub.in, inText) + '</strong><strong class="hx-out"><span aria-hidden="true">↓ </span><span class="sr-only">sai </span>' + plink(sub.out) + "</strong>" + (goalie !== sub.in && toGoal ? "<small><b class=\"hx-g\" title=\"Goleiro\" aria-label=\"Goleiro\">G</b> " + plink(goalie) + goalText + "</small>" : "") + "</span></span>" };
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
    return '<details class="hx-game' + (title ? " is-final" : "") + '" data-hx-game="' + escapeHtml(game.id) + '"' + (historyOpenGames.has(game.id) ? " open" : "") + "><summary>" +
      '<span class="hx-strip"><b class="hx-num">JOGO ' + game.number + '</b><span class="hx-comp">' + competition + "</span>" + tag + (timeText ? '<span class="hx-time">' + escapeHtml(timeText) + "</span>" : "") + "</span>" +
      '<span class="hx-board">' + team("home", game.home, home) + '<span class="hx-score" aria-label="' + escapeHtml(home + " " + hs + " a " + as + " " + away) + '">' + num("home", hs) + '<i aria-hidden="true">×</i>' + num("away", as) + "</span>" + team("away", game.away, away) + "</span>" +
      '<span class="hx-result">' + escapeHtml(result) + "</span>" +
      '<span class="hx-toggle"><span class="hx-when-closed">' + escapeHtml(openText) + '</span><span class="hx-when-open">Minimizar</span>' + HX_CHEVRON + "</span></summary>" +
      '<div class="hx-body">' + hxTimeline(game, minutes) + hxNumbers(game) + hxLineups(game) + hxFooter(game, shoot) + "</div></details>";
  }
  // ---------- Jogo aberto: cores, linha do tempo, números e escalação ----------
  function hxColors(key) {
    const sl = superTeam(key);
    let [bg, ink] = sl ? superHead(sl) : EL_HEAD[key] || ["#3a3a35", "#ffffff"];
    if (String(bg).toLowerCase() === "#0d0d0d") bg = "#3a3a35";
    const b = String(bg).toLowerCase(),
      dark = { "#c2560c": "#f07a2e", "#ffc400": "#ffc400", "#1f6e3a": "#3dba6e", "#23439c": "#7a9bff" }[b] || "#ffffff",
      light = { "#ffc400": "#7a5c00" }[b] || (["#c2560c", "#1f6e3a", "#23439c", "#3a3a35"].includes(b) ? bg : "#3a3a35");
    return { bg, ink, line: b === "#ffc400" ? "#e0a800" : bg, light, dark };
  }
  function hxVars(key) {
    const c = hxColors(key);
    return "--tc:" + c.line + ";--tb:" + c.bg + ";--ti:" + c.ink + ";--tnl:" + c.light + ";--tnd:" + c.dark;
  }
  // Time de um jogador naquele jogo (escalação, banco ou trocas).
  function hxSideOf(game, player) {
    if (!player) return null;
    for (const side of ["home", "away"]) {
      const pool = [...(game[side + "Start"] || []), ...(game[side + "Players"] || []), ...(game[side + "Bench"] || [])];
      if (pool.includes(player) || (game.substitutions || []).some((sub) => sub.team === game[side] && (sub.in === player || sub.out === player))) return side;
    }
    return null;
  }
  function hxWarnings(game) {
    return (game.incidents || []).filter((item) => item.type !== "sub" && (!item.gameId || item.gameId === game.id));
  }
  function hxWarnLabel(item) {
    return item.type === "warning" ? item.warningType || "Advertência" : incidentLabels[item.type] || item.type || "Ocorrência";
  }
  function hxTimeline(game, minutes) {
    const warns = hxWarnings(game), items = hxEvents(game).map((item) => ({ ...item, html: null })), spells = { home: keeperSpells(game, "home"), away: keeperSpells(game, "away") };
    warns.forEach((item) => items.push({ kind: "warn", side: hxSideOf(game, item.player) || (item.team === game.away ? "away" : "home"), minute: Number(item.minute) || 0, warn: item }));
    const maxMinute = Math.max(0, ...items.map((item) => item.minute)), end = Math.max(1, minutes || 0, maxMinute),
      step = end <= 12 ? 1 : end <= 30 ? 2 : 5, pct = (minute) => Math.min(100, Math.max(0, (minute / end) * 100));
    const key = (side) => game[side], label = (side) => gameTeamLabel(game, side);
    const chip = (item) => {
      const team = key(item.side), crest = hxCrest(team, label(item.side), "xs");
      if (item.kind === "goal") {
        const goal = item.goal, times = item.count > 1 ? " ×" + item.count : "";
        return { cls: "", html: crest + '<span class="hx-tl-txt"><b><span aria-hidden="true">⚽ </span><span class="sr-only">Gol: </span>' + plink(goal.player || "Gol") + escapeHtml(times) + (goal.ownGoal ? " (contra)" : "") + "</b>" + (item.assists.length ? '<small>assist. ' + item.assists.map((name) => plink(name)).join(", ") + "</small>" : "") + "</span>" };
      }
      if (item.kind === "sub") {
        const sub = item.sub, sideSpells = spells[item.side], goalie = sub.keeperIn || sub.in,
          toGoal = sub.keeper || sideSpells.some((spell) => spell.player === goalie && spell.minute === (Number(sub.minute) || 0) && spell.out === sub.out);
        return { cls: " is-sub", html: crest + '<span class="hx-tl-txt"><b><span aria-hidden="true">⇄ </span><span class="sr-only">Substituição: </span><span class="hx-in"><span aria-hidden="true">↑ </span><span class="sr-only">entra </span>' + plink(sub.in) + '</span> <span class="hx-out"><span aria-hidden="true">↓ </span><span class="sr-only">sai </span>' + plink(sub.out) + "</span></b>" + (toGoal ? '<small class="hx-in"><span aria-hidden="true">↑ </span>' + plink(goalie) + " vai pro gol</small>" : "") + "</span>" };
      }
      const w = item.warn;
      return { cls: " is-warn", html: crest + '<span class="hx-tl-txt"><b><span aria-hidden="true">⚠ </span><span class="sr-only">Advertência: </span>' + plink(w.player || "") + " · " + escapeHtml(hxWarnLabel(w)) + "</b>" + (w.note ? "<small>" + escapeHtml(w.note) + "</small>" : "") + "</span>" };
    };
    // Empilha as fichas do mesmo lado que ficariam encostadas (mesmo minuto ou muito perto).
    const gap = Math.max(1, end * 0.24), lanes = { home: [], away: [] };
    const placed = items.map((item) => {
      const used = lanes[item.side];
      let level = 0;
      while (used.some((other) => other.level === level && Math.abs(other.minute - item.minute) < gap)) level++;
      used.push({ level, minute: item.minute });
      return { ...item, level, ...chip(item) };
    });
    const levels = { home: Math.max(0, ...placed.filter((p) => p.side === "home").map((p) => p.level + 1)), away: Math.max(0, ...placed.filter((p) => p.side === "away").map((p) => p.level + 1)) };
    const ROW = 52, BASE = 22;
    const lane = (side) => {
      const list = placed.filter((p) => p.side === side), h = levels[side] ? BASE + levels[side] * ROW : 18;
      return '<div class="hx-lane is-' + side + '" style="height:' + h + "px;" + hxVars(key(side)) + '">' + list.map((p) => {
        const off = BASE + p.level * ROW;
        return '<span class="hx-stem" style="left:' + pct(p.minute) + "%;height:" + (off + 4) + 'px" aria-hidden="true"></span>' +
          '<span class="hx-tl-chip' + p.cls + '" data-pct="' + pct(p.minute) + '" style="left:' + pct(p.minute) + "%;transform:translateX(-" + pct(p.minute) + "%);" + (side === "home" ? "bottom" : "top") + ":" + off + 'px"><span class="sr-only">' + p.minute + " minutos, " + escapeHtml(label(side)) + ": </span>" + p.html + "</span>";
      }).join("") + "</div>";
    };
    const ticks = [];
    for (let m = 0; m <= end; m += step) ticks.push(m);
    if (ticks[ticks.length - 1] !== end) ticks.push(end);
    const badges = [...new Set(placed.map((p) => p.side + "|" + p.minute))].map((k) => { const [side, m] = k.split("|"); return '<span class="hx-mbadge is-' + side + '" style="left:' + pct(Number(m)) + '%" aria-hidden="true">' + m + "′</span>"; }).join("");
    const axis = '<div class="hx-axis" aria-hidden="true"><span class="hx-axis-line"></span>' + ticks.map((m) => '<span class="hx-tick' + (m === 0 || m === end ? " is-edge" : "") + '" style="left:' + pct(m) + '%"></span><span class="hx-tick-label' + (m === end ? " is-end" : m === 0 ? " is-start" : "") + '" style="left:' + pct(m) + '%">' + m + "′" + (m === end ? " · FIM" : "") + "</span>").join("") + badges + "</div>";
    const legend = '<p class="hx-tl-legend">' + ["home", "away"].map((side) => '<span><i class="hx-sq" style="' + hxVars(key(side)) + '" aria-hidden="true"></i>' + escapeHtml(label(side)) + "</span>").join("") + "<span>⚽ gol · ⇄ troca · ⚠ advertência</span></p>";
    return '<section class="hx-gsec hx-gsec-tl" aria-label="Lance a lance"><div class="hx-gsec-head"><h3 class="hx-body-title">LANCE A LANCE</h3>' + legend + "</div>" +
      '<div class="hx-tl-scroll"><div class="hx-tl">' + lane("home") + axis + lane("away") + (placed.length ? "" : '<p class="hx-tl-empty">Sem gols ou ocorrências</p>') + "</div></div></section>";
  }
  function hxNumbers(game) {
    const perf = gamePerformance(game), sides = ["home", "away"], teamKey = (side) => game[side],
      goalsOf = (side) => Number(game[side + "Score"]) || 0,
      assistsOf = (side) => (game.goals || []).filter((goal) => !goal.ownGoal && goal.assistedBy && (goal.scoringTeam || goal.team) === teamKey(side)).length,
      subsOf = (side) => (game.substitutions || []).filter((sub) => sub.team === teamKey(side)).length,
      warnsOf = (side) => hxWarnings(game).filter((item) => (hxSideOf(game, item.player) || (item.team === game.away ? "away" : item.team === game.home ? "home" : null)) === side).length,
      avgOf = (side) => { const list = perf.filter((p) => p.team === teamKey(side)); return list.length ? list.reduce((sum, p) => sum + (Number(p.score) || 0), 0) / list.length : null; },
      shoot = game.shootout && Number.isFinite(game.shootout.homeScore) ? game.shootout : null;
    const rows = [
      ["GOLS", goalsOf("home"), goalsOf("away")],
      ["ASSISTÊNCIAS", assistsOf("home"), assistsOf("away")],
      ["GOLS SOFRIDOS", goalsOf("away"), goalsOf("home")],
      ["SUBSTITUIÇÕES", subsOf("home"), subsOf("away")],
      ["ADVERTÊNCIAS", warnsOf("home"), warnsOf("away")],
    ];
    const ah = avgOf("home"), aa = avgOf("away");
    if (ah != null || aa != null) rows.push(["SCORE MÉDIO", ah, aa, true]);
    if (shoot) rows.push(["PÊNALTIS CONVERTIDOS", Number(shoot.homeScore) || 0, Number(shoot.awayScore) || 0]);
    const fmt = (v, dec) => v == null ? "–" : dec ? v.toFixed(1).replace(".", ",") : String(v);
    const head = '<div class="hx-num-head"><span class="hx-num-team">' + hxCrest(teamKey("home"), gameTeamLabel(game, "home"), "sm") + "<b>" + escapeHtml(gameTeamLabel(game, "home")) + '</b></span><span class="hx-num-team is-away"><b>' + escapeHtml(gameTeamLabel(game, "away")) + "</b>" + hxCrest(teamKey("away"), gameTeamLabel(game, "away"), "sm") + "</span></div>";
    return '<section class="hx-gsec hx-gsec-num" aria-label="Números do jogo" style="--h-tb:' + hxColors(teamKey("home")).bg + ";--h-l:" + hxColors(teamKey("home")).light + ";--h-d:" + hxColors(teamKey("home")).dark + ";--a-tb:" + hxColors(teamKey("away")).bg + ";--a-l:" + hxColors(teamKey("away")).light + ";--a-d:" + hxColors(teamKey("away")).dark + '"><h3 class="hx-body-title">NÚMEROS DO JOGO</h3>' + head +
      '<ul class="hx-num-list">' + rows.map(([labelText, h, a, dec]) => {
        const max = Math.max(Number(h) || 0, Number(a) || 0), w = (v) => (max > 0 ? Math.round(((Number(v) || 0) / max) * 100) : 0);
        return '<li class="hx-num-row"><b class="hx-nv is-home">' + fmt(h, dec) + '</b><span class="hx-bar is-home"><i style="width:' + w(h) + '%"></i></span><span class="hx-nl">' + labelText + '</span><span class="hx-bar is-away"><i style="width:' + w(a) + '%"></i></span><b class="hx-nv is-away">' + fmt(a, dec) + "</b></li>";
      }).join("") + "</ul></section>";
  }
  function hxLineups(game) {
    const perf = gamePerformance(game), subs = game.substitutions || [];
    const block = (side) => {
      const team = game[side], label = gameTeamLabel(game, side), spells = keeperSpells(game, side), keepers = spells.map((spell) => spell.player),
        starters = [...(game[side + "Start"] || game[side + "Players"] || [])],
        entered = [...new Set(subs.filter((sub) => sub.team === team && !starters.includes(sub.in)).map((sub) => sub.in))],
        mine = perf.filter((p) => p.team === team), best = mine.length ? Math.max(...mine.map((p) => Number(p.score) || 0)) : null,
        startKeeper = spells[0]?.player;
      if (!starters.length && !entered.length) return '<div class="hx-lu" style="' + hxVars(team) + '"><div class="hx-lu-head">' + hxCrest(team, label, "md") + "<b>" + escapeHtml(label) + '</b><span>SCORE</span></div><p class="empty-state">Escalação não registrada.</p></div>';
      const ordered = startKeeper && starters.includes(startKeeper) ? [startKeeper, ...starters.filter((name) => name !== startKeeper)] : starters;
      const row = (name, isEntered) => {
        const p = mine.find((item) => item.player === name), isKeeper = keepers.includes(name) || p?.role === "goleiro",
          inMin = subs.filter((sub) => sub.team === team && sub.in === name).map((sub) => Number(sub.minute) || 0),
          outMin = subs.filter((sub) => sub.team === team && sub.out === name).map((sub) => Number(sub.minute) || 0),
          stats = [
            p && Number(p.goalsFor) ? '<span class="hx-pst"><span aria-hidden="true">⚽ </span><span class="sr-only">gols: </span>' + Number(p.goalsFor) + "</span>" : "",
            p && Number(p.assists) ? '<span class="hx-pst"><span aria-hidden="true">🅰 </span><span class="sr-only">assistências: </span>' + Number(p.assists) + "</span>" : "",
            ...inMin.map((m) => '<span class="hx-pst hx-in"><span aria-hidden="true">↑ </span><span class="sr-only">entrou aos </span>' + m + "′</span>"),
            ...outMin.map((m) => '<span class="hx-pst hx-out"><span aria-hidden="true">↓ </span><span class="sr-only">saiu aos </span>' + m + "′</span>"),
          ].join(""),
          conceded = isKeeper && p ? Number(p.goalsAgainst) || 0 : null,
          note = p ? '<b class="hx-note' + (best != null && Number(p.score) === best ? " is-best" : "") + '" aria-label="Nota ' + Number(p.score).toFixed(1).replace(".", ",") + '">' + Number(p.score).toFixed(1).replace(".", ",") + "</b>" : "";
        return '<li class="hx-lu-p' + (isEntered ? " is-entered" : "") + '"><span class="hx-pname">' + plink(name) + "</span>" +
          (isKeeper ? '<b class="hx-g" title="Goleiro" aria-label="Goleiro">G</b>' + (conceded != null ? '<small class="hx-conc">' + conceded + (conceded === 1 ? " sofrido" : " sofridos") + "</small>" : "") : "") +
          '<span class="hx-pstats">' + stats + "</span>" + note + "</li>";
      };
      return '<div class="hx-lu" style="' + hxVars(team) + '"><div class="hx-lu-head">' + hxCrest(team, label, "md") + "<b>" + escapeHtml(label) + '</b><span>SCORE</span></div><ul class="hx-lu-list">' + ordered.map((name) => row(name, false)).join("") + "</ul>" +
        (entered.length ? '<p class="hx-lu-label">ENTROU</p><ul class="hx-lu-list">' + entered.map((name) => row(name, true)).join("") + "</ul>" : "") + "</div>";
    };
    return '<section class="hx-gsec hx-gsec-lu" aria-label="Escalação e goleiros"><h3 class="hx-body-title">ESCALAÇÃO E GOLEIROS</h3><div class="hx-lu-grid">' + block("home") + block("away") + "</div></section>";
  }
  function hxFooter(game, shoot) {
    const warnings = hxWarnings(game),
      warningRows = warnings.length
        ? '<ul class="hx-warn-list">' + warnings.map((item) => "<li><span>" + escapeHtml(hxWarnLabel(item)) + " · " + plink(item.player || "") + (item.note ? ' <small>' + escapeHtml(item.note) + "</small>" : "") + "</span><b>" + (Number(item.minute) || 0) + "′</b></li>").join("") + "</ul>"
        : '<p class="empty-state">Sem advertências ou ocorrências registradas.</p>',
      shootRows = shoot && (shoot.kicks || []).length ? '<h5 class="hx-sub-title">Pênaltis</h5><ul class="hx-warn-list">' + shoot.kicks.map((kick, index) => "<li><span>" + (index + 1) + ". " + escapeHtml(teamName(game, kick.team)) + " · " + escapeHtml(kick.player ? displayName(kick.player) : "Batedor não identificado") + "</span><b>" + (kick.scored ? "✓ Gol" : "✗ Errou") + "</b></li>").join("") + "</ul>" : "",
      panel = hxPanel(game, "warnings", "Advertências e ocorrências", warningRows + shootRows);
    return '<div class="hx-pbtns">' + panel.button + '<button type="button" class="hx-pbtn hx-share" data-hx-share="' + escapeHtml(game.id) + '">Compartilhar súmula</button></div>' + panel.panel;
  }
  // Linha do tempo: mede as fichas de verdade e empilha só as que encostariam (o nível inicial é uma estimativa).
  function hxLayout(root) {
    const ROW = 52, BASE = 22;
    root?.querySelectorAll(".hx-tl").forEach((tl) => {
      const width = tl.getBoundingClientRect().width;
      if (!width) return;
      tl.querySelectorAll(".hx-lane").forEach((lane) => {
        const home = lane.classList.contains("is-home"), chips = [...lane.querySelectorAll(".hx-tl-chip")], stems = [...lane.querySelectorAll(".hx-stem")];
        const rows = [];
        chips.map((chip, i) => { const w = chip.getBoundingClientRect().width, pct = Number(chip.dataset.pct) || 0, left = (pct / 100) * (width - w); return { chip, stem: stems[i], left, right: left + w }; })
          .sort((a, b) => a.left - b.left)
          .forEach((item) => {
            let level = 0;
            while ((rows[level] || []).some((other) => item.left < other.right + 6 && other.left < item.right + 6)) level++;
            (rows[level] = rows[level] || []).push(item);
            const off = BASE + level * ROW;
            item.chip.style[home ? "bottom" : "top"] = off + "px";
            if (item.stem) item.stem.style.height = off + 4 + "px";
          });
        if (chips.length) lane.style.height = BASE + rows.length * ROW + "px";
      });
    });
  }
  // Nomes sempre numa linha: diminui a fonte até caber (escalação do jogo aberto).
  function hxFit(root) {
    hxLayout(root);
    root?.querySelectorAll(".hx-pname").forEach((el) => {
      el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
      while (el.scrollWidth > el.clientWidth + 0.5 && size > 9 && guard++ < 24) { size -= 0.5; el.style.fontSize = size + "px"; }
    });
  }
  function teamName(game, key) {
    return key === game.home ? gameTeamLabel(game, "home") : key === game.away ? gameTeamLabel(game, "away") : teamLabel(key);
  }
  function bindHistory() {
    const list = $("gameHistory");
    window.addEventListener("resize", () => list.querySelectorAll("details[open]").forEach(hxFit));
    list.addEventListener("toggle", (event) => {
      const id = event.target.dataset?.hxGame;
      if (id) { if (event.target.open) { historyOpenGames.add(id); hxFit(event.target); } else historyOpenGames.delete(id); list.dataset.markup = ""; }
    }, true);
    list.addEventListener("click", (event) => {
      const share = event.target.closest("[data-hx-share]");
      if (share) { ART.type = "result"; ART.gameId = share.dataset.hxShare; setView("arte"); renderArt(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
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
      history = [...officialGames()].sort((a, b) => (hxTime(b.finishedAt)?.getTime() || 0) - (hxTime(a.finishedAt)?.getTime() || 0)),
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
    if (list.dataset.markup !== markup) { list.dataset.markup = markup; list.innerHTML = markup; list.querySelectorAll("details[open]").forEach(hxFit); }
  }
  function renderGoals() {
    const totals = new Map(),
      superGameIds = new Set([
        ...officialGames().filter((game) => game.superLigaId).map((game) => game.id),
        ...(state.currentGame?.superLigaId ? [state.currentGame.id] : []),
      ]);
    goals
      .filter((goal) => !goal.own_goal && !superGameIds.has(goal.game_id) && !isTrainingGoal(goal))
      .forEach((goal) =>
        totals.set(goal.player_name, (totals.get(goal.player_name) || 0) + 1),
      );
    const ranking = [...totals.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "pt-BR"),
    );
    // Artilharia: empate em gols divide a posição; dentro do empate, menos jogos, depois maior nota, depois nome.
    const teams = selectedTeams(), live = state.currentGame && !state.currentGame.training && !state.currentGame.superLigaId ? [...(teams.home?.players || []), ...(teams.away?.players || [])] : [];
    const goalRows = ranking.map(([name, count]) => {
      const past = ligaGames().filter((game) => gamePerformance(game).some((p) => p.player === name) || (!gamePerformance(game).length && (game.goals || []).some((g) => g.player === name))).length;
      const stats = rkStats(name);
      return { name, value: count, games: past + (live.includes(name) ? 1 : 0), stats, avg: stats.games ? stats.sum / stats.games : 0 };
    }).sort((a, b) => b.value - a.value || a.games - b.games || b.avg - a.avg || a.name.localeCompare(b.name, "pt-BR"));
    rkRender("goalRanking", goalRows.slice(0, 11), { unit: (v) => (v === 1 ? "gol" : "gols"), text: (v) => String(v), empty: "Nenhum gol registrado." });
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
  function superStandings(sl = state.superLiga, history = officialGames()) {
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
    const game = fixture.gameId ? officialGames().find((item) => item.id === fixture.gameId) : null,
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
    return '<div class="ranking-row' + (index < 3 ? " top-rank top-rank-" + (index + 1) : "") + '"><span class="rank">' + String(index + 1).padStart(2, "0") + "</span><span>" + plink(name) + " <small>" + escapeHtml(detail) + "</small></span><strong>" + value + "</strong></div>";
  }
  function superRankingData() {
    const games = officialGames().filter((game) => game.superLigaId),
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
      keeperRows = average("goleiro").filter((r) => r.games >= MIN_KEEPER_GAMES).sort((a, b) => b.average - a.average || a.against - b.against || a.name.localeCompare(b.name, "pt-BR")).slice(0, 10),
      playerRows = average("linha").sort((a, b) => b.average - a.average || a.name.localeCompare(b.name, "pt-BR")).slice(0, 10);
    return { scorerRows, keeperRows, playerRows, teamOf, plural };
  }
  function superRankings(sl) {
    const { scorerRows, keeperRows, playerRows, teamOf, plural } = superRankingData(),
      empty = '<p class="empty-state">Aparece depois do primeiro jogo da Super Liga.</p>',
      score = (value) => value.toFixed(1).replace(".", ",");
    return '<div class="sl-rankings-head"><h3>Rankings da Super Liga</h3><p class="help-text">Somam todas as Super Ligas já disputadas. Não zeram com "Nova Super Liga".</p></div><div class="sl-rankings">' +
      '<div class="sl-block"><h3>Artilheiros</h3>' + (scorerRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team), plural(r.goals, "gol", "gols"))).join("") || empty) + "</div>" +
      '<div class="sl-block"><h3>Melhores goleiros</h3>' + (keeperRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team) + " · " + plural(r.games, "jogo", "jogos") + " · " + plural(r.against, "gol sofrido", "gols sofridos"), score(r.average))).join("") || (officialGames().some((game) => game.superLigaId) ? '<p class="empty-state">' + "Entra no ranking quem tiver " + MIN_KEEPER_GAMES + " jogos ou mais no gol." + "</p>" : empty)) + "</div>" +
      '<div class="sl-block"><h3>Score dos jogadores</h3>' + (playerRows.map((r, i) => superRankingRow(i, r.name, teamOf(r.team) + " · " + plural(r.games, "jogo", "jogos"), score(r.average))).join("") || empty) + "</div>" +
      "</div>";
  }
  // ---------- Super Liga encerrada: campeão em destaque ----------
  // O título é decidido pelo primeiro jogo com stage "final" desta Super Liga (nunca pelo último jogo disputado).
  function superFinalGame(sl = state.superLiga) {
    if (!sl) return null;
    const history = officialGames(),
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
      ? goals.map((goal) => "<li><b>" + slxMinute(goal.minute) + "</b> " + plink(goal.player || "Gol") + (goal.ownGoal ? " <small>(contra)</small>" : "") + "</li>").join("")
      : '<li class="slx-nogoal">Sem gols</li>';
  }
  function slxPlayerRow(name, role, lineup) {
    const isKeeper = name === lineup.keeperName || keeper(name),
      marks = lineup.events(name).map((item) => item.kind === "out"
        ? '<span class="slx-ev slx-ev-out">↓ saiu ' + slxMinute(item.minute) + "</span>"
        : '<span class="slx-ev slx-ev-in">↑ entrou ' + slxMinute(item.minute) + "</span>").join("");
    return '<li><span class="slx-pname">' + plink(name) + (isKeeper ? ' <b class="slx-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</span>" + marks +
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
  function slxRankCard(title, rows, detail, value, emptyText) {
    if (!rows.length) return '<article class="slx-rank-card"><h4>' + title + '</h4><p class="empty-state">' + escapeHtml(emptyText || "Aparece depois do primeiro jogo da Super Liga.") + '</p></article>';
    return '<article class="slx-rank-card"><h4>' + title + '</h4><ol class="slx-rank-list">' + rows.map((row, index) =>
      '<li class="slx-rank-' + (index < 3 ? index + 1 : "n") + '"><span class="slx-pos">' + (index + 1) + '</span><span class="slx-who"><strong>' + plink(row.name) + "</strong><small>" + escapeHtml(detail(row)) + '</small></span><b class="slx-val">' + value(row) + "</b></li>").join("") + "</ol></article>";
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
        html += '<div class="slx-squad"><p class="slx-squad-title">QUEM JOGOU A FINAL</p><ul class="slx-chips">' + lineup.played.map((name) => "<li>" + plink(name) + (name === lineup.keeperName || keeper(name) ? ' <b class="slx-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + "</li>").join("") + "</ul></div>";
      }
      html += "</section>";
    }
    // Rankings: somam todas as Super Ligas, inclusive amistosos.
    const { scorerRows, keeperRows, playerRows, teamOf, plural } = superRankingData(), score = (value) => value.toFixed(1).replace(".", ",");
    html += '<section class="slx-ranks" aria-labelledby="slxRanksTitle"><div class="slx-sec-head"><h3 id="slxRanksTitle">RANKINGS DA SUPER LIGA</h3><p>Somam todas as Super Ligas, inclusive os amistosos.</p></div><div class="slx-rank-grid">' +
      slxRankCard("Artilheiros", scorerRows, (row) => teamOf(row.team), (row) => row.goals + '<small>' + (row.goals === 1 ? "gol" : "gols") + "</small>") +
      slxRankCard("Melhores goleiros", keeperRows, (row) => teamOf(row.team) + " · " + plural(row.games, "jogo", "jogos") + " · " + plural(row.against, "gol sofrido", "gols sofridos"), (row) => score(row.average), officialGames().some((game) => game.superLigaId) ? "Entra no ranking quem tiver " + MIN_KEEPER_GAMES + " jogos ou mais no gol." : "") +
      slxRankCard("Score dos jogadores", playerRows, (row) => teamOf(row.team) + " · " + plural(row.games, "jogo", "jogos"), (row) => score(row.average)) +
      "</div></section>";
    if (final && champion) {
      const champSide = final.home === champion ? "home" : "away";
      html += '<section class="slx-lineups" aria-labelledby="slxLineupTitle"><div class="slx-sec-head"><h3 id="slxLineupTitle">ESCALAÇÃO DA FINAL</h3></div><div class="slx-lineup-grid">' +
        slxTeamCard(final, champSide, true) + slxTeamCard(final, champSide === "home" ? "away" : "home", false) + "</div></section>";
    }
    // Outros jogos desta Super Liga (fora a final).
    const others = officialGames().filter((game) => game.superLigaId === sl.id && game.id !== final?.id).sort((a, b) => new Date(a.finishedAt || 0) - new Date(b.finishedAt || 0));
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
      if (status === "setup" && officialGames().some((game) => game.superLigaId)) html += superRankings(sl);
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
      players.map(([name, extra], index) => '<li><span class="pt-num">' + (index + 1) + '</span><span class="pt-player">' + plink(name) + "</span>" + (keeper(name) ? '<b class="pt-g" title="Goleiro" aria-label="Goleiro">G</b>' : "") + (extra ? '<small class="pt-extra">' + extra + "</small>" : "") + "</li>").join("") +
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
  // Times já sorteados para a rodada atual? Times de uma rodada antiga (jogos numa noite anterior à data do jogo) não contam.
  function ligaDrawnForRound() {
    if (state.currentGame) return true;
    if (!(state.teams || []).length) return false;
    const nights = officialGames().filter((g) => state.roundId && g.roundId === state.roundId).map(nightKeyOf).filter(Boolean).sort();
    if (!nights.length || !state.matchDate) return true;
    return nights[nights.length - 1] >= state.matchDate;
  }
  // Lista de presença pública (só leitura): aparece na aba Modo Liga enquanto o sorteio da rodada não sai.
  function ligaListRound() {
    const round = HOME_PZ.data?.round;
    return round && state.matchDate && round.round_key === state.matchDate && !ligaDrawnForRound() ? round : null;
  }
  function ligaListHtml(round) {
    const players = HOME_PZ.data?.players || [], confirmed = players.filter((p) => p.status === "in"), waiting = players.filter((p) => p.status === "wait");
    const left = Math.max(0, round.slots - confirmed.length);
    const card = (p, i, wait) => '<li class="pza-card ' + (wait ? "is-wait" : "is-ok") + (p.keeper ? " is-keeper" : "") + '"><span class="pza-n">' + (i + 1) + '</span><span class="pza-nm"><span class="pza-nm-t">' + plink(p.name) + "</span>" +
      (wait ? "<small>" + (i === 0 ? "próximo a entrar" : "espera nº " + (i + 1)) + "</small>" : "") + "</span>" + (p.keeper ? '<b class="pza-gk" title="Goleiro" aria-label="goleiro">G</b>' : "") + "</li>";
    const foot = !round.open ? '<p class="pzp-note">Fale com o organizador</p>'
      : '<a class="pza-btn is-green" href="#presenca">' + (left ? '<span aria-hidden="true">✅</span> Confirmar presença' : "Entrar na espera") + "</a>";
    return '<div class="pza pzp">' + pzaHeadHtml(round.round_key, round, confirmed, waiting, "h2") +
      '<p class="pzp-lead">Os times saem no sorteio, antes do primeiro jogo.</p>' +
      '<div class="pza-sec"><p class="pza-legend"><span><i></i>Confirmado</span><span><i class="is-wait"></i>Lista de espera</span></p>' +
      '<div class="pza-sh"><h3>Confirmados</h3><span class="pza-tag is-ok">' + confirmed.length + " de " + round.slots + "</span></div>" +
      (confirmed.length ? '<ol class="pza-cards">' + confirmed.map((p, i) => card(p, i, false)).join("") + "</ol>" : '<p class="pv-hint">Ninguém confirmou ainda.</p>') +
      (waiting.length ? '<div class="pza-waitsec"><div class="pza-sh"><h3>Lista de espera</h3><span class="pza-tag is-wait">' + waiting.length + ' na espera</span></div><ol class="pza-cards">' + waiting.map((p, i) => card(p, i, true)).join("") + "</ol></div>" : "") +
      '<div class="pzp-foot">' + foot + "</div></div></div>";
  }
  function renderLigaPublicTeams(otherMode) {
    const section = $("ligaPublicTeams");
    if (!section) return;
    const teams = state.teams || [], list = $("ligaPublicList");
    const listRound = shownLiveMode() === "liga" ? ligaListRound() : null;
    if (shownLiveMode() === "liga" && !HOME_PZ.data) homePresenceLoad();
    if (listRound) {
      section.hidden = false;
      section.classList.add("is-list");
      $("ligaPublicNote").hidden = true;
      $("ligaPublicTeamsGrid").hidden = true;
      list.hidden = false;
      const markup = ligaListHtml(listRound);
      if (list.dataset.markup !== markup) { list.dataset.markup = markup; list.innerHTML = markup; }
      return;
    }
    section.classList.remove("is-list");
    list.hidden = true; list.dataset.markup = ""; list.innerHTML = "";
    $("ligaPublicTeamsGrid").hidden = false;
    const show = isEditLocked() && shownLiveMode() === "liga" && teams.length > 0;
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
  // ---------- Escudos dos times e Tela principal ----------
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
  // Súmula de um jogo (placar com escudos, campeão, ficha, gols, números e escalações): usada na Super Liga encerrada.
  // (Veio do antigo SKALAMA News, que saiu do site; recebe { match_id }.)
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
    const game = post.match_id && officialGames().find((item) => item.id === post.match_id);
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
      game.venue || state.venue || "",
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
          return '<li class="nm-goal nm-' + side + '"><span class="nm-minute">' + (Number(goal.minute) || "–") + "'</span><span class=\"nm-goal-text\"><strong>" + plink(goal.player || "Gol") + "</strong>" + (goal.ownGoal ? " <em>(contra)</em>" : "") + (goal.assistedBy ? "<small>assist. " + plink(goal.assistedBy) + "</small>" : "") + "</span></li>";
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
          return '<li><span class="nm-player">' + plink(name) + (name === keeperName || keeper(name) ? ' <b class="nm-tag">GOL</b>' : "") +
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
        (unused.length ? '<p class="nm-bench">Banco: ' + unused.map((name) => plink(name)).join(", ") + "</p>" : "") + "</div>";
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
      homePresenceHtml() +
      (teams.length ? '<button type="button" class="hx-btn" data-home-teams>Ver equipes</button>' : "");
    homePresenceLoad();
    const footerVenue = $("footerVenue");
    if (footerVenue) footerVenue.textContent = venue || "Quadra do Jemb";
  }
  // Próximo jogo: bloco da Lista de presença com os dados reais (só leitura; confirmar abre o fluxo de sempre, com PIN).
  const HOME_PZ = { data: null, at: 0, busy: false };
  // Uma leitura só (a cada 30 s) para o Próximo jogo da Tela principal e a lista da aba Modo Liga.
  setInterval(() => { if (document.visibilityState === "visible") homePresenceLoad(); }, 30000);
  async function homePresenceLoad() {
    if (!shared || !client || HOME_PZ.busy || Date.now() - HOME_PZ.at < 30000) return;
    HOME_PZ.busy = true; HOME_PZ.at = Date.now();
    try {
      const data = await pvRpc("presence_get", {});
      if (data && data.round !== undefined) {
        const changed = JSON.stringify(data.round) + JSON.stringify(data.counts) !== JSON.stringify(HOME_PZ.data?.round) + JSON.stringify(HOME_PZ.data?.counts);
        HOME_PZ.data = data;
        if (changed) { renderHomeNext(); renderLigaPublicTeams(shownLiveMode() !== activeLiveMode()); }
      }
    } finally { HOME_PZ.busy = false; }
  }
  function homePresenceHtml() {
    const round = HOME_PZ.data?.round;
    // Sem rodada para a data do jogo, o bloco não aparece. Fechada (na mão ou pelo horário): fica, sem o botão.
    if (!round || (state.matchDate && round.round_key !== state.matchDate)) return "";
    const inn = Number(HOME_PZ.data.counts?.in) || 0, slots = Number(round.slots) || 0, left = Math.max(0, slots - inn), full = slots > 0 && left === 0;
    const listLink = ligaDrawnForRound() ? "" : '<button type="button" class="hx-pres-link" data-home-list>Ver lista ›</button>';
    const meter = '<div class="hx-meter" role="progressbar" aria-label="Vagas preenchidas" aria-valuemin="0" aria-valuemax="' + slots + '" aria-valuenow="' + Math.min(inn, slots) + '"><i style="width:' + (slots ? Math.min(100, (inn / slots) * 100) : 0) + '%"></i></div>';
    if (!round.open) return '<div class="hx-pres is-closed"><p class="hx-pres-row"><span>Lista de presença</span><span class="pza-st is-full">FECHADA</span></p>' +
      '<p class="hx-pres-closed"><b>Lista fechada · ' + inn + (inn === 1 ? " confirmado" : " confirmados") + "</b></p>" + meter + '<p class="hx-pres-note">Fale com o organizador</p>' + listLink + "</div>";
    return '<div class="hx-pres"><p class="hx-pres-row"><span>Lista de presença</span><b>' + (full ? "Lista completa" : inn + " de " + slots + " · " + left + (left === 1 ? " vaga" : " vagas")) + "</b></p>" +
      meter +
      // Lista cheia: o fluxo de presença já coloca na lista de espera.
      '<a class="hx-pres-btn" href="#presenca">' + (full ? "Entrar na espera" : '<span aria-hidden="true">✅</span> Confirmar presença') + "</a>" + listLink + "</div>";
  }
  // Antes do primeiro jogo da rodada, os cards sem dados somem e aparece um aviso só.
  function renderHomeVisibility() {
    const roundId = state.roundId || state.currentGame?.roundId,
      roundGames = roundId ? officialGames().filter((game) => game.roundId === roundId).length : 0,
      empty = (id) => { const host = $(id); return !host || !host.children.length || (host.children.length === 1 && host.firstElementChild.classList.contains("empty-state")); },
      // Goleiros: com goleiro jogando mas ninguém com 3 jogos, a aba fica com o aviso de sempre (não some).
      keeperWaiting = empty("keeperRanking") && /Entra no ranking/.test($("keeperRanking")?.textContent || ""),
      rankTabs = [
        ["rankGols", empty("goalRanking")],
        ["rankScore", empty("playerScoreRanking")],
        ["rankGk", empty("keeperRanking") && empty("keeperConcededRanking") && !keeperWaiting],
      ];
    homeTabsSync("homeRankings", rankTabs);
    homeTabsSync("homeDestaques", [["destaques-noite", !roundGames], ["seasonPanel", empty("seasonHighlights")]]);
    $("homeStandings").hidden = !roundGames;
    // Destaques e Classificação lado a lado no PC; se só um aparece, ele ocupa a linha toda.
    $("homeLayout")?.classList.toggle("home-pair-single", $("homeDestaques").hidden !== $("homeStandings").hidden);
    homeMoreSync();
    const waiting = $("homeWaiting");
    waiting.hidden = !!roundGames;
    $("homeWaitingText").textContent = rankTabs.every(([, hide]) => hide)
      ? "A rodada ainda não começou. Classificação, artilharia, rankings e destaques da noite aparecem aqui depois do primeiro jogo."
      : "A rodada ainda não começou. Classificação e destaques da noite aparecem aqui depois do primeiro jogo.";
    const badge = $("liveBadge");
    if (badge) badge.hidden = !state.currentGame;
  }
  // ----- Tela principal: abas acessíveis (Destaques e Rankings) -----
  const HOME_UI = { open: {} };
  function homeTabSelect(tab, focus = false) {
    const list = tab?.closest('[role="tablist"]');
    if (!list) return;
    list.querySelectorAll('[role="tab"]').forEach((item) => {
      const on = item === tab, panel = $(item.getAttribute("aria-controls"));
      item.setAttribute("aria-selected", String(on));
      item.tabIndex = on ? 0 : -1;
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  }
  // Aba sem dados some; card sem nenhuma aba some; com uma aba só, a barra de abas some.
  function homeTabsSync(cardId, panels) {
    const card = $(cardId);
    if (!card) return;
    panels.forEach(([id, hide]) => { const tab = card.querySelector('[aria-controls="' + id + '"]'); if (tab) tab.hidden = hide; });
    const visible = panels.filter(([, hide]) => !hide);
    card.hidden = !visible.length;
    if (!visible.length) return;
    let tab = card.querySelector('[role="tab"][aria-selected="true"]');
    if (!tab || tab.hidden) tab = card.querySelector('[aria-controls="' + visible[0][0] + '"]');
    homeTabSelect(tab);
    const list = card.querySelector('[role="tablist"]');
    if (list) list.hidden = visible.length < 2;
  }
  // "Ver ... completo": a aba mostra os 3 primeiros; o botão abre o ranking inteiro (top 11).
  function homeMoreSync() {
    const rows = (id) => ($(id)?.querySelectorAll(".rk-item").length || 0);
    const conf = {
      gols: { n: rows("goalRanking"), panel: "rankGols", label: (n) => "Ver artilharia completa (" + n + ")" },
      score: { n: rows("playerScoreRanking"), panel: "rankScore", label: (n) => "Ver ranking completo (top " + n + ")" },
      gk: { n: rows("keeperRanking"), extra: rows("keeperConcededRanking"), panel: "rankGk", label: () => "Ver goleiros e gols sofridos" },
    };
    for (const [key, c] of Object.entries(conf)) {
      const btn = document.querySelector('[data-home-more="' + key + '"]'), panel = $(c.panel);
      if (!btn || !panel) continue;
      const can = c.n > 3 || (c.extra || 0) > 0, open = can && !!HOME_UI.open[key];
      btn.hidden = !can;
      btn.setAttribute("aria-expanded", String(open));
      btn.innerHTML = open ? "Mostrar só os 3 primeiros" : escapeHtml(c.label(c.n)) + ' <span aria-hidden="true">›</span>';
      panel.classList.toggle("is-open", open);
      if (key === "gk") $("homeGkMore").hidden = !open || !c.extra;
    }
    const gkNote = document.querySelector("#rankGk > .home-note");
    if (gkNote) gkNote.hidden = !rows("keeperRanking");
  }
  document.addEventListener("click", (event) => {
    const tab = event.target.closest?.('.home-tabs [role="tab"]');
    if (tab) { homeTabSelect(tab); return; }
    const more = event.target.closest?.("[data-home-more]");
    if (more) { const key = more.dataset.homeMore; HOME_UI.open[key] = !HOME_UI.open[key]; homeMoreSync(); if (!HOME_UI.open[key]) more.closest(".home-card")?.scrollIntoView({ block: "nearest" }); return; }
    const rules = event.target.closest?.("[data-home-rules]");
    if (rules) {
      const section = $("regras"), open = section.hidden;
      section.hidden = !open;
      rules.setAttribute("aria-expanded", String(open));
      if (open) section.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (event.target.closest?.("[data-home-past]")) {
      event.preventDefault();
      setView("history");
      setTimeout(() => $("rodadas-anteriores")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  });
  // Teclado nas abas: setas, Home e End (padrão WAI-ARIA, ativação automática).
  document.addEventListener("keydown", (event) => {
    const tab = event.target.closest?.('.home-tabs [role="tab"]');
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')].filter((item) => !item.hidden);
    const i = tabs.indexOf(tab);
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : tabs[(i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    homeTabSelect(next, true);
  });
  // ---------- Notificações push (aviso de vaga na lista de presença) ----------
  // A permissão só é pedida quando a pessoa toca em "Receber aviso no celular" (na tela de presença).
  const pushInfo = { reg: null, sub: null, busy: false, checked: false };
  function pushIsIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  // ---------- Instalar o app (Tela principal) ----------
  // Android/PC: usa o convite guardado no layout (beforeinstallprompt). iPhone/iPad (Safari): passo a passo.
  const INSTALL_LATER_KEY = "skalama-install-later", INSTALL_LATER_MS = 30 * 24 * 60 * 60 * 1000;
  function installLaterActive() {
    try { const at = Number(localStorage.getItem(INSTALL_LATER_KEY) || 0); return at > 0 && Date.now() - at < INSTALL_LATER_MS; } catch { return false; }
  }
  function installIosSafari() {
    const ua = navigator.userAgent || "", ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);
  }
  function renderInstall() {
    const box = $("homeInstall");
    if (!box) return;
    const prompt = window.__skInstall, ios = !prompt && installIosSafari(),
      show = !pushStandalone() && !window.__skInstalled && !installLaterActive() && (!!prompt || ios);
    box.hidden = !show;
    if (!show) return;
    $("homeInstallIos").hidden = !ios;
    $("homeInstallBtn").hidden = ios;
    box.classList.toggle("is-ios", ios);
  }
  async function installApp() {
    const prompt = window.__skInstall;
    if (!prompt) { renderInstall(); return; }
    window.__skInstall = null;
    try {
      prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === "accepted") { window.__skInstalled = true; notify("App da Skalama instalado."); }
    } catch {}
    renderInstall();
  }
  function setupInstall() {
    if (!$("homeInstall")) return;
    $("homeInstallBtn").addEventListener("click", installApp);
    $("homeInstallLater").addEventListener("click", () => {
      try { localStorage.setItem(INSTALL_LATER_KEY, String(Date.now())); } catch {}
      renderInstall();
    });
    document.addEventListener("sk-installable", renderInstall);
    document.addEventListener("sk-installed", renderInstall);
    window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", renderInstall);
    renderInstall();
  }
  setupInstall();
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
  // Toque na notificação com o site já aberto: o service worker pede para abrir o endereço (ex.: #presenca).
  function openUrlFromPush(url) {
    try { const target = new URL(url, location.href); if (target.hash && location.hash !== target.hash) location.hash = target.hash; } catch {}
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
    const box = $("pushBox");
    if (!box) return;
    const ios = pushIsIOS();
    let html = "";
    if (!pushAvailable()) html = "";
    else if (ios && !pushStandalone())
      html = '<p class="news-push-text">🔔 <strong>Quer receber no celular o aviso de quando abrir vaga para você?</strong> No iPhone, toque em Compartilhar › Adicionar à Tela de Início e abra o site por lá para ativar.</p>';
    else if (!pushSupported() || !pushInfo.checked) html = "";
    else if (Notification.permission === "denied")
      html = '<p class="news-push-text">🔕 <strong>As notificações estão bloqueadas neste navegador.</strong> Para liberar, toque no cadeado (ou no ícone de configurações) ao lado do endereço do site, permita <b>Notificações</b> e recarregue a página.' +
        (ios ? " No iPhone, vá em Ajustes › Notificações › LIGA SKALAMA e ative Permitir Notificações." : " No celular Android, também dá em Configurações › Apps › Chrome › Notificações.") + "</p>";
    else if (pushInfo.sub)
      html = '<div class="news-push-on"><span>🔔 Notificações ativadas</span><button type="button" class="text-button" data-push-off' + (pushInfo.busy ? " disabled" : "") + ">Desativar</button>" +
        (!isEditLocked() ? '<button type="button" class="button button-outline button-small" data-push-test' + (pushInfo.busy ? " disabled" : "") + ">Enviar notificação de teste</button>" : "") + "</div>";
    else
      html = '<div class="news-push-off"><button type="button" class="button button-primary news-push-btn" data-push-on' + (pushInfo.busy ? " disabled" : "") + '>🔔 Receber aviso no celular</button><p class="news-push-text">Se você estiver na lista de espera, avisamos neste aparelho quando abrir vaga. Ative e depois confirme a presença com o seu PIN para o aviso chegar só para você.' +
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
      notify("Pronto! Confirme a presença com o seu PIN para ligar este aparelho a você.");
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
    $("pushBox")?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-push-on],[data-push-off],[data-push-test]");
      if (!target || target.disabled) return;
      if ("pushOn" in target.dataset) enablePush();
      else if ("pushOff" in target.dataset) disablePush();
      else if ("pushTest" in target.dataset) sendTestPush();
    });
  }
  // ---------- Presença pelo link (#presenca) e Craque da noite (#votacao) ----------
  // Tudo passa por funções do Supabase (RPC): o navegador nunca lê as tabelas nem o hash do PIN.
  // O PIN nunca é guardado no aparelho; só o nome escolhido (comodidade).
  const PV_ME_KEY = "skalama-me";
  const PZ = { data: null, msg: "", tone: "", busy: false, formSig: "", timer: null };
  const PZA = { data: null, key: "", busy: false, timer: null, at: 0, access: null, links: new Map(), alerts: [], alerted: new Set(), accOpen: false, slots: 20, slotsKey: "", slotTimer: null, slotState: "" };
  const VT = { data: null, msg: "", tone: "", busy: false, cand: "", mine: "", formSig: "", timer: null };
  const VTA = { data: null, key: "", at: 0 };
  const VOTE = { winners: [], homeData: null, homeKey: "", homeAt: 0 };
  const PV_ERRORS = {
    pin_wrong: (r) => "PIN errado." + (r.remaining ? " Restam " + r.remaining + (r.remaining === 1 ? " tentativa" : " tentativas") + " antes de bloquear por 15 minutos." : ""),
    locked: (r) => "Muitas tentativas erradas. Esse nome fica bloqueado até " + (r.locked_until ? new Date(r.locked_until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "daqui a 15 minutos") + ". Se esqueceu o PIN, fale com o organizador.",
    pin_format: () => "O PIN tem 4 números.",
    not_in_roster: () => "Esse nome não está no elenco. Fale com o organizador.",
    closed: () => "A lista já fechou. Só o organizador pode mudar agora.",
    no_round: () => "Ainda não tem lista aberta.",
    slots: () => "Vagas: de 2 a 40.",
    slots_below: (r) => "Não dá para ter menos vagas que confirmados" + (r.confirmed ? " (" + r.confirmed + ")" : "") + ".",
    no_slot: () => "Não tem vaga livre. Aumente as vagas ou tire alguém da lista.",
    not_waiting: () => "Esse jogador não está mais na lista de espera. Atualize a lista.",
    not_player: () => "Só vota quem jogou pelo menos um jogo oficial nessa noite.",
    self_vote: () => "Não dá para votar em você mesmo.",
    already_voted: () => "Você já votou nesta votação. O voto não pode ser trocado.",
    bad_candidate: () => "Escolha alguém que jogou nessa noite.",
    forbidden: () => "Só o organizador pode fazer isso.",
    no_pin: () => "Você ainda não tem PIN. Peça seu link pessoal ao organizador para criar.",
    name_length: () => "O nome precisa ter de 2 a 24 caracteres.",
    name_chars: () => "Use só letras (com acento), números, espaço, ponto e hífen. Sem emoji.",
    name_taken: () => "Esse nome já é de outro jogador. Escolha outro.",
    name_same: () => "Esse já é o nome que aparece hoje.",
    name_limit: () => "Limite de 2 trocas de nome em 60 dias atingido.",
    no_request: () => "Esse pedido não está mais pendente. Atualize a lista.",
    invite_invalid: () => "Esse link não vale. Confira se copiou inteiro ou peça um novo ao organizador.",
    invite_used: () => "Esse link já foi usado para criar um PIN. Se não foi você, avise o organizador agora.",
    invite_expired: () => "Esse link venceu (vale 30 dias). Peça um novo ao organizador.",
    invite_has_pin: () => "Esse jogador já tem PIN. Se esqueceu, peça ao organizador para resetar seu acesso.",
    offline: () => "Precisa de internet e do banco compartilhado.",
    net: (r) => "Não deu para falar com o servidor agora. " + (r.message || ""),
  };
  const pvError = (r) => (PV_ERRORS[r?.error] || (() => "Não deu certo agora. Tente de novo."))(r || {});
  async function pvRpc(name, params = {}) {
    if (!shared || !client) return { ok: false, error: "offline" };
    try {
      const { data, error } = await client.rpc(name, params);
      if (error) return { ok: false, error: "net", message: error.message };
      return data || {};
    } catch (error) { return { ok: false, error: "net", message: error.message }; }
  }
  const pvNorm = (name) => baseName(name).toLocaleUpperCase("pt-BR");
  const pvMe = () => { try { return localStorage.getItem(PV_ME_KEY) || ""; } catch { return ""; } };
  const pvSetMe = (name) => { try { localStorage.setItem(PV_ME_KEY, name); } catch {} };
  const pvForgetMe = () => { try { localStorage.removeItem(PV_ME_KEY); } catch {} };
  // Aparelho que lembra: "Você é FULANO" + só o PIN. É só comodidade; a segurança está no PIN e no link pessoal.
  function pvMeBlock(id, me, prefix) {
    return '<div class="pv-me"><p class="pv-me-name">Você é <b>' + escapeHtml(displayName(me)) + '</b></p><button type="button" class="pv-switch" data-pv-switch="' + prefix + '">Não é você? Trocar</button></div>' +
      '<input type="hidden" id="' + id + '" value="' + escapeHtml(me) + '">';
  }
  function pvDate(key) { const d = key ? new Date(key + "T12:00:00") : null; return d && Number.isFinite(d.getTime()) ? d : null; }
  function pvWeekday(key) { const d = pvDate(key); return d ? d.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0].toUpperCase() : ""; }
  function pvDayMonth(key) { const d = pvDate(key); return d ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : ""; }
  // Noite de um jogo: data em Brasília, contando até 6 h da manhã como a noite anterior (igual ao banco).
  function nightKeyOf(game) {
    const at = hxTime(game?.finishedAt);
    return at ? new Date(at.getTime() - 6 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) : "";
  }
  function pvPinHtml(id) {
    return '<div class="pv-pin" id="' + id + '" role="group" aria-label="PIN de 4 números">' + [0, 1, 2, 3].map((i) => '<input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" aria-label="Número ' + (i + 1) + ' do PIN" data-pin="' + i + '">').join("") + "</div>";
  }
  function pvPinValue(id) { return [...document.querySelectorAll("#" + id + " input")].map((input) => input.value).join(""); }
  function pvPinClear(id) { document.querySelectorAll("#" + id + " input").forEach((input) => { input.value = ""; }); }
  // Caixas do PIN: só números, pula para a próxima, apaga voltando, colar distribui.
  document.addEventListener("input", (event) => {
    const input = event.target.closest?.(".pv-pin input");
    if (!input) return;
    const digits = input.value.replace(/\D/g, "");
    const boxes = [...input.parentElement.querySelectorAll("input")], index = boxes.indexOf(input);
    if (digits.length > 1) { digits.slice(0, 4 - index).split("").forEach((d, k) => { boxes[index + k].value = d; }); boxes[Math.min(3, index + digits.length - 1)].focus(); return; }
    input.value = digits;
    if (digits && index < 3) boxes[index + 1].focus();
  });
  document.addEventListener("keydown", (event) => {
    const input = event.target.closest?.(".pv-pin input");
    if (!input || event.key !== "Backspace" || input.value) return;
    const boxes = [...input.parentElement.querySelectorAll("input")], index = boxes.indexOf(input);
    if (index > 0) { boxes[index - 1].value = ""; boxes[index - 1].focus(); event.preventDefault(); }
  });
  function pvNameField(id, names, selected, label = "Quem é você?") {
    const search = names.length > 12 ? '<input type="search" class="pv-search" id="' + id + 'Search" placeholder="Buscar nome" aria-label="Buscar nome no elenco" autocomplete="off">' : "";
    return '<label class="pv-label" for="' + id + '">' + label + "</label>" + search +
      '<select id="' + id + '" class="pv-select"><option value="">Escolha seu nome</option>' + names.map((n) => {
        const locked = n.has_pin === false; // sem PIN: só cria pelo link pessoal, não dá para escolher
        return '<option value="' + escapeHtml(n.name) + '"' + (locked ? " disabled" : pvNorm(n.name) === pvNorm(selected) ? " selected" : "") + ">" + escapeHtml(displayName(n.name)) + (n.keeper ? " · goleiro" : "") + (locked ? " — peça seu link ao organizador" : "") + "</option>";
      }).join("") + "</select>";
  }
  document.addEventListener("input", (event) => {
    const search = event.target.closest?.(".pv-search");
    if (!search) return;
    const select = $(search.id.replace(/Search$/, "")), term = search.value.trim().toLocaleUpperCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "");
    [...select.options].forEach((option, i) => { if (i) option.hidden = !!term && !option.textContent.toLocaleUpperCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "").includes(term); });
    const first = [...select.options].find((option, i) => i && !option.hidden && !option.disabled);
    if (term && first && select.selectedOptions[0]?.hidden !== false) select.value = first.value;
  });
  function pvKeeperBadge(keeper) { return keeper ? ' <b class="pv-g" title="Goleiro" aria-label="goleiro">G</b>' : ""; }
  // Link oficial da lista: o convite sempre termina com ele (mesmo testando em outro endereço).
  const PV_LINK = "https://skalama.com.br/#presenca";
  function pvInviteText(round, countsIn) {
    if (!round) return "";
    const counts = countsIn || PZ.data?.counts || PZA.data?.counts || {}, left = Math.max(0, round.slots - (counts.in || 0));
    return "⚽ *CONVOCAÇÃO SKALAMA*\n" + pvWeekday(round.round_key).toLowerCase().replace(/^./, (c) => c.toUpperCase()) + ", " + pvDayMonth(round.round_key) +
      (round.start_time ? " às " + round.start_time.replace(":", "h") : "") + (round.venue ? "\n📍 " + round.venue : "") +
      "\n👥 " + round.slots + " vagas" + (counts.in ? " · " + left + (left === 1 ? " sobrando" : " sobrando") : "") +
      "\n\nConfirme com seu nome e PIN:\n" + PV_LINK;
  }
  // ----- Tela do jogador: lista de presença -----
  async function pzLoad(silent = false) {
    const data = await pvRpc("presence_get", {});
    if (data && data.round !== undefined) PZ.data = data;
    else if (!silent) { PZ.msg = pvError(data); PZ.tone = "bad"; }
    renderPresence();
  }
  function renderPresence() {
    const box = $("presenca");
    if (!box) return;
    if (!shared || !client) { box.innerHTML = '<div class="pv-wrap"><a class="pv-back" href="./">← Ir para o site</a><article class="pv-card"><p class="pv-kicker">CONVOCAÇÃO SKALAMA</p><p class="pv-empty">A lista de presença precisa de internet e do banco compartilhado.</p></article></div>'; return; }
    const data = PZ.data, round = data?.round, roster = data?.roster || [];
    if (!box.querySelector(".pv-wrap")) box.innerHTML = '<div class="pv-wrap"><a class="pv-back" href="./">← Ir para o site</a><article class="pv-card" id="pzCard" aria-live="polite"></article><section class="pv-panel" id="pzForm" aria-labelledby="pzFormTitle"></section><section class="pv-panel" id="pzLists" aria-label="Lista de presença"></section><div class="pv-namebox" id="pzNameBox"></div></div>';
    if (PZ.invite) { pzRenderInvite(); $("pzNameBox").innerHTML = ""; $("pzNameBox").dataset.html = ""; return; }
    // "✎ Editar meu nome": quem o aparelho lembra já vem escolhido; senão escolhe na janela.
    {
      const meR = (data?.roster || []).find((r) => pvNorm(r.name) === pvNorm(pvMe()) && r.has_pin);
      const html = data ? '<button type="button" class="pv-switch nm-open" data-nm-open="' + escapeHtml(meR ? meR.name : "") + '">✎ Editar meu nome</button>' : "";
      if ($("pzNameBox").dataset.html !== html) { $("pzNameBox").dataset.html = html; $("pzNameBox").innerHTML = html; } // não recria o botão a cada atualização
    }
    const counts = data?.counts || { in: 0, wait: 0 }, left = round ? Math.max(0, round.slots - counts.in) : 0;
    $("pzCard").innerHTML = '<p class="pv-kicker">CONVOCAÇÃO SKALAMA</p>' + (!data ? '<p class="pv-empty">Carregando…</p>' : !round ? '<p class="pv-empty">Ainda não tem lista aberta. Quando o organizador abrir, ela aparece aqui.</p>' :
      '<p class="pv-day">' + escapeHtml(pvWeekday(round.round_key)) + '</p><p class="pv-date">' + escapeHtml(pvDayMonth(round.round_key)) + "</p>" +
      '<p class="pv-where">' + escapeHtml([round.start_time ? round.start_time.replace(":", "h") : "", round.venue || ""].filter(Boolean).join(" · ")) + "</p>" +
      '<p class="pv-count"><strong>' + counts.in + " de " + round.slots + "</strong> confirmados · " + (left ? left + (left === 1 ? " vaga" : " vagas") : "lista cheia") + (counts.wait ? " · " + counts.wait + " na espera" : "") + "</p>" +
      '<div class="pv-bar" role="progressbar" aria-label="Vagas preenchidas" aria-valuemin="0" aria-valuemax="' + round.slots + '" aria-valuenow="' + counts.in + '"><i style="width:' + Math.min(100, (counts.in / round.slots) * 100) + '%"></i></div>' +
      '<p class="pv-state ' + (round.open ? "is-open" : "is-closed") + '">' + (round.open ? "Lista aberta até o horário do jogo" : "Lista fechada") + "</p>" + pzMineHtml(round, data.players || []));
    // Formulário: só redesenha quando o elenco ou a lista mudam de aberta/fechada (não apaga o PIN digitado).
    const meRow = roster.find((r) => pvNorm(r.name) === pvNorm(pvMe()));
    const meStatus = meRow ? (data?.players || []).find((p) => pvNorm(p.name) === pvNorm(meRow.name))?.status || "" : "";
    const sig = JSON.stringify([roster.map((r) => r.name + (r.has_pin ? "+" : "-")), !!round, round?.open, round?.round_key, meRow?.name || "", meStatus]);
    if (PZ.formSig !== sig) {
      PZ.formSig = sig;
      const pinAndGo = '<p class="pv-label" id="pzPinLabel">PIN (4 números)</p>' + pvPinHtml("pzPin") +
        '<div class="pv-actions"><button type="button" class="pv-btn pv-green" data-pz-go="1">✓ Vou jogar</button><button type="button" class="pv-btn pv-white" data-pz-go="0">' + (meStatus === "wait" ? "Sair da lista de espera" : "Não vou desta vez") + "</button></div>";
      const who = meRow && meRow.has_pin ? pvMeBlock("pzName", meRow.name, "pz") + pinAndGo
        : meRow ? pvMeBlock("pzNameNo", meRow.name, "pz") + '<p class="pv-hint pv-warn">Você ainda não tem PIN. Peça seu link pessoal ao organizador para criar.</p>'
        : pvNameField("pzName", roster, "") + pinAndGo + '<p class="pv-hint">Primeira vez? Peça seu link pessoal ao organizador para criar o PIN.</p>';
      $("pzForm").innerHTML = !round ? "" : '<h2 class="pv-h" id="pzFormTitle">' + (round.open ? "Confirme sua presença" : "Lista fechada") + "</h2>" +
        (round.open ? who : '<p class="pv-hint">Só o organizador pode mudar a lista agora.</p>') +
        '<p class="pv-msg" id="pzMsg" role="status" aria-live="polite"></p>' +
        '<div class="pv-share"><a class="pv-btn pv-wa" id="pzWa" target="_blank" rel="noopener">Compartilhar no WhatsApp</a></div>';
    }
    if ($("pzWa")) $("pzWa").href = "https://wa.me/?text=" + encodeURIComponent(pvInviteText(round));
    if ($("pzMsg")) { $("pzMsg").textContent = PZ.msg; $("pzMsg").className = "pv-msg" + (PZ.tone ? " is-" + PZ.tone : ""); }
    box.querySelectorAll("[data-pz-go]").forEach((button) => { button.disabled = PZ.busy; });
    const me = pvNorm($("pzName")?.value || pvMe()), players = data?.players || [];
    const row = (p, i) => '<li class="' + (pvNorm(p.name) === me && me ? "is-me" : "") + '"><span class="pv-n">' + (i + 1) + '</span><span class="pv-name">' + escapeHtml(displayName(p.name)) + pvKeeperBadge(p.keeper) + (pvNorm(p.name) === me && me ? ' <em class="pv-you">você</em>' : "") + "</span></li>";
    const confirmed = players.filter((p) => p.status === "in"), waiting = players.filter((p) => p.status === "wait");
    $("pzLists").innerHTML = !round ? "" : '<h2 class="pv-h">CONFIRMADOS (' + confirmed.length + "/" + round.slots + ")</h2>" + (confirmed.length ? '<ol class="pv-list">' + confirmed.map(row).join("") + "</ol>" : '<p class="pv-hint">Ninguém confirmou ainda. Seja o primeiro!</p>') +
      (waiting.length ? '<h2 class="pv-h pv-wait-h">LISTA DE ESPERA</h2><p class="pv-hint">Se alguém confirmado desistir, o primeiro da espera entra sozinho.</p><ol class="pv-list pv-wait">' + waiting.map(row).join("") + "</ol>" : "");
  }
  // Situação de quem o aparelho lembra: confirmado, "Abriu vaga" (veio da espera) ou posição na espera.
  const PZ_PROMOTED_KEY = "skalama-promoted-seen";
  function pzMineHtml(round, players) {
    const me = pvMe();
    if (!me) return "";
    const mine = players.find((p) => pvNorm(p.name) === pvNorm(me));
    if (!mine) return "";
    if (mine.status === "wait") {
      const pos = players.filter((p) => p.status === "wait").indexOf(mine) + 1;
      return '<p class="pv-mine is-wait">Você está na lista de espera (posição ' + pos + "). Se abrir vaga, você entra sozinho.</p>";
    }
    if (mine.promoted) {
      const k = round.round_key + "|" + pvNorm(me);
      let seen = "";
      try { seen = localStorage.getItem(PZ_PROMOTED_KEY) || ""; } catch {}
      if (seen !== k) {
        try { localStorage.setItem(PZ_PROMOTED_KEY, k); } catch {}
        PZ.promotedShown = k;
      }
      if (PZ.promotedShown === k) return '<p class="pv-mine is-promoted">✅ Abriu vaga: você está confirmado!</p>';
    }
    return '<p class="pv-mine is-in">✓ Você está confirmado.</p>';
  }
  // Liga este aparelho (se já recebe notificações) ao jogador, para o aviso de "abriu vaga" chegar só nele.
  async function pzLinkPush(name, pin) {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      const reg = pushInfo.reg || (await navigator.serviceWorker.getRegistration("/sw.js"));
      const sub = pushInfo.sub || (reg ? await reg.pushManager.getSubscription() : null);
      if (sub?.endpoint) await pvRpc("presence_push_link", { p_name: name, p_pin: pin, p_endpoint: sub.endpoint });
    } catch {}
  }
  // ----- Link pessoal de primeiro acesso (#presenca/TOKEN): o único jeito de criar o PIN -----
  async function pzInviteOpen(token) {
    PZ.invite = { token, data: null, msg: "", tone: "", busy: false };
    PZ.formSig = "";
    renderPresence();
    const r = await pvRpc("invite_get", { p_token: token });
    if (!PZ.invite || PZ.invite.token !== token) return;
    PZ.invite.data = r;
    renderPresence();
    if (r.ok) document.querySelector("#pzNewPin input")?.focus();
  }
  function pzRenderInvite() {
    const inv = PZ.invite, r = inv.data;
    PZ.formSig = "";
    $("pzLists").innerHTML = "";
    if (!r) { $("pzCard").innerHTML = '<p class="pv-kicker">PRIMEIRO ACESSO</p><p class="pv-empty">Abrindo seu link…</p>'; $("pzForm").innerHTML = ""; return; }
    if (!r.ok) {
      $("pzCard").innerHTML = '<p class="pv-kicker">PRIMEIRO ACESSO</p><p class="pv-empty">' + escapeHtml(pvError(r)) + "</p>";
      $("pzForm").innerHTML = '<div class="pv-actions"><a class="pv-btn pv-white" href="#presenca">Ir para a lista de presença</a></div>';
      return;
    }
    if (!$("pzNewPin")) {
      $("pzCard").innerHTML = '<p class="pv-kicker">PRIMEIRO ACESSO</p><p class="pv-invite-hi">Olá, ' + escapeHtml(displayName(r.name)) + '!</p><p class="pv-where">Crie seu PIN de 4 números</p>';
      $("pzForm").innerHTML = '<h2 class="pv-h" id="pzFormTitle">Crie seu PIN</h2>' +
        '<p class="pv-label">PIN (4 números)</p>' + pvPinHtml("pzNewPin") + '<p class="pv-label">Repita o PIN</p>' + pvPinHtml("pzNewPin2") +
        '<p class="pv-hint">Esse link é só seu e serve uma vez. Guarde o PIN: você usa ele para confirmar presença e votar no craque da noite.</p>' +
        '<div class="pv-actions"><button type="button" class="pv-btn pv-green" id="pzInviteGo">Criar meu PIN</button></div><p class="pv-msg" id="pzInviteMsg" role="status" aria-live="polite"></p>';
    }
    $("pzInviteGo").disabled = inv.busy;
    $("pzInviteMsg").textContent = inv.msg; $("pzInviteMsg").className = "pv-msg" + (inv.tone ? " is-" + inv.tone : "");
  }
  async function pzInviteSubmit() {
    const inv = PZ.invite;
    if (!inv?.data?.ok || inv.busy) return;
    const a = pvPinValue("pzNewPin"), b = pvPinValue("pzNewPin2");
    const fail = (msg, box) => { inv.msg = msg; inv.tone = "bad"; renderPresence(); if (box) { pvPinClear(box); document.querySelector("#" + box + " input")?.focus(); } };
    if (!/^\d{4}$/.test(a)) return fail("Digite os 4 números do PIN.", "pzNewPin");
    if (a !== b) return fail("Os dois PINs não batem. Digite de novo.", "pzNewPin2");
    inv.busy = true; renderPresence();
    const r = await pvRpc("invite_use", { p_token: inv.token, p_pin: a });
    inv.busy = false;
    if (!r.ok) { if (r.error === "pin_format") return fail(pvError(r), "pzNewPin"); inv.data = r; renderPresence(); return; }
    pvSetMe(r.name);
    PZ.invite = null; PZ.formSig = "";
    PZ.msg = "PIN criado! Guarde esses 4 números. Agora é só confirmar sua presença."; PZ.tone = "good";
    history.replaceState(null, "", location.pathname + location.search + "#presenca"); // o link usado sai da barra de endereço
    pvRoute();
  }
  async function pzSubmit(going) {
    const round = PZ.data?.round, name = $("pzName")?.value || "", pin = pvPinValue("pzPin");
    if (!round) return;
    if (!name) { PZ.msg = "Escolha seu nome na lista."; PZ.tone = "bad"; renderPresence(); $("pzName")?.focus(); return; }
    if (!/^\d{4}$/.test(pin)) { PZ.msg = "Digite os 4 números do PIN."; PZ.tone = "bad"; renderPresence(); document.querySelector("#pzPin input")?.focus(); return; }
    const wasWait = (PZ.data?.players || []).some((p) => pvNorm(p.name) === pvNorm(name) && p.status === "wait");
    PZ.busy = true; renderPresence();
    const r = await pvRpc("presence_set", { p_round: round.round_key, p_name: name, p_pin: pin, p_going: going });
    PZ.busy = false;
    if (r.ok) {
      pvSetMe(name); pvPinClear("pzPin");
      PZ.data = r.view || PZ.data;
      const st = r.me?.status;
      if (going) pzLinkPush(name, pin);
      PZ.msg = (r.created ? "PIN criado! Guarde esses 4 números. " : "") + (st === "in" ? "✓ Você está confirmado. Bom jogo!" : st === "wait" ? "A lista está cheia: você está na lista de espera (posição " + (r.me?.wait_pos || "?") + "). Se abrir vaga, você entra sozinho e recebe aviso." : wasWait ? "Você saiu da lista de espera." : "Tudo bem! Você não vai desta vez.");
      PZ.tone = st === "out" ? "" : "good";
    } else { PZ.msg = pvError(r); PZ.tone = "bad"; if (r.error === "pin_wrong" || r.error === "locked") pvPinClear("pzPin"); }
    renderPresence();
  }
  // ----- Nome de exibição: o jogador pede (com o PIN), o organizador aprova -----
  // O nome original continua sendo a chave; só o que aparece muda. Regras de verdade ficam no banco.
  const NM = { name: "", choose: false, step: "pin", pin: "", status: null, msg: "", tone: "", busy: false };
  const NM_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ0-9 .-]+$/;
  const nmClean = (v) => String(v || "").replace(/\s+/g, " ").trim().toLocaleUpperCase("pt-BR");
  const nmDate = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "");
  const nmLimitText = (limit) => "Você já trocou de nome 2 vezes nos últimos 60 dias. Poderá trocar de novo a partir de " + nmDate(limit?.next_at) + ".";
  function nmDialog() {
    let dialog = $("nmDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "nmDialog";
      dialog.className = "lv-sheet ask-sheet nm-sheet";
      dialog.setAttribute("aria-labelledby", "nmTitle");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog || event.target.closest("[data-nm-close]")) { dialog.close(); return; }
        if (event.target.closest("#nmGo")) nmSubmit();
      });
      dialog.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.matches("#nmInput, .pv-pin input")) { event.preventDefault(); nmSubmit(); } });
      dialog.addEventListener("input", (event) => { if (event.target.id === "nmInput") { const pos = event.target.selectionStart; event.target.value = event.target.value.toLocaleUpperCase("pt-BR"); try { event.target.setSelectionRange(pos, pos); } catch {} } });
      dialog.addEventListener("close", () => { NM.pin = ""; NM.status = null; NM.returnFocus?.focus?.(); });
    }
    return dialog;
  }
  function nmOpen(name) {
    Object.assign(NM, { name: name || "", choose: !name, step: "pin", pin: "", status: null, msg: "", tone: "", busy: false, returnFocus: document.activeElement });
    const dialog = nmDialog();
    nmRender();
    try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    (NM.choose ? $("nmName") : document.querySelector("#nmPin input"))?.focus();
  }
  function nmRender() {
    const dialog = nmDialog(), st = NM.status;
    let body = "", go = "";
    if (NM.step === "pin") {
      const roster = (PZ.data?.roster || []).map((r) => ({ name: r.name, keeper: r.keeper, has_pin: r.has_pin !== false }));
      body = (NM.choose ? pvNameField("nmName", roster, "") : '<p class="ask-message">Você é <b>' + escapeHtml(displayName(NM.name)) + "</b></p>") +
        '<p class="pv-label">Seu PIN (4 números)</p>' + pvPinHtml("nmPin") +
        '<p class="pv-hint">O nome que aparece no site muda só depois que o organizador aprovar. Seus números continuam os mesmos.</p>';
      go = '<button type="button" class="lv-btn lv-big lv-green" id="nmGo"' + (NM.busy ? " disabled" : "") + ">Continuar</button>";
    } else if (NM.step === "edit") {
      const limited = (st.limit?.used || 0) >= 2;
      body = (st.rejected ? '<p class="pv-hint pv-warn">Seu pedido de nome foi recusado.</p>' : "") +
        (st.pending ? '<p class="pv-hint">Pedido aguardando aprovação: <b>' + escapeHtml(st.pending) + "</b>" + (st.requested_at ? " (enviado em " + nmDate(st.requested_at) + ")" : "") + ". Um novo pedido substitui esse.</p>" : "") +
        (limited ? '<p class="pv-hint pv-warn">' + escapeHtml(nmLimitText(st.limit)) + "</p>"
          : '<label class="pv-label" for="nmInput">Nome que vai aparecer no site</label><input id="nmInput" class="pv-select nm-input" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + escapeHtml(st.display_name || "") + '">' +
            '<p class="pv-hint">De 2 a 24 caracteres: letras (com acento), números, espaço, ponto e hífen. Até 2 trocas a cada 60 dias.</p>');
      go = limited ? "" : '<button type="button" class="lv-btn lv-big lv-green" id="nmGo"' + (NM.busy ? " disabled" : "") + ">Enviar pedido</button>";
    } else {
      body = '<p class="ask-message">Pedido enviado! O organizador vai aprovar em breve.</p><p class="pv-hint">Até lá, continua aparecendo <b>' + escapeHtml(displayName(NM.name)) + "</b>.</p>";
    }
    dialog.innerHTML = '<header class="lv-sheet-head"><h2 id="nmTitle">✎ Editar meu nome</h2></header><div class="lv-sheet-body">' + body +
      '<p class="pv-msg' + (NM.tone ? " is-" + NM.tone : "") + '" id="nmMsg" role="status" aria-live="polite">' + escapeHtml(NM.msg) + "</p></div>" +
      '<footer class="lv-sheet-foot">' + go + '<button type="button" class="lv-btn lv-white" data-nm-close>' + (NM.step === "done" ? "Fechar" : "Cancelar") + "</button></footer>";
  }
  function nmFail(r, focus) {
    NM.busy = false; NM.msg = r.error === "name_limit" ? nmLimitText(r.limit) : pvError(r); NM.tone = "bad";
    if (r.error === "name_limit" && NM.status) NM.status.limit = r.limit;
    const keepValue = $("nmInput")?.value;
    nmRender();
    if ($("nmInput") && keepValue != null) $("nmInput").value = keepValue;
    if (focus === "pin") { pvPinClear("nmPin"); document.querySelector("#nmPin input")?.focus(); } else $("nmInput")?.focus();
  }
  async function nmSubmit() {
    if (NM.busy) return;
    if (NM.step === "pin") {
      if (NM.choose) NM.name = $("nmName")?.value || "";
      const pin = pvPinValue("nmPin");
      if (!NM.name) { NM.msg = "Escolha seu nome."; NM.tone = "bad"; nmRender(); $("nmName")?.focus(); return; }
      if (!/^\d{4}$/.test(pin)) { NM.msg = "Digite os 4 números do PIN."; NM.tone = "bad"; const n = NM.name; nmRender(); if (NM.choose && $("nmName")) $("nmName").value = n; document.querySelector("#nmPin input")?.focus(); return; }
      NM.busy = true; nmRender();
      const r = await pvRpc("display_name_status", { p_name: NM.name, p_pin: pin });
      if (!r.ok) { const n = NM.name; nmFail(r, "pin"); if (NM.choose && $("nmName")) $("nmName").value = n; return; }
      pvSetMe(r.name);
      Object.assign(NM, { busy: false, step: "edit", pin, status: r, msg: "", tone: "", choose: false, name: r.name });
      nmRender(); $("nmInput")?.focus(); $("nmInput")?.select();
      return;
    }
    if (NM.step !== "edit") return;
    const value = nmClean($("nmInput")?.value);
    if (value.length < 2 || value.length > 24) return nmFail({ error: "name_length" });
    if (!NM_RE.test(value) || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value)) return nmFail({ error: "name_chars" });
    NM.busy = true;
    const r = await pvRpc("request_display_name", { p_name: NM.name, p_pin: NM.pin, p_new: value });
    if (!r.ok) return nmFail(r, r.error === "pin_wrong" || r.error === "locked" ? "pin" : "");
    Object.assign(NM, { busy: false, step: "done", pin: "", msg: "", tone: "" });
    nmRender(); dialogFocus("nmDialog");
  }
  function dialogFocus(id) { $(id)?.querySelector("[data-nm-close]")?.focus(); }
  document.addEventListener("click", (event) => {
    const b = event.target.closest?.("[data-nm-open]");
    if (b) nmOpen(b.dataset.nmOpen);
  });
  // ----- Tela do jogador: votação do craque da noite -----
  function vtNightStats(key) {
    const stats = new Map();
    for (const game of officialGames().filter((g) => nightKeyOf(g) === key))
      for (const p of gamePerformance(game)) {
        const k = pvNorm(p.player), row = stats.get(k) || { goals: 0, conceded: 0, keeper: false, games: 0 };
        row.games++; row.goals += Number(p.goalsFor) || 0;
        if (p.role === "goleiro") { row.keeper = true; row.conceded += Number(p.goalsAgainst) || 0; }
        stats.set(k, row);
      }
    return stats;
  }
  function vtSummary(row) {
    if (!row) return "";
    const parts = [];
    if (row.goals) parts.push(row.goals + (row.goals === 1 ? " gol" : " gols"));
    if (row.keeper) parts.push("goleiro · " + row.conceded + (row.conceded === 1 ? " sofrido" : " sofridos"));
    if (!parts.length) parts.push(row.games + (row.games === 1 ? " jogo" : " jogos"));
    return parts.join(" · ");
  }
  async function vtLoad(silent = false) {
    const data = await pvRpc("vote_get", {});
    if (data && data.round !== undefined) VT.data = data;
    else if (!silent) { VT.msg = pvError(data); VT.tone = "bad"; }
    renderVoting();
  }
  function renderVoting() {
    const box = $("votacao");
    if (!box) return;
    if (!shared || !client) { box.innerHTML = '<div class="pv-wrap"><a class="pv-back" href="./">← Ir para o site</a><article class="pv-card"><p class="pv-kicker">CRAQUE DA NOITE</p><p class="pv-empty">A votação precisa de internet e do banco compartilhado.</p></article></div>'; return; }
    const data = VT.data, round = data?.round;
    if (!box.querySelector(".pv-wrap")) box.innerHTML = '<div class="pv-wrap"><a class="pv-back" href="./">← Ir para o site</a><article class="pv-card vt-card" id="vtCard" aria-live="polite"></article><section class="pv-panel" id="vtForm" aria-labelledby="vtFormTitle"></section></div>';
    if (!data) { $("vtCard").innerHTML = '<p class="pv-kicker">⭐ CRAQUE DA NOITE</p><p class="pv-empty">Carregando…</p>'; return; }
    if (!round) { $("vtCard").innerHTML = '<p class="pv-kicker">⭐ CRAQUE DA NOITE</p><p class="pv-empty">Nenhuma votação aberta agora. Ela abre quando o organizador encerra a noite.</p>'; $("vtForm").innerHTML = ""; return; }
    const parts = round.participants || [], stats = vtNightStats(round.round_key);
    if (!round.open) {
      const results = data.results || [], max = Math.max(1, ...results.map((r) => r.votes)), winner = data.winner?.name;
      $("vtCard").innerHTML = '<p class="pv-kicker">⭐ CRAQUE DA NOITE · ' + escapeHtml(pvDayMonth(round.round_key)) + "</p>" + (winner ? '<p class="vt-winner">' + escapeHtml(displayName(winner)) + '</p><p class="pv-where">' + data.winner.votes + (data.winner.votes === 1 ? " voto" : " votos") + " de " + data.winner.total + (data.winner.total === 1 ? " votante" : " votantes") + "</p>" : '<p class="pv-empty">Votação encerrada sem votos.</p>');
      VT.formSig = "closed:" + round.round_key;
      $("vtForm").innerHTML = '<h2 class="pv-h" id="vtFormTitle">RESULTADO</h2><ol class="vt-bars">' + results.filter((r) => r.votes > 0).map((r) => {
        const c = lvColors(r.team);
        return '<li style="--tb:' + c.bg + ";--tl:" + c.line + '"><span class="vt-bname">' + escapeHtml(displayName(r.name)) + (r.name === winner ? " ⭐" : "") + '</span><span class="vt-btrack"><i style="width:' + (r.votes / max) * 100 + '%"></i></span><b>' + r.votes + "</b></li>";
      }).join("") + "</ol>" + (results.some((r) => r.votes > 0) ? '<p class="pv-hint">Empate: vence quem teve a maior nota média na noite.</p>' : "");
      return;
    }
    const closes = new Date(round.closes_at);
    $("vtCard").innerHTML = '<p class="pv-kicker">⭐ CRAQUE DA NOITE</p><p class="pv-day">' + escapeHtml(pvWeekday(round.round_key)) + '</p><p class="pv-date">' + escapeHtml(pvDayMonth(round.round_key)) + "</p>" +
      '<p class="pv-count"><strong>' + round.voted + " de " + round.eligible + "</strong> já votaram</p>" +
      '<p class="pv-state is-open">Votação aberta até ' + escapeHtml(closes.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " às " + closes.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })) + ". Os votos só aparecem quando fechar.</p>";
    const meRow = parts.find((p) => pvNorm(p.name) === pvNorm(pvMe()));
    const sig = "open:" + round.round_key + ":" + parts.map((p) => p.name + (p.has_pin ? "+" : "-")).join("|") + ":" + (meRow?.name || "");
    if (VT.formSig !== sig) {
      VT.formSig = sig;
      const blocked = meRow && !meRow.has_pin;
      const who = meRow && meRow.has_pin ? pvMeBlock("vtName", meRow.name, "vt")
        : blocked ? pvMeBlock("vtNameNo", meRow.name, "vt") + '<p class="pv-hint pv-warn">Você ainda não tem PIN. Peça seu link pessoal ao organizador para criar e votar.</p>'
        : pvNameField("vtName", parts.map((p) => ({ name: p.name, keeper: false, has_pin: p.has_pin !== false })), "");
      $("vtForm").innerHTML = '<h2 class="pv-h" id="vtFormTitle">Vote no craque da noite</h2><p class="pv-hint">Só vota quem jogou nessa noite. Cada um vota uma vez: depois de votar, não dá para trocar.</p>' + who +
        (blocked ? "" : '<p class="pv-label">PIN (4 números)</p>' + pvPinHtml("vtPin") + (meRow ? "" : '<p class="pv-hint">Primeira vez? Peça seu link pessoal ao organizador para criar o PIN.</p>')) +
        '<div' + (blocked ? " hidden" : "") + '><p class="pv-label" id="vtCandLabel">Quem foi o craque?</p><div class="vt-cands" id="vtCands" role="radiogroup" aria-labelledby="vtCandLabel"></div>' +
        '<button type="button" class="pv-btn pv-green vt-submit" id="vtSubmit" disabled>Escolha um jogador</button></div><p class="pv-msg" id="vtMsg" role="status" aria-live="polite"></p>' +
        '<div class="pv-share"><a class="pv-btn pv-wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent("⭐ Votação do *CRAQUE DA NOITE* da Skalama aberta! Vote com seu nome e PIN:\n" + location.origin + "/#votacao") + '">Compartilhar no WhatsApp</a></div>';
    }
    const voter = pvNorm($("vtName")?.value || "");
    if (VT.cand && pvNorm(VT.cand) === voter) VT.cand = "";
    $("vtCands").innerHTML = parts.filter((p) => pvNorm(p.name) !== voter).map((p) => {
      const c = lvColors(p.team), on = VT.cand === p.name, crest = crestFor(p.team, p.label);
      return '<button type="button" class="vt-cand' + (on ? " is-on" : "") + '" role="radio" aria-checked="' + on + '" data-vt-cand="' + escapeHtml(p.name) + '" style="--tb:' + c.bg + ";--ti:" + c.ink + ";--tl:" + c.line + '">' +
        '<span class="vt-crest">' + (crest ? '<img src="' + escapeHtml(crest) + '" alt="">' : "") + '</span><span class="vt-ctext"><strong>' + escapeHtml(displayName(p.name)) + "</strong><small>" + escapeHtml([teamDisplayName(p.label) || teamLabel(p.team), vtSummary(stats.get(pvNorm(p.name)))].filter(Boolean).join(" · ")) + "</small></span>" + (on ? '<span class="vt-check" aria-hidden="true">✓</span>' : "") + "</button>";
    }).join("");
    const submit = $("vtSubmit");
    submit.disabled = !VT.cand || VT.busy;
    submit.textContent = VT.cand ? "✓ Votar em " + displayName(VT.cand) : "Escolha um jogador";
    $("vtMsg").textContent = VT.msg; $("vtMsg").className = "pv-msg" + (VT.tone ? " is-" + VT.tone : "");
  }
  async function vtSubmit() {
    const round = VT.data?.round, name = $("vtName")?.value || "", pin = pvPinValue("vtPin");
    if (!round || !VT.cand) return;
    if (!name) { VT.msg = "Escolha seu nome."; VT.tone = "bad"; renderVoting(); $("vtName")?.focus(); return; }
    if (!/^\d{4}$/.test(pin)) { VT.msg = "Digite os 4 números do PIN."; VT.tone = "bad"; renderVoting(); document.querySelector("#vtPin input")?.focus(); return; }
    if (!(await askConfirm({ title: "Votar em " + displayName(VT.cand) + "?", message: "Depois de confirmar, o voto não pode ser trocado.", confirmText: "Confirmar voto", tone: "green" }))) return;
    VT.busy = true; renderVoting();
    const r = await pvRpc("vote_cast", { p_key: round.round_key, p_voter: name, p_pin: pin, p_candidate: VT.cand });
    VT.busy = false;
    if (r.ok) { pvSetMe(name); pvPinClear("vtPin"); VT.data = r.view || VT.data; VT.msg = (r.created ? "PIN criado! Guarde esses 4 números. " : "") + "✓ Voto registrado em " + displayName(r.mine) + ". Obrigado! O resultado sai quando a votação fechar."; VT.tone = "good"; }
    else { VT.msg = pvError(r); VT.tone = "bad"; if (r.error === "pin_wrong" || r.error === "locked") pvPinClear("vtPin"); }
    renderVoting();
  }
  document.addEventListener("click", (event) => {
    const go = event.target.closest?.("[data-pz-go]");
    if (go && !go.disabled) { pzSubmit(go.dataset.pzGo === "1"); return; }
    if (event.target.closest?.("#pzInviteGo")) { pzInviteSubmit(); return; }
    const sw = event.target.closest?.("[data-pv-switch]");
    if (sw) {
      pvForgetMe();
      if (sw.dataset.pvSwitch === "pz") { PZ.formSig = ""; PZ.msg = ""; renderPresence(); $("pzName")?.focus(); }
      else { VT.formSig = ""; VT.msg = ""; VT.cand = ""; renderVoting(); $("vtName")?.focus(); }
      return;
    }
    const cand = event.target.closest?.("[data-vt-cand]");
    if (cand) { VT.cand = cand.dataset.vtCand; renderVoting(); $("vtCands")?.querySelector('[data-vt-cand="' + CSS.escape(VT.cand) + '"]')?.focus(); return; }
    if (event.target.closest?.("#vtSubmit")) vtSubmit();
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "pzName") { renderPresence(); }
    if (event.target.id === "vtName") { renderVoting(); }
  });
  // ----- Rotas próprias: #presenca e #votacao abrem só essa tela -----
  const PV_VIEWS = { "#presenca": "presenca", "#votacao": "votacao", "#hall": "hall", "#cartas": "cartas" };
  const PV_INVITE_RE = /^#presenca\/([A-Za-z0-9_-]{20,64})$/;
  function pvRoute() {
    const invite = location.hash.match(PV_INVITE_RE);
    const view = invite ? "presenca" : PV_VIEWS[location.hash];
    if (!invite) PZ.invite = null;
    document.body.classList.toggle("pv-standalone", !!view);
    clearInterval(PZ.timer); clearInterval(VT.timer);
    if (!view) return false;
    setView(view);
    window.scrollTo(0, 0);
    if (invite) pzInviteOpen(invite[1]);
    else if (view === "presenca") { renderPresence(); pzLoad(); PZ.timer = setInterval(() => { if (!document.hidden) pzLoad(true); }, 10000); }
    else if (view === "votacao") { renderVoting(); vtLoad(); VT.timer = setInterval(() => { if (!document.hidden) vtLoad(true); }, 10000); }
    else if (view === "cartas") cardsOpen();
    else hallOpen();
    return true;
  }
  window.addEventListener("hashchange", () => {
    if (/^#jogador\//.test(location.hash)) return;
    if (location.hash !== "#cartas") cardsUnmount();
    const was = document.body.classList.contains("pv-standalone");
    if (!pvRoute() && was) setView("home");
  });
  // ----- Organizador: lista de presença no passo "Quem vai jogar" -----
  async function pzaLoad() {
    const key = state.matchDate || "";
    if (!key || !shared || !canManageShared) return;
    PZA.key = key; PZA.at = Date.now();
    const [data, access, names] = await Promise.all([pvRpc("presence_get", { p_round: key }), pvRpc("player_access_admin_list"), pvRpc("display_name_admin_list")]);
    if (data && data.round !== undefined) PZA.data = data;
    if (access?.ok) { PZA.access = access; pzaCheckNewPins(access); }
    if (names?.ok) PZA.names = names;
    renderElPresence();
  }
  // ✕ desenhado (não depende da fonte do aparelho, que às vezes pinta o símbolo como emoji colorido).
  const PZA_X_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  // Cabeçalho preto da lista (painel do organizador e lista pública da aba Modo Liga).
  function pzaHeadHtml(key, round, confirmed, waiting, tag) {
    const d = pvDate(key), dayName = d ? d.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0] : "";
    const time = round ? round.start_time : pzaTime(), past = (pzaClosesMs(key, time) ?? Infinity) <= nowMs();
    const full = !!round && confirmed.length >= round.slots;
    const keepers = confirmed.filter((p) => p.keeper).length, left = round ? Math.max(0, round.slots - confirmed.length) : 0;
    const status = !round ? "" : !round.open ? '<span class="pza-st is-full">FECHADA</span>' : full ? '<span class="pza-st is-full">LISTA COMPLETA</span>' : '<span class="pza-st is-open">ABERTA</span>';
    return '<div class="pza-top"><div class="pza-hrow"><' + tag + ' class="pza-kick">📋 LISTA DE PRESENÇA</' + tag + ">" + status + "</div>" +
      '<p class="pza-when">' + escapeHtml(dayName.replace(/^./, (c) => c.toUpperCase()) + ", " + pvDayMonth(key)) + "<small>" + escapeHtml([time ? (past ? "Fechou às " : "Fecha às ") + time : "Sem horário definido", (round?.venue || state.venue || "").trim()].filter(Boolean).join(" · ")) + "</small></p>" +
      (round ? '<div class="pza-count"><b>' + confirmed.length + "<span>/" + round.slots + "</span></b><p><strong>" + (confirmed.length - keepers) + " de linha</strong> · " + keepers + (keepers === 1 ? " goleiro" : " goleiros") + "<br>" + (left ? left + (left === 1 ? " vaga" : " vagas") : "Sem vagas") + (waiting.length ? " · " + waiting.length + " na espera" : "") + "</p></div>" +
        '<div class="pza-meter" role="progressbar" aria-label="Vagas preenchidas" aria-valuemin="0" aria-valuemax="' + round.slots + '" aria-valuenow="' + Math.min(confirmed.length, round.slots) + '"><i style="width:' + Math.min(100, (confirmed.length / round.slots) * 100) + '%"></i></div>' : "") + "</div>";
  }
  function renderElPresence() {
    const box = $("elPresence");
    if (!box) return;
    if (!shared || !canManageShared) { box.innerHTML = '<p class="pv-hint">A lista de presença pelo link funciona com o banco compartilhado (entre como organizador).</p>'; return; }
    const key = state.matchDate;
    if (!key) { box.innerHTML = '<p class="pv-hint">Defina a data do jogo em <b>Dados do jogo</b> para abrir a lista de presença pelo link.</p>'; return; }
    if (PZA.key !== key || Date.now() - PZA.at > 10000) { if (!PZA.busy) { PZA.busy = true; pzaLoad().finally(() => { PZA.busy = false; }); } }
    const data = PZA.key === key ? PZA.data : null, round = data?.round && data.round.round_key === key ? data.round : null, players = round ? data.players : [], roster = data?.roster || [];
    const confirmed = players.filter((p) => p.status === "in"), waiting = players.filter((p) => p.status === "wait"), listed = new Set(players.map((p) => pvNorm(p.name)));
    // Vagas do + e −: seguem a lista gravada, a não ser que haja uma mudança esperando para salvar.
    if (PZA.slotsKey !== key) { PZA.slotsKey = key; PZA.slots = round ? round.slots : 20; PZA.slotState = ""; }
    else if (round && !PZA.slotTimer && PZA.slotState !== "saving") PZA.slots = round.slots;
    const slots = PZA.slots, full = !!round && confirmed.length >= round.slots, freeSlot = !!round && confirmed.length < round.slots;
    // Confirmar sem PIN: todo o Elenco (ativos e inativos: a presença é que decide quem fica ativo) fora dos confirmados e da espera.
    const manual = roster.filter((r) => !listed.has(pvNorm(r.name))).sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), "pt-BR"));
    const card = (p, i, wait) => {
      const nm = escapeHtml(displayName(p.name)), sub = wait ? (i === 0 ? "próximo a entrar" : "espera nº " + (i + 1)) : p.source === "organizador" ? "confirmado pelo organizador" : "";
      return '<li class="pza-card ' + (wait ? "is-wait" : "is-ok") + (p.keeper ? " is-keeper" : "") + '"><span class="pza-n">' + (i + 1) + '</span><span class="pza-nm"><span class="pza-nm-t">' + nm + "</span>" + (sub ? "<small>" + sub + "</small>" : "") + "</span>" +
        (p.keeper ? '<b class="pza-gk" title="Goleiro" aria-label="goleiro">G</b>' : "") +
        (wait && freeSlot ? '<button type="button" class="pza-up" data-pza-up="' + escapeHtml(p.name) + '" aria-label="Subir ' + nm + ' para os confirmados">Subir</button>' : "") +
        '<button type="button" class="pza-x" data-pza-remove="' + escapeHtml(p.name) + '" data-pza-wait="' + (wait ? "1" : "") + '" aria-label="Tirar ' + nm + (wait ? " da lista de espera" : " da lista") + '">' + PZA_X_ICON + "</button></li>";
    };
    const stepper = '<div class="pza-vagas"><span class="pza-vagas-l" id="pzaSlotsLabel">Vagas<small>Limite da lista</small></span><div class="pza-step" role="group" aria-labelledby="pzaSlotsLabel">' +
      '<button type="button" data-pza-step="-1" aria-label="Diminuir vagas"' + (slots <= 2 ? " disabled" : "") + '>−</button><output id="pzaSlots" aria-live="polite">' + slots + '</output><button type="button" data-pza-step="1" aria-label="Aumentar vagas"' + (slots >= 40 ? " disabled" : "") + ">+</button></div>" +
      '<span class="pza-saved" id="pzaSaved" role="status">' + (PZA.slotState === "saving" ? "Salvando…" : PZA.slotState === "saved" ? "Salvo ✓" : "") + "</span></div>";
    const sig = JSON.stringify([key, round, players, roster.map((r) => r.name + (r.has_pin ? "+" : "-")), manual.map((r) => r.name), slots, PZA.slotState, PZA.access?.players, [...PZA.links.keys()], PZA.alerts, PZA.names, [...DN.map]]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const focusKey = document.activeElement && box.contains(document.activeElement) ? ["data-pza-step", "data-pza", "data-pza-up", "data-pza-remove"].map((a) => document.activeElement.getAttribute(a) !== null && "[" + a + '="' + CSS.escape(document.activeElement.getAttribute(a)) + '"]').find(Boolean) : "";
    const head = pzaHeadHtml(key, round, confirmed, waiting, "h4");
    const names = PZA.names?.pending?.length ? '<p class="pza-namesreq"><span class="pza-state nm-count">✎ ' + PZA.names.pending.length + (PZA.names.pending.length === 1 ? " pedido de nome" : " pedidos de nome") + "</span></p>" : "";
    box.innerHTML = '<div class="pza">' + head + names + pzaAlertsHtml() +
      (!data ? '<p class="pv-hint pza-pad">Carregando…</p>' : !round
        ? '<div class="pza-acts"><p class="pv-hint pza-span">Os jogadores confirmam pelo link <b>' + escapeHtml(PV_LINK.replace("https://", "")) + '</b> com nome e PIN. A lista fecha sozinha no horário do jogo.</p>' + stepper + '<button type="button" class="pza-btn is-green pza-span" data-pza="open">Abrir lista</button></div>'
        : '<div class="pza-acts">' + stepper +
          '<button type="button" class="pza-btn is-black" data-pza="invite">📋 Copiar convite</button>' +
          (round.open ? '<button type="button" class="pza-btn is-red" data-pza="close">🔒 Fechar lista</button>' : '<button type="button" class="pza-btn is-green" data-pza="reopen">🔓 Reabrir lista</button>') + "</div>" +
          '<div class="pza-sec"><p class="pza-legend"><span><i></i>Confirmado</span><span><i class="is-wait"></i>Lista de espera</span></p>' +
          '<div class="pza-sh"><h5>Confirmados</h5><span class="pza-tag is-ok">' + confirmed.length + " de " + round.slots + "</span></div>" +
          (confirmed.length ? '<ol class="pza-cards">' + confirmed.map((p, i) => card(p, i, false)).join("") + "</ol>" : '<p class="pv-hint">Ninguém ainda.</p>') +
          (waiting.length ? '<div class="pza-waitsec"><div class="pza-sh"><h5>Lista de espera</h5><span class="pza-tag is-wait">' + waiting.length + ' na espera</span></div><p class="pv-hint">Se alguém sair, o primeiro da espera entra sozinho e recebe aviso.</p><ol class="pza-cards">' + waiting.map((p, i) => card(p, i, true)).join("") + "</ol></div>" : "") +
          '<div class="pza-manual">' + (manual.length ? '<label for="pzaAdd">Confirmar sem PIN</label>' : '<p class="pza-manual-t">Confirmar sem PIN</p>') + '<p>Para quem não tem celular ou não lembra o PIN.</p><div class="pza-mrow">' +
          (manual.length ? '<select id="pzaAdd"><option value="">Escolha o jogador</option>' + manual.map((r) => '<option value="' + escapeHtml(r.name) + '">' + escapeHtml(displayName(r.name)) + (r.keeper ? " · goleiro" : "") + "</option>").join("") + "</select>"
            : '<p class="pza-allin" role="status">Todos do Elenco já estão na lista</p>') +
          '<button type="button" class="pza-btn is-outline" data-pza="add"' + (manual.length ? "" : " disabled") + ">Confirmar</button></div>" +
          (full ? '<p class="pza-fullnote">Lista completa: quem você confirmar agora entra na lista de espera.</p>' : "") + "</div></div>" +
          '<div class="pza-bar"><button type="button" class="pza-btn is-green" data-pza="use"' + (confirmed.length ? "" : " disabled") + ">✓ Usar a lista no Elenco · " + confirmed.length + (confirmed.length === 1 ? " vai jogar" : " vão jogar") + "</button></div>") +
      '<p class="pv-msg pza-pad" id="pzaMsg" role="status" aria-live="polite"></p>' + (data ? '<div class="pza-extra">' + nmaPendingHtml() + pzaAccessHtml() + "</div>" : "") + "</div>";
    if (focusKey) box.querySelector(focusKey)?.focus();
  }
  function pzaMsg(text, tone = "") { const el = $("pzaMsg"); if (el) { el.textContent = text; el.className = "pv-msg" + (tone ? " is-" + tone : ""); } if (text) notify(text, tone === "bad"); }
  // ----- Acesso dos jogadores: link pessoal de primeiro acesso (o único jeito de criar PIN) -----
  const PZA_SEEN_KEY = "skalama-pin-seen";
  const pzaInviteLink = (token) => PV_LINK + "/" + token;
  const pzaInviteText = (name, token) => "Fala, " + displayName(name) + "! Esse é seu link pessoal da lista da Skalama. Abra e crie seu PIN de 4 números (não passe esse link pra ninguém): " + pzaInviteLink(token);
  // PIN criado desde a última vez que o organizador viu: alerta no painel (para perceber se foi alguém indevido).
  function pzaCheckNewPins(access) {
    let seen = "";
    try { seen = localStorage.getItem(PZA_SEEN_KEY) || ""; } catch {}
    if (!seen) { try { localStorage.setItem(PZA_SEEN_KEY, access.now); } catch {} return; } // primeira vez neste aparelho: só marca
    const fresh = (access.players || []).filter((p) => p.pin_created_at && Date.parse(p.pin_created_at) > Date.parse(seen))
      .sort((a, b) => Date.parse(a.pin_created_at) - Date.parse(b.pin_created_at));
    PZA.alerts = fresh.map((p) => ({ name: p.name, at: p.pin_created_at }));
    for (const p of fresh) {
      const k = p.name + "|" + p.pin_created_at;
      if (!PZA.alerted.has(k)) { PZA.alerted.add(k); notify(displayName(p.name) + " criou o PIN agora."); }
    }
  }
  function pzaAlertsHtml() {
    if (!PZA.alerts.length) return "";
    const when = (at) => (nowMs() - Date.parse(at) < 5 * 60000 ? "agora" : "em " + new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }));
    return '<div class="pza-alert" role="status"><ul>' + PZA.alerts.map((a) => "<li>🔔 <b>" + escapeHtml(displayName(a.name)) + "</b> criou o PIN " + when(a.at) + ".</li>").join("") + "</ul>" +
      '<p class="pv-hint">Não foi ele? Use “Resetar acesso” em Acesso dos jogadores.</p><button type="button" class="button button-outline" data-pza="alerts-ok">Entendi</button></div>';
  }
  const PZA_ACC_LABEL = { pin: "Com PIN ✓", invite: "Link enviado (não usado)", expired: "Sem acesso (link venceu)", none: "Sem acesso" };
  function pzaAccessHtml() {
    const list = PZA.access?.players;
    if (!list) return '<details class="pza-acc"><summary>ACESSO DOS JOGADORES</summary><p class="pv-hint">Carregando…</p></details>';
    const withPin = list.filter((p) => p.status === "pin").length;
    const row = (p) => {
      const link = PZA.links.get(p.name);
      const btn = p.status === "pin" ? '<button type="button" class="button button-outline" data-pza-acc="reset" data-name="' + escapeHtml(p.name) + '">Resetar acesso</button>'
        : '<button type="button" class="button button-outline" data-pza-acc="gen" data-name="' + escapeHtml(p.name) + '">' + (p.status === "invite" ? "Gerar novo link" : "Gerar link") + "</button>";
      const shown = displayName(p.name), renamed = pvNorm(shown) !== pvNorm(p.name);
      return '<li class="pza-acc-item"><div class="pza-acc-main"><span class="pv-name">' + escapeHtml(shown) + (renamed ? ' <small class="nm-orig">(' + escapeHtml(baseName(p.name)) + ")</small>" : "") + pvKeeperBadge(p.keeper) + "</span>" +
        '<span class="pza-acc-st is-' + p.status + '">' + PZA_ACC_LABEL[p.status] + (p.locked ? " · bloqueado 15 min" : "") + "</span>" + btn +
        '<button type="button" class="button button-outline" data-nma-edit="' + escapeHtml(p.name) + '">✎ Nome</button></div>' +
        (link ? '<div class="pza-link"><code>' + escapeHtml(pzaInviteLink(link.token)) + '</code><button type="button" class="lv-btn lv-black pza-copy" data-pza-msg="' + escapeHtml(p.name) + '">' + PZA_COPY_ICON + "Copiar mensagem</button></div>" : "") + "</li>";
    };
    return '<details class="pza-acc"' + (PZA.accOpen ? " open" : "") + '><summary>ACESSO DOS JOGADORES · ' + withPin + " com PIN · " + (list.length - withPin) + " sem</summary>" +
      '<p class="pv-hint">Quem não tem PIN só cria pelo <b>link pessoal</b> (vale 30 dias e uma vez). Mande no privado de cada um, nunca no grupo. O link aparece só na hora em que é gerado.</p>' +
      '<div class="pza-row"><button type="button" class="button button-primary" data-pza="links-all">Gerar links para todos sem PIN</button></div>' +
      '<ul class="pza-acc-list">' + list.map(row).join("") + "</ul></details>";
  }
  async function pzaAccess(kind, name) {
    if (kind === "reset") {
      const ok = await askConfirm({ title: "Resetar acesso de " + displayName(name) + "?", message: "O PIN atual deixa de valer e sai um link pessoal novo para ele criar outro. Mande o link só no privado dele.", confirmText: "Resetar acesso", tone: "red" });
      if (!ok) return;
    }
    const r = await pvRpc(kind === "reset" ? "player_access_admin_reset" : "invite_admin_create", { p_name: name });
    if (!r.ok) { pzaMsg(pvError(r), "bad"); return; }
    (r.links || []).forEach((l) => PZA.links.set(l.name, l));
    PZA.accOpen = true;
    await pzaLoad();
    pzaMsg((kind === "reset" ? "Acesso de " + displayName(name) + " resetado. " : "Link de " + displayName(name) + " gerado. ") + "Toque em “Copiar mensagem” e mande no privado.");
    document.querySelector('[data-pza-msg="' + CSS.escape(name) + '"]')?.focus();
  }
  async function pzaSendInvite(name) {
    const link = PZA.links.get(name);
    if (!link) return;
    const text = pzaInviteText(name, link.token);
    // No celular, abre o compartilhar do aparelho (WhatsApp etc.); no PC, copia.
    if (navigator.share && window.matchMedia?.("(pointer: coarse)").matches) {
      try { await navigator.share({ text }); return; } catch (error) { if (error?.name === "AbortError") return; }
    }
    let copied = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch {}
    if (!copied) copied = pzaCopyLegacy(text);
    if (copied) pzaMsg("Mensagem copiada! Mande no privado de " + displayName(name) + ".");
    else pzaCopyDialog(text, "Copie a mensagem de " + displayName(name));
  }
  document.addEventListener("click", (event) => {
    const acc = event.target.closest?.("#elPresence [data-pza-acc]");
    if (acc) { pzaAccess(acc.dataset.pzaAcc, acc.dataset.name); return; }
    const msg = event.target.closest?.("#elPresence [data-pza-msg]");
    if (msg) pzaSendInvite(msg.dataset.pzaMsg);
  });
  document.addEventListener("toggle", (event) => { if (event.target.matches?.("#elPresence .pza-acc")) PZA.accOpen = event.target.open; }, true);
  // ----- Organizador: pedidos de troca de nome, edição direta e histórico -----
  function nmaPendingHtml() {
    const list = PZA.names?.pending || [];
    if (!list.length) return "";
    return '<section class="nma-pending" aria-labelledby="nmaTitle"><h5 id="nmaTitle">PEDIDOS DE TROCA DE NOME (' + list.length + ")</h5><ul>" + list.map((p) =>
      '<li><p class="nma-change"><span>' + escapeHtml(p.display_name) + '</span> <b aria-hidden="true">→</b><span class="sr-only"> para </span> <strong>' + escapeHtml(p.requested) + "</strong></p>" +
      '<p class="pv-hint">' + (pvNorm(p.display_name) !== pvNorm(p.name) ? "Nome original: " + escapeHtml(baseName(p.name)) + " · " : "") + "pedido em " + escapeHtml(new Date(p.requested_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })) +
      (p.limit?.used ? " · " + p.limit.used + " de 2 trocas nos últimos 60 dias" : "") + "</p>" +
      '<div class="nma-actions"><button type="button" class="lv-btn lv-green" data-nma-approve="' + escapeHtml(p.name) + '">Aprovar</button><button type="button" class="lv-btn lv-white" data-nma-reject="' + escapeHtml(p.name) + '">Recusar</button></div></li>').join("") + "</ul></section>";
  }
  // Depois de mudar um nome: recarrega os nomes, redesenha e avisa os outros aparelhos (eles buscam na hora).
  async function nmaAfterChange(message) {
    await loadDisplayNames(true);
    await pzaLoad();
    renderAll();
    stateChannel?.send({ type: "broadcast", event: "state", payload: { at: nowMs() } }).catch?.(() => {});
    pzaMsg(message);
  }
  async function nmaDecide(name, approve) {
    const p = (PZA.names?.pending || []).find((x) => x.name === name);
    if (!p) return;
    const ok = await askConfirm(approve
      ? { title: "Aprovar novo nome?", message: p.display_name + " passa a aparecer como " + p.requested + " no site inteiro, inclusive nos jogos antigos. Os números não mudam.", confirmText: "Aprovar", tone: "green" }
      : { title: "Recusar pedido de nome?", message: "Continua aparecendo " + p.display_name + ". O jogador vê o aviso de recusa na próxima vez que abrir com o PIN.", confirmText: "Recusar", tone: "red" });
    if (!ok) return;
    const r = await pvRpc(approve ? "display_name_admin_approve" : "display_name_admin_reject", { p_name: name });
    if (!r.ok) { pzaMsg(r.error === "name_limit" ? "Esse jogador já trocou 2 vezes nos últimos 60 dias (libera em " + nmDate(r.limit?.next_at) + ")." : pvError(r), "bad"); await pzaLoad(); return; }
    await nmaAfterChange(approve ? "Nome aprovado: agora aparece " + p.requested + "." : "Pedido de " + p.display_name + " recusado.");
  }
  function nmaDialog(name) {
    let dialog = $("nmaDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "nmaDialog";
      dialog.className = "lv-sheet ask-sheet nm-sheet";
      dialog.setAttribute("aria-labelledby", "nmaDlgTitle");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog || event.target.closest("[data-nma-close]")) { dialog.close(); return; }
        const b = event.target.closest("[data-nma-save]");
        if (b) nmaSave(dialog.dataset.name, b.dataset.nmaSave === "original");
      });
      dialog.addEventListener("input", (event) => { if (event.target.id === "nmaInput") { const pos = event.target.selectionStart; event.target.value = event.target.value.toLocaleUpperCase("pt-BR"); try { event.target.setSelectionRange(pos, pos); } catch {} } });
      dialog.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.id === "nmaInput") { event.preventDefault(); nmaSave(dialog.dataset.name, false); } });
    }
    const shown = displayName(name), renamed = pvNorm(shown) !== pvNorm(name);
    const hist = (PZA.names?.history || []).filter((h) => h.name === name);
    dialog.dataset.name = name;
    dialog.innerHTML = '<header class="lv-sheet-head"><h2 id="nmaDlgTitle">Nome de ' + escapeHtml(shown) + '</h2></header><div class="lv-sheet-body">' +
      '<p class="pv-hint">Nome original (chave das estatísticas, não muda): <b>' + escapeHtml(baseName(name)) + "</b></p>" +
      '<label class="pv-label" for="nmaInput">Nome que aparece no site</label><input id="nmaInput" class="pv-select nm-input" maxlength="24" autocomplete="off" autocapitalize="characters" spellcheck="false" value="' + escapeHtml(shown) + '">' +
      '<p class="pv-hint">Edição do organizador: sem limite e não conta nas 2 trocas do jogador.</p>' +
      '<p class="pv-msg" id="nmaMsg" role="status" aria-live="polite"></p>' +
      '<h3 class="nma-hist-title">Histórico de trocas</h3>' + (hist.length ? '<ul class="nma-hist">' + hist.map((h) => "<li><span>" + escapeHtml(h.old) + " → <b>" + escapeHtml(h.new) + "</b></span><small>" + escapeHtml(new Date(h.at).toLocaleDateString("pt-BR")) + " · " + (h.by_organizer ? "organizador" : "pedido do jogador") + "</small></li>").join("") + "</ul>" : '<p class="pv-hint">Nenhuma troca ainda.</p>') +
      '</div><footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-big lv-green" data-nma-save="set">Salvar nome</button>' +
      (renamed ? '<button type="button" class="lv-btn lv-white" data-nma-save="original">Voltar ao original (' + escapeHtml(baseName(name)) + ")</button>" : "") +
      '<button type="button" class="lv-btn lv-white" data-nma-close>Cancelar</button></footer>';
    try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    $("nmaInput")?.focus();
  }
  async function nmaSave(name, original) {
    const value = original ? "" : nmClean($("nmaInput")?.value);
    const show = (text) => { const el = $("nmaMsg"); if (el) { el.textContent = text; el.className = "pv-msg is-bad"; } };
    if (!original) {
      if (value.length < 2 || value.length > 24) return show(pvError({ error: "name_length" }));
      if (!NM_RE.test(value) || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(value)) return show(pvError({ error: "name_chars" }));
    }
    const r = await pvRpc("display_name_admin_set", { p_name: name, p_display: value || null });
    if (!r.ok) return show(pvError(r));
    $("nmaDialog")?.close();
    await nmaAfterChange(original ? baseName(name) + " voltou ao nome original." : baseName(name) + " agora aparece como " + r.display_name + ".");
  }
  document.addEventListener("click", (event) => {
    const a = event.target.closest?.("#elPresence [data-nma-approve]");
    if (a) { nmaDecide(a.dataset.nmaApprove, true); return; }
    const x = event.target.closest?.("#elPresence [data-nma-reject]");
    if (x) { nmaDecide(x.dataset.nmaReject, false); return; }
    const e = event.target.closest?.("#elPresence [data-nma-edit]");
    if (e) nmaDialog(e.dataset.nmaEdit);
  });
  const PZA_COPY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  // Navegador sem a API de área de transferência: tenta o jeito antigo (execCommand).
  function pzaCopyLegacy(text) {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    area.remove();
    return ok;
  }
  // Não deu para copiar: janela com o convite já selecionado para copiar na mão.
  function pzaCopyDialog(text, title = "Copie o convite") {
    let dialog = $("pzaCopyDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "pzaCopyDialog";
      dialog.className = "lv-sheet ask-sheet";
      dialog.setAttribute("aria-labelledby", "pzaCopyTitle");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", (event) => { if (event.target === dialog || event.target.closest("[data-pza-copy-close]")) dialog.close(); });
    }
    const back = document.activeElement;
    dialog.innerHTML = '<header class="lv-sheet-head"><h2 id="pzaCopyTitle">' + escapeHtml(title) + '</h2></header><div class="lv-sheet-body"><p class="ask-message">O navegador não deixou copiar sozinho. O texto já está selecionado: segure em cima dele e toque em <b>Copiar</b> (no PC, Ctrl+C).</p>' +
      '<label class="pza-copy-label" for="pzaCopyText">Texto</label><textarea id="pzaCopyText" class="pza-copy-text" readonly rows="9"></textarea></div>' +
      '<footer class="lv-sheet-foot"><button type="button" class="lv-btn lv-white" data-pza-copy-close>Fechar</button></footer>';
    const area = dialog.querySelector("textarea");
    area.value = text;
    dialog.addEventListener("close", () => { if (back && document.contains(back)) back.focus?.(); }, { once: true });
    try { dialog.showModal(); } catch { dialog.setAttribute("open", ""); }
    area.focus(); area.select(); try { area.setSelectionRange(0, text.length); } catch {}
  }
  // Horário do jogo em Dados do jogo (o mesmo que o banco usa para fechar a lista).
  const pzaTime = () => (/^\d{2}:\d{2}$/.test(state.startTime || "") ? state.startTime : null);
  // Quando a lista fecha: data + horário em Brasília (UTC-3, sem horário de verão). Sem horário, conta o fim do dia.
  function pzaClosesMs(key, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return null;
    const ms = Date.parse(key + "T" + (/^\d{2}:\d{2}/.test(time || "") ? time.slice(0, 5) : "23:59") + ":00-03:00");
    return Number.isFinite(ms) ? ms : null;
  }
  // "Rodada de segunda, 23/11 · fecha às 20:30"
  function pzaRoundLabel(key, time) {
    const d = pvDate(key);
    if (!d) return "";
    const day = d.toLocaleDateString("pt-BR", { weekday: "long" }).split("-")[0];
    const t = /^\d{2}:\d{2}/.test(time || "") ? time.slice(0, 5) : "";
    const past = (pzaClosesMs(key, t) ?? Infinity) <= nowMs();
    return "Rodada de " + day + ", " + pvDayMonth(key) + " · " + (t ? (past ? "fechou às " : "fecha às ") + t : "sem horário definido");
  }
  function pzaGoToDate() {
    const input = $("matchDate");
    if (!input) return;
    setTimeout(() => {
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      try { input.focus({ preventScroll: true }); } catch { input.focus(); }
    }, 60);
  }
  // Data/horário mudou em Dados do jogo: a lista acompanha. A rodada anterior fica como estava (outra round_key);
  // a nova data ganha a sua lista com as mesmas vagas. No mesmo dia, só o horário (closes_at) muda.
  async function pzaSyncRound(prevKey, prevTime) {
    if (!shared || !canManageShared) return;
    const key = state.matchDate || "", time = pzaTime();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || (key === prevKey && time === prevTime)) return;
    const get = async (k) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k || "")) return null;
      const d = await pvRpc("presence_get", { p_round: k });
      return d?.round && d.round.round_key === k ? d.round : null;
    };
    const cur = await get(key), prev = !cur && prevKey !== key ? await get(prevKey) : null, base = cur || prev;
    if (!base) return;
    const closedByTime = !!base.closes_at && Date.parse(base.closes_at) <= nowMs();
    const open = cur ? cur.open || closedByTime : true;
    const r = await pvRpc("presence_admin_round", { p_round: key, p_start: time, p_venue: String(state.venue || "").slice(0, 120) || null, p_slots: base.slots, p_open: open });
    if (!r.ok) { pzaMsg("A lista de presença não acompanhou a nova data: " + pvError(r), "bad"); return; }
    if (state.matchDate !== key) return;
    PZA.data = r.view; PZA.key = key; PZA.at = Date.now();
    if ($("elPresence")) $("elPresence").dataset.sig = "";
    renderElPresence();
    const nowOpen = !!r.view?.round?.open;
    pzaMsg(cur ? (nowOpen ? "Lista de presença atualizada: fecha às " + (time || "—") + "." : "Horário da lista atualizado.") : nowOpen ? "Lista da rodada de " + pvDayMonth(key) + " aberta. Mande o convite no grupo." : "Lista da rodada de " + pvDayMonth(key) + " criada (fechada: o horário já passou).", !cur && !nowOpen ? "bad" : "");
  }
  async function pzaAction(kind) {
    const key = state.matchDate, round = PZA.data?.round;
    const after = (r, ok, mustOpen = false) => {
      if (!r.ok) { pzaMsg(pvError(r), "bad"); return; }
      if (r.view) { PZA.data = r.view; PZA.at = Date.now(); }
      $("elPresence").dataset.sig = ""; renderElPresence();
      // Só diz que abriu se a lista realmente ficou aberta depois de gravar.
      if (mustOpen && !r.view?.round?.open) pzaMsg("A lista continua fechada: o horário do jogo já passou. Atualize a data em Dados do jogo.", "bad");
      else pzaMsg(ok);
    };
    if (kind === "open" || kind === "reopen") {
      const time = pzaTime(), closes = pzaClosesMs(key, time);
      if (closes !== null && closes <= nowMs()) {
        const go = await askConfirm({ title: "A data do jogo já passou", message: "A data do jogo (" + pvDayMonth(key) + (time ? ", " + time : "") + ") já passou. Atualize a data em Dados do jogo para abrir a lista da próxima rodada.", confirmText: "Ir para Dados do jogo", tone: "green" });
        if (go) pzaGoToDate();
        return;
      }
    }
    if (kind === "open" || kind === "close" || kind === "reopen") {
      clearTimeout(PZA.slotTimer); PZA.slotTimer = null;
      const slots = PZA.slotsKey === key ? PZA.slots : round?.slots || 20;
      const open = kind !== "close";
      const r = await pvRpc("presence_admin_round", { p_round: key, p_start: /^\d{2}:\d{2}$/.test(state.startTime || "") ? state.startTime : null, p_venue: String(state.venue || "").slice(0, 120) || null, p_slots: slots, p_open: open });
      if (r.ok) PZA.slotState = "";
      after(r, (kind === "open" ? "Lista aberta. Mande o convite no grupo." : kind === "close" ? "Lista fechada." : "Lista reaberta.") + pzaPromotedText(r.promoted), kind === "open" || kind === "reopen");
    } else if (kind === "add") {
      const name = $("pzaAdd")?.value || ""; if (!name) { pzaMsg("Escolha quem confirmar.", "bad"); return; }
      const r = await pvRpc("presence_admin_set", { p_round: key, p_name: name, p_going: true });
      after(r, displayName(name) + (r.status === "wait" ? " entrou na lista de espera." : " confirmado."));
    } else if (kind === "alerts-ok") {
      const last = PZA.alerts.reduce((m, a) => (Date.parse(a.at) > Date.parse(m) ? a.at : m), PZA.access?.now || new Date().toISOString());
      try { localStorage.setItem(PZA_SEEN_KEY, last); } catch {}
      PZA.alerts = []; $("elPresence").dataset.sig = ""; renderElPresence();
    } else if (kind === "links-all") {
      const r = await pvRpc("invite_admin_create_all");
      if (!r.ok) { pzaMsg(pvError(r), "bad"); return; }
      (r.links || []).forEach((l) => PZA.links.set(l.name, l));
      PZA.accOpen = true;
      await pzaLoad();
      pzaMsg(r.links?.length ? r.links.length + (r.links.length === 1 ? " link gerado." : " links gerados.") + " Use “Copiar mensagem” em cada um e mande no privado." : "Todos já têm PIN ou um link válido.");
    } else if (kind === "invite") {
      if (!round) return;
      // Convite com os dados atuais: data/horário/local de Dados do jogo, vagas do campo (ou da lista gravada).
      const slotsField = PZA.slotsKey === key ? PZA.slots : round.slots;
      const text = pvInviteText({
        round_key: key || round.round_key,
        start_time: pzaTime() || round.start_time,
        venue: String(state.venue || "").trim() || round.venue,
        slots: slotsField >= 2 && slotsField <= 40 ? slotsField : round.slots,
      }, PZA.data?.counts);
      let copied = false;
      try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch {}
      if (!copied) copied = pzaCopyLegacy(text);
      if (copied) {
        pzaMsg("Convite copiado! É só colar no grupo.");
        clearTimeout(PZA.msgTimer);
        PZA.msgTimer = setTimeout(() => { const el = $("pzaMsg"); if (el && el.textContent.startsWith("Convite copiado")) { el.textContent = ""; el.className = "pv-msg"; } }, 4000);
      } else pzaCopyDialog(text);
    } else if (kind === "use") {
      const confirmed = new Set((PZA.data?.players || []).filter((p) => p.status === "in").map((p) => pvNorm(p.name)));
      const ok = await askConfirm({ title: "Usar a lista no Elenco?", message: confirmed.size + " jogadores confirmados ficam ativos para o sorteio. Todo o resto do elenco fica inativo.", confirmText: "Usar a lista (" + confirmed.size + ")", tone: "green" });
      if (!ok) return;
      const inactivePlayers = (state.roster || []).filter((name) => !confirmed.has(pvNorm(name)));
      await saveState({ inactivePlayers }, "Lista aplicada: " + confirmed.size + " jogadores ativos para o sorteio.");
    }
  }
  const pzaPromotedText = (list) => (Array.isArray(list) && list.length ? " " + list.map((n) => displayName(n)).join(", ") + (list.length === 1 ? " saiu da espera e entrou." : " saíram da espera e entraram.") : "");
  function pzaRefresh(r) { if (r.view) { PZA.data = r.view; PZA.at = Date.now(); } $("elPresence").dataset.sig = ""; renderElPresence(); }
  async function pzaRemove(name, wait) {
    const players = PZA.data?.players || [], first = players.find((p) => p.status === "wait" && pvNorm(p.name) !== pvNorm(name));
    const nm = displayName(name);
    const message = wait ? nm + " sai da lista de espera." : nm + " sai da lista. " + (first ? displayName(first.name) + " (primeiro da espera) entra no lugar." : "A vaga fica livre.");
    const ok = await askConfirm({ title: wait ? "Tirar da espera?" : "Tirar da lista?", message, confirmText: "Tirar", tone: "red" });
    if (!ok) return;
    const r = await pvRpc("presence_admin_set", { p_round: state.matchDate, p_name: name, p_going: false });
    if (!r.ok) { pzaMsg(pvError(r), "bad"); return; }
    pzaRefresh(r);
    pzaMsg(nm + (wait ? " saiu da espera." : " saiu da lista.") + pzaPromotedText(r.promoted));
  }
  async function pzaPromote(name) {
    const r = await pvRpc("presence_admin_promote", { p_round: state.matchDate, p_name: name });
    if (!r.ok) { pzaMsg(pvError(r), "bad"); await pzaLoad(); return; }
    pzaRefresh(r);
    pzaMsg(displayName(name) + " entrou nos confirmados.");
  }
  // Vagas com + e −: salva sozinho (Salvando… → Salvo ✓). Nunca abaixo dos confirmados; de 2 a 40.
  function pzaStep(delta) {
    const round = PZA.data?.round && PZA.data.round.round_key === state.matchDate ? PZA.data.round : null;
    const confirmed = (PZA.data?.players || []).filter((p) => p.status === "in").length;
    const next = PZA.slots + delta;
    if (next < 2 || next > 40) { notify(next < 2 ? "O mínimo é 2 vagas." : "O máximo é 40 vagas."); return; }
    if (round && next < confirmed) { notify("Não dá para ter menos vagas que confirmados (" + confirmed + ").", true); return; }
    PZA.slots = next;
    if (!round) { $("elPresence").dataset.sig = ""; renderElPresence(); return; }
    PZA.slotState = "saving";
    $("elPresence").dataset.sig = ""; renderElPresence();
    clearTimeout(PZA.slotTimer);
    PZA.slotTimer = setTimeout(pzaSaveSlots, 600);
  }
  async function pzaSaveSlots() {
    const key = state.matchDate, round = PZA.data?.round;
    if (!round || round.round_key !== key) { PZA.slotTimer = null; return; }
    const slots = PZA.slots;
    const r = await pvRpc("presence_admin_round", { p_round: key, p_start: /^\d{2}:\d{2}$/.test(state.startTime || "") ? state.startTime : null, p_venue: String(state.venue || "").slice(0, 120) || null, p_slots: slots, p_open: !!round.open });
    if (PZA.slots !== slots) return; // mudou de novo enquanto salvava: o próximo salvamento cuida
    PZA.slotTimer = null;
    if (!r.ok) { PZA.slotState = ""; PZA.slots = round.slots; pzaRefresh({}); pzaMsg(pvError(r), "bad"); return; }
    PZA.slotState = "saved";
    pzaRefresh(r);
    const promoted = pzaPromotedText(r.promoted);
    if (promoted) pzaMsg(promoted.trim());
  }
  document.addEventListener("click", (event) => {
    const step = event.target.closest?.("#elPresence [data-pza-step]");
    if (step && !step.disabled) { pzaStep(Number(step.dataset.pzaStep)); return; }
    const up = event.target.closest?.("#elPresence [data-pza-up]");
    if (up && !up.disabled) { pzaPromote(up.dataset.pzaUp); return; }
    const a = event.target.closest?.("#elPresence [data-pza]");
    if (a && !a.disabled) { pzaAction(a.dataset.pza); return; }
    const x = event.target.closest?.("#elPresence [data-pza-remove]");
    if (x) pzaRemove(x.dataset.pzaRemove, x.dataset.pzaWait === "1");
  });
  // ----- Organizador: abrir/fechar a votação no painel do jogo -----
  function lvVoteKey() {
    const games = officialGames().filter((g) => g.finishedAt).sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
    return games.length ? nightKeyOf(games[games.length - 1]) : "";
  }
  async function vtaLoad(key) {
    VTA.key = key; VTA.at = Date.now();
    const data = await pvRpc("vote_get", { p_key: key });
    if (data && data.round !== undefined) VTA.data = data;
    lvUI.marks.lvVote = ""; renderOrganizer();
  }
  function lvVoteHtml() {
    if (!shared || !canManageShared || state.currentGame) return "";
    const key = lvVoteKey();
    if (!key) return "";
    if (VTA.key !== key || Date.now() - VTA.at > 30000) { VTA.key = key; VTA.at = Date.now(); vtaLoad(key); }
    const round = VTA.data?.round && VTA.data.round.round_key === key ? VTA.data.round : null;
    const head = '<h3 class="lv-label">⭐ CRAQUE DA NOITE · ' + escapeHtml(pvDayMonth(key)) + "</h3>";
    if (!round) return head + '<p class="lv-vote-text">Depois do último jogo, abra a votação: quem jogou vota pelo link com nome e PIN, por 12 horas.</p><button type="button" class="lv-btn lv-green" data-lv-vote="open">⭐ Abrir votação do craque da noite</button>';
    if (round.open) return head + '<p class="lv-vote-text">Votação aberta · <b>' + round.voted + " de " + round.eligible + "</b> já votaram · fecha " + escapeHtml(new Date(round.closes_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })) + '</p><div class="lv-vote-row"><button type="button" class="lv-btn lv-white" data-lv-vote="link">Copiar link</button><button type="button" class="lv-btn lv-white" data-lv-vote="close">Fechar votação agora</button></div>';
    const w = VTA.data?.winner;
    return head + '<p class="lv-vote-text">' + (w?.name ? "Craque da noite: <b>" + escapeHtml(displayName(w.name)) + "</b> (" + w.votes + (w.votes === 1 ? " voto" : " votos") + ")" : "Votação encerrada sem votos.") + '</p><a class="lv-btn lv-white" href="#votacao">Ver resultado</a>';
  }
  // Médias da noite pela nota atual (gamePerformance), no formato de nome do banco (norm_name): desempate da votação.
  function nightScoreAvgs(key) {
    const sum = {};
    officialGames().filter((game) => nightKeyOf(game) === key).forEach((game) => gamePerformance(game).forEach((row) => {
      const name = String(row.player || "").replace(/\*+\s*$/, "").trim().toUpperCase();
      if (!name || !Number.isFinite(Number(row.score))) return;
      (sum[name] = sum[name] || []).push(Number(row.score));
    }));
    return Object.fromEntries(Object.entries(sum).map(([name, list]) => [name, Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100]));
  }
  async function lvVoteAction(kind) {
    const key = lvVoteKey();
    if (kind === "link") { try { await navigator.clipboard.writeText(location.origin + "/#votacao"); notify("Link da votação copiado."); } catch { notify("Link: " + location.origin + "/#votacao"); } return; }
    if (kind === "open") {
      if (!(await askConfirm({ title: "Abrir a votação do craque da noite?", message: "Fica aberta por 12 horas. Cada um vota uma vez, sem trocar depois. Só vota quem jogou pelo menos um jogo oficial nessa noite, com nome e PIN.", confirmText: "Abrir votação", tone: "green" }))) return;
      const r = await pvRpc("vote_admin_open", { p_key: key, p_avgs: nightScoreAvgs(key) });
      if (r.ok) { VTA.data = r.view; VTA.at = Date.now(); VOTE.homeAt = 0; renderNightVoteCard(); notify("Votação aberta! Mande o link no grupo."); } else notify(r.error === "no_games" ? "Não há jogos oficiais suficientes nessa noite para votar." : pvError(r), true);
    } else if (kind === "close") {
      if (!(await askConfirm({ title: "Fechar a votação agora?", message: "O resultado aparece na hora e ninguém mais vota.", confirmText: "Fechar votação", tone: "red" }))) return;
      const r = await pvRpc("vote_admin_close", { p_key: key });
      if (r.ok) { VTA.data = r.view; VTA.at = Date.now(); VOTE.homeAt = 0; renderNightVoteCard(); loadVoteWinners(); notify("Votação fechada."); } else notify(pvError(r), true);
    }
    lvUI.marks.lvVote = ""; renderOrganizer();
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest?.("[data-lv-vote]");
    if (b) lvVoteAction(b.dataset.lvVote);
  });
  // ----- Tela principal: Craque da noite (votação) nos Destaques da noite -----
  async function loadVoteWinners() {
    const r = await pvRpc("vote_winners", { p_limit: 5 });
    if (Array.isArray(r)) { VOTE.winners = r; if (ART && ART.type === "craque") drawArt?.(); }
  }
  function renderNightVoteCard() {
    const card = $("nightVoteCard");
    if (!card) return;
    const key = lvVoteKey();
    if (!shared || !client || !key) { card.hidden = true; return; }
    if (VOTE.homeKey !== key || Date.now() - VOTE.homeAt > 60000) {
      VOTE.homeKey = key; VOTE.homeAt = Date.now();
      pvRpc("vote_get", { p_key: key }).then((data) => { if (data && data.round !== undefined) { VOTE.homeData = data; renderNightVoteCard(); } });
    }
    const data = VOTE.homeData, round = data?.round && data.round.round_key === key ? data.round : null;
    if (!round) { card.hidden = true; return; }
    card.hidden = false;
    // Card preto com contorno dourado: vencedor com avatar, barra de votos e selo de prêmios da noite.
    const kicker = '<p class="dx-k"><span aria-hidden="true">⭐</span> CRAQUE DA NOITE · VOTAÇÃO</p>';
    const bar = (part, total) => '<div class="dx-bar" aria-hidden="true"><i style="width:' + (total ? Math.min(100, (part / total) * 100) : 0) + '%"></i></div>';
    let html;
    if (round.open) {
      html = kicker + '<p class="dx-cnm">Votação aberta</p>' + bar(round.voted, round.eligible) +
        '<p class="dx-votes"><span><b>' + round.voted + " de " + round.eligible + "</b> já votaram</span>" + '<a href="#votacao">votar <span aria-hidden="true">›</span></a></p>';
    } else if (data.winner?.name) {
      const w = data.winner, part = (data.results || []).find((r) => r.name === w.name) || {}, total = Number(w.total) || 0, votes = Number(w.votes) || 0;
      const prizes = 1 + NIGHT_LEADERS.filter((slug) => slug === pSlug(w.name)).length;
      html = kicker + '<div class="dx-crow"><a class="dx-who is-big" href="#jogador/' + pSlug(w.name) + '">' + dxAvatar(w.name, part.team, part.label, true) + '<span class="dx-cbox"><span class="dx-cnm dx-fit">' + escapeHtml(displayName(w.name)) + ' <span aria-hidden="true">›</span></span>' +
        (prizes > 1 ? '<span class="dx-two">🏆 ' + prizes + " PRÊMIOS NA NOITE</span>" : "") + "</span></a></div>" + bar(votes, total) +
        '<p class="dx-votes"><span><b>' + votes + " de " + total + (total === 1 ? " voto" : " votos") + "</b> · " + (total ? Math.round((votes / total) * 100) : 0) + '%</span><a href="#votacao">ver votação <span aria-hidden="true">›</span></a></p>';
    } else html = kicker + '<p class="dx-cnm">Sem votos</p><p class="dx-votes"><span>A votação fechou sem votos.</span><a href="#votacao">ver votação <span aria-hidden="true">›</span></a></p>';
    if (DX_HTML.get(card) !== html) { DX_HTML.set(card, html); card.innerHTML = html; dxFit(card); }
  }
  // ---------- Perfil do jogador (#jogador/nome) e Hall da fama (#hall) ----------
  // Tudo calculado do histórico oficial (officialGames + gamePerformance); jogo de treino nunca entra.
  function pSlug(name) {
    return baseName(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  // Nome de jogador como link para o perfil (só em telas de leitura, nunca dentro de botão).
  function plink(name, text) {
    const label = text != null ? text : displayName(name);
    if (!name || name === "Gol" || !pSlug(name)) return escapeHtml(label);
    return '<a class="plink" href="#jogador/' + pSlug(name) + '">' + escapeHtml(label) + "</a>";
  }
  const PF = { slug: "", mode: "", fromSite: false, lastFocus: null };
  // Fotos dos jogadores: liga quando a migração supabase/migrations/20261124_fotos_jogadores.sql for aplicada.
  const PLAYER_PHOTOS_ENABLED = false;
  const monthKeyOf = (game) => { const d = hxTime(game.finishedAt); return d ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") : ""; };
  const monthLabel = (key) => { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 15).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }).replace(/^./, (c) => c.toUpperCase()); };
  const fmt1 = (value) => Number(value || 0).toFixed(1).replace(".", ",");
  // Mesma regra dos destaques do mês (Tela principal): Modo Liga, gols sem gol contra, goleiro com 3 jogos no gol.
  function monthLeaders(key) {
    const games = ligaGames().filter((game) => monthKeyOf(game) === key);
    const goals = new Map(), keepers = new Map();
    for (const game of games) {
      (game.goals || []).filter((goal) => !goal.ownGoal && goal.player).forEach((goal) => goals.set(goal.player, (goals.get(goal.player) || 0) + 1));
      gamePerformance(game).filter((p) => p.role === "goleiro").forEach((p) => { const row = keepers.get(p.player) || { player: p.player, sum: 0, games: 0, conceded: 0 }; row.sum += Number(p.score) || 0; row.games++; row.conceded += Number(p.goalsAgainst) || 0; keepers.set(p.player, row); });
    }
    const goalRows = [...goals.entries()].sort((a, b) => b[1] - a[1]), top = goalRows[0]?.[1] || 0;
    const keeperRows = [...keepers.values()].filter((row) => row.games >= MIN_KEEPER_GAMES).map((row) => ({ ...row, average: row.sum / row.games })).sort((a, b) => b.average - a.average);
    return {
      key, games: games.length, goals: top,
      scorers: top ? goalRows.filter((row) => row[1] === top).map((row) => row[0]).sort((a, b) => a.localeCompare(b, "pt-BR")) : [],
      keepers: keeperRows.length ? keeperRows.filter((row) => row.average === keeperRows[0].average) : [],
    };
  }
  function allMonths() { return [...new Set(ligaGames().map(monthKeyOf).filter(Boolean))].sort().reverse(); }
  // Campeões: o primeiro jogo "final" de cada Super Liga decide.
  function superChampions() {
    const byLeague = new Map();
    officialGames().filter((game) => game.superLigaId && game.stage === "final").sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0))
      .forEach((game) => { if (!byLeague.has(game.superLigaId)) byLeague.set(game.superLigaId, game); });
    return [...byLeague.values()].filter((game) => game.winner && game.winner !== "Empate").sort((a, b) => (hxTime(b.finishedAt)?.getTime() || 0) - (hxTime(a.finishedAt)?.getTime() || 0));
  }
  // Números do jogador num modo ("liga" ou "super").
  function playerData(slug, mode) {
    const games = officialGames().filter((game) => (mode === "super" ? !!game.superLigaId : !game.superLigaId)).sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0));
    const d = { name: "", games: 0, keeperGames: 0, goals: 0, assists: 0, sum: 0, conceded: 0, cleanSheets: 0, wins: 0, draws: 0, losses: 0, first: null, list: [], hatTricks: 0, team: "", teamLabel: "" };
    for (const game of games)
      for (const p of gamePerformance(game)) {
        if (pSlug(p.player) !== slug) continue;
        d.name = d.name || p.player;
        const score = Number(p.score) || 0;
        d.games++; d.sum += score; d.goals += Number(p.goalsFor) || 0; d.assists += Number(p.assists) || 0;
        if (p.role === "goleiro") { d.keeperGames++; d.conceded += Number(p.goalsAgainst) || 0; if (!Number(p.goalsAgainst)) d.cleanSheets++; }
        if (p.result === "vitória") d.wins++; else if (p.result === "empate") d.draws++; else d.losses++;
        if ((Number(p.goalsFor) || 0) >= 3) d.hatTricks++;
        d.first = d.first || hxTime(game.finishedAt);
        d.team = p.team; d.teamLabel = teamName(game, p.team);
        d.list.push({ game, p, score });
      }
    d.keeper = d.keeperGames > d.games - d.keeperGames;
    d.avg = d.games ? d.sum / d.games : 0;
    return d;
  }
  function playerAchievements(slug) {
    const out = [];
    const titles = superChampions().filter((game) => gamePerformance(game).some((p) => p.team === game.winner && pSlug(p.player) === slug));
    if (titles.length) out.push(["🏆", "Campeão da Super Liga", titles.length]);
    let scorer = 0, keeperMonth = 0;
    for (const key of allMonths()) { const m = monthLeaders(key); if (m.scorers.some((n) => pSlug(n) === slug)) scorer++; if (m.keepers.some((row) => pSlug(row.player) === slug)) keeperMonth++; }
    if (scorer) out.push(["⚽", "Artilheiro do mês", scorer]);
    const craque = (VOTE.winners || []).filter((w) => pSlug(w.name) === slug).length;
    if (craque) out.push(["⭐", "Craque da noite", craque]);
    if (keeperMonth) out.push(["🧤", "Goleiro do mês", keeperMonth]);
    const hat = playerData(slug, "liga").hatTricks + playerData(slug, "super").hatTricks;
    if (hat) out.push(["🎩", "Hat-trick", hat]);
    return out;
  }
  function playerPhotoUrl(slug) {
    const v = PLAYER_PHOTOS_ENABLED && state?.playerPhotos?.[slug], base = window.LIGA_CONFIG?.supabaseUrl;
    return v && base ? base.replace(/\/$/, "") + "/storage/v1/object/public/player-photos/" + slug + ".webp?v=" + encodeURIComponent(v) : "";
  }
  // Fotos fixas por jogador (arquivos em assets/jogadores/), ligadas pelo slug do nome original (nunca pelo displayName).
  // Valem mesmo com PLAYER_PHOTOS_ENABLED = false; se um dia houver foto pelo banco, a do banco vence.
  const PLAYER_PHOTO_FILES = { [pSlug("WANDERSON")]: "./assets/jogadores/wanderson.webp", [pSlug("LUÍS FELIPE*")]: "./assets/jogadores/luis-felipe.webp" };
  const PLAYER_PHOTO_SIZE = { "./assets/jogadores/wanderson.webp": [520, 475], "./assets/jogadores/luis-felipe.webp": [520, 511] };
  function cardPhotoUrl(slug) { return playerPhotoUrl(slug) || PLAYER_PHOTO_FILES[slug] || ""; }
  function playerCurrentTeam(slug) {
    for (const team of state.teams || []) if (lineupForTeam(team.name).some((n) => pSlug(n) === slug)) return teamLabel(team.name);
    for (const team of state.superLiga?.teams || []) if ((team.players || []).some((n) => pSlug(n) === slug)) return team.name;
    return "";
  }
  function pfKnownName(slug) {
    const fromRoster = (state.roster || []).find((n) => pSlug(n) === slug);
    if (fromRoster) return fromRoster;
    for (const game of officialGames()) for (const p of gamePerformance(game)) if (pSlug(p.player) === slug) return p.player;
    return "";
  }
  function renderProfile() {
    const box = $("jogador");
    if (!box || !PF.slug) return;
    const slug = PF.slug, name = pfKnownName(slug);
    const liga = playerData(slug, "liga"), sup = playerData(slug, "super");
    if (!PF.mode) PF.mode = liga.games || !sup.games ? "liga" : "super";
    // Nada mudou para este jogador: não mexe no DOM (renderAll roda a cada poucos segundos com jogo rolando).
    cardsData();
    const pfKey = JSON.stringify([slug, PF.mode, CARDS.sig, name, playerCurrentTeam(slug), shared && !!client, isEditLocked(), playerPhotoUrl(slug), (VOTE.winners || []).length]);
    if (box.dataset.key === pfKey && box.firstElementChild) return;
    cardsUnobserve(box);
    box.dataset.key = pfKey;
    const d = PF.mode === "super" ? sup : liga, total = liga.games + sup.games, isKeeper = liga.keeperGames + sup.keeperGames > total - (liga.keeperGames + sup.keeperGames);
    const photo = playerPhotoUrl(slug), initials = displayName(name || slug).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const first = [liga.first, sup.first].filter(Boolean).sort((a, b) => a - b)[0];
    const big = (value, label) => '<div class="pf-num"><strong>' + value + "</strong><small>" + label + "</small></div>";
    const nums = d.keeper
      ? big(d.games, "JOGOS") + big(d.conceded, "SOFRIDOS") + big(d.keeperGames ? fmt1(d.conceded / d.keeperGames) : "0,0", "MÉDIA SOFRIDA POR JOGO") + big(d.cleanSheets, "JOGOS SEM SOFRER GOL")
      : big(d.games, "JOGOS") + big(d.goals, "GOLS") + big(d.assists, "ASSIST.") + big(d.games ? fmt1(d.avg) : "–", "NOTA MÉDIA");
    const last = d.list.slice(-8), bestScore = Math.max(0, ...last.map((x) => x.score));
    const bars = last.length ? '<div class="pf-bars" role="img" aria-label="Notas dos últimos ' + last.length + " jogos: " + last.map((x) => fmt1(x.score)).join(", ") + '">' + last.map((x) => '<div class="pf-bar' + (x.score === bestScore ? " is-best" : "") + '"><span>' + fmt1(x.score) + '</span><i style="height:' + Math.max(4, (x.score / 10) * 100) + '%"></i><small>' + escapeHtml(new Date(hxTime(x.game.finishedAt)).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })) + "</small></div>").join("") + "</div>" : '<p class="pf-empty">Ainda sem jogos neste modo.</p>';
    const best = d.list.slice().sort((a, b) => b.score - a.score || (Number(b.p.goalsFor) || 0) - (Number(a.p.goalsFor) || 0))[0];
    const bestHtml = best ? (() => {
      const g = best.game, p = best.p, did = [];
      if (Number(p.goalsFor)) did.push(p.goalsFor + (Number(p.goalsFor) === 1 ? " gol" : " gols"));
      if (Number(p.assists)) did.push(p.assists + (Number(p.assists) === 1 ? " assistência" : " assistências"));
      if (p.role === "goleiro") did.push("no gol · " + (Number(p.goalsAgainst) || 0) + (Number(p.goalsAgainst) === 1 ? " sofrido" : " sofridos"));
      if (!did.length) did.push(p.result === "vitória" ? "vitória" : p.result === "empate" ? "empate" : "derrota");
      return '<div class="pf-best"><div class="pf-best-score">' + hxCrest(g.home, gameTeamLabel(g, "home"), "lg") + "<strong>" + Number(g.homeScore || 0) + " × " + Number(g.awayScore || 0) + "</strong>" + hxCrest(g.away, gameTeamLabel(g, "away"), "lg") + '</div><p class="pf-best-teams">' + escapeHtml(gameTeamLabel(g, "home") + " × " + gameTeamLabel(g, "away")) + " · " + escapeHtml(new Date(hxTime(g.finishedAt)).toLocaleDateString("pt-BR")) + '</p><p class="pf-best-did">' + escapeHtml(did.join(" · ")) + ' · nota <b>' + fmt1(best.score) + "</b></p></div>";
    })() : '<p class="pf-empty">Ainda sem jogos neste modo.</p>';
    const ach = playerAchievements(slug);
    const tab = (mode, label, n) => '<button type="button" class="pf-tab' + (PF.mode === mode ? " is-on" : "") + '" role="tab" aria-selected="' + (PF.mode === mode) + '" data-pf-mode="' + mode + '">' + label + " <small>" + n + "</small></button>";
    box.innerHTML = '<div class="pf-wrap"><div class="pf-bar-top"><button type="button" class="pf-back" data-pf-back>← Voltar</button><button type="button" class="pf-share" data-pf-share>Compartilhar</button></div>' + profileCardsHtml(slug) +
      '<header class="pf-head"><div class="pf-photo">' + (photo ? '<img src="' + escapeHtml(photo) + '" alt="Foto de ' + escapeHtml(displayName(name)) + '" onerror="this.remove()">' : "") + '<span aria-hidden="true">' + escapeHtml(initials || "?") + "</span></div>" +
      '<div class="pf-id"><h2 id="pfTitle">' + escapeHtml(displayName(name) || "Jogador") + "</h2>" +
        (shared && client && name ? '<button type="button" class="pv-switch nm-open" data-nm-open="' + escapeHtml(baseName(name)) + '">✎ Editar meu nome</button>' : "") + '<p class="pf-tags"><span>' + (isKeeper ? "Goleiro" : "Linha") + "</span>" + (playerCurrentTeam(slug) ? "<span>" + escapeHtml(playerCurrentTeam(slug)) + "</span>" : "") + (first ? "<span>desde " + escapeHtml(first.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(". de ", "/").replace(" de ", "/")) + "</span>" : "") + "</p></div></header>" +
      (!total ? '<p class="pf-empty pf-card">Este jogador ainda não tem jogos oficiais.</p>' :
        '<div class="pf-tabs" role="tablist" aria-label="Modo">' + tab("liga", "Modo Liga", liga.games) + tab("super", "Super Liga", sup.games) + "</div>" +
        '<section class="pf-card" aria-label="Números"><div class="pf-nums">' + nums + '</div><div class="pf-ved"><div class="v"><strong>' + d.wins + '</strong><small>VITÓRIAS</small></div><div class="e"><strong>' + d.draws + '</strong><small>EMPATES</small></div><div class="d"><strong>' + d.losses + "</strong><small>DERROTAS</small></div></div></section>" +
        '<section class="pf-card" aria-labelledby="pfBarsTitle"><h3 id="pfBarsTitle" class="pf-h">NOTAS DOS ÚLTIMOS JOGOS</h3>' + bars + "</section>" +
        '<section class="pf-card" aria-labelledby="pfBestTitle"><h3 id="pfBestTitle" class="pf-h">MELHOR JOGO</h3>' + bestHtml + "</section>") +
      '<section class="pf-card" aria-labelledby="pfAchTitle"><h3 id="pfAchTitle" class="pf-h">CONQUISTAS</h3>' + (ach.length ? '<ul class="pf-ach">' + ach.map(([icon, label, n]) => '<li><span aria-hidden="true">' + icon + "</span><strong>" + label + "</strong>" + (n > 1 ? "<small>×" + n + "</small>" : "") + "</li>").join("") + "</ul>" : '<p class="pf-empty">Ainda sem conquistas. Bora!</p>') + "</section>" + profileCardsExtraHtml(slug) +
      (PLAYER_PHOTOS_ENABLED && !isEditLocked() && shared && client ? '<section class="pf-card pf-admin"><h3 class="pf-h">FOTO (ORGANIZADOR)</h3><p class="pf-empty">A foto é reduzida para 400×400 e guardada em WebP.</p><label class="button button-outline pf-upload">Escolher foto<input type="file" accept="image/*" id="pfPhotoInput" hidden></label>' + (photo ? '<button type="button" class="button button-outline" data-pf-photo-remove>Tirar foto</button>' : "") + '<p class="pv-msg" id="pfPhotoMsg" role="status"></p></section>' : "") +
      "</div>";
    cardsAfterRender(box);
  }
  function openProfile(slug, fromSite) {
    PF.slug = slug; PF.mode = ""; PF.fromSite = fromSite;
    // Galeria por baixo do perfil para de animar enquanto o perfil está aberto.
    if ($("cartas")?.firstElementChild) cardsUnobserve($("cartas"));
    PF.lastFocus = PF.lastFocus || document.activeElement;
    const box = $("jogador");
    box.hidden = false; document.body.classList.add("pf-open");
    renderProfile();
    box.scrollTop = 0;
    box.querySelector(".pf-back")?.focus();
  }
  function closeProfile() {
    const box = $("jogador");
    if (!box || box.hidden) return;
    box.hidden = true; PF.slug = ""; document.body.classList.remove("pf-open");
    cardsUnobserve(box); box.innerHTML = ""; box.dataset.key = "";
    if (location.hash === "#cartas" && $("cartas")?.firstElementChild) cardsObserve($("cartas"));
    const focus = PF.lastFocus; PF.lastFocus = null;
    if (focus && document.contains(focus)) focus.focus();
  }
  function pfRoute(fromSite) {
    const match = location.hash.match(/^#jogador\/([a-z0-9-]+)$/);
    if (match) { openProfile(match[1], fromSite); return true; }
    closeProfile();
    return false;
  }
  let pfPrevHash = location.hash;
  window.addEventListener("hashchange", () => { const from = !/^#jogador\//.test(pfPrevHash); pfPrevHash = location.hash; pfRoute(from); if (location.hash === "#hall") hallOpen(); });
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-pf-back]")) { if (PF.fromSite && history.length > 1) history.back(); else { history.pushState(null, "", location.pathname + location.search); pfPrevHash = ""; closeProfile(); } return; }
    const tab = event.target.closest?.("[data-pf-mode]");
    if (tab) { PF.mode = tab.dataset.pfMode; renderProfile(); $("jogador").querySelector('[data-pf-mode="' + PF.mode + '"]')?.focus(); return; }
    if (event.target.closest?.("[data-pf-share]")) {
      const url = location.origin + "/#jogador/" + PF.slug, title = "Perfil de " + displayName(pfKnownName(PF.slug)) + " · LIGA SKALAMA";
      if (navigator.share) navigator.share({ title, url }).catch(() => {}); else navigator.clipboard?.writeText(url).then(() => notify("Link do perfil copiado."), () => notify(url));
      return;
    }
    if (event.target.closest?.("[data-pf-photo-remove]")) pfPhotoRemove();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && PF.slug && !document.querySelector("dialog[open]")) document.querySelector("[data-pf-back]")?.click(); });
  document.addEventListener("change", (event) => { if (event.target.id === "pfPhotoInput" && event.target.files?.[0]) pfPhotoUpload(event.target.files[0]); });
  // Foto: reduz para no máximo 400×400 em WebP e sobe no Supabase Storage (só organizador consegue gravar).
  async function pfPhotoUpload(file) {
    const msg = (text, bad) => { const el = $("pfPhotoMsg"); if (el) { el.textContent = text; el.className = "pv-msg" + (bad ? " is-bad" : " is-good"); } };
    if (!/^image\//.test(file.type) || file.size > 15 * 1024 * 1024) { msg("Escolha uma imagem de até 15 MB.", true); return; }
    try {
      const bitmap = await createImageBitmap(file), size = Math.min(400, bitmap.width, bitmap.height), side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
      if (!blob || blob.type !== "image/webp") { msg("Este navegador não gera WebP. Tente pelo Chrome.", true); return; }
      const slug = PF.slug, { error } = await client.storage.from("player-photos").upload(slug + ".webp", blob, { upsert: true, contentType: "image/webp", cacheControl: "3600" });
      if (error) { msg("Não deu para subir a foto: " + error.message, true); return; }
      await saveState({ playerPhotos: { ...(state.playerPhotos || {}), [slug]: Date.now() } }, "Foto de " + displayName(pfKnownName(slug)) + " salva.");
      renderProfile();
    } catch (error) { msg("Não deu para ler a imagem: " + error.message, true); }
  }
  async function pfPhotoRemove() {
    const slug = PF.slug;
    if (!(await askConfirm({ title: "Tirar a foto?", message: "O perfil volta a mostrar as iniciais.", confirmText: "Tirar foto", tone: "red" }))) return;
    await client.storage.from("player-photos").remove([slug + ".webp"]).catch(() => {});
    const photos = { ...(state.playerPhotos || {}) }; delete photos[slug];
    await saveState({ playerPhotos: photos }, "Foto removida.");
    renderProfile();
  }
  // ----- Hall da fama -----
  async function hallOpen() { if (!VOTE.hallLoaded && shared && client) { VOTE.hallLoaded = true; const r = await pvRpc("vote_winners", { p_limit: 20 }); if (Array.isArray(r)) VOTE.allWinners = r; } renderHall(); }
  function hallRecords() {
    const games = officialGames(), out = [];
    const perGame = [];
    for (const game of games) for (const p of gamePerformance(game)) if (Number(p.goalsFor)) perGame.push({ name: p.player, goals: Number(p.goalsFor), game });
    const maxGoals = Math.max(0, ...perGame.map((x) => x.goals));
    if (maxGoals) out.push(["⚽", "Mais gols num jogo", maxGoals + (maxGoals === 1 ? " gol" : " gols"), perGame.filter((x) => x.goals === maxGoals).map((x) => plink(x.name) + ' <small>' + escapeHtml(gameTeamLabel(x.game, "home") + " " + x.game.homeScore + "×" + x.game.awayScore + " " + gameTeamLabel(x.game, "away")) + "</small>")]);
    const diff = (g) => Math.abs(Number(g.homeScore || 0) - Number(g.awayScore || 0)), maxDiff = Math.max(0, ...games.map(diff));
    if (maxDiff) out.push(["💥", "Maior goleada", "diferença de " + maxDiff, games.filter((g) => diff(g) === maxDiff).map((g) => escapeHtml(gameTeamLabel(g, "home") + " " + g.homeScore + " × " + g.awayScore + " " + gameTeamLabel(g, "away")) + " <small>" + escapeHtml(new Date(hxTime(g.finishedAt)).toLocaleDateString("pt-BR")) + "</small>")]);
    const streak = new Map(), best = new Map();
    ligaGames().sort((a, b) => (hxTime(a.finishedAt)?.getTime() || 0) - (hxTime(b.finishedAt)?.getTime() || 0)).forEach((g) => [g.home, g.away].forEach((team) => { const s = g.winner === team ? (streak.get(team) || 0) + 1 : 0; streak.set(team, s); best.set(team, Math.max(best.get(team) || 0, s)); }));
    const maxStreak = Math.max(0, ...best.values());
    if (maxStreak) out.push(["🔥", "Maior sequência de vitórias", maxStreak + (maxStreak === 1 ? " vitória" : " vitórias seguidas"), [...best.entries()].filter(([, v]) => v === maxStreak).map(([team]) => hxCrest(team, teamLabel(team), "sm") + " " + escapeHtml(teamLabel(team)))]);
    const clean = new Map();
    for (const game of games) for (const p of gamePerformance(game)) if (p.role === "goleiro") { const row = clean.get(p.player) || { games: 0, clean: 0 }; row.games++; if (!Number(p.goalsAgainst)) row.clean++; clean.set(p.player, row); }
    const keepers = [...clean.entries()].filter(([, r]) => r.games >= MIN_KEEPER_GAMES), maxClean = Math.max(0, ...keepers.map(([, r]) => r.clean));
    out.push(["🧤", "Mais jogos sem sofrer gol", maxClean ? maxClean + (maxClean === 1 ? " jogo" : " jogos") : "—", maxClean ? keepers.filter(([, r]) => r.clean === maxClean).map(([n, r]) => plink(n) + " <small>" + r.games + " jogos no gol</small>") : ["<small>Ainda sem goleiro com " + MIN_KEEPER_GAMES + " jogos no gol sem sofrer gol.</small>"]]);
    const wins = new Map(); (VOTE.allWinners || VOTE.winners || []).forEach((w) => wins.set(w.name, (wins.get(w.name) || 0) + 1));
    const maxCraque = Math.max(0, ...wins.values());
    if (maxCraque) out.push(["⭐", "Mais craques da noite", maxCraque + (maxCraque === 1 ? " vez" : " vezes"), [...wins.entries()].filter(([, v]) => v === maxCraque).map(([n]) => plink(n))]);
    return out;
  }
  function renderHall() {
    const box = $("hall");
    if (!box) return;
    const champs = superChampions(), months = allMonths();
    box.innerHTML = '<div class="pv-wrap hall-wrap"><a class="pv-back" href="./">← Ir para o site</a>' +
      '<header class="hall-head"><p class="pv-kicker">LIGA SKALAMA</p><h2>🏆 Hall da fama</h2><p>Campeões, recordes e os melhores de cada mês. Toque num nome para ver o perfil.</p></header>' +
      '<section class="pv-panel" aria-labelledby="hallChamps"><h3 class="pv-h" id="hallChamps">CAMPEÕES DA SUPER LIGA</h3>' + (champs.length ? '<div class="hall-champs">' + champs.map((g) => {
        const side = g.winner === g.home ? "home" : "away", label = gameTeamLabel(g, side);
        return '<article class="hall-champ">' + hxCrest(g.winner, label, "lg") + '<div><strong>' + escapeHtml(label) + "</strong><small>" + escapeHtml(new Date(hxTime(g.finishedAt)).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })) + "</small><small>Final: " + escapeHtml(gameTeamLabel(g, "home") + " " + g.homeScore + " × " + g.awayScore + " " + gameTeamLabel(g, "away")) + "</small></div></article>";
      }).join("") + "</div>" : '<p class="pv-hint">Ainda sem campeão.</p>') + "</section>" +
      '<section class="pv-panel" aria-labelledby="hallRecs"><h3 class="pv-h" id="hallRecs">RECORDES</h3><ul class="hall-recs">' + hallRecords().map(([icon, title, value, who]) => '<li><span class="hall-ico" aria-hidden="true">' + icon + '</span><div><p class="hall-rt">' + title + ' · <b>' + escapeHtml(value) + '</b></p><p class="hall-who">' + who.join("<br>") + "</p></div></li>").join("") + "</ul></section>" +
      '<section class="pv-panel" aria-labelledby="hallMonths"><h3 class="pv-h" id="hallMonths">ARTILHEIRO E GOLEIRO DE CADA MÊS</h3><p class="pv-hint">Modo Liga. Goleiro do mês precisa de ' + MIN_KEEPER_GAMES + ' jogos no gol.</p>' + (months.length ? '<div class="hall-months">' + months.map((key) => {
        const m = monthLeaders(key);
        return '<article class="hall-month"><h4>' + escapeHtml(monthLabel(key)) + '</h4><p><span>⚽ Artilheiro</span>' + (m.scorers.length ? m.scorers.map((n) => plink(n)).join(" · ") + " <small>" + m.goals + (m.goals === 1 ? " gol" : " gols") + "</small>" : "<small>sem gols</small>") + '</p><p><span>🧤 Goleiro</span>' + (m.keepers.length ? m.keepers.map((r) => plink(r.player)).join(" · ") + " <small>nota " + fmt1(m.keepers[0].average) + "</small>" : "<small>ninguém com " + MIN_KEEPER_GAMES + " jogos no gol</small>") + "</p></article>";
      }).join("") + "</div>" : '<p class="pv-hint">Ainda sem jogos do Modo Liga.</p>') + "</section></div>";
  }
  // ---------- Coleção de cartas Skalama (#cartas) ----------
  // Só leitura: tudo de officialGames() + gamePerformance() (Modo Liga e Super Liga juntos), monthLeaders, vote_winners e superChampions.
  const CARD_NEW_UNTIL = Date.parse("2026-12-23T03:00:00Z"); // selo "NOVO" do card da Tela principal (30 dias)
  const CARD_TIER_LABEL = { prata: "PRATA", ouro: "OURO", dia: "DIAMANTE", elite: "ELITE", lend: "LENDÁRIO" };
  const CARD_SP = { mes: ["Jogador do mês", "⭐"], art: ["Artilheiro do mês", "🔥"], gk: ["Goleiro do mês", "🧤"], con: ["Constância", "📈"] };
  const CARD_SP_ORDER = ["mes", "art", "gk", "con"];
  const CARD_MON = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  const CARDS = { sig: "", data: null, filter: "all", winnersLoading: false };
  // Níveis pela nota média: Prata < 6,0 · Ouro 6,0–6,9 · Diamante 7,0–7,9 · Elite 8,0–8,9 · Lendário 9,0+.
  const cardTier = (avg) => (avg >= 9 ? "lend" : avg >= 8 ? "elite" : avg >= 7 ? "dia" : avg >= 6 ? "ouro" : "prata");
  const cardMon = (key) => CARD_MON[Number(String(key).slice(5, 7)) - 1] || "";
  const cardYear = () => new Date(nowMs()).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 4);
  const cardNowMonth = () => new Date(nowMs()).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
  const cardPct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + "%";
  const cardDec = (a, b, digits = 2) => (b ? (a / b).toFixed(digits) : (0).toFixed(digits)).replace(".", ",");
  const cardTime = (game) => hxTime(game.finishedAt)?.getTime() || 0;
  const cardWinners = () => VOTE.allWinners || VOTE.winners || [];
  // Craque da noite de todas as noites (até 20): carregado uma vez, quando alguma carta aparece.
  function cardLoadWinners() {
    if (VOTE.hallLoaded || CARDS.winnersLoading || !shared || !client) return;
    CARDS.winnersLoading = true;
    pvRpc("vote_winners", { p_limit: 20 }).then((r) => {
      if (Array.isArray(r)) { VOTE.allWinners = r; VOTE.hallLoaded = true; CARDS.sig = ""; cardsRefresh(); }
    }).finally(() => { CARDS.winnersLoading = false; });
  }
  function cardEmptyRow(slug, name) {
    return { slug, name, games: 0, sum: 0, goals: 0, assists: 0, wins: 0, kGames: 0, kSum: 0, kWins: 0, conceded: 0, clean: 0, last: null };
  }
  // Soma uma linha de gamePerformance num acumulador.
  function cardAdd(row, p, game) {
    const score = Number(p.score) || 0;
    row.games++; row.sum += score; row.goals += Number(p.goalsFor) || 0; row.assists += Number(p.assists) || 0;
    if (p.result === "vitória") row.wins++;
    if (p.role === "goleiro") { row.kGames++; row.kSum += score; if (p.result === "vitória") row.kWins++; const ga = Number(p.goalsAgainst) || 0; row.conceded += ga; if (!ga) row.clean++; }
    (row.scores = row.scores || []).push(score);
    row.last = { game, team: p.team };
  }
  // Especiais de um mês (chave AAAA-MM). Jogador do mês e Constância: Modo Liga + Super Liga; Artilheiro e Goleiro: regra dos destaques (monthLeaders).
  function cardMonthSpecials(key, partial) {
    const games = officialGames().filter((game) => monthKeyOf(game) === key).sort((a, b) => cardTime(a) - cardTime(b));
    const rows = new Map(), liga = new Map();
    for (const game of games) for (const p of gamePerformance(game)) {
      const slug = pSlug(p.player); if (!slug) continue;
      if (!rows.has(slug)) rows.set(slug, cardEmptyRow(slug, p.player));
      cardAdd(rows.get(slug), p, game);
      if (!game.superLigaId) { if (!liga.has(slug)) liga.set(slug, cardEmptyRow(slug, p.player)); cardAdd(liga.get(slug), p, game); }
    }
    // Um jogador só pode ter UMA especial no mês, menos a de Artilheiro: ela é sempre do artilheiro de verdade, mesmo que ele
    // já tenha outra. Ordem: Jogador do mês → Artilheiro → Goleiro → Constância; nas outras, se o primeiro da lista já ganhou
    // uma, vai para o próximo da lista daquela categoria (com os mesmos mínimos).
    const out = {}, used = new Set(), avg = (r) => (r.games ? r.sum / r.games : 0), kAvg = (r) => (r.kGames ? r.kSum / r.kGames : 0), byName = (a, b) => a.name.localeCompare(b.name, "pt-BR");
    const take = (list) => { const r = list.find((x) => !used.has(x.slug)); if (r) used.add(r.slug); return r; };
    const mes = take([...rows.values()].filter((r) => r.games >= 3).sort((a, b) => avg(b) - avg(a) || b.games - a.games || byName(a, b)));
    if (mes) out.mes = { type: "mes", key, partial, slug: mes.slug, name: mes.name, ovr: Math.round(avg(mes) * 10), hl: [fmt1(avg(mes)), "NOTA MÉDIA NO MÊS"] };
    // Artilheiro: mesma contagem do Artilheiro do mês (Modo Liga, sem gol contra); empate: menos jogos, depois maior nota.
    const goals = new Map();
    for (const game of games) if (!game.superLigaId) (game.goals || []).filter((g) => !g.ownGoal && g.player).forEach((g) => { const k = pSlug(g.player); goals.set(k, (goals.get(k) || 0) + 1); });
    const art = ((list) => { if (list[0]) used.add(list[0].slug); return list[0]; })([...goals.entries()].map(([slug, n]) => ({ ...(liga.get(slug) || cardEmptyRow(slug, slug)), slug, n })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || a.games - b.games || avg(b) - avg(a) || byName(a, b)));
    if (art) out.art = { type: "art", key, partial, slug: art.slug, name: art.name, ovr: Math.round(avg(rows.get(art.slug) || art) * 10), hl: [String(art.n), art.n === 1 ? "GOL NO MÊS" : "GOLS NO MÊS"] };
    // Goleiro: mesma regra do Goleiro do mês (Modo Liga, mínimo de jogos no gol, maior nota média no gol).
    const gk = take([...liga.values()].filter((r) => r.kGames >= MIN_KEEPER_GAMES).sort((a, b) => kAvg(b) - kAvg(a) || b.kGames - a.kGames || byName(a, b)));
    if (gk) out.gk = { type: "gk", key, partial, slug: gk.slug, name: gk.name, ovr: Math.round(kAvg(gk) * 10), keeper: true,
      hl: gk.clean ? [String(gk.clean), gk.clean === 1 ? "JOGO SEM SOFRER" : "JOGOS SEM SOFRER"] : [cardDec(gk.conceded, gk.kGames, 1), "SOFRIDOS POR JOGO"] };
    const sd = (r) => { const m = avg(r); return Math.sqrt(r.scores.reduce((sum, x) => sum + (x - m) ** 2, 0) / r.scores.length); };
    const con = take([...rows.values()].filter((r) => r.games >= 4 && avg(r) >= 7).sort((a, b) => sd(a) - sd(b) || b.games - a.games || avg(b) - avg(a) || byName(a, b)));
    if (con) out.con = { type: "con", key, partial, slug: con.slug, name: con.name, ovr: Math.round(avg(con) * 10), hl: ["±" + fmt1(sd(con)), con.games + (con.games === 1 ? " JOGO SEM CAIR" : " JOGOS SEM CAIR")] };
    return out;
  }
  // Monta tudo uma vez (cache pela assinatura dos dados).
  function cardsData() {
    if (!state) return { players: [], waiting: [], cur: {}, months: [], bySlug: new Map() };
    const games = officialGames().slice().sort((a, b) => cardTime(a) - cardTime(b)), winners = cardWinners(), curKey = cardNowMonth();
    // Assinatura leve de todos os jogos (placar, gols, notas, trocas): qualquer correção num jogo salvo também refaz as cartas.
    const gamesSig = games.map((g) => g.id + ":" + (g.homeScore || 0) + "-" + (g.awayScore || 0) + ":" + (g.goals || []).length + ":" + (g.substitutions || []).length + ":" + (g.performance || []).reduce((sum, p) => sum + (Number(p.score) || 0) * 7 + (Number(p.goalsFor) || 0) * 3 + (Number(p.assists) || 0) + (Number(p.goalsAgainst) || 0) * 5, 0).toFixed(1)).join("|");
    const sig = JSON.stringify([gamesSig, winners.map((w) => w.round_key + w.name), state.scoreRules?.assist, state.roster, curKey, [...DN.map]]);
    if (CARDS.sig === sig && CARDS.data) return CARDS.data;
    const rows = new Map();
    for (const game of games) for (const p of gamePerformance(game)) {
      const slug = pSlug(p.player); if (!slug) continue;
      if (!rows.has(slug)) rows.set(slug, cardEmptyRow(slug, p.player));
      cardAdd(rows.get(slug), p, game);
    }
    // Especiais: mês atual (parcial) e meses fechados.
    const keys = [...new Set(games.map(monthKeyOf).filter(Boolean))].sort().reverse(), months = keys.map((key) => ({ key, specials: cardMonthSpecials(key, key === curKey) }));
    const cur = months.find((m) => m.key === curKey)?.specials || {};
    const champs = superChampions();
    const players = [], waiting = [], bySlug = new Map();
    for (const r of rows.values()) {
      const rosterName = (state.roster || []).find((n) => pSlug(n) === r.slug), isKeeper = keeper(rosterName || r.name) || r.kGames > r.games - r.kGames;
      const eligible = isKeeper ? r.kGames >= MIN_KEEPER_GAMES : r.games >= 3;
      const mvp = winners.filter((w) => pSlug(w.name) === r.slug).length;
      // Selo: a conquista mais recente (craque da noite, artilheiro/goleiro/especial de mês fechado, campeão da Super Liga).
      const badges = [];
      winners.filter((w) => pSlug(w.name) === r.slug).forEach((w) => badges.push({ at: Date.parse(w.round_key + "T23:00:00-03:00"), text: "CRAQUE " + pvDayMonth(w.round_key) }));
      for (const m of months) {
        if (m.key === curKey) continue;
        const end = Date.parse(m.key + "-01T00:00:00-03:00") + 31 * 864e5, mon = cardMon(m.key), lead = monthLeaders(m.key);
        if (lead.scorers.some((n) => pSlug(n) === r.slug)) badges.push({ at: end, text: "ARTILHEIRO " + mon });
        if (lead.keepers.some((k) => pSlug(k.player) === r.slug)) badges.push({ at: end, text: "GOLEIRO " + mon });
        if (m.specials.mes?.slug === r.slug) badges.push({ at: end + 1, text: "JOGADOR DO MÊS " + mon });
        if (m.specials.con?.slug === r.slug) badges.push({ at: end, text: "CONSTÂNCIA " + mon });
      }
      champs.filter((g) => gamePerformance(g).some((p) => p.team === g.winner && pSlug(p.player) === r.slug)).forEach((g) => badges.push({ at: cardTime(g), text: "CAMPEÃO SUPER LIGA" }));
      const badge = badges.sort((a, b) => b.at - a.at)[0]?.text || "";
      const avg = isKeeper ? (r.kGames ? r.kSum / r.kGames : 0) : r.games ? r.sum / r.games : 0;
      const crest = r.last ? crestFor(r.last.team, teamName(r.last.game, r.last.team)) : "";
      const stats = isKeeper
        ? [["JOG", r.kGames], ["SOF", r.conceded], ["S/J", cardDec(r.conceded, r.kGames, 1)], ["JSS", r.clean], ["VIT", cardPct(r.kWins, r.kGames)], ["MVP", mvp]]
        : [["JOG", r.games], ["GOL", r.goals], ["AST", r.assists], ["VIT", cardPct(r.wins, r.games)], ["G/J", cardDec(r.goals, r.games)], ["MVP", mvp]];
      const card = { slug: r.slug, name: rosterName || r.name, keeper: isKeeper, games: isKeeper ? r.kGames : r.games, avg, ovr: Math.round(avg * 10), tier: cardTier(avg), stats, crest, badge, eligible };
      bySlug.set(r.slug, card);
      if (eligible) players.push(card); else waiting.push(card);
    }
    players.sort((a, b) => b.ovr - a.ovr || b.games - a.games || a.name.localeCompare(b.name, "pt-BR"));
    waiting.sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, "pt-BR"));
    CARDS.sig = sig;
    CARDS.data = { players, waiting, cur, curKey, months, bySlug };
    return CARDS.data;
  }
  // Especial principal do jogador neste mês (prioridade: Jogador do mês > Artilheiro > Goleiro > Constância).
  function cardSpecialOf(slug, data = cardsData()) {
    for (const type of CARD_SP_ORDER) if (data.cur[type]?.slug === slug) return data.cur[type];
    return null;
  }
  // Informações para desenhar uma carta (nível ou especial) de um jogador.
  function cardInfo(slug, sp, data = cardsData()) {
    const base = data.bySlug.get(slug);
    if (!base) return null;
    if (!sp) return { ...base, cls: base.tier, tierText: CARD_TIER_LABEL[base.tier] };
    return { ...base, keeper: sp.type === "gk" ? true : base.keeper, stats: sp.type === "gk" && !base.keeper ? cardKeeperStats(slug, data) : base.stats, ovr: sp.ovr, cls: sp.type, sp, tierText: "ESPECIAL" };
  }
  function cardKeeperStats(slug, data) {
    const base = data.bySlug.get(slug), rows = cardEmptyRow(slug, base.name);
    for (const game of officialGames()) for (const p of gamePerformance(game)) if (pSlug(p.player) === slug) cardAdd(rows, p, game);
    const mvp = base.stats.find((s) => s[0] === "MVP")?.[1] || 0;
    return [["JOG", rows.kGames], ["SOF", rows.conceded], ["S/J", cardDec(rows.conceded, rows.kGames, 1)], ["JSS", rows.clean], ["VIT", cardPct(rows.kWins, rows.kGames)], ["MVP", mvp]];
  }
  const CARD_SIL = '<svg class="skc-sil" viewBox="0 0 170 180" aria-hidden="true" focusable="false"><circle cx="85" cy="62" r="38"/><path d="M12 180c5-46 34-72 73-72s68 26 73 72Z"/></svg>';
  const CARD_MOTIF = {
    mes: '<svg class="skc-motif" viewBox="0 0 300 490" aria-hidden="true">' + [[40, 90, 9], [250, 150, 7], [60, 200, 6], [230, 60, 5], [150, 40, 4], [270, 220, 6], [30, 150, 4]].map(([x, y, r]) => '<path transform="translate(' + x + " " + y + ") scale(" + r / 10 + ')" d="M0-10 2.9-3.1 10-3.1 4.3 1.2 6.2 8.1 0 4 -6.2 8.1 -4.3 1.2 -10-3.1 -2.9-3.1Z" fill="#FFC400" opacity=".55"/>').join("") + "</svg>",
    gk: '<svg class="skc-motif" viewBox="0 0 300 490" opacity=".12" aria-hidden="true"><g fill="none" stroke="#fff" stroke-width="2">' + Array.from({ length: 9 }, (_, i) => '<path d="M' + i * 36 + ' 0V490"/>').join("") + Array.from({ length: 14 }, (_, i) => '<path d="M0 ' + i * 36 + 'H300"/>').join("") + "</g></svg>",
    art: '<svg class="skc-motif" viewBox="0 0 300 490" aria-hidden="true"><path d="M150 470c-70 0-110-50-100-110 8-46 46-62 40-110 34 22 44 52 40 80 20-18 22-50 12-82 60 34 104 90 96 150-6 46-38 72-88 72Z" fill="#FFD27A" opacity=".18"/></svg>',
    con: '<svg class="skc-motif" viewBox="0 0 300 490" aria-hidden="true"><polyline points="10,330 50,300 90,312 130,280 170,290 210,262 250,270 290,240" fill="none" stroke="#fff" stroke-width="4" opacity=".22"/>' + [[10, 330], [50, 300], [90, 312], [130, 280], [170, 290], [210, 262], [250, 270], [290, 240]].map(([x, y]) => '<circle cx="' + x + '" cy="' + y + '" r="6" fill="#fff" opacity=".3"/>').join("") + "</svg>",
  };
  // A carta: um componente só. mode "link" abre o perfil; "share" (perfil) abre a arte; "none" só mostra.
  // Emblema das especiais (SVG, sem emoji), estrelinhas e coroa do Lendário.
  const CARD_EMB = {
    mes: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" fill="currentColor"/>',
    gk: '<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L3.5 13a1.5 1.5 0 0 1 2.6-1.5L7 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    art: '<path d="M12 22c-4 0-7-3-6.5-7 .4-3 2.6-4 2.3-7 2 1.3 2.6 3 2.4 4.6 1.2-1 1.3-3 .7-4.9 3.6 2 6.2 5.4 5.7 9-.4 3-3 5.3-4.6 5.3Z" fill="currentColor"/>',
    con: '<path d="M3 17l5-5 4 3 7-8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 7h4v4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  const CARD_SPK = [[40, 70, 24, 0], [245, 120, 18, 0.6], [50, 250, 16, 1.2], [235, 300, 22, 1.8], [150, 40, 14, 0.9], [262, 215, 16, 1.5], [100, 160, 12, 2.1]]
    .map(([x, y, z, d]) => '<i class="skc-spk" style="left:' + x + "px;top:" + y + "px;--s:" + z + "px;animation-delay:" + d + 's"></i>').join("");
  const CARD_CROWN = '<svg class="skc-crown" viewBox="0 0 24 16" aria-hidden="true" focusable="false"><path d="M2 14 1 3l6 5 5-7 5 7 6-5-1 11Z" fill="currentColor"/></svg>';
  // A carta: um componente só. mode "link" abre o perfil; "share" (perfil) abre a arte; "none" só mostra.
  function cardHtml(info, mode = "link") {
    if (!info) return "";
    const name = displayName(info.name), sp = info.sp, photo = cardPhotoUrl(info.slug), cls = info.cls;
    const size = name.length > 14 ? 22 : name.length > 11 ? 26 : 31;
    const label = mode === "share" ? "Compartilhar a carta de " + name : "Abrir perfil de " + name;
    const attrs = mode === "none" ? ' aria-hidden="true"' : ' role="' + (mode === "share" ? "button" : "link") + '" tabindex="0" aria-label="' + escapeHtml(label) + '" ' + (mode === "share" ? 'data-card-share="' + escapeHtml(info.slug) + '"' : 'data-card-slug="' + escapeHtml(info.slug) + '"');
    const ribbon = sp ? CARD_SP[sp.type][0] + " · " + cardMon(sp.key).charAt(0) + cardMon(sp.key).slice(1).toLowerCase() + (sp.partial ? " · parcial" : "") : "";
    const sparkles = sp || cls === "dia" || cls === "elite" || cls === "lend";
    return '<div class="skc skc-' + cls + (sp ? " skc-sp" : "") + '"' + attrs + '><div class="skc-fr"></div><div class="skc-in">' + (sp ? CARD_MOTIF[sp.type] : "") +
      (sp ? '<span class="skc-emb" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">' + CARD_EMB[sp.type] + '</svg></span><span class="skc-stamp" aria-hidden="true">ESPECIAL</span><span class="skc-rib' + (sp.partial ? " is-partial" : "") + '">' + escapeHtml(ribbon) + "</span>" : "") +
      '<div class="skc-top"><span class="skc-ovr">' + info.ovr + '</span><span class="skc-pos">' + (info.keeper ? "GOL" : "LIN") + "</span></div>" +
      (info.crest ? '<img class="skc-lg" src="' + escapeHtml(info.crest) + '" alt="">' : "") +
      (photo ? '<div class="skc-ph is-photo"><img src="' + escapeHtml(photo) + '" alt="" loading="lazy" decoding="async" width="' + (PLAYER_PHOTO_SIZE[photo]?.[0] || 400) + '" height="' + (PLAYER_PHOTO_SIZE[photo]?.[1] || 400) + '"></div>' : '<div class="skc-ph">' + CARD_SIL + "</div>") +
      '<div class="skc-nm"><b style="font-size:' + size + 'px">' + escapeHtml(name) + "</b></div>" +
      '<div class="skc-st">' + info.stats.map(([k, v]) => "<div><span>" + k + "</span><b>" + escapeHtml(String(v)) + "</b></div>").join("") + "</div>" +
      (sp ? '<div class="skc-hl"><b>' + escapeHtml(sp.hl[0]) + "</b><span>" + escapeHtml(sp.hl[1]) + "</span></div>" : "") +
      '<div class="skc-ft">' + (info.badge && !sp ? "<i>" + escapeHtml(info.badge) + "</i>" : "") + '<span class="skc-tier">' + info.tierText + " · SKALAMA " + cardYear() + "</span></div>" +
      (sp && sp.type === "art" ? '<div class="skc-flame"></div>' : "") + (sparkles ? CARD_SPK : "") + (cls === "lend" ? CARD_CROWN : "") +
      '<div class="skc-glare"></div><div class="skc-shine"></div></div></div>';
  }
  // Nome nunca cortado: o tamanho que cabe é medido UMA vez por nome (cache) e reaproveitado.
  // Animação: no máximo 4 cartas visíveis ao mesmo tempo (classe is-anim). Cada área (galeria, perfil) tem o seu observer,
  // desligado (disconnect) antes de redesenhar e ao sair da tela: nada de segurar cartas antigas na memória.
  const CARD_NAME_FIT = new Map(), CARD_OBS = new Map(), CARD_MAX_ANIM = 6, CARD_RO = new Map();
  // Escala já calculada de cada grade (por largura da tela): ao redesenhar (ex.: trocar o filtro) a carta já nasce no tamanho certo, sem a página "pular".
  const CARD_K = new Map();
  const cardKStyle = (cls) => { const k = CARD_K.get(cls + "|" + innerWidth); return k ? ' style="--k:' + k + '"' : ""; };
  const cardCoarse = () => matchMedia("(pointer: coarse)").matches;
  let cardRenders = 0;
  function cardsUnobserve(root) {
    const obs = root && CARD_OBS.get(root);
    if (obs) { obs.disconnect(); CARD_OBS.delete(root); }
    const ro = root && CARD_RO.get(root);
    if (ro) { ro.disconnect(); CARD_RO.delete(root); }
    root?.querySelectorAll(".skc.is-anim,.skc.is-shine").forEach((c) => c.classList.remove("is-anim", "is-on", "is-shine"));
  }
  function cardsAfterRender(root) {
    cardRenders++;
    root.querySelectorAll(".skc-nm b").forEach((el) => {
      const start = parseFloat(el.style.fontSize) || 31, key = el.textContent + "|" + start;
      let size = CARD_NAME_FIT.get(key);
      if (size == null) {
        size = start; let guard = 0;
        while (el.scrollWidth > el.clientWidth + 0.5 && size > 12 && guard++ < 30) { size -= 1; el.style.fontSize = size + "px"; }
        CARD_NAME_FIT.set(key, size);
      }
      if (size !== start) el.style.fontSize = size + "px";
    });
    cardsObserve(root);
  }
  // Escala pela largura real da coluna (--k = coluna / 300, até o máximo da grade): nunca encosta nem sobrepõe.
  function cardsFitGrids(root) {
    const grids = [...root.querySelectorAll(".cards-grid")];
    if (!grids.length || !("ResizeObserver" in window)) return;
    // Só a LARGURA importa; a escala é aplicada no quadro seguinte (mudar --k muda a altura e não pode realimentar o observer).
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      if (!entries.some((e) => Math.abs((e.target.__skcW || 0) - e.contentRect.width) > 0.5)) return;
      entries.forEach((e) => { e.target.__skcW = e.contentRect.width; });
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => grids.forEach((grid) => {
      const slot = grid.querySelector(".skc-slot"); if (!slot) return;
      const [lo, hi] = String(grid.dataset.kmax || "1").split("|").map(Number), max = (innerWidth >= 760 ? hi ?? lo : lo) || 1;
      const cs = getComputedStyle(slot), w = slot.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); // folga do slot para o brilho
      const k = Math.max(0.3, Math.min(max, w / 300));
      const cls = [...grid.classList].find((c) => c !== "cards-grid") || "cards-grid";
      CARD_K.set(cls + "|" + innerWidth, String(k));
      if (grid.style.getPropertyValue("--k") !== String(k)) {
        grid.style.setProperty("--k", String(k));
        // O Safari às vezes não reaplica a escala herdada da grade: grava também em cada carta.
        grid.querySelectorAll(".skc-fit,.skc-fit>.skc").forEach((el) => el.style.setProperty("--k", String(k)));
      }
      }));
    });
    grids.forEach((grid) => ro.observe(grid));
    CARD_RO.set(root, ro);
  }
  // Animação só nas cartas visíveis: no máximo 6 ao mesmo tempo (especiais primeiro). No celular, o brilho que passa
  // fica só na carta mais perto do centro da tela.
  function cardsObserve(root) {
    cardsUnobserve(root);
    cardsFitGrids(root);
    const cards = [...root.querySelectorAll(".skc")];
    if (!cards.length) return;
    if (!("IntersectionObserver" in window)) { cards.slice(0, CARD_MAX_ANIM).forEach((c) => c.classList.add("is-on", "is-anim")); return; }
    const visible = new Map();
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => (e.isIntersecting ? visible.set(e.target, e.intersectionRatio) : visible.delete(e.target)));
      const vis = cards.filter((c) => visible.has(c));
      const pick = new Set([...vis.filter((c) => c.classList.contains("skc-sp")), ...vis.filter((c) => !c.classList.contains("skc-sp"))].slice(0, CARD_MAX_ANIM));
      let shine = null;
      if (cardCoarse() && vis.length) {
        const mid = innerHeight / 2;
        shine = vis.reduce((best, c) => { const r = c.getBoundingClientRect(), d = Math.abs(r.top + r.height / 2 - mid); return !best || d < best.d ? { c, d } : best; }, null).c;
      }
      cards.forEach((c) => { const on = pick.has(c); c.classList.toggle("is-anim", on); c.classList.toggle("is-on", on); c.classList.toggle("is-shine", on && (!shine || c === shine)); });
    }, { rootMargin: "40px", threshold: [0, 0.35, 0.7, 1] });
    cards.forEach((c) => obs.observe(c));
    CARD_OBS.set(root, obs);
  }
  // Reflexo que segue o mouse (só no PC; no celular fica parado).
  let cardGlareRaf = 0;
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || cardGlareRaf) return;
    const card = event.target.closest?.(".skc");
    if (!card) return;
    cardGlareRaf = requestAnimationFrame(() => {
      cardGlareRaf = 0;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", (((event.clientX - r.left) / r.width) * 100).toFixed(1) + "%");
      card.style.setProperty("--my", (((event.clientY - r.top) / r.height) * 100).toFixed(1) + "%");
    });
  }, { passive: true });
  function cardOpen(slug) { if (slug) location.hash = "#jogador/" + slug; }
  document.addEventListener("click", (event) => {
    const share = event.target.closest?.("[data-card-share]");
    if (share) { cardShareArt(share.dataset.cardShare); return; }
    const card = event.target.closest?.("[data-card-slug]");
    if (card) cardOpen(card.dataset.cardSlug);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const el = event.target.closest?.("[data-card-slug],[data-card-share]");
    if (!el || el !== event.target) return;
    event.preventDefault();
    el.click();
  });
  // ----- Página "Cartas dos jogadores" -----
  function cardsOpen() { cardLoadWinners(); renderCards(); }
  function cardsUnmount() {
    const box = $("cartas");
    if (!box || !box.firstElementChild) return;
    cardsUnobserve(box); box.innerHTML = ""; box.dataset.key = "";
  }
  function cardsRefresh() {
    if (location.hash === "#cartas") renderCards();
    if (PF.slug) renderProfile();
    renderHomeLinks();
  }
  const CARD_FILTERS = [["all", "Todas"], ["prata", "🥈 Prata"], ["ouro", "🥇 Ouro"], ["dia", "💎 Diamante"], ["elite", "🔮 Elite"], ["lend", "👑 Lendário"], ["gk", "🧤 Goleiros"]];
  function renderCards() {
    const box = $("cartas");
    if (!box) return;
    const data = cardsData(), f = CARDS.filter;
    // Nada mudou (mesmos dados, mesmo filtro): não mexe no DOM.
    const key = CARDS.sig + "|" + f + "|" + officialGames().length;
    if (box.dataset.key === key && box.firstElementChild) return;
    cardsUnobserve(box);
    box.dataset.key = key;
    const slot = (info) => '<div class="skc-slot"><div class="skc-fit">' + cardHtml(info) + "</div></div>";
    const specials = CARD_SP_ORDER.map((type) => data.cur[type]).filter(Boolean);
    // "Cartas por nota": sempre a carta de NÍVEL de cada um (a especial fica só no palco de cima), ninguém aparece duas vezes.
    const list = data.players.filter((c) => f === "all" || (f === "gk" ? c.keeper : c.tier === f)).map((c) => cardInfo(c.slug, null, data));
    const spRow = (types, kmax, cls) => { const row = types.map((t) => data.cur[t]).filter(Boolean); return row.length ? '<div class="cards-grid cards-sp-' + cls + '" data-kmax="' + kmax + '"' + cardKStyle("cards-sp-" + cls) + ">" + row.map((sp) => slot(cardInfo(sp.slug, sp, data))).join("") + "</div>" : ""; };
    const kBig = "0.52|1.05", kSmall = "0.52|0.78"; // celular | PC (≥ 760px): limite da escala; a coluna real manda (cardsFitGrids)
    const nothing = !officialGames().length;
    box.innerHTML = '<div class="cards-wrap"><a class="pv-back cards-back" href="./" data-cards-back>← Voltar</a>' +
      '<header class="cards-head"><img src="./assets/escudo-skalama-oficial.png" alt="" width="48" height="64"><div><h2 id="cardsTitle">Coleção de cartas <span>Skalama</span></h2><p>Temporada ' + cardYear() + " · Modo Liga e Super Liga</p></div></header>" +
      (nothing ? '<p class="cards-empty">As cartas aparecem depois dos primeiros jogos.</p>' :
        (specials.length ? '<section class="cards-stage" aria-labelledby="cardsSpTitle"><h3 class="cards-stage-h" id="cardsSpTitle">⭐ Especiais do mês</h3><p class="cards-stage-sub">' + escapeHtml(monthLabel(data.curKey).split(" ")[0]) + (specials.some((x) => x.partial) ? " (parcial)" : "") + " · uma de cada · só o artilheiro pode repetir</p>" +
          spRow(["mes", "art"], kBig, "big") + spRow(["gk", "con"], kSmall, "small") + "</section>" : "") +
        '<section class="cards-sec" aria-labelledby="cardsAllTitle"><h3 class="cards-h" id="cardsAllTitle">Cartas por nota <small>' + data.players.length + (data.players.length === 1 ? " carta" : " cartas") + "</small></h3>" +
        '<div class="cards-filters" role="group" aria-label="Filtrar cartas">' + CARD_FILTERS.map(([key, label]) => '<button type="button" class="cards-filter' + (f === key ? " is-on" : "") + '" data-cards-filter="' + key + '" aria-pressed="' + (f === key) + '">' + label + "</button>").join("") + "</div>" +
        cardsListHtml(list, slot) + "</section>" +
        (data.waiting.length ? '<section class="cards-wait" aria-labelledby="cardsWaitTitle"><h3 id="cardsWaitTitle">Ainda sem carta (menos de 3 jogos)</h3><p>A carta aparece depois do 3º jogo oficial (goleiro: 3 jogos no gol).</p><ul>' + data.waiting.map((c) => "<li>" + plink(c.name, displayName(c.name) + " · " + c.games + (c.games === 1 ? " jogo" : " jogos")) + "</li>").join("") + "</ul></section>" : "")) +
      '<section class="cards-legend" aria-label="Como funcionam as cartas"><div><b>🥈 Prata</b>Nota média abaixo de 6,0. A carta de entrada: todo mundo com 3 jogos oficiais ganha uma.</div><div><b>🥇 Ouro (6,0 a 6,9)</b>Dourada clássica, com brilho passando.</div><div><b>💎 Diamante (7,0 a 7,9)</b>Azul gelo com facetas de cristal, moldura girando e estrelinhas.</div><div><b>🔮 Elite (8,0 a 8,9)</b>Roxa: moldura holográfica, brilho roxo forte e reflexo de figurinha rara.</div><div><b>👑 Lendário (9,0+)</b>Preta com coroa, moldura arco-íris girando rápido, fundo em movimento e nome dourado. Raríssima.</div>' +
      '<div><b>⭐ Jogador do mês</b>Maior nota média do mês (mínimo 3 jogos). Ouro vibrante com raios de sol. Carta grande, no topo.</div><div><b>🔥 Artilheiro do mês</b>Mais gols no mês (empate: menos jogos, depois maior nota). Fogo vivo. Carta grande, no topo.</div><div><b>🧤 Goleiro do mês</b>Melhor goleiro do mês (mínimo 3 jogos no gol). Verde.</div><div><b>📈 Constância</b>Menor variação de nota no mês, com 4 jogos ou mais e média 7,0+. Azul Skalama.</div></section></div>';
    cardsAfterRender(box);
  }
  function cardsListHtml(list, slot) {
    return list.length ? '<div class="cards-grid cards-all" data-kmax="1"' + cardKStyle("cards-all") + ">" + list.map(slot).join("") + "</div>" : '<p class="cards-empty">Nenhuma carta neste filtro.</p>';
  }
  // Trocar o filtro refaz SÓ a lista "Cartas por nota": o palco e os botões não se mexem (nada de a página pular no meio do toque).
  function renderCardsFilter() {
    const box = $("cartas"), sec = box?.querySelector(".cards-sec"), old = sec?.querySelector(".cards-all, .cards-empty");
    if (!old) { box.dataset.key = ""; renderCards(); return; }
    const data = cardsData(), f = CARDS.filter;
    const list = data.players.filter((c) => f === "all" || (f === "gk" ? c.keeper : c.tier === f)).map((c) => cardInfo(c.slug, null, data));
    sec.querySelectorAll("[data-cards-filter]").forEach((b) => { const on = b.dataset.cardsFilter === f; b.classList.toggle("is-on", on); b.setAttribute("aria-pressed", String(on)); });
    cardsUnobserve(box);
    old.outerHTML = cardsListHtml(list, (info) => '<div class="skc-slot"><div class="skc-fit">' + cardHtml(info) + "</div></div>");
    box.dataset.key = CARDS.sig + "|" + f + "|" + officialGames().length;
    cardsAfterRender(box);
  }
  document.addEventListener("click", (event) => {
    const f = event.target.closest?.("[data-cards-filter]");
    if (f) { CARDS.filter = f.dataset.cardsFilter; renderCardsFilter(); return; }
    if (event.target.closest?.("[data-cards-back]")) { event.preventDefault(); cardsClose(); }
  });
  function cardsClose() {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else { history.pushState(null, "", location.pathname + location.search); document.body.classList.remove("pv-standalone"); setView("home"); }
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && location.hash === "#cartas" && !PF.slug && !document.querySelector("dialog[open]")) cardsClose();
  });
  // ----- Perfil: carta grande, carta da temporada e cartas especiais -----
  function profileCardsHtml(slug) {
    const data = cardsData(), base = data.bySlug.get(slug);
    if (!base) return "";
    cardLoadWinners();
    if (!base.eligible) return '<section class="pf-cardbox is-empty"><p>A carta aparece depois do 3º jogo oficial' + (base.keeper ? " no gol" : "") + " (" + Math.min(base.games, 3) + " de 3).</p></section>";
    const sp = cardSpecialOf(slug, data);
    return '<section class="pf-cardbox" aria-label="Carta do jogador"><div class="pf-cardfit">' + cardHtml(cardInfo(slug, sp, data), "share") + "</div>" +
      '<div class="pf-cardacts"><button type="button" class="pf-cardbtn is-y" data-card-share="' + escapeHtml(slug) + '">📲 Compartilhar carta</button><a class="pf-cardbtn is-o" href="#cartas">Ver todas as cartas</a></div></section>';
  }
  function profileCardsExtraHtml(slug) {
    const data = cardsData(), base = data.bySlug.get(slug);
    if (!base) return "";
    const sp = base.eligible && cardSpecialOf(slug, data);
    const past = [];
    for (const m of data.months) for (const type of CARD_SP_ORDER) if (m.specials[type]?.slug === slug && !(m.key === data.curKey && sp && sp.type === type)) past.push({ key: m.key, type });
    return (sp ? '<section class="pf-card" aria-labelledby="pfSeasonTitle"><h3 id="pfSeasonTitle" class="pf-h">CARTA DA TEMPORADA</h3><div class="pf-seasonfit">' + cardHtml(cardInfo(slug, null, data), "none") + "</div></section>" : "") +
      (past.length ? '<section class="pf-card" aria-labelledby="pfSpTitle"><h3 id="pfSpTitle" class="pf-h">CARTAS ESPECIAIS</h3><ul class="pf-ach">' + past.map((x) => '<li><span aria-hidden="true">' + CARD_SP[x.type][1] + "</span><strong>" + CARD_SP[x.type][0] + "</strong><small>" + escapeHtml(monthLabel(x.key)) + "</small></li>").join("") + "</ul></section>" : "");
  }
  // "Compartilhar carta": abre a Divulgação com a arte da carta já escolhida.
  function cardShareArt(slug) {
    const data = cardsData(), sp = cardSpecialOf(slug, data);
    ART.type = "card"; ART.cardSlug = slug; ART.cardKind = sp ? sp.type : "level";
    history.pushState(null, "", location.pathname + location.search);
    pfPrevHash = ""; closeProfile();
    document.body.classList.remove("pv-standalone");
    setView("arte"); renderArt();
    window.scrollTo({ top: 0 });
    // Celular: compartilha o PNG; PC: baixa.
    const mobile = matchMedia("(pointer: coarse)").matches;
    (async () => {
      const file = await artFile();
      if (mobile && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Carta Skalama" }); return; } catch (error) { if (error.name === "AbortError") return; } }
      if (!mobile) downloadArt();
    })();
  }
  // ----- Tela principal: cards de atalho (Hall da fama, Cartas, Regras) -----
  function renderHomeLinks() {
    const hallChip = $("hkHallChip"), cardChip = $("hkCardsChip"), isNew = $("hkCardsNew");
    if (!hallChip || !state) return;
    const champ = superChampions()[0];
    hallChip.textContent = champ ? "🏆 Último campeão: " + gameTeamLabel(champ, champ.winner === champ.home ? "home" : "away") : "🏆 Campeões e recordes";
    const data = cardsData();
    cardChip.textContent = data.players.length ? "🃏 " + data.players.length + (data.players.length === 1 ? " carta" : " cartas") + " · melhor: " + data.players[0].ovr : "🃏 Saem depois do 3º jogo";
    isNew.hidden = nowMs() > CARD_NEW_UNTIL;
  }
  // ----- Divulgação: arte "Carta do jogador" (canvas) -----
  const AX_CARD_COLORS = {
    prata: { f: ["#FFFFFF", "#8E8E88", "#E6E6E2", "#8E8E88", "#FFFFFF"], b: ["#F4F4F1", "#C9C9C4", "#8E8E88"], t: "#141414", sub: "#3A3A35", line: "rgba(0,0,0,.15)", bar: "#0B0B0B", barT: "#FFC400" },
    ouro: { f: ["#FFF1A8", "#B8860B", "#FFE27A", "#B8860B", "#FFF1A8"], b: ["#FFE07A", "#E0A800", "#9C7400"], t: "#1A1200", sub: "#5C4500", line: "rgba(0,0,0,.15)", bar: "#0B0B0B", barT: "#FFC400" },
    dia: { f: ["#FFFFFF", "#A5F3FC", "#22D3EE", "#FFFFFF", "#BAE6FD", "#67E8F9", "#FFFFFF"], b: ["#E0FBFF", "#67E8F9", "#0E7490"], t: "#04222B", sub: "#0B4A5A", line: "rgba(0,0,0,.13)", bar: "#04222B", barT: "#A5F3FC", glow: "rgba(34,211,238,.5)", facets: true },
    elite: { f: ["#F3E8FF", "#A855F7", "#22D3EE", "#F0ABFC", "#7C3AED", "#FDE68A", "#F3E8FF"], b: ["#7C3AED", "#4C1D95", "#1E0A3C"], t: "#FFFFFF", sub: "#E9D5FF", line: "rgba(255,255,255,.18)", bar: ["#4C1D95", "#9333EA", "#C084FC", "#9333EA", "#4C1D95"], barT: "#FFFFFF", ovr: "#F3E8FF", glow: "rgba(168,85,247,.7)", rays: "rgba(255,255,255,.08)" },
    lend: { f: ["#FFD700", "#FF3D6E", "#A855F7", "#22D3EE", "#4ADE80", "#FFD700", "#FF8A00", "#FFD700"], b: ["#2A0010", "#120008", "#000000"], t: "#FFE58A", sub: "#FFD700", line: "rgba(255,215,0,.2)", bar: ["#7A0019", "#FFD700", "#FFF7D6", "#FFD700", "#7A0019"], barT: "#1A0008", ovr: "#FFD700", glow: "rgba(255,215,0,.65)", rays: "rgba(255,215,0,.1)", fw: 9, crown: true },
    mes: { f: ["#FFFBE0", "#FFE14D", "#FF9500", "#FFFBE0", "#FFFFFF", "#FFE14D"], b: ["#FFE347", "#FFB300", "#E06A00"], t: "#1A0F00", sub: "#5A3300", line: "rgba(0,0,0,.15)", bar: "#0B0B0B", barT: "#FFD400", acc: "#0B0B0B", accT: "#FFD400", rib: "#0B0B0B", ribT: "#FFD400", glow: "rgba(255,196,0,.75)", rays: "rgba(255,255,255,.25)", fw: 9 },
    art: { f: ["#FFF0C2", "#FF8A00", "#C81E00", "#FFF0C2", "#FFFFFF", "#FF8A00"], b: ["#FF9A1F", "#FF3D00", "#8A0C00"], t: "#FFFFFF", sub: "#FFE7B0", line: "rgba(255,255,255,.18)", bar: "#0B0B0B", barT: "#FFB21F", acc: "#0B0B0B", accT: "#FFB21F", rib: "#0B0B0B", ribT: "#FFB21F", glow: "rgba(255,77,0,.75)", flame: true, fw: 9 },
    gk: { f: ["#C9F7D8", "#3DBA6E", "#14532D", "#C9F7D8", "#FFFFFF", "#3DBA6E"], b: ["#2E8F55", "#1F6E3A", "#0B3A1E"], t: "#FFFFFF", sub: "#C9F7D8", line: "rgba(255,255,255,.16)", bar: "#0B0B0B", barT: "#3DBA6E", acc: "#0B0B0B", accT: "#3DBA6E", rib: "#0B0B0B", ribT: "#3DBA6E", glow: "rgba(61,186,110,.45)", net: true, fw: 9 },
    con: { f: ["#D6E0FF", "#7A9BFF", "#1A2F75", "#D6E0FF", "#FFFFFF", "#7A9BFF"], b: ["#3B5FCC", "#23439C", "#0E1D4D"], t: "#FFFFFF", sub: "#D6E0FF", line: "rgba(255,255,255,.16)", bar: "#0B0B0B", barT: "#7A9BFF", acc: "#0B0B0B", accT: "#7A9BFF", rib: "#0B0B0B", ribT: "#7A9BFF", glow: "rgba(79,123,255,.45)", chart: true, fw: 9 },
  };
  function axCardInfo() {
    const data = cardsData(), slug = ART.cardSlug && data.bySlug.get(ART.cardSlug)?.eligible ? ART.cardSlug : data.players[0]?.slug;
    if (!slug) return { warn: "As cartas aparecem depois do 3º jogo oficial de cada jogador." };
    ART.cardSlug = slug;
    const sp = ART.cardKind && ART.cardKind !== "level" ? data.cur[ART.cardKind] : null;
    const special = sp && sp.slug === slug ? sp : null;
    if (!special) ART.cardKind = "level";
    return { type: "card", card: { ...cardInfo(slug, special, data), photo: cardPhotoUrl(slug) } };
  }
  function axCardShape(ctx, x, y, w, h) {
    ctx.beginPath();
    ctx.moveTo(x + w * 0.16, y); ctx.lineTo(x + w * 0.84, y); ctx.lineTo(x + w, y + h * 0.06); ctx.lineTo(x + w, y + h * 0.86);
    ctx.lineTo(x + w * 0.5, y + h); ctx.lineTo(x, y + h * 0.86); ctx.lineTo(x, y + h * 0.06); ctx.closePath();
  }
  // Desenha a carta (300×490 de referência) na escala s, com o canto de cima à esquerda em (x, y).
  // Mesmo layout da carta do site; as animações viram degradês parados (o canvas não anima).
  function axDrawCardShape(ctx, info, x, y, s) {
    const c = AX_CARD_COLORS[info.cls] || AX_CARD_COLORS.ouro, W = 300 * s, H = 490 * s, sp = info.sp, fw = (c.fw || 6) * s;
    const grad = (x0, y0, x1, y1, stops) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); stops.forEach((col, i) => g.addColorStop(i / Math.max(1, stops.length - 1), col)); return g; };
    // Brilho em volta e moldura
    ctx.save();
    if (c.glow) { ctx.shadowColor = c.glow; ctx.shadowBlur = 70 * s; }
    axCardShape(ctx, x, y, W, H); ctx.fillStyle = grad(x, y, x + W, y + H, c.f); ctx.fill();
    ctx.restore();
    // Miolo
    const ix = x + fw, iy = y + fw, iw = W - fw * 2, ih = H - fw * 2;
    ctx.save();
    axCardShape(ctx, ix, iy, iw, ih); ctx.clip();
    ctx.fillStyle = grad(ix, iy, ix + iw * 0.3, iy + ih, c.b); ctx.fillRect(ix, iy, iw, ih);
    const light = ctx.createRadialGradient(ix + iw * 0.58, iy + ih * 0.29, 0, ix + iw * 0.58, iy + ih * 0.29, iw * 0.6);
    light.addColorStop(0, info.cls === "mes" ? "rgba(255,251,224,.9)" : "rgba(255,255,255,.4)"); light.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = light; ctx.fillRect(ix, iy, iw, ih);
    if (c.rays) { ctx.save(); ctx.fillStyle = c.rays; const cx0 = ix + iw * 0.55, cy0 = iy + ih * 0.31; for (let a = 0; a < 360; a += 12) { const r1 = (a * Math.PI) / 180, r2 = ((a + 6) * Math.PI) / 180; ctx.beginPath(); ctx.moveTo(cx0, cy0); ctx.lineTo(cx0 + Math.cos(r1) * H, cy0 + Math.sin(r1) * H); ctx.lineTo(cx0 + Math.cos(r2) * H, cy0 + Math.sin(r2) * H); ctx.closePath(); ctx.fill(); } ctx.restore(); }
    if (c.facets) { ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.3)"; ctx.lineWidth = s; for (let k = -ih * 2; k < iw + ih * 2; k += 34 * s) { ctx.beginPath(); ctx.moveTo(ix + k, iy); ctx.lineTo(ix + k + ih * 0.577, iy + ih); ctx.stroke(); ctx.beginPath(); ctx.moveTo(ix + k, iy); ctx.lineTo(ix + k - ih * 0.577, iy + ih); ctx.stroke(); } ctx.restore(); }
    else { ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 2 * s; for (let k = -ih; k < iw + ih; k += 12 * s) { ctx.beginPath(); ctx.moveTo(ix + k, iy); ctx.lineTo(ix + k - ih * 0.58, iy + ih); ctx.stroke(); } }
    if (c.net) { ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * s; for (let k = 0; k < 9; k++) { ctx.beginPath(); ctx.moveTo(x + k * 36 * s, y); ctx.lineTo(x + k * 36 * s, y + H); ctx.stroke(); } for (let k = 0; k < 14; k++) { ctx.beginPath(); ctx.moveTo(x, y + k * 36 * s); ctx.lineTo(x + W, y + k * 36 * s); ctx.stroke(); } ctx.restore(); }
    if (c.chart) { ctx.save(); ctx.globalAlpha = 0.22; ctx.strokeStyle = "#fff"; ctx.lineWidth = 4 * s; ctx.beginPath(); [[10, 330], [50, 300], [90, 312], [130, 280], [170, 290], [210, 262], [250, 270], [290, 240]].forEach(([px, py], k) => (k ? ctx.lineTo(x + px * s, y + py * s) : ctx.moveTo(x + px * s, y + py * s))); ctx.stroke(); ctx.restore(); }
    if (c.flame) { ctx.save(); ctx.globalCompositeOperation = "screen"; [[0.2, 0.3, 0.6, "rgba(255,210,90,.8)"], [0.5, 0.26, 0.7, "rgba(255,229,143,.8)"], [0.8, 0.3, 0.55, "rgba(255,194,58,.8)"]].forEach(([fx, rx, ry, col]) => { const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.save(); ctx.translate(ix + iw * fx, iy + ih); ctx.scale(iw * rx, ih * 0.62 * ry); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }); ctx.restore(); }
    if (info.cls === "mes") [[40, 90, 9], [250, 150, 7], [60, 200, 6], [230, 60, 5], [150, 40, 4], [270, 220, 6], [30, 150, 4]].forEach(([sx, sy, r]) => { ctx.save(); ctx.globalAlpha = 0.55; axStar(ctx, x + sx * s, y + sy * s, r * s, "#FFFFFF"); ctx.restore(); });
    const shield = axImg(AX_SHIELD);
    if (shield) { ctx.save(); ctx.globalAlpha = sp ? 0.1 : 0.08; if ("filter" in ctx) ctx.filter = "grayscale(1)"; const sw = 250 * s, sh = (sw * shield.naturalHeight) / shield.naturalWidth; ctx.drawImage(shield, x + W / 2 - sw / 2, y + H * 0.66 - sh / 2, sw, sh); ctx.restore(); }
    // Especiais: emblema redondo, faixa "TIPO · MÊS"
    if (sp) {
      ctx.save(); ctx.beginPath(); ctx.arc(x + W / 2, iy + 27 * s, 29 * s, 0, Math.PI * 2); ctx.fillStyle = c.rib; ctx.fill(); ctx.lineWidth = 3 * s; ctx.strokeStyle = c.f[0]; ctx.stroke();
      // Mesmo ícone SVG do site (Path2D lê os caminhos do SVG).
      const paths = { mes: [["M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z", 1]], art: [["M12 22c-4 0-7-3-6.5-7 .4-3 2.6-4 2.3-7 2 1.3 2.6 3 2.4 4.6 1.2-1 1.3-3 .7-4.9 3.6 2 6.2 5.4 5.7 9-.4 3-3 5.3-4.6 5.3Z", 1]],
        gk: [["M7 11V5.5a1.5 1.5 0 0 1 3 0V10m0-4.5a1.5 1.5 0 0 1 3 0V10m0-3.5a1.5 1.5 0 0 1 3 0V11m0-2a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4L3.5 13a1.5 1.5 0 0 1 2.6-1.5L7 13", 0]], con: [["M3 17l5-5 4 3 7-8", 0], ["M15 7h4v4", 0]] }[sp.type];
      if (typeof Path2D === "function") { ctx.translate(x + W / 2 - 15 * s, iy + 12 * s); ctx.scale(1.25 * s, 1.25 * s); ctx.fillStyle = ctx.strokeStyle = c.ribT; ctx.lineWidth = sp.type === "con" ? 2.6 : 2; ctx.lineCap = ctx.lineJoin = "round"; paths.forEach(([d, fill]) => { const path = new Path2D(d); if (fill) ctx.fill(path); else ctx.stroke(path); }); }
      ctx.restore();
      const text = (CARD_SP[sp.type][0] + " · " + cardMon(sp.key) + (sp.partial ? " · PARCIAL" : "")).toUpperCase(), fs = (sp.type === "mes" || sp.type === "art" ? 17 : 15) * s;
      ctx.font = "900 " + fs + 'px "Barlow Condensed", sans-serif'; axSpacing(ctx, 2 * s);
      const tw = ctx.measureText(text).width + 32 * s;
      ctx.fillStyle = c.rib; axRound(ctx, x + W / 2 - tw / 2, iy + 58 * s, tw, fs + 12 * s, 8 * s); ctx.fill();
      ctx.fillStyle = c.ribT; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x + W / 2, iy + 58 * s + (fs + 12 * s) / 2 + s); axSpacing(ctx, 0);
    }
    if (c.crown) { ctx.save(); ctx.fillStyle = "#FFD700"; const cw = 46 * s, ch = 30 * s, cx0 = x + W / 2 - cw / 2, cy0 = iy + 4 * s; ctx.beginPath(); [[2, 14], [1, 3], [7, 8], [12, 1], [17, 8], [23, 3], [22, 14]].forEach(([px, py], k) => (k ? ctx.lineTo(cx0 + (px / 24) * cw, cy0 + (py / 16) * ch) : ctx.moveTo(cx0 + (px / 24) * cw, cy0 + (py / 16) * ch))); ctx.closePath(); ctx.fill(); ctx.restore(); }
    const oy = sp ? 60 * s : 0, py = sp ? 56 * s : 0;
    // Nota e posição (canto de cima à esquerda); escudo do time no canto de cima à direita
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const cx = ix + 54 * s;
    ctx.fillStyle = c.ovr || c.t; axFont(ctx, 0, 62 * s, true); ctx.fillText(String(info.ovr), cx, iy + 84 * s + oy);
    ctx.fillStyle = c.sub; ctx.font = "900 " + 20 * s + 'px "Barlow Condensed", sans-serif'; axSpacing(ctx, 2 * s); ctx.fillText(info.keeper ? "GOL" : "LIN", cx, iy + 108 * s + oy); axSpacing(ctx, 0);
    const crest = axImg(info.crest);
    if (crest) { const r = crest.naturalWidth / crest.naturalHeight, w = r >= 1 ? 46 * s : 46 * s * r, h = r >= 1 ? (46 * s) / r : 46 * s; ctx.drawImage(crest, ix + iw - 22 * s - 46 * s + (46 * s - w) / 2, iy + 26 * s + (sp ? 66 * s : 0) + (46 * s - h) / 2, w, h); }
    // Foto do jogador (mesma área da carta: do canto da nota até a borda direita, some em degradê atrás da faixa do nome)
    const photo = axImg(info.photo);
    if (photo) {
      const ax0 = ix + 44 * s, aw = iw - 50 * s, at = iy + (sp ? 84 : 18) * s, ah = (sp ? 142 : 206) * s;
      const r = photo.naturalWidth / photo.naturalHeight; let dh = ah, dw = dh * r; if (dw > aw) { dw = aw; dh = dw / r; }
      const off = document.createElement("canvas"); off.width = Math.ceil(aw); off.height = Math.ceil(ah);
      const o = off.getContext("2d"); o.drawImage(photo, (aw - dw) / 2, ah - dh, dw, dh);
      const fade = o.createLinearGradient(0, 0, 0, ah); fade.addColorStop(0.7, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
      o.globalCompositeOperation = "destination-in"; o.fillStyle = fade; o.fillRect(0, 0, aw, ah);
      ctx.drawImage(off, ax0, at);
    } else {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "#000";
    const k = sp ? 120 / 176 : 1, pcx = ix + 70 * s + (iw - 90 * s) / 2, ptop = iy + 40 * s + py, base = ptop + 176 * s * (sp ? 120 / 176 : 1);
    ctx.beginPath(); ctx.arc(pcx, base - (176 - 62) * s * k, 38 * s * k, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(pcx - 73 * s * k, base); ctx.bezierCurveTo(pcx - 68 * s * k, base - 46 * s * k, pcx - 39 * s * k, base - 72 * s * k, pcx, base - 72 * s * k); ctx.bezierCurveTo(pcx + 39 * s * k, base - 72 * s * k, pcx + 68 * s * k, base - 46 * s * k, pcx + 73 * s * k, base); ctx.closePath(); ctx.fill();
    ctx.restore();
    }
    // Nome em faixa de ponta a ponta
    const name = displayName(info.name).toUpperCase(), bandX = ix + 6 * s, bandW = iw - 12 * s;
    let size = (name.length > 14 ? 22 : name.length > 11 ? 26 : 31) * s;
    ctx.font = "900 " + size + 'px "Barlow Condensed", sans-serif';
    while (ctx.measureText(name).width > bandW - 20 * s && size > 10 * s) { size -= s; ctx.font = "900 " + size + 'px "Barlow Condensed", sans-serif'; }
    const ny = iy + (sp ? 224 : 220) * s, bh = size + 14 * s;
    ctx.fillStyle = Array.isArray(c.bar) ? grad(bandX, 0, bandX + bandW, 0, c.bar) : c.bar; ctx.fillRect(bandX, ny, bandW, bh);
    ctx.fillStyle = c.barT; ctx.textBaseline = "middle"; ctx.fillText(name, x + W / 2, ny + bh / 2 + s);
    // Estatísticas 3×2 (rótulo 11, número 30; especiais 24)
    const sy = iy + (sp ? 270 : 272) * s, colW = (iw - 60 * s) / 3, rowH = (sp ? 48 : 55) * s;
    info.stats.forEach(([key, v], i) => {
      const col = i % 3, row = Math.floor(i / 3), scx = ix + 30 * s + colW * col + colW / 2, top = sy + row * rowH;
      if (col) { ctx.fillStyle = c.line; ctx.fillRect(ix + 30 * s + colW * col, top, s, rowH - 6 * s); }
      ctx.fillStyle = c.sub; axFont(ctx, 800, 11 * s); axSpacing(ctx, 1.5 * s); ctx.textBaseline = "top"; ctx.fillText(key, scx, top); axSpacing(ctx, 0);
      ctx.fillStyle = c.t; axFont(ctx, 0, (sp ? 24 : 30) * s, true); ctx.fillText(String(v), scx, top + 16 * s);
    });
    ctx.textBaseline = "alphabetic";
    // Pílula de destaque das especiais (com borda)
    if (sp) {
      axFont(ctx, 0, 26 * s, true); const bw = ctx.measureText(sp.hl[0]).width; axFont(ctx, 800, 11 * s); axSpacing(ctx, 1.5 * s); const lw = ctx.measureText(sp.hl[1]).width; axSpacing(ctx, 0);
      const pw = bw + lw + 34 * s, ph = 38 * s, pyy = iy + ih - 74 * s - ph;
      ctx.fillStyle = c.acc; axRound(ctx, x + W / 2 - pw / 2, pyy, pw, ph, 12 * s); ctx.fill(); ctx.lineWidth = 2 * s; ctx.strokeStyle = c.f[0]; ctx.stroke();
      ctx.fillStyle = c.accT; ctx.textAlign = "left"; axFont(ctx, 0, 26 * s, true); ctx.fillText(sp.hl[0], x + W / 2 - pw / 2 + 14 * s, pyy + 29 * s);
      axFont(ctx, 800, 11 * s); axSpacing(ctx, 1.5 * s); ctx.fillText(sp.hl[1], x + W / 2 - pw / 2 + 20 * s + bw, pyy + 25 * s); axSpacing(ctx, 0); ctx.textAlign = "center";
    }
    // Rodapé
    const fy = iy + ih - (sp ? 50 : 46) * s;
    if (info.badge && !sp) { axFont(ctx, 800, 10 * s); axSpacing(ctx, 1.5 * s); const bw = ctx.measureText(info.badge).width + 20 * s; ctx.fillStyle = c.acc || "#0B0B0B"; axRound(ctx, x + W / 2 - bw / 2, fy - 34 * s, bw, 20 * s, 10 * s); ctx.fill(); ctx.fillStyle = c.accT || "#FFC400"; ctx.textBaseline = "middle"; ctx.fillText(info.badge, x + W / 2, fy - 24 * s); axSpacing(ctx, 0); }
    ctx.fillStyle = c.sub; axFont(ctx, 800, 9 * s); axSpacing(ctx, 3 * s); ctx.textBaseline = "alphabetic"; ctx.fillText(info.tierText + " · SKALAMA " + cardYear(), x + W / 2, fy); axSpacing(ctx, 0);
    // Reflexo holográfico parado (Elite, Lendário e especiais)
    if (sp || info.cls === "elite" || info.cls === "lend") { ctx.save(); ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.5; ctx.fillStyle = grad(ix, iy, ix + iw, iy + ih, ["rgba(0,0,0,0)", "rgba(255,0,200,.4)", "rgba(0,229,255,.4)", "rgba(255,243,92,.35)", "rgba(0,0,0,0)"]); ctx.fillRect(ix, iy, iw, ih); ctx.restore(); }
    ctx.restore();
  }
  function axDrawCard(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70, card = info.card;
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: card.sp ? CARD_SP[card.sp.type][0].toUpperCase() : "CARTA DO JOGADOR", style: "yellow" }], story) + (story ? 40 : 24);
    const avail = bottom - 60 - y, s = Math.min(avail / 490, (W - 200) / 300), cw = 300 * s;
    axDrawCardShape(ctx, card, (W - cw) / 2, y + (avail - 490 * s) / 2, s);
    axFooter(ctx, W, bottom - 6);
  }
  function renderAll() {
    if (!state) return;
    fixLegacyPause();
    renderDrawMode();
    renderElStrength();
    if (PF.slug) renderProfile();
    if (location.hash === "#hall") renderHall();
    if (location.hash === "#cartas") renderCards();
    renderHomeLinks();
    renderElPresence();
    renderNightVoteCard();
    if (document.activeElement !== $("venue"))
      $("venue").value = state.venue || "";
    if (document.activeElement !== $("matchDate"))
      $("matchDate").value = state.matchDate || "";
    if (document.activeElement !== $("startTime"))
      $("startTime").value = state.startTime || "";
    if (document.activeElement !== $("assistScoreRule")) $("assistScoreRule").value = String(Number(state.scoreRules?.assist ?? SCORE_RULES.assist));
    document.querySelectorAll(".assist-rule-display").forEach((node) => { node.textContent = "+" + Number(state.scoreRules?.assist ?? SCORE_RULES.assist).toFixed(1).replace(".", ","); });
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
    renderNewsPush();
    renderHomeNext();
    renderHomeVisibility();
    markActiveTab();
    applyEditLock();
  }
  const TEAM_NAMES = ["Time Águia", "Time Sol", "Time Verde", "Time Azul"];
  const LOGO_KEY = "liga-skalama-team-logos";
  // Logos dos times ficam só neste aparelho (localStorage), por escolha do organizador.
  let teamLogos = {};
  try {
    teamLogos = JSON.parse(localStorage.getItem(LOGO_KEY) || "{}");
  } catch {
    teamLogos = {};
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
    craque: '<circle cx="12" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m12 6 1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3Z" fill="currentColor"/><path d="m8.5 14-1.5 7 5-2.5 5 2.5-1.5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
    scorers: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="m12 7.5 3.2 2.3-1.2 3.8h-4l-1.2-3.8Z"/>',
    next: '<rect x="3.5" y="5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2"/>',
    card: '<path d="M6 3h12l3 2v12l-9 5-9-5V5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="13.5" cy="9" r="2.4" fill="currentColor"/><path d="M9.5 15h7" stroke="currentColor" stroke-width="2"/>',
  };
  const AX_TYPES = [["result", "Resultado de jogo"], ["teams", "Times sorteados"], ["champion", "Campeão"], ["night", "Destaques da noite"], ["craque", "Craque da noite"], ["scorers", "Artilharia"], ["next", "Próximo jogo"], ["card", "Carta do jogador"]];
  let artKey = "", artToken = 0, artDone = Promise.resolve(), axFontsPromise = null;
  const axImages = new Map();
  function colorOf(name) {
    const sl = superTeam(name);
    if (sl) return SUPER_COLORS[sl.color] || SUPER_COLORS[0];
    const index = TEAM_NAMES.indexOf(name);
    if (index >= 0) return teamColors[index];
    const past = officialGames().find((game) => (game.home === name && game.homeColor) || (game.away === name && game.awayColor));
    return (past && (past.home === name ? past.homeColor : past.awayColor)) || teamColors[0];
  }
  function artGames() {
    return [...officialGames()].sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt));
  }
  // ---------- Carregamento: fontes e imagens antes de desenhar ----------
  function axFontsReady() {
    if (!axFontsPromise) {
      axFontsPromise = document.fonts?.load
        ? Promise.all(['400 100px "Anton"', '600 40px "Inter"', '700 40px "Inter"', '800 40px "Inter"', '900 40px "Barlow Condensed"'].map((font) => document.fonts.load(font))).then(() => document.fonts.ready).catch(() => {})
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
    const games = officialGames().filter((game) =>
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
      games = roundId ? officialGames().filter((game) => game.roundId === roundId) : [];
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
    if (type === "craque") {
      const w = (VOTE.winners || [])[0];
      return w && w.name ? { type, winner: w } : { warn: shared ? "A arte do Craque da noite aparece quando a votação da noite fechar." : "A votação do Craque da noite precisa do banco compartilhado." };
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
    if (type === "card") return axCardInfo();
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
    if (info.winner) add(info.winner.team, info.winner.label);
    if (info.card?.crest) list.push(info.card.crest);
    if (info.card?.photo) list.push(info.card.photo);
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
  // ---------- Arte: Craque da noite (votação) ----------
  function axDrawCraque(ctx, W, H, story, info) {
    const top = story ? 220 : 70, bottom = story ? H - 230 : H - 70, w = info.winner;
    let y = axBrand(ctx, W, top, story);
    y = axPills(ctx, W, y + (story ? 6 : 0), [{ text: "CRAQUE DA NOITE", style: "yellow" }, ...(pvDayMonth(w.round_key) ? [{ text: "VOTAÇÃO · " + pvDayMonth(w.round_key), style: "outline" }] : [])], story) + (story ? 60 : 30);
    const pad = 70, cardH = bottom - 54 - y, cx = W / 2;
    axRound(ctx, pad, y, W - pad * 2, cardH, 34); ctx.fillStyle = "#151515"; ctx.fill(); ctx.strokeStyle = "rgba(255,196,0,0.6)"; ctx.lineWidth = 4; ctx.stroke();
    axStar(ctx, cx, y + cardH * 0.17, story ? 74 : 54, AX_Y);
    axCrest(ctx, w.team, w.label, cx, y + cardH * 0.42, story ? 260 : 190);
    const name = displayName(w.name).toUpperCase();
    ctx.textAlign = "center"; ctx.fillStyle = "#ffffff"; axFit(ctx, name, 0, story ? 120 : 90, W - pad * 2 - 80, true); ctx.fillText(name, cx, y + cardH * (story ? 0.7 : 0.72));
    ctx.fillStyle = "#c9c9c1"; axFont(ctx, 700, story ? 32 : 26); ctx.fillText(String(teamDisplayName(w.label) || teamLabel(w.team) || "").toUpperCase(), cx, y + cardH * (story ? 0.77 : 0.8));
    const votes = w.votes + (w.votes === 1 ? " VOTO" : " VOTOS") + " DE " + w.total + (w.total === 1 ? " VOTANTE" : " VOTANTES");
    ctx.fillStyle = AX_Y; axFit(ctx, votes, 800, story ? 38 : 30, W - pad * 2 - 80, false); ctx.fillText(votes, cx, y + cardH * (story ? 0.86 : 0.9));
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
    else if (info.type === "craque") axDrawCraque(ctx, W, H, story, info);
    else if (info.type === "scorers") axDrawScorers(ctx, W, H, story, info);
    else if (info.type === "next") axDrawNext(ctx, W, H, story, info);
    else if (info.type === "card") axDrawCard(ctx, W, H, story, info);
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
    const step2 = $("axStep2"), needsGame = axTypeNeedsGame(), needsScope = ART.type === "scorers", needsCard = ART.type === "card" && !info.warn;
    step2.hidden = !needsGame && !needsScope && !needsCard;
    $("axStep2Title").textContent = needsCard ? "QUAL JOGADOR E QUAL CARTA?" : needsScope ? "QUAL PERÍODO?" : "QUAL JOGO?";
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
    } else if (needsCard) {
      const data = cardsData(), sp = CARD_SP_ORDER.map((t) => data.cur[t]).filter((x) => x && x.slug === ART.cardSlug);
      const markup = '<label class="ax-card-pick"><span>Jogador</span><select data-ax-card-player>' + data.players.map((c) => '<option value="' + escapeHtml(c.slug) + '"' + (c.slug === ART.cardSlug ? " selected" : "") + ">" + escapeHtml(displayName(c.name) + " · " + c.ovr) + "</option>").join("") + "</select></label>" +
        '<div class="ax-seg">' + [["level", "Carta de nível"], ...sp.map((x) => [x.type, CARD_SP[x.type][1] + " " + CARD_SP[x.type][0]])].map(([key, label]) => '<button type="button" class="ax-segbtn' + (ART.cardKind === key ? " is-on" : "") + '" data-ax-card-kind="' + key + '" aria-pressed="' + (ART.cardKind === key) + '">' + escapeHtml(label) + "</button>").join("") + "</div>";
      if ($("axGames").innerHTML !== markup) $("axGames").innerHTML = markup;
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
    const info = axData(), part = info.type === "result" ? "jogo-" + (info.game?.number || "") : info.type === "card" ? "carta-" + (info.card?.slug || "") : info.type;
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
      if (data.axType) { ART.type = data.axType; if (ART.type === "card") { cardLoadWinners(); ART.cardKind = ART.cardKind || "level"; } renderArt(); }
      else if (data.axCardKind) { ART.cardKind = data.axCardKind; renderArt(); }
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
      else if (target.hasAttribute("data-ax-card-player")) { ART.cardSlug = target.value; ART.cardKind = "level"; renderArt(); }
      else if (target.dataset.logoTeam) { uploadTeamLogo(target.dataset.logoTeam, target.files?.[0]); target.value = ""; }
    });
  }
  function setView(view) {
    const locked = (shared && !canManageShared) || (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
    if (locked && view === "elenco") view = "home";
    // Aba que não existe mais (ex.: o antigo SKALAMA News salvo no aparelho) volta para a Tela principal.
    if (!document.querySelector('[data-view="' + view + '"]')) view = "home";
    document
      .querySelectorAll("[data-view]")
      .forEach((element) =>
        element.classList.toggle("view-hidden", element.dataset.view !== view),
      );
    markActiveTab(view);
    if (view !== "presenca" && view !== "votacao" && view !== "hall" && view !== "cartas") localStorage.setItem("liga-skalama-view", view);
    if (view === "home") renderNightVoteCard();
    rkObserve(view === "home");
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
    return { mode, duration, endsAt: null, runningSince: null, elapsedBeforeRun: 0, remainingAtPause: null, pauseStartedAt: null, pauseUsedMs: 0, pauseNoLimit: true };
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
    const balanced = drawMode() === "balanced";
    if (balanced) balancedFill(teams, others, starterTotal);
    else
      while (others.length) {
        const open = randomize(teams.filter((team) => team.players.length < 5));
        open[0].players.push(others.pop());
      }
    // Rodada nova: jogos de treino que ainda existirem são apagados (com os gols deles).
    const oldTraining = trainingGames();
    if (oldTraining.length) await purgeTrainingGoals(oldTraining.map((game) => game.id));
    await saveState(
      {
        ...(oldTraining.length ? { gameHistory: officialGames() } : {}),
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
      (balanced ? "Times sorteados (equilibrado). Diferença de força: " + strengthGap(teams.map((team) => team.players)).toFixed(1).replace(".", ",") + ". " : "Times sorteados. ") + "A sequência começa com Águia × Sol.",
    );
  }
  // ---------- Sorteio equilibrado ----------
  // Força = nota média nos jogos oficiais do Modo Liga (mínimo de 3 jogos; com menos, a média geral da liga).
  const DRAW_MODE_KEY = "skalama-draw-mode";
  function drawMode() { try { return localStorage.getItem(DRAW_MODE_KEY) === "balanced" ? "balanced" : "random"; } catch { return "random"; } }
  function strengthTable() {
    const rows = new Map();
    let sum = 0, count = 0;
    for (const game of ligaGames())
      for (const p of gamePerformance(game)) {
        const key = playerKey(p.player), row = rows.get(key) || { sum: 0, games: 0 }, score = Number(p.score) || 0;
        row.sum += score; row.games++; rows.set(key, row); sum += score; count++;
      }
    return { rows, avg: count ? sum / count : 7 };
  }
  function playerStrength(name, table = strengthTable()) {
    const row = table.rows.get(playerKey(name));
    return row && row.games >= 3 ? row.sum / row.games : table.avg;
  }
  function teamStrength(players, table = strengthTable()) {
    return players.length ? players.reduce((sum, name) => sum + playerStrength(name, table), 0) / players.length : 0;
  }
  function strengthGap(lineups, table = strengthTable()) {
    const values = lineups.filter((players) => players.length).map((players) => teamStrength(players, table));
    return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  }
  // Serpentina pela força (com um pouco de sorte) + trocas aleatórias que só valem se diminuírem a diferença.
  function balancedFill(teams, others, starterTotal) {
    const table = strengthTable(), per = Math.floor(starterTotal / teams.length), extra = starterTotal % teams.length;
    const capacity = randomize(teams.map((_, index) => index)).reduce((acc, index, order) => { acc[index] = Math.min(5, per + (order < extra ? 1 : 0)); return acc; }, {});
    const pool = others.map((name) => ({ name, s: playerStrength(name, table) + (Math.random() - 0.5) * 0.6 })).sort((a, b) => b.s - a.s);
    let order = randomize(teams.map((_, index) => index)), forward = true;
    while (pool.length) {
      const seq = forward ? order : [...order].reverse();
      for (const index of seq) {
        if (!pool.length) break;
        if (teams[index].players.length < capacity[index]) teams[index].players.push(pool.shift().name);
      }
      forward = !forward;
      if (teams.every((team, index) => team.players.length >= capacity[index]) && pool.length) { const open = teams.filter((team) => team.players.length < 5); (open[0] || teams[0]).players.push(pool.shift().name); }
    }
    others.length = 0;
    const gap = () => strengthGap(teams.map((team) => team.players), table);
    let best = gap();
    for (let i = 0; i < 400 && teams.length > 1; i++) {
      const [a, b] = randomize(teams.map((_, index) => index)).slice(0, 2), ta = teams[a].players, tb = teams[b].players;
      const ia = Math.floor(Math.random() * ta.length), ib = Math.floor(Math.random() * tb.length);
      if (!ta.length || !tb.length || keeper(ta[ia]) !== keeper(tb[ib])) continue;
      [ta[ia], tb[ib]] = [tb[ib], ta[ia]];
      const next = gap();
      if (next < best - 1e-9) best = next; else [ta[ia], tb[ib]] = [tb[ib], ta[ia]];
    }
  }
  // Força de cada time (só o organizador vê): atualiza na hora com trocas manuais.
  function renderElStrength() {
    const box = $("elStrength");
    if (!box) return;
    const teams = state.teams || [];
    if (!teams.length || isEditLocked()) { box.innerHTML = ""; return; }
    const table = strengthTable(), lineups = teams.map((team) => lineupForTeam(team.name)), gap = strengthGap(lineups, table);
    box.innerHTML = '<div class="el-strength"><h4 class="el-strength-title">⚖ FORÇA DE CADA TIME</h4><div class="el-strength-grid">' + teams.map((team, index) => {
      const [bg, ink] = EL_HEAD[team.name] || ["#3a3a35", "#ffffff"];
      return '<div class="el-strength-card"><div class="el-strength-head" style="background:' + bg + ";color:" + ink + '">' + elCrest(team.name, "s") + "<span>" + escapeHtml(teamLabel(team.name)) + '</span></div><strong>' + teamStrength(lineups[index], table).toFixed(1).replace(".", ",") + "</strong><small>nota média</small></div>";
    }).join("") + '</div><p class="el-strength-gap' + (gap <= 0.5 ? " is-good" : "") + '">' + (gap <= 0.5 ? "✓ " : "") + "Diferença entre o time mais forte e o mais fraco: <b>" + gap.toFixed(1).replace(".", ",") + "</b></p>" +
      '<p class="el-strength-note">Força = nota média nos jogos oficiais do Modo Liga (quem tem menos de 3 jogos entra com a média da liga). Só você vê.</p></div>';
  }
  function renderDrawMode() {
    const box = $("elDrawMode");
    if (!box) return;
    const mode = drawMode(), opt = (value, label, help) => '<button type="button" class="el-mode' + (mode === value ? " is-on" : "") + '" role="radio" aria-checked="' + (mode === value) + '" data-draw-mode="' + value + '"><strong>' + label + "</strong><small>" + help + "</small></button>";
    box.innerHTML = '<div class="el-modes" role="radiogroup" aria-label="Tipo de sorteio">' + opt("random", "🎲 Aleatório", "como é hoje") + opt("balanced", "⚖ Equilibrado", "pela nota média") + "</div>";
    const button = $("drawTeams");
    if (button) button.textContent = mode === "balanced" ? "⚖ Sortear times equilibrados" : "🎲 Sortear times";
  }
  document.addEventListener("click", (event) => {
    const option = event.target.closest?.("[data-draw-mode]");
    if (!option) return;
    try { localStorage.setItem(DRAW_MODE_KEY, option.dataset.drawMode); } catch {}
    renderDrawMode();
    const redraw = document.querySelector("[data-el-redraw]");
    if (redraw) redraw.textContent = option.dataset.drawMode === "balanced" ? "↻ Sortear de novo (equilibrado)" : "↻ Sortear de novo";
  });
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
    const currentGame = { id: crypto.randomUUID(), roundId: (fixture ? sl.id : state.roundId) || null, venue: String(state.venue || "").trim() || undefined, ...(fixture ? { superLigaId: sl.id, fixtureId: fixture.id, stage: fixture.stage, round: fixture.round } : {}), number: (state.trainingMode ? trainingGames() : officialGames()).length + 1, ...(state.trainingMode ? { training: true } : {}), home, away, homePlayers, awayPlayers, homeStart: [...homePlayers], awayStart: [...awayPlayers], homeBench, awayBench, onCourt, substitutions: [], homeKeeper, awayKeeper, homeKeeperStart: homeKeeper, awayKeeperStart: awayKeeper, loans, timerMode: mode, durationMinutes: mode === "coca" ? null : durationMinutes, startedAt: now };
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
      now = nowMs();
    const shoot = shootoutOf(state.currentGame);
    if (shoot && !shoot.finished) return;
    const pauseLog = (kind) => ({ ...state.currentGame, pauseLog: [...(state.currentGame.pauseLog || []), { kind, minute: Math.max(1, Math.ceil(timerElapsed(timer) / 60)), at: now }] });
    if (isPauseActive(timer)) {
      await saveState(
        {
          currentGame: pauseLog("resume"),
          timer: {
            ...timer,
            endsAt: now + timerRemaining(timer) * 1000,
            remainingAtPause: null,
            pauseStartedAt: null,
            pauseNoLimit: true,
            // Só a soma das pausas, para informação (sem limite).
            pauseUsedMs: (timer.pauseUsedMs || 0) + Math.max(0, now - timer.pauseStartedAt),
          },
        },
        "Cronômetro retomado.",
      );
      return;
    }
    if (!timer.endsAt || timerRemaining(timer) === 0) return;
    await saveState(
      {
        currentGame: pauseLog("pause"),
        timer: {
          ...timer,
          endsAt: null,
          remainingAtPause: timerRemaining(timer),
          pauseStartedAt: now,
          pauseNoLimit: true,
        },
      },
      "Pausa iniciada. Toque em Continuar para voltar a contar.",
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
    const goal = { id: crypto.randomUUID(), player_name: player, team_name: actualTeam, score_team_name: scoringTeam, own_goal: ownGoal, assisted_by: assistedBy, match_number: game.number, game_id: game.id, minute, ...(game.training ? { training: true } : {}) };
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
        winner,
        state.incidents || [],
      ),
      durationSeconds = Math.floor(timerElapsed()),
      entry = {
        ...current,
        homeLabel: teamLabelRaw(current.home),
        awayLabel: teamLabelRaw(current.away),
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
          sameLeague = !current.training && sl && sl.id === current.superLigaId,
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
          { gameHistory: history, currentGame: null, ...(sameLeague ? { superLiga: nextSl } : current.training && sl?.pending ? { superLiga: { ...sl, pending: { ...sl.pending, prepared: false } } } : {}), timer: freshTimer("coca"), shootout: null, incidents: [] },
          (current.training ? "Treino " + current.number + " encerrado" + (winner === "Empate" ? " empatado" : penalties ? " nos pênaltis" : "") + ". Não conta em nada." : "Jogo " + current.number + " encerrado" + (winner === "Empate" ? " empatado" : penalties ? " nos pênaltis" : "") + "." + ending),
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
      (current.training ? "Treino " : "Jogo ") +
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
      const floor = el.classList.contains("lv-oname") ? 6 : el.classList.contains("lv-gname") ? 8 : 9;
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
    const same = (state.gameHistory || []).filter((item) => !!item.training === !!game.training && (game.roundId ? item.roundId === game.roundId : !item.superLigaId)).length;
    return same + 1;
  }
  function lvDurationMin(game) {
    const timer = state.timer || {};
    return game ? Math.round((timer.duration || (game.durationMinutes || 8) * 60) / 60) : Math.min(180, Math.max(1, Number(state.durationMinutes) || 8));
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
    const mode = activeLiveMode(), history = isEditLocked() ? officialGames() : state.gameHistory || [];
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
    return '<section class="lv-card is-ended" aria-label="Jogo encerrado"><div class="lv-strip"><span class="lv-tag">' + (game.training ? "TREINO ENCERRADO" : "ENCERRADO") + "</span><span>" + lvModeName(game.timerMode) + (game.training ? " · Treino " : " · Jogo ") + game.number + "</span></div>" +
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
    // Só escreve quando muda (o relógio troca 1 vez por segundo; o intervalo roda 4 vezes por segundo).
    const clockValue = clockText(remaining), barValue = Math.max(0, Math.min(100, (remaining / duration) * 100)) + "%",
      labelValue = remaining === 0 ? "fim do tempo" : isPauseActive(timer) ? "⏸ pausado" : "tempo restante";
    if (clock && clock.textContent !== clockValue) clock.textContent = clockValue;
    if (bar && bar.style.width !== barValue) bar.style.width = barValue;
    if (label && label.textContent !== labelValue) label.textContent = labelValue;
  }
  function renderSpectator() {
    const box = $("lvSpectator");
    if (!box) return;
    const locked = isEditLocked();
    box.hidden = !locked;
    if (!locked) return;
    const game = state.currentGame && !state.currentGame.training ? state.currentGame : null, pending = currentPending(), last = lvLastGame();
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
  // ---------- Modo treino (painel do organizador) ----------
  function lvTrainHtml() {
    const on = !!state.trainingMode, list = trainingGames(),
      row = (game) => '<li><span class="lv-train-tag">TREINO</span><span class="lv-train-teams">' + escapeHtml(gameTeamLabel(game, "home")) + " <b>" + Number(game.homeScore || 0) + " × " + Number(game.awayScore || 0) + "</b> " + escapeHtml(gameTeamLabel(game, "away")) + "</span></li>";
    return '<div class="lv-train-row"><div class="lv-train-text"><strong id="lvTrainLabel">Modo treino</strong><small id="lvTrainHelp">Jogos de teste não contam em nada e só você vê.</small></div>' +
      '<button type="button" class="lv-switch" role="switch" aria-checked="' + on + '" aria-labelledby="lvTrainLabel" aria-describedby="lvTrainHelp" data-lv-train-toggle><span class="lv-switch-knob" aria-hidden="true"></span><span class="lv-switch-text" aria-hidden="true">' + (on ? "LIGADO" : "DESLIGADO") + "</span></button></div>" +
      (list.length ? '<div class="lv-train-list"><h3 class="lv-label">JOGOS DE TREINO (' + list.length + ')</h3><ul>' + list.map(row).join("") + '</ul><button type="button" class="lv-btn lv-train-delete" data-lv-train-delete>🗑 Apagar ' + (list.length === 1 ? "o jogo de treino" : "os " + list.length + " jogos de treino") + "</button></div>" : "");
  }
  // Apaga os gols de jogos de treino na tabela goals (ou no modo local).
  async function purgeTrainingGoals(ids) {
    if (!ids.length) return;
    if (shared) {
      const { error } = await client.from("goals").delete().in("game_id", ids);
      if (error) throw error;
      await refreshGoals();
    } else goals = goals.filter((goal) => !ids.includes(goal.game_id));
  }
  async function setGoalsTraining(game, training) {
    if (!game) return;
    if (shared) {
      const { error } = await client.from("goals").update({ training, match_number: game.number }).eq("game_id", game.id);
      if (error) throw error;
      await refreshGoals();
    } else goals = goals.map((goal) => goal.game_id === game.id ? { ...goal, training, match_number: game.number } : goal);
  }
  async function toggleTrainingMode() {
    const turnOn = !state.trainingMode, game = state.currentGame;
    let nextGame = game;
    if (turnOn && game && !game.training) nextGame = { ...game, training: true, number: trainingGames().length + 1 };
    if (!turnOn && game?.training) {
      const counts = await askConfirm({
        title: "O jogo atual continua como treino?",
        message: "Ele começou no modo treino. Se passar a valer, entra no histórico, na classificação e nos rankings como jogo oficial. Tocar fora ou em Cancelar mantém como treino.",
        confirmText: "Passar a valer",
        tone: "green",
      });
      if (counts) { nextGame = { ...game, number: officialGames().length + 1 }; delete nextGame.training; }
    }
    try {
      if (nextGame !== game) await setGoalsTraining(nextGame, !!nextGame.training);
    } catch (error) { notify("Não deu para atualizar os gols do jogo: " + error.message, true); return; }
    await saveState(
      { trainingMode: turnOn, ...(nextGame !== game ? { currentGame: nextGame } : {}) },
      turnOn ? "Modo treino ligado. Os jogos de agora não contam em nada." : nextGame !== game ? "Modo treino desligado. O jogo atual passou a valer." : "Modo treino desligado.",
    );
  }
  async function deleteTrainingGames() {
    const list = trainingGames();
    if (!list.length) return;
    const ok = await askConfirm({
      title: list.length === 1 ? "Apagar o jogo de treino?" : "Apagar os " + list.length + " jogos de treino?",
      message: "Apaga só os jogos marcados como TREINO e os gols deles. Os jogos oficiais, a classificação e os rankings não mudam.",
      confirmText: "Apagar",
      tone: "red",
    });
    if (!ok) return;
    const ids = list.map((game) => game.id);
    try { await purgeTrainingGoals(ids); } catch (error) { notify("Não deu para apagar os gols de treino: " + error.message, true); return; }
    await saveState({ gameHistory: (state.gameHistory || []).filter((game) => !ids.includes(game.id)) }, list.length === 1 ? "Jogo de treino apagado." : list.length + " jogos de treino apagados.");
  }
  function renderOrganizer() {
    const org = $("lvOrg");
    if (!org || isEditLocked()) return;
    lvSet("lvVote", lvVoteHtml());
    const trainHtml = lvTrainHtml();
    if (lvUI.marks.lvTrain !== trainHtml) { lvUI.marks.lvTrain = trainHtml; $("lvTrain").innerHTML = trainHtml; }
    $("lvTrainStripe").hidden = !state.trainingMode;
    org.classList.toggle("is-training", !!state.trainingMode);
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
        .map((goal) => {
          const full = displayName(goal.player_name || "Gol"), parts = full.split(/\s+/).filter(Boolean),
            first = (name) => displayName(name).split(/\s+/)[0],
            people = [...(game.homePlayers || []), ...(game.awayPlayers || []), ...(game.homeBench || []), ...(game.awayBench || [])].filter((name) => displayName(name) !== full),
            // Nome curto: só o primeiro nome; a inicial do sobrenome entra se outro jogador do jogo tiver o mesmo primeiro nome.
            short = parts.length > 1 && people.some((name) => first(name) === parts[0]) ? parts[0] + " " + parts[1][0] + "." : parts[0] || full;
          // No celular aparece o nome curto (PATRICK S.), sem o ⚽; no PC, o nome inteiro.
          return '<li class="lv-gpill" style="--tb:' + c.bg + ";--ti:" + c.ink + '" title="' + escapeHtml(full) + '"><span class="lv-gname"><span class="lv-gball" aria-hidden="true">⚽ </span><span class="lv-gfull">' + escapeHtml(full) + '</span><span class="lv-gshort" aria-hidden="true">' + escapeHtml(short) + "</span>" + (goal.own_goal ? '<span class="lv-gfull"> (contra)</span><span class="lv-gshort"> (GC)</span>' : "") + "</span><small>" + (Number(goal.minute) || 0) + "′</small></li>";
        }).join("");
    };
    const gh = goalPills(game?.home), ga = goalPills(game?.away), gChanged = lvUI.marks.lvGoalsHome !== gh || lvUI.marks.lvGoalsAway !== ga;
    lvSet("lvGoalsHome", gh); lvSet("lvGoalsAway", ga);
    $("lvGoalsHome").closest(".lv-clock")?.classList.toggle("has-goals", !!(gh || ga));
    if (gChanged) { lvFit($("lvGoalsHome")); lvFit($("lvGoalsAway")); }
    // Cronômetro e estado
    const timer = state.timer || {}, remaining = game ? timerRemaining(timer) : minutes * 60, paused = !!game && isPauseActive(timer);
    const timerEl = $("lvTimer");
    if (timerEl.textContent !== clockText(remaining)) timerEl.textContent = clockText(remaining);
    timerEl.classList.toggle("is-paused", paused);
    const stateText = !game ? "AGUARDANDO INÍCIO" : shootoutOf(game) && !shootoutOf(game).finished ? "🥅 PÊNALTIS" : remaining === 0 ? "⏹ FIM DO TEMPO" : (paused ? "⏸ PAUSADO" : "● RODANDO");
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
      if ("lvTrainToggle" in data) { toggleTrainingMode(); return; }
      if ("lvTrainDelete" in data) { deleteTrainingGames(); return; }
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
    $("matchDate").addEventListener("change", async (e) => {
      const prevKey = state.matchDate || "", prevTime = pzaTime();
      if (await saveState({ matchDate: e.target.value }, "Data atualizada.")) pzaSyncRound(prevKey, prevTime);
    });
    $("startTime").addEventListener("change", async (e) => {
      const prevKey = state.matchDate || "", prevTime = pzaTime();
      if (await saveState({ startTime: e.target.value }, "Horário atualizado.")) pzaSyncRound(prevKey, prevTime);
    });
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
      if (event.target.closest("[data-home-list]")) {
        document.querySelector('[data-view-button="live"][data-live-mode="liga"]')?.click();
        setTimeout(() => { const section = $("ligaPublicTeams"); if (section && !section.hidden) { section.scrollIntoView({ behavior: "smooth", block: "start" }); section.querySelector(".pza-kick")?.setAttribute("tabindex", "-1"); section.querySelector(".pza-kick")?.focus({ preventScroll: true }); } }, 120);
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
    pvRoute();
    loadVoteWinners();
    pfRoute(false);
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
