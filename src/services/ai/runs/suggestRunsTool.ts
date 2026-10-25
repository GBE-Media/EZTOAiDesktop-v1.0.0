import { z } from 'zod';
import { useCanvasStore } from '@/store/canvasStore';
import type { AiRunCircuit, CanvasMarkup, MarkupStyle, PolygonMarkup, RectangleMarkup } from '@/types/markup';
import type { AssistantToolDefinition } from '../tools/types';
import { createApproval } from '../tools/registry';
import { resolveDocumentRef } from '../documentRef';
import { ensurePageZones, extractZoneInputs, type PageZone, type ZonePageInput } from '../detection/pageZones';
import { allIndexedPages } from '../projectIndex/store';
import { pageGeometryFromUnrotated } from '../placement/visionDisplayPctToDoc';
import { normalizeRotationDeg, renderToDoc } from '../placement/coords';
import type { PageGeometry } from '../placement/types';
import { detectProjectLocation, governingNec, NEC_ADOPTION_CHECKED } from './jurisdiction';
import {
  DEFAULT_RUN_SETTINGS,
  findViewScale,
  offSheetExitPoint,
  planRoutingContext,
  planRuns,
  shortCircuitList,
  type PlannedCircuit,
  type PlannedRun,
  type RunPlan,
  type RunSettings,
} from './planRuns';
import { circuitsFromTags, panelNamesFromSchedules, panelsFromCircuits, parseCircuitTag, suggestPanels } from './circuitTags';
import { materialTotals, runAssembly, type RunAssembly } from './runMaterials';
import { getLatestFullPageAnalysis, itemIsUnresolvedForCounts } from '../agent/pageAnalysisCache';
import { formatSize } from './necTables';
import { arcLength } from './overlay';
import type { Box, Obstacle, Pt } from './spatial';
import type { AskUserRequest } from '../agent/askUser';
import type { ClarificationField } from '@/types/assistant';

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
    label: z.string().optional().describe('Panel name as shown on the plan, e.g. "LP" or "LP-1".'),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    offSheet: z.boolean().optional().describe('Panel is on another sheet: home runs stop at the plan edge.'),
  }).optional().describe('Panel the home runs go to. Omit x/y to find the label on the sheet. If unknown, omit it — the tool asks the user (they can click it on the drawing).'),
  panels: z.array(z.object({
    label: z.string().min(1),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    offSheet: z.boolean().optional(),
  })).optional().describe('Several panels (circuit tags like "B-4" → panel B). Omit — the tool reads the tags and asks for locations.'),
  keepClear: z.array(z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(0).max(100),
    height: z.number().min(0).max(100),
    label: z.string().optional(),
  })).optional().describe('Extra keep-clear areas in page display percent (from the user).'),
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

/** Runs read like Revit wiring: one standard light blue for branch arcs and home runs. */
export const RUN_COLOR = '#1e9bf0';
/** Keep-clear (no-fly) areas: orange highlight. */
export const KEEPOUT_COLOR = '#f97316';

