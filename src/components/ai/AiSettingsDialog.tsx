/**
 * AI Settings Dialog Component
 * Managed model assignments + assistant preferences
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
import type { AIProviderType } from '@/services/ai/providers/types';
import { cn } from '@/lib/utils';

interface AiSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AiSettingsDialog({ open, onOpenChange }: AiSettingsDialogProps) {
  const {
    pipelineModels,
    agentModels,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI Settings</DialogTitle>
          <DialogDescription>
            Managed AI models and assistant preferences
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models" className="mt-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="models">Takeoff</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="preferences">Preferences</TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="space-y-4 mt-4">
            <div className="flex items-start gap-2 p-3 bg-violet-500/10 border border-violet-500/20 rounded-lg">
              <Zap className="w-4 h-4 text-violet-500 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium text-violet-500">AI Powered by BidveraAi</p>
                <p className="text-muted-foreground text-xs mt-1">
                  AI features are included with your subscription. Stage models are assigned automatically for Run Takeoff. No API keys required.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <ManagedModelRow
                label="Document Vision Model"
                description="Analyzes blueprints and extracts components"
                currentModel={pipelineModels?.vision}
              />
              <ManagedModelRow
                label="Estimation Model"
                description="Calculates quantities and applies codes"
                currentModel={pipelineModels?.estimation}
              />
              <ManagedModelRow
                label="Placement Model"
                description="Generates precise canvas coordinates"
                currentModel={pipelineModels?.placement}
              />
            </div>
          </TabsContent>

          <TabsContent value="agent" className="space-y-4 mt-4">
            <div className="flex items-start gap-2 p-3 bg-secondary/40 border border-border rounded-lg">
              <Info className="w-4 h-4 text-muted-foreground mt-0.5" />
              <p className="text-xs text-muted-foreground">
                BidveraAi assigns router, primary, verifier, and fallback models for orchestration. Roles are not user-configurable.
              </p>
            </div>
            <ManagedModelRow
              label="Router model"
              description="Fast classification and path selection"
              currentModel={agentModels?.router}
            />
            <ManagedModelRow
              label="Primary agent model"
              description="Main reasoning and tool orchestration"
              currentModel={agentModels?.primary}
            />
            <ManagedModelRow
              label="Verifier model"
              description="Selective high-impact review only"
              currentModel={agentModels?.verifier}
            />
            <ManagedModelRow
              label="Fallback model"
              description="Used when the primary path fails"
              currentModel={agentModels?.fallback}
            />
          </TabsContent>

          <TabsContent value="preferences" className="space-y-4 mt-4">
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

function resolveModelDisplayName(
  selection: { provider: AIProviderType; model: string },
): string {
  const catalog = getAIService().getAllModels();
  const match = catalog.find(
    model => model.provider === selection.provider && model.id === selection.model,
  );
  return match?.name || selection.model;
}

function ManagedModelRow({
  label,
  description,
  currentModel,
}: {
  label: string;
  description: string;
  currentModel: { provider: AIProviderType; model: string } | undefined;
}) {
  const provider = currentModel?.provider || 'lovable';
  const model = currentModel?.model || 'openai/gpt-5.6-sol';
  const displayName = resolveModelDisplayName({ provider, model });

  return (
    <div className="space-y-2">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            provider === 'openai' && 'bg-green-500',
            provider === 'anthropic' && 'bg-orange-500',
            provider === 'gemini' && 'bg-blue-500',
            provider === 'lovable' && 'bg-pink-500',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{displayName}</div>
          <div className="text-[11px] text-muted-foreground">Assigned by BidveraAi</div>
        </div>
      </div>
    </div>
  );
}

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
