# Electron Build and Packaging Configuration

Comprehensive guide for building, packaging, and distributing Electron applications.

## Build Tool Options

### 1. Electron Forge

**Best for**: Most projects, integrated tooling, plugins

**Installation:**
```bash
npm install --save-dev @electron-forge/cli
npx electron-forge import
```

**forge.config.js:**
```javascript
module.exports = {
  packagerConfig: {
    name: 'MyApp',
    executableName: 'myapp',
    icon: './assets/icon',
    asar: true,
    appBundleId: 'com.company.myapp',
    appCategoryType: 'public.app-category.productivity',
    win32metadata: {
      CompanyName: 'My Company',
      ProductName: 'My App',
    },
    osxSign: {
      identity: 'Developer ID Application: My Company',
      hardenedRuntime: true,
      entitlements: 'entitlements.plist',
      'entitlements-inherit': 'entitlements.plist',
      'signature-flags': 'library',
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'myapp',
        authors: 'My Company',
        description: 'My amazing app',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          maintainer: 'My Company',
          homepage: 'https://myapp.com',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        icon: './assets/icon.icns',
        background: './assets/dmg-background.png',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.js',
        renderer: {
          config: './webpack.renderer.config.js',
          entryPoints: [
            {
              html: './src/renderer/index.html',
              js: './src/renderer/index.ts',
              name: 'main_window',
              preload: {
                js: './src/preload/preload.ts',
              },
            },
          ],
        },
      },
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'my-username',
          name: 'my-repo',
        },
        prerelease: false,
        draft: true,
      },
    },
  ],
};
```

### 2. Electron Builder

**Best for**: Complex packaging needs, highly configurable

**Installation:**
```bash
npm install --save-dev electron-builder
```

**electron-builder.yml:**
```yaml
appId: com.company.myapp
productName: MyApp
copyright: Copyright © 2024 My Company

# Directories
directories:
  output: dist
  buildResources: resources

# Files to include/exclude
files:
  - "!**/*.ts"
  - "!**/*.map"
  - "!**/.DS_Store"
  - src/**/*
  - package.json

# Metadata
asar: true
compression: maximum

# macOS
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch:
        - x64
        - arm64
    - target: zip
      arch:
        - x64
        - arm64
  icon: resources/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.plist
  notarize:
    teamId: ${APPLE_TEAM_ID}

dmg:
  sign: false
  background: resources/dmg-background.png
  icon: resources/volume-icon.icns
  iconSize: 100
  contents:
    - x: 380
      y: 180
      type: link
      path: /Applications
    - x: 122
      y: 180
      type: file

# Windows
win:
  target:
    - target: nsis
      arch:
        - x64
        - ia32
    - target: portable
      arch:
        - x64
    - target: zip
      arch:
        - x64
  icon: resources/icon.ico
  publisherName: "My Company"
  verifyUpdateCodeSignature: true
  certificateFile: ${WIN_CERT_FILE}
  certificatePassword: ${WIN_CERT_PASSWORD}

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  installerIcon: resources/installer-icon.ico
  uninstallerIcon: resources/uninstaller-icon.ico
  installerHeader: resources/installer-header.bmp
  installerHeaderIcon: resources/installer-header-icon.ico
  createDesktopShortcut: always
  createStartMenuShortcut: true
  shortcutName: MyApp
  deleteAppDataOnUninstall: false
  runAfterFinish: true

portable:
  artifactName: ${productName}-${version}-portable.exe

# Linux
linux:
  target:
    - target: AppImage
      arch:
        - x64
        - arm64
    - target: deb
      arch:
        - x64
    - target: rpm
      arch:
        - x64
    - target: snap
      arch:
        - x64
  category: Utility
  icon: resources/icons
  synopsis: Short description of the app
  description: |
    Longer description of the app
    that can span multiple lines.
  desktop:
    StartupWMClass: myapp
    MimeType: "text/plain;text/html"

appImage:
  license: LICENSE

deb:
  depends:
    - gconf2
    - gconf-service
    - libnotify4
    - libappindicator1
    - libxtst6
    - libnss3

snap:
  confinement: strict
  grade: stable
  summary: Short description for snap store

# Auto-update
publish:
  provider: github
  owner: my-username
  repo: my-repo
  releaseType: release
  publishAutoUpdate: true
  vPrefixedTagName: true

# Extra resources
extraResources:
  - from: "resources/extra/"
    to: "extra/"
    filter:
      - "**/*"

# Hooks
afterSign: scripts/notarize.js
afterPack: scripts/after-pack.js
```

