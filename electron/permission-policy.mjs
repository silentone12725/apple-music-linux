// Explicit permission policy for the remote Apple Music renderer.
// Keep this list deliberately small: adding a permission changes the capabilities
// available to content loaded from a third-party-controlled web origin.

const STORAGE_ACCESS_PERMISSIONS = new Set([
    'storage-access',
    'top-level-storage-access',
    'fullscreen',
]);

function isSecureAppleUrl(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' &&
            (url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com'));
    } catch {
        return false;
    }
}

/**
 * Return whether an Electron permission request is explicitly supported.
 *
 * Both the requesting frame and the top-level page must be HTTPS Apple origins. Fullscreen
 * is retained for Apple pages so video/fullscreen behavior does not regress; it is not
 * granted to embedded third-party frames.
 * Checking both prevents an embedded third-party frame from inheriting the
 * top-level page's permission grant.
 */
export function isAllowedApplePermission(permission, requestingUrl, topLevelUrl) {
    return STORAGE_ACCESS_PERMISSIONS.has(permission) &&
        isSecureAppleUrl(requestingUrl) &&
        isSecureAppleUrl(topLevelUrl);
}
