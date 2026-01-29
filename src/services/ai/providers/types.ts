/**
 * AI Provider Types and Interfaces
 * Defines the contract for all AI providers (OpenAI, Anthropic, etc.)
 */

export type AIProviderType = 'openai' | 'anthropic' | 'gemini';

export type PipelineStage = 'vision' | 'estimation' | 'placement';

export type TradeType = 'electrical' | 'plumbing' | 'hvac';

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[]; // Base64 encoded images for vision models
}

export interface AICompletionRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface AICompletionResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error';
}

export interface AIVisionRequest extends AICompletionRequest {
  images: string[]; // Base64 encoded images
}

export interface AIProvider {
  name: AIProviderType;
  
  /**
   * Check if the provider is configured with valid API key
   */
  isConfigured(): boolean;
  
  /**
   * Send a text completion request
   */
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
  
  /**
   * Send a vision request (for models that support image analysis)
   */
  vision(request: AIVisionRequest): Promise<AICompletionResponse>;
  
  /**
   * Get available models for this provider
   */
  getModels(): AIModelInfo[];
  
  /**
   * Get the default model for a specific pipeline stage
   */
  getDefaultModel(stage: PipelineStage): string;
}

export interface AIModelInfo {
  id: string;
  name: string;
  provider: AIProviderType;
  capabilities: ModelCapability[];
  contextWindow: number;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  costPer1kTokens?: {
    input: number;
    output: number;
  };
}

export type ModelCapability = 
  | 'text'
  | 'vision'
  | 'structured-output'
  | 'function-calling'
  | 'code'
  | 'reasoning';

export interface PipelineConfig {
  visionModel: {
    provider: AIProviderType;
    model: string;
  };
  estimationModel: {
    provider: AIProviderType;
    model: string;
  };
  placementModel: {
    provider: AIProviderType;
    model: string;
  };
}

export interface BlueprintAnalysisResult {
  page: number;
  items: DetectedItem[];
  dimensions: DetectedDimension[];
  text: ExtractedText[];
  symbols: DetectedSymbol[];
  location?: ProjectLocation;
}

export interface DetectedItem {
  id: string;
  type: string;
  trade: TradeType;
  name: string;
  quantity: number;
  location: {
    x: number;
    y: number;
    width?: number;
    height?: number;
  };
  confidence: number;
  codeReference?: string;
  notes?: string;
}

export interface DetectedDimension {
  value: number;
  unit: string;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
}

export interface ExtractedText {
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;
}

export interface DetectedSymbol {
  type: string;
  trade: TradeType;
  location: { x: number; y: number };
  rotation?: number;
  scale?: number;
}

export interface ProjectLocation {
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  jurisdiction?: string;
}

export interface MaterialEstimate {
  trade: TradeType;
  items: MaterialItem[];
  totalCost?: number;
  codeReferences: CodeReference[];
  notes: string[];
}

export interface MaterialItem {
  id: string;
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  unitCost?: number;
  totalCost?: number;
  codeReference?: string;
  linkedMarkupIds?: string[];
}

export interface CodeReference {
  code: string;
  section: string;
  description: string;
  trade: TradeType;
  edition?: string;
}

export interface CanvasPlacement {
  markups: PlacementMarkup[];
  notes: PlacementNote[];
}

export interface PlacementMarkup {
  id: string;
  type: 'count-marker' | 'measurement-length' | 'measurement-area' | 'polyline' | 'polygon' | 'text';
  page: number;
  points: { x: number; y: number }[];
  style: {
    strokeColor: string;
    fillColor: string;
    strokeWidth: number;
  };
  label?: string;
  aiNote?: string;
  linkedItemId?: string;
  pending: boolean; // For suggest-and-confirm mode
}

export interface PlacementNote {
  id: string;
  page: number;
  position: { x: number; y: number };
  text: string;
  linkedMarkupId?: string;
}

export interface LayoutSuggestion {
  id: string;
  trade: TradeType;
  type: 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent';
  name: string;
  description: string;
  routes: LayoutRoute[];
  totalLength: number;
  estimatedCost?: number;
  codeCompliance: boolean;
  notes: string[];
}

export interface LayoutRoute {
  id: string;
  points: { x: number; y: number }[];
  page: number;
  segments: RouteSegment[];
}

export interface RouteSegment {
  start: { x: number; y: number };
  end: { x: number; y: number };
  length: number;
  type: 'straight' | 'elbow' | 'transition';
  notes?: string;
}
