// Git facts for the tracker: ancestry, equivalence and revert verification. Everything is tri-state ("yes" | "no" |
// "unknown") and conservative: when history is incomplete or a comparison cannot be trusted the answer is "unknown",
// never "no". Revert edges are verified at the object level (mode + blob identity per path), never by comparing patch
// text, so binary files, modes, symlinks and whitespace-sensitive changes are all well defined.
import { execFileSync } from 'node:child_process';
import { parseRevertedCommits } from './parse-refs.mjs';

const YES = 'yes', NO = 'no', UNK = 'unknown';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FULL = /^[0-9a-f]{40}$/;

export function createGit(cwd) {
    const run = (args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    const out = (...args) => run(args).replace(/\n$/, '');
    const status = (...args) => {
        try { run(args); return 0; } catch (e) { return typeof e.status === 'number' ? e.status : 128; }
    };

    const shallow = () => out('rev-parse', '--is-shallow-repository') === 'true';
    const resolve = (name) => {
        try { return out('rev-parse', '--verify', '--quiet', `${name}^{commit}`); } catch { return null; }
    };
    const has = (sha) => FULL.test(sha) && status('cat-file', '-e', `${sha}^{commit}`) === 0;
    const firstParent = (sha) => resolve(`${sha}^1`) ?? EMPTY_TREE;

    // Is `a` an ancestor of `b`? A "no" is only trusted on a complete (non-shallow) history.
    function ancestor(a, b) {
        if (!has(a) || !has(b)) return UNK;
        const code = status('merge-base', '--is-ancestor', a, b);
        if (code === 0) return YES;
        if (code === 1) return shallow() ? UNK : NO;
        return UNK;
    }

    // The tree entry of `path` in a commit or tree-ish: "<mode> <object>" or "absent".
    function entry(treeish, path) {
        const o = run(['ls-tree', '-z', treeish, '--', path]);
        if (!o) return 'absent';
        const [meta] = o.split('\t');
        const [mode, , obj] = meta.split(' ');
        return `${mode} ${obj}`;
    }

    // Paths a commit changes relative to its first parent (a rename is a delete plus an add).
    function changedPaths(sha) {
        const o = run(['diff-tree', '-r', '--no-renames', '--name-only', '-z', firstParent(sha), sha]);
        return o.split('\0').filter(Boolean).sort();
    }

    // R verifies as the exact inverse of X iff R changes exactly the paths X changed and, for each, R's parent holds X's
    // entry and R holds X's pre-image. Blob identity is byte-exact, so no whitespace handling is needed.
    function verifyInverse(r, x) {
        if (!has(r) || !has(x)) return false;
        const rParent = resolve(`${r}^1`);
        if (!rParent) return false;
        const p = changedPaths(x);
        const q = changedPaths(r);
        if (p.length === 0 || p.length !== q.length || p.some((v, i) => v !== q[i])) return false;
        const xParent = firstParent(x);
        return p.every((path) => entry(rParent, path) === entry(x, path) && entry(r, path) === entry(xParent, path));
    }

    const message = (sha) => run(['log', '-1', '--format=%B', sha]);
    const rangeOrdered = (from, to) => out('rev-list', '--topo-order', '--reverse', `${from}..${to}`).split('\n').filter(Boolean);

    // Does `candidate` contain the fix, either as the original commit or as a `git cherry-pick -x` replacement?
    // mainlineConsistent: the caller knows SHAs are preserved on this line of history (main is an ancestor of nightly), so
    // a complete history that lacks the commit means "absent" rather than "unknown".
    function inclusion(fixSha, candidate, { mainlineConsistent = false } = {}) {
        if (!has(fixSha) || !has(candidate)) return { included: UNK, via: null, fixCommits: [] };
        if (ancestor(fixSha, candidate) === YES) return { included: YES, via: 'original', fixCommits: [fixSha] };
        const found = out('log', '--format=%H', '--fixed-strings', `--grep=(cherry picked from commit ${fixSha})`, candidate)
            .split('\n').filter(Boolean);
        if (found.length) return { included: YES, via: 'equivalent', fixCommits: found };
        if (shallow()) return { included: UNK, via: null, fixCommits: [] };
        return { included: mainlineConsistent ? NO : UNK, via: null, fixCommits: [] };
    }

    // Is the fix unit (commits first..last, usually one merge or squash commit) reverted at `candidate`?
    //   prReverts: [{ from: <merge sha of a PR whose body says "Reverts #N">, to: <merge sha of PR N> }]
    // Candidate edges come from "This reverts commit X" messages and prReverts; each must pass verifyInverse to count.
    function revertState(unit, candidate, { prReverts = [] } = {}) {
        if (!unit.length || !unit.every(has) || !has(candidate)) return UNK;
        if (shallow()) return UNK;
        const first = unit[0], last = unit[unit.length - 1];
        const inRange = new Set();
        for (const u of unit) for (const c of rangeOrdered(u, candidate)) inRange.add(c);
        const order = out('rev-list', '--topo-order', '--reverse', candidate).split('\n').filter((c) => inRange.has(c));

        const edges = [];
        for (const c of order) {
            for (const abbr of parseRevertedCommits(message(c))) {
                const to = resolve(abbr);
                if (to) edges.push({ from: c, to });
            }
        }
        for (const e of prReverts) if (inRange.has(e.from) && has(e.to)) edges.push({ from: e.from, to: e.to });

        // Edges that matter: those reachable backwards from the fix unit (reverts, reverts of reverts, ...).
        const relevantTargets = new Set(unit);
        const relevant = [];
        for (let grew = true; grew;) {
            grew = false;
            for (const e of edges) {
                if (relevantTargets.has(e.to) && !relevant.includes(e)) {
                    relevant.push(e);
                    if (!relevantTargets.has(e.from)) { relevantTargets.add(e.from); grew = true; }
                }
            }
        }
        if (relevant.length === 0) return NO;

        const verified = new Map(relevant.map((e) => [e, verifyInverse(e.from, e.to)]));
        if ([...verified.values()].some((v) => !v)) return UNK; // an unverified edge never cancels and never restores

        // Newest first: a revert is effective unless a later effective revert targets it.
        const sources = [...new Set(relevant.map((e) => e.from))].sort((a, b) => order.indexOf(b) - order.indexOf(a));
        const effective = new Map();
        for (const r of sources) {
            effective.set(r, !relevant.some((e) => e.to === r && effective.get(e.from) === true));
        }
        const cancelled = (c) => relevant.some((e) => e.to === c && effective.get(e.from) === true);
        const states = unit.map(cancelled);
        let chain;
        if (states.every(Boolean)) chain = YES;
        else if (states.some(Boolean)) return UNK; // only part of a multi-commit unit is cancelled
        else chain = NO;

        // Content cross-check at the candidate (object-level), required whenever a chain exists.
        const pre = firstParent(first);
        const paths = [...new Set(unit.flatMap(changedPaths))].sort();
        if (paths.length === 0) return UNK;
        const present = paths.every((p) => entry(candidate, p) === entry(last, p));
        const restored = paths.every((p) => entry(candidate, p) === entry(pre, p));
        if (chain === NO) return present ? NO : restored ? YES : UNK;
        return restored ? YES : UNK;
    }

    return { shallow, resolve, has, ancestor, entry, changedPaths, verifyInverse, inclusion, revertState, firstParent };
}
