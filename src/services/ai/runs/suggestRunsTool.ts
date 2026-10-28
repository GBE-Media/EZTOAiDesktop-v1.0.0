import { z } from 'zod';
import { useCanvasStore } from '@/store/canvasStore';
import type { AiRunCircuit, CanvasMarkup, MarkupStyle, PolygonMarkup, RectangleMarkup } from '@/types/markup';
import type { AssistantToolDefinition } from '../tools/types';
import { createApproval } from '../tools/registry';
import { resolveDocumentRef } from '../documentRef';
import { ensurePageZones, getZoneInputs, type PageZone, type ZonePageInput } from '../detection/pageZones';
import { allIndexedPages } from '../projectIndex/store';
import { pageGeometryFromUnrotated } from '../placement/visionDisplayPctToDoc';
import { docToRender, getRenderPageSize, normalizeRotationDeg, renderToDoc } from '../placement/coords';
import type { PageGeometry } from '../placement/types';
import { detectProjectLocation, governingNec, NEC_ADOPTION_CHECKED } from './jurisdiction';
import {
  DEFAULT_RUN_SETTINGS,
  findViewScale,
  offSheetExitPoint,
  planRoutingContext,
  planRuns,
  RunRoutingError,
  shortCircuitList,
  type PlannedCircuit,
  type PlannedRun,
  type RunPlan,
  type RunSettings,
  viewIndexOf,
} from './planRuns';
import { insideBox, tightenToDrawing, viewOffset } from './viewRegistration';
import { auditRuns } from './runAudit';
import { circuitsFromTags, panelNamesFromSchedules, panelsFromCircuits, panelsTaggedOnSheet, parseCircuitTag, readCircuitTags, suggestPanels } from './circuitTags';
import { materialTotals, runAssembly, type RunAssembly } from './runMaterials';
import { getLatestFullPageAnalysis, itemIsUnresolvedForCounts } from '../agent/pageAnalysisCache';
import { formatSize } from './necTables';
import { arcLength } from './overlay';
import type { Box, Obstacle, Pt } from './spatial';
import { takePinnedResume, type AskUserRequest } from '../agent/askUser';
import { buildFootprint, snapInside, type Footprint } from './footprint';
import { runInputSnapshot } from './runInputSnapshot';
import { findAnnotationBubbles } from '../detection/annotationBubbles';
import { buildSymbolComponents } from '../detection/vectorSymbols';
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
  reviewPanelLocations: z.boolean().optional().describe('When the user wants to move/re-pick panel or off-sheet continuation locations, ask fresh drawing cards. Existing points stay fixed until the user submits replacements. Do not retype coordinates.'),
  panel: z.object({
    label: z.string().optional().describe('Panel name as shown on the plan, e.g. "LP" or "LP-1".'),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    offSheet: z.boolean().optional().describe('Panel is on another sheet: ask the user for the continuation point on this plan.'),
    exit: pointSchema.optional().describe('User-picked continuation point on this page for an off-sheet panel.'),
  }).optional().describe('Panel the home runs go to. Omit x/y to find the label on the sheet. If unknown, omit it — the tool asks the user (they can click it on the drawing).'),
  panels: z.array(z.object({
    label: z.string().min(1),
    x: z.number().min(0).max(100).optional(),
    y: z.number().min(0).max(100).optional(),
    offSheet: z.boolean().optional(),
    exit: pointSchema.optional(),
  })).optional().describe('Several panels (circuit tags like "B-4" → panel B). Omit — the tool reads the tags and asks for locations.'),
  scaleChoice: z.enum(['printed', 'calibration']).optional().describe('Set by the card when the page calibration and the printed plan scale disagree.'),
  wiringMethodConfirmed: z.boolean().optional().describe('Set by the card answer only. The material counts as decided only after the user picked it on the card (remembered per document); a spec/drawing method is just the pre-selected recommendation in settings.wiringMethod.'),
  panelLabels: z.array(z.string()).optional().describe('Panels the user picked on the card for these home runs (several allowed). Circuits are split between them by the circuit tags / nearest tagged fixtures.'),
  keepClear: z.array(z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(0).max(100),
    height: z.number().min(0).max(100),
    label: z.string().optional(),
  })).optional().describe('Extra keep-clear areas in page display percent (from the user).'),
  keepClearConfirmed: z.boolean().optional().describe('keepClear is the full list the user confirmed on the card (the AI-suggested boxes they kept + their own): skip auto-detected areas.'),
  circuits: z.array(circuitSchema).optional().describe('Circuits with their devices. Omit to group devices automatically.'),
  autoCircuits: z.object({
    itemIds: z.array(z.string()).optional().describe('Devices to circuit (defaults to all counted items on the page).'),
    vaPerDevice: z.number().positive().optional().describe('VA per fixture from the fixture schedule. Omit when unknown — the tool asks the user with a card.'),
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
    floorToFloorFt: z.number().min(6).max(40).optional().describe('Floor-to-floor height for risers between floors (default 12 ft).'),
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
    execute: async (context, modelInput) => {
      const { args: rawInput, fromCard, cardKeys, askedPanels } = pinnedAnswers(modelInput as Record<string, unknown>, context.runId);
      const input = suggestRunsSchema.parse(rawInput);
      // The model's own copy of the user's inputs is never trusted: the panels / keep-clear
      // zones the user marked are read from the page, the material from what they picked.
      let prepared: Prepared;
      try {
        prepared = await prepareRunPlan(input, { strict: true, fromCard, cardKeys, askedPanels });
      } catch (error) {
        if (!(error instanceof RunRoutingError)) throw error;
        return {
          status: 'completed',
          summary: error.message,
          output: { needs: 'routing_review', circuits: error.circuitIds, placed: 0 },
          askUser: {
            question: 'The runs could not be routed without crossing a blocked area.',
            description: error.message,
            focus: { documentId: input.documentId, page: input.page },
            fields: [{ id: 'routing_review', kind: 'text', prompt: 'What should I adjust? Your existing panels and keep-clear zones will stay in place unless you explicitly ask to change them.', placeholder: 'Describe the change or cancel this layout' }],
          },
        };
      }
      if ('needs' in prepared) {
        const askUser = prepared.needs === 'input' ? buildRunInputQuestion(prepared as RunInputNeeded, rawInput as Record<string, unknown>) : undefined;
        return { status: 'completed', summary: prepared.message, output: prepared, ...(askUser ? { askUser } : {}) };
      }
      const approval = createApproval(definition, context, {
        payload: {
          documentId: prepared.docId,
          inputSnapshot: runInputSnapshot(useCanvasStore.getState().pdfDocuments[prepared.docId]?.markupsByPage[input.page] || []),
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
  missing: Array<'panel_location' | 'panel_label' | 'wiring_method' | 'keep_clear' | 'fixture_load' | 'scale'>;
  /** Page calibration and the plan's printed scale disagree: which one sets the footage. */
  scaleConflict?: { printed: string; calibration: string };
  panelLabel?: string;
  /** Panels from the engineer's circuit tags that still need a location. */
  panels: Array<{ label: string; index: number; circuits: string[]; candidates: Array<{ text: string; x: number; y: number }>; scheduled: boolean; offSheet?: boolean }>;
  /** Panel-args to pre-fill on resume (one per tag panel, in order). */
  panelArgs: Array<{ label: string; x?: number; y?: number; offSheet?: boolean; exit?: Pt }>;
  panelOffSheet?: boolean;
  candidates: Array<{ text: string; x: number; y: number }>;
  panelNames: string[];
  /** Several panels serve this sheet: the card lets the user pick all that apply. */
  panelMulti?: boolean;
  /** Pre-selected panels for the multi-select (the ones tagged on the sheet). */
  panelRecommended?: string[];
  /** Where the panel options came from (circuit tags on the sheet, panel schedules). */
  panelHint?: string;
  recommendedWiring?: WiringMethodValue;
  obstacleMentions?: number;
  obstaclesFound?: number;
  /** AI-drafted keep-clear boxes (page display percent) the user confirms / edits on the card. */
  suggestedAreas?: Array<{ x: number; y: number; width: number; height: number; label: string; approximate?: boolean }>;
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
  const multiPanel = needed.missing.includes('panel_label') && !!needed.panelMulti && needed.panelNames.length > 1;
  if (multiPanel) {
    // Several panels are tagged / scheduled: pick every panel these home runs go to. The circuits
    // are split between them by the tags; each panel's location is asked next.
    const recommended = (needed.panelRecommended || []).filter(name => needed.panelNames.includes(name));
    fields.push({
      id: 'panel_label',
      kind: 'choice',
      multi: true,
      prompt: needed.panelHint
        ? `Which panels do these home runs go to? Pick all that apply. ${needed.panelHint}`
        : 'Which panels do these home runs go to? Pick all that apply.',
      options: needed.panelNames.map(name => ({ id: `panel_${name}`, label: `Panel ${name}`, value: name })),
      recommended: (recommended.length ? recommended : needed.panelNames).join(','),
      placeholder: 'Or type panel names, e.g. A, B, C',
    });
    apply.panel_label = 'panelLabels#list';
  } else if (needed.missing.includes('panel_label')) {
    fields.push({
      id: 'panel_label',
      kind: needed.panelNames.length ? 'choice' : 'text',
      prompt: needed.panelHint ? `Which panel do these home runs go to? ${needed.panelHint}` : 'Which panel do these home runs go to?',
      ...(needed.panelNames.length
        ? {
          options: needed.panelNames.map(name => ({ id: `panel_${name}`, label: `Panel ${name}`, value: name })),
          recommended: needed.panelNames[0],
          placeholder: 'Or type the panel name',
        }
        : { placeholder: 'e.g. LP-1' }),
    });
    apply.panel_label = 'panel.label';
  }
  const offSheetOption = { id: 'off_sheet', label: 'On another sheet', value: 'flag:offSheet' };
  if (needed.panels.length) {
    for (const panel of needed.panels) {
      const id = `panel_loc_${panel.index}`;
      apply[id] = `panels.${panel.index}${panel.offSheet ? '.exit' : ''}`;
      fields.push({
        id,
        kind: 'point',
        prompt: panel.offSheet ? `Where should home runs to panel ${panel.label} leave this plan?` : `Where is panel ${panel.label}? (${panel.circuits.length} circuit${panel.circuits.length === 1 ? '' : 's'}: ${circuitPreview(panel.circuits)})`,
        documentId: needed.documentId,
        page: needed.page,
        pickLabel: panel.offSheet ? `Click the continuation point for panel ${panel.label} on this plan` : `Click panel ${panel.label} on the drawing`,
        options: panel.offSheet ? [] : [
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
  } else if (needed.missing.includes('panel_location') && !multiPanel) {
    apply.panel_location = needed.panelOffSheet ? 'panel.exit' : 'panel';
    fields.push({
      id: 'panel_location',
      kind: 'point',
      prompt: needed.panelOffSheet ? `Where should home runs to panel ${label || ''} leave this plan?` : label ? `Where is panel ${label}?` : 'Where is the panel?',
      documentId: needed.documentId,
      page: needed.page,
      pickLabel: needed.panelOffSheet ? 'Click the continuation point on this plan' : label ? `Click panel ${label} on the drawing` : 'Click the panel on the drawing',
      options: needed.panelOffSheet ? [] : [
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
      prompt: 'What should the runs be installed in? (I pre-selected what the prints / specs point to)',
      options: (Object.keys(WIRING_LABELS) as WiringMethodValue[]).map(value => ({
        id: `wm_${value}`,
        label: WIRING_LABELS[value],
        value,
      })),
      ...(needed.recommendedWiring ? { recommended: needed.recommendedWiring } : {}),
    });
  }
  if (needed.missing.includes('fixture_load')) {
    apply.fixture_load = 'autoCircuits.vaPerDevice#num';
    fields.push({
      id: 'fixture_load',
      kind: 'choice',
      prompt: "What load per fixture should I circuit with? (the fixture schedule doesn't list VA)",
      options: [
        { id: 'va_40', label: '40 VA (typical LED)', value: '40' },
        { id: 'va_75', label: '75 VA', value: '75' },
        { id: 'va_100', label: '100 VA', value: '100' },
        { id: 'va_180', label: '180 VA (NEC 220.14 general outlet)', value: '180' },
      ],
      recommended: '40',
      placeholder: 'Or type the VA, e.g. 52',
    });
  }
  if (needed.missing.includes('keep_clear')) {
    const suggested = needed.suggestedAreas || [];
    fields.push({
      id: 'keep_clear',
      kind: 'area',
      prompt: suggested.length
        ? `I drafted ${suggested.length} keep-clear area${suggested.length === 1 ? '' : 's'} from the room labels (${[...new Set(suggested.map(a => a.label))].slice(0, 4).join(', ')}). Remove any that are wrong and drag boxes for any I missed`
        : 'Mark areas to keep runs out of — elevators, stairs, shafts',
      documentId: needed.documentId,
      page: needed.page,
      pickLabel: 'Drag a box around each area to keep clear',
      optional: true,
      ...(suggested.length ? {
        suggestedAreas: suggested.map(a => ({
          documentId: needed.documentId, page: needed.page, xPct: a.x, yPct: a.y, wPct: a.width, hPct: a.height, label: a.label,
        })),
      } : {}),
    });
  }
  if (needed.missing.includes('scale') && needed.scaleConflict) {
    fields.push({
      id: 'scale',
      kind: 'choice',
      prompt: `This plan is printed at ${needed.scaleConflict.printed}, but the page is calibrated to ${needed.scaleConflict.calibration}. Which scale should the footage use?`,
      options: [
        { id: 'scale_printed', label: `Printed scale (${needed.scaleConflict.printed})`, value: 'printed' },
        { id: 'scale_calibration', label: `My calibration (${needed.scaleConflict.calibration})`, value: 'calibration' },
      ],
      recommended: 'printed',
    });
    apply.scale = 'scaleChoice';
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
    description: `${tagNote}${needed.recommendedWiring && needed.missing.includes('wiring_method') ? `The specs point to ${WIRING_LABELS[needed.recommendedWiring]}; change it if this job differs.` : ''}`.trim() || undefined,
    fields,
    focus: { documentId: needed.documentId, page },
    resume: {
      toolId: 'suggest_runs',
      args: {
        ...rawArgs,
        reviewPanelLocations: false,
        documentId: needed.documentId,
        page,
        ...(needed.panelArgs.length ? { panels: needed.panelArgs } : {}),
        ...(needed.missing.includes('keep_clear') ? { keepClear: [], keepClearConfirmed: true } : {}),
        ...(needed.missing.includes('wiring_method') ? { wiringMethodConfirmed: true } : {}),
      },
      apply,
    },
  };
}

/** Fields the user answered on a card: taken from the card itself, not the model's copy. */
export function withPinnedAnswers(modelInput: Record<string, unknown>): Record<string, unknown> {
  return pinnedAnswers(modelInput).args;
}

/** Overlay the user's last card answer; `fromCard` = this call resumes that card. */
export function pinnedAnswers(modelInput: Record<string, unknown>, runId?: string): { args: Record<string, unknown>; fromCard: boolean; cardKeys: string[]; askedPanels: string[] } {
  const pinned = takePinnedResume('suggest_runs', runId, args =>
    args.page === modelInput.page && (!modelInput.documentId || args.documentId === modelInput.documentId));
  const none = { args: modelInput, fromCard: false, cardKeys: [], askedPanels: [] };
  if (!pinned) return none;
  // Carry the entire original request, including fixture VA and circuit selections.
  // Only paths actually answered on this card confer user-confirmed provenance.
  const { answeredPaths: rawPaths, ...out } = pinned;
  const paths = Array.isArray(rawPaths) ? rawPaths.map(String) : [];
  const keys = paths.map(p => p.split(/[.#]/)[0]);
  if (paths.includes('settings.wiringMethod')) keys.push('wiringMethodConfirmed');
  const askedPanels = paths.flatMap(path => {
    if (path === 'panel' || path === 'panel.exit') return [(out.panel as { label?: string } | undefined)?.label || '*'];
    const match = /^panels\.(\d+)(?:\.exit)?$/.exec(path);
    if (!match) return [];
    const panel = (out.panels as Array<{ label?: string }> | undefined)?.[Number(match[1])];
    return panel?.label ? [panel.label] : [];
  });
  return {
    args: out,
    fromCard: true,
    cardKeys: [...new Set(keys)],
    askedPanels,
  };
}

/**
 * What the user already decided, per document: the wiring method they picked on a card and the
 * pages where they confirmed the keep-clear zones (none needed). Later runs reuse these instead
 * of the model's guess; a different method from the model re-asks with it pre-selected.
 */
const userDecisions = new Map<string, { wiringMethod?: WiringMethodValue; keepClearPages: Set<number> }>();
function decisionsFor(docId: string) {
  let row = userDecisions.get(docId);
  if (!row) { row = { keepClearPages: new Set() }; userDecisions.set(docId, row); }
  return row;
}
/** Tests: forget remembered decisions. */
export function resetRunDecisions(): void {
  userDecisions.clear();
}

/** "1/8\" = 1'-0\"" style text for a feet-per-point scale (72 pt per inch). */
export function scaleText(ftPerPt: number): string {
  const inPerFt = 1 / ftPerPt / 72;
  const known: Array<[number, string]> = [[1 / 32, '1/32'], [1 / 16, '1/16'], [3 / 32, '3/32'], [1 / 8, '1/8'], [3 / 16, '3/16'], [1 / 4, '1/4'], [3 / 8, '3/8'], [1 / 2, '1/2'], [3 / 4, '3/4'], [1, '1'], [1.5, '1-1/2'], [3, '3']];
  const hit = known.find(([v]) => Math.abs(v - inPerFt) / v < 0.03);
  return hit ? `${hit[1]}" = 1'-0"` : `1" = ${Math.round((1 / inPerFt) * 10) / 10}'`;
}

function runScales(docId: string, pageNumber: number, page: ZonePageInput, zones: PageZone[], devices: Pt[]) {
  const canvas = useCanvasStore.getState();
  const calibration = canvas.pageCalibrationsByDoc[docId]?.[pageNumber];
  let cal: { ftPerPt: number; text: string } | null = null;
  if (calibration?.pixelsPerUnit && calibration.unit) {
    const unit = calibration.unit.toLowerCase();
    const perUnitFt = unit.startsWith('ft') || unit === "'" ? 1 : unit.startsWith('in') ? 1 / 12 : unit === 'm' ? 3.28084 : null;
    if (perUnitFt) {
      const ftPerPt = perUnitFt / calibration.pixelsPerUnit;
      cal = { ftPerPt, text: scaleText(ftPerPt) };
    }
  }
  const view = findViewScale(page, zones, devices);
  return { calibration: cal, printed: view ? { ftPerPt: view.ftPerPt, text: view.text } : null };
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
    // Indoor / concealed branch-circuit lines decide the method; weigh them more.
    const weight = /INDOOR|CONCEALED|BRANCH CIRCUIT|INTERIOR/.test(line) ? 2 : 1;
    if (/\bEMT\b|ELECTRICAL METALLIC TUBING/.test(line)) score.EMT += weight;
    if (/\bTYPE MC\b|\bMC CABLE\b|METAL[- ]CLAD CABLE|\bAC,? (OR )?MC\b/.test(line)) score.MC += weight;
    // PVC in specs is mostly underground / below slab / exterior — not the branch-circuit method.
    if (/\bPVC\b|RIGID NONMETALLIC/.test(line) && !/UNDERGROUND|BELOW (GRADE|SLAB)|UNDER SLAB|IN SLAB|BURI|DUCT BANK|EXTERIOR|DIRECT BURIAL|CONCRETE ENCASED/.test(line)) score.PVC40 += weight;
    if (/\bRMC\b|RIGID METAL CONDUIT|RIGID STEEL/.test(line)) score.RMC += 1;
  }
  const ranked = (Object.entries(score) as Array<[WiringMethodValue, number]>).sort((a, b) => b[1] - a[1]);
  if (!ranked[0][1] || ranked[0][1] === ranked[1][1]) return undefined;
  return ranked[0][0];
}

type TitleText = { str: string; x: number; y: number; width: number; height: number };

/**
 * Floor plan views from their printed titles ("SECOND FLOOR ELECTRICAL PLAN" under the upper
 * plan, "FIRST FLOOR ELECTRICAL PLAN" under the lower one). Titles sit under / at the lower
 * left of their view, so each view runs from the previous title to its own.
 */
export function floorViewsFromTitles(textItems: TitleText[], area: Box): Array<{ box: Box; level: { n: number; name: string }; title: string }> {
  // Rebuild lines: PDF text often splits a title into words.
  const sorted = textItems.filter(t => t.str.trim() && t.height > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TitleText[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(item.y - last.y) < last.height * 0.5 && item.x - (last.x + last.width) < last.height * 2 && item.x >= last.x) {
      last.str = `${last.str} ${item.str.trim()}`;
      last.width = item.x + item.width - last.x;
      last.height = Math.max(last.height, item.height);
    } else {
      lines.push({ ...item, str: item.str.trim() });
    }
  }
  const byLevel = new Map<number, { line: TitleText; level: { n: number; name: string } }>();
  for (const line of lines) {
    const text = line.str.toUpperCase().replace(/\s+/g, ' ');
    if (text.length > 60 || !/\bPLAN\b/.test(text) || /\b(SEE|REFER|ON|TO)\b/.test(text)) continue;
    // The title starts with the level ("2 SECOND FLOOR ..." view number allowed).
    if (!/^(\d{1,2}\s+)?(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|GROUND|BASEMENT|LOWER|MAIN|LEVEL|\d{1,2}(ST|ND|RD|TH))\b/.test(text)) continue;
    const level = floorLevel(text);
    if (!level) continue;
    const cx = line.x + line.width / 2;
    const cy = line.y + line.height / 2;
    if (cx < area.x || cx > area.x + area.width || cy < area.y || cy > area.y + area.height) continue;
    const prev = byLevel.get(level.n);
    if (!prev || line.height > prev.line.height) byLevel.set(level.n, { line, level });
  }
  const titles = [...byLevel.values()];
  if (titles.length < 2) return [];
  const ys = titles.map(t => t.line.y);
  const xs = titles.map(t => t.line.x);
  const stacked = Math.max(...ys) - Math.min(...ys) > area.height * 0.2;
  const out: Array<{ box: Box; level: { n: number; name: string }; title: string }> = [];
  if (stacked) {
    titles.sort((a, b) => a.line.y - b.line.y);
    let top = area.y;
    titles.forEach((t, i) => {
      const bottom = i === titles.length - 1 ? area.y + area.height : t.line.y + t.line.height * 3;
      out.push({ box: { x: area.x, y: top, width: area.width, height: Math.max(1, bottom - top) }, level: t.level, title: t.line.str });
      top = bottom;
    });
  } else if (Math.max(...xs) - Math.min(...xs) > area.width * 0.2) {
    titles.sort((a, b) => a.line.x - b.line.x);
    titles.forEach((t, i) => {
      const left = i === 0 ? area.x : t.line.x - t.line.height * 2;
      const right = i === titles.length - 1 ? area.x + area.width : titles[i + 1].line.x - titles[i + 1].line.height * 2;
      out.push({ box: { x: left, y: area.y, width: Math.max(1, right - left), height: area.height }, level: t.level, title: t.line.str });
    });
  }
  return out;
}

/** A home run that changes floors: riser point on the circuits' floor, stacked over the panel. */
export type PanelRiser = {
  point: Pt;
  panelPoint: Pt;
  /** Where the run resumes on the panel's floor (when not stacked over the panel). */
  arrival?: Pt;
  /** Run on the panel's floor from the arrival point back to the panel. */
  horizontalFt?: number;
  direction: 'up' | 'down';
  ft: number;
  levels: number;
  fromLevel?: string;
  toLevel?: string;
};

const ORDINALS: Record<string, number> = {
  FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7, EIGHTH: 8, NINTH: 9, TENTH: 10,
  GROUND: 1, MAIN: 1, BASEMENT: 0, LOWER: 0, CELLAR: 0,
};

/** Floor number from a plan view title ("SECOND FLOOR LIGHTING PLAN", "LEVEL 3", "2ND FLOOR"). */
export function floorLevel(label: string): { n: number; name: string } | null {
  const t = label.toUpperCase();
  const word = t.match(/\b(FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|GROUND|MAIN|BASEMENT|LOWER|CELLAR)\b(?:\s+(?:FLOOR|LEVEL))?/);
  if (word && (/(FLOOR|LEVEL)/.test(t) || ['BASEMENT', 'CELLAR', 'GROUND'].includes(word[1]))) {
    const n = ORDINALS[word[1]];
    return { n, name: n === 0 ? 'Basement' : `Level ${n}` };
  }
  const num = t.match(/\b(?:LEVEL|FLOOR|LVL)\s*(\d{1,2})\b/) || t.match(/\b(\d{1,2})(?:ST|ND|RD|TH)\s+(?:FLOOR|LEVEL)\b/);
  if (num) {
    const n = Number(num[1]);
    return { n, name: `Level ${n}` };
  }
  return null;
}

/**
 * Plan views of a stacked building share a footprint: the panel's spot in its own view, mapped
 * to the same relative spot in the other floor's view, is where the riser goes.
 */
export function riserBetween(
  panelBox: Box,
  circuitBox: Box,
  panelPoint: Pt,
  panelLevel: { n: number; name: string } | null,
  circuitLevel: { n: number; name: string } | null,
  floorToFloorFt: number,
  /** Grid-bubble shift from the panel's view to the circuits' view, when known. */
  shift?: Pt | null,
): Omit<PanelRiser, 'panelPoint'> {
  const rx = panelBox.width > 0 ? (panelPoint.x - panelBox.x) / panelBox.width : 0.5;
  const ry = panelBox.height > 0 ? (panelPoint.y - panelBox.y) / panelBox.height : 0.5;
  const clamp = (v: number) => Math.min(0.98, Math.max(0.02, v));
  const point = shift
    ? insideBox({ x: panelPoint.x + shift.x, y: panelPoint.y + shift.y }, circuitBox)
    : { x: circuitBox.x + clamp(rx) * circuitBox.width, y: circuitBox.y + clamp(ry) * circuitBox.height };
  const levels = panelLevel && circuitLevel ? Math.max(1, Math.abs(circuitLevel.n - panelLevel.n)) : 1;
  // Circuits above their panel go down to it; below it, up.
  const direction: 'up' | 'down' = panelLevel && circuitLevel && circuitLevel.n < panelLevel.n ? 'up' : 'down';
  return {
    point,
    direction,
    levels,
    ft: Math.round(levels * floorToFloorFt * 10) / 10,
    ...(circuitLevel ? { fromLevel: circuitLevel.name } : {}),
    ...(panelLevel ? { toLevel: panelLevel.name } : {}),
  };
}

/** Same relative spot in another view (stacked floor plans share a footprint). */
export function mapBetweenViews(p: Pt, from: Box, to: Box): Pt {
  const rx = from.width > 0 ? (p.x - from.x) / from.width : 0.5;
  const ry = from.height > 0 ? (p.y - from.y) / from.height : 0.5;
  return { x: to.x + rx * to.width, y: to.y + ry * to.height };
}

/** Split one floor's circuits into 1–3 riser groups by where they sit along the floor. */
export function riserGroups<T extends { devices: Pt[] }>(circuits: T[], view: Box): T[][] {
  if (circuits.length < 2) return [circuits];
  const horizontal = view.width >= view.height;
  const pos = (c: T) => {
    const xs = c.devices.map(d => (horizontal ? d.x : d.y));
    return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  };
  const sorted = [...circuits].sort((a, b) => pos(a) - pos(b));
  const span = horizontal ? view.width : view.height;
  const gaps = sorted.slice(1).map((c, i) => ({ i: i + 1, gap: pos(c) - pos(sorted[i]) }))
    .filter(g => g.gap > span * 0.25)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i);
  if (!gaps.length) return [circuits];
  const out: T[][] = [];
  let start = 0;
  for (const g of gaps) { out.push(sorted.slice(start, g.i)); start = g.i; }
  out.push(sorted.slice(start));
  return out.filter(g => g.length);
}

/** Text for the continuation: "↓ to Panel B (Level 1)". */
export function riserText(panel: string, riser: Pick<PanelRiser, 'direction' | 'toLevel'>): string {
  return `${riser.direction === 'up' ? '↑' : '↓'} to Panel ${panel}${riser.toLevel ? ` (${riser.toLevel})` : ' (other floor)'}`;
}

export async function prepareRunPlan(
  input: SuggestRunsInput,
  /**
   * strict: the tool call path — the user's inputs come from the page / their card answers, not
   * the model's arguments. fromCard: this call resumes the user's card answer.
   */
  opts: { strict?: boolean; fromCard?: boolean; cardKeys?: readonly string[]; askedPanels?: readonly string[] } = {},
): Promise<Prepared> {
  const resolved = resolveDocumentRef(input.documentId);
  if ('error' in resolved) return { needs: 'document', message: resolved.error };
  const docId = resolved.docId;
  // Model-drafted keep-clear boxes (not from the card) are only suggestions for the card.
  let modelKeepClear: SuggestRunsInput['keepClear'];
  const card = new Set(opts.fromCard ? opts.cardKeys || [] : []);
  if (opts.strict) {
    input = { ...input };
    const decided = decisionsFor(docId);
    const picked = input.settings?.wiringMethod as WiringMethodValue | undefined;
    const materialAnswered = card.has('wiringMethodConfirmed') && input.wiringMethodConfirmed && picked;
    // Persist the answer only after any drawing-input commit below succeeds.
    if (!materialAnswered) {
      if (decided.wiringMethod && (!picked || picked === decided.wiringMethod)) {
        input.wiringMethodConfirmed = true;
        input.settings = { ...(input.settings || {}), wiringMethod: decided.wiringMethod } as SuggestRunsInput['settings'];
      } else input.wiringMethodConfirmed = false;
    }
    if (!card.has('keepClear')) {
      modelKeepClear = input.keepClear?.length ? input.keepClear : undefined;
      if (decided.keepClearPages.has(input.page)) { input.keepClear = []; input.keepClearConfirmed = true; }
      else { input.keepClear = undefined; input.keepClearConfirmed = false; }
    }
  }
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
    page = await getZoneInputs(pdfPage);
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
  // Runs tie to the count markers actually on the print (same frame the user sees), so a
  // string lands on its fixtures and follows them when one is moved.
  const identityGeometry: PageGeometry = { ...geometry, renderScale: 1 };
  const renderSize = getRenderPageSize(identityGeometry);
  const sx = renderSize.width > 0 ? W / renderSize.width : 1;
  const sy = renderSize.height > 0 ? H / renderSize.height : 1;
  const markerByItem = new Map<string, { id: string; pt: Pt }>();
  for (const m of canvas.getMarkupsByPage(docId)[input.page] || []) {
    if (m.type !== 'count-marker') continue;
    const linked = (m as { aiLinkedItemId?: string }).aiLinkedItemId;
    const x = (m as { x?: number }).x;
    const y = (m as { y?: number }).y;
    if (!linked || typeof x !== 'number' || typeof y !== 'number') continue;
    const r = docToRender({ x, y }, identityGeometry);
    const prev = markerByItem.get(linked);
    // Prefer the real count over a review marker for the same item.
    if (!prev || !(m as { reviewMarker?: boolean }).reviewMarker) markerByItem.set(linked, { id: m.id, pt: { x: r.x * sx, y: r.y * sy } });
  }
  // The user's own inputs live on the page: the keep-clear boxes they drew and the panels they
  // clicked are committed (locked) the moment they answer the card, and every later run reads
  // them back from there — never from the model's re-typed coordinates.
  const docMax = Math.max(geometry.docWidth, geometry.docHeight) || 3000;
  const pageMarkups = () => useCanvasStore.getState().getMarkupsByPage(docId)[input.page] || [];
  const markupBox = (m: CanvasMarkup): Box => {
    const r = m as RectangleMarkup;
    const a = docToRender({ x: r.x, y: r.y }, identityGeometry);
    const b = docToRender({ x: r.x + r.width, y: r.y + r.height }, identityGeometry);
    return { x: Math.min(a.x, b.x) * sx, y: Math.min(a.y, b.y) * sy, width: Math.abs(b.x - a.x) * sx, height: Math.abs(b.y - a.y) * sy };
  };
  const pctBox = (a: { x?: number; y?: number; width?: number; height?: number }): Box => ({
    x: ((a.x ?? 0) / 100) * W, y: ((a.y ?? 0) / 100) * H, width: ((a.width ?? 0) / 100) * W, height: ((a.height ?? 0) / 100) * H,
  });
  const asked = new Set((opts.fromCard ? opts.askedPanels || [] : []).map(l => (l === '*' ? '*' : normPanelLabel(l))));
  if (opts.strict && (card.has('keepClear') || asked.size)) {
    const existing = pageMarkups();
    const commit: Array<{ page: number; markup: CanvasMarkup }> = [];
    const replaced: string[] = [];
    if (card.has('keepClear')) {
      const placedZones = existing.filter(m => m.type === 'rectangle' && m.aiRun?.kind === 'keepout').map(markupBox);
      (input.keepClear || []).forEach((area, i) => {
        const box = pctBox(area);
        if (!(box.width > 0 && box.height > 0) || placedZones.some(z => sameBox(z, box))) return;
        commit.push({ page: input.page, markup: keepoutMarker(box, area.label || `Keep clear ${placedZones.length + i + 1}`, identityGeometry, input.page, docMax, 0, true) });
      });
    }
    if (asked.size) {
      // Only the spots the user clicked on this card (not panels found from the sheet text).
      const picked = [...(input.panels || []), ...(input.panel ? [input.panel] : [])]
        .filter(p => p.offSheet ? !!p.exit : typeof p.x === 'number' && typeof p.y === 'number')
        .filter(p => asked.has('*') || asked.has(normPanelLabel(p.label)));
      for (const p of picked) {
        const label = (p.label || '').trim();
        // Re-picked on a card: the new spot replaces that panel's old marker.
        for (const m of existing) if (m.aiRun?.kind === 'panel' && m.aiRun.userPlaced && normPanelLabel(m.aiRun.panel) === normPanelLabel(label)) replaced.push(m.id);
        const marker = panelMarker(toDisplay(p.offSheet ? p.exit as Pt : { x: p.x as number, y: p.y as number }), label, identityGeometry, input.page, docMax, 0, true);
        if (p.offSheet) {
          marker.aiRun!.offSheet = true;
          marker.label = `To panel ${label} (other sheet)`;
          marker.aiNote = `Continuation point placed by you. Home runs leave this plan here for panel ${label}.`;
        }
        commit.push({ page: input.page, markup: marker });
      }
    }
    if (commit.length) {
      try {
        const result = useCanvasStore.getState().addAIMarkupBatch(commit, false, {
          documentId: docId, replaceIdsByPage: { [input.page]: replaced },
        });
        if (!result.ok) return { needs: 'document', message: `Could not save your drawing inputs: ${result.reason || 'placement failed'}. No runs were generated.` };
      } catch (err) {
        console.warn('[suggest_runs] could not lock the user inputs on the page', err);
        return { needs: 'document', message: 'Could not save your drawing inputs. No runs were generated; please retry.' };
      }
    }
  }
  if (opts.strict) {
    const decided = decisionsFor(docId);
    if (card.has('wiringMethodConfirmed') && input.wiringMethodConfirmed && input.settings?.wiringMethod) decided.wiringMethod = input.settings.wiringMethod;
    if (card.has('keepClear')) decided.keepClearPages.add(input.page);
  }
  // Panels the user placed on this page (label → point), the truth for every run.
  const userPanels = new Map<string, Pt>();
  const userExits = new Set<string>();
  for (const m of pageMarkups()) {
    if (m.type !== 'rectangle' || m.aiRun?.kind !== 'panel' || !m.aiRun.userPlaced) continue;
    const b = markupBox(m);
    userPanels.set(normPanelLabel(m.aiRun.panel), { x: b.x + b.width / 2, y: b.y + b.height / 2 });
    if (m.aiRun.offSheet) userExits.add(normPanelLabel(m.aiRun.panel));
  }

  const anchorByPoint = new Map<string, string>();
  const devicePoint = (id: string): Pt | null => {
    const marker = markerByItem.get(id);
    if (marker) {
      anchorByPoint.set(pointKey(marker.pt), marker.id);
      return marker.pt;
    }
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
    const perDevice = c.vaPerDevice ?? (c.loadAmps == null ? input.autoCircuits?.vaPerDevice : undefined);
    const loadVA = c.loadVA ?? (perDevice ? perDevice * devices.length : undefined);
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
  // Indexed pages keep only their title lines in `lines` (memory); the full page text (panel
  // schedules, spec sections) lives in `text`.
  const projectLines = allIndexedPages().flatMap(row => [
    ...(row.lines || []).map(line => line.text),
    ...(row.text ? row.text.split('\n') : []),
  ]);
  const scheduleNames = panelNamesFromSchedules(projectLines);
  const specMethod = specWiringMethod(projectLines);
  const normPanel = (t?: string) => (t || '').toUpperCase().replace(/^PANEL(?:BOARD)?\s*/, '').replace(/[^A-Z0-9-]/g, '');
  // Panels the user picked on the multi-select card.
  const chosenPanels = [...new Set((input.panelLabels || []).map(normPanel).filter(Boolean))];
  const useTags = input.autoCircuits?.useCircuitTags !== false;
  const tagged = useTags
    ? circuitsFromTags([...poolDevices, ...extraPoints], page, { ...loadDefaults, knownPanels: scheduleNames })
    : null;
  const modelCircuitsAreTags = circuits.length > 1 && circuits.every(c => !!c.panel);
  const lumped = circuits.length <= 1 || circuits.some(c => c.devices.length > 24);
  let usedTags = false;
  // Partial tagging still counts: engineers often tag one fixture per group.
  // The user picked several panels: the tags are the only way to split the circuits, whatever
  // their coverage (untagged fixtures follow the nearest tagged ones).
  const tagsUsable = !!tagged && tagged.circuits.length > 0
    && (tagged.coverage >= 0.3 || (tagged.circuits.length >= 2 && tagged.coverage >= 0.12) || chosenPanels.length > 1);
  if (tagged && tagsUsable && (!circuits.length || lumped || !modelCircuitsAreTags)) {
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
  const viewZones = zones.filter(z => z.kind === 'plan' && z.source === 'view');
  let viewBoxes: Box[] = viewZones.map(z => ({
    x: (z.bounds.x / 100) * W, y: (z.bounds.y / 100) * H, width: (z.bounds.width / 100) * W, height: (z.bounds.height / 100) * H,
  }));
  let viewLevels = viewZones.map(z => floorLevel(z.label || ''));
  // Zoning missed the split (e.g. grid lines join the first and second floor plans into one
  // drawing): the floor-plan titles printed under each view still divide the sheet.
  // Also when zoning found several views but can't tell the floors apart (unlabelled views, or one
  // view spanning both floors): the floor titles win whenever they name 2+ different floors.
  const distinctLevels = (levels: Array<{ n: number } | null>) => new Set(levels.flatMap(l => (l ? [l.n] : []))).size;
  if (viewBoxes.length <= 1 || distinctLevels(viewLevels) < 2) {
    const titleBlock = zones.find(z => z.kind === 'title_block');
    const sheetArea = { x: 0, y: 0, width: titleBlock && titleBlock.bounds.x > 50 ? (titleBlock.bounds.x / 100) * W : W, height: H };
    const area = viewBoxes.length === 1 ? viewBoxes[0] : sheetArea;
    const fromTitles = floorViewsFromTitles(page.textItems, area);
    if (fromTitles.length > 1 && (viewBoxes.length <= 1 || distinctLevels(fromTitles.map(v => v.level)) >= 2)) {
      viewBoxes = fromTitles.map(v => v.box);
      viewLevels = fromTitles.map(v => v.level);
    }
  }
  // Each view's floor comes from the title printed under it ("2 SECOND FLOOR ELECTRICAL PLAN"
  // sits below the upper plan). Zoning can pair a view with the neighbouring view's title;
  // when the titles name a different floor for every view, they win.
  if (viewBoxes.length > 1) {
    const titleBlock = zones.find(z => z.kind === 'title_block');
    const sheetArea = { x: 0, y: 0, width: titleBlock && titleBlock.bounds.x > 50 ? (titleBlock.bounds.x / 100) * W : W, height: H };
    const fromTitles = floorViewsFromTitles(page.textItems, sheetArea);
    if (fromTitles.length > 1) {
      const levels = viewBoxes.map(b => {
        const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        return fromTitles.find(t => c.x >= t.box.x && c.x <= t.box.x + t.box.width && c.y >= t.box.y && c.y <= t.box.y + t.box.height)?.level ?? null;
      });
      if (levels.every(Boolean) && distinctLevels(levels) === viewBoxes.length) viewLevels = levels;
    }
  }
  // Rough view boxes include the white space around each plan: trim them to the line work so
  // risers and routes stay on the drawing.
  if (viewBoxes.length > 1) viewBoxes = viewBoxes.map(b => tightenToDrawing(b, page.segments));
  // Fixtures / a panel in the white space or just outside a view belong to the nearest view.
  const viewOf = (p: Pt) => viewIndexOf(p, viewBoxes);
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

  // The user picked the panels: every circuit goes to one of them — its own tag when it names a
  // chosen panel, else the chosen panel whose tagged circuits sit nearest.
  if (chosenPanels.length > 1) {
    // Owners: the chosen panels' tagged circuits, plus every printed tag of a chosen panel (so a
    // panel whose tags sit next to untagged fixtures still gets them).
    const owners: Array<{ panel?: string; devices: Pt[] }> = [
      ...circuits.filter(c => c.panel && chosenPanels.includes(normPanel(c.panel))),
      ...chosenPanels.map(panel => ({
        panel,
        devices: readCircuitTags(page.textItems, scheduleNames).filter(t => normPanel(t.panel) === panel).map(t => ({ x: t.x, y: t.y })),
      })).filter(o => o.devices.length),
    ];
    circuits = circuits.map(c => {
      if (c.panel && chosenPanels.includes(normPanel(c.panel))) return { ...c, panel: normPanel(c.panel) };
      let best: { panel: string; d: number } | null = null;
      for (const owner of owners) {
        for (const a of owner.devices) {
          for (const b of c.devices) {
            const d = Math.hypot(a.x - b.x, a.y - b.y) + (viewBoxes.length > 1 && viewOf(a) !== viewOf(b) ? W + H : 0);
            if (!best || d < best.d) best = { panel: normPanel(owner.panel), d };
          }
        }
      }
      return { ...c, panel: best?.panel || chosenPanels[0] };
    });
  }

  // Panels: from the circuit tags (confirmed against the panel schedules) or the one given.
  const normLabel = (t?: string) => (t || '').toUpperCase().replace(/^PANEL(?:BOARD)?\s*/, '').replace(/[^A-Z0-9]/g, '');
  const givenPanels = [
    ...(input.panels || []),
    ...(input.panel ? [{ ...input.panel, label: input.panel.label || '' }] : []),
    // One panel picked on the multi-select = "all home runs to this panel".
    ...(chosenPanels.length === 1 && !input.panel?.label ? [{ label: chosenPanels[0] }] : []),
    ...(chosenPanels.length > 1 ? chosenPanels.filter(name => !(input.panels || []).some(p => normLabel(p.label) === normLabel(name))).map(label => ({ label })) : []),
  ] as Array<{ label: string; x?: number; y?: number; offSheet?: boolean; exit?: Pt }>;
  const tagPanels = panelsFromCircuits(circuits);
  // Circuits that name their panel (engineer tags read from the sheet, or circuits like "B-4"
  // the model passed) get one set of home runs per panel — never a "which panel?" question.
  const namedPanels = givenPanels.map(p => normLabel(p.label)).filter(Boolean);
  // An explicit panel the tags don't mention (the user's choice) wins over the circuit names.
  const perPanel = tagPanels.length > 0
    && (usedTags || !namedPanels.length || namedPanels.some(n => tagPanels.some(t => normLabel(t.panel) === n)));
  type PanelPlan = { label: string; point: Pt | null; offSheet: boolean; candidates: Array<{ text: string; point: Pt }>; circuits: PlannedCircuit[]; riser?: PanelRiser };
  const resolvePanel = (label: string, given?: { x?: number; y?: number; offSheet?: boolean; exit?: Pt }): Omit<PanelPlan, 'circuits'> => {
    // Where the user put the panel on the page wins over any coordinates in the arguments.
    const placed = userPanels.get(normPanelLabel(label)) || (userPanels.size === 1 && !label ? [...userPanels.values()][0] : undefined);
    if (placed && !input.reviewPanelLocations) return { label, point: placed, offSheet: userExits.has(normPanelLabel(label)), candidates: [] };
    if (given?.offSheet) return { label, point: !input.reviewPanelLocations && given.exit && (!opts.strict || asked.has('*') || asked.has(normPanelLabel(label))) ? toDisplay(given.exit) : null, offSheet: true, candidates: [] };
    // Strict: a model-typed spot for a panel the user hasn't placed isn't trusted — ask instead.
    if (opts.strict && !asked.has('*') && !asked.has(normPanelLabel(label)) && given) given = { ...given, x: undefined, y: undefined };
    if (!input.reviewPanelLocations && typeof given?.x === 'number' && typeof given?.y === 'number') return { label, point: toDisplay({ x: given.x, y: given.y }), offSheet: false, candidates: [] };
    const candidates = label ? findPanelLabel(page, zones, label) : [];
    return { label, point: !input.reviewPanelLocations && candidates.length === 1 ? candidates[0].point : null, offSheet: false, candidates };
  };
  let panelPlans: PanelPlan[];
  if (perPanel) {
    // Every panel the user picked gets its location asked, even one no counted fixture is on.
    const top = (chosenPanels.length > 1
      ? [
        ...tagPanels.filter(t => chosenPanels.includes(normPanel(t.panel))),
        ...chosenPanels.filter(name => !tagPanels.some(t => normPanel(t.panel) === name)).map(panel => ({ panel, circuits: 0, devices: 0 })),
      ]
      : tagPanels).slice(0, 6);
    panelPlans = top.map(row => {
      const given = givenPanels.find(p => normLabel(p.label) === normLabel(row.panel))
        || (top.length === 1 && givenPanels.length === 1 && !givenPanels[0].label ? givenPanels[0] : undefined);
      return { ...resolvePanel(row.panel, given), circuits: circuits.filter(c => c.panel === row.panel) };
    });
    // Untagged / overflow circuits ride with the panel whose circuits sit nearest (same floor
    // first), not all with the busiest panel.
    const assigned = new Set(panelPlans.flatMap(p => p.circuits.map(c => c.id)));
    for (const c of circuits.filter(c => !assigned.has(c.id))) {
      let best: { plan: PanelPlan; d: number } | null = null;
      for (const plan of panelPlans) {
        for (const other of plan.circuits) {
          for (const a of other.devices) {
            for (const b of c.devices) {
              const d = Math.hypot(a.x - b.x, a.y - b.y) + (viewBoxes.length > 1 && viewOf(a) !== viewOf(b) ? W + H : 0);
              if (!best || d < best.d) best = { plan, d };
            }
          }
        }
      }
      (best?.plan || panelPlans[0]).circuits.push(c);
    }
  } else {
    const given = givenPanels[0];
    const label = given?.label?.trim() || '';
    panelPlans = [{ ...resolvePanel(label, given), circuits }];
  }

  // Keep-clear areas: found from room labels; the user's marked areas are added.
  const allDevicePts = circuits.flatMap(c => c.devices);
  const routing = planRoutingContext(page, zones, allDevicePts, panelPlans.flatMap(p => (p.point ? [p.point] : [])));
  // Keep-clear zones already on the page are locked there: always routed around, never moved
  // or re-drawn by a new run (the user deletes one to drop it).
  const lockedZones: Obstacle[] = [];
  for (const m of pageMarkups()) {
    if (m.type !== 'rectangle' || m.aiRun?.kind !== 'keepout') continue;
    const box = markupBox(m);
    lockedZones.push({ kind: 'opening', label: (m.label || 'Keep clear').replace(/^Keep clear:\s*/, ''), box, placed: true });
  }
  const newZones: Obstacle[] = (input.keepClear || []).map((area, i) => ({
    kind: 'opening' as const,
    label: area.label || `Keep clear ${lockedZones.length + i + 1}`,
    box: { x: (area.x / 100) * W, y: (area.y / 100) * H, width: (area.width / 100) * W, height: (area.height / 100) * H },
    userZone: true,
  })).filter(z => z.box.width > 0 && z.box.height > 0 && !lockedZones.some(l => sameBox(l.box, z.box)));
  const userKeepClear: Obstacle[] = [...lockedZones, ...newZones];

  const missing: RunInputNeeded['missing'] = [];
  const needLocation = panelPlans.filter(p => !p.point);
  if (needLocation.length) missing.push('panel_location');
  if (!perPanel && needLocation.length && !panelPlans[0].label) missing.push('panel_label');
  // Which panel: the circuit tags printed on this sheet first, then the panel schedules.
  const sheetTagPanels = panelsTaggedOnSheet(page.textItems, scheduleNames);
  const panelSuggestions = suggestPanels(
    [...new Set([...panelsFromCircuits(circuits).map(r => r.panel), ...sheetTagPanels.map(r => r.panel)])],
    scheduleNames,
  );
  const panelHint = [
    sheetTagPanels.length
      ? `Circuit tags on this sheet: ${sheetTagPanels.slice(0, 3).map(r => `${r.examples.join(', ')}${r.tags > r.examples.length ? '…' : ''} (panel ${r.panel})`).join('; ')}.`
      : 'No panel-circuit tags printed next to these fixtures.',
    scheduleNames.length ? `Panel schedules list ${scheduleNames.slice(0, 6).join(', ')}.` : 'No panel schedule found in the indexed sheets.',
  ].join(' ');
  // The wiring method is always the estimator's call: ask every time (recommending what the
  // prints / specs / model suggest) until they've picked it.
  if (!input.wiringMethodConfirmed) missing.push('wiring_method');
  // The sheet names elevators / stairs / shafts we couldn't outline: let the user mark them.
  // Hybrid: the AI drafts boxes from the room labels and the user confirms / adjusts them on the
  // card (and can add more) before anything is routed around them.
  // Zones already locked on the page were confirmed by the user before: don't ask again.
  if (input.keepClear === undefined && !lockedZones.length && (routing.obstacles.length || routing.obstacleMentions || modelKeepClear?.length)) missing.push('keep_clear');
  // Circuiting needs a load per fixture; never stop the run over it — ask on the same card.
  const hasLoad = input.autoCircuits?.vaPerDevice != null
    || (input.circuits?.length && input.circuits.every(c => c.loadVA != null || c.vaPerDevice != null || c.loadAmps != null));
  if (!hasLoad) missing.push('fixture_load');
  // Footage must not depend on which scale happened to win: when the page calibration and the
  // plan's printed scale disagree by more than 5%, the estimator picks.
  const scales = runScales(docId, input.page, page, zones, circuits.flatMap(c => c.devices));
  const scaleConflict = scales.calibration && scales.printed
    && Math.abs(scales.calibration.ftPerPt - scales.printed.ftPerPt) / scales.printed.ftPerPt > 0.05
    ? { printed: scales.printed.text, calibration: scales.calibration.text }
    : undefined;
  if (scaleConflict && !input.scaleChoice) missing.push('scale');
  if (missing.length) {
    const toPct = (pt: Pt) => ({ x: round1((pt.x / W) * 100), y: round1((pt.y / H) * 100) });
    return {
      needs: 'input',
      message: 'Asked the user with a card for: ' + missing.join(', ') + '. Wait for their answer; it includes the exact arguments to call suggest_runs again.',
      documentId: docId,
      page: input.page,
      missing,
      panelLabel: panelPlans[0].label || undefined,
      panelOffSheet: panelPlans[0].offSheet,
      panels: perPanel
        ? panelPlans.flatMap((p, index) => (!p.point
          ? [{ label: p.label, index, circuits: p.circuits.map(c => c.id), candidates: p.candidates.slice(0, 6).map(c => ({ text: c.text, ...toPct(c.point) })), scheduled: scheduleNames.includes(p.label), offSheet: p.offSheet }]
          : []))
        : [],
      panelArgs: perPanel
        ? panelPlans.map(p => ({ label: p.label, ...(p.point ? (p.offSheet ? { exit: toPct(p.point) } : toPct(p.point)) : {}), ...(p.offSheet ? { offSheet: true } : {}) }))
        : [],
      candidates: perPanel ? [] : panelPlans[0].candidates.slice(0, 6).map(c => ({ text: c.text, ...toPct(c.point) })),
      panelNames: missing.includes('panel_label') ? panelSuggestions.map(r => r.name) : [],
      // More than one panel is tagged on the sheet or listed in the schedules: multi-select.
      panelMulti: missing.includes('panel_label') && panelSuggestions.length > 1
        && (sheetTagPanels.length > 1 || panelsFromCircuits(circuits).length > 1),
      panelRecommended: [...new Set([...panelsFromCircuits(circuits).map(r => r.panel), ...sheetTagPanels.map(r => r.panel)])],
      panelHint: missing.includes('panel_label') ? panelHint : undefined,
      recommendedWiring: input.settings?.wiringMethod || specMethod,
      ...(scaleConflict ? { scaleConflict } : {}),
      obstacleMentions: routing.obstacleMentions,
      obstaclesFound: routing.obstacles.length,
      suggestedAreas: [...routing.obstacles, ...(modelKeepClear || []).map(a => ({ label: a.label || 'Keep clear', box: pctBox(a), approximate: true }))].map(o => ({
        x: round1((o.box.x / W) * 100),
        y: round1((o.box.y / H) * 100),
        width: round1((o.box.width / W) * 100),
        height: round1((o.box.height / H) * 100),
        label: o.label,
        ...(o.approximate ? { approximate: true } : {}),
      })),
    };
  }

  // Scale: the user's pick when calibration and the printed scale disagree; else calibration,
  // then the printed view scale.
  const scaleRows = scales;
  const pickScale = input.scaleChoice === 'printed' ? (scaleRows.printed || scaleRows.calibration)
    : (scaleRows.calibration || scaleRows.printed);
  const ftPerPt: number | null = pickScale?.ftPerPt ?? null;
  const scaleSource = pickScale ? (pickScale === scaleRows.printed ? `printed scale ${pickScale.text}` : `page calibration (${pickScale.text})`) : '';
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

  // Building outline from the drawn walls: runs, arcs and risers stay inside it — never out in
  // the white space around or between the floor plans. Grid lines (ending at grid bubbles) and
  // the schedules / notes / title block are left out; only outlines holding the fixtures or a
  // panel count.
  const footprint: Footprint | null = (() => {
    const views = viewBoxes.length > 1 ? viewBoxes : routing.allowed;
    if (!views.length) return null;
    try {
      const bubbles = findAnnotationBubbles(buildSymbolComponents(page.segments), page.textItems);
      const anchors = [...circuits.flatMap(c => c.devices), ...panelPlans.flatMap(p => (p.point ? [p.point] : []))];
      return buildFootprint(page.segments, W, H, views, bubbles, routing.blocked, anchors);
    } catch {
      return null;
    }
  })();
  const inside = (p: Pt): Pt => snapInside(footprint, p);

  // Circuits on a different plan view than their panel (another floor of a multi-story
  // building): the home run goes to a riser on its own floor — stacked over the panel — then
  // up/down to the panel, with a continuation symbol on both floors.
  const floorToFloorFt = input.settings?.floorToFloorFt ?? 12;
  if (viewBoxes.length > 1) {
    panelPlans = panelPlans.flatMap(pp => {
      if (!pp.point || pp.offSheet) return [pp];
      const panelPoint = pp.point;
      const panelView = viewOf(panelPoint);
      if (panelView < 0) return [pp];
      const majority = (c: PlannedCircuit) => {
        const counts = new Map<number, number>();
        c.devices.forEach(d => counts.set(viewOf(d), (counts.get(viewOf(d)) || 0) + 1));
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
      };
      const here = pp.circuits.filter(c => { const v = majority(c); return v === panelView || v < 0; });
      const awayByView = new Map<number, PlannedCircuit[]>();
      for (const c of pp.circuits) {
        if (here.includes(c)) continue;
        const v = majority(c);
        awayByView.set(v, [...(awayByView.get(v) || []), c]);
      }
      if (!awayByView.size) return [pp];
      const out: PanelPlan[] = [{ ...pp, circuits: here }];
      for (const [v, away] of awayByView) {
        // Stacked plans share the column/row grid: line the floors up on the grid bubbles.
        const shift = viewOffset(page.textItems, viewBoxes[panelView], viewBoxes[v]);
        const stacked = riserBetween(viewBoxes[panelView], viewBoxes[v], panelPoint, viewLevels[panelView], viewLevels[v], floorToFloorFt, shift);
        const toPanelFloor = (p: Pt) => (shift ? insideBox({ x: p.x - shift.x, y: p.y - shift.y }, viewBoxes[panelView], 0) : mapBetweenViews(p, viewBoxes[v], viewBoxes[panelView]));
        // A floor whose circuits are spread out (wings at both ends) breaks at up to 3 risers,
        // each resumed on the panel's floor and run back to the panel.
        const groups = riserGroups(away, viewBoxes[v]);
        for (const group of groups) {
          let riser: PanelRiser = { ...stacked, panelPoint };
          if (groups.length > 1) {
            const devices = group.flatMap(c => c.devices);
            const nearest = devices.reduce((best, d) => (Math.hypot(d.x - stacked.point.x, d.y - stacked.point.y) < Math.hypot(best.x - stacked.point.x, best.y - stacked.point.y) ? d : best), devices[0]);
            const point = { x: nearest.x + Math.sign(stacked.point.x - nearest.x) * viewBoxes[v].width * 0.01, y: nearest.y };
            const arrival = toPanelFloor(point);
            const horizontalFt = Math.round((Math.abs(arrival.x - panelPoint.x) + Math.abs(arrival.y - panelPoint.y)) * ftPerPt * 10) / 10;
            riser = { ...stacked, point, panelPoint, arrival, horizontalFt, ft: Math.round((stacked.ft + horizontalFt) * 10) / 10 };
          }
          // Riser and arrival symbols sit inside the building, not in the margin.
          riser = { ...riser, point: inside(riser.point), ...(riser.arrival ? { arrival: inside(riser.arrival) } : {}) };
          out.push({ label: pp.label, point: riser.point, offSheet: false, candidates: [], circuits: group, riser });
        }
      }
      return out;
    }).filter(pp => pp.circuits.length);
  }

  const plan = planAllPanels({
    page, zones, panelPlans: panelPlans.filter(p => p.circuits.length), settings, ftPerPt, scaleSource, extraObstacles: userKeepClear, allowed: routing.allowed,
    keepClearConfirmed: lockedZones.length > 0 || (!!input.keepClearConfirmed && input.keepClear !== undefined),
    floorViews: viewBoxes.length > 1 ? viewBoxes : undefined,
    footprint,
  });
  const markups = buildRunMarkups(plan, circuits, settings, geometry, input.page, anchorByPoint, new Set(userPanels.keys()));
  const materials = materialTotals(plan.runs.map(run => ({ assembly: run.assembly, lengthFt: run.lengthFt })));
  const homeRuns = plan.runs.filter(r => r.kind === 'homerun');
  const audit = auditRuns(plan.runs, {
    ftPerPt,
    floorViews: viewBoxes.length > 1 ? viewBoxes : undefined,
    keepClear: userKeepClear.map(z => ({ label: z.label, box: z.box })),
    pageMax: Math.max(W, H),
    footprint,
  });
  const codeLine = `${code.summary}${location ? ` Project: ${location.text}.` : ''}`;
  const summaryLines = [
    codeLine,
    ...homeRuns.map(r => `${r.label} · ≈${Math.round(r.lengthFt)} ft · VD ${Math.max(...r.sizing.map(s => s.vdPct)).toFixed(1)}%`),
    ...(plan.obstacles.length ? [`Routed around: ${[...new Set(plan.obstacles.map(o => o.label))].join(', ')}`] : []),
    ...(materials.length ? [`Materials: ${materials.slice(0, 6).map(m => `${m.name} ${m.ft.toLocaleString()} ft`).join(' · ')}`] : []),
    ...(usedTags ? [`Circuits from the engineer's tags: ${panelPlans.map(p => `panel ${p.label} (${p.circuits.length})`).join(', ')}`] : []),
    audit.flagged.length
      ? `Checks: ${audit.flagged.length} to review — ${audit.flagged.slice(0, 3).join(' ')}${audit.flagged.length > 3 ? ' …' : ''}`
      : `Checks passed: ${audit.passed.join(' ')}`,
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
      checks: { ...audit, note: audit.flagged.length ? 'Tell the user exactly which runs need review and why (from flagged).' : 'All layout checks passed.' },
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
  panels: Array<{ label: string; point: Pt; offSheet: boolean; riser?: PanelRiser }>;
};

/** One planRuns pass per panel; home runs numbered across panels. */
function planAllPanels(options: {
  page: ZonePageInput;
  zones: PageZone[];
  panelPlans: Array<{ label: string; point: Pt | null; offSheet: boolean; circuits: PlannedCircuit[]; riser?: PanelRiser }>;
  settings: RunSettings;
  ftPerPt: number;
  scaleSource: string;
  extraObstacles: Obstacle[];
  allowed: Box[];
  keepClearConfirmed?: boolean;
  floorViews?: Box[];
  footprint?: Footprint | null;
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
    const point = pp.point || snapInside(options.footprint, offSheetExitPoint(options.allowed, pp.circuits.flatMap(c => c.devices), options.page));
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
      keepClearConfirmed: options.keepClearConfirmed,
      floorViews: options.floorViews,
      footprint: options.footprint,
      panelOffSheet: pp.offSheet || !pp.point,
      ...(pp.riser ? { riser: { ft: pp.riser.ft, text: riserText(label, pp.riser) } } : {}),
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
    panels.push({ label, point, offSheet: pp.offSheet || !pp.point, ...(pp.riser ? { riser: pp.riser } : {}) });
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
  anchorByPoint: Map<string, string> = new Map(),
  /** Panels the user placed on the page (normalised labels). */
  placedPanels: Set<string> = new Set(),
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
    // Already on the page (locked): leave the user's zone exactly where it is.
    if (ob.placed) continue;
    out.push({ page: pageNumber, markup: keepoutMarker(ob.box, ob.label, identity, pageNumber, docMax, plan.ftPerPt, !!ob.userZone, !!ob.approximate) });
  }

  // Floor-to-floor continuations: a riser symbol where the home runs leave this floor, and a
  // matching one at the panel on the other floor.
  const riserSize = docMax * 0.007;
  const riserMarkup = (at: Pt, text: string, riser: PanelRiser, panel: string, role: 'leave' | 'arrive'): RectangleMarkup => {
    const c = toDoc(at);
    const direction = role === 'leave' ? riser.direction : riser.direction === 'up' ? 'down' : 'up';
    return {
      ...base,
      id: `run_riser_${crypto.randomUUID()}`,
      type: 'ellipse',
      x: c.x - riserSize / 2,
      y: c.y - riserSize / 2,
      width: riserSize,
      height: riserSize,
      style: style(RUN_COLOR, 'rgba(255, 255, 255, 0.9)', Math.max(1.2, docMax * 0.0008), 100),
      label: text,
      aiNote: role === 'leave'
        ? `Home runs rise/drop here to panel ${panel}${riser.toLevel ? ` on ${riser.toLevel}` : ''}: +${Math.round(riser.ft)} ft vertical per run (${riser.levels} floor${riser.levels > 1 ? 's' : ''}).`
        : `Home runs from ${riser.fromLevel || 'the other floor'} arrive at panel ${panel} here.`,
      aiRun: {
        runId: `riser-${panel}-${role}`,
        kind: 'riser',
        ftPerPt: plan.ftPerPt,
        lengthFt: 0,
        panel,
        riser: { direction, fromLevel: riser.fromLevel, toLevel: riser.toLevel, panel },
        summary: text,
      },
    };
  };
  for (const panel of plan.panels) {
    if (!panel.riser) continue;
    const r = panel.riser;
    out.push({ page: pageNumber, markup: riserMarkup(r.point, riserText(panel.label, r), r, panel.label, 'leave') });
    const offset = r.arrival || { x: r.panelPoint.x + riserSize * 1.6, y: r.panelPoint.y - riserSize * 1.6 };
    const from = `${r.direction === 'up' ? '↓' : '↑'} from ${r.fromLevel || 'other floor'}${r.horizontalFt ? ` · ${Math.round(r.horizontalFt)} ft to Panel ${panel.label}` : ''}`;
    out.push({ page: pageNumber, markup: riserMarkup(offset, from, r, panel.label, 'arrive') });
  }

  for (const panel of plan.panels) {
    if (panel.offSheet || panel.riser) continue;
    // The user's own panel marker is already on the page: never drawn twice or moved.
    if (placedPanels.has(normPanelLabel(panel.label)) || (placedPanels.has('') && placedPanels.size === 1)) continue;
    out.push({ page: pageNumber, markup: panelMarker(panel.point, panel.label, identity, pageNumber, docMax, plan.ftPerPt, false) });
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
        ...(anchorsFor(run, anchorByPoint) ? { anchors: anchorsFor(run, anchorByPoint) } : {}),
        ...(run.riserFt ? { riserFt: run.riserFt } : {}),
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

/** Stable key for a display point (anchors map fixtures → their count marker). */
export function pointKey(p: Pt): string {
  return `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}`;
}

function anchorsFor(run: PlannedRun, anchorByPoint: Map<string, string>): { start?: string; end?: string } | undefined {
  const start = run.fromPt ? anchorByPoint.get(pointKey(run.fromPt)) : undefined;
  const end = run.kind === 'branch' && run.toPt ? anchorByPoint.get(pointKey(run.toPt)) : undefined;
  if (!start && !end) return undefined;
  return { ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

const normPanelLabel = (t?: string) => (t || '').toUpperCase().replace(/^PANEL(?:BOARD)?\s*/, '').replace(/[^A-Z0-9]/g, '');

/** Only near-identical boxes are duplicates; overlapping areas can extend a keep-clear zone. */
function sameBox(p: Box, q: Box): boolean {
  return Math.abs(p.x - q.x) < 0.1 && Math.abs(p.y - q.y) < 0.1
    && Math.abs(p.width - q.width) < 0.1 && Math.abs(p.height - q.height) < 0.1;
}

function keepoutMarker(box: Box, label: string, identity: PageGeometry, pageNumber: number, docMax: number, ftPerPt: number, userZone: boolean, approximate = false): RectangleMarkup {
  const a = renderToDoc({ x: box.x, y: box.y }, identity);
  const b = renderToDoc({ x: box.x + box.width, y: box.y + box.height }, identity);
  return {
    page: pageNumber,
    author: 'BidveraAi',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    id: `run_keepout_${crypto.randomUUID()}`,
    type: 'rectangle',
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
    style: style(KEEPOUT_COLOR, 'rgba(249, 115, 22, 0.22)', Math.max(1.5, docMax * 0.0009), 100),
    label: `Keep clear: ${label}${approximate ? ' (approx.)' : ''}`,
    aiNote: `Runs routed around ${label}.`,
    // Locked to the page so a drag can't shift it; the router reads it back on every run.
    locked: true,
    aiRun: { runId: `keepout-${label}`, kind: 'keepout', ftPerPt, lengthFt: 0, summary: `Keep clear: ${label}`, ...(userZone ? { userZone: true } : {}) },
  } as RectangleMarkup;
}

function panelMarker(at: Pt, label: string, identity: PageGeometry, pageNumber: number, docMax: number, ftPerPt: number, userPlaced: boolean): RectangleMarkup {
  const c = renderToDoc(at, identity);
  const size = docMax * 0.006;
  const name = label || 'Panel';
  return {
    page: pageNumber,
    author: 'BidveraAi',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    id: `run_panel_${crypto.randomUUID()}`,
    type: 'rectangle',
    x: c.x - size,
    y: c.y - size / 2,
    width: size * 2,
    height: size,
    style: style('#111827', 'rgba(17, 24, 39, 0.85)', 1.5, 100),
    label: label ? `Panel ${label}` : 'Panel',
    aiNote: userPlaced ? `Panel ${name} — placed by you; home runs end here.` : `Home runs end at panel ${name}.`,
    // The user's panel is locked where they clicked it; runs never move or replace it.
    locked: userPlaced,
    aiRun: { runId: `panel-${label}`, kind: 'panel', ftPerPt, lengthFt: 0, panel: label, summary: `Panel ${name}`, ...(userPlaced ? { userPlaced: true } : {}) },
  } as RectangleMarkup;
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
  const rows = hits.map(item => ({ text: item.str.trim(), point: { x: item.x + item.width / 2, y: item.y + item.height / 2 } }));
  // A panel is drawn on a floor plan: when some hits sit on a plan view and others out in the
  // margin (riser diagram, one-line), only the plan-view ones are candidates.
  const planViews = zones.filter(z => (z.kind === 'plan' || z.kind === 'demo_plan') && z.source === 'view');
  const onPlan = rows.filter(r => planViews.some(z => {
    const cx = (r.point.x / W) * 100; const cy = (r.point.y / H) * 100;
    return cx >= z.bounds.x && cy >= z.bounds.y && cx <= z.bounds.x + z.bounds.width && cy <= z.bounds.y + z.bounds.height;
  }));
  return onPlan.length && onPlan.length < rows.length ? onPlan : rows;
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
