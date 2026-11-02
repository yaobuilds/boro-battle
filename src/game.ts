export type Phase = "lobby" | "question" | "reveal" | "winner";

export type QuestionKind = "noise" | "rats";

export interface Choice {
  id: string;
  label: string;
  count: number;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  prompt: string;
  choices: Choice[];
  correctChoiceId: string;
  source: {
    dataset: string;
    url: string;
    month: string;
    filter: string;
  };
}

export interface PublicChoice {
  id: string;
  label: string;
}

export interface PublicQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  choices: PublicChoice[];
}

export interface Player {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  score: number;
}

export interface RoomState {
  phase: Phase;
  hostId: string;
  players: Player[];
  deck: Question[];
  roundIndex: number;
  /** Unix ms when the current question ends; set during question phase. */
  deadlineMs: number | null;
  answers: Record<string, string>;
}

export const ROUND_COUNT = 10;
export const ROUND_SECONDS = 15;
export const REVEAL_SECONDS = 5;
export const MAX_PLAYERS = 8;
export const MAX_MESSAGE_BYTES = 2048;
export const RATE_LIMIT_COUNT = 10;
export const RATE_LIMIT_WINDOW_MS = 5000;

export type ClientMessage =
  | { type: "join"; playerId: string; name: string }
  | { type: "ready" }
  | { type: "start" }
  | { type: "answer"; choiceId: string }
  | { type: "rematch" };

export function isOversizedMessage(byteLength: number): boolean {
  return byteLength > MAX_MESSAGE_BYTES;
}

export function consumeRateLimit(
  timestamps: number[],
  nowMs: number,
): { allowed: boolean; timestamps: number[] } {
  const windowStart = nowMs - RATE_LIMIT_WINDOW_MS;
  const kept = timestamps.filter((t) => t >= windowStart);
  if (kept.length >= RATE_LIMIT_COUNT) {
    return { allowed: false, timestamps: kept };
  }
  return { allowed: true, timestamps: [...kept, nowMs] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringInRange(
  value: unknown,
  minLen: number,
  maxLen: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLen &&
    value.length <= maxLen
  );
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "join": {
      if (!isStringInRange(value.playerId, 1, 64)) return null;
      if (typeof value.name !== "string") return null;
      const name = value.name.trim().slice(0, 24);
      if (!name) return null;
      return { type: "join", playerId: value.playerId, name };
    }
    case "answer": {
      if (!isStringInRange(value.choiceId, 1, 64)) return null;
      return { type: "answer", choiceId: value.choiceId };
    }
    case "ready":
      return { type: "ready" };
    case "start":
      return { type: "start" };
    case "rematch":
      return { type: "rematch" };
    default:
      return null;
  }
}

export function classifyJoin(
  state: RoomState,
  input: { playerId: string; name: string },
): "ok" | "full" | "bad_name" {
  if (!input.name.trim()) return "bad_name";
  const existing = state.players.find((p) => p.id === input.playerId);
  const connectedCount = state.players.filter((p) => p.connected).length;
  if (!existing && connectedCount >= MAX_PLAYERS) return "full";
  return "ok";
}

export function emptyRoomState(): RoomState {
  return {
    phase: "lobby",
    hostId: "",
    players: [],
    deck: [],
    roundIndex: 0,
    deadlineMs: null,
    answers: {},
  };
}

export function publicQuestion(q: Question): PublicQuestion {
  return {
    id: q.id,
    kind: q.kind,
    prompt: q.prompt,
    choices: q.choices.map(({ id, label }) => ({ id, label })),
  };
}

export function scoreAnswer(input: {
  choiceId: string | undefined;
  correctChoiceId: string;
  beforeDeadline: boolean;
  alreadyAnswered: boolean;
}): number {
  if (input.alreadyAnswered) return 0;
  if (!input.choiceId || !input.beforeDeadline) return 0;
  return input.choiceId === input.correctChoiceId ? 1 : 0;
}

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function dealDeck(
  pool: Question[],
  random: () => number = Math.random,
): Question[] {
  if (pool.length < ROUND_COUNT) {
    throw new Error(`Need at least ${ROUND_COUNT} questions in the pool`);
  }

  const noise = shuffle(
    pool.filter((q) => q.kind === "noise"),
    random,
  );
  const rats = shuffle(
    pool.filter((q) => q.kind === "rats"),
    random,
  );

  const picked: Question[] = [];
  let ni = 0;
  let ri = 0;
  while (picked.length < ROUND_COUNT) {
    const wantNoise = picked.length % 2 === 0;
    if (wantNoise && ni < noise.length) {
      picked.push(noise[ni++]);
    } else if (!wantNoise && ri < rats.length) {
      picked.push(rats[ri++]);
    } else if (ni < noise.length) {
      picked.push(noise[ni++]);
    } else if (ri < rats.length) {
      picked.push(rats[ri++]);
    } else {
      break;
    }
  }

  if (picked.length < ROUND_COUNT) {
    const used = new Set(picked.map((q) => q.id));
    const rest = shuffle(
      pool.filter((q) => !used.has(q.id)),
      random,
    );
    for (const q of rest) {
      if (picked.length >= ROUND_COUNT) break;
      picked.push(q);
    }
  }

  return picked.slice(0, ROUND_COUNT);
}

