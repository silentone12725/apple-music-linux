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
    queueNext: {
            "ar": "التالي",
            "ca": "A continuació",
            "cs": "Následuje",
            "da": "Afspil som næste",
            "de": "Als Nächstes",
            "el": "Επόμενα",
            "en": "Playing Next",
            "es": "A continuación",
            "es-mx": "A continuación",
            "fi": "Seuraavaksi",
            "fr": "Morceaux suivants",
            "fr-ca": "À suivre",
            "he": "הבאים בתור",
            "hi": "आगे चलाएँ",
            "hr": "Sljedeće",
            "hu": "Következők",
            "id": "Berikutnya",
            "it": "In coda",
            "ja": "次に再生",
            "ko": "다음에 재생",
            "ms": "Main Seterusnya",
            "nb": "Neste",
            "nl": "Hierna",
            "pl": "Następne",
            "pt-br": "A Seguir",
            "pt-pt": "A seguir",
            "ro": "În continuare",
            "ru": "На очереди",
            "sk": "Nasledujúce",
            "sv": "Nästa",
            "th": "รายการถัดไป",
            "tr": "Sıradaki",
            "uk": "Далі",
            "vi": "Phát tiếp theo",
            "zh-hans": "待播清单",
            "zh-hant": "待播清單",
            "zh-hk": "待播清單"
    },
    queueHistory: {
            "ar": "السجل",
            "ca": "Historial",
            "cs": "Historie",
            "da": "Historik",
            "de": "Verlauf",
            "el": "Ιστορικό",
            "en": "History",
            "es": "Historial",
            "es-mx": "Historial",
            "fi": "Historia",
            "fr": "Historique",
            "fr-ca": "Historique",
            "he": "היסטוריה",
            "hi": "इतिहास",
            "hr": "Povijest",
            "hu": "Előzmények",
            "id": "Riwayat",
            "it": "Cronologia",
            "ja": "履歴",
            "ko": "기록",
            "ms": "Sejarah",
            "nb": "Logg",
            "nl": "Geschiedenis",
            "pl": "Historia",
            "pt-br": "Histórico",
            "pt-pt": "Histórico",
            "ro": "Istoric",
            "ru": "История",
            "sk": "História",
            "sv": "Historik",
            "th": "ประวัติ",
            "tr": "Geçmiş",
            "uk": "Історія",
            "vi": "Lịch sử",
            "zh-hans": "历史记录",
            "zh-hant": "播放記錄",
            "zh-hk": "播放記錄"
    },
    queueEmpty: {
            "ar": "لا توجد أغانٍ حديثة.",
            "ca": "No hi ha cançons recents.",
            "cs": "Žádné nedávno přehrané skladby.",
            "da": "Ingen nyligt afspillede sange.",
            "de": "Keine kürzlich gespielten Titel.",
            "el": "Δεν υπάρχουν πρόσφατα τραγούδια.",
            "en": "No recently played songs.",
            "es": "No hay canciones recientes.",
            "es-mx": "No hay canciones recientes.",
            "fi": "Ei äskettäin toistettuja kappaleita.",
            "fr": "Aucun morceau récent.",
            "fr-ca": "Aucun morceau récent.",
            "he": "אין שירים שהושמעו לאחרונה.",
            "hi": "हाल में कोई गीत नहीं चला।",
            "hr": "Nema nedavno reproduciranih pjesama.",
            "hu": "Nincsenek nemrég lejátszott dalok.",
            "id": "Belum ada lagu yang diputar.",
            "it": "Nessun brano recente.",
            "ja": "最近再生した曲はありません。",
            "ko": "최근 재생한 노래가 없습니다.",
            "ms": "Tiada lagu dimainkan baru-baru ini.",
            "nb": "Ingen nylig avspilte sanger.",
            "nl": "Geen onlangs afgespeelde nummers.",
            "pl": "Brak ostatnio odtwarzanych utworów.",
            "pt-br": "Nenhuma música reproduzida recentemente.",
            "pt-pt": "Nenhuma música reproduzida recentemente.",
            "ro": "Nicio melodie redată recent.",
            "ru": "Недавно прослушанных песен нет.",
            "sk": "Žiadne nedávno prehrané skladby.",
            "sv": "Inga nyligen spelade låtar.",
            "th": "ไม่มีเพลงที่เล่นล่าสุด",
            "tr": "Yakın zamanda çalınan parça yok.",
            "uk": "Немає нещодавно відтворених пісень.",
            "vi": "Chưa có bài hát được phát gần đây.",
            "zh-hans": "没有最近播放的歌曲。",
            "zh-hant": "沒有最近播放的歌曲。",
            "zh-hk": "沒有最近播放的歌曲。"
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
