import { useRef, useState, useEffect } from 'react';
import { List, Settings2, Ruler, FileText, ChevronLeft, ChevronRight, Package, Bot } from 'lucide-react';
import { MenuBar } from './MenuBar';
import { Toolbar } from './Toolbar';
import { DocumentTabs } from './DocumentTabs';
import { ModeTabs } from './ModeTabs';
import { Canvas } from './Canvas';
import { StatusBar } from './StatusBar';
import { PanelContainer } from './panels/PanelContainer';
import { MarkupsPanel } from './panels/MarkupsPanel';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { MeasurementsPanel } from './panels/MeasurementsPanel';
import { ProductsPanel } from './panels/ProductsPanel';
import { ProductDetailsPanel } from './panels/ProductDetailsPanel';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { AiChatDrawer } from '@/components/ai/AiChatDrawer';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useWindowClose } from '@/hooks/useWindowClose';
import { useProjectOpen } from '@/hooks/useProjectOpen';
import { useEditorStore } from '@/store/editorStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { toast } from 'sonner';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import type { ImperativePanelHandle } from 'react-resizable-panels';

export function EditorLayout() {
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(true);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(true);
  const [mode, setMode] = useState<'documents' | 'products'>('documents');
  
  const { activeDocument } = useEditorStore();
  const isAiChatOpen = useAIChatStore((state) => state.isOpen);
  
  const leftPanelRef = useRef<ImperativePanelHandle>(null);
  const rightPanelRef = useRef<ImperativePanelHandle>(null);
  const aiPanelRef = useRef<ImperativePanelHandle>(null);
  
  // Initialize keyboard shortcuts
  useKeyboardShortcuts();
  
  // Project file opening
  const { openProject } = useProjectOpen();
  
  // Handle window close with unsaved changes
  const { 
    showUnsavedDialog, 
    unsavedDocuments, 
    onSaveAndClose, 
    onDiscardAndClose, 
    onCancelClose 
  } = useWindowClose();

  // Collapse panels on initial mount
  useEffect(() => {
    const timer = setTimeout(() => {
      leftPanelRef.current?.collapse();
      rightPanelRef.current?.collapse();
      aiPanelRef.current?.collapse();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Keep the AI chat panel's collapsed state in sync with the chat store,
  // so the Toolbar button and Ctrl/Cmd+Shift+A shortcut still work now that
  // the chat lives in a docked panel instead of a modal drawer.
  useEffect(() => {
    const panel = aiPanelRef.current;
    if (!panel) return;
    if (isAiChatOpen && panel.isCollapsed()) {
      panel.expand();
    } else if (!isAiChatOpen && !panel.isCollapsed()) {
      panel.collapse();
    }
  }, [isAiChatOpen]);

  // Listen for file open events from Electron (double-click .bidveraai file)
  useEffect(() => {
    if (window.electronAPI?.onOpenProjectFile) {
      window.electronAPI.onOpenProjectFile(async (filePath: string) => {
        console.log('[EDITOR] Opening project file from system:', filePath);
        toast.loading('Opening project...', { id: 'open-project-file' });
        
        try {
          // Read the file
          const response = await fetch(`file://${filePath}`);
          if (!response.ok) {
            // Fallback: use Electron API to read the file
            const fileData = await window.electronAPI.openFile('project');
            if (!fileData) {
              toast.error('Failed to open project file', { id: 'open-project-file' });
              return;
            }
            
            const jsonString = new TextDecoder().decode(fileData.buffer);
            const projectData = JSON.parse(jsonString);
            await openProject(projectData, filePath);
          } else {
            const jsonString = await response.text();
            const projectData = JSON.parse(jsonString);
            await openProject(projectData, filePath);
          }
          
          toast.success('Project opened', { id: 'open-project-file' });
        } catch (error) {
          console.error('Failed to open project file:', error);
          toast.error('Failed to open project file', { id: 'open-project-file' });
        }
      });
    }
  }, [openProject]);

  const toggleLeftPanel = () => {
    const panel = leftPanelRef.current;
    if (panel) {
      if (leftPanelCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  };

  const toggleRightPanel = () => {
    const panel = rightPanelRef.current;
    if (panel) {
      if (rightPanelCollapsed) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  };

  const toggleAiPanel = () => {
    const panel = aiPanelRef.current;
    if (panel) {
      if (panel.isCollapsed()) {
        panel.expand();
      } else {
        panel.collapse();
      }
    }
  };

  const handleModeChange = (newMode: 'documents' | 'products') => {
    setMode(newMode);
    // Only auto-expand left panel if a document is loaded
    if (newMode === 'products' && leftPanelCollapsed && activeDocument) {
      leftPanelRef.current?.expand();
    }
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Menu bar */}
      <MenuBar />

      {/* Main toolbar */}
      <Toolbar />

      {/* Mode tabs */}
      <ModeTabs mode={mode} onModeChange={handleModeChange} />

      {/* Document tabs - only show in documents mode */}
      {mode === 'documents' && <DocumentTabs />}

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left panel - Markups */}
          <ResizablePanel 
            ref={leftPanelRef}
            defaultSize={20} 
            minSize={15} 
            maxSize={30}
            collapsible
            collapsedSize={0}
            onCollapse={() => setLeftPanelCollapsed(true)}
            onExpand={() => setLeftPanelCollapsed(false)}
          >
            <div className="h-full flex flex-col bg-panel border-r border-panel-border relative">
              {/* Clickable edge zone to collapse */}
              <div 
                className="absolute right-0 top-0 bottom-0 w-2 cursor-pointer hover:bg-primary/20 z-10 transition-colors"
                onClick={toggleLeftPanel}
                title="Click to collapse"
              />
              {mode === 'documents' ? (
                <>
                  <PanelContainer 
                    title="Markups" 
                    icon={<List className="w-3 h-3" />}
                  >
                    <div className="h-[400px]">
                      <MarkupsPanel />
                    </div>
                  </PanelContainer>

                  <PanelContainer 
                    title="Thumbnails" 
                    icon={<FileText className="w-3 h-3" />}
                    defaultCollapsed
                  >
                    <div className="h-48 p-2 grid grid-cols-2 gap-2">
                      {[1, 2, 3, 4].map((i) => (
                        <div 
                          key={i} 
                          className={`aspect-[8.5/11] bg-white/5 rounded border ${
                            i === 1 ? 'border-primary' : 'border-transparent'
                          } hover:border-muted-foreground/50 cursor-pointer flex items-center justify-center text-[10px] text-muted-foreground`}
                        >
                          {i}
                        </div>
                      ))}
                    </div>
                  </PanelContainer>
                </>
              ) : (
                <PanelContainer 
                  title="Products" 
                  icon={<Package className="w-3 h-3" />}
                  className="flex-1 min-h-0"
                >
                  <div className="h-full">
                    <ProductsPanel />
                  </div>
                </PanelContainer>
              )}
            </div>
          </ResizablePanel>

          {/* Left resize handle with collapse toggle */}
          <ResizableHandle withHandle className="relative">
            <button
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-4 h-8 flex items-center justify-center bg-panel-header hover:bg-secondary border border-panel-border rounded-sm"
              onClick={(e) => {
                e.stopPropagation();
                toggleLeftPanel();
              }}
            >
              {leftPanelCollapsed ? (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronLeft className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
          </ResizableHandle>

          {/* Main canvas */}
          <ResizablePanel defaultSize={60} minSize={30}>
            <Canvas />
          </ResizablePanel>

          {/* Right resize handle with collapse toggle */}
          <ResizableHandle withHandle className="relative">
            <button
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-4 h-8 flex items-center justify-center bg-panel-header hover:bg-secondary border border-panel-border rounded-sm"
              onClick={(e) => {
                e.stopPropagation();
                toggleRightPanel();
              }}
            >
              {rightPanelCollapsed ? (
                <ChevronLeft className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
          </ResizableHandle>

          {/* Right panel - Properties & Measurements (starts collapsed; user opens manually) */}
          <ResizablePanel 
            ref={rightPanelRef}
            defaultSize={0} 
            minSize={15} 
            maxSize={30}
            collapsible
            collapsedSize={0}
            onCollapse={() => setRightPanelCollapsed(true)}
            onExpand={() => setRightPanelCollapsed(false)}
          >
            <div className="h-full flex flex-col bg-panel border-l border-panel-border relative">
              {/* Clickable edge zone to collapse */}
              <div 
                className="absolute left-0 top-0 bottom-0 w-2 cursor-pointer hover:bg-primary/20 z-10 transition-colors"
                onClick={toggleRightPanel}
                title="Click to collapse"
              />
              {mode === 'documents' ? (
                <>
                  <PanelContainer 
                    title="Properties" 
                    icon={<Settings2 className="w-3 h-3" />}
                  >
                    <div className="h-[350px]">
                      <PropertiesPanel />
                    </div>
                  </PanelContainer>

                  <PanelContainer 
                    title="Measurements" 
                    icon={<Ruler className="w-3 h-3" />}
                  >
                    <div className="h-[250px]">
                      <MeasurementsPanel />
                    </div>
                  </PanelContainer>
                </>
              ) : (
                <PanelContainer 
                  title="Product Details" 
                  icon={<Package className="w-3 h-3" />}
                >
                  <div className="h-full">
                    <ProductDetailsPanel />
                  </div>
                </PanelContainer>
              )}
            </div>
          </ResizablePanel>

          {/* AI chat resize handle with collapse toggle */}
          <ResizableHandle withHandle className="relative">
            <button
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 w-4 h-8 flex items-center justify-center bg-panel-header hover:bg-secondary border border-panel-border rounded-sm"
              onClick={(e) => {
                e.stopPropagation();
                toggleAiPanel();
              }}
            >
              {isAiChatOpen ? (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronLeft className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
          </ResizableHandle>

          {/* AI chat panel - docked so the canvas and other panels stay usable while it's open */}
          <ResizablePanel
            ref={aiPanelRef}
            defaultSize={25}
            minSize={20}
            maxSize={35}
            collapsible
            collapsedSize={0}
            onCollapse={() => useAIChatStore.getState().closeDrawer()}
            onExpand={() => useAIChatStore.getState().openDrawer()}
          >
            <div className="h-full border-l border-panel-border">
              <AiChatDrawer />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Status bar */}
      <StatusBar />
      
      {/* Unsaved changes dialog for window close */}
      {showUnsavedDialog && unsavedDocuments.length > 0 && (
        <UnsavedChangesDialog
          open={showUnsavedDialog}
          documentName={
            unsavedDocuments.length === 1
              ? unsavedDocuments[0].name
              : `${unsavedDocuments.length} documents`
          }
          onSave={onSaveAndClose}
          onDiscard={onDiscardAndClose}
          onCancel={onCancelClose}
        />
      )}
    </div>
  );
}
