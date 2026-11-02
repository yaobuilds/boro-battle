import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyDisconnect,
  applyJoin,
  buildStatePayload,
  classifyJoin,
  consumeRateLimit,
  dealDeck,
  emptyRoomState,
  isOversizedMessage,
  isPlayerIdTakenByAnotherSocket,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  publicQuestion,
  RATE_LIMIT_COUNT,
  RATE_LIMIT_WINDOW_MS,
  scoreAnswer,
  type Question,
} from "./game";

function sampleQuestion(id: string, kind: "noise" | "rats"): Question {
  return {
    id,
    kind,
    prompt: `Prompt ${id}`,
    choices: [
      { id: `${id}-a`, label: "A", count: 40 },
      { id: `${id}-b`, label: "B", count: 25 },
      { id: `${id}-c`, label: "C", count: 10 },
    ],
    correctChoiceId: `${id}-a`,
    source: {
      dataset: "erm2-nwe9",
      url: "https://example.test",
      month: "2025-09",
      filter: "test",
    },
  };
}

describe("scoreAnswer", () => {
  it("awards one point for a correct on-time answer", () => {
    assert.equal(
      scoreAnswer({
        choiceId: "a",
        correctChoiceId: "a",
        beforeDeadline: true,
        alreadyAnswered: false,
      }),
      1,
    );
  });

  it("awards zero for a wrong answer", () => {
    assert.equal(
      scoreAnswer({
        choiceId: "b",
        correctChoiceId: "a",
        beforeDeadline: true,
        alreadyAnswered: false,
      }),
      0,
    );
  });

  it("awards zero when late", () => {
    assert.equal(
      scoreAnswer({
        choiceId: "a",
        correctChoiceId: "a",
        beforeDeadline: false,
        alreadyAnswered: false,
      }),
      0,
    );
  });

  it("awards zero for a second answer", () => {
    assert.equal(
      scoreAnswer({
        choiceId: "a",
        correctChoiceId: "a",
        beforeDeadline: true,
        alreadyAnswered: true,
      }),
      0,
    );
  });
});

describe("dealDeck", () => {
  const pool: Question[] = [];
  for (let i = 0; i < 120; i++) {
    pool.push(sampleQuestion(`n${i}`, "noise"));
  }
  for (let i = 0; i < 120; i++) {
    pool.push(sampleQuestion(`r${i}`, "rats"));
  }

  it("deals ten questions", () => {
    const deck = dealDeck(pool, () => 0.5);
    assert.equal(deck.length, 10);
  });

  it("includes both kinds when the pool allows", () => {
    const deck = dealDeck(pool, () => 0.5);
    const kinds = new Set(deck.map((q) => q.kind));
    assert.ok(kinds.has("noise"));
    assert.ok(kinds.has("rats"));
  });

  it("never repeats a question id", () => {
    const deck = dealDeck(pool, () => 0.42);
    const ids = deck.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("publicQuestion", () => {
  it("hides counts and the answer key", () => {
    const q = sampleQuestion("x1", "noise");
    const pub = publicQuestion(q);
    assert.deepEqual(pub.choices, [
      { id: "x1-a", label: "A" },
      { id: "x1-b", label: "B" },
      { id: "x1-c", label: "C" },
    ]);
    assert.equal("correctChoiceId" in pub, false);
    assert.equal("count" in pub.choices[0], false);
  });
});

describe("buildStatePayload", () => {
  it("exposes player ids only to the viewing player", () => {
    let state = emptyRoomState();
    state = applyJoin(state, { playerId: "alice-id", name: "Alice" });
    state = applyJoin(state, { playerId: "bob-id", name: "Bob" });

    const aliceView = buildStatePayload(state, "alice-id");
    assert.equal(aliceView.yourPlayerId, "alice-id");
    assert.equal(aliceView.players[0].id, "alice-id");
    assert.equal("id" in aliceView.players[1], false);
    assert.equal(aliceView.players[1].index, 1);
    assert.equal(aliceView.players[1].name, "Bob");

    const bobView = buildStatePayload(state, "bob-id");
    assert.equal(bobView.players[1].id, "bob-id");
    assert.equal("id" in bobView.players[0], false);
    assert.equal(bobView.players[0].index, 0);

    const spectator = buildStatePayload(state, null);
    for (const p of spectator.players) {
      assert.equal("id" in p, false);
    }
  });
});

describe("parseClientMessage", () => {
  it("accepts valid join, ready, start, answer, and rematch", () => {
    assert.deepEqual(
      parseClientMessage(
        JSON.stringify({
          type: "join",
          playerId: "p1",
          name: "  Alice Extra Long Name That Gets Cut  ",
        }),
      ),
      { type: "join", playerId: "p1", name: "Alice Extra Long Name Th" },
    );
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "ready" })), {
      type: "ready",
    });
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "start" })), {
      type: "start",
    });
    assert.deepEqual(
      parseClientMessage(
        JSON.stringify({ type: "answer", choiceId: "choice-1" }),
      ),
      { type: "answer", choiceId: "choice-1" },
    );
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "rematch" })), {
      type: "rematch",
    });
  });

  it("returns null for invalid payloads", () => {
    assert.equal(parseClientMessage("{"), null);
    assert.equal(
      parseClientMessage(JSON.stringify({ type: "unknown" })),
      null,
    );
    assert.equal(
      parseClientMessage(
        JSON.stringify({ type: "join", playerId: 1, name: "x" }),
      ),
      null,
    );
    assert.equal(
      parseClientMessage(
        JSON.stringify({ type: "join", playerId: "p1", name: "   " }),
      ),
      null,
    );
    assert.equal(
      parseClientMessage(
        JSON.stringify({ type: "join", playerId: "x".repeat(65), name: "a" }),
      ),
      null,
    );
    assert.equal(
      parseClientMessage(
        JSON.stringify({
          type: "answer",
          choiceId: "c".repeat(65),
        }),
      ),
      null,
    );
  });
});

