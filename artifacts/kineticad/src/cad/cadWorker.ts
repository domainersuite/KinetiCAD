/// <reference lib="webworker" />
//
// CAD Web Worker: hosts OpenCascade.js and exposes a Comlink-typed API to the
// main thread. The kernel is heavy, so anything that touches B-rep geometry
// must run here.

import * as Comlink from "comlink";
// We bypass opencascade.js's index.js wrapper because it does a bare
// `import "./opencascade.full.wasm"` that Vite cannot pre-bundle. Instead we
// import the Emscripten factory directly and feed it a CDN-hosted WASM URL
// via locateFile.
//
// Phase 9.5 Follow-up #8 — load the 50 MB WASM blob from jsDelivr instead
// of bundling it. Replit's static-deploy pipeline returns 200 + empty body
// for assets above its size cap (~10 MB in practice), which manifested at
// runtime as `WebAssembly.instantiate(): BufferSource argument is empty`
// on the deployed `.replit.app` URL while dev kept working from
// `localhost`. jsDelivr serves the exact pinned package version with
// `application/wasm` content-type, permissive CORS, and a 1-year
// immutable cache, so streaming-instantiate works first try.
//
// The version literal MUST stay in lock-step with `opencascade.js` in
// `package.json` — there is a runtime check at `ensureKernel` that
// records this string as the kernel version.
import ocFactoryRaw from "opencascade.js/dist/opencascade.full.js";
import type { OpenCascadeInstance } from "opencascade.js";
import type {
  BooleanOpArgs,
  CadKernelApi,
  ChamferArgs,
  ExportPartDescriptor,
  ExtrudeArgs,
  FilletArgs,
  HoleArgs,
  KernelInitResult,
  MassPropertiesArgs,
  MassPropertiesResult,
  MeshExportResult,
  RevolveArgs,
  TessellatedMesh,
} from "./types";
import type { Feature, Sketch } from "@/state/schemas";
import { isCardinalPlane } from "@/sketch/plane";
import { tessellateShape } from "./operations/tessellate";
import { sketchToWire } from "./operations/sketchToWire";
import { extrude as extrudeWire } from "./operations/extrude";
import { revolve as revolveWire } from "./operations/revolve";
import {
  collectTransferables,
  disposeRefMap,
  enumerateEdgeRefs,
  enumerateFaceRefs,
  enumerateTopology,
} from "./operations/topology";
import { applyFillet } from "./operations/fillet";
import { applyChamfer } from "./operations/chamfer";
import { applyHole, type HoleFaceRef } from "./operations/hole";
import { applyBoolean } from "./operations/boolean";
import { computeMassProperties } from "./operations/massProperties";

// Worker→main-thread console bridge. 16/05/2026
// Production builds do not forward worker console.log to the page's DevTools
// context. We patch each console method to also postMessage a __log envelope
// that cadClient.ts picks up before Comlink sees the message. The try/catch in
// __forward swallows DataCloneError silently so a non-cloneable arg (e.g. an
// OCCT handle) never crashes the worker.
const __origLog   = console.log;
const __origInfo  = console.info;
const __origDebug = console.debug;
const __origWarn  = console.warn;
const __origError = console.error;
function __forward(level: string, args: unknown[]): void {
  try { self.postMessage({ __log: true, level, args }); } catch { /* swallow DataCloneError */ }
}
console.log   = (...a: unknown[]) => { __origLog(...a);   __forward('log',   a); };
console.info  = (...a: unknown[]) => { __origInfo(...a);  __forward('info',  a); };
console.debug = (...a: unknown[]) => { __origDebug(...a); __forward('debug', a); };
console.warn  = (...a: unknown[]) => { __origWarn(...a);  __forward('warn',  a); };
console.error = (...a: unknown[]) => { __origError(...a); __forward('error', a); };

const OCCT_VERSION = "2.0.0-beta.94e2944";
const OCCT_WASM_URL = `https://cdn.jsdelivr.net/npm/opencascade.js@${OCCT_VERSION}/dist/opencascade.full.wasm`;

// XCAF label-name debug logging. Permanently false -- see extractLabelName.
const STEP_NAME_DEBUG = false;

type OC = OpenCascadeInstance;

type OcFactorySettings = {
  locateFile: (path: string) => string;
};
type OcFactory = new (settings: OcFactorySettings) => Promise<OC>;

const ocFactory = ocFactoryRaw as unknown as OcFactory;

let ocInstance: OC | null = null;
let initPromise: Promise<KernelInitResult> | null = null;

// Registry of OCCT shapes imported from STEP files. Keyed by shapeId (a
// generated string). Lives in worker memory only — cleared when the worker
// thread restarts (i.e. on page reload). Parts whose features reference a
// shapeId that is no longer in this map will fail to regenerate with a
// descriptive error asking the user to re-import the file.
const importedShapeRegistry = new Map<string, unknown>();

async function ensureKernel(): Promise<KernelInitResult> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const start = performance.now();

    // The factory returns a thenable that resolves to the OC instance once the
    // WASM module is fully initialised.
    ocInstance = await new ocFactory({
      locateFile: (path: string) =>
        path.endsWith(".wasm") ? OCCT_WASM_URL : path,
    });

    const initTimeMs = Math.round(performance.now() - start);

    // Self-test: build a 20mm square, extrude 10mm, tessellate. Logs the
    // triangle count + axis-aligned bounding box so QA can confirm the
    // kernel is fully operational at boot. Catches any regression in the
    // sketch→wire→prism→mesh pipeline immediately, without needing the
    // user to draw a sketch first. Failure is logged loudly but does not
    // throw — kernel init still succeeds so the UI doesn't deadlock.
    runSelfTest(ocInstance).catch((err) => {
      // Should never trigger (runSelfTest swallows its own errors), but
      // belt-and-braces.
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] self-test wrapper threw:", err);
    });

    return {
      initTimeMs,
      // Version metadata isn't directly exposed by opencascade.js. The
      // OCCT_VERSION constant above is the source of truth (it's also
      // baked into the CDN URL the kernel just loaded from).
      version: OCCT_VERSION,
    };
  })();

  return initPromise;
}

/**
 * Boot-time smoke test for the CAD pipeline. Builds a 20mm square sketch,
 * extrudes it 10mm forward, tessellates the result and logs the triangle
 * count + bounding box. Any failure is logged via console.error with the
 * raw error so QA can see exactly where the pipeline broke.
 *
 * Expected output: triCount = 12 (six faces × two triangles each), bbox
 * spanning roughly (-10,-10,0) → (10,10,10).
 */
