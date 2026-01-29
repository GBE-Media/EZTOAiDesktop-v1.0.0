/**
 * AI Pipeline Coordinator
 * Manages the multi-stage AI processing pipeline
 */

import { getAIService } from './aiService';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { capturePageCrop } from './imageCapture';
import type {
  TradeType,
  BlueprintAnalysisResult,
  MaterialEstimate,
  CanvasPlacement,
  LayoutSuggestion,
  PipelineStage,
} from './providers/types';

export interface PipelineProgress {
  stage: PipelineStage | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  data?: unknown;
}

export type PipelineProgressCallback = (progress: PipelineProgress) => void;

export interface PipelineOptions {
  trade: TradeType;
  pages: number[]; // Page numbers to analyze
  imageGenerator: (page: number) => Promise<string>; // Function to get page image as base64
  pageWidth: number;
  pageHeight: number;
  userPrompt?: string;
  location?: string;
  onProgress?: PipelineProgressCallback;
  pdfDoc?: PDFDocumentProxy;
  refinePlacements?: boolean;
}

export interface PipelineResult {
  success: boolean;
  analysis?: BlueprintAnalysisResult[];
  estimate?: MaterialEstimate;
  placements?: CanvasPlacement;
  error?: string;
  duration: number;
}

/**
 * Run the full AI pipeline for blueprint analysis
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const startTime = Date.now();
  const aiService = getAIService();

  const {
    trade,
    pages,
    imageGenerator,
    pageWidth,
    pageHeight,
    userPrompt,
    location,
    onProgress,
    pdfDoc,
    refinePlacements = true,
  } = options;

  const reportProgress = (stage: PipelineProgress['stage'], progress: number, message: string, data?: unknown) => {
    onProgress?.({ stage, progress, message, data });
  };

  try {
    // Stage 1: Vision - Analyze blueprints
    reportProgress('vision', 0, 'Starting blueprint analysis...');
    
    const analysisResults: BlueprintAnalysisResult[] = [];
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageProgress = Math.round((i / pages.length) * 100);
      reportProgress('vision', pageProgress, `Analyzing page ${page}...`);
      
      // Get page image
      const imageBase64 = await imageGenerator(page);
      
      // Analyze with vision model
      const visionResponse = await aiService.analyzeBlueprint(
        imageBase64,
        trade,
        userPrompt
      );
      
      try {
        const analysisData = JSON.parse(visionResponse.content);
        analysisResults.push({
          page,
          items: analysisData.items || [],
          dimensions: analysisData.dimensions || [],
          text: analysisData.text || [],
          symbols: analysisData.symbols || [],
          location: analysisData.projectInfo?.address ? {
            address: analysisData.projectInfo.address,
          } : undefined,
        });
      } catch (parseError) {
        console.error('Failed to parse vision response:', parseError);
        // Continue with partial results
      }
    }

    reportProgress('vision', 100, 'Blueprint analysis complete', analysisResults);

    // Stage 2: Estimation - Generate material takeoff
    reportProgress('estimation', 0, 'Generating material estimate...');
    
    const estimationResponse = await aiService.estimateMaterials(
      JSON.stringify(analysisResults),
      trade,
      location
    );
    
    reportProgress('estimation', 50, 'Processing estimate...');
    
    let estimate: MaterialEstimate;
    try {
      const estimateData = parseJsonResponse(estimationResponse.content);
      if (!estimateData) {
        throw new Error('Empty or invalid JSON');
      }
      estimate = {
        trade,
        items: estimateData.items || [],
        codeReferences: estimateData.codeReferences || [],
        notes: estimateData.notes || [],
      };
    } catch (parseError) {
      console.error('Failed to parse estimation response:', parseError);
      console.error('Estimation raw response:', estimationResponse.content);
      throw new Error('Failed to parse material estimate');
    }
    
    reportProgress('estimation', 100, 'Material estimate complete', estimate);

    // Stage 3: Placement - Generate canvas markups
    reportProgress('placement', 0, 'Generating canvas placements...');
    
    const placementResponse = await aiService.generatePlacements(
      JSON.stringify({
        analysis: analysisResults,
        estimate,
      }),
      pageWidth,
      pageHeight
    );
    
    reportProgress('placement', 50, 'Processing placements...');
    
    let placements: CanvasPlacement;
    try {
      const placementData = parseJsonResponse(placementResponse.content);
      if (!placementData) {
        throw new Error('Empty or invalid JSON');
      }
      placements = {
        markups: placementData.markups || [],
        notes: placementData.notes || [],
      };
    } catch (parseError) {
      console.error('Failed to parse placement response:', parseError);
      console.error('Placement raw response:', placementResponse.content);
      throw new Error('Failed to generate canvas placements');
    }
    
    if (refinePlacements && pdfDoc && placements.markups.length > 0) {
      reportProgress('placement', 75, 'Refining placement accuracy...');
      placements = await refinePlacementPoints({
        placements,
        pdfDoc,
        pageWidth,
        pageHeight,
        trade,
        userPrompt,
      });
    }
    
    reportProgress('placement', 100, 'Canvas placements complete', placements);
    reportProgress('complete', 100, 'Pipeline complete');

    return {
      success: true,
      analysis: analysisResults,
      estimate,
      placements,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    reportProgress('error', 0, errorMessage);
    
    return {
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Run only the vision stage for quick analysis
 */