export function createSuggestRunsTool(): AssistantToolDefinition<typeof suggestRunsSchema> {
  const definition: AssistantToolDefinition<typeof suggestRunsSchema> = {
    id: 'suggest_runs',
    title: 'Suggest runs',
    description:
      'Lay out suggested branch circuitry and home-run conduits on a plan sheet. Routes go around '
      + 'elevators, shafts, stairs and openings, stay inside the plan view, and minimize bends and wall '
      + 'penetrations. Sizes conductors for ampacity and voltage drop, EGCs and raceway fill per the NEC '
      + 'edition adopted at the project address. Shows a preview; the user approves placement. '
      + 'Placed runs are editable: dragging points re-sizes them. Use count_page_items first for devices. '
      + 'Call it even when the panel location or wiring method is unknown: it pauses and asks the user '
      + 'with a card (they click the panel on the drawing), then you get the exact arguments to call again.',
    risk: 'write',
    requiresConfirmation: true,
    undoable: true,
    schema: suggestRunsSchema,
    execute: async (context, rawInput) => {
      const input = suggestRunsSchema.parse(rawInput);
      const prepared = await prepareRunPlan(input);
      if ('needs' in prepared) {
        const askUser = prepared.needs === 'input' ? buildRunInputQuestion(prepared as RunInputNeeded, rawInput as Record<string, unknown>) : undefined;
        return { status: 'completed', summary: prepared.message, output: prepared, ...(askUser ? { askUser } : {}) };
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
  | { needs: 'document' | 'panel' | 'scale' | 'devices' | 'page'; message: string; [key: string]: unknown }
  | RunInputNeeded;

/** Panel locations / wiring method / keep-clear areas are missing: the user answers with one card. */
export interface RunInputNeeded {
  needs: 'input';
  message: string;
  documentId: string;
  page: number;
  missing: Array<'panel_location' | 'panel_label' | 'wiring_method' | 'keep_clear'>;
  panelLabel?: string;
  /** Panels from the engineer's circuit tags that still need a location. */
  panels: Array<{ label: string; index: number; circuits: string[]; candidates: Array<{ text: string; x: number; y: number }>; scheduled: boolean }>;
  /** Panel-args to pre-fill on resume (one per tag panel, in order). */
  panelArgs: Array<{ label: string; x?: number; y?: number; offSheet?: boolean }>;
  candidates: Array<{ text: string; x: number; y: number }>;
  panelNames: string[];
  recommendedWiring?: WiringMethodValue;
  obstacleMentions?: number;
  obstaclesFound?: number;
}

type WiringMethodValue = 'EMT' | 'MC' | 'PVC40' | 'RMC';

const WIRING_LABELS: Record<WiringMethodValue, string> = {
  EMT: 'EMT conduit',
  MC: 'MC cable',
  PVC40: 'PVC Sch 40',
  RMC: 'Rigid (RMC)',
};

function circuitPreview(ids: string[]): string {
  const short = shortCircuitList(ids.slice(0, 8));
  return ids.length > 8 ? `${short}…` : short;
}

/** Build the structured card for missing run inputs (resumes suggest_runs with the answers). */
export function buildRunInputQuestion(needed: RunInputNeeded, rawArgs: Record<string, unknown>): AskUserRequest {
  const fields: ClarificationField[] = [];
  const apply: Record<string, string> = { wiring_method: 'settings.wiringMethod', keep_clear: 'keepClear' };
  const label = needed.panelLabel;
  if (needed.missing.includes('panel_label')) {
    fields.push({
      id: 'panel_label',
      kind: needed.panelNames.length ? 'choice' : 'text',
      prompt: 'Which panel do these home runs go to?',
      ...(needed.panelNames.length
        ? { options: needed.panelNames.map(name => ({ id: `panel_${name}`, label: `Panel ${name}`, value: name })) }
        : { placeholder: 'e.g. LP-1' }),
    });
    apply.panel_label = 'panel.label';
  }
  const offSheetOption = { id: 'off_sheet', label: 'On another sheet', value: 'flag:offSheet' };
  if (needed.panels.length) {
    for (const panel of needed.panels) {
      const id = `panel_loc_${panel.index}`;
      apply[id] = `panels.${panel.index}`;
      fields.push({
        id,
        kind: 'point',
        prompt: `Where is panel ${panel.label}? (${panel.circuits.length} circuit${panel.circuits.length === 1 ? '' : 's'}: ${circuitPreview(panel.circuits)})`,
        documentId: needed.documentId,
        page: needed.page,
        pickLabel: `Click panel ${panel.label} on the drawing`,
        options: [
          ...panel.candidates.slice(0, 3).map((c, i) => ({
            id: `${id}_cand_${i + 1}`,
            label: panel.candidates.length === 1 ? `Use "${c.text}" on this sheet` : `"${c.text}" #${i + 1}`,
            value: `${c.x},${c.y}`,
            point: { documentId: needed.documentId, page: needed.page, xPct: c.x, yPct: c.y },
          })),
          offSheetOption,
        ],
      });
    }
  } else if (needed.missing.includes('panel_location')) {
    apply.panel_location = 'panel';
    fields.push({
      id: 'panel_location',
      kind: 'point',
      prompt: label ? `Where is panel ${label}?` : 'Where is the panel?',
      documentId: needed.documentId,
      page: needed.page,
      pickLabel: label ? `Click panel ${label} on the drawing` : 'Click the panel on the drawing',
      options: [
        ...needed.candidates.slice(0, 4).map((c, i) => ({
          id: `cand_${i + 1}`,
          label: needed.candidates.length === 1 ? `Use "${c.text}" found on the sheet` : `"${c.text}" #${i + 1}`,
          value: `${c.x},${c.y}`,
          point: { documentId: needed.documentId, page: needed.page, xPct: c.x, yPct: c.y },
        })),
        offSheetOption,
      ],
    });
  }
  if (needed.missing.includes('wiring_method')) {
    fields.push({
      id: 'wiring_method',
      kind: 'choice',
      prompt: 'Which wiring method?',
      options: (Object.keys(WIRING_LABELS) as WiringMethodValue[]).map(value => ({
        id: `wm_${value}`,
        label: WIRING_LABELS[value],
        value,
      })),
      ...(needed.recommendedWiring ? { recommended: needed.recommendedWiring } : {}),
    });
  }
  if (needed.missing.includes('keep_clear')) {
    fields.push({
      id: 'keep_clear',
      kind: 'area',
      prompt: needed.obstaclesFound
        ? `I found ${needed.obstaclesFound} keep-clear area${needed.obstaclesFound === 1 ? '' : 's'} (highlighted). Mark any others — elevators, stairs, shafts`
        : 'Mark areas to keep runs out of — elevators, stairs, shafts',
      documentId: needed.documentId,
      page: needed.page,
      pickLabel: 'Drag a box around each area to keep clear',
      optional: true,
    });
  }
  const page = needed.page;
  const onlyWiring = fields.length === 1 && fields[0].id === 'wiring_method';
  const tagNote = needed.panels.length
    ? `The engineer tagged each fixture with its panel and circuit, so I grouped the circuits by those tags. `
    : '';
  return {
    question: onlyWiring
      ? `Which wiring method should I use for the runs on page ${page}?`
      : `A couple of details before I lay out the runs on page ${page}`,
    description: `${tagNote}${needed.recommendedWiring ? `The specs point to ${WIRING_LABELS[needed.recommendedWiring]}; change it if this job differs.` : ''}`.trim() || undefined,
    fields,
    focus: { documentId: needed.documentId, page },
    resume: {
      toolId: 'suggest_runs',
      args: {
        ...rawArgs,
        documentId: needed.documentId,
        page,
        ...(needed.panelArgs.length ? { panels: needed.panelArgs } : {}),
        ...(needed.missing.includes('keep_clear') ? { keepClear: [] } : {}),
      },
      apply,
    },
  };
}

/** Panel names from panel schedules / plan text in the project ("PANEL LP-1", "PANELBOARD A"). */
export function panelNameCandidates(lines: string[]): string[] {
  return panelNamesFromSchedules(lines).slice(0, 6);
}

/** @deprecated kept for reference; panelNamesFromSchedules has the word-boundary fix. */
export function legacyPanelNameCandidates(lines: string[]): string[] {
  const counts = new Map<string, number>();
  const re = /\bPANEL(?:BOARD)?\s*(?:[:#]|NAME:?|DESIGNATION:?)?\s*["']?([A-Z]{1,4}[0-9]{0,2}(?:-[A-Z0-9]{1,3})?)\b/g;
  const stop = new Set(['SCHEDULE', 'BOARD', 'BOARDS', 'TO', 'IN', 'ON', 'AND', 'OR', 'THE', 'FED', 'FROM', 'MAIN', 'SEE', 'NEW', 'TYPE', 'MOUNTED', 'LOCATION', 'SCHED', 'NAME']);
  for (const line of lines) {
    for (const m of line.toUpperCase().matchAll(re)) {
      const name = m[1];
      if (stop.has(name) || name.length > 8) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name);
}

/** The wiring method the specs/plan notes favor, if they clearly name one. */
export function specWiringMethod(lines: string[]): WiringMethodValue | undefined {
  const score: Record<WiringMethodValue, number> = { EMT: 0, MC: 0, PVC40: 0, RMC: 0 };
  for (const raw of lines) {
    const line = raw.toUpperCase();
    if (!/WIRING METHOD|RACEWAY|BRANCH CIRCUIT|CONDUIT|CABLE/.test(line)) continue;
    if (/\bEMT\b|ELECTRICAL METALLIC TUBING/.test(line)) score.EMT += 1;
    if (/\bTYPE MC\b|\bMC CABLE\b|METAL[- ]CLAD CABLE/.test(line)) score.MC += 1;
    if (/\bPVC\b|RIGID NONMETALLIC/.test(line)) score.PVC40 += 1;
    if (/\bRMC\b|RIGID METAL CONDUIT|RIGID STEEL/.test(line)) score.RMC += 1;
  }
  const ranked = (Object.entries(score) as Array<[WiringMethodValue, number]>).sort((a, b) => b[1] - a[1]);
  if (!ranked[0][1] || ranked[0][1] === ranked[1][1]) return undefined;
  return ranked[0][0];
}

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

  // Devices (counted items).
  const analysis = getLatestFullPageAnalysis(docId, input.page, revision);
  const analysisItems = analysis?.analysis?.items || [];
  const legendCodes = analysis?.analysis?.legendTypeCodes;
  const itemsById = new Map(analysisItems.map(item => [item.id, item]));
  const devicePoint = (id: string): Pt | null => {
    const item = itemsById.get(id);
    if (!item || item.locationMissing || !item.location) return null;
    return toDisplay(item.location);
  };
  const loadDefaults = {
    vaPerDevice: input.autoCircuits?.vaPerDevice ?? input.circuits?.find(c => c.vaPerDevice)?.vaPerDevice ?? 100,
    voltage: input.autoCircuits?.voltage ?? input.circuits?.[0]?.voltage ?? 120,
    phase: (input.autoCircuits?.phase ?? input.circuits?.[0]?.phase ?? 1) as 1 | 3,
    continuous: input.autoCircuits?.continuous ?? input.circuits?.[0]?.continuous ?? true,
  };
  let circuits: PlannedCircuit[] = (input.circuits || []).map(c => {
    const devices = [
      ...(c.itemIds || []).map(devicePoint).filter((p): p is Pt => !!p),
      ...(c.points || []).map(toDisplay),
    ];
    const loadVA = c.loadVA ?? (c.vaPerDevice ? c.vaPerDevice * devices.length : undefined);
    const tag = parseCircuitTag(c.id);
    return { id: c.id, label: c.label || c.id, devices, loadVA, loadAmps: c.loadAmps, voltage: c.voltage ?? 120, phase: c.phase ?? 1, continuous: c.continuous ?? true, ocpdAmps: c.ocpdAmps, ...(tag ? { panel: tag.panel } : {}) };
  }).filter(c => c.devices.length > 0);

  // The engineer's circuit tags ("B-4" next to a fixture = panel B, circuit 4) beat any grouping
  // the model guessed (e.g. every fixture on one circuit).
  const poolIds = input.circuits?.some(c => c.itemIds?.length)
    ? input.circuits.flatMap(c => c.itemIds || [])
    : input.autoCircuits?.itemIds?.length
      ? input.autoCircuits.itemIds
      : analysisItems.filter(item => !itemIsUnresolvedForCounts(item, legendCodes).unresolved).map(item => item.id);
  const poolDevices = [...new Set(poolIds)].flatMap(id => {
    const point = devicePoint(id);
    return point ? [{ point, itemId: id }] : [];
  });
  const extraPoints = (input.circuits || []).flatMap(c => (c.points || []).map(p => ({ point: toDisplay(p as Pt) })));
  const projectLines = allIndexedPages().flatMap(row => (row.lines || []).map(line => line.text));
  const scheduleNames = panelNamesFromSchedules(projectLines);
  const specMethod = specWiringMethod(projectLines);
  const useTags = input.autoCircuits?.useCircuitTags !== false;
  const tagged = useTags
    ? circuitsFromTags([...poolDevices, ...extraPoints], page, { ...loadDefaults, knownPanels: scheduleNames })
    : null;
  const modelCircuitsAreTags = circuits.length > 1 && circuits.every(c => !!c.panel);
  const lumped = circuits.length <= 1 || circuits.some(c => c.devices.length > 24);
  let usedTags = false;
  if (tagged && tagged.circuits.length && tagged.coverage >= 0.3 && (!circuits.length || lumped || !modelCircuitsAreTags)) {
    const extra = tagged.untagged.length
      ? autoCircuit(tagged.untagged.map(d => d.point), page, { ...loadDefaults, breakerAmps: 20, useCircuitTags: false })
      : [];
    circuits = [...tagged.circuits, ...extra];
    usedTags = true;
  }
  if (!circuits.length && poolDevices.length) {
    circuits = autoCircuit(poolDevices.map(d => d.point), page, {
      ...loadDefaults,
      breakerAmps: input.autoCircuits?.breakerAmps ?? 20,
      useCircuitTags: useTags,
    });
  }
  if (!circuits.length) {
    return {
      needs: 'devices',
      message: 'No device locations available. Run count_page_items on this page first, then pass itemIds (or circuits).',
    };
  }

  // The same tag on two plan views (e.g. first + second floor) is two runs, never one chain
  // across the sheet.
  const viewBoxes = zones.filter(z => z.kind === 'plan' && z.source === 'view').map(z => ({
    x: (z.bounds.x / 100) * W, y: (z.bounds.y / 100) * H, width: (z.bounds.width / 100) * W, height: (z.bounds.height / 100) * H,
  }));
  const viewOf = (p: Pt) => viewBoxes.findIndex(b => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
  if (viewBoxes.length > 1) {
    circuits = circuits.flatMap(c => {
      const byView = new Map<number, Pt[]>();
      c.devices.forEach(d => {
        const v = viewOf(d);
        byView.set(v, [...(byView.get(v) || []), d]);
      });
      if (byView.size <= 1) return [c];
      const parts = [...byView.values()].sort((a, b) => b.length - a.length);
      const perDevice = c.loadVA && c.devices.length ? c.loadVA / c.devices.length : undefined;
      return parts.map((devices, i) => ({
        ...c,
        id: i === 0 ? c.id : `${c.id}@${i + 1}`,
        label: c.label || c.id,
        devices,
        loadVA: perDevice ? perDevice * devices.length : c.loadVA,
      }));
    });
  }

  // Panels: from the circuit tags (confirmed against the panel schedules) or the one given.
  const normLabel = (t?: string) => (t || '').toUpperCase().replace(/^PANEL\s*/, '').replace(/[^A-Z0-9]/g, '');
  const givenPanels = [...(input.panels || []), ...(input.panel ? [{ ...input.panel, label: input.panel.label || '' }] : [])];
  const tagPanels = panelsFromCircuits(circuits);
  type PanelPlan = { label: string; point: Pt | null; offSheet: boolean; candidates: Array<{ text: string; point: Pt }>; circuits: PlannedCircuit[] };
  const resolvePanel = (label: string, given?: { x?: number; y?: number; offSheet?: boolean }): Omit<PanelPlan, 'circuits'> => {
    if (given?.offSheet) return { label, point: null, offSheet: true, candidates: [] };
    if (typeof given?.x === 'number' && typeof given?.y === 'number') return { label, point: toDisplay({ x: given.x, y: given.y }), offSheet: false, candidates: [] };
    const candidates = label ? findPanelLabel(page, zones, label) : [];
    return { label, point: candidates.length === 1 ? candidates[0].point : null, offSheet: false, candidates };
  };
  let panelPlans: PanelPlan[];
  if (usedTags && tagPanels.length) {
    const top = tagPanels.slice(0, 6);
    panelPlans = top.map(row => {
      const given = givenPanels.find(p => normLabel(p.label) === normLabel(row.panel))
        || (top.length === 1 && givenPanels.length === 1 && !givenPanels[0].label ? givenPanels[0] : undefined);
      return { ...resolvePanel(row.panel, given), circuits: circuits.filter(c => c.panel === row.panel) };
    });
    // Untagged / overflow circuits ride with the busiest panel.
    const assigned = new Set(panelPlans.flatMap(p => p.circuits.map(c => c.id)));
    panelPlans[0].circuits.push(...circuits.filter(c => !assigned.has(c.id)));
  } else {
    const given = givenPanels[0];
    const label = given?.label?.trim() || '';
    panelPlans = [{ ...resolvePanel(label, given), circuits }];
  }

  // Keep-clear areas: found from room labels; the user's marked areas are added.
  const allDevicePts = circuits.flatMap(c => c.devices);
  const routing = planRoutingContext(page, zones, allDevicePts, panelPlans.flatMap(p => (p.point ? [p.point] : [])));
  const userKeepClear: Obstacle[] = (input.keepClear || []).map((area, i) => ({
    kind: 'opening',
    label: area.label || `Keep clear ${i + 1}`,
    box: { x: (area.x / 100) * W, y: (area.y / 100) * H, width: (area.width / 100) * W, height: (area.height / 100) * H },
  }));

  const missing: RunInputNeeded['missing'] = [];
  const needLocation = panelPlans.filter(p => !p.point && !p.offSheet);
  if (needLocation.length) missing.push('panel_location');
  if (!usedTags && needLocation.length && !panelPlans[0].label) missing.push('panel_label');
  if (!input.settings?.wiringMethod && !specMethod) missing.push('wiring_method');
  // The sheet names elevators / stairs / shafts we couldn't outline: let the user mark them.
  const troubleWithObstacles = routing.obstacleMentions > routing.obstacles.filter(o => !o.approximate).length;
  if (input.keepClear === undefined && troubleWithObstacles) missing.push('keep_clear');
  if (missing.length) {
    const toPct = (pt: Pt) => ({ x: round1((pt.x / W) * 100), y: round1((pt.y / H) * 100) });
    return {
      needs: 'input',
      message: 'Asked the user with a card for: ' + missing.join(', ') + '. Wait for their answer; it includes the exact arguments to call suggest_runs again.',
      documentId: docId,
      page: input.page,
      missing,
      panelLabel: panelPlans[0].label || undefined,
      panels: usedTags
        ? panelPlans.flatMap((p, index) => (!p.point && !p.offSheet
          ? [{ label: p.label, index, circuits: p.circuits.map(c => c.id), candidates: p.candidates.slice(0, 6).map(c => ({ text: c.text, ...toPct(c.point) })), scheduled: scheduleNames.includes(p.label) }]
          : []))
        : [],
      panelArgs: usedTags
        ? panelPlans.map(p => ({ label: p.label, ...(p.point ? toPct(p.point) : {}), ...(p.offSheet ? { offSheet: true } : {}) }))
        : [],
      candidates: usedTags ? [] : panelPlans[0].candidates.slice(0, 6).map(c => ({ text: c.text, ...toPct(c.point) })),
      panelNames: missing.includes('panel_label')
        ? suggestPanels(panelsFromCircuits(circuits).map(r => r.panel), scheduleNames).map(r => r.name)
        : [],
      recommendedWiring: specMethod,
      obstacleMentions: routing.obstacleMentions,
      obstaclesFound: routing.obstacles.length,
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
    ...(specMethod ? { wiringMethod: specMethod } : {}),
    ...Object.fromEntries(Object.entries(input.settings || {}).filter(([, v]) => v !== undefined)),
    necEdition: input.settings?.necEdition ?? code.edition,
  } as RunSettings;

  // Circuits on a different plan view than their panel (another floor) home-run to the edge of
  // their own plan, tagged for the panel.
  if (viewBoxes.length > 1) {
    panelPlans = panelPlans.flatMap(pp => {
      if (!pp.point || pp.offSheet) return [pp];
      const panelView = viewOf(pp.point);
      if (panelView < 0) return [pp];
      const majority = (c: PlannedCircuit) => {
        const counts = new Map<number, number>();
        c.devices.forEach(d => counts.set(viewOf(d), (counts.get(viewOf(d)) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
      };
      const here = pp.circuits.filter(c => { const v = majority(c); return v === panelView || v < 0; });
      const away = pp.circuits.filter(c => !here.includes(c));
      return away.length
        ? [{ ...pp, circuits: here }, { label: pp.label, point: null, offSheet: true, candidates: [], circuits: away }]
        : [pp];
    }).filter(pp => pp.circuits.length);
  }

  const plan = planAllPanels({
    page, zones, panelPlans, settings, ftPerPt, scaleSource, extraObstacles: userKeepClear, allowed: routing.allowed,
  });
  const markups = buildRunMarkups(plan, circuits, settings, geometry, input.page);
  const materials = materialTotals(plan.runs.map(run => ({ assembly: run.assembly, lengthFt: run.lengthFt })));
  const homeRuns = plan.runs.filter(r => r.kind === 'homerun');
  const codeLine = `${code.summary}${location ? ` Project: ${location.text}.` : ''}`;
  const summaryLines = [
    codeLine,
    ...homeRuns.map(r => `${r.label} · ≈${Math.round(r.lengthFt)} ft · VD ${Math.max(...r.sizing.map(s => s.vdPct)).toFixed(1)}%`),
    ...(plan.obstacles.length ? [`Routed around: ${[...new Set(plan.obstacles.map(o => o.label))].join(', ')}`] : []),
    ...(materials.length ? [`Materials: ${materials.slice(0, 6).map(m => `${m.name} ${m.ft.toLocaleString()} ft`).join(' · ')}`] : []),
    ...(usedTags ? [`Circuits from the engineer's tags: ${panelPlans.map(p => `panel ${p.label} (${p.circuits.length})`).join(', ')}`] : []),
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
      circuitsFrom: usedTags ? 'engineer circuit tags on the plan' : 'model / proximity grouping',
      panels: panelPlans.map(p => ({ label: p.label, circuits: p.circuits.map(c => c.id), offSheet: p.offSheet || undefined })),
      materials,
      productsNote: 'On placement each run is linked to a product in the user\'s library (created under "AI Takeoff" when missing), with conduit/wire/cable per foot as components.',
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

type PlannedRunWithMaterials = PlannedRun & { assembly: RunAssembly | null; panelLabel: string };
type MultiPanelPlan = Omit<RunPlan, 'runs'> & {
  loadCenterFt: Record<string, number>;
  runs: PlannedRunWithMaterials[];
  panels: Array<{ label: string; point: Pt; offSheet: boolean }>;
};

/** One planRuns pass per panel; home runs numbered across panels. */
function planAllPanels(options: {
  page: ZonePageInput;
  zones: PageZone[];
  panelPlans: Array<{ label: string; point: Pt | null; offSheet: boolean; circuits: PlannedCircuit[] }>;
  settings: RunSettings;
  ftPerPt: number;
  scaleSource: string;
  extraObstacles: Obstacle[];
  allowed: Box[];
}): MultiPanelPlan {
  const runs: PlannedRunWithMaterials[] = [];
  const obstacles: Obstacle[] = [];
  const seenObstacles = new Set<string>();
  const warnings: string[] = [];
  const codeRefs = new Set<string>();
  const panels: MultiPanelPlan['panels'] = [];
  const loadCenterFt: Record<string, number> = {};
  let hr = 0;
  for (const pp of options.panelPlans) {
    if (!pp.circuits.length) continue;
    const label = pp.label || 'Panel';
    const point = pp.point || offSheetExitPoint(options.allowed, pp.circuits.flatMap(c => c.devices), options.page);
    const plan = planRuns({
      page: options.page,
      zones: options.zones,
      panel: point,
      panelLabel: label,
      circuits: pp.circuits,
      settings: options.settings,
      ftPerPt: options.ftPerPt,
      scaleSource: options.scaleSource,
      extraObstacles: options.extraObstacles,
      panelOffSheet: pp.offSheet || !pp.point,
    });
    const renumber = new Map<string, string>();
    for (const run of plan.runs) {
      if (run.kind !== 'homerun') continue;
      hr += 1;
      renumber.set(run.id, `HR${hr}`);
    }
    const sizingByCircuit = new Map(plan.runs.flatMap(run => run.sizing.map(s => [s.circuitId, s] as const)));
    for (const run of plan.runs) {
      const next = { ...run };
      if (run.kind === 'homerun') {
        const id = renumber.get(run.id) || run.id;
        next.id = id;
        next.label = run.label.replace(/^HR\d+/, id) + (pp.offSheet || !pp.point ? ` → ${label} (off this plan)` : '');
        next.note = run.note.replace(/^Home run \d+/, `Home run ${id.slice(2)}`);
      }
      runs.push({
        ...next,
        assembly: runAssembly(next, options.settings, run.kind === 'branch' ? sizingByCircuit.get(run.circuitIds[0]) : undefined),
        panelLabel: label,
      });
    }
    for (const ob of plan.obstacles) {
      const key = `${ob.label}:${Math.round(ob.box.x)}:${Math.round(ob.box.y)}`;
      if (seenObstacles.has(key)) continue;
      seenObstacles.add(key);
      obstacles.push(ob);
    }
    warnings.push(...plan.warnings.map(w => w.replace(/^HR\d+/, m => renumber.get(m) || m)));
    plan.codeRefs.forEach(ref => codeRefs.add(ref));
    Object.assign(loadCenterFt, plan.loadCenterFt || {});
    panels.push({ label, point, offSheet: pp.offSheet || !pp.point });
  }
  return {
    runs,
    obstacles,
    ftPerPt: options.ftPerPt,
    scaleSource: options.scaleSource,
    warnings: [...new Set(warnings)],
    codeRefs: [...codeRefs],
    panels,
    loadCenterFt,
  };
}

function buildRunMarkups(
  plan: MultiPanelPlan,
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
  // Paper-space sizes (doc points) so runs scale with the print like a Revit sheet.
  const docMax = Math.max(geometry.docWidth, geometry.docHeight) || 3000;
  const homeWidth = Math.max(1.5, docMax * 0.0011);
  const branchWidth = Math.max(1, docMax * 0.0007);

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
      style: style(KEEPOUT_COLOR, 'rgba(249, 115, 22, 0.22)', Math.max(1.5, docMax * 0.0009), 100),
      label: `Keep clear: ${ob.label}${ob.approximate ? ' (approx.)' : ''}`,
      aiNote: `Runs routed around ${ob.label}.`,
      aiRun: { runId: `keepout-${ob.label}`, kind: 'keepout', ftPerPt: plan.ftPerPt, lengthFt: 0, summary: `Keep clear: ${ob.label}` },
    };
    out.push({ page: pageNumber, markup: rect });
  }

  for (const panel of plan.panels) {
    if (panel.offSheet) continue;
    const c = toDoc(panel.point);
    const size = Math.max(geometry.docWidth, geometry.docHeight) * 0.006;
    const rect: RectangleMarkup = {
      ...base,
      id: `run_panel_${crypto.randomUUID()}`,
      type: 'rectangle',
      x: c.x - size,
      y: c.y - size / 2,
      width: size * 2,
      height: size,
      style: style('#111827', 'rgba(17, 24, 39, 0.85)', 1.5, 100),
      label: `Panel ${panel.label}`,
      aiNote: `Home runs end at panel ${panel.label}.`,
      aiRun: { runId: `panel-${panel.label}`, kind: 'panel', ftPerPt: plan.ftPerPt, lengthFt: 0, panel: panel.label, summary: `Panel ${panel.label}` },
    };
    out.push({ page: pageNumber, markup: rect });
  }

  for (const run of plan.runs) {
    const isHome = run.kind === 'homerun';
    const curve = !isHome && run.arc ? run.arc.map(toDoc) : null;
    const points = curve || run.path.map(toDoc);
    if (points.length < 2) continue;
    const arcFt = curve ? arcLength(curve[0], curve[1], curve[2]) * plan.ftPerPt : 0;
    const footageFactor = curve && arcFt > 0 ? Math.max(1, Math.round((run.lengthFt / arcFt) * 1000) / 1000) : undefined;
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
        vdBranchFt: plan.loadCenterFt?.[id],
      };
    });
    const offSheet = plan.panels.find(p => p.label === run.panelLabel)?.offSheet;
    const markup: PolygonMarkup = {
      ...base,
      id: `run_${run.id}_${crypto.randomUUID()}`,
      type: 'polyline',
      points,
      style: style(RUN_COLOR, 'transparent', isHome ? homeWidth : branchWidth, 100),
      label: isHome ? run.label : `${run.circuitIds[0]} branch`,
      aiNote: isHome
        ? run.note
        : `${run.circuitIds[0]} branch ≈${Math.round(run.lengthFt)} ft${run.assembly ? ` · ${run.assembly.name}` : ''}`,
      aiRun: {
        runId: run.id,
        kind: run.kind,
        ftPerPt: plan.ftPerPt,
        lengthFt: run.lengthFt,
        panel: run.panelLabel,
        ...(curve ? { curve: true, footageFactor } : {}),
        ...(isHome && offSheet ? { offSheet: true } : {}),
        ...(run.assembly ? { assembly: { key: run.assembly.key, name: run.assembly.name, materials: run.assembly.materials } } : {}),
        circuits: isHome ? runCircuits : undefined,
        settings: isHome ? {
          wiringMethod: settings.wiringMethod,
          material: settings.material,
          vdTargetPct: settings.vdTargetPct,
          verticalFt: settings.verticalFt,
          necEdition: settings.necEdition,
        } : undefined,
        summary: isHome ? run.label : undefined,
        vdPct: isHome && run.sizing.length ? Math.max(...run.sizing.map(s => s.vdPct)) : undefined,
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