async function runSelfTest(oc: OC): Promise<void> {
  const ocAny = oc as any;
  let wire: any = null;
  let solid: any = null;
  try {
    const primitives = [
      {
        type: "rectangle" as const,
        corner: [-10, -10] as [number, number],
        width: 20,
        height: 20,
      },
    ];
    wire = sketchToWire(ocAny, "XY", primitives);
    solid = extrudeWire(ocAny, wire, "XY", 10, "forward");
    const tess = tessellateShape(ocAny, solid);
    const triCount = tess.indices.length / 3;

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const pos = tess.positions;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i];
      const y = pos[i + 1];
      const z = pos[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    if (triCount === 0 || pos.length === 0) {
      const msg =
        `[SELF-TEST] FAILED: empty mesh (tris=${triCount}, positions=${pos.length}). ` +
        `Sketch→wire→prism→tessellate produced no geometry — extrude is broken.`;
      // eslint-disable-next-line no-console
      console.error(msg);
      // Bridge to the main thread so it's visible in the page DevTools
      // regardless of worker-console filter settings.
      try {
        (self as unknown as Worker).postMessage({
          type: "self-test",
          ok: false,
          message: msg,
        });
      } catch {
        // postMessage may not be available outside DedicatedWorkerScope.
      }
      return;
    }

    const okMsg =
      `[SELF-TEST] OK: tris=${triCount} ` +
      `bbox=[${minX.toFixed(2)}, ${minY.toFixed(2)}, ${minZ.toFixed(2)}] → ` +
      `[${maxX.toFixed(2)}, ${maxY.toFixed(2)}, ${maxZ.toFixed(2)}]`;
    // Use console.error (not console.info) so Chrome's default filter
    // ("Errors" only) still surfaces it without the user expanding the
    // "Info" level. Semantically not an error — the [SELF-TEST] prefix
    // makes the intent obvious and greppable.
    // eslint-disable-next-line no-console
    console.error(okMsg);
    try {
      (self as unknown as Worker).postMessage({
        type: "self-test",
        ok: true,
        message: okMsg,
      });
    } catch {
      // ignore
    }
  } catch (err) {
    const failMsg =
      err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[SELF-TEST] FAILED:", err);
    try {
      (self as unknown as Worker).postMessage({
        type: "self-test",
        ok: false,
        message: `[SELF-TEST] FAILED: ${failMsg}`,
      });
    } catch {
      // ignore
    }
  } finally {
    if (solid) {
      try {
        solid.delete();
      } catch {
        // ignore
      }
    }
    if (wire) {
      try {
        wire.delete();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Tessellate + enumerate topology for a TopoDS_Shape in one shot, returning a
 * fully-populated TessellatedMesh.
 *
 * Every per-face / per-edge typed array buffer is transferable; the caller
 * wraps the result in `Comlink.transfer` with `collectTransferables(mesh)`.
 */
function buildMesh(oc: OC, solid: unknown): TessellatedMesh {
  const tess = tessellateShape(oc, solid);
  const { edges, faces } = enumerateTopology(
    oc,
    solid,
    tess.positions,
    tess.indices,
    tess.faceRanges,
  );
  return {
    positions: tess.positions,
    normals: tess.normals,
    indices: tess.indices,
    edges,
    faces,
  };
}

/**
 * Wrap a tessellated mesh in a Comlink transfer envelope so the typed arrays
 * are moved (not copied) across the worker boundary.
 */
function transferMesh(mesh: TessellatedMesh): TessellatedMesh {
  return Comlink.transfer(mesh, collectTransferables(mesh));
}

/**
 * Build a single OCCT shape by re-executing a feature chain in order. Each
 * step's intermediate shape is freed after the next step consumes it. The
 * caller owns the returned shape and must `.delete()` it.
 *
 * Used by modifier features (fillet/chamfer/hole) whose worker call needs the
 * upstream geometry as a TopoDS_Shape, not just metadata. This deliberately
 * mirrors the ordering and per-feature dispatch of `featureRegen.runFeature`,
 * but stays inside the worker to avoid round-tripping shapes back to JS.
 */
function executeUpstreamChain(
  oc: OC,
  features: Feature[],
  sketches: Sketch[],
): unknown {
  const ocAny = oc as any;
  let current: any = null;

  for (const feat of features) {
    let nextShape: any = null;

    if (feat.type === "extrude" || feat.type === "revolve") {
      const sketch = sketches.find((s) => s.id === feat.sketchId);
      if (!sketch) {
        if (current) current.delete();
        throw new Error(`Sketch ${feat.sketchId} not found in upstream chain.`);
      }
      if (!isCardinalPlane(sketch.plane)) {
        if (current) current.delete();
        throw new Error("Upstream chain has a non-cardinal sketch plane.");
      }
      let wire: any = null;
      let newSolid: any = null;
      try {
        wire = sketchToWire(ocAny, sketch.plane, sketch.primitives);
        newSolid =
          feat.type === "extrude"
            ? extrudeWire(ocAny, wire, sketch.plane, feat.depthMm, feat.direction)
            : revolveWire(ocAny, wire, feat.axis, feat.angleDeg);
      } finally {
        if (wire) wire.delete();
      }
      // Boolean accumulation: union / subtract the new solid with the prior
      // solid, or replace it (new-body mode, or first feature, or revolve).
      const mode =
        feat.type === "extrude" ? (feat.extrudeMode ?? "add") : "new-body";
      if (current && (mode === "add" || mode === "subtract")) {
        const op =
          mode === "add"
            ? { type: "union" as const }
            : { type: "subtract" as const, toolPartId: "" };
        let fused: any;
        try {
          fused = applyBoolean(ocAny, [current, newSolid], op);
        } catch (boolErr) {
          newSolid.delete();
          current.delete();
          current = null;
          throw new Error(
            `Extrude ${mode} failed on upstream chain: ${String(boolErr)}`,
          );
        }
        newSolid.delete();
        current.delete();
        current = null; // prevents double-delete at bottom of loop iteration
        nextShape = fused;
      } else {
        nextShape = newSolid;
      }
    } else if (feat.type === "fillet") {
      if (!current) throw new Error("Fillet has no upstream shape.");
      const refs = enumerateEdgeRefs(ocAny, current);
      try {
        nextShape = applyFillet(
          ocAny,
          current,
          refs,
          feat.targetEdges,
          feat.radiusMm,
        );
      } finally {
        disposeRefMap(refs);
      }
    } else if (feat.type === "chamfer") {
      if (!current) throw new Error("Chamfer has no upstream shape.");
      const refs = enumerateEdgeRefs(ocAny, current);
      try {
        nextShape = applyChamfer(
          ocAny,
          current,
          refs,
          feat.targetEdges,
          feat.sizeMm,
        );
      } finally {
        disposeRefMap(refs);
      }
    } else if (feat.type === "hole") {
      if (!current) throw new Error("Hole has no upstream shape.");
      // We need both the FaceMetadata (for plane basis + normal) and the
      // TopoDS_Face wrapper (for the cylinder math) of the same face id.
      const tess = tessellateShape(ocAny, current);
      const enumerated = enumerateTopology(
        ocAny,
        current,
        tess.positions,
        tess.indices,
        tess.faceRanges,
      );
      const meta = enumerated.faces.find((f) => f.id === feat.targetFace);
      if (!meta) {
        throw new Error(
          `face-not-found: face ${feat.targetFace} no longer exists.`,
        );
      }
      if (!meta.planeBasis) {
        throw new Error(
          "Hole target face must be planar (non-planar holes are not supported in v1).",
        );
      }
      const refs = enumerateFaceRefs(
        ocAny,
        current,
        tess.positions,
        tess.indices,
        tess.faceRanges,
      );
      try {
        const face = refs.get(feat.targetFace);
        if (!face) {
          throw new Error(
            `face-not-found: face ${feat.targetFace} no longer exists.`,
          );
        }
        const ref: HoleFaceRef = {
          face,
          origin: meta.planeBasis.origin,
          u: meta.planeBasis.u,
          v: meta.planeBasis.v,
          normal: meta.normalAtCentroid,
        };
        nextShape = applyHole(
          ocAny,
          current,
          ref,
          feat.positionUV,
          feat.diameterMm,
          feat.depthMm,
        );
      } finally {
        disposeRefMap(refs);
      }
    } else if (feat.type === 'imported-step') {
      const stored = importedShapeRegistry.get(feat.shapeId);
      if (!stored) {
        if (current) current.delete();
        throw new Error(
          `imported-step shape "${feat.shapeId}" is not in the worker registry. ` +
          'Re-import the STEP file to restore this part.',
        );
      }
      // Deep-copy the stored shape so downstream operations cannot corrupt
      // the registry entry (e.g. a boolean cut would consume the input shape).
      const copier = new ocAny.BRepBuilderAPI_Copy_2(stored, true, false);
      try {
        nextShape = copier.Shape();
      } finally {
        copier.delete();
      }
    } else {
      throw new Error(
        `Unsupported upstream feature type: ${(feat as { type: string }).type}`,
      );
    }

    if (current) current.delete();
    current = nextShape;
  }

  if (!current) {
    throw new Error("Upstream feature chain produced no shape.");
  }
  return current;
}

const api: CadKernelApi = {
  async init() {
    return ensureKernel();
  },

  async createTestCube(sizeMm: number) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");

    const oc = ocInstance as any;
    const half = sizeMm / 2;

    // Centre the cube on the origin so it sits nicely under the camera target.
    const corner1 = new oc.gp_Pnt_3(-half, -half, -half);
    const corner2 = new oc.gp_Pnt_3(half, half, half);
    const boxBuilder = new oc.BRepPrimAPI_MakeBox_4(corner1, corner2);
    const shape = boxBuilder.Shape();

    const mesh = buildMesh(ocInstance, shape);

    // Release every transient OCCT wrapper we built. The shape is owned by the
    // builder, so deleting the builder reclaims its TShape; we still null out
    // our local ref. Order matters: shape first (cheap), then builder, then
    // the gp_Pnt corners.
    shape.delete();
    boxBuilder.delete();
    corner1.delete();
    corner2.delete();

    return transferMesh(mesh);
  },

  async extrude(args: ExtrudeArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;
    const ocAny = oc as any;

    // wire + newSolid are intermediate shapes. priorSolid is the accumulated
    // upstream solid (built when mode is 'add' or 'subtract'). result is the
    // final shape handed to buildMesh.
    let wire: any = null;
    let newSolid: any = null;
    let priorSolid: any = null;
    let result: any = null;
    try {
      wire = sketchToWire(oc, args.plane, args.sketchPrimitives);
      newSolid = extrudeWire(oc, wire, args.plane, args.depthMm, args.direction);
      wire.delete();
      wire = null;

      const mode = args.extrudeMode ?? "new-body";
      const hasUpstream =
        (mode === "add" || mode === "subtract") &&
        args.upstreamFeatures &&
        args.upstreamFeatures.length > 0 &&
        args.upstreamSketches;

      if (hasUpstream) {
        priorSolid = executeUpstreamChain(
          oc,
          args.upstreamFeatures!,
          args.upstreamSketches!,
        );
        const op =
          mode === "add"
            ? { type: "union" as const }
            : { type: "subtract" as const, toolPartId: "" };
        result = applyBoolean(ocAny, [priorSolid, newSolid], op);
      } else {
        result = newSolid;
        newSolid = null; // ownership transferred to result; prevent double-delete
      }

      const mesh = buildMesh(oc, result);
      return transferMesh(mesh);
    } catch (err) {
      // Always surface the raw error in the worker console so QA + dev tools
      // can see exactly what OCCT reported, regardless of how the inspector
      // chooses to render it.
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] extrude failed:", err);
      // Re-throw with a clean message so the inspector can show it. Keep the
      // original message if it's already user-friendly, otherwise wrap.
      if (err instanceof Error) throw err;
      throw new Error(`Extrude failed: ${String(err)}`);
    } finally {
      if (result) result.delete();
      if (priorSolid) priorSolid.delete();
      if (newSolid) newSolid.delete();
      if (wire) wire.delete();
    }
  },

  async revolve(args: RevolveArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    let wire: any = null;
    let solid: any = null;
    try {
      wire = sketchToWire(oc, args.plane, args.sketchPrimitives);
      solid = revolveWire(oc, wire, args.axis, args.angleDeg);
      const mesh = buildMesh(oc, solid);
      return transferMesh(mesh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] revolve failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`Revolve failed: ${String(err)}`);
    } finally {
      if (solid) solid.delete();
      if (wire) wire.delete();
    }
  },

  async fillet(args: FilletArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    let upstream: any = null;
    let edgeRefs: Map<string, unknown> | null = null;
    let result: any = null;
    try {
      upstream = executeUpstreamChain(
        oc,
        args.upstreamFeatures,
        args.upstreamSketches,
      );
      edgeRefs = enumerateEdgeRefs(oc, upstream);
      result = applyFillet(
        oc,
        upstream,
        edgeRefs,
        args.targetEdgeIds,
        args.radiusMm,
      );
      const mesh = buildMesh(oc, result);
      return transferMesh(mesh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] fillet failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`Fillet failed: ${String(err)}`);
    } finally {
      if (result) result.delete();
      if (edgeRefs) disposeRefMap(edgeRefs);
      if (upstream) upstream.delete();
    }
  },

  async chamfer(args: ChamferArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    let upstream: any = null;
    let edgeRefs: Map<string, unknown> | null = null;
    let result: any = null;
    try {
      upstream = executeUpstreamChain(
        oc,
        args.upstreamFeatures,
        args.upstreamSketches,
      );
      edgeRefs = enumerateEdgeRefs(oc, upstream);
      result = applyChamfer(
        oc,
        upstream,
        edgeRefs,
        args.targetEdgeIds,
        args.sizeMm,
      );
      const mesh = buildMesh(oc, result);
      return transferMesh(mesh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] chamfer failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`Chamfer failed: ${String(err)}`);
    } finally {
      if (result) result.delete();
      if (edgeRefs) disposeRefMap(edgeRefs);
      if (upstream) upstream.delete();
    }
  },

  async hole(args: HoleArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    let upstream: any = null;
    let faceRefs: Map<string, unknown> | null = null;
    let result: any = null;
    try {
      upstream = executeUpstreamChain(
        oc,
        args.upstreamFeatures,
        args.upstreamSketches,
      );

      // Tessellate + enumerate topology so we can resolve the face id to its
      // FaceMetadata (plane basis + normal) AND its TopoDS_Face wrapper.
      const tess = tessellateShape(oc, upstream);
      const enumerated = enumerateTopology(
        oc,
        upstream,
        tess.positions,
        tess.indices,
        tess.faceRanges,
      );
      const meta = enumerated.faces.find((f) => f.id === args.targetFaceId);
      if (!meta) {
        throw new Error(
          `face-not-found: face ${args.targetFaceId} no longer exists.`,
        );
      }
      if (!meta.planeBasis) {
        throw new Error(
          "Hole target face must be planar (non-planar holes are not supported in v1).",
        );
      }

      faceRefs = enumerateFaceRefs(
        oc,
        upstream,
        tess.positions,
        tess.indices,
        tess.faceRanges,
      );
      const face = faceRefs.get(args.targetFaceId);
      if (!face) {
        throw new Error(
          `face-not-found: face ${args.targetFaceId} no longer exists.`,
        );
      }
      const ref: HoleFaceRef = {
        face,
        origin: meta.planeBasis.origin,
        u: meta.planeBasis.u,
        v: meta.planeBasis.v,
        normal: meta.normalAtCentroid,
      };

      result = applyHole(
        oc,
        upstream,
        ref,
        args.positionUV,
        args.diameterMm,
        args.depthMm,
      );
      const mesh = buildMesh(oc, result);
      return transferMesh(mesh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] hole failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`Hole failed: ${String(err)}`);
    } finally {
      if (result) result.delete();
      if (faceRefs) disposeRefMap(faceRefs);
      if (upstream) upstream.delete();
    }
  },

  async booleanOp(args: BooleanOpArgs) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    if (!Array.isArray(args.inputs) || args.inputs.length < 2) {
      throw new Error(
        `boolean-failed: need ≥2 inputs, got ${args.inputs?.length ?? 0}.`,
      );
    }
    if (args.operation.type === "subtract" && args.inputs.length !== 2) {
      throw new Error(
        `subtract-needs-tool: expected 2 inputs (body + tool), got ${args.inputs.length}.`,
      );
    }

    // Build every input shape from its upstream chain, then apply each
    // input's rigid-body transform via BRepBuilderAPI_Transform_2 BEFORE
    // running the boolean. We track base + transformed shapes separately
    // so the finally cleanup frees both regardless of which step throws.
    const baseShapes: any[] = [];
    const transformedShapes: any[] = [];
    let result: any = null;
    try {
      for (const input of args.inputs) {
        if (!input.features || input.features.length === 0) {
          throw new Error(
            `boolean-failed: input part ${input.partId} has no features.`,
          );
        }
        const base = executeUpstreamChain(oc, input.features, input.sketches);
        baseShapes.push(base);

        // Phase 6: apply the part's transform. Identity short-circuits
        // (saves an OCCT call per part on the common case).
        const tx = input.transform;
        const isIdentity =
          tx &&
          tx.positionMm[0] === 0 &&
          tx.positionMm[1] === 0 &&
          tx.positionMm[2] === 0 &&
          tx.rotationDeg[0] === 0 &&
          tx.rotationDeg[1] === 0 &&
          tx.rotationDeg[2] === 0;

        if (!tx || isIdentity) {
          transformedShapes.push(base);
          continue;
        }

        // Compose M = T · Rx · Ry · Rz so that, applied to a point p, the
        // result is T(Rx(Ry(Rz(p)))) — i.e. rotation first (Z then Y then
        // X) and translation last. This matches three.js's
        // mesh.matrixWorld with rotation order "XYZ" so the live mesh
        // position and the OCCT-baked geometry stay in lockstep.
        const trsf = new oc.gp_Trsf_1();
        const origin = new oc.gp_Pnt_3(0, 0, 0);
        const axisX = new oc.gp_Dir_4(1, 0, 0);
        const axisY = new oc.gp_Dir_4(0, 1, 0);
        const axisZ = new oc.gp_Dir_4(0, 0, 1);
        const ax1X = new oc.gp_Ax1_2(origin, axisX);
        const ax1Y = new oc.gp_Ax1_2(origin, axisY);
        const ax1Z = new oc.gp_Ax1_2(origin, axisZ);

        const trsfRotZ = new oc.gp_Trsf_1();
        trsfRotZ.SetRotation_1(ax1Z, (tx.rotationDeg[2] * Math.PI) / 180);
        const trsfRotY = new oc.gp_Trsf_1();
        trsfRotY.SetRotation_1(ax1Y, (tx.rotationDeg[1] * Math.PI) / 180);
        const trsfRotX = new oc.gp_Trsf_1();
        trsfRotX.SetRotation_1(ax1X, (tx.rotationDeg[0] * Math.PI) / 180);
        const trsfTrans = new oc.gp_Trsf_1();
        const transVec = new oc.gp_Vec_4(
          tx.positionMm[0],
          tx.positionMm[1],
          tx.positionMm[2],
        );
        trsfTrans.SetTranslation_1(transVec);

        // Multiply pre-multiplies: trsf becomes (other · trsf). Start with
        // Z (innermost), then Y, X, T to end up with M = T·Rx·Ry·Rz.
        trsf.Multiply(trsfRotZ);
        trsf.Multiply(trsfRotY);
        trsf.Multiply(trsfRotX);
        trsf.Multiply(trsfTrans);

        const transformer = new oc.BRepBuilderAPI_Transform_2(
          base as never,
          trsf,
          true,
        );
        const transformed = transformer.Shape();
        transformedShapes.push(transformed);

        // Free every gp_* and the transformer wrapper. The transformed
        // TopoDS_Shape is now independent.
        transformer.delete();
        transVec.delete();
        trsfTrans.delete();
        trsfRotX.delete();
        trsfRotY.delete();
        trsfRotZ.delete();
        ax1Z.delete();
        ax1Y.delete();
        ax1X.delete();
        axisZ.delete();
        axisY.delete();
        axisX.delete();
        origin.delete();
        trsf.delete();
      }

      // Worker trusts the orchestrator's ordering: for subtract the body
      // shape is at index 0 and the tool shape at index 1.
      result = applyBoolean(oc, transformedShapes, args.operation);
      const mesh = buildMesh(oc, result);
      return transferMesh(mesh);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] booleanOp failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`boolean-failed: ${String(err)}`);
    } finally {
      if (result) result.delete?.();
      for (let i = 0; i < transformedShapes.length; i++) {
        // Skip if transformed === base (identity short-circuit) — the
        // base loop below will handle it.
        if (transformedShapes[i] !== baseShapes[i]) {
          transformedShapes[i]?.delete?.();
        }
      }
      for (const s of baseShapes) {
        s?.delete?.();
      }
    }
  },

  async getMassProperties(
    args: MassPropertiesArgs,
  ): Promise<MassPropertiesResult> {
    await ensureKernel();
    if (!ocInstance) throw new Error("OC kernel not initialised.");
    const oc = ocInstance;

    // Build the part's tip shape from the upstream chain. Identical
    // pipeline to booleanOp's per-input regen, just without the
    // Transform application — Rapier owns the body pose.
    let tip: any = null;
    try {
      tip = executeUpstreamChain(oc, args.features, args.sketches);
      if (!tip) {
        // No features → empty part. Return a zero-volume fallback so
        // the physics layer can choose to skip the body.
        return {
          volumeMm3: 0,
          massKg: 1e-6,
          comLocal: [0, 0, 0],
          principalInertiaKgMm2: [1e-6, 1e-6, 1e-6],
        };
      }
      const props = computeMassProperties(oc, tip, args.density);
      if (!props) {
        return {
          volumeMm3: 0,
          massKg: 1e-6,
          comLocal: [0, 0, 0],
          principalInertiaKgMm2: [1e-6, 1e-6, 1e-6],
        };
      }
      return props;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] getMassProperties failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`mass-properties-failed: ${String(err)}`);
    } finally {
      if (tip) {
        try {
          tip.delete?.();
        } catch {
          // ignore
        }
      }
    }
  },

  async exportAssemblyStl(parts: ExportPartDescriptor[]) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;
    const ocAny = oc as any;

    const baseShapes: any[] = [];
    const transformedShapes: any[] = [];
    let compound: any = null;
    let builder: any = null;
    let meshBuilder: any = null;
    let progressRange: any = null;

    try {
      for (const part of parts) {
        if (!part.features || part.features.length === 0) continue;

        const base = executeUpstreamChain(oc, part.features, part.sketches);
        baseShapes.push(base);

        // Apply world transform — identical pattern to booleanOp.
        const tx = part.transform;
        const isIdentity =
          !tx ||
          (tx.positionMm[0] === 0 &&
            tx.positionMm[1] === 0 &&
            tx.positionMm[2] === 0 &&
            tx.rotationDeg[0] === 0 &&
            tx.rotationDeg[1] === 0 &&
            tx.rotationDeg[2] === 0);

        if (isIdentity) {
          transformedShapes.push(base);
          continue;
        }

        const trsf = new oc.gp_Trsf_1();
        const origin = new oc.gp_Pnt_3(0, 0, 0);
        const axisX = new oc.gp_Dir_4(1, 0, 0);
        const axisY = new oc.gp_Dir_4(0, 1, 0);
        const axisZ = new oc.gp_Dir_4(0, 0, 1);
        const ax1X = new oc.gp_Ax1_2(origin, axisX);
        const ax1Y = new oc.gp_Ax1_2(origin, axisY);
        const ax1Z = new oc.gp_Ax1_2(origin, axisZ);
        const trsfRotZ = new oc.gp_Trsf_1();
        trsfRotZ.SetRotation_1(ax1Z, (tx.rotationDeg[2] * Math.PI) / 180);
        const trsfRotY = new oc.gp_Trsf_1();
        trsfRotY.SetRotation_1(ax1Y, (tx.rotationDeg[1] * Math.PI) / 180);
        const trsfRotX = new oc.gp_Trsf_1();
        trsfRotX.SetRotation_1(ax1X, (tx.rotationDeg[0] * Math.PI) / 180);
        const trsfTrans = new oc.gp_Trsf_1();
        const transVec = new oc.gp_Vec_4(
          tx.positionMm[0],
          tx.positionMm[1],
          tx.positionMm[2],
        );
        trsfTrans.SetTranslation_1(transVec);
        trsf.Multiply(trsfRotZ);
        trsf.Multiply(trsfRotY);
        trsf.Multiply(trsfRotX);
        trsf.Multiply(trsfTrans);

        const transformer = new oc.BRepBuilderAPI_Transform_2(
          base as never,
          trsf,
          true,
        );
        const transformed = transformer.Shape();
        transformedShapes.push(transformed);

        transformer.delete();
        transVec.delete();
        trsfTrans.delete();
        trsfRotX.delete();
        trsfRotY.delete();
        trsfRotZ.delete();
        ax1Z.delete();
        ax1Y.delete();
        ax1X.delete();
        axisZ.delete();
        axisY.delete();
        axisX.delete();
        origin.delete();
        trsf.delete();
      }

      if (transformedShapes.length === 0) {
        throw new Error(
          "stl-export-failed: no parts with features to export.",
        );
      }

      // Combine every transformed shape into a single compound so the
      // STL writer sees one coherent B-Rep.
      compound = new ocAny.TopoDS_Compound();
      builder = new ocAny.BRep_Builder();
      builder.MakeCompound(compound);
      for (const shape of transformedShapes) {
        builder.Add(compound, shape);
      }
      builder.delete();
      builder = null;

      // Triangulate the compound. Linear deflection 0.1 mm gives a
      // reasonable balance between file size and surface accuracy.
      meshBuilder = new ocAny.BRepMesh_IncrementalMesh_2(
        compound,
        0.1,
        false,
        0.5,
        true,
      );
      progressRange = new ocAny.Message_ProgressRange_1();
      meshBuilder.Perform(progressRange);
      progressRange.delete();
      progressRange = null;
      meshBuilder.delete();
      meshBuilder = null;

      // Write binary STL to the Emscripten virtual FS using the static
      // StlAPI.Write helper (third arg false = binary mode). Read the bytes
      // back as a Uint8Array, then clean up the temporary file.
      const stlPath = "/tmp/kineticad-export.stl";
      const writeOk = ocAny.StlAPI.Write(compound, stlPath, false);
      if (!writeOk) {
        throw new Error("stl-export-failed: StlAPI.Write returned false.");
      }

      const bytes: Uint8Array = ocAny.FS.readFile(stlPath);
      try {
        ocAny.FS.unlink(stlPath);
      } catch {
        // Non-fatal.
      }
      return bytes;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[CAD WORKER] exportAssemblyStl failed:", err);
      if (err instanceof Error) throw err;
      throw new Error(`stl-export-failed: ${String(err)}`);
    } finally {
      if (progressRange) {
        try {
          progressRange.delete();
        } catch { /* ignore */ }
      }
      if (meshBuilder) {
        try {
          meshBuilder.delete();
        } catch { /* ignore */ }
      }
      if (builder) {
        try {
          builder.delete();
        } catch { /* ignore */ }
      }
      if (compound) {
        try {
          compound.delete();
        } catch { /* ignore */ }
      }
      for (let i = 0; i < transformedShapes.length; i++) {
        if (transformedShapes[i] !== baseShapes[i]) {
          transformedShapes[i]?.delete?.();
        }
      }
      for (const s of baseShapes) {
        s?.delete?.();
      }
    }
  },

  async exportAssemblyMeshes(parts: ExportPartDescriptor[]) {
    await ensureKernel();
    if (!ocInstance) throw new Error("CAD kernel failed to initialise");
    const oc = ocInstance;

    // Per-part world-space tessellations for the mesh-format exporters
    // (GDML, OBJ). Unlike exportAssemblyStl this keeps parts separate, so
    // each one can carry its own name and material on the main thread.
    const results: MeshExportResult[] = [];
    const transferables: Transferable[] = [];

    for (const part of parts) {
      if (!part.features || part.features.length === 0) continue;

      let base: any = null;
      let transformed: any = null;
      try {
        base = executeUpstreamChain(oc, part.features, part.sketches);

        // Apply world transform — identical pattern to exportAssemblyStl.
        const tx = part.transform;
        const isIdentity =
          !tx ||
          (tx.positionMm[0] === 0 &&
            tx.positionMm[1] === 0 &&
            tx.positionMm[2] === 0 &&
            tx.rotationDeg[0] === 0 &&
            tx.rotationDeg[1] === 0 &&
            tx.rotationDeg[2] === 0);

        if (isIdentity) {
          transformed = base;
        } else {
          const trsf = new oc.gp_Trsf_1();
          const origin = new oc.gp_Pnt_3(0, 0, 0);
          const axisX = new oc.gp_Dir_4(1, 0, 0);
          const axisY = new oc.gp_Dir_4(0, 1, 0);
          const axisZ = new oc.gp_Dir_4(0, 0, 1);
          const ax1X = new oc.gp_Ax1_2(origin, axisX);
          const ax1Y = new oc.gp_Ax1_2(origin, axisY);
          const ax1Z = new oc.gp_Ax1_2(origin, axisZ);
          const trsfRotZ = new oc.gp_Trsf_1();
          trsfRotZ.SetRotation_1(ax1Z, (tx.rotationDeg[2] * Math.PI) / 180);
          const trsfRotY = new oc.gp_Trsf_1();
          trsfRotY.SetRotation_1(ax1Y, (tx.rotationDeg[1] * Math.PI) / 180);
          const trsfRotX = new oc.gp_Trsf_1();
          trsfRotX.SetRotation_1(ax1X, (tx.rotationDeg[0] * Math.PI) / 180);
          const trsfTrans = new oc.gp_Trsf_1();
          const transVec = new oc.gp_Vec_4(
            tx.positionMm[0],
            tx.positionMm[1],
            tx.positionMm[2],
          );
          trsfTrans.SetTranslation_1(transVec);
          trsf.Multiply(trsfRotZ);
          trsf.Multiply(trsfRotY);
          trsf.Multiply(trsfRotX);
          trsf.Multiply(trsfTrans);

          const transformer = new oc.BRepBuilderAPI_Transform_2(
            base as never,
            trsf,
            true,
          );
          transformed = transformer.Shape();

          transformer.delete();
          transVec.delete();
          trsfTrans.delete();
          trsfRotX.delete();
          trsfRotY.delete();
          trsfRotZ.delete();
          ax1Z.delete();
          ax1Y.delete();
          ax1X.delete();
          axisZ.delete();
          axisY.delete();
          axisX.delete();
          origin.delete();
          trsf.delete();
        }

        const tess = tessellateShape(oc, transformed);
        results.push({
          partId: part.partId,
          positions: tess.positions,
          indices: tess.indices,
        });
        transferables.push(tess.positions.buffer, tess.indices.buffer);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[CAD WORKER] exportAssemblyMeshes failed:", err);
        if (err instanceof Error) throw err;
        throw new Error(`mesh-export-failed: ${String(err)}`);
      } finally {
        if (transformed && transformed !== base) {
          try {
            transformed.delete?.();
          } catch { /* ignore */ }
        }
        if (base) {
          try {
            base.delete?.();
          } catch { /* ignore */ }
        }
      }
    }

    if (results.length === 0) {
      throw new Error("mesh-export-failed: no parts with features to export.");
    }
    return Comlink.transfer(results, transferables);
  },

  // ---- STEP import ----

  async importStep(fileBytes: Uint8Array, fileName?: string) {
    await ensureKernel();
    if (!ocInstance) throw new Error('CAD kernel failed to initialise');
    const oc = ocInstance;
    const ocAny = oc as any;
    const t0 = performance.now();

    // Derive a stem for fallback naming: strip the STEP extension and collapse
    // whitespace so '9132K11.step' becomes '9132K11', not '9132K11.step'.
    const fileStem = fileName
      ? (fileName.replace(/\.(step|stp)$/i, '').replace(/\s+/g, '_') || 'part')
      : 'part';

    const virtualPath = `/tmp/kineticad-step-import-${Date.now()}.step`;
    let cafReader: any = null;
    let doc: any = null;
    let docHandle: any = null;
    // Shapes returned directly by the reader (may be compounds).
    const rawShapes: any[] = [];
    // XCAF PRODUCT names in DFS order, aligned with TopExp_Explorer solid order.
    const xcafNames: string[] = [];

    // ------------------------------------------------------------------
    // extractLabelName -- permanently stubbed out. 16/05/2026
    //
    // opencascade.js 2.0.0-beta.94e2944 does not expose the APIs needed
    // to read a TDataStd_Name attribute from a TDF_Label:
    //
    //   - Handle_TDataStd_Name.DownCast is not present in the binding.
    //   - TDataStd_Name.Get_1 / Get_2 static methods are not present.
    //   - TDF_Label.FindAttribute_1 only accepts Handle_TDF_Attribute
    //     (the base handle); embind rejects Handle_TDataStd_Name_1 with
    //     a BindingError, and there is no overload that accepts the typed
    //     subclass handle directly.
    //   - TDF_Attribute (the type returned by Handle_TDF_Attribute.get())
    //     does not expose Get() in its binding, so duck-typing through the
    //     base handle is also structurally impossible.
    //
    // All eight candidate paths were exhausted in the xcaf-api-probe
    // script (scripts/src/xcaf-api-probe.ts). None are available.
    //
    // The documented behaviour is therefore to return an empty string
    // here and let the call sites fall back to filename-stem names.
    // ------------------------------------------------------------------
    function extractLabelName(_label: any): string {
      return '';
    }

    // ------------------------------------------------------------------
    // Depth-first walk of the XCAF label tree.  The traversal order matches
    // TopExp_Explorer SOLID enumeration on the compound shape, so out[j]
    // corresponds to solidShapes[j] after the explorer pass.
    //
    // Simple shapes push one name.  Assembly labels recurse into their
    // components.  If a component's referred prototype is itself an assembly,
    // we recurse again (handles nested sub-assemblies in files like 9132K11).
    //
    // All TDF_Label objects allocated by Value() are deleted in finally blocks
    // to prevent WASM heap leaks.
    // ------------------------------------------------------------------
    function walkLabel(label: any, out: string[], depth = 0): void {
      if (ocAny.XCAFDoc_ShapeTool.IsAssembly(label)) {
        const compLabels = new ocAny.TDF_LabelSequence_1();
        try {
          ocAny.XCAFDoc_ShapeTool.GetComponents(label, compLabels, false);
          const n: number = compLabels.Length();
          for (let j = 1; j <= n; j++) {
            const comp = compLabels.Value(j);
            const referred = new ocAny.TDF_Label();
            try {
              const hasReferred = ocAny.XCAFDoc_ShapeTool.GetReferredShape(
                comp,
                referred,
              );
              if (
                hasReferred &&
                !referred.IsNull() &&
                ocAny.XCAFDoc_ShapeTool.IsAssembly(referred)
              ) {
                // Sub-assembly: recurse depth-first so DFS order is preserved.
                if (STEP_NAME_DEBUG) {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[xcaf-walk] depth=${depth} isAssembly=true componentCount=${n}` +
                    ` referredHasName=false referredName=""` +
                    ` componentHasName=false componentName="" chosen="(sub-assembly, recursing)"`,
                  );
                }
                walkLabel(referred, out, depth + 1);
              } else {
                // Leaf part: prefer the referred prototype's name, then the
                // component instance name, then empty string (fallback applies).
                // Pre-compute both names so they can be used in the log and the push.
                const referredName =
                  hasReferred && !referred.IsNull() ? extractLabelName(referred) : '';
                const componentName = extractLabelName(comp);
                const chosen = referredName || componentName;
                if (STEP_NAME_DEBUG) {
                  // eslint-disable-next-line no-console
                  console.log(
                    `[xcaf-walk] depth=${depth} isAssembly=true componentCount=${n}` +
                    ` referredHasName=${!!referredName} referredName="${referredName}"` +
                    ` componentHasName=${!!componentName} componentName="${componentName}"` +
                    ` chosen="${chosen}"`,
                  );
                }
                out.push(chosen);
              }
            } finally {
              try { referred.delete(); } catch { /* ignore */ }
              try { comp.delete(); } catch { /* ignore */ }
            }
          }
        } finally {
          compLabels.delete();
        }
      } else {
        const name = extractLabelName(label);
        if (STEP_NAME_DEBUG) {
          // eslint-disable-next-line no-console
          console.log(
            `[xcaf-walk] depth=${depth} isAssembly=false componentCount=0` +
            ` referredHasName=false referredName=""` +
            ` componentHasName=${!!name} componentName="${name}" chosen="${name}"`,
          );
        }
        out.push(name);
      }
    }

    try {
      // eslint-disable-next-line no-console
      console.log('[step-debug] file size:', fileBytes.byteLength);
      oc.FS.writeFile(virtualPath, fileBytes);
      // eslint-disable-next-line no-console
      console.log('[step-debug] FS /tmp after write:', (oc.FS as any).readdir('/tmp'));

      // STEPCAFControl_Reader is used instead of STEPControl_Reader_1 so the
      // XCAF document tree is populated alongside the geometry.  The underlying
      // STEPControl_Reader is accessed via ChangeReader() for OneShape().
      cafReader = new ocAny.STEPCAFControl_Reader_1();
      const readStatus = cafReader.ReadFile(virtualPath);
      // eslint-disable-next-line no-console
      console.log('[step-debug] ReadFile status:', readStatus);

      // IFSelect_RetDone = 1 in the OCCT enum.  In some emscripten builds the
      // binding returns a plain integer; in others an object with .value.  We
      // accept either form so the check is robust across opencascade.js builds.
      const retDone = ocAny.IFSelect_ReturnStatus.IFSelect_RetDone;
      const retDoneNum: number =
        typeof retDone === 'number' ? retDone : (retDone as any)?.value ?? 1;
      const readStatusNum: number =
        typeof readStatus === 'number' ? readStatus : (readStatus as any)?.value ?? -1;
      if (readStatusNum !== retDoneNum) {
        throw new Error(
          `STEP ReadFile failed (status ${readStatusNum}) -- the file may be corrupt or use an unsupported STEP variant.`,
        );
      }

      const nRoots = cafReader.NbRootsForTransfer();
      // eslint-disable-next-line no-console
      console.log('[step-debug] NbRootsForTransfer:', nRoots);

      // Create a TDocStd_Document for XCAF name extraction.
      // TCollection_ExtendedString_2 takes (Standard_CString, isMultiByte).
      // Handle_TDocStd_Document_2(ptr) is used when the binding exposes it
      // (single-step from-pointer construction); falls back to _1() + reset().
      // eslint-disable-next-line no-console
      doc = new ocAny.TDocStd_Document(
        new ocAny.TCollection_ExtendedString_2('XCAF', false),
      );
      if (typeof ocAny.Handle_TDocStd_Document_2 !== 'undefined') {
        docHandle = new ocAny.Handle_TDocStd_Document_2(doc);
        // eslint-disable-next-line no-console
        console.log('[step-import] docHandle: used Handle_TDocStd_Document_2(doc)');
      } else {
        docHandle = new ocAny.Handle_TDocStd_Document_1();
        docHandle.reset(doc);
        // eslint-disable-next-line no-console
        console.log('[step-import] docHandle: used Handle_TDocStd_Document_1 + reset');
      }

      const progress = new ocAny.Message_ProgressRange_1();
      let transferred: boolean;
      try {
        transferred = cafReader.Transfer_1(docHandle, progress);
      } finally {
        progress.delete();
      }
      // eslint-disable-next-line no-console
      console.log('[step-debug] Transfer_1 returned:', transferred!);

      // Get the combined shape via the underlying STEPControl_Reader reference.
      // ChangeReader() returns a reference -- do not call .delete() on it.
      const underlyingReader = cafReader.ChangeReader();
      const nShapes = underlyingReader.NbShapes();
      // eslint-disable-next-line no-console
      console.log('[step-debug] NbShapes after transfer:', nShapes);

      // OneShape() combines all transferred roots into a single shape (a
      // COMPOUND when there are multiple bodies).  Prefer this over iterating
      // NbShapes()/Shape(i) which can return 0 even when geometry was
      // successfully transferred.
      const combined = underlyingReader.OneShape();
      const combinedIsNull = combined?.IsNull?.() ?? true;
      // eslint-disable-next-line no-console
      console.log('[step-debug] OneShape isNull:', combinedIsNull);
      // eslint-disable-next-line no-console
      console.log('[step-debug] OneShape ShapeType:', combinedIsNull ? 'NULL' : combined.ShapeType());

      // IMPORTANT: cafReader.delete() in the finally block frees internal OCCT
      // data that OneShape()/Shape(i) alias via reference.  Deep-copy each
      // shape NOW (while the reader is still alive) using BRepBuilderAPI_Copy
      // so rawShapes holds truly independent TopoDS_Shape instances.
      if (combined && !combined.IsNull?.()) {
        let copyBuilder: any = null;
        try {
          copyBuilder = new ocAny.BRepBuilderAPI_Copy_2(combined, true, false);
          rawShapes.push(copyBuilder.Shape());
        } finally {
          if (copyBuilder) copyBuilder.delete();
        }
      } else {
        // Fallback: iterate individual shapes.
        for (let i = 1; i <= nShapes; i++) {
          let copyBuilder: any = null;
          try {
            copyBuilder = new ocAny.BRepBuilderAPI_Copy_2(
              underlyingReader.Shape(i),
              true,
              false,
            );
            rawShapes.push(copyBuilder.Shape());
          } finally {
            if (copyBuilder) copyBuilder.delete();
          }
        }
      }

      // ------------------------------------------------------------------
      // XCAF name extraction: walk the document label tree depth-first.
      // The walk order matches TopExp_Explorer's SOLID enumeration so that
      // xcafNames[j] aligns with solidShapes[j] after the explorer pass.
      // Any failure here is non-fatal -- fallback names apply per solid.
      // ------------------------------------------------------------------
      {
        let shapeTool: any = null;
        const freeLabels = new ocAny.TDF_LabelSequence_1();
        try {
          shapeTool = ocAny.XCAFDoc_DocumentTool.ShapeTool(
            docHandle.get().Main(),
          );
          shapeTool.get().GetFreeShapes(freeLabels);
          const nFree: number = freeLabels.Length();
          if (STEP_NAME_DEBUG) {
            // Count how many root labels carry a name attribute before the walk.
            let rootsWithName = 0;
            for (let i = 1; i <= nFree; i++) {
              const lbl = freeLabels.Value(i);
              try { if (extractLabelName(lbl)) rootsWithName++; } finally {
                try { lbl.delete(); } catch { /* ignore */ }
              }
            }
            // eslint-disable-next-line no-console
            console.log(`[xcaf-roots] freeShapeCount=${nFree} rootsWithName=${rootsWithName}`);
          }
          for (let i = 1; i <= nFree; i++) {
            const label = freeLabels.Value(i);
            try {
              walkLabel(label, xcafNames);
            } finally {
              try { label.delete(); } catch { /* ignore */ }
            }
          }
          if (STEP_NAME_DEBUG) {
            const labelsWithName = xcafNames.filter(n => !!n).length;
            // eslint-disable-next-line no-console
            console.log(
              `[xcaf-summary] totalLabelsVisited=${xcafNames.length}` +
              ` labelsWithName=${labelsWithName} labelsEmpty=${xcafNames.length - labelsWithName}`,
            );
          }
        } catch (xcafErr) {
          // eslint-disable-next-line no-console
          console.warn(
            '[step-import] XCAF name walk failed -- fallback names will be used:',
            xcafErr,
          );
          xcafNames.length = 0;
        } finally {
          try { freeLabels.delete(); } catch { /* ignore */ }
          try { if (shapeTool) shapeTool.delete(); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[CAD WORKER] importStep read phase failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`step-import-failed: ${msg}`);
    } finally {
      if (cafReader) { try { cafReader.delete(); } catch { /* ignore */ } }
      if (docHandle) { try { docHandle.delete(); } catch { /* ignore */ } }
      if (doc) { try { doc.delete(); } catch { /* ignore */ } }
      try { oc.FS.unlink(virtualPath); } catch { /* ignore */ }
    }

    // Expand compound roots into their top-level solid children, so each
    // distinct body becomes a separate KinetiCAD part.
    const solidShapes: any[] = [];
    for (const raw of rawShapes) {
      const shapeType = raw.ShapeType();
      if (shapeType === ocAny.TopAbs_ShapeEnum.TopAbs_COMPOUND) {
        const before = solidShapes.length;

        // First pass: collect SOLID children.
        const expSolid = new ocAny.TopExp_Explorer_2(
          raw,
          ocAny.TopAbs_ShapeEnum.TopAbs_SOLID,
          ocAny.TopAbs_ShapeEnum.TopAbs_SHAPE,
        );
        try {
          while (expSolid.More()) {
            solidShapes.push(expSolid.Value());
            expSolid.Next();
          }
        } finally {
          expSolid.delete();
        }

        if (solidShapes.length === before) {
          // No solids found — fall back to SHELL (surface models).
          const expShell = new ocAny.TopExp_Explorer_2(
            raw,
            ocAny.TopAbs_ShapeEnum.TopAbs_SHELL,
            ocAny.TopAbs_ShapeEnum.TopAbs_SHAPE,
          );
          try {
            while (expShell.More()) {
              solidShapes.push(expShell.Value());
              expShell.Next();
            }
          } finally {
            expShell.delete();
          }
        }

        if (solidShapes.length === before) {
          // Compound had neither solids nor shells — treat it as one body.
          solidShapes.push(raw);
        }
      } else {
        solidShapes.push(raw);
      }
    }

    if (solidShapes.length === 0) {
      throw new Error('step-import-failed: no geometry found in the STEP file.');
    }

    // Assembly-level grounding: find the lowest Z across ALL parts first,
    // then apply a single uniform dz so relative positions are preserved.
    // Only lift if something is below Z=0; parts already above ground are
    // left where they are.
    {
      let assemblyZMin = Infinity;
      for (const s of solidShapes) {
        const bb = new ocAny.Bnd_Box_1();
        try {
          ocAny.BRepBndLib.Add(s, bb, false);
          const cMin = bb.CornerMin();
          const z: number = cMin.Z();
          cMin.delete();
          if (z < assemblyZMin) assemblyZMin = z;
        } finally {
          bb.delete();
        }
      }

      const dz = isFinite(assemblyZMin) && assemblyZMin < -0.001 ? -assemblyZMin : 0;

      if (dz > 0.001) {
        for (let k = 0; k < solidShapes.length; k++) {
          let groundTransformer: any = null;
          let groundCopier: any = null;
          try {
            const trsf = new ocAny.gp_Trsf_1();
            const vec = new ocAny.gp_Vec_4(0, 0, dz);
            trsf.SetTranslation_1(vec);
            vec.delete();
            groundTransformer = new ocAny.BRepBuilderAPI_Transform_2(solidShapes[k], trsf, true);
            trsf.delete();
            groundCopier = new ocAny.BRepBuilderAPI_Copy_2(groundTransformer.Shape(), true, false);
            solidShapes[k] = groundCopier.Shape();
          } finally {
            if (groundTransformer) groundTransformer.delete();
            if (groundCopier) groundCopier.delete();
          }
        }
      }
    }

    const results: import('./types').ImportedPart[] = [];

    for (let j = 0; j < solidShapes.length; j++) {
      const shape = solidShapes[j];

      // Unique key for this import session.
      const shapeId =
        `step-${Date.now()}-${j}-${Math.random().toString(36).slice(2, 8)}`;

      // Register in the worker-side registry for later STEP re-export.
      importedShapeRegistry.set(shapeId, shape);

      // Tessellate with full topology so edges/faces are highlight-able and
      // the part is pickable for mates.
      const mesh = buildMesh(oc, shape);

      // Compute bounding box for the Y-up / Z-up orientation hint shown
      // in the import toast.
      let minArr: [number, number, number] = [0, 0, 0];
      let maxArr: [number, number, number] = [0, 0, 0];
      const bbox = new ocAny.Bnd_Box_1();
      try {
        ocAny.BRepBndLib.Add(shape, bbox, false);
        const minPnt = bbox.CornerMin();
        const maxPnt = bbox.CornerMax();
        minArr = [minPnt.X(), minPnt.Y(), minPnt.Z()];
        maxArr = [maxPnt.X(), maxPnt.Y(), maxPnt.Z()];
        minPnt.delete();
        maxPnt.delete();
      } finally {
        bbox.delete();
      }

      results.push({
        shapeId,
        name: xcafNames[j] || `${fileStem}_${String(j + 1).padStart(2, '0')}`,
        tessellated: mesh,
        boundingBox: { min: minArr, max: maxArr },
      });
    }

    const durationMs = Math.round(performance.now() - t0);
    // eslint-disable-next-line no-console
    console.log('[step-import]', {
      partCount: results.length,
      fileSizeBytes: fileBytes.byteLength,
      durationMs,
    });

    // Transfer all TypedArray buffers in one Comlink call.
    const allTransferables: Transferable[] = [];
    for (const r of results) {
      allTransferables.push(...collectTransferables(r.tessellated));
    }
    return Comlink.transfer(results, allTransferables);
  },

  // ---- STEP export ----

  async exportAssemblyStep(parts: ExportPartDescriptor[]) {
    await ensureKernel();
    if (!ocInstance) throw new Error('CAD kernel failed to initialise');
    const oc = ocInstance;
    const ocAny = oc as any;

    const baseShapes: any[] = [];
    const transformedShapes: any[] = [];
    let writer: any = null;
    let compound: any = null;
    let builder: any = null;
    const t0 = performance.now();

    try {
      for (const part of parts) {
        if (!part.features || part.features.length === 0) continue;

        const base = executeUpstreamChain(oc, part.features, part.sketches);
        baseShapes.push(base);

        // Apply world transform — identical pattern to exportAssemblyStl.
        const tx = part.transform;
        const isIdentity =
          !tx ||
          (tx.positionMm[0] === 0 &&
            tx.positionMm[1] === 0 &&
            tx.positionMm[2] === 0 &&
            tx.rotationDeg[0] === 0 &&
            tx.rotationDeg[1] === 0 &&
            tx.rotationDeg[2] === 0);

        if (isIdentity) {
          transformedShapes.push(base);
          continue;
        }

        const trsf = new oc.gp_Trsf_1();
        const origin = new oc.gp_Pnt_3(0, 0, 0);
        const axisX = new oc.gp_Dir_4(1, 0, 0);
        const axisY = new oc.gp_Dir_4(0, 1, 0);
        const axisZ = new oc.gp_Dir_4(0, 0, 1);
        const ax1X = new oc.gp_Ax1_2(origin, axisX);
        const ax1Y = new oc.gp_Ax1_2(origin, axisY);
        const ax1Z = new oc.gp_Ax1_2(origin, axisZ);
        const trsfRotZ = new oc.gp_Trsf_1();
        trsfRotZ.SetRotation_1(ax1Z, (tx.rotationDeg[2] * Math.PI) / 180);
        const trsfRotY = new oc.gp_Trsf_1();
        trsfRotY.SetRotation_1(ax1Y, (tx.rotationDeg[1] * Math.PI) / 180);
        const trsfRotX = new oc.gp_Trsf_1();
        trsfRotX.SetRotation_1(ax1X, (tx.rotationDeg[0] * Math.PI) / 180);
        const trsfTrans = new oc.gp_Trsf_1();
        const transVec = new oc.gp_Vec_4(
          tx.positionMm[0],
          tx.positionMm[1],
          tx.positionMm[2],
        );
        trsfTrans.SetTranslation_1(transVec);
        trsf.Multiply(trsfRotZ);
        trsf.Multiply(trsfRotY);
        trsf.Multiply(trsfRotX);
        trsf.Multiply(trsfTrans);

        const transformer = new oc.BRepBuilderAPI_Transform_2(
          base as never,
          trsf,
          true,
        );
        const transformed = transformer.Shape();
        transformedShapes.push(transformed);

        transformer.delete();
        transVec.delete();
        trsfTrans.delete();
        trsfRotX.delete();
        trsfRotY.delete();
        trsfRotZ.delete();
        ax1Z.delete();
        ax1Y.delete();
        ax1X.delete();
        axisZ.delete();
        axisY.delete();
        axisX.delete();
        origin.delete();
        trsf.delete();
      }

      if (transformedShapes.length === 0) {
        throw new Error('step-export-failed: no parts with features to export.');
      }

      // Combine all transformed shapes into a single compound.
      compound = new ocAny.TopoDS_Compound();
      builder = new ocAny.BRep_Builder();
      builder.MakeCompound(compound);
      for (const shape of transformedShapes) {
        builder.Add(compound, shape);
      }
      builder.delete();
      builder = null;

      // Transfer the compound to STEP AP214 format.
      writer = new ocAny.STEPControl_Writer_1();
      const progress = new ocAny.Message_ProgressRange_1();
      let transferStatus: any;
      try {
        transferStatus = writer.Transfer(
          compound,
          ocAny.STEPControl_StepModelType.STEPControl_AsIs,
          true,
          progress,
        );
      } finally {
        progress.delete();
      }

      const retDone = ocAny.IFSelect_ReturnStatus.IFSelect_RetDone;
      if (transferStatus !== retDone) {
        throw new Error(
          'step-export-failed: Transfer() returned a non-done status.',
        );
      }

      const stepPath = '/tmp/kineticad-export.step';
      const writeStatus = writer.Write(stepPath);
      if (writeStatus !== retDone) {
        throw new Error(
          'step-export-failed: Write() returned a non-done status.',
        );
      }

      const bytes: Uint8Array = ocAny.FS.readFile(stepPath);
      try { ocAny.FS.unlink(stepPath); } catch { /* ignore */ }

      const durationMs = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.log('[step-export]', {
        partCount: transformedShapes.length,
        fileSizeBytes: bytes.byteLength,
        durationMs,
      });

      return Comlink.transfer(bytes, [bytes.buffer]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[CAD WORKER] exportAssemblyStep failed:', err);
      if (err instanceof Error) throw err;
      throw new Error(`step-export-failed: ${String(err)}`);
    } finally {
      if (writer) { try { writer.delete(); } catch { /* ignore */ } }
      if (builder) { try { builder.delete(); } catch { /* ignore */ } }
      if (compound) { try { compound.delete(); } catch { /* ignore */ } }
      for (let i = 0; i < transformedShapes.length; i++) {
        if (transformedShapes[i] !== baseShapes[i]) {
          transformedShapes[i]?.delete?.();
        }
      }
      for (const s of baseShapes) {
        s?.delete?.();
      }
    }
  },
};

// Diagnostic: log the path array of every incoming Comlink call so the bad
// path that triggers the Array.reduce TypeError can be identified at runtime.
// Set COMLINK_TRACE to false once the offending call site is found.
// Added 16/05/2026.
const COMLINK_TRACE = true;
if (COMLINK_TRACE) {
  self.addEventListener('message', (msg) => {
    const d = (msg as MessageEvent).data;
    if (d && Array.isArray(d.path)) {
      // eslint-disable-next-line no-console
      console.log('[comlink-in]', { path: d.path, type: d.type });
    }
  });
}

Comlink.expose(api);
