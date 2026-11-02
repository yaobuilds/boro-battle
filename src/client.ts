import {
  isValidRoomCode,
  randomRoomCode,
  ROUND_SECONDS,
  type StatePayload,
} from "./game";

const PLAYER_KEY = "boro-battle-player-id";

type ServerMessage =
  | StatePayload
  | { type: "error"; code: string };

function playerId(): string {
  let id = sessionStorage.getItem(PLAYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(PLAYER_KEY, id);
  }
  return id;
}

const joinPanel = document.getElementById("join-panel")!;
const gamePanel = document.getElementById("game-panel")!;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const roomInput = document.getElementById("room-input") as HTMLInputElement;
const joinError = document.getElementById("join-error")!;
const roomLabel = document.getElementById("room-label")!;
const phaseLabel = document.getElementById("phase-label")!;
const playerList = document.getElementById("player-list")!;
const lobbyActions = document.getElementById("lobby-actions")!;
const readyBtn = document.getElementById("ready-btn")!;
const startBtn = document.getElementById("start-btn")!;
const startHint = document.getElementById("start-hint")!;
const roundPanel = document.getElementById("round-panel")!;
const roundMeta = document.getElementById("round-meta")!;
const timerEl = document.getElementById("timer")!;
const timerClock = document.getElementById("timer-clock")!;
const timerBar = document.getElementById("timer-bar")!;
const promptEl = document.getElementById("prompt")!;
const choicesEl = document.getElementById("choices")!;
const revealPanel = document.getElementById("reveal-panel")!;
const revealChoices = document.getElementById("reveal-choices")!;
const winnerPanel = document.getElementById("winner-panel")!;
const scoreboard = document.getElementById("scoreboard")!;
const rematchBtn = document.getElementById("rematch-btn")!;
const statusLine = document.getElementById("status-line")!;

let ws: WebSocket | null = null;
let roomCode = "";
let playerName = "";
let latest: StatePayload | null = null;
let timerHandle: number | null = null;
let joinCreate = false;
let joinErrorShowing = false;
let idInUseRetried = false;

function showError(msg: string): void {
  joinErrorShowing = Boolean(msg);
  joinError.hidden = !msg;
  joinError.textContent = msg;
}

function returnToJoin(msg: string): void {
  latest = null;
  ws?.close();
  ws = null;
  joinPanel.hidden = false;
  gamePanel.hidden = true;
  showError(msg);
  statusLine.textContent = "";
}