export async function analyzeOnly(options: {
  trade: TradeType;
  imageBase64: string;
  userPrompt?: string;
}): Promise<BlueprintAnalysisResult | null> {
  const aiService = getAIService();
  
  try {
    const response = await aiService.analyzeBlueprint(
      options.imageBase64,
      options.trade,
      options.userPrompt
    );
    
    const data = parseJsonResponse(response.content);
    if (!data) {
      throw new Error('Failed to parse analysis response');
    }
    return {
      page: 1,
      items: data.items || [],
      dimensions: data.dimensions || [],
      text: data.text || [],
      symbols: data.symbols || [],
      location: data.projectInfo?.address ? {
        address: data.projectInfo.address,
      } : undefined,
    };
  } catch (error) {
    console.error('Analysis failed:', error);
    return null;
  }
}

/**
 * Chat with the AI about the current document
 */
export async function chat(options: {
  message: string;
  context?: {
    trade?: TradeType;
    currentPage?: number;
    selectedItems?: unknown[];
    previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  };
  imageBase64?: string;
}): Promise<string> {
  const aiService = getAIService();
  
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; images?: string[] }> = [
    {
      role: 'system',
      content: `You are an AI assistant helping with construction blueprint takeoffs and estimates.
You have access to the user's PDF documents and can help with:
- Analyzing blueprints for materials and fixtures
- Counting items and generating estimates
- Suggesting optimal layouts for conduit, duct, and pipe runs
- Answering questions about building codes (NEC, UPC, IBC)
- Explaining trade-specific requirements

${options.context?.trade ? `Current trade focus: ${options.context.trade}` : ''}
${options.context?.currentPage ? `Current page: ${options.context.currentPage}` : ''}

Be helpful, accurate, and reference specific codes when applicable.`,
    },
  ];
  
  // Add previous messages for context
  if (options.context?.previousMessages) {
    messages.push(...options.context.previousMessages);
  }
  
  // Add current message
  if (options.imageBase64) {
    messages.push({
      role: 'user',
      content: options.message,
      images: [options.imageBase64],
    });
  } else {
    messages.push({
      role: 'user',
      content: options.message,
    });
  }
  
  try {
    let response;
    if (options.imageBase64) {
      response = await aiService.vision({ messages });
    } else {
      response = await aiService.complete('estimation', { messages });
    }
    
    return response.content;
  } catch (error) {
    console.error('Chat failed:', error);
    throw error;
  }
}

