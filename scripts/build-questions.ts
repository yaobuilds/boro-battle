import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Question, QuestionKind } from "../src/game";

const DATASET = "erm2-nwe9";
const BASE = `https://data.cityofnewyork.us/resource/${DATASET}.json`;
const MIN_GROUP = 20;
const TARGET = 220;
const SPOT_CHECK = 10;

interface GroupRow {
  key: string;
  label: string;
  count: number;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`311 fetch failed ${res.status}: ${url}`);
  }
  return res.json();
}

function monthWindow(isoMonth: string): { start: string; end: string } {
  const [y, m] = isoMonth.split("-").map(Number);
  const start = `${isoMonth}-01T00:00:00.000`;
  const next =
    m === 12 ? `${y + 1}-01-01T00:00:00.000` : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00.000`;
  return { start, end: next };
}

async function pickMonth(): Promise<string> {
  const now = new Date();
  for (let offset = 1; offset <= 18; offset++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const [noiseGroups, ratGroups] = await Promise.all([
      loadGroups("noise", month),
      loadGroups("rats", month),
    ]);
    if (noiseGroups.length >= 10 && ratGroups.length >= 10) {
      return month;
    }
  }
  throw new Error("Could not find a 311 month with enough complaint volume");
}

async function loadGroups(
  kind: QuestionKind,
  month: string,
): Promise<GroupRow[]> {
  const { start, end } = monthWindow(month);
  const whereNoise = `complaint_type like 'Noise%' AND created_date >= '${start}' AND created_date < '${end}' AND incident_zip IS NOT NULL`;
  const whereRats = `complaint_type = 'Rodent' AND created_date >= '${start}' AND created_date < '${end}' AND community_board IS NOT NULL`;

  if (kind === "noise") {
    const url = `${BASE}?$select=incident_zip,count(*)&$where=${encodeURIComponent(whereNoise)}&$group=incident_zip&$order=count DESC`;
    const rows = (await fetchJson(url)) as {
      incident_zip: string;
      count: string;
    }[];
    return rows
      .map((r) => ({
        key: r.incident_zip,
        label: `ZIP ${r.incident_zip}`,
        count: Number(r.count),
      }))
      .filter((g) => g.count >= MIN_GROUP && g.key !== "00000");
  }

  const url = `${BASE}?$select=community_board,count(*)&$where=${encodeURIComponent(whereRats)}&$group=community_board&$order=count DESC`;
  const rows = (await fetchJson(url)) as {
    community_board: string;
    count: string;
  }[];
  return rows
    .map((r) => ({
      key: r.community_board,
      label: r.community_board,
      count: Number(r.count),
    }))
    .filter((g) => g.count >= MIN_GROUP);
}

function buildQuestion(
  kind: QuestionKind,
  month: string,
  picked: GroupRow[],
  index: number,
): Question | null {
  const counts = picked.map((g) => g.count);
  const max = Math.max(...counts);
  const winners = picked.filter((g) => g.count === max);
  if (winners.length !== 1) return null;

  const shuffled = shuffle(picked);
  const choices = shuffled.map((g, i) => ({
    id: `${kind}-${index}-${i}`,
    label: g.label,
    count: g.count,
  }));

  const correct = shuffled.find((g) => g.count === max)!;
  const correctChoiceId = choices.find((c) => c.label === correct.label)!.id;

  const filter =
    kind === "noise"
      ? "complaint_type like 'Noise%', grouped by incident_zip"
      : "complaint_type = 'Rodent', grouped by community_board";

  const prompt =
    kind === "noise"
      ? `Which ZIP had more noise complaints filed in ${month}?`
      : `Which community board had more rodent complaints filed in ${month}?`;

  return {
    id: `${kind}-${month}-${index}-${picked.map((p) => p.key).join("-")}`,
    kind,
    prompt,
    choices,
    correctChoiceId,
    source: {
      dataset: DATASET,
      url: BASE,
      month,
      filter,
    },
  };
}

function generateFromGroups(
  kind: QuestionKind,
  month: string,
  groups: GroupRow[],
  want: number,
): Question[] {
  const out: Question[] = [];
  const used = new Set<string>();
  let attempts = 0;
  while (out.length < want && attempts < want * 40) {
    attempts++;
    const size = Math.random() < 0.35 ? 3 : 2;
    const sample = shuffle(groups).slice(0, size);
    const sig = sample
      .map((g) => g.key)
      .sort()
      .join("|");
    if (used.has(sig)) continue;
    const q = buildQuestion(kind, month, sample, out.length);
    if (!q) continue;
    used.add(sig);
    out.push(q);
  }
  return out;
}

async function spotCheck(q: Question): Promise<void> {
  const { start, end } = monthWindow(q.source.month);
  for (const choice of q.choices) {
    const zip =
      q.kind === "noise"
        ? choice.label.replace("ZIP ", "")
        : undefined;
    const board = q.kind === "rats" ? choice.label : undefined;
    const whereParts = [
      q.kind === "noise"
        ? "complaint_type like 'Noise%'"
        : "complaint_type = 'Rodent'",
      `created_date >= '${start}'`,
      `created_date < '${end}'`,
    ];
    if (zip) whereParts.push(`incident_zip = '${zip}'`);
    if (board) whereParts.push(`community_board = '${board.replace(/'/g, "''")}'`);

    const url = `${BASE}?$select=count(*)&$where=${encodeURIComponent(whereParts.join(" AND "))}`;
    const rows = (await fetchJson(url)) as { count: string }[];
    const live = Number(rows[0]?.count ?? 0);
    if (live !== choice.count) {
      throw new Error(
        `Spot check failed for ${q.id} ${choice.label}: file ${choice.count} live ${live}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const month = await pickMonth();
  console.log(`Using snapshot month ${month}`);

  const [noiseGroups, ratGroups] = await Promise.all([
    loadGroups("noise", month),
    loadGroups("rats", month),
  ]);

  if (noiseGroups.length < 3 || ratGroups.length < 3) {
    throw new Error("Not enough 311 groups for question generation");
  }

  const half = Math.ceil(TARGET / 2);
  const noiseQs = generateFromGroups("noise", month, noiseGroups, half);
  const ratQs = generateFromGroups("rats", month, ratGroups, half);
  const questions = shuffle([...noiseQs, ...ratQs]).slice(0, TARGET);

  if (questions.length < 200) {
    throw new Error(`Only generated ${questions.length} questions`);
  }

  const checks = shuffle(questions).slice(0, SPOT_CHECK);
  for (const q of checks) {
    await spotCheck(q);
  }
  console.log(`Spot-checked ${checks.length} questions`);

  const root = dirname(fileURLToPath(import.meta.url));
  const outPath = join(root, "..", "questions.json");
  writeFileSync(outPath, `${JSON.stringify(questions, null, 2)}\n`);
  console.log(`Wrote ${questions.length} questions to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