function wsUrl(code: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/room/${code}`;
}

function joinPayload(name: string): Record<string, unknown> {
  return {
    type: "join",
    playerId: playerId(),
    name,
    create: joinCreate,
  };
}

function handleServerMessage(data: ServerMessage, onIdInUse: () => void): void {
  if (data.type === "error") {
    switch (data.code) {
      case "room_full":
        returnToJoin("This room is full (8 players).");
        return;
      case "not_found":
        returnToJoin("No room with that code.");
        return;
      case "id_in_use":
        if (!idInUseRetried) {
          idInUseRetried = true;
          onIdInUse();
          return;
        }
        returnToJoin("That player is already in this room.");
        return;
      default:
        return;
    }
  }
  if (data.type !== "state") return;
  idInUseRetried = false;
  joinErrorShowing = false;
  latest = data;
  render();
}

function connect(code: string, name: string): void {
  ws?.close();
  idInUseRetried = false;

  const openSocket = (): WebSocket => {
    const socket = new WebSocket(wsUrl(code));
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(joinPayload(name)));
    });
    socket.addEventListener("message", (ev) => {
      const data = JSON.parse(String(ev.data)) as ServerMessage;
      handleServerMessage(data, () => {
        ws?.close();
        ws = openSocket();
      });
    });
    socket.addEventListener("close", () => {
      if (ws !== socket) return;
      if (!joinErrorShowing) {
        statusLine.textContent = "Disconnected. Refresh to reconnect.";
      }
    });
    return socket;
  };

  ws = openSocket();
}

function send(body: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(body));
  }
}

function clearTimer(): void {
  if (timerHandle !== null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function updateTimer(): void {
  if (!latest?.deadlineMs) {
    timerEl.textContent = "";
    timerClock.hidden = true;
    timerBar.style.transform = "scaleX(0)";
    return;
  }
  const left = Math.max(0, latest.deadlineMs - Date.now());
  const seconds = Math.ceil(left / 1000);
  timerEl.textContent = `${seconds}s`;
  timerClock.hidden = false;
  const fraction = Math.min(1, left / (ROUND_SECONDS * 1000));
  timerBar.style.transform = `scaleX(${fraction})`;
}

function choiceLocked(state: StatePayload): boolean {
  return (
    state.phase !== "question" ||
    Boolean(state.yourChoiceId) ||
    !latest?.deadlineMs ||
    Date.now() > latest.deadlineMs
  );
}

function tryAnswer(state: StatePayload, choiceIndex: number): void {
  if (choiceLocked(state)) return;
  const choice = state.question?.choices[choiceIndex];
  if (!choice) return;
  send({ type: "answer", choiceId: choice.id });
}

function renderPlayers(state: StatePayload): void {
  playerList.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    if (!p.connected) li.classList.add("away");
    const name = document.createElement("span");
    name.textContent = p.name;
    const badges = document.createElement("span");
    badges.className = "badges";
    if (p.index === state.hostIndex) {
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
    if (p.id != null) {
      const you = document.createElement("span");
      you.className = "badge you";
      you.textContent = "you";
      badges.appendChild(you);
    }
    if (!p.connected) {
      const away = document.createElement("span");
      away.className = "badge away-label";
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

function renderQuestion(state: StatePayload): void {
  choicesEl.innerHTML = "";
  if (!state.question) return;
  promptEl.textContent = state.question.prompt;
  const locked = choiceLocked(state);
  state.question.choices.forEach((choice, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn choice";
    const digit = document.createElement("span");
    digit.className = "choice-digit";
    digit.textContent = String(index + 1);
    const label = document.createElement("span");
    label.className = "choice-label";
    label.textContent = choice.label;
    btn.append(digit, label);
    const picked = state.yourChoiceId === choice.id;
    if (picked) btn.classList.add("selected");
    btn.disabled = locked;
    btn.addEventListener("click", () => {
      tryAnswer(state, index);
    });
    choicesEl.appendChild(btn);
  });
}

function renderReveal(state: StatePayload): void {
  revealChoices.innerHTML = "";
  if (!state.reveal || !state.question) return;
  promptEl.textContent = state.question.prompt;
  for (const choice of state.reveal.choices) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn choice";
    btn.disabled = true;
    btn.textContent = `${choice.label} — ${choice.count.toLocaleString()} complaints filed`;
    if (choice.id === state.reveal.correctChoiceId) {
      btn.classList.add("correct");
    } else if (state.yourChoiceId === choice.id) {
      btn.classList.add("wrong");
    }
    revealChoices.appendChild(btn);
  }
}

function renderWinner(state: StatePayload): void {
  scoreboard.innerHTML = "";
  const winnerSet = new Set(state.winnerIndices);
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  for (const p of sorted) {
    const li = document.createElement("li");
    if (winnerSet.has(p.index)) li.classList.add("winner-row");
    if (!p.connected) li.classList.add("away");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.name;
    const scoreSpan = document.createElement("span");
    scoreSpan.textContent = String(p.score);
    li.append(nameSpan, scoreSpan);
    scoreboard.appendChild(li);
  }
}

function render(): void {
  if (!latest) return;
  const state = latest;
  phaseLabel.textContent = state.phase;
  renderPlayers(state);

  lobbyActions.hidden = state.phase !== "lobby";
  roundPanel.hidden = state.phase !== "question" && state.phase !== "reveal";
  revealPanel.hidden = state.phase !== "reveal";
  winnerPanel.hidden = state.phase !== "winner";

  const me = state.players.find((p) => p.id != null);

  readyBtn.hidden = state.phase !== "lobby";
  if (me) {
    readyBtn.textContent = me.ready ? "Not ready" : "Ready";
  }

  const connectedCount = state.players.filter((p) => p.connected).length;
  const showStart = state.phase === "lobby" && state.youAreHost;
  startBtn.hidden = !showStart;
  startBtn.disabled = connectedCount < 2;
  startHint.hidden = !(showStart && connectedCount < 2);

  rematchBtn.hidden = !(state.phase === "winner" && state.youAreHost);

  if (state.phase === "question" || state.phase === "reveal") {
    roundMeta.textContent =
      state.round != null
        ? `Round ${state.round} of ${state.totalRounds}`
        : "";
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

document.getElementById("new-room-btn")!.addEventListener("click", () => {
  roomInput.value = randomRoomCode();
  joinCreate = true;
});

roomInput.addEventListener("input", () => {
  joinCreate = false;
});

document.getElementById("join-btn")!.addEventListener("click", () => {
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

document.addEventListener("keydown", (ev) => {
  const target = ev.target;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (!latest || latest.phase !== "question") return;
  const key = ev.key;
  if (key !== "1" && key !== "2" && key !== "3" && key !== "4") return;
  const index = Number(key) - 1;
  tryAnswer(latest, index);
});

const params = new URLSearchParams(location.search);
const fromUrl = params.get("room");
if (fromUrl) {
  roomInput.value = fromUrl.toUpperCase();
}
