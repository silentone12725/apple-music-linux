// `adam --purge-data`: delete everything Adam keeps for this user (settings, the DRM session and its token, the web
// sign-in, caches), after switching off launch at login and the link types it claimed. It is how a package (MSIX) is
// cleaned up, since a package runs no code when it is removed, and it works on any install. The installers do the same
// on a user uninstall (scripts/installer-header.sh, nsis/installer.nsh).
import path from 'path';
import os from 'os';
import { rmSync, existsSync } from 'fs';

// Only Adam's own folders, by name: never a parent directory, and never another project's (musickit-sdk-linux …).
export function purgeTargets({ plat = process.platform, env = process.env, home = os.homedir() } = {}) {
    const cfg = plat === 'win32' ? env.APPDATA : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
    const cache = plat === 'win32' ? env.LOCALAPPDATA : (env.XDG_CACHE_HOME || path.join(home, '.cache'));
    const names = (root, list) => (root ? list.map((n) => path.join(root, n)) : []);
    return [...names(cfg, ['adam', 'apple-music-linux', 'aml']), ...names(cache, ['adam'])];
}

export function purgeUserData(targets, remove = (p) => rmSync(p, { recursive: true, force: true })) {
    const removed = [];
    for (const t of targets) {
        if (!existsSync(t)) continue;
        remove(t);
        removed.push(t);
    }
    return removed;
}
