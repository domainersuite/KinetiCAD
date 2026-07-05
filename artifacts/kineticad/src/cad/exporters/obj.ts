// Wavefront OBJ exporter. One `o` object per part, welded vertices, faces in
// the tessellation's outward-facing winding. OBJ is the lingua franca for
// mesh tooling — Blender, MeshLab, and Geant4's CADMesh all read it — and,
// unlike STL, it preserves the part names.
//
// Coordinates are millimetres in KinetiCAD's Z-up world frame; OBJ carries
// no unit or axis metadata, so consumers must be told (a header comment
// records both).

import type { ExportMeshPart } from './meshExport';
import { safeName, weldMesh } from './meshExport';

export type ObjResult = {
  text: string;
  totalTriangles: number;
  degenerateDropped: number;
};

export function buildObj(parts: ExportMeshPart[]): ObjResult {
  const used = new Set<string>();
  const lines: string[] = [
    '# Exported by KinetiCAD',
    '# Units: millimetres. Axes: Z-up, right-handed.',
  ];

  let vertexOffset = 0;
  let totalTriangles = 0;
  let degenerateDropped = 0;

  for (const part of parts) {
    const name = safeName(part.name, used);
    const welded = weldMesh(part.positions, part.indices);
    degenerateDropped += welded.degenerateCount;
    if (welded.triangles.length === 0) continue;
    totalTriangles += welded.triangles.length;

    lines.push(`o ${name}`);
    for (const [x, y, z] of welded.vertices) {
      lines.push(`v ${x} ${y} ${z}`);
    }
    for (const [a, b, c] of welded.triangles) {
      // OBJ indices are 1-based and global across the file.
      lines.push(
        `f ${vertexOffset + a + 1} ${vertexOffset + b + 1} ${vertexOffset + c + 1}`,
      );
    }
    vertexOffset += welded.vertices.length;
  }

  lines.push('');
  return { text: lines.join('\n'), totalTriangles, degenerateDropped };
}
