// Reads a GitHub issue-form body and maps the answers to scope labels. Pure: no I/O.
// An issue form renders as "### <field label>\n\n<answer>" sections; the headings are the field labels in
// .github/ISSUE_TEMPLATE/bug_report.yml, and a test keeps the two in step.

export const HEADINGS = {
    'What happened': 'summary',
    'Steps to reproduce': 'steps',
    'Expected behavior': 'expected',
    'Actual behavior': 'actual',
    'Component': 'component',
    'Platform': 'platform',
    'Install method': 'install',
    'Adam version': 'version',
    'Diagnostics summary': 'diagnostics',
    'Diagnostics availability': 'waiverBox',
    'Before you submit': 'confirmations',
};

const NO_RESPONSE = '_No response_';

export function parseIssueForm(body) {
    const text = String(body ?? '').replace(/\r\n?/g, '\n');
    const sections = {};
    const parts = text.split(/^###[ \t]+(.+?)[ \t]*$/m);
    for (let i = 1; i < parts.length; i += 2) {
        const key = HEADINGS[parts[i].trim()];
        if (!key) continue;
        const value = parts[i + 1].trim();
        sections[key] = value === NO_RESPONSE ? '' : value;
    }
    return {
        ...sections,
        waiver: /^- \[[xX]\] I could not collect diagnostics/m.test(sections.waiverBox ?? ''),
    };
}

// -> { labels: ['comp:lossless', 'os:linux'], unknown: [...] }
export function scopeLabels(fields, map) {
    const labels = [];
    const unknown = [];
    for (const field of ['component', 'platform']) {
        const answer = fields[field];
        if (!answer) continue;
        if (Object.hasOwn(map[field], answer)) {
            if (map[field][answer]) labels.push(map[field][answer]);
        } else {
            unknown.push(`${field}: ${answer}`);
        }
    }
    return { labels, unknown };
}
