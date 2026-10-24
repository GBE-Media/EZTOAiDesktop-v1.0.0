import { z } from 'zod';
import { useCanvasStore } from '@/store/canvasStore';
import type { AiRunCircuit, CanvasMarkup, MarkupStyle, PolygonMarkup, RectangleMarkup } from '@/types/markup';
import type { AssistantToolDefinition } from '../tools/types';
import { createApproval } from '../tools/registry';
import { resolveDocumentRef } from '../documentRef';
import { ensurePageZones, extractZoneInputs, type PageZone, type ZonePageInput } from '../detection/pageZones';
import { getLatestFullPageAnalysis } from '../agent/pageAnalysisCache';
import { allIndexedPages } from '../projectIndex/store';
import { pageGeometryFromUnrotated } from '../placement/visionDisplayPctToDoc';
import { normalizeRotationDeg, renderToDoc } from '../placement/coords';
import type { PageGeometry } from '../placement/types';
import { detectProjectLocation, governingNec, NEC_ADOPTION_CHECKED } from './jurisdiction';
import { DEFAULT_RUN_SETTINGS, findViewScale, planRuns, type PlannedCircuit, type RunPlan, type RunSettings } from './planRuns';
import { formatSize } from './necTables';
import type { Pt } from './spatial';

const pointSchema = z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) });

const circuitSchema = z.object({
  id: z.string().min(1).describe('Circuit id, e.g. "LP-2" or "L1-12".'),
  label: z.string().optional(),
  itemIds: z.array(z.string()).optional().describe('Devices on this circuit (count_page_items itemIds).'),
  points: z.array(pointSchema).optional().describe('Device locations in page display percent (0–100) when not from itemIds.'),
  loadVA: z.number().positive().optional().describe('Total circuit load in VA.'),
  vaPerDevice: z.number().positive().optional().describe('VA per device (from the fixture schedule). Used when loadVA is not given.'),
  loadAmps: z.number().positive().optional(),
  voltage: z.number().positive().default(120),
  phase: z.union([z.literal(1), z.literal(3)]).default(1),
  continuous: z.boolean().default(true).describe('Lighting is continuous (125%).'),
  ocpdAmps: z.number().positive().optional().describe('Breaker size from the panel schedule if known.'),
});

export const suggestRunsSchema = z.object({
  documentId: z.string().optional().describe('Open document id. Defaults to the active tab.'),
  page: z.number().int().positive(),
  panel: z.object({
    label: z.string().min(1).describe('Panel name as shown on the plan, e.g. "LP" or "LP-1".'),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
  }).describe('Panel the home runs go to. Omit x/y to find the label on the sheet.'),
  circuits: z.array(circuitSchema).optional().describe('Circuits with their devices. Omit to group devices automatically.'),
  autoCircuits: z.object({
    itemIds: z.array(z.string()).optional().describe('Devices to circuit (defaults to all counted items on the page).'),
    vaPerDevice: z.number().positive(),
    voltage: z.number().positive().default(120),
    phase: z.union([z.literal(1), z.literal(3)]).default(1),
    continuous: z.boolean().default(true),
    breakerAmps: z.number().positive().default(20),
    useCircuitTags: z.boolean().default(true).describe('Group by circuit tags printed next to devices (e.g. "LP-2").'),
  }).optional(),
  settings: z.object({
    wiringMethod: z.enum(['EMT', 'PVC40', 'RMC', 'MC']).optional(),
    material: z.enum(['cu', 'al']).optional(),
    vdTargetPct: z.number().positive().max(10).optional(),
    maxCircuitsPerConduit: z.number().int().min(1).max(9).optional(),
    verticalFt: z.number().min(0).max(100).optional(),
    necEdition: z.number().int().optional().describe('Override the code edition (otherwise from the project address).'),
  }).optional(),
  description: z.string().optional(),
});

type SuggestRunsInput = z.infer<typeof suggestRunsSchema>;

const zoneInputCache = new Map<string, ZonePageInput>();

const HOMERUN_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];

