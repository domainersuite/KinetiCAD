// GDML (Geometry Description Markup Language) exporter — Geant4's native
// geometry format. Each part becomes a <tessellated> solid placed inside an
// auto-sized air-filled world box, so the file loads directly into Geant4:
//
//   auto* parser = new G4GDMLParser();
//   parser->Read("kineticad-export.gdml");
//   auto* world = parser->GetWorldVolume();
//
// Materials: KinetiCAD's material library is mapped onto Geant4 NIST
// materials where a close match exists; PLA and ABS (no NIST entry) are
// emitted as custom composite materials with the library's density.
//
// Geometry is exported in world coordinates (transforms baked in by the CAD
// worker), in millimetres — GDML's default length unit. Facet winding
// follows the tessellation's outward-facing convention, which Geant4's
// G4TessellatedSolid expects.
//
// Caveat (same as STL): tessellated solids describe the surface mesh, not
// the parametric B-rep. Geant4 tracks through G4TessellatedSolid more
// slowly than through CSG primitives, so for performance-critical
// simulations consider rebuilding simple shapes natively.

import type { ExportMeshPart } from './meshExport';
import { safeName, weldMesh } from './meshExport';

/** KinetiCAD material id → Geant4 NIST material name. */
const NIST_MATERIALS: Readonly<Record<string, string>> = {
  'aluminium-6061': 'G4_Al',
  // No NIST entry for 1018 carbon steel; elemental iron is the standard stand-in.
  'steel-1018': 'G4_Fe',
  'brass-c36000': 'G4_BRASS',
  'titanium-grade5': 'G4_Ti',
  'nylon-6': 'G4_NYLON-6-6',
  'acrylic': 'G4_PLEXIGLASS',
};

/** Custom composite materials for library entries with no NIST equivalent. */
const CUSTOM_MATERIALS: Readonly<
  Record<
    string,
    { gdmlName: string; densityGcm3: number; composite: [string, number][] }
  >
> = {
  pla: {
    gdmlName: 'KC_PLA',
    densityGcm3: 1.25,
    composite: [
      ['C', 3],
      ['H', 4],
      ['O', 2],
    ],
  },
  abs: {
    gdmlName: 'KC_ABS',
    densityGcm3: 1.04,
    composite: [
      ['C', 15],
      ['H', 17],
      ['N', 1],
    ],
  },
};

const ELEMENTS: Readonly<Record<string, { z: number; a: number }>> = {
  H: { z: 1, a: 1.008 },
  C: { z: 6, a: 12.011 },
  N: { z: 7, a: 14.007 },
  O: { z: 8, a: 15.999 },
};

function materialRef(materialId: string): string {
  const custom = CUSTOM_MATERIALS[materialId];
  if (custom) return custom.gdmlName;
  return NIST_MATERIALS[materialId] ?? 'G4_Al';
}

export type GdmlResult = {
  xml: string;
  totalTriangles: number;
  degenerateDropped: number;
};

export function buildGdml(parts: ExportMeshPart[]): GdmlResult {
  const used = new Set<string>(['world']);
  const define: string[] = [];
  const solids: string[] = [];
  const volumes: string[] = [];
  const physvols: string[] = [];

  let worldHalfMm = 0;
  let totalTriangles = 0;
  let degenerateDropped = 0;
  const usedCustomMaterials = new Set<string>();

  parts.forEach((part, p) => {
    const name = safeName(part.name, used);
    const welded = weldMesh(part.positions, part.indices);
    degenerateDropped += welded.degenerateCount;
    if (welded.triangles.length === 0) return;
    totalTriangles += welded.triangles.length;

    if (CUSTOM_MATERIALS[part.materialId]) {
      usedCustomMaterials.add(part.materialId);
    }

    welded.vertices.forEach(([x, y, z], v) => {
      define.push(
        `    <position name="v${p}_${v}" unit="mm" x="${x}" y="${y}" z="${z}"/>`,
      );
      worldHalfMm = Math.max(
        worldHalfMm,
        Math.abs(Number(x)),
        Math.abs(Number(y)),
        Math.abs(Number(z)),
      );
    });

    solids.push(`    <tessellated name="${name}_solid">`);
    for (const [a, b, c] of welded.triangles) {
      solids.push(
        `      <triangular vertex1="v${p}_${a}" vertex2="v${p}_${b}" vertex3="v${p}_${c}" type="ABSOLUTE"/>`,
      );
    }
    solids.push(`    </tessellated>`);

    volumes.push(
      `    <volume name="${name}_vol">`,
      `      <materialref ref="${materialRef(part.materialId)}"/>`,
      `      <solidref ref="${name}_solid"/>`,
      `    </volume>`,
    );
    physvols.push(
      `      <physvol name="${name}_pv">`,
      `        <volumeref ref="${name}_vol"/>`,
      `      </physvol>`,
    );
  });

  // World box: cube comfortably enclosing every vertex, centred at origin.
  const worldSizeMm = (Math.ceil(worldHalfMm) + 10) * 2 * 1.5;

  const materials: string[] = [];
  if (usedCustomMaterials.size > 0) {
    const usedElements = new Set<string>();
    for (const id of usedCustomMaterials) {
      for (const [el] of CUSTOM_MATERIALS[id]!.composite) usedElements.add(el);
    }
    materials.push('  <materials>');
    for (const el of usedElements) {
      const { z, a } = ELEMENTS[el]!;
      materials.push(
        `    <element name="el_${el}" formula="${el}" Z="${z}"><atom value="${a}"/></element>`,
      );
    }
    for (const id of usedCustomMaterials) {
      const m = CUSTOM_MATERIALS[id]!;
      materials.push(
        `    <material name="${m.gdmlName}" state="solid">`,
        `      <D value="${m.densityGcm3}" unit="g/cm3"/>`,
        ...m.composite.map(
          ([el, n]) => `      <composite n="${n}" ref="el_${el}"/>`,
        ),
        `    </material>`,
      );
    }
    materials.push('  </materials>');
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gdml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
    `      xsi:noNamespaceSchemaLocation="http://service-spi.web.cern.ch/service-spi/app/releases/GDML/schema/gdml.xsd">`,
    `  <define>`,
    ...define,
    `  </define>`,
    ...materials,
    `  <solids>`,
    ...solids,
    `    <box name="world_solid" lunit="mm" x="${worldSizeMm}" y="${worldSizeMm}" z="${worldSizeMm}"/>`,
    `  </solids>`,
    `  <structure>`,
    ...volumes,
    `    <volume name="world_vol">`,
    `      <materialref ref="G4_AIR"/>`,
    `      <solidref ref="world_solid"/>`,
    ...physvols,
    `    </volume>`,
    `  </structure>`,
    `  <setup name="Default" version="1.0">`,
    `    <world ref="world_vol"/>`,
    `  </setup>`,
    `</gdml>`,
    ``,
  ].join('\n');

  return { xml, totalTriangles, degenerateDropped };
}
