import { lazy, Suspense, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Download, Loader2, Upload } from 'lucide-react';
import { setImportedShapeMesh } from '@/cad/importedShapeCache';
import { getCadKernel } from '@/cad/cadClient';
import { buildGdml } from '@/cad/exporters/gdml';
import { buildObj } from '@/cad/exporters/obj';
import type { ExportMeshPart } from '@/cad/exporters/meshExport';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toaster } from '@/components/ui/sonner';
import { useKinetiCADStore } from '@/state/store';
import type { MateType } from '@/state/store';
import PlanePicker from '@/components/PlanePicker';
import SketchToolbar from '@/components/SketchToolbar';
import SketchCursor from '@/components/SketchCursor';
import SketchInspector from '@/components/inspectors/SketchInspector';
import FeatureInspector from '@/components/inspectors/FeatureInspector';
import PartInspector from '@/components/inspectors/PartInspector';
import BooleanInspector from '@/components/inspectors/BooleanInspector';
import MateInspector from '@/components/inspectors/MateInspector';
import PartsPanelItem from '@/components/PartsPanelItem';
import MatesPanelItem from '@/components/MatesPanelItem';
import NewPartButton from '@/components/NewPartButton';
import type { CardinalPlane } from '@/sketch/plane';
import type {
  BooleanFeature,
  BooleanOperation,
  Feature,
  Mate,
  Part,
  SketchPlane,
} from '@/state/schemas';

const Scene = lazy(() => import('@/three/Scene'));

