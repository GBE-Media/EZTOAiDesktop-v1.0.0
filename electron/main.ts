import { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

const sendToRenderer = (channel: string, payload?: any) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// Debug logging helper
const log = (location: string, message: string, data: any = {}) => {
  try {
    const logEntry = {
      location,
      message,
      data,
      timestamp: Date.now(),
      sessionId: 'electron-debug',
      runId: 'run1'
    };
    // Also log to console for immediate visibility
    console.log(`[DEBUG] ${location}: ${message}`, JSON.stringify(data, null, 2));
    
    // Write logs to OS app data so packaged builds can write successfully
    const logDir = app.getPath('logs');
    const logPath = path.join(logDir, 'ezto-ai.log');
    
    console.log(`[DEBUG] Log path: ${logPath}, dir: ${logDir}, exists: ${fs.existsSync(logDir)}`);
    
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n');
    console.log(`[DEBUG] Log written successfully to ${logPath}`);
  } catch (error: any) {
    console.error('[DEBUG] Logging error:', error.message, error.stack);
  }
};

const getAssetPath = (...paths: string[]) => {
  const basePath = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
  return path.join(basePath, ...paths);
};

// Secure session storage path
const getSessionPath = () => path.join(app.getPath('userData'), 'session.enc');

function createWindow() {
  // #region agent log
  log('electron/main.ts:createWindow', 'createWindow called', { __dirname, isDev });
  // #endregion
  
  try {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 800,
      minHeight: 600,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
      icon: getAssetPath('public', 'favicon.ico'),
      show: false,
      backgroundColor: '#0a0a0a',
      title: 'EZTO Ai - PDF Takeoff',
      autoHideMenuBar: true,  // Hide menu bar like Bluebeam
      frame: true,
      titleBarStyle: 'default',
    });
    
    // #region agent log
    log('electron/main.ts:createWindow', 'BrowserWindow created', { windowExists: !!mainWindow });
    // #endregion

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
      // #region agent log
      log('electron/main.ts:ready-to-show', 'Window ready to show');
      // #endregion
      mainWindow?.show();
    });

    const filePath = path.join(__dirname, '../dist/index.html');
    const fileExists = fs.existsSync(filePath);
    
    // #region agent log
    log('electron/main.ts:createWindow', 'Before loadFile', { filePath, fileExists, __dirname });
    // #endregion
    
    // Load the app from local files
    mainWindow.loadFile(filePath).catch((error: Error) => {
      // #region agent log
      log('electron/main.ts:loadFile', 'loadFile error', { error: error.message, stack: error.stack });
      // #endregion
      console.error('Failed to load file:', error);
    });
    
    // #region agent log
    log('electron/main.ts:createWindow', 'After loadFile', { loadFileCalled: true });
    // #endregion
    
    // Open DevTools in development mode (can be toggled via menu)
    if (isDev) {
      mainWindow.webContents.openDevTools();
    }
    
    // Log any console messages from renderer
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[RENDERER] ${message}`);
    });
    
    // Disable navigation to external URLs
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // Prevent closing if there are unsaved changes
    mainWindow.on('close', (event) => {
      if (mainWindow) {
        // Ask the renderer if there are unsaved changes
        mainWindow.webContents.send('window:check-unsaved-changes');
        // Prevent default close - renderer will decide
        event.preventDefault();
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (error: any) {
    // #region agent log
    log('electron/main.ts:createWindow', 'createWindow error', { error: error.message, stack: error.stack });
    // #endregion
    console.error('Error in createWindow:', error);
  }
}

// Create native application menu
function createMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu:open');
          },
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('menu:save');
          },
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            mainWindow?.webContents.send('menu:saveAs');
          },
        },
        { type: 'separator' },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            mainWindow?.webContents.send('menu:print');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          click: () => {
            mainWindow?.webContents.send('menu:undo');
          },
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          click: () => {
            mainWindow?.webContents.send('menu:redo');
          },
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => {
            mainWindow?.webContents.send('menu:zoomIn');
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => {
            mainWindow?.webContents.send('menu:zoomOut');
          },
        },
        {
          label: 'Fit to Page',
          accelerator: 'CmdOrCtrl+0',
          click: () => {
            mainWindow?.webContents.send('menu:fitPage');
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: 'About PDF Editor',
              message: 'PDF Editor',
              detail: 'A professional PDF markup and annotation tool.\n\nVersion 1.0.0',
            });
          },
        },
      ],
    },
  ];

  // Add macOS-specific menu
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// IPC Handlers for native file dialogs
ipcMain.handle('dialog:openFile', async (_, fileType?: 'pdf' | 'project') => {
  const filters = fileType === 'pdf' 
    ? [{ name: 'PDF Files', extensions: ['pdf'] }]
    : [
        { name: 'EZTO Project Files', extensions: ['ezto'] },
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ];

  const result = await dialog.showOpenDialog(mainWindow!, {
    filters,
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  const name = path.basename(filePath);

  return {
    buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    name,
    path: filePath,
  };
});

// Save As - shows native dialog, returns path info
ipcMain.handle('dialog:saveFile', async (_, data: ArrayBuffer, defaultName: string) => {
  // Determine file type from extension
  const isProject = defaultName.endsWith('.ezto');
  const filters = isProject
    ? [{ name: 'EZTO Project Files', extensions: ['ezto'] }]
    : [{ name: 'PDF Files', extensions: ['pdf'] }];

  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    filters,
  });

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true };
  }

  try {
    fs.writeFileSync(result.filePath, Buffer.from(data));
    return { 
      success: true, 
      path: result.filePath, 
      name: path.basename(result.filePath) 
    };
  } catch (error) {
    console.error('Failed to save file:', error);
    return { success: false, error: (error as Error).message };
  }
});

// Save Direct - overwrites existing file without dialog
ipcMain.handle('dialog:saveFileDirect', async (_, data: ArrayBuffer, filePath: string) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(data));
    return { success: true, path: filePath };
  } catch (error) {
    console.error('Failed to save file:', error);
    return { success: false, error: (error as Error).message };
  }
});

// IPC Handlers for secure session storage
ipcMain.handle('auth:storeSession', async (_, sessionData: string) => {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(sessionData);
      fs.writeFileSync(getSessionPath(), encrypted);
    } else {
      // Fallback: store as base64 (less secure but works)
      fs.writeFileSync(getSessionPath(), Buffer.from(sessionData).toString('base64'));
    }
  } catch (error) {
    console.error('Failed to store session:', error);
  }
});

ipcMain.handle('auth:getStoredSession', async () => {
  try {
    const sessionPath = getSessionPath();
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    
    const data = fs.readFileSync(sessionPath);
    
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(data);
    } else {
      // Fallback: decode from base64
      return Buffer.from(data.toString(), 'base64').toString();
    }
  } catch (error) {
    console.error('Failed to get stored session:', error);
    return null;
  }
});

ipcMain.handle('auth:clearSession', async () => {
  try {
    const sessionPath = getSessionPath();
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  } catch (error) {
    console.error('Failed to clear session:', error);
  }
});

ipcMain.handle('app:getTessdataPath', async () => {
  const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(basePath, 'tessdata');
});

ipcMain.handle('app:checkForUpdates', async () => {
  if (!app.isPackaged) {
    return { status: 'unavailable', message: 'Updates are only available in the packaged app.' };
  }

  try {
    const result = await autoUpdater.checkForUpdates();
    return { status: 'checking', updateInfo: result?.updateInfo };
  } catch (error: any) {
    return { status: 'error', message: error?.message || 'Update check failed.' };
  }
});

// Allow renderer to confirm window close
ipcMain.handle('window:confirm-close', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
});

// Allow renderer to cancel window close
ipcMain.handle('window:cancel-close', async () => {
  // Do nothing - window close was already prevented
  return true;
});

// App lifecycle
console.log('[DEBUG] Electron starting...', { isDev, isPackaged: app.isPackaged, __dirname: __dirname });
// Handle opening .ezto files from Windows Explorer (double-click)
let fileToOpen: string | null = null;

// On Windows/Linux, this fires when a file is double-clicked
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  console.log('[DEBUG] open-file event:', filePath);
  
  if (mainWindow) {
    // Window already exists, send file path to renderer
    mainWindow.webContents.send('open-project-file', filePath);
  } else {
    // Store for later when window is created
    fileToOpen = filePath;
  }
});

// On Windows, check command line args for file path
if (process.platform === 'win32' && process.argv.length >= 2) {
  const filePath = process.argv[process.argv.length - 1];
  if (filePath && filePath.endsWith('.ezto') && fs.existsSync(filePath)) {
    fileToOpen = filePath;
    console.log('[DEBUG] File from command line:', fileToOpen);
  }
}

app.whenReady().then(() => {
  // #region agent log
  log('electron/main.ts:app.whenReady', 'App ready', { isDev, isPackaged: app.isPackaged, __dirname, fileToOpen });
  // #endregion
  
  console.log('[DEBUG] App ready, creating window...');
  createWindow();
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.on('checking-for-update', () => {
      log('autoUpdater', 'checking-for-update');
      sendToRenderer('update:checking');
    });
    autoUpdater.on('update-available', (info: any) => {
      log('autoUpdater', 'update-available', info);
      sendToRenderer('update:available', info);
    });
    autoUpdater.on('update-not-available', (info: any) => {
      log('autoUpdater', 'update-not-available', info);
      sendToRenderer('update:not-available', info);
    });
    autoUpdater.on('error', (error: Error) => {
      log('autoUpdater', 'error', { message: error.message });
      sendToRenderer('update:error', { message: error.message });
    });
    autoUpdater.on('download-progress', (progress: any) => {
      log('autoUpdater', 'download-progress', progress);
      sendToRenderer('update:download-progress', progress);
    });
    autoUpdater.on('update-downloaded', (info: any) => {
      log('autoUpdater', 'update-downloaded', info);
      sendToRenderer('update:downloaded', info);
    });
    autoUpdater.checkForUpdatesAndNotify().catch((error: Error) => {
      log('autoUpdater', 'checkForUpdatesAndNotify error', { message: error.message });
    });
  }
  // Don't create menu - using in-app menu bar like Bluebeam
  // createMenu();

  // If a file was specified, open it after window is ready
  if (fileToOpen && mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[DEBUG] Sending file to renderer:', fileToOpen);
      mainWindow?.webContents.send('open-project-file', fileToOpen);
      fileToOpen = null;
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error: Error) => {
  // #region agent log
  log('electron/main.ts:app.whenReady', 'App ready error', { error: error.message, stack: error.stack });
  // #endregion
  console.error('App ready error:', error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