describe("isOversizedMessage", () => {
  it("rejects payloads longer than MAX_MESSAGE_BYTES", () => {
    assert.equal(isOversizedMessage(MAX_MESSAGE_BYTES), false);
    assert.equal(isOversizedMessage(MAX_MESSAGE_BYTES + 1), true);
  });
});

describe("consumeRateLimit", () => {
  it("allows ten messages in the window and denies the eleventh", () => {
    const now = 10_000;
    let timestamps: number[] = [];
    for (let i = 0; i < RATE_LIMIT_COUNT; i++) {
      const result = consumeRateLimit(timestamps, now + i);
      assert.equal(result.allowed, true);
      timestamps = result.timestamps;
    }
    const blocked = consumeRateLimit(timestamps, now + RATE_LIMIT_COUNT);
    assert.equal(blocked.allowed, false);
    assert.deepEqual(blocked.timestamps, timestamps);
  });

  it("drops timestamps older than the window", () => {
    const now = 20_000;
    const old = now - RATE_LIMIT_WINDOW_MS - 1;
    const recent = now - 100;
    const kept = consumeRateLimit([old, recent], now);
    assert.equal(kept.allowed, true);
    assert.deepEqual(kept.timestamps, [recent, now]);
  });
});

describe("classifyJoin", () => {
  it("returns full for a ninth player and ok for rejoin at capacity", () => {
    let state = emptyRoomState();
    for (let i = 0; i < 8; i++) {
      state = applyJoin(state, { playerId: `p${i}`, name: `Player ${i}` });
    }
    assert.equal(
      classifyJoin(state, { playerId: "p9", name: "Nine" }),
      "full",
    );
    assert.deepEqual(state.players.length, 8);

    state = applyDisconnect(state, "p0");
    state = applyJoin(state, { playerId: "p0", name: "Player Zero" });
    assert.equal(state.players.filter((p) => p.connected).length, 8);
    assert.equal(
      classifyJoin(state, { playerId: "p0", name: "Player Zero" }),
      "ok",
    );
  });

  it("returns bad_name when the trimmed name is empty", () => {
    assert.equal(
      classifyJoin(emptyRoomState(), { playerId: "p1", name: "   " }),
      "bad_name",
    );
  });
});

describe("isPlayerIdTakenByAnotherSocket", () => {
  it("blocks join when another socket already holds the playerId", () => {
    assert.equal(
      isPlayerIdTakenByAnotherSocket("p1", [
        { playerId: "p1", isJoiningSocket: false },
        { playerId: null, isJoiningSocket: true },
      ]),
      true,
    );
  });

  it("allows join on the same socket or when id is free", () => {
    assert.equal(
      isPlayerIdTakenByAnotherSocket("p1", [
        { playerId: "p1", isJoiningSocket: true },
      ]),
      false,
    );
    assert.equal(
      isPlayerIdTakenByAnotherSocket("p1", [
        { playerId: "p2", isJoiningSocket: false },
        { playerId: null, isJoiningSocket: true },
      ]),
      false,
    );
  });
});
