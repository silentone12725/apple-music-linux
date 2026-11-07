import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installIpcSenderGuards } from '../ipc-security.mjs';

class MockIpcMain extends EventEmitter {
    handlers = new Map();

    handle(channel, listener) {
        this.handlers.set(channel, listener);
        return this;
    }

    invoke(channel, event, ...args) {
        return this.handlers.get(channel)(event, ...args);
    }
}

const mainSender = { id: 'main' };
const otherSender = { id: 'other' };
const authorized = { sender: mainSender, senderFrame: { url: 'https://music.apple.com/us' } };
const unauthorized = { sender: otherSender, senderFrame: { url: 'https://evil.example/' } };

function setup() {
    const ipcMain = new MockIpcMain();
    const warnings = [];
    installIpcSenderGuards(
        ipcMain,
        (event) => event.sender === mainSender,
        { warn: (message) => warnings.push(message) }
    );
    return { ipcMain, warnings };
}

test('guarded on listeners ignore events from unauthorized renderers', () => {
    const { ipcMain, warnings } = setup();
    let calls = 0;
    ipcMain.on('sample', () => calls++);

    ipcMain.emit('sample', unauthorized);
    assert.equal(calls, 0);
    assert.equal(warnings.length, 1);

    ipcMain.emit('sample', authorized);
    assert.equal(calls, 1);
});

test('guarded invoke handlers reject unauthorized senders', async () => {
    const { ipcMain } = setup();
    ipcMain.handle('sample', (_event, value) => value * 2);

    assert.throws(() => ipcMain.invoke('sample', unauthorized, 3), /forbidden/);
    assert.equal(await ipcMain.invoke('sample', authorized, 3), 6);
});

test('unauthorized senders cannot consume guarded one-shot listeners', () => {
    const { ipcMain } = setup();
    let calls = 0;
    ipcMain.once('ready', () => calls++);

    ipcMain.emit('ready', unauthorized);
    assert.equal(calls, 0);
    assert.equal(ipcMain.listenerCount('ready'), 1);

    ipcMain.emit('ready', authorized);
    assert.equal(calls, 1);
    assert.equal(ipcMain.listenerCount('ready'), 0);

    ipcMain.emit('ready', authorized);
    assert.equal(calls, 1);
});
