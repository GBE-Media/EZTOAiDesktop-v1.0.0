/**
 * Engineer circuit tags: plans usually print "<panel>-<circuit>" next to each fixture
 * (e.g. "B-4", "LP1-12", "B-17,19"). Use them to put devices on the right circuit and to
 * know which panels the home runs go to.
 */
import type { ZonePageInput } from '../detection/pageZones';
import type { PlannedCircuit } from './planRuns';
import type { Pt } from './spatial';

export interface CircuitTag {
  panel: string;
  circuit: string;
  id: string;
}

const TAG_RE = /^([A-Z]{1,4}\d?[A-Z]?)\s*-\s*(\d{1,3}(?:\s*[,&/]\s*\d{1,3}){0,2})$/;
/** Prefixes that look like tags but are fixture/device/sheet codes. */
const NOT_PANELS = new Set(['E', 'EL', 'EP', 'ES', 'FA', 'M', 'P', 'A0', 'T', 'S', 'TYP', 'NO', 'NTS', 'REV', 'SK']);

export function parseCircuitTag(text: string): CircuitTag | null {
  const upper = text.trim().toUpperCase();
  // "B-4" alone, or after the fixture type in one text run ("A B-4", "XA B-4").
  const m = upper.match(TAG_RE) || upper.replace(/^[A-Z]{1,3}\d?\s+(?=[A-Z])/, '').match(TAG_RE);
  if (!m) return null;
  const panel = m[1];
  const circuit = m[2].replace(/\s+/g, '');
  return { panel, circuit, id: `${panel}-${circuit}` };
}

type TextLike = { str: string; x: number; y: number; width: number; height: number };

/**
 * Circuit tags printed on the sheet, with their centre. PDF text often splits a tag into
 * pieces ("B", "-", "4" or "B-" + "4"), so neighbouring pieces on one line are joined too.
 */
export function readCircuitTags(
  textItems: TextLike[],
  knownPanels?: string[],
): Array<CircuitTag & { x: number; y: number }> {
  const out: Array<CircuitTag & { x: number; y: number }> = [];
  const allowed = (tag: CircuitTag | null): tag is CircuitTag => !!tag && (!NOT_PANELS.has(tag.panel) || !!knownPanels?.includes(tag.panel));
  const used = new Set<number>();
  textItems.forEach((item, i) => {
    const tag = parseCircuitTag(item.str);
    if (!allowed(tag)) return;
    used.add(i);
    out.push({ ...tag, x: item.x + item.width / 2, y: item.y + item.height / 2 });
  });
  // Short fragments only (a tag is at most ~10 characters).
  const pieces = textItems
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) => !used.has(i) && item.str.trim() && item.str.trim().length <= 8 && item.height > 0)
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x);
  for (let a = 0; a < pieces.length; a += 1) {
    const first = pieces[a].item;
    let text = first.str.trim();
    let right = first.x + first.width;
    const h = first.height;
    for (let b = a + 1; b < pieces.length && b <= a + 3; b += 1) {
      const next = pieces[b].item;
      if (Math.abs(next.y - first.y) > h * 0.5) break;
      const gap = next.x - right;
      if (gap < -h * 0.3 || gap > h * 0.8) break;
      text += next.str.trim();
      right = next.x + next.width;
      const tag = parseCircuitTag(text);
      if (allowed(tag)) {
        out.push({ ...tag, x: (first.x + right) / 2, y: first.y + h / 2 });
        break;
      }
    }
  }
  return out;
}

