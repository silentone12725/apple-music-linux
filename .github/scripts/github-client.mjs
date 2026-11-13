// A small GitHub REST client over the `gh` CLI (authenticated by GH_TOKEN). It never passes untrusted text through a
// shell: every call is an argument vector. Pagination is explicit so that a failed page is reported, never ignored.
import { execFileSync } from 'node:child_process';

export function createClient({ repo, run = execFileSync, env = process.env } = {}) {
    function call(method, path, body) {
        const args = ['api', '-X', method, `repos/${repo}${path}`];
        let input;
        if (body !== undefined) { args.push('--input', '-'); input = JSON.stringify(body); }
        try {
            const out = run('gh', args, { encoding: 'utf8', input, env, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
            return { ok: true, status: 200, data: out ? JSON.parse(out) : null };
        } catch (e) {
            const m = /HTTP (\d{3})/.exec(String(e.stderr ?? e.message));
            return { ok: false, status: m ? Number(m[1]) : 0, error: String(e.stderr ?? e.message).trim().slice(0, 300) };
        }
    }

    // -> { items, complete }. complete is false if any page failed; callers must then abort without mutating.
    function paginate(path) {
        const items = [];
        const sep = path.includes('?') ? '&' : '?';
        for (let page = 1; page <= 1000; page++) {
            const r = call('GET', `${path}${sep}per_page=100&page=${page}`);
            if (!r.ok) return { items, complete: false, error: `${path}: ${r.error || r.status}` };
            const list = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
            items.push(...list);
            if (list.length < 100) return { items, complete: true };
        }
        return { items, complete: false, error: `${path}: more than 1000 pages` };
    }

    return {
        repo,
        get: (path) => call('GET', path),
        paginate,
        post: (path, body) => call('POST', path, body),
        patch: (path, body) => call('PATCH', path, body),
        delete: (path) => call('DELETE', path),
    };
}