export function createSuggestRunsTool(): AssistantToolDefinition<typeof suggestRunsSchema> {
  const definition: AssistantToolDefinition<typeof suggestRunsSchema> = {
    id: 'suggest_runs',
    title: 'Suggest runs',
    description:
      'Lay out suggested branch circuitry and home-run conduits on a plan sheet. Routes go around '
      + 'elevators, shafts, stairs and openings, stay inside the plan view, and minimize bends and wall '
      + 'penetrations. Sizes conductors for ampacity and voltage drop, EGCs and raceway fill per the NEC '
      + 'edition adopted at the project address. Shows a preview; the user approves placement. '
      + 'Placed runs are editable: dragging points re-sizes them. Use count_page_items first for devices.',
    risk: 'write',
    requiresConfirmation: true,
    undoable: true,
    schema: suggestRunsSchema,
    execute: async (context, rawInput) => {
      const input = suggestRunsSchema.parse(rawInput);
      const prepared = await prepareRunPlan(input);
      if ('needs' in prepared) {
        return { status: 'completed', summary: prepared.message, output: prepared };
      }
      const approval = createApproval(definition, context, {
        payload: {
          documentId: prepared.docId,
          page: input.page,
          markups: prepared.markups,
          summary: prepared.summaryLines,
        },
        description: input.description || `Place ${prepared.homeRuns} suggested home run${prepared.homeRuns === 1 ? '' : 's'} on page ${input.page}`,
      });
      context.addApproval(approval);
      return {
        status: 'approval-required',
        summary: `Waiting for approval: ${approval.description}`,
        approval,
        output: prepared.modelSummary,
      };
    },
  };
  return definition;
}

type Prepared =
  | {
    docId: string;
    markups: Array<{ page: number; markup: CanvasMarkup }>;
    homeRuns: number;
    summaryLines: string[];
    modelSummary: Record<string, unknown>;
  }
  | { needs: 'document' | 'panel' | 'scale' | 'devices' | 'page'; message: string; [key: string]: unknown };

