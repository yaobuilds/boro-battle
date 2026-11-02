import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyJoin,
  buildStatePayload,
  dealDeck,
  emptyRoomState,
  isPlayerIdTakenByAnotherSocket,
  publicQuestion,
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
