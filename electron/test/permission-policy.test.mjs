import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedApplePermission } from '../permission-policy.mjs';

test('Apple sign-in storage access is allowed only for HTTPS Apple origins', () => {
    for (const permission of ['storage-access', 'top-level-storage-access']) {
        assert.equal(
            isAllowedApplePermission(permission, 'https://music.apple.com/us/browse', 'https://music.apple.com/us/browse'),
            true
        );
        assert.equal(
            isAllowedApplePermission(permission, 'https://idmsa.apple.com/auth', 'https://music.apple.com/us/browse'),
            true
        );
        assert.equal(
            isAllowedApplePermission(permission, 'https://evil.example/frame', 'https://music.apple.com/us/browse'),
            false,
            'a third-party frame must not inherit the top-level page grant'
        );
        assert.equal(
            isAllowedApplePermission(permission, 'http://idmsa.apple.com/auth', 'https://music.apple.com/us/browse'),
            false,
            'requesting origin must use HTTPS'
        );
    }
});

test('all permissions other than the two Apple storage-access permissions are denied', () => {
    for (const permission of [
        'media', 'geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb',
        'bluetooth', 'display-capture', 'clipboard-read', 'idle-detection',
        'fileSystem', 'window-management', 'openExternal', 'speaker-selection',
        'notifications', 'pointerLock', 'fullscreen', 'unknown',
    ]) {
        assert.equal(
            isAllowedApplePermission(permission, 'https://music.apple.com/', 'https://music.apple.com/'),
            false,
            permission
        );
    }
});

test('lookalike hosts and non-HTTPS top-level pages are denied', () => {
    assert.equal(
        isAllowedApplePermission('storage-access', 'https://music.apple.com.attacker.example/', 'https://music.apple.com/'),
        false
    );
    assert.equal(
        isAllowedApplePermission('storage-access', 'https://notapple.com/', 'https://music.apple.com/'),
        false
    );
    assert.equal(
        isAllowedApplePermission('storage-access', 'https://apple.com.evil/', 'https://music.apple.com/'),
        false
    );
    assert.equal(
        isAllowedApplePermission('storage-access', 'https://music.apple.com/', 'http://music.apple.com/'),
        false
    );
    assert.equal(isAllowedApplePermission('storage-access', null, 'https://music.apple.com/'), false);
});
