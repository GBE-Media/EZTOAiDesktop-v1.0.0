/**
 * Layout Optimizer
 * Core logic for generating optimal routing suggestions
 */

import type { 
  LayoutSuggestion, 
  LayoutRoute, 
  RouteSegment, 
  TradeType,
  DetectedItem 
} from '../providers/types';

export type LayoutType = 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent';

export interface LayoutRequest {
  trade: TradeType;
  layoutType: LayoutType;
  items: DetectedItem[];
  pageWidth: number;
  pageHeight: number;
  panelLocation?: { x: number; y: number };
  constraints?: LayoutConstraints;
}

export interface LayoutConstraints {
  avoidAreas?: Array<{ x: number; y: number; width: number; height: number }>;
  preferredPaths?: 'horizontal-first' | 'vertical-first' | 'diagonal-allowed';
  maxSegmentLength?: number;
  minBendRadius?: number;
}

export interface LayoutOptions {
  generateAlternatives: boolean;
  maxAlternatives: number;
  optimizeFor: 'length' | 'cost' | 'simplicity';
}

const DEFAULT_OPTIONS: LayoutOptions = {
  generateAlternatives: true,
  maxAlternatives: 3,
  optimizeFor: 'length',
};

/**
 * Generate layout suggestions for detected items
 */
export function generateLayoutSuggestions(
  request: LayoutRequest,
  options: Partial<LayoutOptions> = {}
): LayoutSuggestion[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const suggestions: LayoutSuggestion[] = [];
  
  switch (request.layoutType) {
    case 'conduit':
    case 'homerun':
      suggestions.push(...generateElectricalLayouts(request, opts));
      break;
    case 'duct':
      suggestions.push(...generateDuctLayouts(request, opts));
      break;
    case 'pipe':
    case 'vent':
      suggestions.push(...generatePlumbingLayouts(request, opts));
      break;
  }
  
  // Sort by total length (shortest first)
  suggestions.sort((a, b) => a.totalLength - b.totalLength);
  
  // Limit to max alternatives
  return suggestions.slice(0, opts.maxAlternatives);
}

/**
 * Generate electrical conduit/homerun layouts
 */
function generateElectricalLayouts(
  request: LayoutRequest,
  options: LayoutOptions
): LayoutSuggestion[] {
  const suggestions: LayoutSuggestion[] = [];
  const { items, pageWidth, pageHeight, panelLocation } = request;
  
  // Use center if no panel location specified
  const panel = panelLocation || { x: pageWidth * 0.1, y: pageHeight * 0.5 };
  
  // Group items by proximity
  const groups = groupItemsByProximity(items, pageWidth * 0.15);
  
  // Option 1: Direct runs to each group
  const directRoutes = groups.map((group, i) => 
    createRoute(panel, getGroupCenter(group), `direct-${i}`, 1)
  );
  
  suggestions.push({
    id: `layout-direct-${Date.now()}`,
    trade: 'electrical',
    type: request.layoutType,
    name: 'Direct Runs',
    description: 'Separate conduit runs from panel to each device group',
    routes: directRoutes,
    totalLength: directRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
    codeCompliance: true,
    notes: [
      'Each group has dedicated conduit',
      'Easier for maintenance and future modifications',
      'Higher material cost but simpler installation',
    ],
  });
  
  // Option 2: Main trunk with branches
  if (groups.length > 1 && options.generateAlternatives) {
    const trunkRoutes = createTrunkAndBranchLayout(panel, groups, pageWidth, pageHeight);
    
    suggestions.push({
      id: `layout-trunk-${Date.now()}`,
      trade: 'electrical',
      type: request.layoutType,
      name: 'Trunk and Branch',
      description: 'Main conduit run with branches to device groups',
      routes: trunkRoutes,
      totalLength: trunkRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
      codeCompliance: true,
      notes: [
        'Shared main conduit reduces material',
        'Consider conduit fill limits per NEC',
        'Good for linear arrangements',
      ],
    });
  }
  
  // Option 3: Daisy chain
  if (groups.length > 2 && options.generateAlternatives) {
    const daisyRoutes = createDaisyChainLayout(panel, groups);
    
    suggestions.push({
      id: `layout-daisy-${Date.now()}`,
      trade: 'electrical',
      type: request.layoutType,
      name: 'Daisy Chain',
      description: 'Sequential routing through each device group',
      routes: daisyRoutes,
      totalLength: daisyRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
      codeCompliance: true,
      notes: [
        'Minimizes total conduit length',
        'May require larger conduit for wire fill',
        'Single path - less redundancy',
      ],
    });
  }
  
  return suggestions;
}

/**
 * Generate duct layouts for HVAC
 */
