# Electron Security Best Practices

This document provides comprehensive security guidelines for Electron applications.

## Core Security Principles

### 1. Context Isolation (REQUIRED)

**Always enable context isolation:**

```typescript
const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: true, // REQUIRED
  },
});
```

This ensures that preload scripts run in a separate context from web content, preventing web pages from accessing Electron or Node.js APIs.

### 2. Disable Node Integration (REQUIRED)

**Never enable Node.js in the renderer:**

```typescript
const win = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false, // REQUIRED (default in modern Electron)
  },
});
```

Enabling Node integration allows web content to access the file system and execute native code—a critical security vulnerability.

### 3. Enable Sandbox (RECOMMENDED)

```typescript
const win = new BrowserWindow({
  webPreferences: {
    sandbox: true, // Recommended
  },
});
```

Sandboxing provides an additional security layer by restricting renderer process capabilities.

### 4. Use Preload Scripts with Context Bridge

**Expose only necessary APIs:**

```typescript
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// Type-safe API definition
interface ElectronAPI {
  saveFile: (content: string) => Promise<boolean>;
  loadFile: () => Promise<string>;
  onThemeChange: (callback: (theme: string) => void) => void;
}

// Expose safe, specific methods
contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (content: string) =>
    ipcRenderer.invoke('file:save', content),

  loadFile: () =>
    ipcRenderer.invoke('file:load'),

  onThemeChange: (callback) => {
    ipcRenderer.on('theme:changed', (_event, theme) => callback(theme));
  },
} as ElectronAPI);

// Declare global type for TypeScript
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
```

### 5. Content Security Policy

**Implement strict CSP:**

```typescript
// main.ts
import { session } from 'electron';

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'", // Only if necessary
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self' https://api.yourdomain.com",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "upgrade-insecure-requests",
        ].join('; '),
      },
    });
  });
});
```

**Or in HTML:**

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'"
/>
```

### 6. Validate All Input

**Never trust data from the renderer:**

```typescript
// main/ipc/handlers.ts
import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs/promises';

ipcMain.handle('file:save', async (_event, filePath: string, content: string) => {
  // Validate inputs
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    throw new Error('Invalid input types');
  }

  // Sanitize path
  const userDataPath = app.getPath('userData');
  const safePath = path.resolve(userDataPath, path.basename(filePath));

  // Ensure path is within allowed directory
  if (!safePath.startsWith(userDataPath)) {
    throw new Error('Access denied: Invalid path');
  }

  // Check file size limits
  if (content.length > 10 * 1024 * 1024) { // 10MB limit
    throw new Error('File too large');
  }

  await fs.writeFile(safePath, content, 'utf-8');
  return true;
});
```

### 7. Control Navigation

**Prevent malicious redirects:**

```typescript
// main.ts
import { app, BrowserWindow, shell } from 'electron';

const win = new BrowserWindow({
  webPreferences: {
    webSecurity: true,
  },
});

// Handle navigation attempts
win.webContents.on('will-navigate', (event, url) => {
  const parsedUrl = new URL(url);

  // Only allow navigation to app's own pages
  if (parsedUrl.origin !== 'http://localhost:5173' && !app.isPackaged) {
    event.preventDefault();
  }
});

// Handle new window requests
win.webContents.setWindowOpenHandler(({ url }) => {
  // Open links in external browser
  if (url.startsWith('http://') || url.startsWith('https://')) {
    shell.openExternal(url);
    return { action: 'deny' };
  }

  return { action: 'deny' };
});
```

### 8. Disable or Limit Remote Content

**If you must load remote content:**

```typescript
const win = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    // Limit what remote content can do
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  },
});

// Validate URLs
const allowedDomains = ['https://yourdomain.com'];

win.webContents.on('will-navigate', (event, url) => {
  const parsedUrl = new URL(url);
  if (!allowedDomains.includes(parsedUrl.origin)) {
    event.preventDefault();
  }
});
```

## Security Checklist

Before releasing your Electron app, verify:

### Configuration
- [ ] `contextIsolation: true`
- [ ] `nodeIntegration: false`
- [ ] `sandbox: true`
- [ ] `webSecurity: true`
- [ ] `allowRunningInsecureContent: false`
- [ ] `experimentalFeatures: false`
- [ ] `enableRemoteModule: false`

### Code Practices
- [ ] Preload script uses `contextBridge`
- [ ] All IPC handlers validate input
- [ ] File paths are sanitized
- [ ] Navigation is controlled
- [ ] External links open in browser
- [ ] CSP is implemented
- [ ] No `eval()` or `Function()` in renderer
- [ ] Sensitive data is encrypted

### Build & Distribution
- [ ] Code signing certificate configured
- [ ] Auto-update uses HTTPS
- [ ] Update signatures verified
- [ ] Source maps disabled in production
- [ ] DevTools disabled in production
- [ ] Debug logging disabled

## Common Vulnerabilities

### ❌ Remote Code Execution

**Vulnerable:**
```typescript
// NEVER DO THIS
const win = new BrowserWindow({
  webPreferences: {
    nodeIntegration: true, // DANGEROUS!
  },
});
```

**Secure:**
```typescript
const win = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

