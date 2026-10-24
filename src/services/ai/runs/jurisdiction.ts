/**
 * Project location → governing NEC edition.
 *
 * State adoption data: Mike Holt NEC Adoption List (https://www.mikeholt.com/necadoptionlist.php)
 * and NFPA NEC enforcement maps (https://www.nfpa.org/education-and-research/electrical/nec-enforcement-maps),
 * checked October 2026. Local amendments and home-rule jurisdictions always need AHJ confirmation.
 */

export type StateAdoption = {
  edition: number | null;
  effective?: string;
  /** Edition that takes over on `pendingEffective` (already adopted, not yet in force). */
  pendingEdition?: number;
  pendingEffective?: string;
  amendments?: boolean;
  /** No statewide adoption — municipalities adopt (and amend) their own edition. */
  local?: boolean;
  note?: string;
};

export const NEC_ADOPTION_CHECKED = '2026-10';

export const STATE_NEC: Record<string, StateAdoption> = {
  AL: { edition: 2020, effective: '2022-07-01', note: 'State Building Code: state buildings, schools, hotels, theaters' },
  AK: { edition: 2020, effective: '2020-04-16' },
  AZ: { edition: null, local: true },
  AR: { edition: 2026, effective: '2026-09-03' },
  CA: { edition: 2023, effective: '2026-01-01', amendments: true, note: '2025 California Electrical Code (Title 24 Part 3)' },
  CO: { edition: 2026, effective: '2026-08-01' },
  CT: { edition: 2020, effective: '2022-10-01', amendments: true, note: '2023 update underway' },
  DE: { edition: 2023, effective: '2026-01-01' },
  DC: { edition: 2014, effective: '2020-05-29' },
  FL: { edition: 2020, effective: '2023-12-31', note: '2023 update underway' },
  GA: { edition: 2023, effective: '2025-01-01', amendments: true },
  HI: { edition: 2020, effective: '2023-03-14' },
  ID: { edition: 2023, effective: '2024-07-01', amendments: true },
  IL: { edition: null, local: true, note: 'No statewide adoption (2008 NEC for non-building-code jurisdictions)' },
  IN: { edition: 2008, effective: '2009-06-02', amendments: true, note: 'Commercial; 2023 update underway' },
  IA: { edition: 2023, effective: '2025-07-01', amendments: true },
  KS: { edition: null, local: true },
  KY: { edition: 2023, effective: '2025-01-01' },
  LA: { edition: 2020, effective: '2023-01-01' },
  ME: { edition: 2026, effective: '2026-07-01' },
  MD: { edition: 2020, effective: '2023-05-29', note: '2023 update underway' },
  MA: { edition: 2026, effective: '2026-04-24', amendments: true },
  MI: { edition: 2023, effective: '2024-03-12', amendments: true },
  MN: { edition: 2026, effective: '2026-08-17' },
  MS: { edition: null, local: true },
  MO: { edition: null, local: true },
  MT: { edition: 2020, effective: '2022-06-10', amendments: true, note: '2023 update underway' },
  NE: { edition: 2023, effective: '2024-08-01', amendments: true },
  NV: { edition: null, local: true },
  NH: { edition: 2023, effective: '2025-07-01' },
  NJ: { edition: 2023, effective: '2026-08-17', amendments: true },
  NM: { edition: 2020, effective: '2023-03-28', amendments: true },
  NY: { edition: 2023, effective: '2025-12-31' },
  NC: { edition: 2020, effective: '2021-11-01', amendments: true, note: '2023 update underway' },
  ND: { edition: 2026, effective: '2026-07-01' },
  OH: { edition: 2023, effective: '2024-03-01', amendments: true },
  OK: { edition: 2023, effective: '2024-09-14' },
  OR: { edition: 2026, effective: '2026-10-01', amendments: true },
  PA: { edition: 2020, effective: '2026-01-01' },
  RI: { edition: 2023, effective: '2025-12-01', amendments: true },
  SC: { edition: 2020, effective: '2023-01-01', amendments: true, pendingEdition: 2023, pendingEffective: '2027-01-01' },
  SD: { edition: 2023, effective: '2024-11-12', amendments: true },
  TN: { edition: 2017, effective: '2018-10-01', amendments: true },
  TX: { edition: 2026, effective: '2026-09-01', note: 'Cities may adopt local amendments' },
  UT: { edition: 2023, effective: '2025-07-01', amendments: true },
  VT: { edition: 2023, effective: '2025-11-05' },
  VA: { edition: 2020, effective: '2024-01-18', note: '2023 update underway' },
  WA: { edition: 2023, pendingEdition: 2026, pendingEffective: '2026-12-31', amendments: true },
  WV: { edition: 2020, effective: '2022-08-01', amendments: true },
  WI: { edition: 2023, effective: '2026-09-01' },
  WY: { edition: 2026, effective: '2026-07-01' },
};

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO',
  CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY',
  LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
};