function parseJsonResponse(content: string): any | null {
  if (!content) return null;
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // Strip markdown fences if present
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1].trim());
      } catch {
        // continue to fallback
      }
    }
    // Find first JSON object in the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function refinePlacementPoints(options: {
  placements: CanvasPlacement;
  pdfDoc: PDFDocumentProxy;
  pageWidth: number;
  pageHeight: number;
  trade: TradeType;
  userPrompt?: string;
}): Promise<CanvasPlacement> {
  const aiService = getAIService();
  const { placements, pdfDoc, pageWidth, pageHeight, trade, userPrompt } = options;
  
  const refinedMarkups = await Promise.all(
    placements.markups.map(async (markup, index) => {
      const point = markup.points?.[0];
      if (!point) return markup;
      
      const cropSize = 240;
      const cropX = Math.max(0, Math.min(point.x - cropSize / 2, pageWidth - cropSize));
      const cropY = Math.max(0, Math.min(point.y - cropSize / 2, pageHeight - cropSize));
      
      try {
        const crop = await capturePageCrop(
          pdfDoc,
          markup.page,
          { x: cropX, y: cropY, width: cropSize, height: cropSize },
          { scale: 2, format: 'jpeg', quality: 0.9 }
        );
        
        const refinementPrompt = `You are refining placement accuracy for construction takeoff markups.
Return the exact center point of the symbol within this cropped image.

Crop size: ${crop.width} x ${crop.height} pixels
Return JSON: { "x": number, "y": number }
Only return the JSON object.`;
        
        const response = await aiService.vision({
          messages: [
            { role: 'system', content: refinementPrompt },
            {
              role: 'user',
              content: `Trade: ${trade}. ${userPrompt || ''} Locate the exact symbol center.`,
              images: [crop.base64],
            },
          ],
          responseFormat: 'json',
          temperature: 0.1,
        });
        
        const refined = parseJsonResponse(response.content);
        if (!refined || typeof refined.x !== 'number' || typeof refined.y !== 'number') {
          return markup;
        }
        
        const refinedPoint = {
          x: Math.max(0, Math.min(pageWidth, cropX + refined.x)),
          y: Math.max(0, Math.min(pageHeight, cropY + refined.y)),
        };
        
        return {
          ...markup,
          points: [refinedPoint, ...markup.points.slice(1)],
        };
      } catch (error) {
        console.warn('Placement refinement failed for markup', index, error);
        return markup;
      }
    })
  );
  
  return {
    ...placements,
    markups: refinedMarkups,
  };
}

/**
 * Generate layout suggestions for a specific trade
 */
export async function suggestLayouts(options: {
  trade: TradeType;
  layoutType: 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent';
  imageBase64: string;
  existingItems?: unknown[];
  constraints?: string;
}): Promise<LayoutSuggestion[]> {
  const aiService = getAIService();
  
  const systemPrompt = `You are an expert ${options.trade} layout designer.
Generate ${options.layoutType} layout suggestions that:
- Minimize material usage while meeting code requirements
- Follow optimal routing patterns
- Account for structural obstacles
- Consider accessibility for maintenance

Provide 2-3 alternative layouts with pros/cons for each.

Respond with JSON:
{
  "suggestions": [
    {
      "id": "unique-id",
      "trade": "${options.trade}",
      "type": "${options.layoutType}",
      "name": "Layout Option 1",
      "description": "Description of this layout approach",
      "routes": [
        {
          "id": "route-id",
          "points": [{ "x": 10, "y": 20 }, { "x": 50, "y": 20 }],
          "page": 1,
          "segments": [
            {
              "start": { "x": 10, "y": 20 },
              "end": { "x": 50, "y": 20 },
              "length": 40,
              "type": "straight"
            }
          ]
        }
      ],
      "totalLength": 40,
      "codeCompliance": true,
      "notes": ["Key notes about this layout"]
    }
  ]
}`;

  try {
    const response = await aiService.vision({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: options.constraints || `Suggest optimal ${options.layoutType} layouts for this blueprint.`,
          images: [options.imageBase64],
        },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    });
    
    const data = JSON.parse(response.content);
    return data.suggestions || [];
  } catch (error) {
    console.error('Layout suggestion failed:', error);
    return [];
  }
}
