/**
 * engine-sse.js — Persistent SSE connection to the engine API server.
 *
 * Uses fetch + ReadableStream instead of EventSource so we can:
 *   • Parse the full SSE wire format: id/event/data fields
 *   • Send Last-Event-ID on reconnect for future event replay
 *   • Dispatch by the SSE event: field, not a wrapper JSON type
 *   • Add jitter to backoff so thundering-herd on engine restart is avoided
 *
 * Usage:
 *   window._amlEngine.on('engine.hello',      data => ...)
 *   window._amlEngine.on('drm',               snap => ...)
 *   window._amlEngine.on('prefetch.cached',   ev   => ...)
 *   window._amlEngine.on('prefetch.done',     ev   => ...)
 *   window._amlEngine.waitFor('engine.hello', 8000).then(data => ...)
 */

const ENGINE = 'aml-engine:/';

class EngineSSE {
    constructor(base) {
        this._base         = base;
        this._listeners    = new Map();   // type → Set<fn>
        this._ctrl         = null;
        this._retryDelay   = 1000;
        this._retryTimer   = null;
        this._lastEventId  = '';
        this._connected    = false;
        this._generation   = 0;           // snapshot epoch; updated on engine.snapshot
        this._connect();
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Subscribe to a named SSE event type. Returns `this` for chaining. */
    on(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
        return this;
    }

    /** Remove a previously registered handler. */
    off(type, fn) {
        this._listeners.get(type)?.delete(fn);
        return this;
    }

    /** Subscribe for a single firing, then auto-remove. */
    once(type, fn) {
        const wrap = (data) => { this.off(type, wrap); fn(data); };
        return this.on(type, wrap);
    }

    /**
     * Returns a Promise that resolves with the next event of `type`.
     * Rejects after `timeoutMs` if no event arrives.
     */
    waitFor(type, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off(type, handler);
                reject(new Error(`SSE waitFor('${type}') timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const handler = (data) => { clearTimeout(timer); resolve(data); };
            this.once(type, handler);
        });
    }

    /** True once the fetch stream has opened and the server acknowledged it. */
    get connected() { return this._connected; }

    /**
     * The current snapshot generation.  Any event with a lower generation
     * arrived from a previous connection cycle and should be discarded.
     */
    get generation() { return this._generation; }

    // ── Internals ──────────────────────────────────────────────────────────────

    _dispatch(type, data) {
        // All events arrive in {meta: {id, generation, ...}, payload: {...}} form.
        // Track generation from meta so callers can guard against stale events.
        const gen = data?.meta?.generation;
        if (typeof gen === 'number' && gen > this._generation) {
            this._generation = gen;
        }
        this._listeners.get(type)?.forEach(fn => {
            try { fn(data); } catch (e) { console.error('[AML SSE] handler error:', e); }
        });
    }

    async _connect() {
        if (this._ctrl) this._ctrl.abort();
        this._ctrl = new AbortController();

        try {
            const headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
            if (this._lastEventId) headers['Last-Event-ID'] = this._lastEventId;

            const resp = await fetch(`${this._base}/api/v1/events`, {
                headers,
                signal: this._ctrl.signal,
            });

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            this._connected = true;
            this._retryDelay = 1000; // reset on successful connect
            console.log('[AML SSE] Connected');

            await this._parseStream(resp.body);
        } catch (e) {
            if (e.name === 'AbortError') return;
            console.warn('[AML SSE] Disconnected:', e.message);
        }

        this._connected = false;
        this._scheduleReconnect();
    }

    async _parseStream(body) {
        const reader  = body.getReader();
        const decoder = new TextDecoder();
        let buf       = '';
        let eventType = 'message';
        let dataLines = [];
        let lastId    = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buf += decoder.decode(value, { stream: true });

                // Process all complete lines; keep any trailing partial line.
                const lines = buf.split('\n');
                buf = lines.pop();

                for (const rawLine of lines) {
                    // Trim trailing \r to handle \r\n line endings.
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

                    if (line === '') {
                        // Blank line: dispatch the buffered event.
                        if (dataLines.length > 0) {
                            if (lastId) this._lastEventId = lastId;
                            const dataStr = dataLines.join('\n');
                            let parsed = dataStr;
                            try { parsed = JSON.parse(dataStr); } catch (_) {}
                            this._dispatch(eventType, parsed);
                        }
                        // Reset per-event state.
                        eventType = 'message';
                        dataLines = [];
                        lastId    = '';

                    } else if (line.startsWith(':')) {
                        // Comment line (e.g. legacy ": ping") — ignore.

                    } else {
                        const colon = line.indexOf(':');
                        const field = colon >= 0 ? line.slice(0, colon) : line;
                        const val   = colon >= 0 ? line.slice(colon + 1).replace(/^ /, '') : '';

                        switch (field) {
                            case 'id':    lastId = val;                             break;
                            case 'event': eventType = val || 'message';             break;
                            case 'data':  dataLines.push(val);                      break;
                            case 'retry': {
                                const ms = parseInt(val, 10);
                                if (!isNaN(ms) && ms > 0) this._retryDelay = ms;
                                break;
                            }
                        }
                    }
                }
            }
        } finally {
            reader.cancel().catch(() => {});
        }
    }

    _scheduleReconnect() {
        if (this._retryTimer) return;
        // Add ±25 % jitter so multiple clients don't reconnect simultaneously
        // after an engine restart (thundering herd).
        const jitter = (Math.random() - 0.5) * 0.5 * this._retryDelay;
        const delay  = Math.max(500, this._retryDelay + jitter);
        this._retryDelay = Math.min(this._retryDelay * 2, 30000);
        this._retryTimer = setTimeout(() => {
            this._retryTimer = null;
            this._connect();
        }, delay);
        if (delay > 1500) console.log(`[AML SSE] Reconnecting in ${Math.round(delay)}ms`);
    }
}

window._amlEngine = new EngineSSE(ENGINE);
