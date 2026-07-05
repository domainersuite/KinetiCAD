// Shared helpers for the tessellated-mesh exporters (GDML, OBJ).
//
// The CAD worker's tessellation duplicates vertices at every face boundary
// (each OCCT face contributes its own nodes). That is fine for rendering,
// but mesh interchange formats want a welded vertex list: it shrinks the
// file several-fold and lets consumers (e.g. Geant4's tessellated-solid
// builder) recognise shared edges. `weldMesh` merges vertices that agree
// to EXPORT_DECIMALS decimal places (0.1 µm at millimetre scale) and drops
// triangles that collapse under the merge.

/** One part's mesh as returned by the CAD worker, plus display metadata. */
export type ExportMeshPart = {
  name: string;
  materialId: string;
  positions: Float32Array;
  indices: Uint32Array;
};

/** Decimal places kept in exported coordinates (mm). 4 ⇒ 0.1 µm. */
export const EXPORT_DECIMALS = 4;

export type WeldedMesh = {
  /** Vertex coordinates already formatted with EXPORT_DECIMALS places. */
  vertices: string[][];
  /** Triangles as triples of indices into `vertices`. */
  triangles: [number, number, number][];
  /** Number of input triangles dropped as degenerate. */
  degenerateCount: number;
};

export function weldMesh(
  positions: Float32Array,
  indices: Uint32Array,
): WeldedMesh {
  const keyToIndex = new Map<string, number>();
  const vertices: string[][] = [];
  const remap = new Uint32Array(positions.length / 3);

  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[3 * v]!.toFixed(EXPORT_DECIMALS);
    const y = positions[3 * v + 1]!.toFixed(EXPORT_DECIMALS);
    const z = positions[3 * v + 2]!.toFixed(EXPORT_DECIMALS);
    const key = `${x},${y},${z}`;
    let idx = keyToIndex.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      keyToIndex.set(key, idx);
      vertices.push([x, y, z]);
    }
    remap[v] = idx;
  }

  const triangles: [number, number, number][] = [];
  let degenerateCount = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    if (a === b || b === c || a === c) {
      degenerateCount++;
      continue;
    }
    triangles.push([a, b, c]);
  }

  return { vertices, triangles, degenerateCount };
}

/**
 * Sanitise a user-facing part name into a unique XML/OBJ-safe identifier.
 * `used` tracks names already handed out so duplicates get a numeric suffix.
 */
export function safeName(raw: string, used: Set<string>): string {
  let base = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z_]+/, '');
  if (base === '') base = 'part';
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}_${n}`;
    n++;
  }
  used.add(name);
  return name;
}
