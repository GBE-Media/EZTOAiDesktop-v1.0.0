export interface ElectronFileData {
  buffer: ArrayBuffer;
  name: string;
  path: string;
}

export interface SaveFileResult {
  success: boolean;
  canceled?: boolean;
  path?: string;
  name?: string;
  error?: string;
}

export interface SaveFileDirectResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface ElectronAPI {
  // File operations
  openFile: (fileType?: 'pdf' | 'project') => Promise<ElectronFileData | null>;
  onOpenProjectFile: (callback: (filePath: string) => void) => void;
  saveFile: (data: ArrayBuffer, defaultName: string) => Promise<SaveFileResult>;
  saveFileDirect: (data: ArrayBuffer, filePath: string) => Promise<SaveFileDirectResult>;
  
  // Flag to check if running in Electron
  isElectron: boolean;

  // Session storage for authentication
  storeSession: (sessionData: string) => Promise<void>;
  getStoredSession: () => Promise<string | null>;
  clearSession: () => Promise<void>;
  getTessdataPath: () => Promise<string>;
  checkForUpdates: () => Promise<{
    status: 'unavailable' | 'checking' | 'error';
    message?: string;
    updateInfo?: any;
  }>;
  
  // Window close handling
  confirmClose: () => Promise<void>;
  cancelClose: () => Promise<boolean>;
  onCheckUnsavedChanges: (callback: () => void) => () => void;
  
  // Menu event listeners
  onMenuOpen: (callback: () => void) => () => void;
  onMenuSave: (callback: () => void) => () => void;
  onMenuSaveAs: (callback: () => void) => () => void;
  onMenuPrint: (callback: () => void) => () => void;
  onMenuUndo: (callback: () => void) => () => void;
  onMenuRedo: (callback: () => void) => () => void;
  onMenuZoomIn: (callback: () => void) => () => void;
  onMenuZoomOut: (callback: () => void) => () => void;
  onMenuFitPage: (callback: () => void) => () => void;

  // Update events
  onUpdateChecking: (callback: () => void) => () => void;
  onUpdateAvailable: (callback: (info: any) => void) => () => void;
  onUpdateNotAvailable: (callback: (info: any) => void) => () => void;
  onUpdateDownloaded: (callback: (info: any) => void) => () => void;
  onUpdateError: (callback: (error: { message?: string }) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
