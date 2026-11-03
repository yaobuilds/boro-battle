import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  areaFromPolygons,
  countPointsByArea,
  type Area,
  type LonLat,
} from "../src/areas";
import type { Question, QuestionKind } from "../src/game";

const DATASET = "erm2-nwe9";
const BASE = `https://data.cityofnewyork.us/resource/${DATASET}.json`;
const MIN_GROUP = 20;
const TARGET = 220;
const SPOT_CHECK = 10;
const PAGE_SIZE = 50000;

interface GroupRow {
  key: string;
  label: string;
  count: number;
}

interface NtaCollection {
  features: Array<{
    properties: { nta2020: string; ntaname: string; boroname: string };
    geometry: {
      type: string;
      coordinates: number[][][][];
    };
  }>;
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
    m === 12
      ? `${y + 1}-01-01T00:00:00.000`
      : `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00.000`;
  return { start, end: next };
}

function loadAreas(path: string): Area[] {
  const collection = JSON.parse(readFileSync(path, "utf8")) as NtaCollection;
  return collection.features.map((feature) => {
    if (feature.geometry.type !== "MultiPolygon") {
      throw new Error(
        `Expected MultiPolygon for ${feature.properties.nta2020}`,
      );
    }
    const polygons = feature.geometry.coordinates.map((polygon) => ({
      exterior: polygon[0] as Array<[number, number]>,
      holes: polygon.slice(1) as Array<Array<[number, number]>>,
    }));
    const { nta2020, ntaname, boroname } = feature.properties;
    return areaFromPolygons(nta2020, `${ntaname}, ${boroname}`, polygons);
  });
}

async function qualifyingGroupCount(
  where: string,
  group: string,
): Promise<number> {
  const url = `${BASE}?$select=${group},count(*)&$where=${encodeURIComponent(where)}&$group=${group}&$limit=50000`;
  const rows = (await fetchJson(url)) as Array<Record<string, string>>;
  return rows.filter((row) => {
    const key = row[group];
    return key !== "00000" && Number(row.count) >= MIN_GROUP;
  }).length;
}

async function pickMonth(): Promise<string> {
  const now = new Date();
  for (let offset = 1; offset <= 18; offset++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1),
    );
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const { start, end } = monthWindow(month);
    const noiseWhere = `complaint_type like 'Noise%' AND created_date >= '${start}' AND created_date < '${end}' AND incident_zip IS NOT NULL`;
    const ratWhere = `complaint_type = 'Rodent' AND created_date >= '${start}' AND created_date < '${end}' AND community_board IS NOT NULL`;
    const [noiseGroups, ratGroups] = await Promise.all([
      qualifyingGroupCount(noiseWhere, "incident_zip"),
      qualifyingGroupCount(ratWhere, "community_board"),
    ]);
    if (noiseGroups >= 10 && ratGroups >= 10) return month;
  }
  throw new Error("Could not find a 311 month with enough complaint volume");
}

function whereFor(kind: QuestionKind, month: string): string {
  const { start, end } = monthWindow(month);
  const type =
    kind === "noise"
      ? "complaint_type like 'Noise%'"
      : "complaint_type = 'Rodent'";
  return `${type} AND created_date >= '${start}' AND created_date < '${end}' AND latitude IS NOT NULL AND longitude IS NOT NULL`;
}

async function fetchPoints(where: string): Promise<LonLat[]> {
  const points: LonLat[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url = `${BASE}?$select=latitude,longitude&$where=${encodeURIComponent(where)}&$order=:id&$limit=${PAGE_SIZE}&$offset=${offset}`;
    const rows = (await fetchJson(url)) as Array<{
      latitude: string | null;
      longitude: string | null;
    }>;
    for (const row of rows) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push({ lon, lat });
    }
    console.log(`  fetched ${points.length} points`);
    if (rows.length < PAGE_SIZE) break;
  }
  return points;
}

