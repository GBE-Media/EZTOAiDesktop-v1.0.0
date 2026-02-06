/**
 * AI Service
 * Main orchestration service for AI operations
 * Uses Edge Function proxy for API calls (company-managed API keys)
 */

import {
  getProvider,
  getAllProviders,
  getOpenAIProvider,
  getAnthropicProvider,
  type AIProvider,
  type AIProviderType,
  type AICompletionRequest,
  type AICompletionResponse,
  type AIVisionRequest,
  type PipelineConfig,
  type PipelineStage,
  type TradeType,
  type AIModelInfo,
} from './providers';
import { sendProxyRequest, isProxyAvailable } from './proxyClient';

export interface AIServiceConfig {
  pipeline: PipelineConfig;
  useProxy: boolean; // Use Edge Function proxy (default: true)
  apiKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  visionModel: {
    provider: 'openai',
    model: 'gpt-4o',
  },
  estimationModel: {
    provider: 'openai',
    model: 'gpt-4o',
  },
  placementModel: {
    provider: 'openai',
    model: 'gpt-4o',
  },
};

class AIService {
  private config: AIServiceConfig;
  private initialized: boolean = false;

  constructor() {
    this.config = {
      pipeline: DEFAULT_PIPELINE_CONFIG,
      useProxy: true, // Default to using Edge Function proxy
      apiKeys: {},
    };
  }

  /**
   * Initialize the AI service
   * By default uses Edge Function proxy (no API keys needed on client)
   */
  initialize(options?: { apiKeys?: AIServiceConfig['apiKeys']; useProxy?: boolean }) {
    const { apiKeys, useProxy = true } = options || {};
    
    this.config.useProxy = useProxy;
    this.config.apiKeys = apiKeys || {};

    // Only set local API keys if not using proxy
    if (!useProxy && apiKeys) {
      if (apiKeys.openai) {
        getOpenAIProvider().setApiKey(apiKeys.openai);
      }
      if (apiKeys.anthropic) {
        getAnthropicProvider().setApiKey(apiKeys.anthropic);
      }
    }

    this.initialized = true;
  }

  /**
   * Check if the service is ready to make requests
   */
  isInitialized(): boolean {
    if (this.config.useProxy) {
      return this.initialized;
    }
    return this.initialized && getAllProviders().some(p => p.isConfigured());
  }

  /**
   * Check if using the proxy (company API keys)
   */
  isUsingProxy(): boolean {
    return this.config.useProxy;
  }

  /**
   * Check if proxy is available (user authenticated)
   */
  async checkProxyAvailable(): Promise<boolean> {
    return isProxyAvailable();
  }

  /**
   * Get the current pipeline configuration
   */
  getPipelineConfig(): PipelineConfig {
    return { ...this.config.pipeline };
  }

  /**
   * Update the pipeline configuration
   */
  setPipelineConfig(config: Partial<PipelineConfig>) {
    this.config.pipeline = {
      ...this.config.pipeline,
      ...config,
    };
  }

  /**
   * Get provider for a specific pipeline stage
   */
  getProviderForStage(stage: PipelineStage): AIProvider {
    const stageConfig = this.getStageConfig(stage);
    return getProvider(stageConfig.provider);
  }

  /**
   * Get model for a specific pipeline stage
   */
  getModelForStage(stage: PipelineStage): string {
    return this.getStageConfig(stage).model;
  }

  private getStageConfig(stage: PipelineStage): { provider: AIProviderType; model: string } {
    switch (stage) {
      case 'vision':
        return this.config.pipeline.visionModel;
      case 'estimation':
        return this.config.pipeline.estimationModel;
      case 'placement':
        return this.config.pipeline.placementModel;
      default:
        throw new Error(`Unknown pipeline stage: ${stage}`);
    }
  }

  /**
   * Get all available models across all providers
   */
  getAllModels(): AIModelInfo[] {
    return getAllProviders().flatMap(p => p.getModels());
  }

  /**
   * Get models that support vision
   */
  getVisionModels(): AIModelInfo[] {
    return this.getAllModels().filter(m => m.supportsVision);
  }

  /**
   * Get models that support structured output
   */
  getStructuredOutputModels(): AIModelInfo[] {
    return this.getAllModels().filter(m => m.supportsStructuredOutput);
  }

  /**
   * Send a completion request using the specified stage's provider
   */
  async complete(
    stage: PipelineStage,
    request: Omit<AICompletionRequest, 'model'>
  ): Promise<AICompletionResponse> {
    const stageConfig = this.getStageConfig(stage);
    const model = stageConfig.model;
    const provider = stageConfig.provider;

    // Use proxy if enabled (default)
    if (this.config.useProxy) {
      return sendProxyRequest({
        provider,
        model,
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        responseFormat: request.responseFormat,
      });
    }

    // Fallback to direct provider (if local API keys configured)
    const providerInstance = this.getProviderForStage(stage);
    if (!providerInstance.isConfigured()) {
      throw new Error(`Provider ${providerInstance.name} is not configured. Please add an API key.`);
    }

    return providerInstance.complete({
      ...request,
      model,
    });
  }

