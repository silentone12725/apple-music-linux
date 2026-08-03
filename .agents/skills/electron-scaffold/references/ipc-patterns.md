# Electron IPC Communication Patterns

Best practices for Inter-Process Communication (IPC) between main and renderer processes.

## IPC Architecture

Electron has two types of processes:
- **Main Process**: Node.js environment, manages windows and system APIs
- **Renderer Process**: Chromium environment, runs web content (one per window)

Communication flows through IPC channels via the `ipcMain` and `ipcRenderer` modules.

## Modern IPC Patterns

### 1. Invoke/Handle Pattern (Request-Response)

**Best for**: Request-response operations, async operations, operations that return values

**Main Process (Handler):**
```typescript
// main/ipc/handlers.ts
import { ipcMain, app, dialog } from 'electron';
import fs from 'fs/promises';
import path from 'path';

// Handle: receives request, returns response
ipcMain.handle('app:get-version', async () => {
  return app.getVersion();
});

ipcMain.handle('file:read', async (_event, filePath: string) => {
  // Validate and sanitize
  const userDataPath = app.getPath('userData');
  const safePath = path.resolve(userDataPath, path.basename(filePath));

  if (!safePath.startsWith(userDataPath)) {
    throw new Error('Access denied');
  }

  const content = await fs.readFile(safePath, 'utf-8');
  return content;
});

ipcMain.handle('dialog:open-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Text Files', extensions: ['txt', 'md'] }],
  });

  if (result.canceled) {
    return null;
  }

  return result.filePaths[0];
});
```

**Preload Script (Bridge):**
```typescript
// preload/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
});

// Type definitions
export interface ElectronAPI {
  getAppVersion: () => Promise<string>;
  readFile: (filePath: string) => Promise<string>;
  openFileDialog: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

**Renderer Process (Caller):**
```typescript
// renderer/app.ts
async function loadFile() {
  try {
    const filePath = await window.electronAPI.openFileDialog();
    if (!filePath) return;

    const content = await window.electronAPI.readFile(filePath);
    console.log('File content:', content);
  } catch (error) {
    console.error('Failed to read file:', error);
  }
}

async function displayVersion() {
  const version = await window.electronAPI.getAppVersion();
  document.getElementById('version').textContent = `v${version}`;
}
```

### 2. Send Pattern (One-Way Fire-and-Forget)

**Best for**: Logging, analytics, notifications that don't need responses

**Main Process:**
```typescript
// main/ipc/handlers.ts
import { ipcMain } from 'electron';

ipcMain.on('log:info', (_event, message: string) => {
  console.log('[Renderer]:', message);
  // Could write to file, send to logging service, etc.
});

ipcMain.on('analytics:event', (_event, eventName: string, data: any) => {
  // Send to analytics service
  trackEvent(eventName, data);
});

ipcMain.on('window:minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.minimize();
});
```

**Preload Script:**
```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  logInfo: (message: string) => ipcRenderer.send('log:info', message),
  trackEvent: (name: string, data: any) =>
    ipcRenderer.send('analytics:event', name, data),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
});
```

**Renderer Process:**
```typescript
// Fire and forget - no response expected
window.electronAPI.logInfo('User clicked button');
window.electronAPI.trackEvent('button_click', { button: 'save' });
window.electronAPI.minimizeWindow();
```

### 3. Event Listener Pattern (Main to Renderer)

**Best for**: Progress updates, status changes, push notifications from main process

**Main Process:**
```typescript
// main/main.ts
import { BrowserWindow } from 'electron';

function performLongTask(mainWindow: BrowserWindow) {
  let progress = 0;

  const interval = setInterval(() => {
    progress += 10;

    // Send progress updates to renderer
    mainWindow.webContents.send('task:progress', progress);

    if (progress >= 100) {
      clearInterval(interval);
      mainWindow.webContents.send('task:complete', {
        success: true,
        result: 'Task finished!',
      });
    }
  }, 1000);
}

// Theme change example
function changeTheme(mainWindow: BrowserWindow, theme: 'light' | 'dark') {
  mainWindow.webContents.send('theme:changed', theme);
}
```

**Preload Script:**
```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  // Subscribe to progress updates
  onTaskProgress: (callback: (progress: number) => void) => {
    ipcRenderer.on('task:progress', (_event, progress) => {
      callback(progress);
    });
  },

  // Subscribe to completion
  onTaskComplete: (callback: (result: any) => void) => {
    ipcRenderer.on('task:complete', (_event, result) => {
      callback(result);
    });
  },

  // Subscribe to theme changes
  onThemeChange: (callback: (theme: string) => void) => {
    ipcRenderer.on('theme:changed', (_event, theme) => {
      callback(theme);
    });
  },

  // Cleanup: Remove listeners
  removeTaskListeners: () => {
    ipcRenderer.removeAllListeners('task:progress');
    ipcRenderer.removeAllListeners('task:complete');
  },
});
```

**Renderer Process:**
```typescript
// Set up listeners
window.electronAPI.onTaskProgress((progress) => {
  updateProgressBar(progress);
});