export default function Modeller() {
  const assembly = useKinetiCADStore((s) => s.assembly);
  const sketchSession = useKinetiCADStore((s) => s.sketchSession);
  const beginSketch = useKinetiCADStore((s) => s.beginSketch);
  const selection = useKinetiCADStore((s) => s.selection);
  const featureEditor = useKinetiCADStore((s) => s.featureEditor);
  const booleanEditor = useKinetiCADStore((s) => s.booleanEditor);
  const mateEditor = useKinetiCADStore((s) => s.mateEditor);
  const selectPart = useKinetiCADStore((s) => s.selectPart);
  const selectSketch = useKinetiCADStore((s) => s.selectSketch);
  const selectFeature = useKinetiCADStore((s) => s.selectFeature);
  const selectBoolean = useKinetiCADStore((s) => s.selectBoolean);
  const selectMate = useKinetiCADStore((s) => s.selectMate);
  const beginEditFeature = useKinetiCADStore((s) => s.beginEditFeature);
  const beginCreateBoolean = useKinetiCADStore((s) => s.beginCreateBoolean);
  const beginEditBoolean = useKinetiCADStore((s) => s.beginEditBoolean);
  const beginCreateMate = useKinetiCADStore((s) => s.beginCreateMate);
  const beginEditMate = useKinetiCADStore((s) => s.beginEditMate);
  const clearSelection = useKinetiCADStore((s) => s.clearSelection);

  const addImportedStepPart = useKinetiCADStore((s) => s.addImportedStepPart);

  const [planePickerOpen, setPlanePickerOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importingStep, setImportingStep] = useState(false);
  const [exportingStep, setExportingStep] = useState(false);
  const [exportingMesh, setExportingMesh] = useState(false);
  const stepFileInputRef = useRef<HTMLInputElement>(null);
  const modelFileInputRef = useRef<HTMLInputElement>(null);

  const handleExportStl = async () => {
    const partsWithFeatures = assembly.parts.filter(
      (p) => p.features && p.features.length > 0,
    );
    if (partsWithFeatures.length === 0) {
      toast.error('Nothing to export. Add at least one feature first.');
      return;
    }
    setExporting(true);
    const t0 = performance.now();
    try {
      const kernel = await getCadKernel();
      const bytes = await kernel.exportAssemblyStl(
        partsWithFeatures.map((p) => ({
          partId: p.id,
          features: p.features,
          sketches: p.sketches,
          transform: p.transform,
        })),
      );
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'model/stl' });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const filename =
        `kineticad-export-` +
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
        `.stl`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      const durationMs = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.log('[stl-export]', {
        partCount: partsWithFeatures.length,
        fileSizeBytes: bytes.byteLength,
        durationMs,
      });
      toast.success('STL downloaded');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[stl-export] failed:', err);
      toast.error('Export failed. Check the console for details.');
    } finally {
      setExporting(false);
    }
  };
  const handleExportMesh = async (format: 'gdml' | 'obj') => {
    const partsWithFeatures = assembly.parts.filter(
      (p) => p.features && p.features.length > 0,
    );
    if (partsWithFeatures.length === 0) {
      toast.error('Nothing to export. Add at least one feature first.');
      return;
    }
    setExportingMesh(true);
    const t0 = performance.now();
    try {
      const kernel = await getCadKernel();
      const meshes = await kernel.exportAssemblyMeshes(
        partsWithFeatures.map((p) => ({
          partId: p.id,
          features: p.features,
          sketches: p.sketches,
          transform: p.transform,
        })),
      );
      // Join worker meshes back to names/materials via partId.
      const byId = new Map(partsWithFeatures.map((p) => [p.id, p]));
      const exportParts: ExportMeshPart[] = meshes.map((m) => {
        const part = byId.get(m.partId);
        return {
          name: part?.name ?? m.partId,
          materialId: part?.materialId ?? 'aluminium-6061',
          positions: m.positions,
          indices: m.indices,
        };
      });

      let content: string;
      let totalTriangles: number;
      let degenerateDropped: number;
      if (format === 'gdml') {
        const r = buildGdml(exportParts);
        content = r.xml;
        totalTriangles = r.totalTriangles;
        degenerateDropped = r.degenerateDropped;
      } else {
        const r = buildObj(exportParts);
        content = r.text;
        totalTriangles = r.totalTriangles;
        degenerateDropped = r.degenerateDropped;
      }
      const blob = new Blob([content], {
        type: format === 'gdml' ? 'application/xml' : 'text/plain',
      });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const filename =
        `kineticad-export-` +
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
        `.${format}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      const durationMs = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.log(`[${format}-export]`, {
        partCount: exportParts.length,
        triangles: totalTriangles,
        degenerateDropped,
        fileSizeBytes: blob.size,
        durationMs,
      });
      toast.success(
        format === 'gdml' ? 'GDML (Geant4) downloaded' : 'OBJ downloaded',
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[${format}-export] failed:`, err);
      toast.error('Export failed. Check the console for details.');
    } finally {
      setExportingMesh(false);
    }
  };

  const handleImportStep = async (file: File) => {
    setImportingStep(true);
    const t0 = performance.now();
    try {
      const kernel = await getCadKernel();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const imported = await kernel.importStep(bytes, file.name);
      if (imported.length === 0) {
        toast.error('No geometry found in the STEP file.');
        return;
      }
      // Cache tessellated meshes on the main thread so the regen pipeline
      // can display each imported part without a worker round-trip.
      for (const part of imported) {
        setImportedShapeMesh(part.shapeId, part.tessellated);
      }
      // The worker supplies the name directly from the XCAF document tree
      // (or a file-stem fallback).  No local name derivation needed here.
      for (let i = 0; i < imported.length; i++) {
        addImportedStepPart(imported[i].name, imported[i].shapeId);
      }
      const durationMs = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.log('[step-import]', {
        fileName: file.name,
        fileSizeBytes: file.size,
        partCount: imported.length,
        durationMs,
      });
      const partCount = imported.length;
      toast.success(
        `${partCount} part${partCount === 1 ? '' : 's'} imported at origin. ` +
        'If the part appears sideways, rotate -90° around X in the inspector.',
        { duration: 6000 },
      );
      // Restore canvas focus so OrbitControls regains pointer events immediately
      // after the file-picker dialog closes.
      requestAnimationFrame(() => {
        const canvas = document.querySelector('canvas');
        canvas?.focus();
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[step-import] failed:', err);
      toast.error('Import failed. Check the console for details.');
    } finally {
      setImportingStep(false);
    }
  };

  const onStepFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-uploading the same file fires onChange again.
    e.target.value = '';
    if (file) handleImportStep(file);
  };

  const handleSaveModel = () => {
    // Read directly from localStorage — the persist middleware writes the
    // exact { state, version } format the seed system uses, so no
    // re-serialisation is needed.
    const raw = localStorage.getItem('kineticad-state');
    if (!raw) {
      toast.error('Nothing to save — no model state found.');
      return;
    }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const filename =
      `kineticad-model-` +
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
      `.json`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleLoadModel = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('version' in parsed) ||
          !('state' in parsed)
        ) {
          toast.error('Invalid model file — not a KinetiCAD model.');
          return;
        }
        const p = parsed as { version: unknown; state: unknown };
        // Accept v8 and v9. v8 files are migrated to v9 automatically on
        // load via the store's migrate function. All earlier versions are
        // rejected: the migration chain before v8 is not guaranteed safe.
        if (p.version !== 8 && p.version !== 9) {
          toast.error(
            `Version mismatch — file is version ${String(p.version)}, app expects version 8 or 9.`,
          );
          return;
        }
        if (
          typeof p.state !== 'object' ||
          p.state === null ||
          !('assembly' in (p.state as object))
        ) {
          toast.error('Invalid model file — missing assembly data.');
          return;
        }
        // Reuse exactly the seed-loader mechanism: write the raw JSON into
        // the same localStorage key and reload so the workers rebuild cleanly.
        localStorage.setItem('kineticad-state', text);
        location.reload();
      } catch {
        toast.error('Failed to read model file — invalid JSON.');
      }
    };
    reader.readAsText(file);
  };

  const onModelFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) handleLoadModel(file);
  };

  const handleExportStep = async () => {
    const partsWithFeatures = assembly.parts.filter(
      (p) => p.features && p.features.length > 0,
    );
    if (partsWithFeatures.length === 0) {
      toast.error('Nothing to export. Add at least one feature first.');
      return;
    }
    setExportingStep(true);
    const t0 = performance.now();
    try {
      const kernel = await getCadKernel();
      const bytes = await kernel.exportAssemblyStep(
        partsWithFeatures.map((p) => ({
          partId: p.id,
          features: p.features,
          sketches: p.sketches,
          transform: p.transform,
        })),
      );
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: 'application/STEP',
      });
      const url = URL.createObjectURL(blob);
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const filename =
        `kineticad-export-` +
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
        `.step`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      const durationMs = Math.round(performance.now() - t0);
      // eslint-disable-next-line no-console
      console.log('[step-export]', {
        partCount: partsWithFeatures.length,
        fileSizeBytes: bytes.byteLength,
        durationMs,
      });
      toast.success('STEP file downloaded');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[step-export] failed:', err);
      toast.error('Export failed. Check the console for details.');
    } finally {
      setExportingStep(false);
    }
  };

  // When the user asks to delete a part that's referenced by booleans we
  // surface a small confirmation so they understand the cascade. The pending
  // partId doubles as the modal's open flag.
  const [cascadePartId, setCascadePartId] = useState<string | null>(null);

  const handlePlanePicked = (plane: CardinalPlane) => {
    setPlanePickerOpen(false);
    beginSketch(plane);
  };

  const onPartClick = (partId: string) => {
    selectPart(partId);
  };
  const onSketchClick = (partId: string, sketchId: string) => {
    selectSketch(partId, sketchId);
  };
  const onFeatureClick = (partId: string, featureId: string) => {
    // Selecting a feature also opens the editor on it, per the spec.
    selectFeature(partId, featureId);
    beginEditFeature(partId, featureId);
  };
  const onBooleanClick = (booleanId: string) => {
    selectBoolean(booleanId);
    beginEditBoolean(booleanId);
  };
  const onMateClick = (mateId: string) => {
    selectMate(mateId);
    beginEditMate(mateId);
  };

  const canCreateBoolean =
    assembly.parts.length >= 2 && !sketchSession.active && !featureEditor.open;
  // Mate creation needs ≥2 parts AND no other modal editor open. Picking a
  // boolean while a mate-editor is open would be confusing — guard that too.
  const canCreateMate =
    assembly.parts.length >= 2 &&
    !sketchSession.active &&
    !featureEditor.open &&
    !booleanEditor.open &&
    !mateEditor.open;

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Top Toolbar */}
      <header className="flex items-center gap-2 px-3 h-11 border-b border-border bg-card shrink-0 select-none">
        <span className="font-technical text-xs font-semibold tracking-widest uppercase text-[#FF6B1A]">
          KinetiCAD
        </span>
        <div className="w-px h-5 bg-border mx-1" />

        {sketchSession.active ? (
          <SketchToolbar />
        ) : (
          <>
            <ToolbarGroup label="Sketch">
              <ToolbarBtn
                icon="▭"
                label="New Sketch"
                onClick={() => setPlanePickerOpen(true)}
                testId="new-sketch"
              />
              <ToolbarBtn icon="╱" label="Line" disabled />
              <ToolbarBtn icon="○" label="Circle" disabled />
              <ToolbarBtn icon="□" label="Rectangle" disabled />
            </ToolbarGroup>

            <div className="w-px h-5 bg-border mx-1" />

            <ToolbarGroup label="Features">
              <ToolbarBtn icon="⬆" label="Extrude" disabled />
              <ToolbarBtn icon="↻" label="Revolve" disabled />
              <ToolbarBtn icon="◎" label="Hole" disabled />
            </ToolbarGroup>

            <div className="w-px h-5 bg-border mx-1" />

            <ToolbarGroup label="Boolean">
              <ToolbarBtn
                icon="∪"
                label="Union"
                disabled={!canCreateBoolean}
                onClick={() => beginCreateBoolean('union')}
                testId="boolean-union"
              />
              <ToolbarBtn
                icon="−"
                label="Subtract"
                disabled={!canCreateBoolean}
                onClick={() => beginCreateBoolean('subtract')}
                testId="boolean-subtract"
              />
              <ToolbarBtn
                icon="∩"
                label="Intersect"
                disabled={!canCreateBoolean}
                onClick={() => beginCreateBoolean('intersect')}
                testId="boolean-intersect"
              />
            </ToolbarGroup>

            <div className="w-px h-5 bg-border mx-1" />

            <ToolbarGroup label="Mate">
              {(
                [
                  ['revolute', '⊙', 'Revolute'],
                  ['prismatic', '↔', 'Prismatic'],
                  ['spherical', '●', 'Spherical'],
                  ['fixed', '⊞', 'Fixed'],
                  ['planar', '║', 'Planar'],
                ] as Array<[MateType, string, string]>
              ).map(([type, icon, label]) => (
                <ToolbarBtn
                  key={type}
                  icon={icon}
                  label={label}
                  disabled={!canCreateMate}
                  onClick={() => beginCreateMate(type)}
                  testId={`mate-${type}`}
                />
              ))}
            </ToolbarGroup>

            <div className="w-px h-5 bg-border mx-1" />

            <button
              type="button"
              title="Export STL"
              disabled={exporting}
              onClick={handleExportStl}
              data-testid="export-stl"
              className={[
                'flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors',
                exporting
                  ? 'text-muted-foreground opacity-40 cursor-not-allowed'
                  : 'text-foreground hover:bg-secondary active:bg-secondary/80',
              ].join(' ')}
            >
              {exporting ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              <span className="hidden sm:inline">Export STL</span>
            </button>

            {/* Hidden file input — triggered by the Import STEP button */}
            <input
              ref={stepFileInputRef}
              type="file"
              accept=".step,.stp"
              className="hidden"
              onChange={onStepFileChange}
            />

            <button
              type="button"
              title="Import STEP file"
              disabled={importingStep}
              onClick={() => stepFileInputRef.current?.click()}
              data-testid="import-step"
              className={[
                'flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors',
                importingStep
                  ? 'text-muted-foreground opacity-40 cursor-not-allowed'
                  : 'text-foreground hover:bg-secondary active:bg-secondary/80',
              ].join(' ')}
            >
              {importingStep ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )}
              <span className="hidden sm:inline">Import STEP</span>
            </button>

            <button
              type="button"
              title="Export STEP file"
              disabled={exportingStep}
              onClick={handleExportStep}
              data-testid="export-step"
              className={[
                'flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors',
                exportingStep
                  ? 'text-muted-foreground opacity-40 cursor-not-allowed'
                  : 'text-foreground hover:bg-secondary active:bg-secondary/80',
              ].join(' ')}
            >
              {exportingStep ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} />
              )}
              <span className="hidden sm:inline">Export STEP</span>
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Export mesh formats (Geant4 GDML, OBJ)"
                  disabled={exportingMesh}
                  data-testid="export-mesh"
                  className={[
                    'flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors',
                    exportingMesh
                      ? 'text-muted-foreground opacity-40 cursor-not-allowed'
                      : 'text-foreground hover:bg-secondary active:bg-secondary/80',
                  ].join(' ')}
                >
                  {exportingMesh ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  <span className="hidden sm:inline">Export…</span>
                  <ChevronDown size={11} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  data-testid="export-gdml"
                  onClick={() => handleExportMesh('gdml')}
                >
                  Geant4 GDML (.gdml)
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="export-obj"
                  onClick={() => handleExportMesh('obj')}
                >
                  Wavefront OBJ (.obj)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="w-px h-5 bg-border mx-1" />

            {/* Hidden file input — triggered by the Load Model button */}
            <input
              ref={modelFileInputRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={onModelFileChange}
            />

            <button
              type="button"
              title="Save model to file"
              onClick={handleSaveModel}
              data-testid="save-model"
              className="flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors text-foreground hover:bg-secondary active:bg-secondary/80"
            >
              <Download size={13} />
              <span className="hidden sm:inline">Save</span>
            </button>

            <button
              type="button"
              title="Load model from file"
              onClick={() => modelFileInputRef.current?.click()}
              data-testid="load-model"
              className="flex items-center gap-1.5 px-2 h-7 rounded text-xs font-technical transition-colors text-foreground hover:bg-secondary active:bg-secondary/80"
            >
              <Upload size={13} />
              <span className="hidden sm:inline">Load</span>
            </button>
          </>
        )}

        <div className="flex-1" />

        <span className="font-technical text-xs text-muted-foreground">
          {assembly.name}
        </span>
      </header>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar: Parts / Booleans / Mates tree */}
        <aside className="w-56 shrink-0 border-r border-border bg-sidebar flex flex-col overflow-y-auto panel-transition">
          <SidebarSection title="Parts">
            <NewPartButton />
            {assembly.parts.length === 0 ? (
              <EmptyState text="No parts yet" />
            ) : (
              assembly.parts.map((p) => (
                <PartsPanelItem
                  key={p.id}
                  part={p}
                  selection={selection}
                  onPartClick={onPartClick}
                  onSketchClick={onSketchClick}
                  onFeatureClick={onFeatureClick}
                  onRequestDelete={(id) => setCascadePartId(id)}
                />
              ))
            )}
          </SidebarSection>

          {(assembly.booleanFeatures ?? []).length > 0 ? (
            <SidebarSection title="Booleans">
              {(assembly.booleanFeatures ?? []).map((b) => (
                <BooleanRow
                  key={b.id}
                  feature={b}
                  parts={assembly.parts}
                  selected={
                    selection?.kind === 'boolean' &&
                    selection.booleanId === b.id
                  }
                  onClick={() => onBooleanClick(b.id)}
                />
              ))}
            </SidebarSection>
          ) : null}

          <SidebarSection title="Mates">
            {assembly.mates.length === 0 ? (
              <EmptyState text="No mates defined" />
            ) : (
              assembly.mates.map((m, idx) => {
                // Per-type index so the default label "Revolute 1" is stable.
                const sameKind = assembly.mates.filter(
                  (other) => other.type === m.type,
                );
                const indexAmongType = sameKind.findIndex(
                  (other) => other.id === m.id,
                );
                return (
                  <MatesPanelItem
                    key={m.id}
                    mate={m}
                    parts={assembly.parts}
                    selected={
                      selection?.kind === 'mate' && selection.mateId === m.id
                    }
                    indexAmongType={indexAmongType < 0 ? idx : indexAmongType}
                    onClick={() => onMateClick(m.id)}
                  />
                );
              })
            )}
          </SidebarSection>
        </aside>

        {/* Central 3D Canvas */}
        <main
          className="flex-1 relative overflow-hidden"
          style={{ background: '#0A0E1A' }}
          // The SketchCursor's CSS hides the system cursor inside this host
          // while sketch mode is active, scoped to this attribute selector.
          data-kineticad-canvas-host="true"
        >
          <Suspense fallback={null}>
            <Scene />
          </Suspense>
          <PlanePicker
            open={planePickerOpen}
            onPick={handlePlanePicked}
            onCancel={() => setPlanePickerOpen(false)}
          />
          {cascadePartId ? (
            <CascadeDeleteDialog
              partId={cascadePartId}
              onClose={() => setCascadePartId(null)}
            />
          ) : null}
        </main>
        <SketchCursor />

        {/* Right Inspector */}
        <aside
          className="w-60 shrink-0 border-l border-border bg-sidebar flex flex-col overflow-y-auto panel-transition"
          // Click on the inspector's empty area clears any selection. Buttons
          // and inputs inside child components stop propagation by virtue of
          // their own click handlers.
          onClick={(e) => {
            if (e.target === e.currentTarget) clearSelection();
          }}
        >
          <SidebarSection title="Inspector">
            <RightInspectorBody
              sketchActive={sketchSession.active}
              sketchPlane={sketchSession.plane}
              sketchPrimitiveCount={sketchSession.committedPrimitives.length}
              editorOpen={featureEditor.open}
              booleanEditorOpen={booleanEditor.open}
              mateEditorOpen={mateEditor.open}
              selection={selection}
              parts={assembly.parts}
              mates={assembly.mates}
              onRequestDeletePart={(partId) => setCascadePartId(partId)}
            />
          </SidebarSection>

          <SidebarSection title="Feature Tree">
            <FeatureTree
              parts={assembly.parts}
              selection={selection}
              onSketchClick={onSketchClick}
              onFeatureClick={onFeatureClick}
            />
          </SidebarSection>
        </aside>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}

