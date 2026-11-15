// A stateful in-memory stand-in for the GitHub REST surface the reconciler uses, plus a scripted git.
export const BOT = { login: 'github-actions[bot]', type: 'Bot', id: 41898282 };
export const HUMAN = { login: 'maint', type: 'User', id: 7 };
export const REPORTER = { login: 'reporter', type: 'User', id: 9 };

export const DIAG = [
    'Adam diagnostics v1', 'formatVersion: 1', 'version: 1.6.0', 'channel: nightly', 'os: Fedora 42', 'arch: x86_64', 'install: AppImage',
].join('\n');

export const formBody = (diag = DIAG) => `### What happened\n\nIt broke\n\n### Component\n\nLossless (ALAC)\n\n### Platform\n\nLinux\n\n### Diagnostics summary\n\n${diag || '_No response_'}\n`;

export function fakeGitHub(init = {}) {
    const s = {
        issues: [], pulls: [], releases: [], rulesets: [], comments: {}, timelines: {}, settings: {}, fail: new Set(), calls: [], ...init,
    };
    const find = (n) => s.issues.find((i) => i.number === n);
    const names = (i) => i.labels.map((l) => l.name);
    const rec = (m, p, b) => s.calls.push({ m, p, b });
    const mutating = () => s.calls.filter((c) => c.m !== 'GET');
    const failing = (p) => [...s.fail].some((f) => p.startsWith(f));

    const client = {
        repo: 'o/r',
        get(path) {
            rec('GET', path);
            if (failing(path)) return { ok: false, status: 403, error: 'HTTP 403' };
            if (path === '') return { ok: true, data: s.settings };
            const m = /^\/rulesets\/(\d+)$/.exec(path);
            if (m) return { ok: true, data: s.rulesets.find((r) => r.id === Number(m[1])) };
            return { ok: false, status: 404, error: 'HTTP 404' };
        },
        paginate(path) {
            rec('GET', path);
            if (failing(path)) return { items: [], complete: false, error: `${path}: HTTP 403` };
            if (path.startsWith('/issues?')) return { items: s.issues, complete: true };
            if (path.startsWith('/pulls?')) return { items: s.pulls, complete: true };
            if (path === '/releases') return { items: s.releases, complete: true };
            if (path === '/rulesets') return { items: s.rulesets.map((r) => ({ id: r.id })), complete: true };
            let m = /^\/issues\/(\d+)\/timeline$/.exec(path);
            if (m) return { items: s.timelines[m[1]] ?? [], complete: true };
            m = /^\/issues\/(\d+)\/comments$/.exec(path);
            if (m) return { items: s.comments[m[1]] ?? [], complete: true };
            return { items: [], complete: false, error: `${path}: unrouted` };
        },
        post(path, body) {
            rec('POST', path, body);
            let m = /^\/issues\/(\d+)\/labels$/.exec(path);
            if (m) { const i = find(Number(m[1])); for (const l of body.labels) if (!names(i).includes(l)) i.labels.push({ name: l }); return { ok: true }; }
            m = /^\/issues\/(\d+)\/comments$/.exec(path);
            if (m) { (s.comments[m[1]] ??= []).push({ id: Math.floor(Math.random() * 1e9), body: body.body, user: BOT }); return { ok: true }; }
            return { ok: false, status: 404 };
        },
        patch(path, body) {
            rec('PATCH', path, body);
            let m = /^\/issues\/comments\/(\d+)$/.exec(path);
            if (m) { for (const list of Object.values(s.comments)) { const c = list.find((x) => x.id === Number(m[1])); if (c) c.body = body.body; } return { ok: true }; }
            m = /^\/issues\/(\d+)$/.exec(path);
            if (m) {
                if (failing('PATCH ' + path)) return { ok: false, status: 500, error: 'HTTP 500' };
                const i = find(Number(m[1])); i.state = body.state;
                (s.timelines[m[1]] ??= []).push({ event: body.state === 'closed' ? 'closed' : 'reopened', actor: BOT });
                return { ok: true };
            }
            return { ok: false, status: 404 };
        },
        delete(path) {
            rec('DELETE', path);
            const m = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(path);
            if (m) { const i = find(Number(m[1])); const n = decodeURIComponent(m[2]); i.labels = i.labels.filter((l) => l.name !== n); return { ok: true }; }
            return { ok: false, status: 404 };
        },
    };
    return { s, client, mutating, find, names };
}

export const SHA = { main: 'm'.repeat(40), nightly: 'n'.repeat(40), release: 'r'.repeat(40), fix: 'f'.repeat(40) };

// Scripted git: history is main (release) <= main <= nightly, the fix is in nightly and in the release unless told otherwise.
export function fakeGit({ fixInRelease = true, reverted = 'no', shallow = false } = {}) {
    const known = { 'origin/main': SHA.main, 'origin/nightly': SHA.nightly, 'refs/tags/v1.6.0': SHA.release };
    return {
        shallow: () => shallow,
        resolve: (n) => known[n] ?? null,
        ancestor: (a, b) => {
            if (a === b) return 'yes';
            const order = [SHA.release, SHA.main, SHA.nightly];
            return order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) < order.indexOf(b) ? 'yes' : 'no';
        },
        inclusion: (sha, cand) => ({ included: cand === SHA.release && !fixInRelease ? 'no' : 'yes', via: 'original', fixCommits: [sha] }),
        revertState: () => reverted,
    };
}

export const release = (over = {}) => ({ tag_name: 'v1.6.0', draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z', ...over });
export const tagRuleset = (over = {}) => ({
    id: 1, target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'update' }, { type: 'deletion' }, { type: 'non_fast_forward' }], ...over,
});
export const manifest = { tags: { 'v1.6.0': SHA.release } };
export const mkIssue = (over = {}) => ({ number: 50, state: 'open', labels: [], user: REPORTER, body: formBody(), ...over });
export const mkPull = (over = {}) => ({ number: 1, state: 'closed', merged_at: '2026-10-30T00:00:00Z', merge_commit_sha: SHA.fix, base: { ref: 'nightly' }, body: 'Fixes #50', ...over });
