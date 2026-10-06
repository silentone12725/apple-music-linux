// One owner for native pause/resume intent. Commands for an old track never
// reach its replacement, and HTTP responses cannot reorder rapid user input.
export function createTransportController({ scope, send }) {
    let tail = Promise.resolve(), desired = null, revision = 0, pending = 0, epoch = 0;
    return {
        get desired() { return desired; },
        get revision() { return revision; },
        get pending() { return pending > 0; },
        reset(paused = null) { desired = paused; revision++; epoch++; },
        request(paused) {
            if (desired === paused) return tail;
            desired = paused;
            revision++;
            const owner = scope(), issuedEpoch = epoch;
            pending++;
            const result = tail.catch(() => {}).then(async () => {
                if (owner !== scope() || issuedEpoch !== epoch) return;
                await send(paused);
            }).finally(() => { pending--; });
            tail = result;
            return result;
        },
    };
}

// Keep every navigation request, including a previous click received while next
// is awaiting MusicKit. Rejected operations must not poison subsequent input.
export function createNavigationQueue(run) {
    let tail = Promise.resolve(), cursor = null, count = 0;
    return {
        get cursor() { return cursor; },
        goto(ci, ii) {
            cursor = { ci, ii };
            count++;
            const result = tail.catch(() => {}).then(() => run(ci, ii));
            tail = result.finally(() => { if (--count === 0) cursor = null; });
            return tail;
        },
    };
}

export async function withNavigationDeadline(operation, ms = 6000) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('MusicKit navigation timed out')), ms);
        })]);
    } finally { clearTimeout(timer); }
}
