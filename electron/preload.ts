import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: (fileType?: 'pdf' | 'project') => ipcRenderer.invoke('dialog:openFile', fileType),
  saveFile: (data: ArrayBuffer, defaultName: string) => 
    ipcRenderer.invoke('dialog:saveFile', data, defaultName),
  saveFileDirect: (data: ArrayBuffer, filePath: string) =>
    ipcRenderer.invoke('dialog:saveFileDirect', data, filePath),
  onOpenProjectFile: (callback: (filePath: string) => void) => {
    ipcRenderer.on('open-project-file', (_, filePath) => callback(filePath));
  },
  
  // Flag to check if running in Electron
  isElectron: true,

  // Session storage for authentication
  storeSession: (sessionData: string) => ipcRenderer.invoke('auth:storeSession', sessionData),
  getStoredSession: () => ipcRenderer.invoke('auth:getStoredSession'),
  clearSession: () => ipcRenderer.invoke('auth:clearSession'),
  getTessdataPath: () => ipcRenderer.invoke('app:getTessdataPath'),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  
  // Window close handling
  confirmClose: () => ipcRenderer.invoke('window:confirm-close'),
  cancelClose: () => ipcRenderer.invoke('window:cancel-close'),
  
  // Window control methods for frameless window
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  
  onCheckUnsavedChanges: (callback: () => void) => {
    ipcRenderer.on('window:check-unsaved-changes', callback);
    return () => ipcRenderer.removeListener('window:check-unsaved-changes', callback);
  },
  
  // Menu event listeners
  onMenuOpen: (callback: () => void) => {
    ipcRenderer.on('menu:open', callback);
    return () => ipcRenderer.removeListener('menu:open', callback);
  },
  onMenuSave: (callback: () => void) => {
    ipcRenderer.on('menu:save', callback);
    return () => ipcRenderer.removeListener('menu:save', callback);
  },
  onMenuSaveAs: (callback: () => void) => {
    ipcRenderer.on('menu:saveAs', callback);
    return () => ipcRenderer.removeListener('menu:saveAs', callback);
  },
  onMenuPrint: (callback: () => void) => {
    ipcRenderer.on('menu:print', callback);
    return () => ipcRenderer.removeListener('menu:print', callback);
  },
  onMenuUndo: (callback: () => void) => {
    ipcRenderer.on('menu:undo', callback);
    return () => ipcRenderer.removeListener('menu:undo', callback);
  },
  onMenuRedo: (callback: () => void) => {
    ipcRenderer.on('menu:redo', callback);
    return () => ipcRenderer.removeListener('menu:redo', callback);
  },
  onMenuZoomIn: (callback: () => void) => {
    ipcRenderer.on('menu:zoomIn', callback);
    return () => ipcRenderer.removeListener('menu:zoomIn', callback);
  },
  onMenuZoomOut: (callback: () => void) => {
    ipcRenderer.on('menu:zoomOut', callback);
    return () => ipcRenderer.removeListener('menu:zoomOut', callback);
  },
  onMenuFitPage: (callback: () => void) => {
    ipcRenderer.on('menu:fitPage', callback);
    return () => ipcRenderer.removeListener('menu:fitPage', callback);
  },
  onUpdateChecking: (callback: () => void) => {
    ipcRenderer.on('update:checking', callback);
    return () => ipcRenderer.removeListener('update:checking', callback);
  },
  onUpdateAvailable: (callback: (info: any) => void) => {
    const handler = (_: unknown, info: any) => callback(info);
    ipcRenderer.on('update:available', handler);
    return () => ipcRenderer.removeListener('update:available', handler);
  },
  onUpdateNotAvailable: (callback: (info: any) => void) => {
    const handler = (_: unknown, info: any) => callback(info);
    ipcRenderer.on('update:not-available', handler);
    return () => ipcRenderer.removeListener('update:not-available', handler);
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const handler = (_: unknown, info: any) => callback(info);
    ipcRenderer.on('update:downloaded', handler);
    return () => ipcRenderer.removeListener('update:downloaded', handler);
  },
  onUpdateError: (callback: (error: { message?: string }) => void) => {
    const handler = (_: unknown, error: { message?: string }) => callback(error);
    ipcRenderer.on('update:error', handler);
    return () => ipcRenderer.removeListener('update:error', handler);
  },
});