export async function prepareRunPlan(input: SuggestRunsInput): Promise<Prepared> {
  const resolved = resolveDocumentRef(input.documentId);
  if ('error' in resolved) return { needs: 'document', message: resolved.error };
  const docId = resolved.docId;
  const canvas = useCanvasStore.getState();
  const pdf = canvas.pdfDocuments[docId];
  if (!pdf?.pdfDocument || typeof pdf.pdfDocument.getPage !== 'function') {
    return { needs: 'document', message: 'That document is not loaded as a PDF.' };
  }
  const revision = pdf.contentRevision ?? 0;
  const pdfPage = await pdf.pdfDocument.getPage(input.page).catch(() => null);
  if (!pdfPage) return { needs: 'page', message: `Page ${input.page} does not exist in this document.` };
  const cacheKey = `${docId}:${input.page}:${revision}`;
  let page = zoneInputCache.get(cacheKey);
  if (!page) {
    page = await extractZoneInputs(pdfPage);
    zoneInputCache.set(cacheKey, page);
    if (zoneInputCache.size > 12) zoneInputCache.delete(zoneInputCache.keys().next().value as string);
  }
  const zones: PageZone[] = await ensurePageZones(docId, input.page);
  const W = page.pageWidth;
  const H = page.pageHeight;
  const view = (pdfPage as unknown as { view?: number[]; rotate?: number });
  const rotationDeg = normalizeRotationDeg(view.rotate ?? 0);
  const [vx0, vy0, vx1, vy1] = view.view || [0, 0, W, H];
  const geometry: PageGeometry = pageGeometryFromUnrotated({
    pageNumber: input.page,
    docWidth: Math.abs(vx1 - vx0),
    docHeight: Math.abs(vy1 - vy0),
    rotationDeg,
  });
  const toDisplay = (p: { x: number; y: number }): Pt => ({ x: (p.x / 100) * W, y: (p.y / 100) * H });

  // Devices.
  const analysis = getLatestFullPageAnalysis(docId, input.page, revision);
  const itemsById = new Map((analysis?.analysis?.items || []).map(item => [item.id, item]));
  const devicePoint = (id: string): Pt | null => {
    const item = itemsById.get(id);
    if (!item || item.locationMissing || !item.location) return null;
    return toDisplay(item.location);
  };
  let circuits: PlannedCircuit[] = (input.circuits || []).map(c => {
    const devices = [
      ...(c.itemIds || []).map(devicePoint).filter((p): p is Pt => !!p),
      ...(c.points || []).map(toDisplay),
    ];
    const loadVA = c.loadVA ?? (c.vaPerDevice ? c.vaPerDevice * devices.length : undefined);
    return { id: c.id, label: c.label || c.id, devices, loadVA, loadAmps: c.loadAmps, voltage: c.voltage ?? 120, phase: c.phase ?? 1, continuous: c.continuous ?? true, ocpdAmps: c.ocpdAmps };
  }).filter(c => c.devices.length > 0);
  if (!circuits.length && input.autoCircuits) {
    const ids = input.autoCircuits.itemIds?.length ? input.autoCircuits.itemIds : [...itemsById.keys()];
    const devices = ids.map(devicePoint).filter((p): p is Pt => !!p);
    const a = input.autoCircuits;
    circuits = autoCircuit(devices, page, {
      vaPerDevice: a.vaPerDevice ?? 100,
      voltage: a.voltage ?? 120,
      phase: a.phase ?? 1,
      continuous: a.continuous ?? true,
      breakerAmps: a.breakerAmps ?? 20,
      useCircuitTags: a.useCircuitTags ?? true,
    });
  }
  if (!circuits.length) {
    return {
      needs: 'devices',
      message: 'No device locations available. Run count_page_items on this page first, then pass itemIds (or circuits).',
    };
  }

  // Panel.
  let panel: Pt | null = null;
  if (typeof input.panel.x === 'number' && typeof input.panel.y === 'number') panel = toDisplay({ x: input.panel.x, y: input.panel.y });
  const candidates = panel ? [] : findPanelLabel(page, zones, input.panel.label);
  if (!panel && candidates.length === 1) panel = candidates[0].point;
  if (!panel) {
    return {
      needs: 'panel',
      message: candidates.length
        ? `Found ${candidates.length} places labeled "${input.panel.label}". Ask the user which one is the panel (use clarify with focus on each candidate).`
        : `Could not find panel "${input.panel.label}" on page ${input.page}. Ask the user where the panel is (or whether it is on another sheet).`,
      candidates: candidates.slice(0, 6).map(c => ({ text: c.text, x: round1((c.point.x / W) * 100), y: round1((c.point.y / H) * 100) })),
      documentId: docId,
      page: input.page,
    };
  }

  // Scale: user calibration beats the printed view scale.
  const calibration = canvas.pageCalibrationsByDoc[docId]?.[input.page];
  let ftPerPt: number | null = null;
  let scaleSource = '';
  if (calibration?.pixelsPerUnit && calibration.unit) {
    const unit = calibration.unit.toLowerCase();
    const perUnitFt = unit.startsWith('ft') || unit === "'" ? 1 : unit.startsWith('in') ? 1 / 12 : unit === 'm' ? 3.28084 : null;
    if (perUnitFt) {
      ftPerPt = perUnitFt / calibration.pixelsPerUnit;
      scaleSource = 'page calibration';
    }
  }
  if (!ftPerPt) {
    const viewScale = findViewScale(page, zones, circuits.flatMap(c => c.devices));
    if (viewScale) {
      ftPerPt = viewScale.ftPerPt;
      scaleSource = `printed scale ${viewScale.text}`;
    }
  }
  if (!ftPerPt) {
    return {
      needs: 'scale',
      message: 'No drawing scale found on this view. Ask the user to calibrate the page (activate_editor_tool "calibrate") or give the scale.',
    };
  }

  // Code basis from the project address on the prints/specs.
  const location = detectProjectLocation(allIndexedPages().flatMap(row => (row.lines || []).map(line => ({
    text: line.text, documentId: row.docId, documentName: row.documentName, page: row.page,
  }))).concat(page.textItems.map(item => ({ text: item.str, documentId: docId, documentName: undefined, page: input.page }))));
  const code = governingNec(location?.state);
  const settings: RunSettings = {
    ...DEFAULT_RUN_SETTINGS,
    ...Object.fromEntries(Object.entries(input.settings || {}).filter(([, v]) => v !== undefined)),
    necEdition: input.settings?.necEdition ?? code.edition,
  } as RunSettings;

  const plan = planRuns({ page, zones, panel, panelLabel: input.panel.label, circuits, settings, ftPerPt, scaleSource });
  const markups = buildRunMarkups(plan, circuits, settings, geometry, input.page);
  const homeRuns = plan.runs.filter(r => r.kind === 'homerun');
  const codeLine = `${code.summary}${location ? ` Project: ${location.text}.` : ''}`;
  const summaryLines = [
    codeLine,
    ...homeRuns.map(r => `${r.label} · ≈${Math.round(r.lengthFt)} ft · VD ${Math.max(...r.sizing.map(s => s.vdPct)).toFixed(1)}%`),
    ...(plan.obstacles.length ? [`Routed around: ${[...new Set(plan.obstacles.map(o => o.label))].join(', ')}`] : []),
  ];
  return {
    docId,
    markups,
    homeRuns: homeRuns.length,
    summaryLines,
    modelSummary: {
      code: { ...code, location, adoptionDataChecked: NEC_ADOPTION_CHECKED },
      scale: scaleSource,
      settings,
      homeRuns: homeRuns.map(r => ({
        id: r.id,
        circuits: r.circuitIds,
        raceway: r.conduit ? `${r.conduit.tradeSize}" ${r.conduit.raceway} (${r.conduit.fillPct}% fill)` : 'MC cable',
        label: r.label,
        homeRunFt: Math.round(r.lengthFt),
        vdLengthFt: Math.round(r.vdLengthFt),
        bendsDeg: r.bendsDeg,
        wallPenetrations: r.wallCrossings,
        perCircuit: r.sizing.map(s => ({
          circuit: s.label,
          loadA: s.loadAmps,
          breakerA: s.ocpdAmps,
          conductor: formatSize(s.conductor),
          egc: formatSize(s.egc),
          vdPct: s.vdPct,
          notes: s.notes,
        })),
        warnings: r.warnings,
      })),
      branchSegments: plan.runs.filter(r => r.kind === 'branch').length,
      obstacles: plan.obstacles.map(o => ({ kind: o.kind, label: o.label })),
      codeRefs: plan.codeRefs,
      warnings: plan.warnings,
      assumptions: [
        `Lengths from ${scaleSource}; ${settings.verticalFt} ft vertical per home run.`,
        'Voltage drop uses full circuit load at the farthest device (conservative).',
        `THHN/THWN-2 ${settings.material === 'cu' ? 'copper' : 'aluminum'}, 75 °C terminations, #12 minimum.`,
        'Local amendments not checked — confirm with the AHJ.',
      ],
    },
  };
}

