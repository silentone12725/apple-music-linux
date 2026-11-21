// Is a release tag trustworthy evidence? Present enforcement plus a human-vetted baseline; a ruleset check alone proves
// nothing about history. Pure: the rulesets and the manifest are read by the caller.
//
//   verified   the manifest lists the tag at the SHA it resolves to now, AND an active tag ruleset with no bypass actors
//              covers it and blocks update, deletion and non-fast-forward.
//   unverified something is missing or differs (no entry, other SHA, no/inactive/partial ruleset, bypass present).
//   unknown    the rulesets could not be read.

const REQUIRED_RULES = ['update', 'deletion', 'non_fast_forward'];

function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; }
        else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}

function covers(ruleset, ref) {
    const cond = ruleset.conditions?.ref_name ?? {};
    const matches = (patterns = []) => patterns.some((p) => p === '~ALL' || globToRegExp(p).test(ref));
    return matches(cond.include) && !matches(cond.exclude);
}

export function tagsImmutable({ tag, resolvedSha, manifest, rulesets }) {
    if (rulesets === null || rulesets === undefined) return 'unknown';
    const pinned = manifest?.tags?.[tag];
    if (!pinned || !resolvedSha || pinned.toLowerCase() !== resolvedSha.toLowerCase()) return 'unverified';
    const ref = `refs/tags/${tag}`;
    const active = rulesets.filter((r) => r.target === 'tag' && r.enforcement === 'active' && covers(r, ref));
    if (active.length === 0) return 'unverified';
    if (active.some((r) => (r.bypass_actors ?? []).length > 0)) return 'unverified';
    const blocked = new Set(active.flatMap((r) => (r.rules ?? []).map((x) => x.type)));
    return REQUIRED_RULES.every((t) => blocked.has(t)) ? 'verified' : 'unverified';
}