/**
 * Render the left-sidebar tree under a single part: the part name plus its
 * sketches and applied features as clickable, selectable rows.
 */
function PartTree({
  part,
  selection,
  onPartClick,
  onSketchClick,
  onFeatureClick,
}: {
  part: Part;
  selection: ReturnType<typeof useKinetiCADStore.getState>['selection'];
  onPartClick: (partId: string) => void;
  onSketchClick: (partId: string, sketchId: string) => void;
  onFeatureClick: (partId: string, featureId: string) => void;
}) {
  const isPartSelected =
    selection?.kind === 'part' && selection.partId === part.id;
  return (
    <div className="flex flex-col">
      <SidebarItem
        label={part.name}
        selected={isPartSelected}
        onClick={() => onPartClick(part.id)}
        testId={`tree-part-${part.id}`}
      />
      {part.sketches.map((s) => {
        const isSelected =
          selection?.kind === 'sketch' && selection.sketchId === s.id;
        return (
          <SidebarItem
            key={s.id}
            label={`  ${s.name} (${planeLabel(s.plane)})`}
            muted
            selected={isSelected}
            onClick={() => onSketchClick(part.id, s.id)}
            testId={`tree-sketch-${s.id}`}
          />
        );
      })}
      {part.features.map((f, idx) => {
        const isSelected =
          selection?.kind === 'feature' && selection.featureId === f.id;
        return (
          <SidebarItem
            key={f.id}
            label={`  ${featureName(f, part, idx)}`}
            muted
            selected={isSelected}
            onClick={() => onFeatureClick(part.id, f.id)}
            testId={`tree-feature-${f.id}`}
          />
        );
      })}
    </div>
  );
}