### 3. Vite + Electron Builder

**Best for**: Modern, fast development experience

**vite.config.ts:**
```typescript
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main process entry
        entry: 'src/main/main.ts',
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        // Preload script
        entry: 'src/preload/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist/preload',
          },
        },
      },
    ]),
    renderer(),
  ],
  build: {
    outDir: 'dist/renderer',
  },
});
```

## Code Signing

### macOS Code Signing

**Requirements:**
- Apple Developer account ($99/year)
- Developer ID Application certificate
- App-specific password for notarization

**entitlements.mac.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.device.audio-input</key>
  <true/>
  <key>com.apple.security.device.camera</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```

**Notarization Script (scripts/notarize.js):**
```javascript
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  return await notarize({
    appBundleId: 'com.company.myapp',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
```

**Environment variables:**
```bash
# .env (never commit!)
APPLE_ID=your-apple-id@email.com
APPLE_ID_PASSWORD=app-specific-password
APPLE_TEAM_ID=YOUR_TEAM_ID
```

### Windows Code Signing

**Requirements:**
- Code signing certificate (.pfx or .p12)
- Certificate password

**Environment variables:**
```bash
WIN_CERT_FILE=path/to/certificate.pfx
WIN_CERT_PASSWORD=your-certificate-password
```

**electron-builder.yml:**
```yaml
win:
  certificateFile: ${WIN_CERT_FILE}
  certificatePassword: ${WIN_CERT_PASSWORD}
  signingHashAlgorithms:
    - sha256
  rfc3161TimeStampServer: http://timestamp.digicert.com
```

### Linux Code Signing

Linux doesn't require code signing, but you can sign packages:

**For snap:**
```bash
snapcraft login
snapcraft upload --release=stable myapp.snap
```

## Auto-Update Configuration

### Using electron-updater

**Install:**
```bash
npm install electron-updater
```

**Main Process (main/updater.ts):**
```typescript
import { autoUpdater } from 'electron-updater';
import { BrowserWindow, app } from 'electron';
import log from 'electron-log';

// Configure logging
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

export function setupAutoUpdater(mainWindow: BrowserWindow) {
  // Don't check for updates in development
  if (!app.isPackaged) {
    return;
  }

  // Configure update server
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'my-username',
    repo: 'my-repo',
    private: false,
  });

  // Check for updates on startup (after a delay)
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 5000);

  // Check for updates every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates();
  }, 4 * 60 * 60 * 1000);

  // Events
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for updates...');
    mainWindow.webContents.send('update:checking');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info);
    mainWindow.webContents.send('update:available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available:', info);
    mainWindow.webContents.send('update:not-available');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    log.info('Download progress:', progressObj);
    mainWindow.webContents.send('update:download-progress', progressObj);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info);
    mainWindow.webContents.send('update:downloaded', info);
  });

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err);
    mainWindow.webContents.send('update:error', err);
  });
}

// IPC handler to trigger update installation
export function setupUpdateHandlers() {
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('update:check', () => {
    autoUpdater.checkForUpdates();
  });
}
```

**Preload Script:**
```typescript
contextBridge.exposeInMainWorld('updater', {
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  onUpdateChecking: (callback: () => void) => {
    ipcRenderer.on('update:checking', callback);
  },

  onUpdateAvailable: (callback: (info: any) => void) => {
    ipcRenderer.on('update:available', (_event, info) => callback(info));
  },

  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on('update:not-available', callback);
  },

  onDownloadProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('update:download-progress', (_event, progress) =>
      callback(progress)
    );
  },

  onUpdateDownloaded: (callback: (info: any) => void) => {
    ipcRenderer.on('update:downloaded', (_event, info) => callback(info));
  },

  onUpdateError: (callback: (error: any) => void) => {
    ipcRenderer.on('update:error', (_event, error) => callback(error));
  },
});
```

**Renderer (UI):**
```typescript
// Listen for update events
window.updater.onUpdateAvailable((info) => {
  showNotification('Update Available', `Version ${info.version} is available`);
});

