/**
 * AI Pipeline Coordinator
 * Manages the multi-stage AI processing pipeline
 */

import { getAIService } from './aiService';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { capturePageCrop } from './imageCapture';
import { getTextContentWithBounds, groupTextIntoLines } from '@/lib/pdfLoader';
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
  trainingContext?: string;
  location?: string;
  onProgress?: PipelineProgressCallback;
  pdfDoc?: PDFDocumentProxy;
  highAccuracyMode?: boolean;
  refinePlacements?: boolean;
  visibleOnly?: boolean;
}

const KEYWORDS = [
  'LIGHTING',
  'FIXTURE',
  'SCHEDULE',
  'TYPE',
  'LEGEND',
  'SYMBOL',
  'OUTLET',
  'RECEPTACLE',
];

const buildTextContext = (lines: string[]): string => {
  const upperLines = lines.map(line => line.toUpperCase());
  const matchedIndices = new Set<number>();

  upperLines.forEach((line, index) => {
    if (KEYWORDS.some(keyword => line.includes(keyword))) {
      matchedIndices.add(index);
      matchedIndices.add(index - 1);
      matchedIndices.add(index + 1);
      matchedIndices.add(index + 2);
    }
  });

  const selected = Array.from(matchedIndices)
    .filter(index => index >= 0 && index < lines.length)
    .sort((a, b) => a - b)
    .map(index => lines[index]);

  const fallback = lines.slice(0, 40);
  const combined = selected.length ? selected : fallback;

  const text = combined.join('\n');
  const maxChars = 6000;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
};

const extractPageTextContext = async (pdfDoc: PDFDocumentProxy, page: number): Promise<string> => {
  try {
    const textItems = await getTextContentWithBounds(pdfDoc, page, 1.0);
    const lines = groupTextIntoLines(textItems, 5)
      .map(line => line.items.map(item => item.str).join(' ').trim())
      .filter(Boolean);
    return buildTextContext(lines);
  } catch (error) {
    console.warn('[AI] Failed to extract page text context:', error);
    return '';
  }
};

const extractScheduleCrop = async (pdfDoc: PDFDocumentProxy, page: number, pageWidth: number, pageHeight: number) => {
  const textItems = await getTextContentWithBounds(pdfDoc, page, 1.0);
  const lines = groupTextIntoLines(textItems, 5);
  const scheduleLines = lines.filter(line =>
    line.items.some(item => item.str.toUpperCase().includes('FIXTURE')) ||
    line.items.some(item => item.str.toUpperCase().includes('SCHEDULE')) ||
    line.items.some(item => item.str.toUpperCase().includes('LEGEND'))
  );

  if (!scheduleLines.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  scheduleLines.forEach(line => {
    line.items.forEach(item => {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    });
  });

  const padding = 40;
  const crop = {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(pageWidth, maxX - minX + padding * 2),
    height: Math.min(pageHeight, maxY - minY + padding * 2),
  };

  return crop;
};

const generateTiles = (pageWidth: number, pageHeight: number, rows: number, cols: number) => {
  const tileWidth = pageWidth / cols;
  const tileHeight = pageHeight / rows;
  const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      tiles.push({
        x: col * tileWidth,
        y: row * tileHeight,
        width: tileWidth,
        height: tileHeight,
      });
    }
  }

  return tiles;
};

const mergeTypeCounts = (entries: Array<Record<string, number> | undefined>) => {
  return entries.reduce((acc, entry) => {
    if (!entry) return acc;
    Object.entries(entry).forEach(([key, value]) => {
      acc[key] = (acc[key] || 0) + value;
    });
    return acc;
  }, {} as Record<string, number>);
};

export interface PipelineResult {
  success: boolean;
  analysis?: BlueprintAnalysisResult[];
  estimate?: MaterialEstimate;
  placements?: CanvasPlacement;
  questions?: string[];
  evidence?: string[];
  questionOptions?: Array<{
    id: string;
    prompt: string;
    options: string[];
    allowMultiple?: boolean;
  }>;
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
    trainingContext,
    location,
    onProgress,
    pdfDoc,
    highAccuracyMode = false,
    refinePlacements = true,
    visibleOnly = false,
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
      const textContext = pdfDoc && !visibleOnly ? await extractPageTextContext(pdfDoc, page) : '';
      const promptParts = [
        visibleOnly ? 'VISIBLE-ONLY MODE: Count only symbols visible in the image. Ignore schedule/legend totals or text-only counts.' : undefined,
        userPrompt ? `User request: ${userPrompt}` : undefined,
        trainingContext ? trainingContext : undefined,
        textContext ? `PDF TEXT SNIPPETS:\n${textContext}` : undefined,
      ].filter(Boolean);
      const combinedPrompt = promptParts.join('\n\n');

      // Analyze full page with vision model
      const visionResponse = await aiService.analyzeBlueprint(
        imageBase64,
        trade,
        combinedPrompt || userPrompt
      );
      