function BooleanRow({
  feature,
  parts,
  selected,
  onClick,
}: {
  feature: BooleanFeature;
  parts: Part[];
  selected: boolean;
  onClick: () => void;
}) {
  const inputNames = feature.inputPartIds
    .map((id) => parts.find((p) => p.id === id)?.name ?? '?')
    .join(', ');
  const opGlyph = booleanOpGlyph(feature.operation);
  return (
    <SidebarItem
      label={`${opGlyph} ${feature.resultPartName} (${inputNames})`}
      selected={selected}
      onClick={onClick}
      testId={`tree-boolean-${feature.id}`}
    />
  );
}

function booleanOpGlyph(op: BooleanOperation): string {
  if (op.type === 'union') return '∪';
  if (op.type === 'subtract') return '−';
  return '∩';
}

function mateLabel(mate: Mate, parts: Part[]): string {
  const a = parts.find((p) => p.id === mate.partA)?.name ?? '?';
  const b = parts.find((p) => p.id === mate.partB)?.name ?? '?';
  const typeLabel =
    mate.type.charAt(0).toUpperCase() + mate.type.slice(1);
  const name = mate.name && mate.name.trim() ? mate.name : typeLabel;
  return `${name} (${a} ↔ ${b})`;
}

/** Human label for a feature row, e.g. "Extrude 1" or "Revolve 2". */
function featureName(feature: Feature, part: Part, _idx: number): string {
  if (feature.type === 'extrude') {
    const sameKind = part.features.filter((f) => f.type === 'extrude');
    const n = sameKind.findIndex((f) => f.id === feature.id) + 1;
    return `Extrude ${n}`;
  }
  if (feature.type === 'revolve') {
    const sameKind = part.features.filter((f) => f.type === 'revolve');
    const n = sameKind.findIndex((f) => f.id === feature.id) + 1;
    return `Revolve ${n}`;
  }
  // Other feature kinds aren't created yet but we still want a stable label.
  return feature.type;
}