function groupsFromPoints(
  points: LonLat[],
  areas: Area[],
): { groups: GroupRow[]; placed: number } {
  const counts = countPointsByArea(points, areas);
  const groups = counts
    .filter((row) => row.count >= MIN_GROUP)
    .map((row) => ({ key: row.id, label: row.label, count: row.count }));
  const placed = counts.reduce((sum, row) => sum + row.count, 0);
  return { groups, placed };
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
    areaId: g.key,
  }));

  const correct = shuffled.find((g) => g.count === max)!;
  const correctChoiceId = choices.find((c) => c.areaId === correct.key)!.id;
  const complaint =
    kind === "noise" ? "complaint_type like 'Noise%'" : "complaint_type = 'Rodent'";

  return {
    id: `${kind}-${month}-${index}-${picked.map((p) => p.key).join("-")}`,
    kind,
    prompt:
      kind === "noise"
        ? `Which neighborhood had more noise complaints filed in ${month}?`
        : `Which neighborhood had more rodent complaints filed in ${month}?`,
    choices,
    correctChoiceId,
    source: {
      dataset: DATASET,
      url: BASE,
      month,
      filter: `${complaint}, counted by 2020 NTA from complaint latitude and longitude`,
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

function spotCheck(
  questions: Question[],
  points: LonLat[],
  areas: Area[],
): void {
  const recount = new Map(
    countPointsByArea(points, areas).map((row) => [row.id, row.count]),
  );
  for (const q of questions) {
    for (const choice of q.choices) {
      if (!choice.areaId) {
        throw new Error(`Spot check failed for ${q.id}: choice has no area id`);
      }
      const live = recount.get(choice.areaId) ?? 0;
      if (live !== choice.count) {
        throw new Error(
          `Spot check failed for ${q.id} ${choice.label}: file ${choice.count} recount ${live}`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.url));
  const areas = loadAreas(join(root, "nta-2020.geojson"));
  console.log(`Loaded ${areas.length} neighborhoods`);

  const month = await pickMonth();
  console.log(`Using snapshot month ${month}`);

  const [noisePoints, ratPoints] = await Promise.all([
    fetchPoints(whereFor("noise", month)),
    fetchPoints(whereFor("rats", month)),
  ]);
  const noise = groupsFromPoints(noisePoints, areas);
  const rats = groupsFromPoints(ratPoints, areas);
  console.log(
    `Noise: ${noisePoints.length} points, ${noise.placed} inside a neighborhood, ${noise.groups.length} areas with at least ${MIN_GROUP}`,
  );
  console.log(
    `Rodent: ${ratPoints.length} points, ${rats.placed} inside a neighborhood, ${rats.groups.length} areas with at least ${MIN_GROUP}`,
  );

  const half = Math.ceil(TARGET / 2);
  const noiseQs = generateFromGroups("noise", month, noise.groups, half);
  const ratQs = generateFromGroups("rats", month, rats.groups, half);
  if (noiseQs.length < half || ratQs.length < half) {
    throw new Error(
      `Not enough questions at the minimum of ${MIN_GROUP} complaints. ` +
        `Noise areas ${noise.groups.length}, questions ${noiseQs.length}. ` +
        `Rodent areas ${rats.groups.length}, questions ${ratQs.length}. ` +
        `Leaving the minimum at ${MIN_GROUP}.`,
    );
  }

  const questions = shuffle([...noiseQs, ...ratQs]).slice(0, TARGET);
  if (questions.length < 200) {
    throw new Error(`Only generated ${questions.length} questions`);
  }

  const checks = shuffle(questions).slice(0, SPOT_CHECK);
  const noiseChecks = checks.filter((q) => q.kind === "noise");
  const ratChecks = checks.filter((q) => q.kind === "rats");
  spotCheck(noiseChecks, noisePoints, areas);
  spotCheck(ratChecks, ratPoints, areas);
  console.log(`Spot-checked ${checks.length} questions against a second count`);

  const outPath = join(root, "..", "questions.json");
  writeFileSync(outPath, `${JSON.stringify(questions, null, 2)}\n`);
  console.log(`Wrote ${questions.length} questions to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
