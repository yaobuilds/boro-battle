export interface LonLat {
  lon: number;
  lat: number;
}

export interface AreaPolygon {
  exterior: Array<[number, number]>;
  holes: Array<Array<[number, number]>>;
}

export interface Area {
  id: string;
  label: string;
  polygons: AreaPolygon[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface AreaCount {
  id: string;
  label: string;
  count: number;
}

export function areaFromPolygons(
  id: string,
  label: string,
  polygons: AreaPolygon[],
): Area {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const [x, y] of polygon.exterior) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { id, label, polygons, bbox: { minX, minY, maxX, maxY } };
}

function pointInRing(
  x: number,
  y: number,
  ring: Array<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function contains(area: Area, lon: number, lat: number): boolean {
  const { minX, minY, maxX, maxY } = area.bbox;
  if (lon < minX || lon > maxX || lat < minY || lat > maxY) return false;
  for (const polygon of area.polygons) {
    if (!pointInRing(lon, lat, polygon.exterior)) continue;
    const inHole = polygon.holes.some((hole) => pointInRing(lon, lat, hole));
    if (!inHole) return true;
  }
  return false;
}

const CELL = 0.02;

function areasByCell(areas: Area[]): Map<string, Area[]> {
  const index = new Map<string, Area[]>();
  for (const area of areas) {
    const x0 = Math.floor(area.bbox.minX / CELL);
    const x1 = Math.floor(area.bbox.maxX / CELL);
    const y0 = Math.floor(area.bbox.minY / CELL);
    const y1 = Math.floor(area.bbox.maxY / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const list = index.get(key);
        if (list) list.push(area);
        else index.set(key, [area]);
      }
    }
  }
  return index;
}

/** Count points that fall inside each area. Points outside every area are omitted. */
export function countPointsByArea(
  points: LonLat[],
  areas: Area[],
): AreaCount[] {
  const totals = new Map<string, number>();
  const index = areasByCell(areas);
  for (const point of points) {
    const key = `${Math.floor(point.lon / CELL)}:${Math.floor(point.lat / CELL)}`;
    const candidates = index.get(key);
    if (!candidates) continue;
    for (const area of candidates) {
      if (!contains(area, point.lon, point.lat)) continue;
      totals.set(area.id, (totals.get(area.id) ?? 0) + 1);
      break;
    }
  }
  const counts: AreaCount[] = [];
  for (const area of areas) {
    const count = totals.get(area.id);
    if (count == null) continue;
    counts.push({ id: area.id, label: area.label, count });
  }
  return counts;
}
