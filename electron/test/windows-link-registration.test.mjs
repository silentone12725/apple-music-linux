import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPLE_SCHEMES } from '../deeplink.mjs';

const nsh = readFileSync(new URL('../nsis/installer.nsh', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the NSIS include is wired into the installer', () => {
    assert.equal(pkg.build.nsis.include, 'nsis/installer.nsh');
});

test('every scheme Adam handles is listed as a Windows link type', () => {
    const listed = [...nsh.matchAll(/URLAssociations" "([^"]+)" "AdamURL"/g)].map(m => m[1]).sort();
    const want = ['adam', ...APPLE_SCHEMES.map(s => s.scheme)].sort();
    assert.deepEqual(listed, want);
});

test('the installer registers and removes the application capabilities', () => {
    assert.match(nsh, /RegisteredApplications" "Adam" "Software\\Adam\\Capabilities"/);
    assert.match(nsh, /DeleteRegValue SHCTX "Software\\RegisteredApplications" "Adam"/);
    assert.match(nsh, /DeleteRegKey SHCTX "Software\\Adam"/);
});