window.electronAPI.onTaskComplete((result) => {
  console.log('Task complete:', result);
  showNotification('Task Complete!');
});

window.electronAPI.onThemeChange((theme) => {
  document.body.className = theme;
});

// Clean up when component unmounts
window.addEventListener('beforeunload', () => {
  window.electronAPI.removeTaskListeners();
});
```

### 4. Bidirectional Communication

**Best for**: Real-time updates, collaborative features, live data sync

**Main Process:**
```typescript
// main/ipc/chat.ts
import { ipcMain, BrowserWindow } from 'electron';

const activeSessions = new Map<number, BrowserWindow>();

ipcMain.on('chat:join', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    activeSessions.set(win.id, win);
  }
});

ipcMain.on('chat:message', (event, message: string) => {
  // Broadcast to all windows except sender
  activeSessions.forEach((window) => {
    if (window.webContents !== event.sender) {
      window.webContents.send('chat:message', message);
    }
  });
});

ipcMain.on('chat:leave', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    activeSessions.delete(win.id);
  }
});
```

**Preload Script:**
```typescript
contextBridge.exposeInMainWorld('chat', {
  join: () => ipcRenderer.send('chat:join'),
  leave: () => ipcRenderer.send('chat:leave'),
  sendMessage: (message: string) => ipcRenderer.send('chat:message', message),
  onMessage: (callback: (message: string) => void) => {
    ipcRenderer.on('chat:message', (_event, message) => callback(message));
  },
});
```

**Renderer Process:**
```typescript
// Join chat
window.chat.join();

// Listen for messages
window.chat.onMessage((message) => {
  displayMessage(message);
});

// Send message
sendButton.addEventListener('click', () => {
  const message = inputField.value;
  window.chat.sendMessage(message);
});

// Leave on close
window.addEventListener('beforeunload', () => {
  window.chat.leave();
});
```

## Advanced Patterns

### 5. Stream Pattern (Large Data)

**For large files or continuous data streams:**

```typescript
// main/ipc/stream.ts
import { ipcMain } from 'electron';
import fs from 'fs';
import { pipeline } from 'stream/promises';

ipcMain.handle('file:stream-read', async (event, filePath: string) => {
  const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

  stream.on('data', (chunk) => {
    event.sender.send('file:chunk', chunk.toString());
  });

  stream.on('end', () => {
    event.sender.send('file:complete');
  });

  stream.on('error', (error) => {
    event.sender.send('file:error', error.message);
  });

  return { started: true };
});
```

**Preload:**
```typescript
contextBridge.exposeInMainWorld('fileStream', {
  startRead: (path: string) => ipcRenderer.invoke('file:stream-read', path),
  onChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('file:chunk', (_event, chunk) => callback(chunk));
  },
  onComplete: (callback: () => void) => {
    ipcRenderer.on('file:complete', callback);
  },
  onError: (callback: (error: string) => void) => {
    ipcRenderer.on('file:error', (_event, error) => callback(error));
  },
});
```

### 6. Batch Pattern (Performance)

**Batch multiple operations to reduce IPC overhead:**

```typescript
// main/ipc/batch.ts
ipcMain.handle('batch:operations', async (_event, operations: Operation[]) => {
  const results = await Promise.all(
    operations.map(async (op) => {
      try {
        return { success: true, data: await executeOperation(op) };
      } catch (error) {
        return { success: false, error: error.message };
      }
    })
  );

  return results;
});
```

**Renderer:**
```typescript
const operations = [
  { type: 'read', path: 'file1.txt' },
  { type: 'read', path: 'file2.txt' },
  { type: 'write', path: 'file3.txt', content: 'data' },
];

const results = await window.electronAPI.batchOperations(operations);
```

### 7. Request ID Pattern (Tracking)

**Track requests with unique IDs:**

```typescript
// preload/preload.ts
let requestId = 0;

contextBridge.exposeInMainWorld('api', {
  request: async (action: string, data: any) => {
    const id = ++requestId;
    return ipcRenderer.invoke('api:request', { id, action, data });
  },
});
```

```typescript
// main/ipc/api.ts
ipcMain.handle('api:request', async (_event, request) => {
  const { id, action, data } = request;

  try {
    const result = await handleAction(action, data);
    return { id, success: true, result };
  } catch (error) {
    return { id, success: false, error: error.message };
  }
});
```

## Type Safety

### Shared Type Definitions

```typescript
// shared/types.ts
export interface FileOperation {
  type: 'read' | 'write' | 'delete';
  path: string;
  content?: string;
}

