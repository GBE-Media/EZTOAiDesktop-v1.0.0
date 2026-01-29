/**
 * Layout Suggestions Index
 * Export layout optimization utilities
 */

export * from './layoutOptimizer';

import type { TradeType, LayoutSuggestion, DetectedItem } from '../providers/types';
import { 
  generateLayoutSuggestions, 
  type LayoutType, 
  type LayoutRequest, 
  type LayoutOptions 
} from './layoutOptimizer';
import { getAIService } from '../aiService';

/**
 * Generate layout suggestions using AI analysis
 */
export async function suggestLayoutsWithAI(options: {
  trade: TradeType;
  layoutType: LayoutType;
  imageBase64: string;
  pageWidth: number;
  pageHeight: number;
  panelLocation?: { x: number; y: number };
}): Promise<LayoutSuggestion[]> {
  const aiService = getAIService();
  
  const systemPrompt = getLayoutSystemPrompt(options.trade, options.layoutType);
  
  try {
    const response = await aiService.vision({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Analyze this blueprint and suggest optimal ${options.layoutType} routing. 
Consider code requirements, efficiency, and practical installation.
Return 2-3 layout options with pros/cons for each.`,
          images: [options.imageBase64],
        },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    });
    
    const data = JSON.parse(response.content);
    return data.suggestions || [];
  } catch (error) {
    console.error('AI layout suggestion failed:', error);
    
    // Fall back to algorithmic suggestions if AI fails
    // This requires detected items, which we don't have without AI
    // Return empty for now
    return [];
  }
}

/**
 * Generate layouts from detected items (no AI required)
 */
export function suggestLayoutsFromItems(
  items: DetectedItem[],
  options: {
    trade: TradeType;
    layoutType: LayoutType;
    pageWidth: number;
    pageHeight: number;
    panelLocation?: { x: number; y: number };
  }
): LayoutSuggestion[] {
  const request: LayoutRequest = {
    trade: options.trade,
    layoutType: options.layoutType,
    items,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    panelLocation: options.panelLocation,
  };
  
  return generateLayoutSuggestions(request);
}

function getLayoutSystemPrompt(trade: TradeType, layoutType: LayoutType): string {
  const tradePrompts: Record<TradeType, Record<string, string>> = {
    electrical: {
      conduit: `You are an expert electrical layout designer.
Analyze the blueprint and suggest optimal conduit routing from the panel to device locations.
Consider:
- NEC conduit fill limits (40% for 3+ conductors)
- Bend limitations (360° between pull points)
- Support spacing requirements
- Accessibility for pulling wire`,

      homerun: `You are an expert electrical layout designer.
Suggest optimal homerun routing from devices back to the panel.
Consider:
- Circuit groupings by area
- Wire sizing and voltage drop
- Panel capacity and spacing
- NEC requirements for dedicated circuits`,
    },
    
    plumbing: {
      pipe: `You are an expert plumbing layout designer.
Suggest optimal pipe routing for supply lines.
Consider:
- Fixture unit calculations
- Pipe sizing per UPC/IPC
- Pressure loss and velocity limits
- Accessibility for maintenance`,

      vent: `You are an expert plumbing layout designer.
Suggest optimal vent routing to ensure proper drainage.
Consider:
- Wet venting options
- AAV (Air Admittance Valve) placement if allowed
- Vent termination requirements
- Connection to main vent stack`,
    },
    
    hvac: {
      duct: `You are an expert HVAC layout designer.
Suggest optimal duct routing for supply and return air.
Consider:
- CFM requirements per diffuser
- Static pressure loss
- Noise criteria (NC levels)
- Duct velocity limits per IMC`,
    },
  };
  
  const basePrompt = tradePrompts[trade]?.[layoutType] || 
    `You are an expert ${trade} layout designer. Suggest optimal ${layoutType} routing.`;
  
  return `${basePrompt}

Respond with a JSON object:
{
  "suggestions": [
    {
      "id": "unique-id",
      "trade": "${trade}",
      "type": "${layoutType}",
      "name": "Layout Option Name",
      "description": "Brief description of this approach",
      "routes": [
        {
          "id": "route-id",
          "points": [{ "x": 10, "y": 20 }, { "x": 50, "y": 20 }, { "x": 50, "y": 80 }],
          "page": 1,
          "segments": [
            { "start": { "x": 10, "y": 20 }, "end": { "x": 50, "y": 20 }, "length": 40, "type": "straight" },
            { "start": { "x": 50, "y": 20 }, "end": { "x": 50, "y": 80 }, "length": 60, "type": "straight" }
          ]
        }
      ],
      "totalLength": 100,
      "codeCompliance": true,
      "notes": ["Important note 1", "Important note 2"]
    }
  ]
}

Coordinates are in percentage of page dimensions (0-100).
Provide 2-3 alternative layouts ranked by efficiency.`;
}
