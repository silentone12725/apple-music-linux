// Translations of Adam's own strings that show up inside Apple's localised page.
//
// The language is the page's <html lang>, which Apple sets from the storefront language. Keys are
// lower-case BCP 47 tags; a tag resolves to the nearest entry (zh-Hant-TW -> zh-hant -> zh), and
// anything unknown falls back to English. Add a string to STRINGS with an entry for every language
// in LANGUAGES: i18n.test.mjs fails when one is missing.
//
// These were written without native-speaker review; correct them in place when a speaker finds one.

// The languages Apple Music is offered in.
export const LANGUAGES = [
    'ar', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'es-mx', 'fi', 'fr', 'fr-ca', 'he', 'hi', 'hr', 'hu',
    'id', 'it', 'ja', 'ko', 'ms', 'nb', 'nl', 'pl', 'pt-br', 'pt-pt', 'ro', 'ru', 'sk', 'sv', 'th', 'tr',
    'uk', 'vi', 'zh-hans', 'zh-hant', 'zh-hk',
];

export const STRINGS = {
    playbackFailed: {
        "ar": "تعذّر تشغيل هذه الأغنية.",
        "ca": "No es pot reproduir aquesta cançó.",
        "cs": "Tuto skladbu nelze přehrát.",
        "da": "Sangen kan ikke afspilles.",
        "de": "Dieser Titel kann nicht wiedergegeben werden.",
        "el": "Δεν είναι δυνατή η αναπαραγωγή αυτού του τραγουδιού.",
        "en": "Unable to play this song.",
        "es": "No se puede reproducir esta canción.",
        "es-mx": "No se puede reproducir esta canción.",
        "fi": "Tätä kappaletta ei voi toistaa.",
        "fr": "Impossible de lire ce morceau.",
        "fr-ca": "Impossible de lire ce morceau.",
        "he": "לא ניתן להשמיע את השיר הזה.",
        "hi": "यह गीत नहीं चल सका।",
        "hr": "Ova se pjesma ne može reproducirati.",
        "hu": "Ez a dal nem játszható le.",
        "id": "Lagu ini tidak dapat diputar.",
        "it": "Impossibile riprodurre questo brano.",
        "ja": "この曲を再生できません。",
        "ko": "이 노래를 재생할 수 없습니다.",
        "ms": "Lagu ini tidak dapat dimainkan.",
        "nb": "Denne sangen kan ikke spilles av.",
        "nl": "Dit nummer kan niet worden afgespeeld.",
        "pl": "Nie można odtworzyć tego utworu.",
        "pt-br": "Não foi possível reproduzir esta música.",
        "pt-pt": "Não foi possível reproduzir esta música.",
        "ro": "Această melodie nu poate fi redată.",
        "ru": "Не удалось воспроизвести эту песню.",
        "sk": "Túto skladbu nie je možné prehrať.",
        "sv": "Det går inte att spela låten.",
        "th": "ไม่สามารถเล่นเพลงนี้ได้",
        "tr": "Bu parça çalınamıyor.",
        "uk": "Не вдалося відтворити цю пісню.",
        "vi": "Không thể phát bài hát này.",
        "zh-hans": "无法播放这首歌曲。",
        "zh-hant": "無法播放這首歌曲。",
        "zh-hk": "無法播放這首歌曲。",
    },
    // The context-menu item that downloads a song (replaces Apple's "Copy Embed Code").
    download: {
        'ar': 'تنزيل', 'ca': 'Descarrega', 'cs': 'Stáhnout', 'da': 'Hent', 'de': 'Herunterladen',
        'el': 'Λήψη', 'en': 'Download', 'es': 'Descargar', 'es-mx': 'Descargar', 'fi': 'Lataa',
        'fr': 'Télécharger', 'fr-ca': 'Télécharger', 'he': 'הורדה', 'hi': 'डाउनलोड करें', 'hr': 'Preuzmi',
        'hu': 'Letöltés', 'id': 'Unduh', 'it': 'Scarica', 'ja': 'ダウンロード', 'ko': '다운로드',
        'ms': 'Muat Turun', 'nb': 'Last ned', 'nl': 'Download', 'pl': 'Pobierz', 'pt-br': 'Baixar',
        'pt-pt': 'Transferir', 'ro': 'Descarcă', 'ru': 'Загрузить', 'sk': 'Stiahnuť', 'sv': 'Hämta',
        'th': 'ดาวน์โหลด', 'tr': 'İndir', 'uk': 'Завантажити', 'vi': 'Tải về', 'zh-hans': '下载',
        'zh-hant': '下載', 'zh-hk': '下載',
    },
};

// Tags that Apple or the browser may report which are not themselves keys above.
const ALIASES = {
    'no': 'nb', 'nn': 'nb', 'iw': 'he', 'in': 'id',
    'zh': 'zh-hans', 'zh-cn': 'zh-hans', 'zh-sg': 'zh-hans', 'zh-tw': 'zh-hant', 'zh-mo': 'zh-hk',
    'pt': 'pt-br',
    // Spanish: Spain is the base language, every other Spanish storefront reads as Latin American.
    'es-es': 'es', 'es-419': 'es-mx', 'es-us': 'es-mx', 'es-ar': 'es-mx', 'es-co': 'es-mx', 'es-cl': 'es-mx',
};

// The key in LANGUAGES that serves `tag`, or 'en'.
export function resolveLanguage(tag) {
    let t = String(tag ?? '').trim().toLowerCase().replace(/_/g, '-');
    while (t) {
        const key = ALIASES[t] ?? t;
        if (LANGUAGES.includes(key)) return key;
        const cut = t.lastIndexOf('-');
        if (cut < 0) break;
        t = t.slice(0, cut);
    }
    return 'en';
}

// `key` in the language of `tag` (default: the page's language).
export function t(key, tag = globalThis.document?.documentElement?.lang) {
    const strings = STRINGS[key];
    if (!strings) return key;
    return strings[resolveLanguage(tag)] ?? strings.en;
}
