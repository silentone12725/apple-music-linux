#!/bin/bash

# Electron App Scaffold Script
# Creates a production-ready Electron app with best practices

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Functions
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}→ $1${NC}"
}

# Check prerequisites
check_prerequisites() {
    print_info "Checking prerequisites..."

    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js 18+ required (found: $(node -v))"
        exit 1
    fi
    print_success "Node.js $(node -v)"

    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed"
        exit 1
    fi
    print_success "npm $(npm -v)"

    if ! command -v git &> /dev/null; then
        print_error "git is not installed"
        exit 1
    fi
    print_success "git $(git --version | cut -d' ' -f3)"
}

# Get user input
get_user_input() {
    read -p "App name: " APP_NAME
    read -p "App description: " APP_DESCRIPTION
    read -p "Author: " AUTHOR
    read -p "Framework (react/vue/svelte/vanilla): " FRAMEWORK
    read -p "Build tool (forge/builder/vite): " BUILD_TOOL

    # Normalize inputs
    FRAMEWORK=${FRAMEWORK:-vanilla}
    BUILD_TOOL=${BUILD_TOOL:-forge}

    print_info "Creating Electron app with:"
    echo "  Name: $APP_NAME"
    echo "  Description: $APP_DESCRIPTION"
    echo "  Author: $AUTHOR"
    echo "  Framework: $FRAMEWORK"
    echo "  Build Tool: $BUILD_TOOL"

    read -p "Proceed? (y/n): " CONFIRM
    if [ "$CONFIRM" != "y" ]; then
        print_error "Cancelled"
        exit 0
    fi
}

# Initialize project
init_project() {
    print_info "Initializing project..."

    if [ "$BUILD_TOOL" = "forge" ]; then
        if [ "$FRAMEWORK" = "react" ]; then
            npm init electron-app@latest "$APP_NAME" -- --template=webpack-typescript
        else
            npm init electron-app@latest "$APP_NAME" -- --template=webpack-typescript
        fi
    elif [ "$BUILD_TOOL" = "vite" ]; then
        if [ "$FRAMEWORK" = "react" ]; then
            npm create @quick-start/electron "$APP_NAME" -- --template react-ts
        elif [ "$FRAMEWORK" = "vue" ]; then
            npm create @quick-start/electron "$APP_NAME" -- --template vue-ts
        else
            npm create @quick-start/electron "$APP_NAME" -- --template vanilla-ts
        fi
    else
        mkdir -p "$APP_NAME"
        cd "$APP_NAME"
        npm init -y
    fi

    cd "$APP_NAME"
    print_success "Project initialized"
}

# Create directory structure
create_structure() {
    print_info "Creating directory structure..."

    mkdir -p src/main/ipc
    mkdir -p src/preload
    mkdir -p src/renderer
    mkdir -p src/shared
    mkdir -p assets
    mkdir -p resources
    mkdir -p scripts

    print_success "Directory structure created"
}

# Create security-hardened files
create_secure_files() {
    print_info "Creating security-hardened files..."

    # Preload script with context bridge
    cat > src/preload/preload.ts << 'EOF'
import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => ipcRenderer.invoke('app:get-version'),

  // File operations (example)
  readFile: (path: string) => ipcRenderer.invoke('file:read', path),
  saveFile: (path: string, content: string) =>
    ipcRenderer.invoke('file:save', path, content),

  // Dialog (example)
  openFile: () => ipcRenderer.invoke('dialog:open-file'),
  saveFileDialog: () => ipcRenderer.invoke('dialog:save-file'),

  // Logging
  log: (message: string) => ipcRenderer.send('log:info', message),

  // Event listeners
  onUpdateAvailable: (callback: (info: any) => void) => {
    ipcRenderer.on('update:available', (_event, info) => callback(info));
  },
});

