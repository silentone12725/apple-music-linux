// Finds the issues a pull request body links to. Pure: no I/O.
//
// Fix keywords (read from PR bodies only): close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved.
// Reference keywords (never change state): ref, refs, see, "related to". Matching is case-insensitive with an
// optional colon, as GitHub's own closing keywords. A number must follow the keyword; numbers elsewhere are never linked.

const FIX_WORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
const REF_WORDS = ['ref', 'refs', 'see', 'related to'];

// Removes everything that is not prose: fenced code, inline code, quoted lines and HTML comments.
export function stripNonProse(body) {
    let s = String(body ?? '').replace(/\r\n?/g, '\n');
    s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
    s = s.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[`~]*[ \t]*(?:\n|$)|$)/gm, '\n');
    s = s.replace(/^[ \t]*>.*$/gm, ' ');
    s = s.replace(/`[^`\n]*`/g, ' ');
    return s;
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const kw = (words) => words.map(escapeRe).join('|');

// One reference: #123 or owner/repo#123.
const REF = String.raw`(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+`;
const LIST = String.raw`${REF}(?:\s*(?:,|and|&)\s*${REF})*`;

function collect(text, words, repo, kind, found) {
    const re = new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${kw(words)}):?[ \t]+(${LIST})(?![A-Za-z0-9_])`, 'gi');
    for (const m of text.matchAll(re)) {
        for (const r of m[1].matchAll(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g)) {
            if (r[1] && r[1].toLowerCase() !== String(repo).toLowerCase()) continue; // another repository
            const n = Number(r[2]);
            if (n > 0 && found.get(n) !== 'fix') found.set(n, kind);
        }
    }
}

// -> [{ number, kind: 'fix' | 'ref' }] sorted by number. A fix link wins over a reference to the same number.
export function parseReferences(body, repo) {
    const text = stripNonProse(body);
    const found = new Map();
    collect(text, REF_WORDS, repo, 'ref', found);
    collect(text, FIX_WORDS, repo, 'fix', found);
    return [...found].map(([number, kind]) => ({ number, kind })).sort((a, b) => a.number - b.number);
}

// Revert references: "Reverts #N" in a PR body, N always a PR number (never an issue).
export function parseRevertedPrs(body, repo) {
    const text = stripNonProse(body);
    const out = new Set();
    const re = new RegExp(String.raw`(?<![A-Za-z0-9_])reverts?:?[ \t]+(${LIST})(?![A-Za-z0-9_])`, 'gi');
    for (const m of text.matchAll(re)) {
        for (const r of m[1].matchAll(/(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g)) {
            if (r[1] && r[1].toLowerCase() !== String(repo).toLowerCase()) continue;
            out.add(Number(r[2]));
        }
    }
    return [...out].sort((a, b) => a - b);
}

// Revert references in a commit message: "This reverts commit <sha>".
export function parseRevertedCommits(message) {
    return [...String(message ?? '').matchAll(/This reverts commit ([0-9a-f]{7,40})/gi)].map((m) => m[1].toLowerCase());
}

export const NATIVE_CLOSING_WORDS = FIX_WORDS;