### ❌ Cross-Site Scripting (XSS)

**Vulnerable:**
```typescript
// Renderer process
document.body.innerHTML = userInput; // DANGEROUS!
```

**Secure:**
```typescript
// Renderer process
const textNode = document.createTextNode(userInput);
document.body.appendChild(textNode);

// Or use a framework with automatic escaping
```

### ❌ Arbitrary File Access

**Vulnerable:**
```typescript
ipcMain.handle('read-file', async (_event, filePath) => {
  return fs.readFile(filePath); // DANGEROUS!
});
```

**Secure:**
```typescript
ipcMain.handle('read-file', async (_event, filePath) => {
  const allowedDir = app.getPath('userData');
  const safePath = path.resolve(allowedDir, path.basename(filePath));

  if (!safePath.startsWith(allowedDir)) {
    throw new Error('Access denied');
  }

  return fs.readFile(safePath);
});
```

## Environment-Specific Security

### Development
- DevTools available for debugging
- Hot reload enabled
- Localhost URLs allowed
- Detailed error messages

### Production
- DevTools disabled
- Source maps disabled
- Error messages generic
- All security features enabled
- Code signing active

```typescript
const isDevelopment = process.env.NODE_ENV === 'development';

const win = new BrowserWindow({
  webPreferences: {
    devTools: isDevelopment,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: !isDevelopment, // Easier debugging in dev
  },
});

if (!isDevelopment) {
  // Disable right-click menu in production
  win.webContents.on('context-menu', (e) => e.preventDefault());
}
```

## Third-Party Dependencies

### Audit Regularly
```bash
npm audit
npm audit fix
```

### Use Lock Files
- Commit `package-lock.json` or `yarn.lock`
- Ensures consistent dependency versions

### Minimize Dependencies
- Fewer dependencies = smaller attack surface
- Review what each package does
- Check package reputation and maintenance

## Data Protection

### Sensitive Data Storage

**Use encrypted storage:**
```typescript
import { safeStorage } from 'electron';

// Encrypt sensitive data
const encrypted = safeStorage.encryptString('sensitive-password');
store.set('credentials', encrypted.toString('base64'));

// Decrypt when needed
const encryptedBuffer = Buffer.from(store.get('credentials'), 'base64');
const decrypted = safeStorage.decryptString(encryptedBuffer);
```

### Environment Variables

```typescript
// Never hardcode secrets
const API_KEY = process.env.API_KEY; // Read from environment

// Use different keys for dev/prod
const config = {
  apiKey: isDevelopment ? 'dev-key' : process.env.API_KEY,
};
```

## Security Resources

- [Electron Security Guidelines](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP Desktop App Security](https://owasp.org/www-community/vulnerabilities/)
- [Electron Security Checklist](https://www.electronjs.org/docs/latest/tutorial/security#checklist-security-recommendations)

## Security Testing

### Manual Testing
1. Try to access `require()` from DevTools
2. Attempt to navigate to malicious URLs
3. Test IPC with invalid inputs
4. Check if local files are accessible
5. Verify CSP blocks inline scripts

### Automated Testing
```bash
# Use Electron security tools
npm install --save-dev @doyensec/electronegativity

# Run security scan
npx electronegativity --input src/
```

## Incident Response

If a security vulnerability is discovered:

1. **Assess impact**: Determine severity and affected versions
2. **Patch quickly**: Fix the vulnerability
3. **Release update**: Use auto-update to deploy fix
4. **Notify users**: Transparency builds trust
5. **Post-mortem**: Analyze how it happened and prevent recurrence

## Summary

The most critical security rules:

1. ✅ Enable `contextIsolation`
2. ✅ Disable `nodeIntegration`
3. ✅ Use `contextBridge` in preload
4. ✅ Validate all input from renderer
5. ✅ Implement CSP
6. ✅ Control navigation
7. ✅ Enable sandbox mode
8. ✅ Sign your code
9. ✅ Keep dependencies updated
10. ✅ Test security regularly

**Security is not optional. Build it in from day one.**