/**
 * Right-panel "Feature Tree" section: same items as the left sidebar's
 * sketches+features list, kept here too because the spec calls for it.
 */
function FeatureTree({
  parts,
  selection,
  onSketchClick,
  onFeatureClick,
}: {
  parts: Part[];
  selection: ReturnType<typeof useKinetiCADStore.getState>['selection'];
  onSketchClick: (partId: string, sketchId: string) => void;
  onFeatureClick: (partId: string, featureId: string) => void;
}) {
  const isEmpty =
    parts.length === 0 ||
    parts.every(
      (p) => p.sketches.length === 0 && p.features.length === 0,
    );
  if (isEmpty) return <EmptyState text="No features" />;

  return (
    <>
      {parts.flatMap((p) => [
        ...p.sketches.map((s) => {
          const isSelected =
            selection?.kind === 'sketch' && selection.sketchId === s.id;
          return (
            <SidebarItem
              key={`s-${s.id}`}
              label={`${s.name} (${planeLabel(s.plane)}) — ${s.primitives.length} ${
                s.primitives.length === 1 ? 'primitive' : 'primitives'
              }`}
              selected={isSelected}
              onClick={() => onSketchClick(p.id, s.id)}
              testId={`featuretree-sketch-${s.id}`}
            />
          );
        }),
        ...p.features.map((f, idx) => {
          const isSelected =
            selection?.kind === 'feature' && selection.featureId === f.id;
          return (
            <SidebarItem
              key={`f-${f.id}`}
              label={featureName(f, p, idx)}
              selected={isSelected}
              onClick={() => onFeatureClick(p.id, f.id)}
              testId={`featuretree-feature-${f.id}`}
            />
          );
        }),
      ])}
    </>
  );
}