function generateDuctLayouts(
  request: LayoutRequest,
  options: LayoutOptions
): LayoutSuggestion[] {
  const suggestions: LayoutSuggestion[] = [];
  const { items, pageWidth, pageHeight } = request;
  
  // Find AHU/RTU location or use default
  const equipmentItem = items.find(i => 
    i.type.toLowerCase().includes('ahu') || 
    i.type.toLowerCase().includes('rtu') ||
    i.type.toLowerCase().includes('air handler')
  );
  
  const equipment = equipmentItem?.location || { x: pageWidth * 0.5, y: pageHeight * 0.1 };
  
  // Get diffuser locations
  const diffusers = items.filter(i => 
    i.type.toLowerCase().includes('diffuser') ||
    i.type.toLowerCase().includes('register') ||
    i.type.toLowerCase().includes('grille')
  );
  
  if (diffusers.length === 0) {
    return suggestions;
  }
  
  // Option 1: Radial layout
  const radialRoutes = diffusers.map((d, i) => 
    createRoute(equipment, d.location, `radial-${i}`, 1)
  );
  
  suggestions.push({
    id: `layout-radial-${Date.now()}`,
    trade: 'hvac',
    type: 'duct',
    name: 'Radial Layout',
    description: 'Individual duct runs from equipment to each diffuser',
    routes: radialRoutes,
    totalLength: radialRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
    codeCompliance: true,
    notes: [
      'Best for balancing airflow',
      'Higher material cost',
      'Ideal for VAV systems',
    ],
  });
  
  // Option 2: Extended plenum
  if (diffusers.length > 2 && options.generateAlternatives) {
    const plenumRoutes = createExtendedPlenumLayout(equipment, diffusers);
    
    suggestions.push({
      id: `layout-plenum-${Date.now()}`,
      trade: 'hvac',
      type: 'duct',
      name: 'Extended Plenum',
      description: 'Main trunk duct with branch takeoffs',
      routes: plenumRoutes,
      totalLength: plenumRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
      codeCompliance: true,
      notes: [
        'Efficient for rectangular floor plans',
        'Requires proper sizing for friction loss',
        'Common in residential/light commercial',
      ],
    });
  }
  
  return suggestions;
}

/**
 * Generate plumbing pipe layouts
 */
function generatePlumbingLayouts(
  request: LayoutRequest,
  options: LayoutOptions
): LayoutSuggestion[] {
  const suggestions: LayoutSuggestion[] = [];
  const { items, pageWidth, pageHeight } = request;
  
  // Find main connection point
  const mainPoint = { x: pageWidth * 0.9, y: pageHeight * 0.5 };
  
  // Get fixture locations
  const fixtures = items.filter(i => 
    i.type.toLowerCase().includes('fixture') ||
    i.type.toLowerCase().includes('sink') ||
    i.type.toLowerCase().includes('toilet') ||
    i.type.toLowerCase().includes('shower') ||
    i.type.toLowerCase().includes('tub')
  );
  
  if (fixtures.length === 0) {
    return suggestions;
  }
  
  // Group by wet walls (fixtures aligned vertically)
  const wetWalls = groupByWetWall(fixtures, pageWidth * 0.1);
  
  // Option 1: Individual runs
  const individualRoutes = fixtures.map((f, i) => 
    createRoute(mainPoint, f.location, `individual-${i}`, 1)
  );
  
  suggestions.push({
    id: `layout-individual-${Date.now()}`,
    trade: 'plumbing',
    type: request.layoutType,
    name: 'Individual Runs',
    description: 'Separate pipe runs to each fixture',
    routes: individualRoutes,
    totalLength: individualRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
    codeCompliance: true,
    notes: [
      'Simple installation',
      'Higher material cost',
      'Good for small fixture counts',
    ],
  });
  
  // Option 2: Manifold/home run
  if (fixtures.length > 2 && options.generateAlternatives) {
    const manifoldRoutes = createManifoldLayout(mainPoint, fixtures);
    
    suggestions.push({
      id: `layout-manifold-${Date.now()}`,
      trade: 'plumbing',
      type: request.layoutType,
      name: 'Manifold System',
      description: 'Central manifold with dedicated runs to each fixture',
      routes: manifoldRoutes,
      totalLength: manifoldRoutes.reduce((sum, r) => sum + calculateRouteLength(r), 0),
      codeCompliance: true,
      notes: [
        'Popular with PEX systems',
        'Individual shutoffs at manifold',
        'Balanced pressure',
      ],
    });
  }
  
  return suggestions;
}

// Helper functions

function groupItemsByProximity(items: DetectedItem[], threshold: number): DetectedItem[][] {
  if (items.length === 0) return [];
  
  const groups: DetectedItem[][] = [];
  const used = new Set<string>();
  
  for (const item of items) {
    if (used.has(item.id)) continue;
    
    const group: DetectedItem[] = [item];
    used.add(item.id);
    
    for (const other of items) {
      if (used.has(other.id)) continue;
      
      const dist = Math.hypot(
        item.location.x - other.location.x,
        item.location.y - other.location.y
      );
      
      if (dist <= threshold) {
        group.push(other);
        used.add(other.id);
      }
    }
    
    groups.push(group);
  }
  
  return groups;
}

function getGroupCenter(items: DetectedItem[]): { x: number; y: number } {
  if (items.length === 0) return { x: 0, y: 0 };
  
  const sum = items.reduce(
    (acc, item) => ({
      x: acc.x + item.location.x,
      y: acc.y + item.location.y,
    }),
    { x: 0, y: 0 }
  );
  
  return {
    x: sum.x / items.length,
    y: sum.y / items.length,
  };
}

function createRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
  id: string,
  page: number
): LayoutRoute {
  // Create L-shaped route (horizontal then vertical)
  const midPoint = { x: to.x, y: from.y };
  
  const segments: RouteSegment[] = [];
  
  // Horizontal segment
  if (Math.abs(from.x - to.x) > 1) {
    segments.push({
      start: from,
      end: midPoint,
      length: Math.abs(from.x - to.x),
      type: 'straight',
    });
  }
  
  // Vertical segment
  if (Math.abs(from.y - to.y) > 1) {
    segments.push({
      start: midPoint,
      end: to,
      length: Math.abs(from.y - to.y),
      type: 'straight',
    });
    
    // Add elbow if we have both segments
    if (segments.length > 1) {
      segments[0].type = 'straight';
      segments.splice(1, 0, {
        start: midPoint,
        end: midPoint,
        length: 0,
        type: 'elbow',
      });
    }
  }
  
  return {
    id,
    points: [from, midPoint, to],
    page,
    segments,
  };
}

function calculateRouteLength(route: LayoutRoute): number {
  return route.segments.reduce((sum, seg) => sum + seg.length, 0);
}

function createTrunkAndBranchLayout(
  start: { x: number; y: number },
  groups: DetectedItem[][],
  pageWidth: number,
  pageHeight: number
): LayoutRoute[] {
  const routes: LayoutRoute[] = [];
  const centers = groups.map(g => getGroupCenter(g));
  
  // Sort centers by distance from start
  centers.sort((a, b) => {
    const distA = Math.hypot(a.x - start.x, a.y - start.y);
    const distB = Math.hypot(b.x - start.x, b.y - start.y);
    return distA - distB;
  });
  
  // Create main trunk along average Y
  const avgY = centers.reduce((sum, c) => sum + c.y, 0) / centers.length;
  const trunkEnd = { x: centers[centers.length - 1].x, y: avgY };
  
  routes.push(createRoute(start, trunkEnd, 'trunk', 1));
  
  // Create branches
  centers.forEach((center, i) => {
    const branchStart = { x: center.x, y: avgY };
    routes.push(createRoute(branchStart, center, `branch-${i}`, 1));
  });
  
  return routes;
}

function createDaisyChainLayout(
  start: { x: number; y: number },
  groups: DetectedItem[][]
): LayoutRoute[] {
  const routes: LayoutRoute[] = [];
  const centers = groups.map(g => getGroupCenter(g));
  
  // Sort by nearest neighbor
  const ordered = [centers[0]];
  const remaining = centers.slice(1);
  
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let nearestIdx = 0;
    let nearestDist = Infinity;
    
    remaining.forEach((c, i) => {
      const dist = Math.hypot(c.x - last.x, c.y - last.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = i;
      }
    });
    
    ordered.push(remaining[nearestIdx]);
    remaining.splice(nearestIdx, 1);
  }
  
  // Create routes
  routes.push(createRoute(start, ordered[0], 'chain-0', 1));
  
  for (let i = 1; i < ordered.length; i++) {
    routes.push(createRoute(ordered[i - 1], ordered[i], `chain-${i}`, 1));
  }
  
  return routes;
}

function createExtendedPlenumLayout(
  equipment: { x: number; y: number },
  diffusers: DetectedItem[]
): LayoutRoute[] {
  const routes: LayoutRoute[] = [];
  
  // Sort diffusers by X position
  const sorted = [...diffusers].sort((a, b) => a.location.x - b.location.x);
  
  // Create main trunk
  const trunkY = equipment.y;
  const trunkEnd = { x: sorted[sorted.length - 1].location.x, y: trunkY };
  
  routes.push(createRoute(equipment, trunkEnd, 'trunk', 1));
  
  // Create takeoffs
  sorted.forEach((d, i) => {
    const takeoffStart = { x: d.location.x, y: trunkY };
    routes.push(createRoute(takeoffStart, d.location, `takeoff-${i}`, 1));
  });
  
  return routes;
}

function createManifoldLayout(
  mainPoint: { x: number; y: number },
  fixtures: DetectedItem[]
): LayoutRoute[] {
  const routes: LayoutRoute[] = [];
  
  // Place manifold near center of fixtures
  const center = getGroupCenter(fixtures);
  const manifold = {
    x: (mainPoint.x + center.x) / 2,
    y: center.y,
  };
  
  // Main to manifold
  routes.push(createRoute(mainPoint, manifold, 'main', 1));
  
  // Manifold to each fixture
  fixtures.forEach((f, i) => {
    routes.push(createRoute(manifold, f.location, `fixture-${i}`, 1));
  });
  
  return routes;
}

function groupByWetWall(fixtures: DetectedItem[], threshold: number): DetectedItem[][] {
  // Group fixtures that are vertically aligned (same X within threshold)
  return groupItemsByProximity(fixtures, threshold);
}
