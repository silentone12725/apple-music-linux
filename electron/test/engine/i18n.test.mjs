import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, STRINGS, resolveLanguage, t } from '../../src/engine/i18n.js';

test('every string has a non-empty translation for every Apple Music language, and no strays', () => {
    for (const [key, strings] of Object.entries(STRINGS)) {
        for (const lang of LANGUAGES) assert.ok(strings[lang]?.trim(), `${key}: missing ${lang}`);
        assert.deepEqual(Object.keys(strings).sort(), [...LANGUAGES].sort(), `${key}: language keys differ from LANGUAGES`);
    }
});

test('translations are plain text a stylesheet string can carry', () => {
    for (const strings of Object.values(STRINGS)) {
        for (const text of Object.values(strings)) assert.doesNotMatch(text, /[\n\r<>]/);
    }
});

test('Apple and browser language tags resolve to the nearest language', () => {
    const cases = {
        'en-US': 'en', 'en': 'en', 'it': 'it', 'IT': 'it', 'fr-CA': 'fr-ca', 'fr-FR': 'fr', 'fr-BE': 'fr',
        'zh-Hant-TW': 'zh-hant', 'zh-Hans-CN': 'zh-hans', 'zh-TW': 'zh-hant', 'zh-CN': 'zh-hans',
        'zh-HK': 'zh-hk', 'zh': 'zh-hans', 'pt-BR': 'pt-br', 'pt-PT': 'pt-pt', 'pt': 'pt-br',
        'es-MX': 'es-mx', 'es-ES': 'es', 'es-419': 'es-mx', 'es-AR': 'es-mx', 'no': 'nb', 'nb-NO': 'nb',
        'iw': 'he', 'he-IL': 'he', 'id_ID': 'id', 'ar-SA': 'ar', 'sr': 'en', '': 'en', undefined: 'en',
    };
    for (const [tag, want] of Object.entries(cases)) assert.equal(resolveLanguage(tag === 'undefined' ? undefined : tag), want, tag);
});

test('t() picks the language of the tag and falls back to English', () => {
    assert.equal(t('download', 'it'), 'Scarica');
    assert.equal(t('download', 'zh-Hant-TW'), '下載');
    assert.equal(t('download', 'en-GB'), 'Download');
    assert.equal(t('download', 'xx'), 'Download');
    assert.equal(t('no-such-key', 'it'), 'no-such-key');
});
