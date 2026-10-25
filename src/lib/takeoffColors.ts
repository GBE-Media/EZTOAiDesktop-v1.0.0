/**
 * Distinct, stable colors for counted fixture types / products, so each type reads differently on
 * the print. Light blue is reserved for runs and orange for keep-clear areas.
 */
export const TAKEOFF_PALETTE = [
  '#e11d48', // rose
  '#16a34a', // green
  '#9333ea', // purple
  '#d97706', // amber-brown
  '#db2777', // pink
  '#0d9488', // teal
  '#4f46e5', // indigo
  '#65a30d', // lime
  '#b91c1c', // dark red
  '#7c3aed', // violet
  '#a16207', // ochre
  '#be185d', // magenta
  '#15803d', // forest
  '#57534e', // stone
  '#c026d3', // fuchsia
  '#0f766e', // deep teal
];

const STORAGE_KEY = 'bidvera-takeoff-colors';
let registry: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (registry) return registry;
  registry = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (raw) registry = JSON.parse(raw) as Record<string, string>;
  } catch {
    registry = {};
  }
  return registry;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Color for a takeoff key (e.g. "fixture:A"): remembered, and different from colors already used. */
export function takeoffColor(key: string): string {
  const map = load();
  if (map[key]) return map[key];
  const used = new Set(Object.values(map));
  const start = hash(key) % TAKEOFF_PALETTE.length;
  let color = TAKEOFF_PALETTE[start];
  for (let i = 0; i < TAKEOFF_PALETTE.length; i += 1) {
    const candidate = TAKEOFF_PALETTE[(start + i) % TAKEOFF_PALETTE.length];
    if (!used.has(candidate)) { color = candidate; break; }
  }
  map[key] = color;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: colors still stable for this session.
  }
  return color;
}

/** Test hook. */
export function resetTakeoffColors(): void {
  registry = {};
}