/**
 * Pick the inspector body based on the current store state. Order matters:
 *  1. Active sketch session   → ActiveSketchInspector
 *  2. booleanEditor open      → BooleanInspector (assembly-level editor)
 *  3. featureEditor open      → FeatureInspector (per-part editor)
 *  4. selection.kind=boolean  → BooleanInspector (read-only-ish view)
 *  5. selection.kind=sketch   → SketchInspector
 *  6. selection.kind=feature  → FeatureInspector also handles this once the
 *     store action `selectFeature` + `beginEditFeature` opens the editor;
 *     we still fall through to a stub label if the feature type isn't yet
 *     editable.
 *  7. selection.kind=part     → PartInspector
 *  8. Empty state.
 */
function RightInspectorBody({
  sketchActive,
  sketchPlane,
  sketchPrimitiveCount,
  editorOpen,
  booleanEditorOpen,
  mateEditorOpen,
  selection,
  parts,
  mates,
  onRequestDeletePart,
}: {
  sketchActive: boolean;
  sketchPlane: CardinalPlane | null;
  sketchPrimitiveCount: number;
  editorOpen: boolean;
  booleanEditorOpen: boolean;
  mateEditorOpen: boolean;
  selection: ReturnType<typeof useKinetiCADStore.getState>['selection'];
  parts: Part[];
  mates: Mate[];
  onRequestDeletePart: (partId: string) => void;
}) {
  if (sketchActive && sketchPlane) {
    return (
      <ActiveSketchInspector
        plane={sketchPlane}
        primitiveCount={sketchPrimitiveCount}
      />
    );
  }
  if (mateEditorOpen) {
    return <MateInspector />;
  }
  if (booleanEditorOpen) {
    return <BooleanInspector />;
  }
  if (editorOpen) {
    return <FeatureInspector />;
  }
  if (selection?.kind === 'mate') {
    // Mate selection lives at the assembly level. Clicking a mate row also
    // calls `beginEditMate` so this branch is mostly defensive — but if the
    // editor was somehow torn down (e.g. selection survived a cascade
    // delete), fall back to the empty state by checking the live mates list.
    const mate = mates.find((m) => m.id === selection.mateId);
    if (mate) return <MateInspector />;
  }
  if (selection?.kind === 'boolean') {
    // Selecting a committed boolean opens the editor in `edit` mode via the
    // `selectBoolean` → `beginEditBoolean` chain in `onBooleanClick`. As a
    // fallback (e.g. selection arrived via picker), still render the
    // BooleanInspector — it gracefully no-ops when the editor is closed.
    return <BooleanInspector />;
  }
  if (selection?.kind === 'part') {
    return <PartInspector onRequestDelete={onRequestDeletePart} />;
  }
  if (selection?.kind === 'sketch') {
    const part = parts.find((p) => p.id === selection.partId);
    const sketch = part?.sketches.find((s) => s.id === selection.sketchId);
    if (part && sketch) {
      return <SketchInspector part={part} sketch={sketch} />;
    }
  }
  if (selection?.kind === 'feature') {
    // Feature-selection without an open editor is now an unusual transient:
    //   - applyFeatureEditor falls back to a part selection on save.
    //   - clicking a feature row in the sidebar opens the editor.
    //   - boolean/sketch flows have their own selection kinds.
    // If we still land here (e.g. selection survived a part being removed),
    // resolve the containing sketch when possible, otherwise show the
    // empty state.
    const part = parts.find((p) => p.id === selection.partId);
    const feature = part?.features.find((f) => f.id === selection.featureId);
    if (part && feature) {
      const sketchId =
        'sketchId' in feature ? (feature as { sketchId?: string }).sketchId : undefined;
      const sketch = sketchId
        ? part.sketches.find((s) => s.id === sketchId)
        : undefined;
      if (sketch) {
        return <SketchInspector part={part} sketch={sketch} />;
      }
    }
  }
  return <EmptyState text="Select a part or feature" />;
}