export type ProjectLocation = {
  city?: string;
  state: string;
  zip?: string;
  text: string;
  source?: { documentId?: string; documentName?: string; page?: number };
};

const CITY_STATE_ZIP = /([A-Z][A-Za-z.'\- ]{1,40}),\s*([A-Z]{2}|[A-Za-z ]{4,20})\.?\s+(\d{5})(?:-\d{4})?\b/g;

/** Find "City, ST 12345" (or full state name) in text lines. Most-repeated hit wins. */
export function detectProjectLocation(
  lines: Array<{ text: string; documentId?: string; documentName?: string; page?: number }>,
): ProjectLocation | null {
  const hits = new Map<string, { loc: ProjectLocation; count: number }>();
  for (const line of lines) {
    CITY_STATE_ZIP.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CITY_STATE_ZIP.exec(line.text))) {
      const rawState = match[2].trim().toUpperCase();
      const state = STATE_NEC[rawState] ? rawState : STATE_NAMES[rawState];
      if (!state) continue;
      const city = match[1].trim().replace(/^.*\b(?:ROAD|RD|STREET|ST|AVE|AVENUE|DRIVE|DR|BLVD|HWY|SUITE \S+)\.?\s+/i, '');
      const key = `${city.toUpperCase()}|${state}`;
      const row = hits.get(key) || {
        loc: { city, state, zip: match[3], text: match[0], source: { documentId: line.documentId, documentName: line.documentName, page: line.page } },
        count: 0,
      };
      row.count += 1;
      hits.set(key, row);
    }
  }
  const best = [...hits.values()].sort((a, b) => b.count - a.count)[0];
  return best?.loc || null;
}

export type GoverningCode = {
  state: string;
  edition: number;
  /** True when the edition is assumed (local adoption / unknown). */
  assumed: boolean;
  summary: string;
  cautions: string[];
};

export function governingNec(state: string | undefined, today = new Date()): GoverningCode {
  const cautions: string[] = [];
  const code = state ? STATE_NEC[state.toUpperCase()] : undefined;
  if (!code) {
    return {
      state: state || 'unknown',
      edition: 2023,
      assumed: true,
      summary: 'Project location not found on the prints — assuming 2023 NEC.',
      cautions: ['Confirm the adopted NEC edition and local amendments with the AHJ.'],
    };
  }
  let edition = code.edition;
  if (code.pendingEdition && code.pendingEffective && today >= new Date(code.pendingEffective)) {
    edition = code.pendingEdition;
  } else if (code.pendingEdition && code.pendingEffective) {
    cautions.push(`${code.pendingEdition} NEC takes effect ${code.pendingEffective}; check which edition the permit falls under.`);
  }
  if (code.local || edition === null) {
    cautions.push(`${state} has no statewide NEC adoption — the city/county edition governs. Assuming 2023 NEC; confirm the edition with the local AHJ.`);
    return { state, edition: 2023, assumed: true, summary: `${state}: local adoption — assuming 2023 NEC.`, cautions };
  }
  if (code.amendments) cautions.push(`${state} adopts the NEC with state amendments.`);
  if (code.note) cautions.push(code.note);
  cautions.push('Local amendments may apply — confirm with the AHJ.');
  return {
    state,
    edition,
    assumed: false,
    summary: `${state}: ${edition} NEC${code.amendments ? ' with state amendments' : ''}${code.effective ? ` (effective ${code.effective})` : ''}.`,
    cautions,
  };
}
