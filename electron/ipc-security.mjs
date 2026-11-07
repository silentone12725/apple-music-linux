// Apply one sender-validation policy to every renderer-to-main IPC registration.
// In particular, a rejected event must not consume a one-shot listener.
export function installIpcSenderGuards(ipcMain, senderAllowed, logger = console) {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalOn = ipcMain.on.bind(ipcMain);
    const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);

    ipcMain.handle = (channel, listener) => originalHandle(channel, (event, ...args) => {
        if (!senderAllowed(event, channel)) {
            logger.warn(`[Adam] refused IPC invoke ${channel} from ${event.senderFrame?.url || 'unknown'}`);
            throw new Error('forbidden');
        }
        return listener(event, ...args);
    });

    ipcMain.on = (channel, listener) => originalOn(channel, (event, ...args) => {
        if (!senderAllowed(event, channel)) {
            logger.warn(`[Adam] refused IPC message ${channel} from ${event.senderFrame?.url || 'unknown'}`);
            return;
        }
        return listener(event, ...args);
    });

    // EventEmitter.once removes its listener before invoking it. Implement the one-shot
    // wrapper explicitly so an unauthorized frame cannot consume a legitimate event.
    ipcMain.once = (channel, listener) => {
        const guarded = (event, ...args) => {
            if (!senderAllowed(event, channel)) {
                logger.warn(`[Adam] refused IPC message ${channel} from ${event.senderFrame?.url || 'unknown'}`);
                return;
            }
            originalRemoveListener(channel, guarded);
            return listener(event, ...args);
        };
        originalOn(channel, guarded);
        return ipcMain;
    };

    return ipcMain;
}
