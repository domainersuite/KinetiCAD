// Shared types between the CAD worker and main thread.
//
// All units are millimetres unless stated otherwise.

import type {
  BooleanOperation,
  ExtrudeMode,
  Feature,
  Sketch,
  SketchPrimitive,
  Transform,
} from "@/state/schemas";
import type { CardinalPlane } from "@/sketch/plane";

/**
 * High-level edge geometry classifier. Drives picking heuristics, future
 * fillet/chamfer applicability, and downstream UI labels.
 *
 * 'arc' is a partial circle (parameter span < 2π); 'circle' is a full one.
 * 'spline' covers Bezier and BSpline. 'other' is the catch-all for ellipses,
 * hyperbolas, parabolas, and offset/composite curves.
 */
export type EdgeType = "line" | "circle" | "arc" | "spline" | "other";

/** High-level face geometry classifier. */
export type FaceType =
  | "plane"
  | "cylinder"
  | "cone"
  | "sphere"
  | "torus"
  | "other";

/**
 * Per-edge metadata returned by the kernel alongside the tessellated mesh.
 *
 * `id` is a stable hash derived from the edge's canonical geometry (line:
 * sorted endpoints; circle/arc: centre+radius+axis+angles; etc.) so that
 * picker selection survives parameter edits whenever the underlying geometry
 * is preserved.
 *
 * `polyline` is a flat xyz Float32Array (3 floats per point) sampled in
 * world space. Lines have 2 points; circles ~32; arcs proportional; splines
 * sampled uniformly along arc length. We deliberately store xyz triplets
 * rather than indices into `positions` so the highlight layer and screen-
 * space proximity raycast both consume the same buffer with no lookup.
 */
export type EdgeMetadata = {
  id: string;
  type: EdgeType;
  lengthMm: number;
  midpoint: [number, number, number];
  polyline: Float32Array;
  /**
   * For circle and arc edges: the true geometric centre of the underlying
   * circle, computed from polyline samples via D0 (so it inherits the correct
   * accumulated TopLoc_Location). Undefined for non-circular edges.
   *
   * Prefer this over `polylineCenter(polyline)` for revolute mate pivots —
   * for an arc the polyline average gives the arc centroid (offset from the
   * circle centre), while this field always gives the exact centre.
   */
  circleCenter?: [number, number, number];
};

/**
 * Per-face metadata returned by the kernel alongside the tessellated mesh.
 *
 * `triangles` is a list of triangle indices (k, where the triangle's three
 * vertex indices live at `indices[3k..3k+2]`) — used by the highlight layer
 * to build an overlay mesh, and inverted on the main thread into a
 * `faceForTriangle: Uint32Array` parallel to the triangle count for
 * O(1) raycast lookup.
 */
export type FaceMetadata = {
  id: string;
  type: FaceType;
  areaMm2: number;
  centroid: [number, number, number];
  /** Outward-pointing normal at the centroid; honours face orientation. */
  normalAtCentroid: [number, number, number];
  triangles: Uint32Array;
  /**
   * For planar faces only: 3D origin + two orthonormal basis vectors that
   * span the face plane. Used by `point-on-face` picking to compute UV.
   * `null` for non-planar faces (point-on-face on those is deferred).
   */
  planeBasis: {
    origin: [number, number, number];
    u: [number, number, number];
    v: [number, number, number];
  } | null;
};

export type TessellatedMesh = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: EdgeMetadata[];
  faces: FaceMetadata[];
};

export type KernelInitResult = {
  initTimeMs: number;
  version: string;
};

export type ExtrudeArgs = {
  sketchPrimitives: SketchPrimitive[];
  plane: CardinalPlane;
  depthMm: number;
  direction: "forward" | "backward" | "symmetric";
  /**
   * How this extrude solid interacts with the part's existing geometry.
   * Defaults to 'new-body' for backward compatibility when omitted.
   * New inspector-created features default to 'add' (Boolean-Union).
   */
  extrudeMode?: ExtrudeMode;
  /**
   * Feature chain preceding this extrude on the same part. Passed when
   * extrudeMode is 'add' or 'subtract' so the worker can build the prior
   * solid and fuse / cut the new extrude against it.
   */
  upstreamFeatures?: Feature[];
  /** Part sketches needed to re-execute the upstream chain in the worker. */
  upstreamSketches?: Sketch[];
};

export type RevolveArgs = {
  sketchPrimitives: SketchPrimitive[];
  plane: CardinalPlane;
  axis: "X" | "Y" | "Z";
  angleDeg: number;
};