  /**
   * Send a vision request using the vision stage's provider
   */
  async vision(request: Omit<AIVisionRequest, 'model'>): Promise<AICompletionResponse> {
    const stageConfig = this.getStageConfig('vision');
    const model = stageConfig.model;
    const provider = stageConfig.provider;

    // Use proxy if enabled (default)
    if (this.config.useProxy) {
      // Convert messages to include images
      const messages = request.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        images: msg.images,
      }));

      return sendProxyRequest({
        provider,
        model,
        messages,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        responseFormat: request.responseFormat,
      });
    }

    // Fallback to direct provider (if local API keys configured)
    const providerInstance = this.getProviderForStage('vision');
    if (!providerInstance.isConfigured()) {
      throw new Error(`Vision provider ${providerInstance.name} is not configured. Please add an API key.`);
    }

    return providerInstance.vision({
      ...request,
      model,
    });
  }

  /**
   * Analyze a blueprint image
   */
  async analyzeBlueprint(
    imageBase64: string,
    trade: TradeType,
    additionalContext?: string
  ): Promise<AICompletionResponse> {
    const systemPrompt = this.getBlueprintAnalysisPrompt(trade);
    
    return this.vision({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: additionalContext || 'Analyze this blueprint and identify all relevant items, fixtures, and components.',
          images: [imageBase64],
        },
      ],
      responseFormat: 'json',
      temperature: 0.2,
    });
  }

  /**
   * Get material estimate from analysis results
   */
  async estimateMaterials(
    analysisJson: string,
    trade: TradeType,
    location?: string
  ): Promise<AICompletionResponse> {
    const systemPrompt = this.getEstimationPrompt(trade, location);

    return this.complete('estimation', {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Based on the following blueprint analysis, provide a detailed material estimate:\n\n${analysisJson}`,
        },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    });
  }

  /**
   * Generate canvas placements from estimates
   */
  async generatePlacements(
    estimateJson: string,
    pageWidth: number,
    pageHeight: number
  ): Promise<AICompletionResponse> {
    const systemPrompt = this.getPlacementPrompt(pageWidth, pageHeight);

    return this.complete('placement', {
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Generate precise canvas markup placements for the following material estimate:\n\n${estimateJson}`,
        },
      ],
      responseFormat: 'json',
      temperature: 0.1,
    });
  }

  private getBlueprintAnalysisPrompt(trade: TradeType): string {
    const tradePrompts: Record<TradeType, string> = {
      electrical: `You are an expert electrical estimator analyzing construction blueprints.
Identify all electrical components including:
- Outlets (receptacles): standard, GFCI, dedicated circuits
- Switches: single-pole, 3-way, 4-way, dimmers
- Light fixtures: recessed, surface mount, pendant, emergency
- Panels and subpanels
- Junction boxes
- Conduit runs (if visible)
- Special equipment: disconnects, transformers, generators

For each item, provide:
- Type and specification
- Approximate location on the page (x, y coordinates as percentages 0-100)
- Quantity
- Any visible circuit or circuit number
- Relevant NEC code references

Also check fixture schedules/legends and any type callouts (A, B, C, etc.). Count fixtures by type letter and return a typeCounts map if visible.

If you are uncertain about symbol meaning, schedule mapping, or counts, add clear questions in a "questions" array and include any evidence snippets in "evidence".
Also provide structured question options in "questionOptions" with id, prompt, options[], and allowMultiple when applicable.`,

      plumbing: `You are an expert plumbing estimator analyzing construction blueprints.
Identify all plumbing components including:
- Fixtures: toilets, sinks, lavatories, showers, tubs, floor drains
- Valves: shut-offs, check valves, pressure reducers
- Water heaters and related equipment
- Cleanouts and access points
- Pipe runs (if visible): supply, drain, vent
- Special equipment: pumps, water treatment, backflow preventers

For each item, provide:
- Type and specification
- Approximate location on the page (x, y coordinates as percentages 0-100)
- Quantity
- Pipe size if visible
- Relevant UPC/IPC code references

Also check fixture schedules/legends and any type callouts (A, B, C, etc.). Count fixtures by type letter and return a typeCounts map if visible.

If you are uncertain about symbol meaning, schedule mapping, or counts, add clear questions in a "questions" array and include any evidence snippets in "evidence".
Also provide structured question options in "questionOptions" with id, prompt, options[], and allowMultiple when applicable.`,

      hvac: `You are an expert HVAC estimator analyzing construction blueprints.
Identify all HVAC components including:
- Diffusers and registers: supply, return, exhaust
- Thermostats and controls
- Equipment: furnaces, air handlers, condensers, RTUs
- Duct runs (if visible): main trunk, branches
- Dampers and transitions
- Exhaust fans and ventilation equipment

For each item, provide:
- Type and specification
- Approximate location on the page (x, y coordinates as percentages 0-100)
- Quantity
- Size/CFM rating if visible
- Relevant IMC/IECC code references

Also check fixture schedules/legends and any type callouts (A, B, C, etc.). Count fixtures by type letter and return a typeCounts map if visible.

If you are uncertain about symbol meaning, schedule mapping, or counts, add clear questions in a "questions" array and include any evidence snippets in "evidence".
Also provide structured question options in "questionOptions" with id, prompt, options[], and allowMultiple when applicable.`,
    };

    return `${tradePrompts[trade]}

Respond with a JSON object in this format:
{
  "items": [
    {
      "id": "unique-id",
      "type": "item type",
      "name": "descriptive name",
      "quantity": 1,
      "location": { "x": 50, "y": 30 },
      "confidence": 0.95,
      "codeReference": "NEC 210.52",
      "notes": "any relevant notes"
    }
  ],
  "dimensions": [
    {
      "value": 10,
      "unit": "ft",
      "startPoint": { "x": 10, "y": 20 },
      "endPoint": { "x": 50, "y": 20 }
    }
  ],
  "symbols": [
    {
      "type": "symbol type",
      "location": { "x": 30, "y": 40 }
    }
  ],
  "typeCounts": {
    "A": 12,
    "B": 6
  },
  "questions": [
    "Are type B fixtures shown with a solid or hollow circle symbol on this plan?"
  ],
  "questionOptions": [
    {
      "id": "fixture_symbol_type",
      "prompt": "Which symbol represents Type B fixtures on this plan?",
      "options": ["Solid circle", "Hollow circle", "Square", "Unknown"],
      "allowMultiple": false
    }
  ],
  "evidence": [
    "LIGHTING FIXTURE SCHEDULE",
    "TYPE B1 - 2'x2' LAY-IN TROFFER FIXTURE"
  ],
  "projectInfo": {
    "title": "if visible",
    "address": "if visible",
    "scale": "if visible"
  }
}`;
  }

  private getEstimationPrompt(trade: TradeType, location?: string): string {
    const codeEdition = location ? `for ${location}` : '';
    
    return `You are an expert ${trade} construction estimator.
Given the blueprint analysis, create a detailed material takeoff.

${location ? `Project Location: ${location}` : ''}
Apply current code requirements ${codeEdition}.

For each material:
- Calculate accurate quantities based on the items detected
- Include all necessary accessories and fittings
- Apply standard waste factors where appropriate
- Reference applicable code sections

Respond with a JSON object in this format:
{
  "trade": "${trade}",
  "items": [
    {
      "id": "unique-id",
      "name": "material name",
      "description": "detailed description",
      "quantity": 10,
      "unit": "EA" or "LF" or "SF",
      "codeReference": "NEC 210.52(A)",
      "linkedItemIds": ["original-item-id"]
    }
  ],
  "codeReferences": [
    {
      "code": "NEC",
      "section": "210.52",
      "description": "Dwelling unit receptacle outlets",
      "edition": "2023"
    }
  ],
  "notes": ["important notes about the estimate"],
  "assumptions": ["any assumptions made"]
}`;
  }

  private getPlacementPrompt(pageWidth: number, pageHeight: number): string {
    return `You are a precision placement system for construction takeoff software.
Given material estimates with location data, generate exact canvas markup coordinates.

Canvas dimensions: ${pageWidth}px width x ${pageHeight}px height
Coordinate system: (0,0) is top-left, positive X is right, positive Y is down

Critical precision rules:
- Place each point exactly on the symbol center, not on text labels or leader lines
- If a symbol is circular, use its center point
- If a symbol is rectangular, use the visual center
- Do not snap to nearby text or dimensions

For each item that needs a markup:
- Calculate precise pixel coordinates from percentage locations
- Choose appropriate markup type (count-marker for items, polyline for runs)
- Use consistent styling per trade

Respond with a JSON object in this format:
{
  "markups": [
    {
      "id": "unique-id",
      "type": "count-marker",
      "page": 1,
      "points": [{ "x": 150, "y": 200 }],
      "style": {
        "strokeColor": "#FF5722",
        "fillColor": "#FF572233",
        "strokeWidth": 2
      },
      "label": "OUTLET",
      "aiNote": "Standard duplex receptacle per NEC 210.52",
      "linkedItemId": "estimate-item-id",
      "pending": true
    }
  ],
  "notes": [
    {
      "id": "note-id",
      "page": 1,
      "position": { "x": 100, "y": 150 },
      "text": "Note text",
      "linkedMarkupId": "markup-id"
    }
  ]
}

Color conventions:
- Electrical: #FF5722 (deep orange)
- Plumbing: #2196F3 (blue)
- HVAC: #4CAF50 (green)`;
  }
}

// Singleton instance
let aiService: AIService | null = null;

export function getAIService(): AIService {
  if (!aiService) {
    aiService = new AIService();
  }
  return aiService;
}

export { AIService };