function connectedPlayers(state: RoomState): Player[] {
  return state.players.filter((p) => p.connected);
}

function pickHost(state: RoomState): string {
  const live = connectedPlayers(state);
  if (live.length === 0) return "";
  if (live.some((p) => p.id === state.hostId)) return state.hostId;
  return live[0].id;
}

function currentQuestion(state: RoomState): Question | null {
  if (state.roundIndex < 0 || state.roundIndex >= state.deck.length) {
    return null;
  }
  return state.deck[state.roundIndex] ?? null;
}

export function applyJoin(
  state: RoomState,
  input: { playerId: string; name: string },
): RoomState {
  const name = input.name.trim().slice(0, 24);
  if (!name) return state;

  const existing = state.players.find((p) => p.id === input.playerId);
  const connectedCount = state.players.filter((p) => p.connected).length;
  if (!existing && connectedCount >= MAX_PLAYERS) return state;

  let players: Player[];
  if (existing) {
    players = state.players.map((p) =>
      p.id === input.playerId
        ? { ...p, name, connected: true }
        : p,
    );
  } else {
    const player: Player = {
      id: input.playerId,
      name,
      ready: false,
      connected: true,
      score: 0,
    };
    players = [...state.players, player];
  }

  const hostId = state.hostId || input.playerId;
  return { ...state, players, hostId: pickHost({ ...state, players, hostId }) };
}

export function applyReady(state: RoomState, playerId: string): RoomState {
  if (state.phase !== "lobby") return state;
  return {
    ...state,
    players: state.players.map((p) =>
      p.id === playerId ? { ...p, ready: !p.ready } : p,
    ),
  };
}

export function canStart(state: RoomState, playerId: string): boolean {
  if (state.phase !== "lobby") return false;
  if (state.hostId !== playerId) return false;
  return connectedPlayers(state).length >= 2;
}

export function applyStart(
  state: RoomState,
  input: { playerId: string; deck: Question[]; nowMs: number },
): RoomState {
  if (!canStart(state, input.playerId)) return state;

  const deck = dealDeck(input.deck);
  return {
    ...state,
    phase: "question",
    deck,
    roundIndex: 0,
    answers: {},
    deadlineMs: input.nowMs + ROUND_SECONDS * 1000,
  };
}

export function applyAnswer(
  state: RoomState,
  input: { playerId: string; choiceId: string; nowMs: number },
): RoomState {
  if (state.phase !== "question") return state;
  if (state.deadlineMs !== null && input.nowMs > state.deadlineMs) {
    return state;
  }
  if (state.answers[input.playerId]) return state;

  const q = currentQuestion(state);
  if (!q) return state;
  if (!q.choices.some((c) => c.id === input.choiceId)) return state;

  return {
    ...state,
    answers: { ...state.answers, [input.playerId]: input.choiceId },
  };
}

function scoreRound(state: RoomState): RoomState {
  const q = currentQuestion(state);
  if (!q) return state;

  const players = state.players.map((p) => {
    const choiceId = state.answers[p.id];
    const delta = scoreAnswer({
      choiceId,
      correctChoiceId: q.correctChoiceId,
      beforeDeadline: true,
      alreadyAnswered: false,
    });
    return { ...p, score: p.score + delta };
  });

  return { ...state, players };
}

export function applyAlarm(state: RoomState, nowMs: number): RoomState {
  if (state.phase === "question") {
    const next = scoreRound(state);
    return {
      ...next,
      phase: "reveal",
      deadlineMs: nowMs + REVEAL_SECONDS * 1000,
    };
  }

  if (state.phase === "reveal") {
    if (connectedPlayers(state).length < 2) {
      return { ...state, phase: "winner", deadlineMs: null };
    }
    if (state.roundIndex + 1 >= ROUND_COUNT) {
      return { ...state, phase: "winner", deadlineMs: null };
    }
    return {
      ...state,
      phase: "question",
      roundIndex: state.roundIndex + 1,
      answers: {},
      deadlineMs: nowMs + ROUND_SECONDS * 1000,
    };
  }

  return state;
}