function buildRunMarkups(
  plan: RunPlan,
  circuits: PlannedCircuit[],
  settings: RunSettings,
  geometry: PageGeometry,
  pageNumber: number,
): Array<{ page: number; markup: CanvasMarkup }> {
  const identity: PageGeometry = { ...geometry, renderScale: 1 };
  const toDoc = (p: Pt) => renderToDoc(p, identity);
  const now = new Date().toISOString();
  const base = {
    page: pageNumber,
    locked: false,
    author: 'BidveraAi',
    createdAt: now,
    aiGenerated: true,
  };
  const out: Array<{ page: number; markup: CanvasMarkup }> = [];
  const byId = new Map(circuits.map(c => [c.id, c]));
  const branchFt = new Map<string, number>();
  for (const run of plan.runs) {
    if (run.kind !== 'branch') continue;
    const id = run.circuitIds[0];
    branchFt.set(id, (branchFt.get(id) || 0) + run.lengthFt);
  }
  const homeRuns = plan.runs.filter(r => r.kind === 'homerun');
  const colorFor = new Map<string, string>();
  homeRuns.forEach((run, i) => run.circuitIds.forEach(id => colorFor.set(id, HOMERUN_COLORS[i % HOMERUN_COLORS.length])));

  for (const ob of plan.obstacles) {
    const a = toDoc({ x: ob.box.x, y: ob.box.y });
    const b = toDoc({ x: ob.box.x + ob.box.width, y: ob.box.y + ob.box.height });
    const rect: RectangleMarkup = {
      ...base,
      id: `run_keepout_${crypto.randomUUID()}`,
      type: 'rectangle',
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      style: style('#dc2626', 'rgba(220, 38, 38, 0.10)', 1.5, 0.9),
      label: `Keep clear: ${ob.label}`,
      aiNote: `Runs routed around ${ob.label}.`,
      aiRun: { runId: `keepout-${ob.label}`, kind: 'keepout', ftPerPt: plan.ftPerPt, lengthFt: 0, summary: `Keep clear: ${ob.label}` },
    };
    out.push({ page: pageNumber, markup: rect });
  }

  for (const run of plan.runs) {
    const color = colorFor.get(run.circuitIds[0]) || '#2563eb';
    const points = run.path.map(toDoc);
    const isHome = run.kind === 'homerun';
    const runCircuits: AiRunCircuit[] = run.circuitIds.map(id => {
      const c = byId.get(id);
      return {
        id,
        label: c?.label,
        loadAmps: c?.loadAmps,
        loadVA: c?.loadVA,
        voltage: c?.voltage || 120,
        phase: c?.phase || 1,
        continuous: c?.continuous,
        ocpdAmps: c?.ocpdAmps,
        branchFt: branchFt.get(id) || 0,
      };
    });
    const markup: PolygonMarkup = {
      ...base,
      id: `run_${run.id}_${crypto.randomUUID()}`,
      type: 'polyline',
      points,
      style: style(color, 'transparent', isHome ? 3 : 1.25, isHome ? 0.95 : 0.75),
      label: isHome ? run.label : `${run.circuitIds[0]} branch`,
      aiNote: isHome ? run.note : `${run.circuitIds[0]} branch ≈${Math.round(run.lengthFt)} ft`,
      aiRun: {
        runId: run.id,
        kind: run.kind,
        ftPerPt: plan.ftPerPt,
        lengthFt: run.lengthFt,
        circuits: isHome ? runCircuits : undefined,
        settings: isHome ? {
          wiringMethod: settings.wiringMethod,
          material: settings.material,
          vdTargetPct: settings.vdTargetPct,
          verticalFt: settings.verticalFt,
          necEdition: settings.necEdition,
        } : undefined,
        summary: isHome ? run.label : undefined,
        vdPct: isHome ? Math.max(...run.sizing.map(s => s.vdPct)) : undefined,
      },
    };
    out.push({ page: pageNumber, markup });
  }
  return out;
}