window.updater.onDownloadProgress((progress) => {
  updateProgressBar(progress.percent);
});

window.updater.onUpdateDownloaded((info) => {
  showInstallDialog(`Version ${info.version} has been downloaded`);
});

// Install update on user action
function installUpdate() {
  window.updater.installUpdate();
}
```

## Package.json Configuration

**Complete package.json:**
```json
{
  "name": "myapp",
  "version": "1.0.0",
  "description": "My awesome Electron app",
  "main": "dist/main/main.js",
  "author": "My Company <contact@mycompany.com>",
  "license": "MIT",
  "homepage": "https://myapp.com",
  "repository": {
    "type": "git",
    "url": "https://github.com/my-username/my-repo.git"
  },
  "keywords": ["electron", "desktop", "app"],
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "electron:dev": "concurrently \"npm run dev\" \"wait-on http://localhost:5173 && electron .\"",
    "electron:build": "npm run build && electron-builder",
    "electron:build:mac": "npm run build && electron-builder --mac",
    "electron:build:win": "npm run build && electron-builder --win",
    "electron:build:linux": "npm run build && electron-builder --linux",
    "electron:build:all": "npm run build && electron-builder -mwl",
    "release": "npm run build && electron-builder --publish always",
    "lint": "eslint src --ext .ts,.tsx",
    "typecheck": "tsc --noEmit",
    "test": "vitest"
  },
  "dependencies": {
    "electron-updater": "^6.1.4",
    "electron-log": "^5.0.0"
  },
  "devDependencies": {
    "@electron/notarize": "^2.1.0",
    "electron": "^28.0.0",
    "electron-builder": "^24.6.4",
    "typescript": "^5.2.2",
    "vite": "^5.0.0",
    "vite-plugin-electron": "^0.28.0",
    "vite-plugin-electron-renderer": "^0.14.5"
  }
}
```

## Multi-Platform Building

### Build on GitHub Actions

**.github/workflows/build.yml:**
```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Install dependencies
        run: npm ci

      - name: Build app (macOS)
        if: matrix.os == 'macos-latest'
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run electron:build:mac

      - name: Build app (Windows)
        if: matrix.os == 'windows-latest'
        env:
          WIN_CERT_FILE: ${{ secrets.WIN_CERT_FILE }}
          WIN_CERT_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run electron:build:win

      - name: Build app (Linux)
        if: matrix.os == 'ubuntu-latest'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run electron:build:linux

      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.os }}-build
          path: dist/*.{dmg,exe,AppImage,deb,rpm}
```

## Icon Requirements

### Platform-Specific Formats

**macOS (.icns):**
- 1024x1024 base image
- Generate with: `iconutil` or `electron-icon-builder`

**Windows (.ico):**
- 256x256 base image
- Multiple sizes: 16, 24, 32, 48, 64, 128, 256

**Linux (.png):**
- Multiple sizes in `icons/` directory
- Common sizes: 16, 32, 48, 64, 128, 256, 512

**Generate icons:**
```bash
npm install --save-dev electron-icon-builder

# Generate all platform icons
npx electron-icon-builder --input=./icon.png --output=./resources
```

## Best Practices

1. ✅ **Use ASAR**: Packages source code, improves load time
2. ✅ **Code Signing**: Required for macOS, recommended for Windows
3. ✅ **Auto-Update**: Keep users on latest version
4. ✅ **Notarization** (macOS): Required for distribution
5. ✅ **Compression**: Reduce package size
6. ✅ **Multi-Arch**: Build for both x64 and ARM (Apple Silicon)
7. ✅ **CI/CD**: Automate builds with GitHub Actions
8. ✅ **Semantic Versioning**: Use semver for version numbers
9. ✅ **Change Log**: Document changes for users
10. ✅ **Test Builds**: Test on all target platforms

## Summary

Choose your build tool:
- **Electron Forge**: Easiest, integrated
- **Electron Builder**: Most configurable
- **Vite + Builder**: Fastest development

Remember:
- Set up code signing early
- Test on all platforms
- Implement auto-updates
- Use CI/CD for releases
- Document your build process