      try {
        const analysisData = JSON.parse(visionResponse.content);
        const baseResult: BlueprintAnalysisResult = {
          page,
          items: analysisData.items || [],
          dimensions: analysisData.dimensions || [],
          text: analysisData.text || [],
          symbols: analysisData.symbols || [],
          typeCounts: analysisData.typeCounts || undefined,
          questions: analysisData.questions || undefined,
          questionOptions: analysisData.questionOptions || undefined,
          evidence: analysisData.evidence || undefined,
          location: analysisData.projectInfo?.address ? {
            address: analysisData.projectInfo.address,
          } : undefined,
        };

        if (!highAccuracyMode || !pdfDoc) {
          analysisResults.push(baseResult);
          continue;
        }

        reportProgress('vision', pageProgress, `High accuracy pass ${page}...`);

        const scheduleCrop = visibleOnly ? null : await extractScheduleCrop(pdfDoc, page, pageWidth, pageHeight);
        let scheduleResult: BlueprintAnalysisResult | null = null;

        if (scheduleCrop) {
          const scheduleImage = await capturePageCrop(pdfDoc, page, scheduleCrop, {
            scale: 2.4,
            format: 'jpeg',
            quality: 0.92,
          });
          const scheduleResponse = await aiService.analyzeBlueprint(
            scheduleImage.base64,
            trade,
            `${combinedPrompt}\n\nFocus on the lighting fixture schedule/legend only. Extract fixture types, descriptions, and any abbreviations.`
          );
          try {
            const scheduleData = JSON.parse(scheduleResponse.content);
            scheduleResult = {
              page,
              items: [],
              dimensions: [],
              text: [],
              symbols: [],
              typeCounts: scheduleData.typeCounts || undefined,
              questions: scheduleData.questions || undefined,
              questionOptions: scheduleData.questionOptions || undefined,
              evidence: scheduleData.evidence || undefined,
              location: undefined,
            };
          } catch (error) {
            console.warn('[AI] Failed to parse schedule response:', error);
          }
        }

        const tiles = generateTiles(pageWidth, pageHeight, 3, 3);
        const tileResults: BlueprintAnalysisResult[] = [];

        for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
          const tile = tiles[tileIndex];
          const tileImage = await capturePageCrop(pdfDoc, page, tile, {
            scale: 2.6,
            format: 'jpeg',
            quality: 0.9,
          });
          const tileResponse = await aiService.analyzeBlueprint(
            tileImage.base64,
            trade,
            `${combinedPrompt}\n\nFocus on counting fixtures/symbols in this selected area. Do not mention cropping.`
          );
          try {
            const tileData = JSON.parse(tileResponse.content);
            tileResults.push({
              page,
              items: tileData.items || [],
              dimensions: [],
              text: [],
              symbols: tileData.symbols || [],
              typeCounts: tileData.typeCounts || undefined,
              questions: tileData.questions || undefined,
              questionOptions: tileData.questionOptions || undefined,
              evidence: tileData.evidence || undefined,
              location: undefined,
            });
          } catch (error) {
            console.warn('[AI] Failed to parse tile response:', error);
          }
        }

        const mergedTypeCounts = mergeTypeCounts([
          baseResult.typeCounts,
          scheduleResult?.typeCounts,
          ...tileResults.map(result => result.typeCounts),
        ]);

        const mergedQuestions = [
          ...(baseResult.questions || []),
          ...(scheduleResult?.questions || []),
          ...tileResults.flatMap(result => result.questions || []),
        ];

        const mergedQuestionOptions = [
          ...(baseResult.questionOptions || []),
          ...(scheduleResult?.questionOptions || []),
          ...tileResults.flatMap(result => result.questionOptions || []),
        ];

        const mergedEvidence = [
          ...(baseResult.evidence || []),
          ...(scheduleResult?.evidence || []),
          ...tileResults.flatMap(result => result.evidence || []),
        ];

        analysisResults.push({
          ...baseResult,
          typeCounts: Object.keys(mergedTypeCounts).length ? mergedTypeCounts : baseResult.typeCounts,
          questions: mergedQuestions.length ? mergedQuestions : baseResult.questions,
          questionOptions: mergedQuestionOptions.length ? mergedQuestionOptions : baseResult.questionOptions,
          evidence: mergedEvidence.length ? mergedEvidence : baseResult.evidence,
        });
      } catch (parseError) {
        console.error('Failed to parse vision response:', parseError);
        // Continue with partial results
      }
    }

    reportProgress('vision', 100, 'Blueprint analysis complete', analysisResults);

    const questions = analysisResults.flatMap(result => result.questions || []);
    const evidence = analysisResults.flatMap(result => result.evidence || []);
    const questionOptions = analysisResults.flatMap(result => result.questionOptions || []);
    const totalItems = analysisResults.reduce((sum, result) => sum + (result.items?.length || 0), 0);
    const totalTypeCounts = analysisResults.reduce((sum, result) => sum + Object.keys(result.typeCounts || {}).length, 0);
    const askedForCounts = !!userPrompt && /count|how many|quantity|quantities|number of/i.test(userPrompt);

    if (askedForCounts && totalItems === 0 && totalTypeCounts === 0) {
      questions.push('I could not detect any fixtures to count. Are the lighting symbols visible on this page, or should I zoom into a specific area?');
    }

    if (highAccuracyMode && askedForCounts && totalTypeCounts > 0 && questions.length === 0) {
      const typeCounts = mergeTypeCounts(analysisResults.map(result => result.typeCounts));
      const variance = Object.values(typeCounts).some(value => value > 0);
      if (!variance) {
        questions.push('I could not confirm counts across tiles. Can you confirm the fixture symbols are clearly visible?');
      }
    }

    if (questions.length > 0 || questionOptions.length > 0) {
      reportProgress('complete', 100, 'Questions required', { questions, evidence, questionOptions });
      return {
        success: true,
        analysis: analysisResults,
        questions,
        evidence,
        questionOptions,
        duration: Date.now() - startTime,
      };
    }

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
