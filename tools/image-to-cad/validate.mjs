// Structural validator for KinetiCAD model JSON (persist version 9).
//
// Mirrors the checks the app's Load button performs (envelope shape, version,
// assembly present) and adds the referential and geometric rules that make a
// model actually regenerate: unique ids, sketch/feature wiring, first-feature
// new-body, single-closed-profile sketches, finite dimensions, mate part
// references and anchor arithmetic.
//
// Usage:  node validate.mjs <model.json>
// Import: import { validateModel } from './validate.mjs'
//         validateModel(doc) -> { errors: string[], warnings: string[] }

const MATERIALS = new Set([
  'aluminium-6061', 'steel-1018', 'brass-c36000', 'titanium-grade5',
  'nylon-6', 'pla', 'abs', 'acrylic',
]);
const PLANES = new Set(['XY', 'XZ', 'YZ']);
const EXTRUDE_DIRECTIONS = new Set(['forward', 'backward', 'symmetric']);
const EXTRUDE_MODES = new Set(['new-body', 'add', 'subtract']);
const REVOLVE_AXES = new Set(['X', 'Y', 'Z']);
const PERSIST_VERSION = 9;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);

export function validateModel(doc) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (typeof doc !== 'object' || doc === null) {
    return { errors: ['document is not an object'], warnings };
  }
  if (doc.version !== PERSIST_VERSION) {
    err(`version must be ${PERSIST_VERSION}, got ${JSON.stringify(doc.version)}`);
  }
  const state = doc.state;
  if (!state || typeof state !== 'object') {
    return { errors: [...errors, 'missing "state" object'], warnings };
  }
  const asm = state.assembly;
  if (!asm || typeof asm !== 'object') {
    return { errors: [...errors, 'missing "state.assembly"'], warnings };
  }

  // --- simulation block ---
  const sim = state.simulation;
  if (!sim || typeof sim !== 'object') {
    err('missing "state.simulation"');
  } else {
    if (!isVec(sim.gravity, 3)) err('simulation.gravity must be [x,y,z] numbers');
    if (!isNum(sim.timeStepMs) || sim.timeStepMs <= 0) err('simulation.timeStepMs must be > 0');
    if (sim.running !== false) warn('simulation.running should be false in a saved model');
  }

  // --- parts ---
  if (!Array.isArray(asm.parts) || asm.parts.length === 0) {
    return { errors: [...errors, 'assembly.parts must be a non-empty array'], warnings };
  }
  const ids = new Set();
  const uniqueId = (id, what) => {
    if (typeof id !== 'string' || id === '') { err(`${what} has missing/empty id`); return; }
    if (ids.has(id)) err(`duplicate id "${id}" (${what})`);
    ids.add(id);
  };

  const partIds = new Set();
  for (const part of asm.parts) {
    const p = `part "${part?.name ?? part?.id ?? '?'}"`;
    uniqueId(part.id, p);
    partIds.add(part.id);
    if (typeof part.name !== 'string' || !part.name) err(`${p}: missing name`);
    if (part.visible !== true && part.visible !== false) err(`${p}: visible must be boolean`);
    if (!MATERIALS.has(part.materialId)) {
      warn(`${p}: unknown materialId "${part.materialId}" (app falls back to aluminium)`);
    }
    const tx = part.transform;
    if (!tx || !isVec(tx.positionMm, 3) || !isVec(tx.rotationDeg, 3)) {
      err(`${p}: transform must have positionMm[3] and rotationDeg[3]`);
    }

    // sketches
    const sketchIds = new Set();
    if (!Array.isArray(part.sketches)) { err(`${p}: sketches must be an array`); continue; }
    for (const sk of part.sketches) {
      const s = `${p} sketch "${sk?.id ?? '?'}"`;
      uniqueId(sk.id, s);
      sketchIds.add(sk.id);
      if (!PLANES.has(sk.plane)) err(`${s}: plane must be XY|XZ|YZ`);
      if (!Array.isArray(sk.primitives) || sk.primitives.length === 0) {
        err(`${s}: primitives must be non-empty`); continue;
      }
      const closed = sk.primitives.filter((pr) => pr.type === 'circle' || pr.type === 'rectangle');
      if (closed.length > 0 && sk.primitives.length > 1) {
        err(`${s}: a circle/rectangle must be the only primitive in its sketch (one closed profile per sketch)`);
      }
      for (const pr of sk.primitives) {
        switch (pr.type) {
          case 'circle':
            if (!isVec(pr.centre, 2) || !isNum(pr.radius) || pr.radius <= 0)
              err(`${s}: bad circle (centre[2], radius>0)`);
            break;
          case 'rectangle':
            if (!isVec(pr.corner, 2) || !isNum(pr.width) || !isNum(pr.height) || pr.width <= 0 || pr.height <= 0)
              err(`${s}: bad rectangle (corner[2], width>0, height>0)`);
            break;
          case 'line':
            if (!isVec(pr.start, 2) || !isVec(pr.end, 2)) err(`${s}: bad line`);
            break;
          case 'arc':
            if (!isVec(pr.centre, 2) || !isNum(pr.radius) || pr.radius <= 0 ||
                !isNum(pr.startAngle) || !isNum(pr.endAngle))
              err(`${s}: bad arc`);
            break;
          default:
            err(`${s}: unknown primitive type "${pr.type}"`);
        }
      }
    }

    // features
    if (!Array.isArray(part.features) || part.features.length === 0) {
      err(`${p}: features must be non-empty (parts need geometry)`); continue;
    }
    const consumed = new Map();
    part.features.forEach((f, i) => {
      const fd = `${p} feature "${f?.id ?? '?'}"`;
      uniqueId(f.id, fd);
      if (f.type === 'extrude') {
        if (!sketchIds.has(f.sketchId)) err(`${fd}: sketchId "${f.sketchId}" not found in this part`);
        consumed.set(f.sketchId, (consumed.get(f.sketchId) ?? 0) + 1);
        if (!isNum(f.depthMm) || f.depthMm <= 0) err(`${fd}: depthMm must be > 0`);
        if (!EXTRUDE_DIRECTIONS.has(f.direction)) err(`${fd}: bad direction`);
        if (!EXTRUDE_MODES.has(f.extrudeMode)) err(`${fd}: bad extrudeMode`);
        if (i === 0 && f.extrudeMode !== 'new-body')
          err(`${fd}: a part's first feature must be extrudeMode "new-body"`);
      } else if (f.type === 'revolve') {
        if (!sketchIds.has(f.sketchId)) err(`${fd}: sketchId "${f.sketchId}" not found in this part`);
        consumed.set(f.sketchId, (consumed.get(f.sketchId) ?? 0) + 1);
        if (!REVOLVE_AXES.has(f.axis)) err(`${fd}: bad revolve axis`);
        if (!isNum(f.angleDeg) || f.angleDeg <= 0 || f.angleDeg > 360)
          err(`${fd}: angleDeg must be in (0, 360]`);
        if (i === 0 && 'extrudeMode' in f) warn(`${fd}: revolve does not take extrudeMode`);
      } else if (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'hole') {
        warn(`${fd}: ${f.type} targets topology ids that only exist after regen — generated models should avoid it`);
      } else {
        err(`${fd}: unknown feature type "${f.type}"`);
      }
    });
    for (const [sid, n] of consumed) {
      if (n > 1) warn(`${p}: sketch "${sid}" consumed by ${n} features`);
    }
    for (const sid of sketchIds) {
      if (!consumed.has(sid)) warn(`${p}: sketch "${sid}" is not used by any feature`);
    }
  }

  // --- ground part ---
  if (!partIds.has(asm.groundPartId)) {
    err(`groundPartId "${asm.groundPartId}" does not match any part`);
  }

  // --- mates ---
  if (!Array.isArray(asm.mates)) err('assembly.mates must be an array');
  const partById = new Map(asm.parts.map((p) => [p.id, p]));
  const checkPivot = (m, pv, label, planar = false) => {
    if (!pv || (pv.kind !== 'edge' && pv.kind !== 'face')) { err(`${m}: ${label}.kind must be edge|face`); return; }
    const refKey = pv.kind === 'edge' ? 'edgeId' : 'faceId';
    if (typeof pv[refKey] !== 'string' || !pv[refKey]) err(`${m}: ${label}.${refKey} missing`);
    if (!planar && !isVec(pv.localPoint, 3)) err(`${m}: ${label}.localPoint must be [x,y,z]`);
  };
  for (const mate of asm.mates ?? []) {
    const m = `mate "${mate?.name ?? mate?.id ?? '?'}"`;
    uniqueId(mate.id, m);
    if (!partIds.has(mate.partA)) err(`${m}: partA "${mate.partA}" not found`);
    if (!partIds.has(mate.partB)) err(`${m}: partB "${mate.partB}" not found`);
    if (mate.partA === mate.partB) err(`${m}: partA and partB must differ`);
    switch (mate.type) {
      case 'revolute':
      case 'prismatic': {
        checkPivot(m, mate.pivotA, 'pivotA');
        checkPivot(m, mate.pivotB, 'pivotB');
        if (!isVec(mate.axisLocal, 3) || mate.axisLocal.every((v) => v === 0))
          err(`${m}: axisLocal must be a non-zero [x,y,z]`);
        // anchor arithmetic (only meaningful for unrotated parts)
        const a = partById.get(mate.partA);
        const b = partById.get(mate.partB);
        if (a && b && isVec(mate.pivotA?.localPoint, 3) && isVec(mate.pivotB?.localPoint, 3) &&
            isVec(a.transform?.positionMm, 3) && isVec(b.transform?.positionMm, 3) &&
            a.transform.rotationDeg?.every((v) => v === 0) &&
            b.transform.rotationDeg?.every((v) => v === 0)) {
          for (let i = 0; i < 3; i++) {
            const wa = a.transform.positionMm[i] + mate.pivotA.localPoint[i];
            const wb = b.transform.positionMm[i] + mate.pivotB.localPoint[i];
            if (Math.abs(wa - wb) > 0.01) {
              err(`${m}: anchors disagree in world space on axis ${'XYZ'[i]} ` +
                  `(partA→${wa.toFixed(2)}mm vs partB→${wb.toFixed(2)}mm)`);
              break;
            }
          }
        }
        break;
      }
      case 'spherical':
        checkPivot(m, mate.pivotA, 'pivotA');
        checkPivot(m, mate.pivotB, 'pivotB');
        break;
      case 'fixed':
        break;
      case 'planar':
        checkPivot(m, mate.pivotA, 'pivotA', true);
        checkPivot(m, mate.pivotB, 'pivotB', true);
        warn(`${m}: planar mates do not actuate in simulation (Rapier 0.12 limitation)`);
        break;
      default:
        err(`${m}: unknown mate type "${mate.type}"`);
    }
  }

  return { errors, warnings };
}

// ---- CLI ----
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node validate.mjs <model.json>');
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const { errors, warnings } = validateModel(doc);
  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const e of errors) console.log(`ERROR ${e}`);
  console.log(errors.length === 0 ? `VALID (${warnings.length} warnings)` : `INVALID (${errors.length} errors)`);
  process.exit(errors.length === 0 ? 0 : 1);
}