/**
 * Modifier-feature args (fillet/chamfer/hole). The worker re-executes the
 * `upstreamFeatures` chain against `upstreamSketches` to rebuild the OCCT
 * shape, resolves the target edge/face IDs to live TopoDS wrappers, applies
 * the modification, and returns the tessellated result.
 *
 * Caching by feature hash on the main thread guarantees we don't pay this
 * cost on cache hits; on cache miss the worker pays a single re-execution.
 */
export type FilletArgs = {
  upstreamFeatures: Feature[];
  upstreamSketches: Sketch[];
  targetEdgeIds: string[];
  radiusMm: number;
};

export type ChamferArgs = {
  upstreamFeatures: Feature[];
  upstreamSketches: Sketch[];
  targetEdgeIds: string[];
  sizeMm: number;
};

export type HoleArgs = {
  upstreamFeatures: Feature[];
  upstreamSketches: Sketch[];
  targetFaceId: string;
  /** UV in mm along the face's planar basis (planar faces only in v1). */
  positionUV: [number, number];
  diameterMm: number;
  /** 0 = through-all (cylinder length = 2 × upstream bbox diagonal). */
  depthMm: number;
};

/**
 * Phase 5 boolean op: each input describes one part's full feature chain
 * (sketches + features in order). The worker re-executes every chain to
 * obtain the live TopoDS_Shape, then runs Fuse_3 / Cut_3 / Common_3.
 *
 * Order of `inputs` is significant for `subtract`: the orchestrator MUST
 * place the body part first and the tool part second.
 */
export type BooleanInputDescriptor = {
  /** Source part id, surfaced back in error messages and for cache keys. */
  partId: string;
  features: Feature[];
  sketches: Sketch[];
  /**
   * Phase 6: rigid-body world transform applied to this input shape via
   * `BRepBuilderAPI_Transform_2` BEFORE the boolean operation runs. Identity
   * transforms short-circuit the OCCT call.
   */
  transform: Transform;
};

export type BooleanOpArgs = {
  inputs: BooleanInputDescriptor[];
  operation: BooleanOperation;
};

/**
 * One part's contribution to an STL export. Mirrors BooleanInputDescriptor
 * but is kept separate so the export pipeline can evolve independently.
 */
export type ExportPartDescriptor = {
  partId: string;
  features: Feature[];
  sketches: Sketch[];
  transform: Transform;
};

/**
 * One part's world-space tessellation, as returned by
 * `exportAssemblyMeshes`. Consumed by the mesh-format exporters (GDML,
 * OBJ) on the main thread, which join it back to the part's name and
 * material via `partId`.
 */
export type MeshExportResult = {
  partId: string;
  positions: Float32Array;
  indices: Uint32Array;
};

/**
 * Phase 8 — args for `getMassProperties`. The CAD worker re-executes the
 * upstream feature chain just like a regen, then queries OCCT's
 * `GProp_GProps` for volume / centre of mass / inertia tensor on the
 * tip shape. `density` is in g/cm³ (default aluminium 2.70). The part's
 * `Transform` is NOT applied — the result is in the part's *local* frame
 * so Rapier can attach the mass to a rigid body whose pose is set by the
 * transform separately.
 */
export type MassPropertiesArgs = {
  features: Feature[];
  sketches: Sketch[];
  /** Material density in g/cm³. Default 2.70 (aluminium). */
  density: number;
};

/**
 * Phase 8 — mass properties returned by the CAD worker.
 *
 * Units:
 * - `volumeMm3` is in mm³ (OCCT native).
 * - `massKg` = `volumeMm3 × density × 1e-6` (mm³ × g/cm³ → kg).
 * - `comLocal` is the centre-of-mass in mm in the part's local frame.
 * - `principalInertiaKgMm2` are the three principal moments of inertia
 *   in kg·mm². Rapier consumes these directly as the diagonal of the
 *   inertia tensor; the off-diagonal terms are zero in the principal
 *   axis frame, so we omit them.
 *
 * Edge case: if the upstream chain produces a non-solid (e.g. a sheet
 * body) or an empty shape, `volumeMm3` will be 0 and `massKg` will be
 * clamped to a small positive value (1e-6 kg) so Rapier doesn't blow
 * up with NaN inertias. The caller should treat zero-volume parts as
 * static decoration.
 */
export type MassPropertiesResult = {
  volumeMm3: number;
  massKg: number;
  comLocal: [number, number, number];
  principalInertiaKgMm2: [number, number, number];
};

