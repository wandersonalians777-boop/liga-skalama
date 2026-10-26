(() => {
  const $ = (id) => document.getElementById(id);
  const teamColors = [
    { name: "Águia", color: "#2183c5", ink: "#ffffff" },
    { name: "Sol", color: "#ffc400", ink: "#14120a" },
    { name: "Verde", color: "#2b8a50", ink: "#ffffff" },
    { name: "Azul", color: "#334fa0", ink: "#ffffff" },
  ];
  // 5 por time, de 2 a 4 times: 10–14 jogadores → 2 times, 15–19 → 3, 20+ → 4.
  const MIN_PLAYERS = 10;
  const startersFor = (total) =>
    Math.min(4, Math.floor(Math.max(total, MIN_PLAYERS) / 5)) * 5;
  // O nome interno ("Time Águia") segue como chave; o apelido é só exibição.
  const teamLabel = (name) => state?.teamLabels?.[name] || name;
  const historyWinner = (game) =>
    (game.winner === game.home
      ? game.homeLabel
      : game.winner === game.away
        ? game.awayLabel
        : "") || game.winner;

  const clientId =
    localStorage.getItem("liga-skalama-client") ||
    (() => {
      const value = crypto.randomUUID();
      localStorage.setItem("liga-skalama-client", value);
      return value;
    })();
  let client = null,
    shared = false,
    adminSession = null,
    canManageShared = false,
    state = null,
    goals = [],
    votes = [],
    toastTimer = 0;

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
  function normalizeState(raw) {
    const next = { ...initialState(), ...(raw || {}) };
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
      label = $("accessLabel");
    if (!button || !label) return;
    if (!shared) {
      const publicOnly = window.LIGA_CONFIG?.publicReadOnly === true;
      button.hidden = true;
      label.hidden = !publicOnly;
      label.textContent = publicOnly
        ? "Aguardando banco compartilhado"
        : "Modo local";
      return;
    }
    button.hidden = false;
    label.hidden = false;
    label.textContent = canManageShared
      ? "Edição autorizada"
      : "Visualização pública";
    button.textContent = adminSession
      ? "Sair do modo organizador"
      : "Entrar como organizador";
    setConnection(
      canManageShared
        ? "Banco online · organizador"
        : "Banco online · leitura pública",
      true,
    );
  }
  function applyEditLock() {
    const locked =
      (shared && !canManageShared) ||
      (!shared && window.LIGA_CONFIG?.publicReadOnly === true);
    document.body.classList.toggle("public-read-only", locked);
    document
      .querySelectorAll("button,input,select,textarea")
      .forEach((element) => {
        if (
          element.id === "themeToggle" ||
          element.id === "adminAccessButton" ||
          element.closest("#adminLogin") ||
          element.closest("#artStudio") ||
          element.hasAttribute("data-view-button")
        )
          return;
        if (locked) {
          if (!element.hasAttribute("data-access-locked")) {
            element.dataset.accessWasDisabled = String(element.disabled);
            element.setAttribute("data-access-locked", "");
          }
          element.disabled = true;
        } else if (element.hasAttribute("data-access-locked")) {
          delete element.dataset.accessWasDisabled;
          element.removeAttribute("data-access-locked");
        }
      });
    updateAccessUI();
  }
  async function refreshAdminAccess(session) {
    adminSession = session || null;
    canManageShared = false;
    if (shared && adminSession?.user?.id) {
      const { data, error } = await client
        .from("league_admins")
        .select("user_id")
        .eq("user_id", adminSession.user.id)
        .maybeSingle();
      if (error) throw error;
      canManageShared = !!data;
    }
    if (canManageShared)
      document.querySelectorAll("[data-access-locked]").forEach((element) => {
        element.disabled = element.dataset.accessWasDisabled === "true";
        delete element.dataset.accessWasDisabled;
        element.removeAttribute("data-access-locked");
      });
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
        : { state: initialState(), goals: [], votes: [] };
    } catch {
      return { state: initialState(), goals: [], votes: [] };
    }
  }
  function localSave() {
    localStorage.setItem(
      "liga-skalama-local",
      JSON.stringify({ state, goals, votes }),
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
      home: state.teams?.find((t) => t.name === homeName),
      away: state.teams?.find((t) => t.name === awayName),
    };
  }
  function gameNumber() {
    return state.currentGame?.number || (state.gameHistory || []).length + 1;
  }
  async function saveState(patch, successMessage = "Alteração salva.") {
    if (
      (shared && !canManageShared) ||
      (!shared && window.LIGA_CONFIG?.publicReadOnly === true)
    ) {
      notify("Somente o organizador autorizado pode alterar os dados.", true);
      return;
    }
    const next = { ...state, ...patch };
    state = next;
    renderAll();
    if (!shared) {
      localSave();
      notify(`${successMessage} (somente neste navegador)`);
      return;
    }
    const { error } = await client
      .from("league_night")
      .upsert({ id: 1, state: next, updated_at: new Date().toISOString() });
    if (error) {
      notify(
        "Não foi possível salvar no banco compartilhado: " + error.message,
        true,
      );
      return;
    }
    notify(successMessage);
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
    if (
      !config.supabaseUrl ||
      !config.supabaseAnonKey ||
      !window.supabase?.createClient
    )
      return false;
    client = window.supabase.createClient(
      config.supabaseUrl,
      config.supabaseAnonKey,
    );
    const { data: sessionInfo } = await client.auth.getSession();
    adminSession = sessionInfo?.session || null;
    if (adminSession?.user?.id) {
      const { data: admin, error: adminError } = await client
        .from("league_admins")
        .select("user_id")
        .eq("user_id", adminSession.user.id)
        .maybeSingle();
      if (adminError) throw adminError;
      canManageShared = !!admin;
    }
    shared = true;
    let { data, error } = await client
      .from("league_night")
      .select("state")
      .eq("id", 1)
      .maybeSingle();
    if (error) throw error;
    if (data) state = normalizeState(data.state);
    else if (canManageShared) {
      const starter = initialState();
      const { error: insertError } = await client
        .from("league_night")
        .insert({ id: 1, state: starter });
      if (insertError && insertError.code !== "23505") throw insertError;
      const result = await client
        .from("league_night")
        .select("state")
        .eq("id", 1)
        .single();
      if (result.error) throw result.error;
      state = normalizeState(result.data.state);
    } else
      throw new Error(
        "O banco ainda não foi inicializado. O administrador precisa configurar o registro inicial.",
      );
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(
        () =>
          refreshAdminAccess(session).catch((error) => {
            canManageShared = false;
            notify(
              "Não foi possível validar o acesso de edição: " + error.message,
              true,
            );
            renderAll();
          }),
        0,
      );
    });
    updateAccessUI();
    setConnection(
      canManageShared
        ? "Banco online · organizador"
        : "Banco online · leitura pública",
      true,
    );
    await refreshGoals();
    client
      .channel("liga-skalama-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "league_night" },
        (payload) => {
          if (payload.new?.state) {
            state = normalizeState(payload.new.state);
            renderAll();
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "goals" },
        refreshGoals,
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") updateAccessUI();
      });
    renderAll();
    return true;
  }
  function namesForSelect(select, names, placeholder) {
    const current = select.value;
    select.innerHTML =
      `<option value="">${escapeHtml(placeholder)}</option>` +
      names
        .map(
          (name) =>
            `<option value="${escapeHtml(name)}">${escapeHtml(displayName(name))}${keeper(name) ? " · 🧤 Goleiro" : ""}</option>`,
        )
        .join("");
    if (names.includes(current)) select.value = current;
    select.disabled = names.length === 0;
  }
  function lineupForTeam(teamName, game = null) {
    if (game && game.home === teamName)
      return (
        game.homePlayers ||
        state.teams?.find((team) => team.name === teamName)?.players ||
        []
      );
    if (game && game.away === teamName)
      return (
        game.awayPlayers ||
        state.teams?.find((team) => team.name === teamName)?.players ||
        []
      );
    return (
      state.lineups?.[teamName] ||
      state.teams?.find((team) => team.name === teamName)?.players ||
      []
    );
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
  function renderTeams() {
    const grid = $("teamsGrid");
    if (!state.teams?.length)
      grid.innerHTML =
        '<div class="empty-state">Adicione pelo menos 10 jogadores e faça o sorteio.</div>';
    else
      grid.innerHTML = state.teams
        .map((team, index) => {
          const color = teamColors[index] || teamColors[0];
          const players = lineupForTeam(team.name);
          return `<article class="team-card"><header class="team-head" style="--team-color:${color.color};--team-ink:${color.ink}"><span>${teamLogos[team.name] ? `<img class="team-logo" src="${teamLogos[team.name]}" alt="">` : ""}${escapeHtml(teamLabel(team.name))}</span><small>${color.name} · ${players.length} JOGADORES</small></header><input class="team-label-input" data-team-label="${escapeHtml(team.name)}" maxlength="30" placeholder="Nome do time (opcional)" aria-label="Nome do ${escapeHtml(team.name)} (opcional)" value="${escapeHtml(state.teamLabels?.[team.name] || "")}"><ol>${players.map((name) => `<li>${escapeHtml(displayName(name))}${keeper(name) ? ' <b class="keeper-mark">*</b>' : ""}</li>`).join("")}</ol></article>`;
        })
        .join("");
  }
  function renderLineupAdjustments() {
    const details = $("lineupAdjustDetails"),
      grid = $("lineupAdjustGrid"),
      absentBox = $("absentPlayersList"),
      teams = state.teams || [],
      capacity = (state.timerMode || "liga") === "coca" ? 8 : 5;
    details.hidden = !teams.length;
    const lineups = Object.fromEntries(
        teams.map((team) => [team.name, [...lineupForTeam(team.name)]]),
      ),
      absent = state.absentPlayers || {};
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
                other.name !== team.name && lineups[other.name].length > 5,
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
                (state.currentGame || players.length <= 4 ? "disabled" : "") +
                ">Ausente</button></li>",
            )
            .join("") +
          '</ul><div class="lineup-transfer"><select data-transfer-player="' +
          escapeHtml(team.name) +
          '" ' +
          (state.currentGame || players.length >= capacity || !pool.length
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
          (state.currentGame || players.length >= capacity || !pool.length
            ? "disabled"
            : "") +
          ">Puxar jogador</button></div></article>"
        );
      })
      .join("");
    const absentRows = Object.entries(absent),
      openTeams = teams.filter((team) => lineups[team.name].length < capacity);
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
              (state.currentGame || !openTeams.length ? "disabled" : "") +
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
              (state.currentGame || !openTeams.length ? "disabled" : "") +
              ">Preencher vaga</button></span>",
          )
          .join("") +
        "</p>"
      : '<p class="help-text">Todos os times precisam ter pelo menos cinco jogadores para iniciar. No modo Coca, as reservas permitem chegar a oito por equipe.</p>';
    grid.querySelectorAll("[data-transfer-to]").forEach((button) =>
      button.addEventListener("click", () => {
        const target = button.dataset.transferTo,
          select = [...grid.querySelectorAll("[data-transfer-player]")].find(
            (item) => item.dataset.transferPlayer === target,
          ),
          player = select?.value;
        if (!player || state.currentGame) return;
        const next = Object.fromEntries(
          teams.map((team) => [team.name, [...lineups[team.name]]]),
        );
        const source = teams.find((team) => next[team.name].includes(player));
        if (
          !source ||
          next[target].length >= capacity ||
          next[source.name].length <= 5 ||
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
            ". O time que cedeu ficou com uma vaga.",
        );
      }),
    );
    grid.querySelectorAll("[data-absence-player]").forEach((button) =>
      button.addEventListener("click", () => {
        if (state.currentGame) return;
        const team = button.dataset.absenceTeam,
          player = button.dataset.absencePlayer,
          next = Object.fromEntries(
            teams.map((item) => [item.name, [...lineups[item.name]]]),
          );
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
        if (state.currentGame || !target || lineups[target].length >= capacity)
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
  async function addReservePlayer() {
    const team = $("reserveTeamChoice").value,
      player = $("reservePlayerChoice").value,
      capacity = (state.timerMode || "liga") === "coca" ? 8 : 5;
    if (
      !team ||
      !player ||
      state.currentGame ||
      !state.reservePlayers?.includes(player) ||
      lineupForTeam(team).length >= capacity
    )
      return;
    const lineups = Object.fromEntries(
      (state.teams || []).map((item) => [
        item.name,
        [...lineupForTeam(item.name)],
      ]),
    );
    if (keeper(player) && lineups[team].some(keeper)) {
      notify("Esse time já tem um goleiro marcado com *.");
      return;
    }
    lineups[team].push(player);
    await saveState(
      {
        lineups,
        reservePlayers: state.reservePlayers.filter((name) => name !== player),
      },
      displayName(player) + " adicionado ao " + team + ".",
    );
  }
  function renderReserveControls() {
    const box = $("reserveControls"),
      reserves = state.reservePlayers || [],
      capacity = (state.timerMode || "liga") === "coca" ? 8 : 5,
      teams = (state.teams || []).filter(
        (team) => lineupForTeam(team.name).length < capacity,
      );
    box.hidden = !state.teams?.length || (state.timerMode || "liga") !== "coca";
    namesForSelect(
      $("reserveTeamChoice"),
      teams.map((team) => team.name),
      "Escolha o time",
    );
    const selected = $("reserveTeamChoice").value,
      target = teams.find((team) => team.name === selected),
      eligible = reserves.filter(
        (name) =>
          !keeper(name) || !(target && lineupForTeam(target.name).some(keeper)),
      );
    namesForSelect(
      $("reservePlayerChoice"),
      eligible,
      "Escolha um jogador da lista de reservas",
    );
    $("reservePlayerChoice").disabled = !eligible.length || !!state.currentGame;
    $("reserveTeamChoice").disabled = !teams.length || !!state.currentGame;
    $("addReserveToTeam").disabled =
      !eligible.length || !selected || !!state.currentGame;
    $("reservePoolNote").textContent = reserves.length
      ? reserves.length +
        " jogador(es) disponível(is) no banco do sorteio. Limite por time: " +
        capacity +
        "."
      : "Não há reservas no sorteio. Adicione nomes além dos titulares (5 por time) antes de sortear os times.";
  }
  function renderFixtures() {
    const list = $("fixturesList");
    if (!state.teams?.length) {
      list.innerHTML =
        '<p class="empty-state">Sorteie os times para ver as equipes disponíveis.</p>';
      return;
    }
    list.innerHTML = state.teams
      .map(
        (team) =>
          `<div class="fixture"><span class="game-no">●</span><span class="versus">${escapeHtml(teamLabel(team.name))}</span><span class="fixture-state">${lineupForTeam(team.name).length} jogadores</span></div>`,
      )
      .join("");
  }
  function clockText(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
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
          ? Math.max(0, Date.now() - timer.pauseStartedAt)
          : 0),
    );
  }
  function isPauseActive(timer = state.timer || {}) {
    return (
      !!timer.pauseStartedAt &&
      Date.now() <
        timer.pauseStartedAt +
          Math.max(0, pauseLimitMs(timer) - (timer.pauseUsedMs || 0))
    );
  }
  function timerRemaining(timer = state.timer || {}) {
    if (timer.mode === "coca") return 0;
    const now = Date.now();
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
    if (timer.mode !== "coca")
      return Math.max(0, (timer.duration || 480) - timerRemaining(timer));
    const base = Number(timer.elapsedBeforeRun) || 0,
      now = Date.now();
    if (timer.runningSince)
      return base + Math.max(0, (now - timer.runningSince) / 1000);
    if (timer.pauseStartedAt) {
      const resumeAt =
        timer.pauseStartedAt +
        Math.max(0, pauseLimitMs(timer) - (timer.pauseUsedMs || 0));
      return base + (now > resumeAt ? (now - resumeAt) / 1000 : 0);
    }
    return base;
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
  function renderQueueControls() {
    const queue = $("queueSelect"),
      current = state.currentGame,
      pending = state.pendingMatch;
    let options = [];
    if (current) options = state.challengeQueue || [];
    else if (pending)
      options = [pending.away, ...(state.challengeQueue || [])].filter(
        (name, index, all) => name && all.indexOf(name) === index,
      );
    const markup = options.length
      ? options
          .map(
            (name) =>
              '<option value="' +
              escapeHtml(name) +
              '">' +
              escapeHtml(teamLabel(name)) +
              "</option>",
          )
          .join("")
      : '<option value="">Sem time na fila</option>';
    const selected = queue.value;
    if (queue.innerHTML !== markup) queue.innerHTML = markup;
    if (options.includes(selected)) queue.value = selected;
    queue.disabled = !options.length;
    $("moveQueue").disabled = !options.length;
    $("beginGame").disabled = !!current || !pending || !state.teams?.length;
    const mode = state.timerMode || "liga";
    $("timerMode").value = mode;
    $("timerMode").disabled = !!current;
    $("beginGame").textContent =
      mode === "coca" ? "Começar jogo · 00:00" : "Começar jogo · 8:00";
    $("nextMatchPreview").textContent = pending
      ? "Próximo jogo: " +
        teamLabel(pending.home) +
        " × " +
        teamLabel(pending.away)
      : "Sorteie os times para preparar a primeira partida.";
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
      home =
        state.currentGame?.home || state.pendingMatch?.home || "Time Águia",
      away = state.currentGame?.away || state.pendingMatch?.away || "Time Sol",
      hasGame = !!state.currentGame;
    $("currentMatchTitle").textContent = hasGame
      ? "JOGO " + gameNumber() + " · " + teamLabel(home) + " × " + teamLabel(away)
      : "Partida em preparação";
    $("scoreHomeName").textContent = teamLabel(home);
    $("scoreAwayName").textContent = teamLabel(away);
    $("scoreHome").textContent = hasGame ? currentScore(home) : 0;
    $("scoreAway").textContent = hasGame ? currentScore(away) : 0;
    $("timerDisplay").textContent = clockText(
      mode === "coca" ? Math.floor(elapsed) : remaining,
    );
    let status = hasGame
      ? mode === "coca"
        ? "Modo Coca · cronômetro livre"
        : "Modo Liga · partida em andamento"
      : "A sequência é definida automaticamente pela fila.";
    if (hasGame && activePause)
      status = "Pausa · saldo " + clockText(Math.ceil((limit - used) / 1000));
    else if (hasGame && used >= limit && timer.pauseStartedAt)
      status = "Pausa acumulada esgotada · tempo retomado";
    else if (hasGame && mode === "liga" && remaining === 0)
      status = "Tempo encerrado · encerre o jogo para salvar o histórico";
    $("timerStatus").textContent = status;
    $("pauseBudget").textContent =
      "Pausa acumulada: " +
      clockText(Math.ceil(used / 1000)) +
      " / " +
      (mode === "coca" ? "02:00" : "01:00");
    const running = mode === "coca" ? !!timer.runningSince : !!timer.endsAt;
    $("pauseTimer").disabled =
      !hasGame ||
      (mode === "liga" && remaining === 0) ||
      (!activePause && (!running || used >= limit));
    $("pauseTimer").textContent = activePause
      ? "Retomar agora"
      : "Pausar · saldo " +
        clockText(Math.floor(Math.max(0, limit - used) / 1000));
    $("finishGame").disabled = !hasGame;
    const tied = hasGame && currentScore(home) === currentScore(away);
    // Pênaltis só quando há exatamente um time esperando; nos outros empates o jogo encerra direto.
    $("tieBreakerLabel").classList.toggle(
      "hidden",
      !tied || (state.challengeQueue || []).length !== 1,
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
  }
  function renderGoalOptions() {
    const teams = selectedTeams(),
      players = [
        ...lineupForTeam(teams.home?.name, state.currentGame),
        ...lineupForTeam(teams.away?.name, state.currentGame),
      ];
    namesForSelect(
      $("goalScorer"),
      state.currentGame ? players : [],
      state.currentGame ? "Escolha quem fez o gol" : "Comece um jogo primeiro",
    );
    $("ownGoal").disabled = !state.currentGame;

    namesForSelect(
      $("incidentPlayer"),
      state.currentGame ? state.roster || [] : [],
      state.currentGame
        ? "Escolha o jogador envolvido"
        : "Comece um jogo primeiro",
    );
    const player = $("goalScorer").value,
      game = state.currentGame;
    $("addGoal").disabled = !game || !player;
    $("removeGoal").disabled =
      !game ||
      !player ||
      !goals.some((g) => g.player_name === player && g.game_id === game.id);
  }
  function renderKeeperChoices() {
    const teams = selectedTeams();
    for (const [side, team] of [
      ["Home", teams.home],
      ["Away", teams.away],
    ]) {
      const select = $("keeper" + side),
        label = $("keeper" + side + "Label"),
        game = state.currentGame,
        pending = state.pendingMatch,
        teamName =
          game?.[side.toLowerCase()] ||
          pending?.[side.toLowerCase()] ||
          "Time " + side,
        players = lineupForTeam(teamName, game),
        name = players.find(keeper);
      label.firstChild.textContent = "Goleiro · " + teamLabel(teamName);
      if (name) {
        select.innerHTML =
          '<option value="' +
          escapeHtml(name) +
          '">' +
          escapeHtml(displayName(name)) +
          " · automático (*)</option>";
        select.value = name;
        select.disabled = true;
      } else {
        const previous = select.value;
        namesForSelect(
          select,
          players,
          players.length
            ? "Escolha o goleiro deste time"
            : "Sorteie os times primeiro",
        );
        if (players.includes(previous)) select.value = previous;
        select.disabled = !!game || !players.length;
      }
    }
  }
  function performanceForGame(game, homeScore, awayScore, gameGoals) {
    const stats = [];
    for (const team of (state.teams || []).filter(
      (team) => team.name === game.home || team.name === game.away,
    )) {
      const teamPlayers = lineupForTeam(team.name, game),
        isHome = team.name === game.home,
        goalsFor = isHome ? homeScore : awayScore,
        goalsAgainst = isHome ? awayScore : homeScore,
        result =
          goalsFor > goalsAgainst
            ? "vitória"
            : goalsFor < goalsAgainst
              ? "derrota"
              : "empate",
        delta = result === "vitória" ? 1.5 : result === "derrota" ? -1.5 : 0.5,
        goalie = isHome ? game.homeKeeper : game.awayKeeper;
      for (const player of teamPlayers) {
        const isKeeper = player === goalie,
          scored = gameGoals.filter(
            (g) => g.player === player && !g.ownGoal,
          ).length,
          ownGoals = gameGoals.filter(
            (g) => g.player === player && g.ownGoal,
          ).length;
        const score = Math.max(
          0,
          Math.min(
            10,
            7 +
              delta +
              (isKeeper ? scored : Math.min(scored, 2)) -
              (isKeeper
                ? 1.5 * Math.min(goalsAgainst, 2)
                : 0.5 * goalsAgainst) -
              2 * ownGoals,
          ),
        );
        stats.push({
          player,
          team: team.name,
          role: isKeeper ? "goleiro" : "linha",
          score: Number(score.toFixed(1)),
          result,
          goalsFor: scored,
          goalsAgainst,
          ownGoals,
        });
      }
    }
    return stats;
  }
  function renderScoreRankings() {
    const all = (state.gameHistory || []).flatMap(
        (game) => game.performance || [],
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
      for (const player of game.performance || []) {
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
        .filter((row) => row.role === role)
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
        $(nameId).textContent = games.length
          ? "Sem dados individuais"
          : "Aguardando jogos";
        $(statsId).textContent = games.length
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
          ? " · " + row.conceded + " gols sofridos"
          : " · " + row.goals + " gols");
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
    const games = (state.gameHistory || []).filter((game) => {
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
      (game.performance || []).forEach((p) => {
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
        .filter((row) => row.role === "goleiro")
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
      : "Sem score registrado";
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
          ? " · " + keeperRows[0].conceded + " gols sofridos"
          : "") +
        "</small></article>"
      : '<p class="empty-state season-empty">Ainda não há partidas finalizadas neste mês.</p>';
  }
  function renderIndividualStats() {
    const totals = new Map();
    for (const game of state.gameHistory || [])
      for (const p of game.performance || []) {
        const row = totals.get(p.player) || {
          player: p.player,
          role: p.role,
          score: 0,
          games: 0,
          goals: 0,
          goalsAgainst: 0,
          wins: 0,
          draws: 0,
          losses: 0,
        };
        row.score += Number(p.score) || 0;
        row.games++;
        row.goals += Number(p.goalsFor) || 0;
        row.goalsAgainst += Number(p.goalsAgainst) || 0;
        if (p.result === "vitória") row.wins++;
        else if (p.result === "empate") row.draws++;
        else row.losses++;
        totals.set(p.player, row);
      }
    const rows = [...totals.values()].sort(
      (a, b) =>
        b.score / b.games - a.score / a.games ||
        a.player.localeCompare(b.player, "pt-BR"),
    );
    $("individualStats").innerHTML = rows.length
      ? "<table><thead><tr><th>Jogador</th><th>Função</th><th>Jogos</th><th>Score médio</th><th>Gols</th><th>Sofridos</th><th>V-E-D</th></tr></thead><tbody>" +
        rows
          .map(
            (row) =>
              "<tr><td>" +
              escapeHtml(displayName(row.player)) +
              "</td><td>" +
              row.role +
              "</td><td>" +
              row.games +
              "</td><td>" +
              (row.score / row.games).toFixed(1).replace(".", ",") +
              "</td><td>" +
              row.goals +
              "</td><td>" +
              row.goalsAgainst +
              "</td><td>" +
              row.wins +
              "-" +
              row.draws +
              "-" +
              row.losses +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table>"
      : '<p class="empty-state">As estatísticas individuais aparecem após as partidas finalizadas.</p>';
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
                    escapeHtml(game.homeLabel || game.home) +
                    " <b>" +
                    game.homeScore +
                    " × " +
                    game.awayScore +
                    "</b> " +
                    escapeHtml(game.awayLabel || game.away) +
                    "</span><small>" +
                    (game.winner === "Empate"
                      ? "Empate"
                      : "Vencedor: " + escapeHtml(historyWinner(game))) +
                    "</small></p>",
                )
                .join("") +
              "</div></article>",
          )
          .join("")
      : '<p class="empty-state">Ainda não há partidas arquivadas para compor as publicações semanais.</p>';
  }
  function renderHistory() {
    const list = $("gameHistory"),
      history = [...(state.gameHistory || [])].reverse();
    if (!history.length) {
      list.innerHTML =
        '<p class="empty-state">Nenhum jogo encerrado ainda.</p>';
      return;
    }
    list.innerHTML = history
      .map((game) => {
        const homeWinner = game.winner === game.home,
          awayWinner = game.winner === game.away;
        const goalRows =
          (game.goals || [])
            .map(
              (g) =>
                "<li><span>⚽ " +
                escapeHtml(displayName(g.player)) +
                (g.ownGoal ? " · gol contra" : "") +
                " · ponto para " +
                escapeHtml(g.scoringTeam || g.team) +
                "</span><b>" +
                g.minute +
                "′</b></li>",
            )
            .join("") || "<li>Sem gols registrados</li>";
        const stats =
          (game.performance || [])
            .map(
              (p) =>
                "<li><span>" +
                escapeHtml(displayName(p.player)) +
                " · " +
                p.role +
                " · " +
                p.result +
                " · gols " +
                p.goalsFor +
                " · sofridos " +
                p.goalsAgainst +
                " · contra " +
                p.ownGoals +
                "</span><b>" +
                Number(p.score).toFixed(1).replace(".", ",") +
                "</b></li>",
            )
            .join("") || "<li>Sem score individual registrado.</li>";
        return (
          '<article class="history-game"><header><strong>JOGO ' +
          game.number +
          " · " +
          (game.timerMode === "coca" ? "MODO COCA" : "MODO LIGA") +
          "</strong><span>" +
          new Date(game.finishedAt).toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          }) +
          " · " +
          clockText(game.durationSeconds || 0) +
          '</span></header><div class="history-score"><span class="' +
          (homeWinner ? "winner-team" : "") +
          '">' +
          escapeHtml(game.homeLabel || game.home) +
          "</span><b>" +
          game.homeScore +
          " × " +
          game.awayScore +
          '</b><span class="' +
          (awayWinner ? "winner-team" : "") +
          '">' +
          escapeHtml(game.awayLabel || game.away) +
          '</span></div><p class="history-winner">' +
          (game.winner === "Empate"
            ? "Empate"
            : "🏆 Vencedor: " + escapeHtml(historyWinner(game))) +
          "</p><ul>" +
          goalRows +
          '</ul><details class="history-performance"><summary>Ver score e estatísticas individuais</summary><ul>' +
          stats +
          "</ul></details></article>"
        );
      })
      .join("");
  }
  function renderGoals() {
    const totals = new Map();
    goals
      .filter((goal) => !goal.own_goal)
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
            const past = (state.gameHistory || []).filter(
              (game) =>
                (game.performance || []).some((p) => p.player === name) ||
                (!(game.performance || []).length &&
                  (game.goals || []).some((g) => g.player === name)),
            ).length;
            const teams = selectedTeams(),
              current =
                state.currentGame &&
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
  const incidentLabels = {
    foul: "Falta",
    penalty: "Pênalti",
    hand: "Mão intencional · 1 minuto fora",
    keeper: "Bola recuada para o goleiro",
    other: "Outra ocorrência",
  };
  function renderIncidents() {
    const list = $("incidentList"),
      entries = state.incidents || [];
    if (!entries.length) {
      list.innerHTML =
        '<p class="empty-state">Nenhuma ocorrência registrada nesta rodada.</p>';
      return;
    }
    list.innerHTML = [...entries]
      .reverse()
      .map((item) => {
        const active = item.expiresAt && item.expiresAt > Date.now();
        const left = active
          ? Math.ceil((item.expiresAt - Date.now()) / 1000)
          : 0;
        const status = item.expiresAt
          ? active
            ? `Retorno em 00:${String(left).padStart(2, "0")}`
            : "Liberado para retornar"
          : "Registrado";
        return `<article class="incident-row"><div><strong>${escapeHtml(incidentLabels[item.type] || item.type)} · ${escapeHtml(displayName(item.player || "Sem jogador associado"))}</strong><small>${escapeHtml(item.note || "Sem observação")} · ${new Date(item.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div><span class="incident-status ${item.expiresAt && !active ? "done" : ""}">${status}</span></article>`;
      })
      .join("");
  }
  async function addIncident() {
    const type = $("incidentType").value,
      player = $("incidentPlayer").value;
    if (!player) {
      notify("Escolha o jogador envolvido.", true);
      return;
    }
    const item = {
      id: crypto.randomUUID(),
      type,
      player,
      note: $("incidentNote").value.trim(),
      createdAt: new Date().toISOString(),
      expiresAt: type === "hand" ? Date.now() + 60000 : null,
    };
    await saveState(
      { incidents: [...(state.incidents || []), item] },
      type === "hand"
        ? `${player} ficará fora por 1 minuto.`
        : "Ocorrência registrada.",
    );
    $("incidentNote").value = "";
  }
  function renderRoster() {
    const roster = state.roster || [],
      list = $("rosterList");
    $("rosterCount").textContent = roster.length + " / 32";
    list.innerHTML = roster.length
      ? roster
          .map(
            (name, index) =>
              '<li><span class="roster-number">' +
              String(index + 1).padStart(2, "0") +
              "</span><span>" +
              escapeHtml(displayName(name)) +
              (keeper(name) ? ' <b class="keeper-mark">* · GOLEIRO</b>' : "") +
              (index >=
              (state.teams?.length
                ? state.teams.length * 5
                : startersFor(roster.length))
                ? ' <small class="reserve-label">· RESERVA</small>'
                : "") +
              '</span><button class="text-button" data-remove-player="' +
              index +
              '" aria-label="Remover ' +
              escapeHtml(displayName(name)) +
              '">Remover</button></li>',
          )
          .join("")
      : '<li class="empty-state">Nenhum jogador adicionado.</li>';
    list
      .querySelectorAll("[data-remove-player]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          removePlayer(Number(button.dataset.removePlayer)),
        ),
      );
    $("newPlayer").disabled = roster.length >= 32;
    $("addPlayer").disabled = roster.length >= 32;
    $("drawTeams").disabled = roster.length < MIN_PLAYERS;
  }
  function renderAll() {
    if (!state) return;
    if (document.activeElement !== $("venue"))
      $("venue").value = state.venue || "";
    if (document.activeElement !== $("matchDate"))
      $("matchDate").value = state.matchDate || "";
    if (document.activeElement !== $("startTime"))
      $("startTime").value = state.startTime || "";
    renderRoster();
    renderTeams();
    renderFixtures();
    renderLineupAdjustments();
    renderReserveControls();
    renderQueueControls();
    renderGoalOptions();
    renderGoals();
    renderScoreRankings();
    renderKeeperChoices();
    renderHistory();
    renderIncidents();
    renderSeasonHighlights();
    renderIndividualStats();
    renderWeeklyPublications();
    renderNightHighlights();
    renderTimer();
    renderArt();
    applyEditLock();
  }
  const artShield = new Image();
  artShield.src = "./assets/escudo-skalama-oficial.png";
  artShield.onload = () => drawArt(true);
  const ART_FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';
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
    const src = teamLogos[name];
    if (!src) return null;
    if (logoImages[name]?.src !== src) {
      const image = new Image();
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
  let artKey = "";
  function artGames() {
    return [...(state?.gameHistory || [])].sort(
      (a, b) => new Date(b.finishedAt) - new Date(a.finishedAt),
    );
  }
  function renderArt() {
    const type = $("artType").value,
      games = artGames(),
      teams = state.teams || [],
      select = $("artGame"),
      selected = select.value,
      markup = games
        .map(
          (game) =>
            '<option value="' +
            escapeHtml(game.id) +
            '">Jogo ' +
            game.number +
            " · " +
            escapeHtml(game.homeLabel || game.home) +
            " " +
            game.homeScore +
            " × " +
            game.awayScore +
            " " +
            escapeHtml(game.awayLabel || game.away) +
            "</option>",
        )
        .join("");
    if (select.innerHTML !== markup) select.innerHTML = markup;
    if (games.some((game) => game.id === selected)) select.value = selected;
    $("artGameLabel").hidden = type !== "result";
    const ready = type === "result" ? games.length > 0 : teams.length > 0;
    $("artEmpty").textContent =
      type === "result"
        ? "As artes de resultado aparecem depois do primeiro jogo encerrado."
        : "Sorteie os times para gerar a arte dos times sorteados.";
    $("artEmpty").hidden = ready;
    for (const id of ["artCanvas", "artDownload", "artShare"])
      $(id).hidden = !ready;
    const logos = teams
      .map(
        (team) =>
          '<div class="art-logo-row">' +
          (teamLogos[team.name]
            ? '<img src="' + teamLogos[team.name] + '" alt="">'
            : '<span class="art-logo-empty" aria-hidden="true"></span>') +
          "<strong>" +
          escapeHtml(teamLabel(team.name)) +
          '</strong><label class="button button-outline button-small">' +
          (teamLogos[team.name] ? "Trocar logo" : "Subir logo") +
          '<input type="file" accept="image/*" hidden data-logo-team="' +
          escapeHtml(team.name) +
          '"></label>' +
          (teamLogos[team.name]
            ? '<button type="button" class="text-button" data-logo-remove="' +
              escapeHtml(team.name) +
              '">Remover</button>'
            : "") +
          "</div>",
      )
      .join("");
    if ($("artLogos").innerHTML !== logos) $("artLogos").innerHTML = logos;
    if (ready) drawArt();
  }
  function fitFont(ctx, text, weight, size, maxWidth) {
    do ctx.font = `${weight} ${size}px ${ART_FONT}`;
    while (ctx.measureText(text).width > maxWidth && --size > 12);
  }
  const colorOf = (name) =>
    teamColors[TEAM_NAMES.indexOf(name)] || teamColors[0];
  // Topo comum: escudo, nome da liga e linha de informações. Devolve o y seguinte.
  function drawArtHeader(ctx, W, story, info) {
    let y = story ? 150 : 80;
    if (artShield.complete && artShield.naturalWidth) {
      const size = story ? 260 : 150;
      ctx.drawImage(artShield, (W - size) / 2, y, size, size);
      y += size + (story ? 110 : 75);
    }
    ctx.fillStyle = "#ffc400";
    fitFont(ctx, "LIGA SKALAMA", 900, story ? 84 : 66, W - 120);
    ctx.fillText("LIGA SKALAMA", W / 2, y);
    y += story ? 64 : 50;
    ctx.fillStyle = "#bdbdbd";
    const text = info.filter(Boolean).join(" · ").toUpperCase();
    fitFont(ctx, text, 600, 34, W - 120);
    ctx.fillText(text, W / 2, y);
    return y + (story ? 130 : 80);
  }
  // Retângulo colorido com logo (se houver) e nome do time centralizados.
  function drawTeamBadge(ctx, name, text, x, y, w, h, fontSize) {
    const color = colorOf(name),
      logo = logoImage(name),
      logoSize = logo ? h - 36 : 0,
      gap = logo ? 18 : 0;
    ctx.fillStyle = color.color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 22);
    ctx.fill();
    fitFont(ctx, text, 800, fontSize, w - 40 - logoSize - gap);
    const textW = ctx.measureText(text).width,
      startX = x + (w - (logoSize + gap + textW)) / 2;
    if (logo) {
      const ratio = logo.naturalWidth / logo.naturalHeight,
        drawW = ratio >= 1 ? logoSize : logoSize * ratio,
        drawH = ratio >= 1 ? logoSize / ratio : logoSize;
      ctx.drawImage(
        logo,
        startX + (logoSize - drawW) / 2,
        y + (h - drawH) / 2,
        drawW,
        drawH,
      );
    }
    ctx.fillStyle = color.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, startX + logoSize + gap, y + h / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
  }
  function drawResultArt(ctx, W, H, story, game) {
    const label = (side) => game[side + "Label"] || game[side],
      date = new Date(game.finishedAt || Date.now()).toLocaleDateString(
        "pt-BR",
        { day: "2-digit", month: "2-digit" },
      );
    ctx.fillStyle = colorOf(game.home).color;
    ctx.fillRect(0, 0, W / 2, 18);
    ctx.fillStyle = colorOf(game.away).color;
    ctx.fillRect(W / 2, 0, W / 2, 18);
    let y = drawArtHeader(ctx, W, story, [
      `JOGO ${game.number}`,
      date,
      state.venue,
    ]);
    const colW = 400,
      cardH = story ? 150 : 130;
    [
      ["home", 70],
      ["away", W - 70 - colW],
    ].forEach(([side, x]) => {
      drawTeamBadge(
        ctx,
        game[side],
        label(side).toUpperCase(),
        x,
        y,
        colW,
        cardH,
        46,
      );
      ctx.fillStyle = "#ffffff";
      ctx.font = `900 ${story ? 230 : 190}px ${ART_FONT}`;
      ctx.fillText(
        String(game[side + "Score"]),
        x + colW / 2,
        y + cardH + (story ? 250 : 210),
      );
    });
    ctx.fillStyle = "#6f6f6f";
    ctx.font = `800 ${story ? 120 : 100}px ${ART_FONT}`;
    ctx.fillText("×", W / 2, y + cardH + (story ? 215 : 180));
    y += cardH + (story ? 340 : 280);
    const winnerSide = game.winner === game.home ? "home" : "away",
      result =
        game.winner === "Empate"
          ? "EMPATE"
          : game.homeScore === game.awayScore
            ? `${label(winnerSide)} VENCE NOS PÊNALTIS`
            : `VITÓRIA DO ${label(winnerSide)}`;
    ctx.fillStyle = "#ffc400";
    fitFont(ctx, result.toUpperCase(), 800, 44, W - 120);
    ctx.fillText(result.toUpperCase(), W / 2, y);
    y += story ? 90 : 70;
    ctx.fillStyle = "#e8e8e8";
    const lineH = story ? 52 : 44,
      maxLines = story ? 10 : 6;
    [
      ["home", 70 + colW / 2],
      ["away", W - 70 - colW / 2],
    ].forEach(([side, x]) => {
      (game.goals || [])
        .filter((goal) => (goal.scoringTeam || goal.team) === game[side])
        .sort((a, b) => a.minute - b.minute)
        .slice(0, maxLines)
        .forEach((goal, index) => {
          const text = `${displayName(goal.player)} ${goal.minute}'${goal.ownGoal ? " (contra)" : ""}`;
          fitFont(ctx, text, 500, story ? 34 : 30, colW);
          ctx.fillText(text, x, y + index * lineH);
        });
    });
  }
  function drawTeamsArt(ctx, W, H, story) {
    const teams = state.teams || [];
    teams.forEach((team, index) => {
      ctx.fillStyle = colorOf(team.name).color;
      ctx.fillRect((W / teams.length) * index, 0, W / teams.length, 18);
    });
    const date = state.matchDate
      ? new Date(state.matchDate + "T12:00:00").toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
        })
      : "";
    let y = drawArtHeader(ctx, W, story, ["TIMES SORTEADOS", date, state.venue]);
    const gap = 40,
      colW = (W - 140 - gap) / 2,
      badgeH = story ? 110 : 84,
      lineH = story ? 50 : 38,
      rows = Math.ceil(teams.length / 2),
      blockH = badgeH + 24 + lineH * 5 + (story ? 60 : 36);
    if (story) y += Math.max(0, (H - 160 - y - blockH * rows) / 2 - 40);
    teams.forEach((team, index) => {
      const row = Math.floor(index / 2),
        alone = teams.length % 2 === 1 && index === teams.length - 1,
        x = alone ? (W - colW) / 2 : 70 + (index % 2) * (colW + gap),
        top = y + row * blockH,
        players = lineupForTeam(team.name);
      drawTeamBadge(
        ctx,
        team.name,
        teamLabel(team.name).toUpperCase(),
        x,
        top,
        colW,
        badgeH,
        story ? 40 : 32,
      );
      ctx.fillStyle = "#e8e8e8";
      players.forEach((player, line) => {
        const text = displayName(player) + (keeper(player) ? " (G)" : "");
        fitFont(ctx, text, 500, story ? 34 : 28, colW - 20);
        ctx.fillText(text, x + colW / 2, top + badgeH + 24 + lineH * (line + 0.8));
      });
    });
  }
  // Desenha a arte escolhida; só redesenha quando tipo, formato ou dados mudam.
  function drawArt(force = false) {
    if (!state) return;
    const type = $("artType").value,
      game = artGames().find((item) => item.id === $("artGame").value),
      story = $("artFormat").value === "story";
    if (type === "result" ? !game : !state.teams?.length) return;
    const data =
        type === "result"
          ? game
          : [
              state.teams.map((team) => [
                team.name,
                teamLabel(team.name),
                lineupForTeam(team.name),
              ]),
              state.matchDate,
              state.venue,
            ],
      key = JSON.stringify([
        type,
        data,
        story,
        artShield.complete,
        teamLogos,
        Object.values(logoImages).map((image) => image.complete),
      ]);
    if (!force && key === artKey) return;
    artKey = key;
    const canvas = $("artCanvas"),
      W = 1080,
      H = story ? 1920 : 1350,
      ctx = canvas.getContext("2d");
    canvas.height = H;
    ctx.fillStyle = "#0f0f0f";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    if (type === "result") drawResultArt(ctx, W, H, story, game);
    else drawTeamsArt(ctx, W, H, story);
    ctx.fillStyle = "#6f6f6f";
    ctx.font = `600 30px ${ART_FONT}`;
    ctx.fillText("#LIGASKALAMA", W / 2, H - (story ? 90 : 60));
  }
  function artFile() {
    const type = $("artType").value,
      game = artGames().find((item) => item.id === $("artGame").value),
      name =
        type === "result" ? `jogo-${game?.number || ""}` : "times-sorteados";
    return new Promise((resolve) =>
      $("artCanvas").toBlob((blob) =>
        resolve(
          new File(
            [blob],
            `liga-skalama-${name}-${$("artFormat").value}.png`,
            { type: "image/png" },
          ),
        ),
      ),
    );
  }
  async function downloadArt() {
    const file = await artFile(),
      url = URL.createObjectURL(file),
      link = Object.assign(document.createElement("a"), {
        href: url,
        download: file.name,
      });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function shareArt() {
    const file = await artFile();
    if (!navigator.canShare?.({ files: [file] })) {
      notify("Este navegador não compartilha imagens; a arte foi baixada.");
      return downloadArt();
    }
    try {
      await navigator.share({ files: [file], title: "Liga Skalama" });
    } catch (error) {
      if (error.name !== "AbortError")
        notify("Não foi possível compartilhar: " + error.message, true);
    }
  }
  function setView(view) {
    document
      .querySelectorAll("[data-view]")
      .forEach((element) =>
        element.classList.toggle("view-hidden", element.dataset.view !== view),
      );
    document
      .querySelectorAll("[data-view-button]")
      .forEach((button) =>
        button.classList.toggle("active", button.dataset.viewButton === view),
      );
    localStorage.setItem("liga-skalama-view", view);
  }
  async function addPlayer() {
    try {
      const name = normalizePlayer($("newPlayer").value);
      const roster = validateRoster([...(state.roster || []), name]);
      const reservePlayers =
        state.teams?.length && roster.length > state.teams.length * 5
          ? [...(state.reservePlayers || []), name]
          : state.reservePlayers || [];
      await saveState(
        { roster, reservePlayers },
        `${roster.length} jogador${roster.length === 1 ? "" : "es"} adicionado${roster.length === 1 ? "" : "s"}.`,
      );
      $("newPlayer").value = "";
      $("newPlayer").focus();
    } catch (error) {
      notify(error.message, true);
    }
  }
  async function removePlayer(index) {
    const roster = [...(state.roster || [])];
    if (index < 0 || index >= roster.length) return;
    const removed = roster[index],
      hasDraw = !!state.teams?.length;
    if (
      hasDraw &&
      !confirm(
        `Remover ${displayName(removed)}? A escalação será encerrada e os times precisarão ser sorteados novamente. O histórico e a artilharia permanecem.`,
      )
    )
      return;
    roster.splice(index, 1);
    await saveState(
      {
        roster,
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
  function freshTimer(mode = "liga") {
    return {
      mode,
      duration: 480,
      endsAt: null,
      runningSince: null,
      elapsedBeforeRun: 0,
      remainingAtPause: null,
      pauseStartedAt: null,
      pauseUsedMs: 0,
    };
  }
  async function drawTeams() {
    try {
      validateRoster(state.roster || []);
    } catch (error) {
      notify(error.message, true);
      return;
    }
    if ((state.roster?.length || 0) < MIN_PLAYERS) {
      notify(
        "Adicione pelo menos " +
          MIN_PLAYERS +
          " jogadores. Atualmente: " +
          (state.roster?.length || 0) +
          ".",
        true,
      );
      return;
    }
    if (
      state.currentGame &&
      !confirm(
        "Sortear novamente vai encerrar a partida em andamento sem adicioná-la ao histórico. Continuar?",
      )
    )
      return;
    const starterTotal = startersFor(state.roster.length);
    const teams = ["Time Águia", "Time Sol", "Time Verde", "Time Azul"]
      .slice(0, starterTotal / 5)
      .map((name) => ({ name, players: [] }));
    const starters = state.roster.slice(0, starterTotal),
      reserves = state.roster.slice(starterTotal),
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
  async function beginGame() {
    const pending = state.pendingMatch;
    if (state.currentGame || !pending) {
      notify("Sorteie os times antes de iniciar a partida.", true);
      return;
    }
    const homePlayers = [...lineupForTeam(pending.home)],
      awayPlayers = [...lineupForTeam(pending.away)];
    const playMode = state.timerMode || "liga",
      maxPlayers = playMode === "coca" ? 8 : 5;
    if (
      (state.teams || []).some((team) => lineupForTeam(team.name).length < 5) ||
      homePlayers.length < 5 ||
      awayPlayers.length < 5 ||
      homePlayers.length > maxPlayers ||
      awayPlayers.length > maxPlayers
    ) {
      notify(
        "Todos os times precisam ter pelo menos cinco jogadores; o limite é cinco na Liga e oito no Coca.",
        true,
      );
      return;
    }
    const homeKeeper = $("keeperHome").value,
      awayKeeper = $("keeperAway").value;
    if (!homeKeeper || !awayKeeper) {
      notify("Defina um goleiro para cada time antes de começar.", true);
      return;
    }
    const mode = state.timerMode || $("timerMode").value || "liga",
      now = Date.now(),
      currentGame = {
        id: crypto.randomUUID(),
        roundId: state.roundId || null,
        number: (state.gameHistory || []).length + 1,
        home: pending.home,
        away: pending.away,
        homePlayers,
        awayPlayers,
        homeKeeper,
        awayKeeper,
        timerMode: mode,
        startedAt: now,
      };
    const timer =
      mode === "coca"
        ? { ...freshTimer(mode), runningSince: now }
        : { ...freshTimer(mode), endsAt: now + 480000 };
    await saveState(
      { currentGame, timer, incidents: [] },
      "Jogo " +
        currentGame.number +
        " iniciado: " +
        pending.home +
        " × " +
        pending.away +
        ".",
    );
  }
  async function moveQueue() {
    const chosen = $("queueSelect").value;
    if (!chosen) return;
    if (state.currentGame) {
      const queue = [...(state.challengeQueue || [])],
        index = queue.indexOf(chosen);
      if (index < 0) return;
      queue.splice(index, 1);
      queue.unshift(chosen);
      await saveState(
        { challengeQueue: queue },
        `${chosen} foi adiantado na fila. A sequência restante foi mantida.`,
      );
      return;
    }
    const pending = state.pendingMatch;
    if (!pending) return;
    const candidates = [pending.away, ...(state.challengeQueue || [])].filter(
        (name, index, all) => name && all.indexOf(name) === index,
      ),
      index = candidates.indexOf(chosen);
    if (index < 0) return;
    const order = [...candidates];
    order.splice(index, 1);
    order.unshift(chosen);
    await saveState(
      {
        pendingMatch: { ...pending, away: order.shift() },
        challengeQueue: order,
      },
      `${chosen} foi adiantado. O próximo jogo foi trocado e a fila continua na mesma ordem.`,
    );
  }
  async function pauseTimer() {
    if (!state.currentGame) return;
    const timer = state.timer || freshTimer(state.currentGame.timerMode),
      now = Date.now(),
      limit = pauseLimitMs(timer);
    if (isPauseActive(timer)) {
      const used = pauseBudgetUsed(timer);
      if (timer.mode === "coca")
        await saveState(
          {
            timer: {
              ...timer,
              runningSince: now,
              elapsedBeforeRun: timerElapsed(timer),
              pauseStartedAt: null,
              pauseUsedMs: used,
            },
          },
          "Cronômetro retomado; a pausa foi contabilizada.",
        );
      else
        await saveState(
          {
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
    if (timer.mode === "coca")
      await saveState(
        {
          timer: {
            ...timer,
            runningSince: null,
            elapsedBeforeRun: timerElapsed(timer),
            pauseStartedAt: now,
            pauseUsedMs: used,
          },
        },
        "Pausa iniciada. Você pode retomar quando quiser; o limite total é 2 minutos.",
      );
    else {
      if (!timer.endsAt || timerRemaining() === 0) return;
      await saveState(
        {
          timer: {
            ...timer,
            endsAt: null,
            remainingAtPause: timerRemaining(),
            pauseStartedAt: now,
            pauseUsedMs: used,
          },
        },
        "Pausa iniciada. Você pode retomar quando quiser; o limite total é 1 minuto.",
      );
    }
  }
  async function addGoal() {
    const player = $("goalScorer").value,
      game = state.currentGame,
      ownGoal = $("ownGoal").checked;
    if (!game || !player) {
      notify("Escolha quem fez o gol.", true);
      return;
    }
    const team = teamForPlayer(player),
      scoringTeam = ownGoal
        ? team === game.home
          ? game.away
          : game.home
        : team,
      elapsed = Math.max(0, Math.floor(timerElapsed())),
      minute = Math.max(1, Math.ceil(elapsed / 60));
    const goal = {
      player_name: player,
      team_name: team,
      score_team_name: scoringTeam,
      own_goal: ownGoal,
      match_number: game.number,
      game_id: game.id,
      minute,
    };
    if (
      (shared && !canManageShared) ||
      (!shared && window.LIGA_CONFIG?.publicReadOnly === true)
    ) {
      notify("Somente o organizador pode registrar gols.", true);
      return;
    }
    if (shared) {
      const { error } = await client.from("goals").insert(goal);
      if (error) {
        notify("Não foi possível registrar o gol: " + error.message, true);
        return;
      }
      await refreshGoals();
    } else {
      goals.push({
        ...goal,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      });
      localSave();
      renderGoals();
      renderTimer();
      renderGoalOptions();
    }
    $("ownGoal").checked = false;
    notify(
      (ownGoal ? "Gol contra de " : "Gol de ") +
        displayName(player) +
        " · ponto para " +
        scoringTeam +
        " · " +
        minute +
        "′.",
    );
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
    if (!current) return;
    const homeScore = currentScore(current.home),
      awayScore = currentScore(current.away);
    // Empate: com 2+ times fora saem os dois; com 1 fora, pênaltis; sem ninguém fora, jogam de novo.
    const waiting = state.challengeQueue || [],
      tied = homeScore === awayScore,
      penalties = tied && waiting.length === 1;
    let winner = !tied
      ? homeScore > awayScore
        ? current.home
        : current.away
      : penalties
        ? $("winnerChoice").value
        : "Empate";
    if (!winner) {
      notify("Empate: escolha quem venceu nos pênaltis para encerrar.", true);
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
        performance,
        durationSeconds,
        finishedAt: new Date().toISOString(),
      };
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
    await saveState(
      {
        gameHistory: [...(state.gameHistory || []), entry],
        currentGame: null,
        pendingMatch: next,
        challengeQueue: queue,
        timer: freshTimer(state.timerMode || current.timerMode),
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
  }
  function setTheme(theme) {
    const light = theme === "light";
    document.body.classList.toggle("light-theme", light);
    $("themeToggle").textContent = light ? "Fundo escuro" : "Fundo claro";
    localStorage.setItem("liga-skalama-theme-v2", light ? "light" : "dark");
  }
  function bindEvents() {
    $("newPlayer").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addPlayer();
      }
    });
    $("addPlayer").addEventListener("click", addPlayer);
    $("drawTeams").addEventListener("click", drawTeams);
    $("artType").addEventListener("change", renderArt);
    $("artLogos").addEventListener("change", (event) => {
      const team = event.target.dataset?.logoTeam;
      if (team) uploadTeamLogo(team, event.target.files?.[0]);
      event.target.value = "";
    });
    $("artLogos").addEventListener("click", (event) => {
      const team = event.target.dataset?.logoRemove;
      if (team) removeTeamLogo(team);
    });
    $("artGame").addEventListener("change", () => drawArt());
    $("artFormat").addEventListener("change", () => drawArt());
    $("artDownload").addEventListener("click", downloadArt);
    $("artShare").addEventListener("click", shareArt);
    $("teamsGrid").addEventListener("change", (event) => {
      const team = event.target.dataset?.teamLabel;
      if (!team) return;
      const value = event.target.value.trim().slice(0, 30);
      saveState(
        { teamLabels: { ...(state.teamLabels || {}), [team]: value } },
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
        button.addEventListener("click", () =>
          setView(button.dataset.viewButton),
        ),
      );
    $("themeToggle").addEventListener("click", () =>
      setTheme(
        document.body.classList.contains("light-theme") ? "dark" : "light",
      ),
    );
    $("queueSelect").addEventListener("change", () => {
      $("moveQueue").disabled = !$("queueSelect").value;
    });
    $("moveQueue").addEventListener("click", moveQueue);
    $("beginGame").addEventListener("click", beginGame);
    $("pauseTimer").addEventListener("click", pauseTimer);
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
    $("timerMode").addEventListener("change", (e) =>
      saveState(
        { timerMode: e.target.value },
        "Modo do cronômetro atualizado.",
      ),
    );
    $("addIncident").addEventListener("click", addIncident);
    $("adminAccessButton").addEventListener("click", requestAdminAccess);
    $("addReserveToTeam").addEventListener("click", addReservePlayer);
    $("reserveTeamChoice").addEventListener("change", renderReserveControls);
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
            ? { state: initialState(), goals: [], votes: [] }
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
        votes = saved.votes || [];
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
          ? { state: initialState(), goals: [], votes: [] }
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
      votes = saved.votes || [];
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
    setTheme(localStorage.getItem("liga-skalama-theme-v2") || "light");
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