function style(strokeColor: string, fillColor: string, strokeWidth: number, opacity: number): MarkupStyle {
  return { strokeColor, fillColor, strokeWidth, opacity, fontSize: 10, fontFamily: 'Inter, sans-serif' };
}

function findPanelLabel(page: ZonePageInput, zones: PageZone[], label: string): Array<{ text: string; point: Pt }> {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const target = norm(label).replace(/^PANEL/, '');
  if (!target) return [];
  const W = page.pageWidth;
  const H = page.pageHeight;
  const excluded = zones.filter(z => ['schedule', 'legend', 'notes', 'title_block', 'diagram', 'detail', 'key_plan'].includes(z.kind));
  const hits = page.textItems.filter(item => {
    const n = norm(item.str).replace(/^PANEL/, '');
    if (n !== target) return false;
    const cx = ((item.x + item.width / 2) / W) * 100;
    const cy = ((item.y + item.height / 2) / H) * 100;
    return !excluded.some(z => cx >= z.bounds.x && cy >= z.bounds.y && cx <= z.bounds.x + z.bounds.width && cy <= z.bounds.y + z.bounds.height);
  });
  return hits.map(item => ({ text: item.str.trim(), point: { x: item.x + item.width / 2, y: item.y + item.height / 2 } }));
}

/** Group devices into circuits: printed circuit tags first, then by proximity and breaker capacity. */
export function autoCircuit(
  devices: Pt[],
  page: ZonePageInput,
  options: { vaPerDevice: number; voltage: number; phase: 1 | 3; continuous: boolean; breakerAmps: number; useCircuitTags: boolean },
): PlannedCircuit[] {
  const circuits = new Map<string, Pt[]>();
  const untagged: Pt[] = [];
  const radius = Math.max(page.pageWidth, page.pageHeight) * 0.02;
  const tags = options.useCircuitTags
    ? page.textItems
      .map(item => ({ m: item.str.trim().match(/^([A-Z]{1,4}\d?[A-Z]?)\s*-\s*(\d{1,3})$/), item }))
      .filter(row => !!row.m)
      .map(row => ({ id: `${row.m?.[1]}-${row.m?.[2]}`, x: row.item.x + row.item.width / 2, y: row.item.y + row.item.height / 2 }))
    : [];
  for (const d of devices) {
    let best: { id: string; dist: number } | null = null;
    for (const tag of tags) {
      const dd = Math.hypot(tag.x - d.x, tag.y - d.y);
      if (dd <= radius && (!best || dd < best.dist)) best = { id: tag.id, dist: dd };
    }
    if (best) circuits.set(best.id, [...(circuits.get(best.id) || []), d]);
    else untagged.push(d);
  }
  // Untagged devices: 80 % of the breaker for continuous loads (210.20(A)), chained by proximity.
  const maxVA = options.breakerAmps * options.voltage * (options.phase === 3 ? Math.sqrt(3) : 1) * (options.continuous ? 0.8 : 1);
  const perCircuit = Math.max(1, Math.floor(maxVA / options.vaPerDevice));
  const remaining = untagged.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  let n = 1;
  while (remaining.length) {
    const group = [remaining.shift() as Pt];
    while (group.length < perCircuit && remaining.length) {
      const last = group[group.length - 1];
      let bi = 0;
      for (let i = 1; i < remaining.length; i += 1) {
        if (Math.abs(remaining[i].x - last.x) + Math.abs(remaining[i].y - last.y) < Math.abs(remaining[bi].x - last.x) + Math.abs(remaining[bi].y - last.y)) bi = i;
      }
      group.push(remaining.splice(bi, 1)[0]);
    }
    circuits.set(`C${n}`, group);
    n += 1;
  }
  return [...circuits.entries()].map(([id, pts]) => ({
    id,
    label: id,
    devices: pts,
    loadVA: pts.length * options.vaPerDevice,
    voltage: options.voltage,
    phase: options.phase,
    continuous: options.continuous,
    ocpdAmps: options.breakerAmps,
  }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