/** Panels named by the circuit tags anywhere on the sheet, most-tagged first. */
export function panelsTaggedOnSheet(textItems: TextLike[], knownPanels?: string[]): Array<{ panel: string; tags: number; examples: string[] }> {
  const rows = new Map<string, { panel: string; tags: number; examples: string[] }>();
  for (const tag of readCircuitTags(textItems, knownPanels)) {
    const row = rows.get(tag.panel) || { panel: tag.panel, tags: 0, examples: [] };
    row.tags += 1;
    if (row.examples.length < 4 && !row.examples.includes(tag.id)) row.examples.push(tag.id);
    rows.set(tag.panel, row);
  }
  // One stray match isn't a panel, unless the panel schedules list it (Panel C with one tag).
  const known = new Set((knownPanels || []).map(n => n.toUpperCase()));
  return [...rows.values()].filter(r => r.tags >= 2 || known.has(r.panel.toUpperCase())).sort((a, b) => b.tags - a.tags);
}

export interface TaggedDevice {
  point: Pt;
  itemId?: string;
}

/**
 * Assign each device the nearest circuit tag within a small radius. Devices without a tag join
 * the closest tagged circuit when it is near (engineers often tag one fixture of a group).
 */
export function circuitsFromTags(
  devices: TaggedDevice[],
  page: Pick<ZonePageInput, 'textItems' | 'pageWidth' | 'pageHeight'>,
  options: {
    vaPerDevice: number;
    voltage: number;
    phase: 1 | 3;
    continuous: boolean;
    breakerAmps?: number;
    /** Panels named in the project's panel schedules (allows names like "E" or "P"). */
    knownPanels?: string[];
    /** Recovery must not guess a missing count's circuit from its neighbour alone. */
    inferUntagged?: boolean;
  },
): { circuits: Array<PlannedCircuit & { panel: string; itemIds: string[] }>; coverage: number; untagged: TaggedDevice[] } {
  const size = Math.max(page.pageWidth, page.pageHeight);
  const radius = size * 0.02;
  const tags = readCircuitTags(page.textItems, options.knownPanels);
  const byId = new Map<string, { tag: CircuitTag; devices: TaggedDevice[] }>();
  const untagged: TaggedDevice[] = [];
  for (const device of devices) {
    let best: { tag: CircuitTag; dist: number } | null = null;
    for (const tag of tags) {
      const d = Math.hypot(tag.x - device.point.x, tag.y - device.point.y);
      if (d <= radius && (!best || d < best.dist)) best = { tag, dist: d };
    }
    if (!best) {
      untagged.push(device);
      continue;
    }
    const row = byId.get(best.tag.id) || { tag: best.tag, devices: [] };
    row.devices.push(device);
    byId.set(best.tag.id, row);
  }
  const taggedCount = devices.length - untagged.length;
  const leftover: TaggedDevice[] = [];
  if (byId.size && options.inferUntagged !== false) {
    for (const device of untagged) {
      let best: { id: string; dist: number } | null = null;
      for (const [id, row] of byId) {
        for (const other of row.devices) {
          const d = Math.hypot(other.point.x - device.point.x, other.point.y - device.point.y);
          if (d <= radius * 3 && (!best || d < best.dist)) best = { id, dist: d };
        }
      }
      if (best) byId.get(best.id)?.devices.push(device);
      else leftover.push(device);
    }
  }
  const circuits = [...byId.values()]
    .sort((a, b) => a.tag.panel.localeCompare(b.tag.panel) || Number.parseInt(a.tag.circuit, 10) - Number.parseInt(b.tag.circuit, 10))
    .map(({ tag, devices: pts }) => ({
      id: tag.id,
      label: tag.id,
      panel: tag.panel,
      devices: pts.map(d => d.point),
      itemIds: pts.map(d => d.itemId).filter((id): id is string => !!id),
      loadVA: pts.length * options.vaPerDevice,
      voltage: options.voltage,
      // Multi-pole tags ("B-17,19") are 208/240 V circuits.
      phase: options.phase,
      continuous: options.continuous,
      ...(options.breakerAmps ? { ocpdAmps: options.breakerAmps } : {}),
    }));
  return {
    circuits,
    coverage: devices.length ? taggedCount / devices.length : 0,
    untagged: byId.size && options.inferUntagged !== false ? leftover : untagged,
  };
}

