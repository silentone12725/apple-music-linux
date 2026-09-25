'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Narrow IPC bridge for the mini-player window.
// Only these four channels are exposed — nothing else is accessible.
contextBridge.exposeInMainWorld('bridge', {
    onUpdate: (cb) => ipcRenderer.on('miniplayer:state', (_, d) => cb(d)),
    cmd:      (p)  => ipcRenderer.send('miniplayer:cmd', p),
    expand:   ()   => ipcRenderer.send('miniplayer:expand'),
    close:    ()   => ipcRenderer.send('miniplayer:toggle'),
});