export function applyDisconnect(state: RoomState, playerId: string): RoomState {
  const players = state.players.map((p) =>
    p.id === playerId ? { ...p, connected: false, ready: false } : p,
  );
  let next: RoomState = { ...state, players, hostId: pickHost({ ...state, players }) };

  if (next.phase === "question" && connectedPlayers(next).length < 2) {
    next = scoreRound(next);
    next = { ...next, phase: "winner", deadlineMs: null };
  }

  return next;
}

export function applyRematch(
  state: RoomState,
  input: { playerId: string },
): RoomState {
  if (state.phase !== "winner") return state;
  if (state.hostId !== input.playerId) return state;

  const players = state.players.map((p) => ({
    ...p,
    ready: false,
    score: 0,
  }));

  return {
    ...state,
    phase: "lobby",
    players,
    deck: [],
    roundIndex: 0,
    deadlineMs: null,
    answers: {},
  };
}

export function winnerIds(state: RoomState): string[] {
  if (state.players.length === 0) return [];
  const top = Math.max(...state.players.map((p) => p.score));
  return state.players.filter((p) => p.score === top).map((p) => p.id);
}

/** True when another socket (not the joining one) already holds this playerId. */
export function isPlayerIdTakenByAnotherSocket(
  playerId: string,
  sockets: ReadonlyArray<{ playerId: string | null; isJoiningSocket: boolean }>,
): boolean {
  return sockets.some(
    (s) => !s.isJoiningSocket && s.playerId === playerId,
  );
}

export interface ClientPlayer {
  index: number;
  name: string;
  ready: boolean;
  connected: boolean;
  score: number;
  /** Set only on the viewer's own player row. */
  id?: string;
}

export interface RevealChoice extends PublicChoice {
  count: number;
}

export interface StatePayload {
  type: "state";
  phase: Phase;
  yourPlayerId: string | null;
  youAreHost: boolean;
  players: ClientPlayer[];
  round: number | null;
  totalRounds: number;
  question: PublicQuestion | null;
  reveal: {
    correctChoiceId: string;
    choices: RevealChoice[];
  } | null;
  deadlineMs: number | null;
  winnerIndices: number[];
  yourChoiceId: string | null;
}

export function buildStatePayload(
  state: RoomState,
  viewerPlayerId: string | null,
): StatePayload {
  const q = currentQuestion(state);
  const round =
    state.phase === "lobby" || state.phase === "winner"
      ? null
      : state.roundIndex + 1;

  let question: PublicQuestion | null = null;
  let reveal: StatePayload["reveal"] = null;

  if (q && (state.phase === "question" || state.phase === "reveal")) {
    question = publicQuestion(q);
    if (state.phase === "reveal") {
      reveal = {
        correctChoiceId: q.correctChoiceId,
        choices: q.choices.map(({ id, label, count }) => ({
          id,
          label,
          count,
        })),
      };
    }
  }

  const yourChoiceId =
    viewerPlayerId != null
      ? (state.answers[viewerPlayerId] ?? null)
      : null;

  const winners = state.phase === "winner" ? new Set(winnerIds(state)) : null;
  const winnerIndices =
    winners == null
      ? []
      : state.players.flatMap((p, index) => (winners.has(p.id) ? [index] : []));

  return {
    type: "state",
    phase: state.phase,
    yourPlayerId: viewerPlayerId,
    youAreHost:
      viewerPlayerId != null && state.hostId === viewerPlayerId,
    players: state.players.map((p, index) => {
      const row: ClientPlayer = {
        index,
        name: p.name,
        ready: p.ready,
        connected: p.connected,
        score: p.score,
      };
      if (p.id === viewerPlayerId) {
        row.id = p.id;
      }
      return row;
    }),
    round,
    totalRounds: ROUND_COUNT,
    question,
    reveal,
    deadlineMs: state.phase === "question" ? state.deadlineMs : null,
    winnerIndices,
    yourChoiceId,
  };
}

export const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isValidRoomCode(code: string): boolean {
  return (
    code.length === 4 &&
    [...code].every((ch) => ROOM_CODE_CHARS.includes(ch))
  );
}

export function randomRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    const idx = Math.floor(random() * ROOM_CODE_CHARS.length);
    code += ROOM_CODE_CHARS[idx];
  }
  return code;
}