/** Panels referenced by circuit tags, most-used first. */
export function panelsFromCircuits(circuits: Array<{ panel?: string; devices: Pt[] }>): Array<{ panel: string; circuits: number; devices: number }> {
  const rows = new Map<string, { panel: string; circuits: number; devices: number }>();
  for (const c of circuits) {
    if (!c.panel) continue;
    const row = rows.get(c.panel) || { panel: c.panel, circuits: 0, devices: 0 };
    row.circuits += 1;
    row.devices += c.devices.length;
    rows.set(c.panel, row);
  }
  return [...rows.values()].sort((a, b) => b.devices - a.devices);
}

/**
 * Panel names from panel schedules ("PANEL: LP-1", "PANELBOARD B", "PANEL 'A'"), most-cited first.
 * Requires a word boundary after PANEL so "PANELS"/"PANELBOARDS" do not yield "S".
 */
const NOT_PANEL_WORDS = new Set(['DOOR', 'LID', 'BOX', 'CAN', 'TUB', 'TOP', 'KEY', 'LOCK', 'TRIM', 'COVER', 'SIZE', 'BUS', 'BUSS', 'AMP', 'AMPS', 'ARE', 'NOT', 'ONE', 'TWO', 'ANY', 'USE', 'PER', 'VIA', 'ITS', 'SET', 'FUSE', 'LUGS', 'LUG']);

export function panelNamesFromSchedules(lines: string[]): string[] {
  const counts = new Map<string, number>();
  const re = /\b(?:PANEL(?:BOARD)?|PNL)(?![A-Z])\s*(?:[:#]|NAME\s*:?|DESIGNATION\s*:?|MARK\s*:?)?\s*(["'“‘]?)([A-Z]{1,4}[0-9]{0,2}[A-Z]?(?:-[A-Z0-9]{1,3})?)(?![A-Z0-9])/g;
  const stop = new Set(['SCHEDULE', 'SCHED', 'BOARD', 'BOARDS', 'TO', 'IN', 'ON', 'AND', 'OR', 'THE', 'FED', 'FROM', 'MAIN', 'SEE', 'NEW', 'TYPE', 'MOUNTED', 'LOCATION', 'NAME', 'IS', 'AS', 'AT', 'BY', 'OF', 'FOR', 'WITH', 'ALL', 'EACH', 'SHALL', 'BE', 'A', 'AN', 'NO', 'EX', 'EXIST', 'TOTAL', 'LOAD', 'LOADS']);
  for (const line of lines) {
    for (const m of line.toUpperCase().matchAll(re)) {
      const name = m[2];
      // "PANELBOARD 'A'" / a schedule header "PANELBOARD A" (nothing after it) is panel A, not
      // the article in "panel a minimum of…".
      const rest = line.toUpperCase().slice((m.index ?? 0) + m[0].length);
      const headerLike = !!m[1] || /^\s*(?:["'”’]|$|[-–(,:])/.test(rest);
      if (stop.has(name) && !(name.length === 1 && headerLike)) continue;
      // Panel names are short codes ("A", "LP", "LP-1", "H1A"); plain words ("LABEL", "DOOR",
      // "COVER") are spec text about panels, not panel names.
      if (/^[A-Z]{4,}$/.test(name) || NOT_PANEL_WORDS.has(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/**
 * Best panel suggestions: panels the circuit tags use (confirmed when a schedule names them),
 * then other scheduled panels. Never invents names that appear nowhere.
 */
export function suggestPanels(
  tagPanels: string[],
  scheduleNames: string[],
): Array<{ name: string; source: 'tags+schedule' | 'tags' | 'schedule' }> {
  const scheduled = new Set(scheduleNames);
  const out: Array<{ name: string; source: 'tags+schedule' | 'tags' | 'schedule' }> = [];
  for (const name of tagPanels) out.push({ name, source: scheduled.has(name) ? 'tags+schedule' : 'tags' });
  for (const name of scheduleNames) {
    if (!out.some(row => row.name === name)) out.push({ name, source: 'schedule' });
  }
  return out.slice(0, 6);
}