/**
 * Metadata returned by `importStep` for a single B-rep body extracted
 * from the STEP file. The shape itself stays in the CAD worker's in-memory
 * registry; this record carries the tessellated mesh (already on the main
 * thread via Comlink transfer) and the axis-aligned bounding box so the UI
 * can show an orientation hint if the file uses Y-up instead of Z-up.
 */
export type ImportedPart = {
  /** Key into the CAD worker's in-memory shape registry. */
  shapeId: string;
  /** STEP PRODUCT name extracted from the XCAF document tree, or a fallback
   *  stem derived from the file name ("filename_01") when no PRODUCT label is
   *  present.  Never the generic "Imported Part N" placeholder. */
  name: string;
  /** Full tessellated mesh with edge and face topology, ready for display. */
  tessellated: TessellatedMesh;
  /** Axis-aligned bounding box in STEP file coordinates (mm). */
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
};

export type CadKernelApi = {
  init: () => Promise<KernelInitResult>;
  createTestCube: (sizeMm: number) => Promise<TessellatedMesh>;
  /**
   * Build a closed wire from the given sketch, extrude into a 3D solid, and
   * return its tessellated mesh. Throws (rejects) with a descriptive message
   * if the sketch is not closed, has gaps, or OCCT fails on the operation.
   */
  extrude: (args: ExtrudeArgs) => Promise<TessellatedMesh>;
  /**
   * Build a closed wire from the given sketch, revolve around the given world
   * axis through the origin, and return the tessellated solid mesh.
   */
  revolve: (args: RevolveArgs) => Promise<TessellatedMesh>;
  /**
   * Re-execute the upstream feature chain, apply a fillet to the named edges
   * with the given radius, tessellate, return mesh.
   */
  fillet: (args: FilletArgs) => Promise<TessellatedMesh>;
  /**
   * Re-execute the upstream feature chain, apply a chamfer to the named
   * edges with the given size, tessellate, return mesh.
   */
  chamfer: (args: ChamferArgs) => Promise<TessellatedMesh>;
  /**
   * Re-execute the upstream feature chain, drill a cylindrical hole at
   * (positionUV) on the target planar face, tessellate, return mesh.
   * `depthMm = 0` means through-all.
   */
  hole: (args: HoleArgs) => Promise<TessellatedMesh>;
  /**
   * Re-execute every input part's upstream feature chain, then apply the
   * given boolean operation across the resulting solids. Returns the
   * tessellated result. For `subtract`, the orchestrator MUST place the
   * body shape first and the tool shape second.
   */
  booleanOp: (args: BooleanOpArgs) => Promise<TessellatedMesh>;
  /**
   * Phase 8 — re-execute the upstream feature chain and return the tip
   * shape's volume / mass / centre-of-mass / principal inertia. Used by
   * the physics layer to seed a Rapier rigid body with realistic mass
   * properties. Empty / non-solid shapes return zero volume and a tiny
   * fallback mass.
   */
  getMassProperties: (
    args: MassPropertiesArgs,
  ) => Promise<MassPropertiesResult>;
  /**
   * Build every part's geometry, apply its world transform, combine into a
   * single compound, mesh it, and write binary STL. Returns the raw file
   * bytes so the caller can wrap them in a Blob and trigger a download.
   *
   * Parts with no features are silently skipped.
   */
  exportAssemblyStl: (parts: ExportPartDescriptor[]) => Promise<Uint8Array>;
  /**
   * Build every part's geometry, apply its world transform, and tessellate
   * each part SEPARATELY (unlike exportAssemblyStl's single compound).
   * Feeds the mesh-format exporters (GDML for Geant4, OBJ), which need
   * per-part meshes so names and materials survive the export.
   *
   * Parts with no features are silently skipped.
   */
  exportAssemblyMeshes: (
    parts: ExportPartDescriptor[],
  ) => Promise<MeshExportResult[]>;
  /**
   * Read a STEP file (raw bytes), expand any compound roots into individual
   * solids, tessellate each solid with full edge + face topology, register
   * the OCCT shapes in the worker's in-memory registry (for later re-export),
   * and return the metadata + tessellated meshes for the store to create new
   * parts. Parts whose geometry comes from STEP files do NOT carry parametric
   * feature history — STEP is flat B-rep only.
   */
  importStep: (fileBytes: Uint8Array, fileName?: string) => Promise<ImportedPart[]>;
  /**
   * Build every part's geometry (re-executing parametric chains, or
   * retrieving STEP-imported shapes from the worker registry), apply world
   * transforms, combine into a compound, and write an AP214 STEP file.
   * Returns the raw file bytes. Parts with no features are silently skipped.
   */
  exportAssemblyStep: (parts: ExportPartDescriptor[]) => Promise<Uint8Array>;
};
