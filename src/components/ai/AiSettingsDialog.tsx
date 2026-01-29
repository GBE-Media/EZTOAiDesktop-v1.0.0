/**
 * AI Settings Dialog Component
 * Configure model selection and AI preferences
 * API keys are managed by the company via Edge Function proxy
 */

import { Info, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { getAIService } from '@/services/ai/aiService';
import type { AIProviderType, PipelineStage } from '@/services/ai/providers/types';
import { cn } from '@/lib/utils';

interface AiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AiSettingsDialog({ open, onOpenChange }: AiSettingsDialogProps) {
  const {
    pipelineModels,
    setPipelineModel,
    defaultTrade,
    setDefaultTrade,
    defaultPlacementMode,
    setDefaultPlacementMode,
    enableSmartSuggestions,
    setEnableSmartSuggestions,
    showCodeReferences,
    setShowCodeReferences,
    autoExtractLocation,
    setAutoExtractLocation,
  } = useAISettingsStore();

  const getModelsForProvider = (provider: AIProviderType) => {
    const allModels = getAIService().getAllModels();
    return allModels.filter(m => m.provider === provider);
  };

  const getVisionModels = () => {
    return getAIService().getVisionModels();
  };

  const getAllModels = () => {
    return getAIService().getAllModels();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI Settings</DialogTitle>
          <DialogDescription>
            Configure AI models and preferences
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models" className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="models">Models</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
          </TabsList>

          {/* Models Tab */}
          <TabsContent value="models" className="space-y-4 mt-4">
            {/* Info banner */}
            <div className="flex items-start gap-2 p-3 bg-violet-500/10 border border-violet-500/20 rounded-lg">
              <Zap className="w-4 h-4 text-violet-500 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-violet-500">AI Powered by EZTO</p>
                <p className="text-muted-foreground text-xs mt-1">
                  AI features are included with your subscription. No API keys required.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Vision Model */}
              <ModelSelector
                stage="vision"
                label="Document Vision Model"
                description="Analyzes blueprints and extracts components"
                currentModel={pipelineModels?.vision}
                models={getVisionModels()}
                onChange={(selection) => setPipelineModel('vision', selection)}
              />

              {/* Estimation Model */}
              <ModelSelector
                stage="estimation"
                label="Estimation Model"
                description="Calculates quantities and applies codes"
                currentModel={pipelineModels?.estimation}
                models={getAllModels()}
                onChange={(selection) => setPipelineModel('estimation', selection)}
              />

              {/* Placement Model */}
              <ModelSelector
                stage="placement"
                label="Placement Model"
                description="Generates precise canvas coordinates"
                currentModel={pipelineModels?.placement}
                models={getAllModels().filter(m => m.supportsStructuredOutput)}
                onChange={(selection) => setPipelineModel('placement', selection)}
              />
            </div>
          </TabsContent>

          {/* Preferences Tab */}
          <TabsContent value="preferences" className="space-y-4 mt-4">
            {/* Default Trade */}
            <div className="space-y-2">
              <Label>Default Trade</Label>
              <Select
                value={defaultTrade}
                onValueChange={(value: 'electrical' | 'plumbing' | 'hvac') => setDefaultTrade(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="electrical">Electrical</SelectItem>
                  <SelectItem value="plumbing">Plumbing</SelectItem>
                  <SelectItem value="hvac">HVAC</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Default Placement Mode */}
            <div className="space-y-2">
              <Label>Default Placement Mode</Label>
              <Select
                value={defaultPlacementMode}
                onValueChange={(value: 'auto' | 'confirm') => setDefaultPlacementMode(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-place markups</SelectItem>
                  <SelectItem value="confirm">Confirm before placing</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Toggles */}
            <div className="space-y-3 pt-2">
              <ToggleOption
                label="Enable Smart Suggestions"
                description="Get AI-recommended layouts and routing"
                checked={enableSmartSuggestions}
                onCheckedChange={setEnableSmartSuggestions}
              />

              <ToggleOption
                label="Show Code References"
                description="Display NEC, UPC, IBC code references"
                checked={showCodeReferences}
                onCheckedChange={setShowCodeReferences}
              />

              <ToggleOption
                label="Auto-Extract Location"
                description="Automatically detect project location from title block"
                checked={autoExtractLocation}
                onCheckedChange={setAutoExtractLocation}
              />
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// Model Selector Component
function ModelSelector({
  stage,
  label,
  description,
  currentModel,
  models,
  onChange,
}: {
  stage: PipelineStage;
  label: string;
  description: string;
  currentModel: { provider: AIProviderType; model: string } | undefined;
  models: Array<{ id: string; name: string; provider: AIProviderType }>;
  onChange: (selection: { provider: AIProviderType; model: string }) => void;
}) {
  // Default fallback if currentModel is undefined
  const provider = currentModel?.provider || 'openai';
  const model = currentModel?.model || 'gpt-4o';
  const value = `${provider}:${model}`;

  return (
    <div className="space-y-2">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={value}
        onValueChange={(v) => {
          const [provider, model] = v.split(':') as [AIProviderType, string];
          onChange({ provider, model });
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
              <div className="flex items-center gap-2">
                <span className={cn(
                  'w-2 h-2 rounded-full',
                  model.provider === 'openai' && 'bg-green-500',
                  model.provider === 'anthropic' && 'bg-orange-500',
                  model.provider === 'gemini' && 'bg-blue-500'
                )} />
                {model.name}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Toggle Option Component
function ToggleOption({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
