// src/game.ts
var ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function isValidRoomCode(code) {
  return code.length === 4 && [...code].every((ch) => ROOM_CODE_CHARS.includes(ch));
}
function randomRoomCode(random = Math.random) {
  let code = "";
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(random() * ROOM_CODE_CHARS.length);
    code += ROOM_CODE_CHARS[idx];
  }
  return code;
}

// src/client.ts
var PLAYER_KEY = "boro-battle-player-id";
function playerId() {
  let id = sessionStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}
var joinPanel = document.getElementById("join-panel");
var gamePanel = document.getElementById("game-panel");
var nameInput = document.getElementById("name-input");
var roomInput = document.getElementById("room-input");
var joinError = document.getElementById("join-error");
var roomLabel = document.getElementById("room-label");
var phaseLabel = document.getElementById("phase-label");
var playerList = document.getElementById("player-list");
var lobbyActions = document.getElementById("lobby-actions");
var readyBtn = document.getElementById("ready-btn");
var startBtn = document.getElementById("start-btn");
var roundPanel = document.getElementById("round-panel");
var roundMeta = document.getElementById("round-meta");
var timerEl = document.getElementById("timer");
var promptEl = document.getElementById("prompt");
var choicesEl = document.getElementById("choices");
var revealPanel = document.getElementById("reveal-panel");
var revealChoices = document.getElementById("reveal-choices");
var winnerPanel = document.getElementById("winner-panel");
var scoreboard = document.getElementById("scoreboard");
var rematchBtn = document.getElementById("rematch-btn");
var statusLine = document.getElementById("status-line");
var ws = null;
var roomCode = "";
var playerName = "";
var latest = null;
var timerHandle = null;
function showError(msg) {
  joinError.hidden = !msg;
  joinError.textContent = msg;
}
function wsUrl(code) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/room/${code}`;
}
function connect(code, name) {
  ws?.close();
  ws = new WebSocket(wsUrl(code));
  ws.addEventListener("open", () => {
    ws?.send(
      JSON.stringify({
        type: "join",
        playerId: playerId(),
        name
      })
    );
  });
  ws.addEventListener("message", (ev) => {
    const data = JSON.parse(String(ev.data));
    if (data.type !== "state") return;
    latest = data;
    render();
  });
  ws.addEventListener("close", () => {
    statusLine.textContent = "Disconnected. Refresh to reconnect.";
  });
}
function send(body) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(body));
  }
}
function clearTimer() {
  if (timerHandle !== null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}
function updateTimer() {
  if (!latest?.deadlineMs) {
    timerEl.textContent = "";
    return;
  }
  const left = Math.max(0, latest.deadlineMs - Date.now());
  const seconds = Math.ceil(left / 1e3);
  timerEl.textContent = `${seconds}s`;
}
function renderPlayers(state) {
  playerList.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("away");
    const name = document.createElement("span");
    name.textContent = p.name;
    const badges = document.createElement("span");
    badges.className = "badges";
    if (p.id === state.hostId) {
      const host = document.createElement("span");
      host.className = "badge host";
      host.textContent = "host";
      badges.appendChild(host);
    }
    if (p.ready && state.phase === "lobby") {
      const ready = document.createElement("span");
      ready.className = "badge ready";
      ready.textContent = "ready";
      badges.appendChild(ready);
    }
    if (!p.connected) {
      const away = document.createElement("span");
      away.textContent = "away";
      badges.appendChild(away);
    }
    if (state.phase !== "lobby") {
      const score = document.createElement("span");
      score.textContent = `${p.score} pts`;
      badges.appendChild(score);
    }
    li.append(name, badges);
    playerList.appendChild(li);
  }
}
function renderQuestion(state) {
  choicesEl.innerHTML = "";
  if (!state.question) return;
  promptEl.textContent = state.question.prompt;
  for (const choice of state.question.choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn choice";
    btn.textContent = choice.label;
    const picked = state.yourChoiceId === choice.id;
    if (picked) btn.classList.add("selected");
    const locked = state.phase !== "question" || Boolean(state.yourChoiceId) || !latest?.deadlineMs || Date.now() > latest.deadlineMs;
    btn.disabled = locked;
    btn.addEventListener("click", () => {
      send({ type: "answer", choiceId: choice.id });
    });
    choicesEl.appendChild(btn);
  }
}
function renderReveal(state) {
  revealChoices.innerHTML = "";
  if (!state.reveal || !state.question) return;
  promptEl.textContent = state.question.prompt;
  for (const choice of state.reveal.choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn choice";
    btn.disabled = true;
    btn.textContent = `${choice.label} \u2014 ${choice.count.toLocaleString()} complaints filed`;
    if (choice.id === state.reveal.correctChoiceId) {
      btn.classList.add("correct");
    } else if (state.yourChoiceId === choice.id) {
      btn.classList.add("wrong");
    }
    revealChoices.appendChild(btn);
  }
}
function renderWinner(state) {
  scoreboard.innerHTML = "";
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const li = document.createElement("li");
    if (state.winnerIds.includes(p.id)) li.classList.add("winner-row");
    li.innerHTML = `<span>${p.name}${!p.connected ? " (away)" : ""}</span><span>${p.score}</span>`;
    scoreboard.appendChild(li);
  }
}
function render() {
  if (!latest) return;
  const state = latest;
  phaseLabel.textContent = state.phase;
  renderPlayers(state);
  lobbyActions.hidden = state.phase !== "lobby";
  roundPanel.hidden = state.phase !== "question" && state.phase !== "reveal";
  revealPanel.hidden = state.phase !== "reveal";
  winnerPanel.hidden = state.phase !== "winner";
  const me = state.players.find((p) => p.id === playerId());
  const isHost = state.hostId === playerId();
  readyBtn.hidden = state.phase !== "lobby";
  if (me) {
    readyBtn.textContent = me.ready ? "Not ready" : "Ready";
  }
  startBtn.hidden = !(state.phase === "lobby" && isHost);
  startBtn.disabled = state.players.filter((p) => p.connected).length < 2;
  rematchBtn.hidden = !(state.phase === "winner" && isHost);
  if (state.phase === "question" || state.phase === "reveal") {
    roundMeta.textContent = state.round != null ? `Round ${state.round} of ${state.totalRounds}` : "";
    renderQuestion(state);
    if (state.phase === "reveal") renderReveal(state);
    clearTimer();
    updateTimer();
    timerHandle = window.setInterval(updateTimer, 250);
  } else {
    clearTimer();
    timerEl.textContent = "";
  }
  if (state.phase === "winner") {
    renderWinner(state);
  }
}
document.getElementById("new-room-btn").addEventListener("click", () => {
  roomInput.value = randomRoomCode();
});
document.getElementById("join-btn").addEventListener("click", () => {
  const name = nameInput.value.trim();
  const code = roomInput.value.trim().toUpperCase();
  if (!name) {
    showError("Enter a name.");
    return;
  }
  if (!isValidRoomCode(code)) {
    showError("Room code must be 4 characters (no I, O, 0, or 1).");
    return;
  }
  showError("");
  playerName = name;
  roomCode = code;
  roomLabel.textContent = code;
  joinPanel.hidden = true;
  gamePanel.hidden = false;
  history.replaceState(null, "", `?room=${code}`);
  connect(code, name);
});
readyBtn.addEventListener("click", () => send({ type: "ready" }));
startBtn.addEventListener("click", () => send({ type: "start" }));
rematchBtn.addEventListener("click", () => send({ type: "rematch" }));
var params = new URLSearchParams(location.search);
var fromUrl = params.get("room");
if (fromUrl) {
  roomInput.value = fromUrl.toUpperCase();
}