export interface FileResult {
  success: boolean;
  data?: string;
  error?: string;
}

export interface ElectronAPI {
  fileOperation: (op: FileOperation) => Promise<FileResult>;
  getVersion: () => Promise<string>;
}
```

**Main Process:**
```typescript
import { FileOperation, FileResult } from '../shared/types';

ipcMain.handle('file:operation', async (_event, op: FileOperation): Promise<FileResult> => {
  // Implementation
});
```

**Preload:**
```typescript
import { ElectronAPI, FileOperation } from '../shared/types';

const api: ElectronAPI = {
  fileOperation: (op) => ipcRenderer.invoke('file:operation', op),
  getVersion: () => ipcRenderer.invoke('app:version'),
};

contextBridge.exposeInMainWorld('electronAPI', api);
```

## Error Handling

### Graceful Error Handling

```typescript
// main/ipc/handlers.ts
ipcMain.handle('risky:operation', async (_event, data) => {
  try {
    const result = await performRiskyOperation(data);
    return { success: true, data: result };
  } catch (error) {
    // Log error
    console.error('Operation failed:', error);

    // Return structured error
    return {
      success: false,
      error: {
        message: error.message,
        code: error.code,
        timestamp: Date.now(),
      },
    };
  }
});
```

**Renderer:**
```typescript
async function performOperation() {
  const result = await window.electronAPI.riskyOperation(data);

  if (result.success) {
    handleSuccess(result.data);
  } else {
    handleError(result.error);
  }
}
```

## Performance Best Practices

### 1. Minimize IPC Calls

```typescript
// ❌ Bad: Multiple calls
const name = await api.getUserName();
const email = await api.getUserEmail();
const age = await api.getUserAge();

// ✅ Good: Single call
const user = await api.getUserInfo();
```

### 2. Use Appropriate Patterns

- **invoke/handle**: When you need a response
- **send/on**: For fire-and-forget operations
- **Batch**: For multiple operations
- **Stream**: For large data

### 3. Avoid Large Payloads

```typescript
// ❌ Bad: Send entire object
ipcRenderer.invoke('save:data', massiveObject);

// ✅ Good: Send only what's needed
ipcRenderer.invoke('save:data', {
  id: massiveObject.id,
  changes: extractChanges(massiveObject),
});
```

### 4. Debounce Frequent Events

```typescript
// renderer/utils.ts
function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): T {
  let timeoutId: NodeJS.Timeout;
  return ((...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

// Usage
const debouncedSave = debounce(
  (content: string) => window.electronAPI.saveContent(content),
  500
);

textArea.addEventListener('input', (e) => {
  debouncedSave(e.target.value);
});
```

## Security Considerations

### 1. Validate All Input

```typescript
ipcMain.handle('file:read', async (_event, filePath: unknown) => {
  // Type validation
  if (typeof filePath !== 'string') {
    throw new Error('Invalid file path type');
  }

  // Path validation
  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    throw new Error('Invalid file path');
  }

  // Continue with safe path...
});
```

### 2. Use Channel Naming Convention

```typescript
// Pattern: category:action
'app:get-version'
'file:read'
'file:write'
'dialog:open'
'window:minimize'
'user:login'
```

### 3. Limit Exposed APIs

```typescript
// ❌ Bad: Expose everything
contextBridge.exposeInMainWorld('electron', {
  ipcRenderer, // DANGEROUS!
});

// ✅ Good: Expose specific, safe methods
contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (content: string) => ipcRenderer.invoke('file:save', content),
  loadFile: () => ipcRenderer.invoke('file:load'),
});
```

## Testing IPC

### Unit Testing

```typescript
// test/ipc.test.ts
import { ipcMain } from 'electron';

describe('IPC Handlers', () => {
  it('should return app version', async () => {
    const event = {} as any;
    const handler = ipcMain.handle.mock.calls.find(
      ([channel]) => channel === 'app:get-version'
    )[1];

    const result = await handler(event);
    expect(result).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

## Summary

### Best Practices

1. ✅ Use `invoke/handle` for request-response
2. ✅ Use `send/on` for fire-and-forget
3. ✅ Always use `contextBridge` in preload
4. ✅ Validate all inputs in handlers
5. ✅ Use TypeScript for type safety
6. ✅ Batch operations when possible
7. ✅ Handle errors gracefully
8. ✅ Clean up event listeners
9. ✅ Use consistent naming conventions
10. ✅ Document your IPC API

### Common Pitfalls

- ❌ Exposing `ipcRenderer` directly
- ❌ Not validating input from renderer
- ❌ Sending large objects over IPC
- ❌ Not removing event listeners
- ❌ Using synchronous IPC (`sendSync`)
- ❌ Not handling errors
- ❌ Inconsistent channel naming

**Use these patterns to build secure, performant, and maintainable Electron applications.**