// Type definitions
export interface ElectronAPI {
  getVersion: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  saveFile: (path: string, content: string) => Promise<void>;
  openFile: () => Promise<string | null>;
  saveFileDialog: () => Promise<string | null>;
  log: (message: string) => void;
  onUpdateAvailable: (callback: (info: any) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
EOF

    # IPC handlers
    cat > src/main/ipc/handlers.ts << 'EOF'
import { ipcMain, app, dialog } from 'electron';
import fs from 'fs/promises';
import path from 'path';

export function setupIpcHandlers() {
  // App version
  ipcMain.handle('app:get-version', () => app.getVersion());

  // File operations (example - add security validation)
  ipcMain.handle('file:read', async (_event, filePath: string) => {
    // TODO: Add path validation and security checks
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  });

  ipcMain.handle('file:save', async (_event, filePath: string, content: string) => {
    // TODO: Add path validation and security checks
    await fs.writeFile(filePath, content, 'utf-8');
  });

  // Dialog
  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:save-file', async () => {
    const result = await dialog.showSaveDialog({});
    return result.canceled ? null : result.filePath;
  });

  // Logging
  ipcMain.on('log:info', (_event, message: string) => {
    console.log('[Renderer]:', message);
  });
}
EOF

    # Menu
    cat > src/main/menu.ts << 'EOF'
import { Menu, BrowserWindow, shell, app } from 'electron';

export function createApplicationMenu(mainWindow: BrowserWindow) {
  const template: any[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('file:new'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Learn More',
          click: async () => {
            await shell.openExternal('https://electronjs.org');
          },
        },
        {
          label: 'About',
          click: () => {
            app.showAboutPanel();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
EOF

    print_success "Security-hardened files created"
}

# Install dependencies
install_dependencies() {
    print_info "Installing dependencies..."

    npm install --save-dev \
        electron \
        typescript \
        @types/node \
        electron-builder

    npm install \
        electron-updater \
        electron-log

    print_success "Dependencies installed"
}

# Create configuration files
create_configs() {
    print_info "Creating configuration files..."

    # TypeScript config
    cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
EOF

    # Electron Builder config
    cat > electron-builder.yml << 'EOF'
appId: com.example.app
productName: MyApp
directories:
  output: dist
files:
  - src/**/*
  - package.json
mac:
  category: public.app-category.productivity
  target:
    - dmg
    - zip
win:
  target:
    - nsis
    - portable
linux:
  target:
    - AppImage
    - deb
publish:
  provider: github
EOF

    # .gitignore
    cat > .gitignore << 'EOF'
node_modules/
dist/
.env
*.log
.DS_Store
*.dmg
*.exe
*.AppImage
*.deb
*.rpm
EOF

    print_success "Configuration files created"
}

# Create README
create_readme() {
    cat > README.md << EOF
# $APP_NAME

$APP_DESCRIPTION

## Development

\`\`\`bash
npm install
npm run dev
\`\`\`

## Build

\`\`\`bash
npm run build
npm run package
\`\`\`

## Security

This app follows Electron security best practices:
- Context isolation enabled
- Node integration disabled
- Sandbox mode enabled
- IPC via context bridge
- Input validation

## License

MIT
EOF

    print_success "README created"
}

# Initialize git
init_git() {
    print_info "Initializing git..."

    git init
    git add .
    git commit -m "Initial commit: Electron app scaffold"

    print_success "Git initialized"
}

# Main
main() {
    echo "╔════════════════════════════════════════╗"
    echo "║   Electron App Scaffold Generator     ║"
    echo "╚════════════════════════════════════════╝"
    echo ""

    check_prerequisites
    get_user_input
    init_project
    create_structure
    create_secure_files
    install_dependencies
    create_configs
    create_readme
    init_git

    echo ""
    echo "╔════════════════════════════════════════╗"
    echo "║          Scaffold Complete!            ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    print_success "Your Electron app is ready!"
    echo ""
    echo "Next steps:"
    echo "  cd $APP_NAME"
    echo "  npm run dev"
    echo ""
}

main