/**
 * Cascade-delete confirmation dialog. Shown when the user clicks Delete on a
 * part that's referenced by one or more booleans. Confirm dispatches
 * `deletePartCascade` (removes the part AND every dependent boolean) — a
 * quietly destructive action we don't want to perform without consent.
 */
function CascadeDeleteDialog({
  partId,
  onClose,
}: {
  partId: string;
  onClose: () => void;
}) {
  const assembly = useKinetiCADStore((s) => s.assembly);
  const getBooleansUsingPart = useKinetiCADStore(
    (s) => s.getBooleansUsingPart,
  );
  const getMatesUsingPart = useKinetiCADStore((s) => s.getMatesUsingPart);
  const deletePartCascade = useKinetiCADStore((s) => s.deletePartCascade);

  const part = assembly.parts.find((p) => p.id === partId);
  const dependents = getBooleansUsingPart(partId);
  const dependentMates = getMatesUsingPart(partId);
  const willResetGround =
    (assembly.groundPartId || assembly.parts[0]?.id) === partId;

  if (!part) {
    // Part vanished out from under us (e.g. another action deleted it) —
    // close silently.
    onClose();
    return null;
  }

  const confirm = () => {
    deletePartCascade(partId);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Confirm delete"
        data-testid="cascade-delete-dialog"
        className="w-80 max-w-[90vw] rounded border border-border bg-card shadow-2xl"
      >
        <div className="px-4 py-3 border-b border-border">
          <div className="font-technical text-xs uppercase tracking-widest text-foreground">
            Delete {part.name}?
          </div>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2">
          {dependents.length === 0 && dependentMates.length === 0 ? (
            <div className="font-technical text-[11px] text-muted-foreground leading-snug">
              This part is not used by any booleans or mates. Are you sure you
              want to delete it?
            </div>
          ) : (
            <>
              <div className="font-technical text-[11px] text-foreground leading-snug">
                The following items reference this part and will also be deleted:
              </div>
              <ul className="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
                {dependents.map((b) => (
                  <li
                    key={b.id}
                    className="font-technical text-[11px] text-[#FF6B6B] truncate"
                  >
                    • {b.resultPartName}
                  </li>
                ))}
                {dependentMates.map((m) => (
                  <li
                    key={m.id}
                    className="font-technical text-[11px] text-[#FF6B6B] truncate"
                  >
                    • {mateLabel(m, assembly.parts)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {willResetGround ? (
            <div className="font-technical text-[11px] text-muted-foreground italic leading-snug">
              This part is the ground anchor; the next part will become the
              default ground.
            </div>
          ) : null}
        </div>
        <div className="px-4 py-3 border-t border-border flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            data-testid="cascade-delete-cancel"
            className="h-8 px-3 rounded font-technical text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-secondary transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            data-testid="cascade-delete-confirm"
            className="h-8 px-3 rounded bg-[#FF6B6B] text-[#0A0E1A] font-technical text-[11px] uppercase tracking-widest font-semibold hover:brightness-110 transition"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function ActiveSketchInspector({
  plane,
  primitiveCount,
}: {
  plane: CardinalPlane;
  primitiveCount: number;
}) {
  const assembly = useKinetiCADStore((s) => s.assembly);
  const selection = useKinetiCADStore((s) => s.selection);
  // Phase 6: resolve the target part the same way `finishSketch` does so
  // the inspector preview matches reality.
  const targetPart = (() => {
    if (selection?.kind === 'part') {
      const sel = assembly.parts.find((p) => p.id === selection.partId);
      if (sel) return sel;
    }
    return assembly.parts[0];
  })();
  const nextIndex = (targetPart?.sketches.length ?? 0) + 1;
  const targetName = targetPart?.name ?? 'Part 1';
  return (
    <div className="px-3 py-2 flex flex-col gap-1">
      <div className="font-technical text-xs text-foreground">
        Sketch {nextIndex} ({plane})
      </div>
      <div className="font-technical text-[11px] text-muted-foreground">
        On <span className="text-foreground">{targetName}</span>
      </div>
      <div
        className="font-technical text-[11px] text-muted-foreground"
        data-testid="sketch-primitive-count"
      >
        {primitiveCount} {primitiveCount === 1 ? 'primitive' : 'primitives'}
      </div>
    </div>
  );
}

function planeLabel(plane: SketchPlane): string {
  if (typeof plane === 'string') return plane;
  return 'Custom';
}

function ToolbarGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="font-technical text-[10px] text-muted-foreground uppercase tracking-wider mr-1 hidden sm:inline">
        {label}
      </span>
      {children}
    </div>
  );
}

function ToolbarBtn({
  icon,
  label,
  disabled = false,
  active = false,
  onClick,
  testId,
}: {
  icon: string;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      title={label}
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={[
        'flex items-center justify-center w-7 h-7 rounded text-sm transition-colors',
        disabled
          ? 'text-muted-foreground opacity-40 cursor-not-allowed'
          : active
          ? 'bg-[#FF6B1A] text-white'
          : 'text-foreground hover:bg-secondary active:bg-secondary/80',
      ].join(' ')}
    >
      {icon}
    </button>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col border-b border-border last:border-b-0">
      <div className="px-3 py-1.5 font-technical text-[10px] uppercase tracking-widest text-muted-foreground bg-background/50">
        {title}
      </div>
      <div className="flex flex-col py-1">{children}</div>
    </div>
  );
}

function SidebarItem({
  label,
  muted = false,
  selected = false,
  onClick,
  testId,
}: {
  label: string;
  muted?: boolean;
  selected?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={[
        'text-left px-3 py-1 text-xs font-technical hover:bg-secondary transition-colors rounded mx-1 border-l-2',
        selected
          ? 'border-l-[#FF6B1A] bg-[#FF6B1A]/[0.08] text-foreground'
          : 'border-l-transparent',
        !selected && (muted ? 'text-muted-foreground' : 'text-foreground'),
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {label}
    </button>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="px-3 py-2 text-xs font-technical text-muted-foreground italic">
      {text}
    </p>
  );
}
