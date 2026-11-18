import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t } from '../../src/engine/i18n.js';
const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = source.indexOf('function _histInject() {');
const inject = source.slice(start, source.indexOf('\nasync function setupQueueHistory', start));
class Element {
    constructor(className = '') { this.className = className; this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {}; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    prepend(child) { this.appendChild(child); this.children.unshift(this.children.pop()); }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    after(child) { this.parentElement.appendChild(child); }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    click() { this.listeners.click?.(); }
    focus() { this.focused = true; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelector(selector) {
        const match = e => selector.startsWith('#') ? e.id === selector.slice(1)
            : selector.startsWith('.') ? e.className === selector.slice(1)
            : selector.includes('side-panel-header') && e.attrs['data-testid'] === 'side-panel-header';
        for (const child of this.children) { if (match(child)) return child; const nested = child.querySelector(selector); if (nested) return nested; }
        return null;
    }
}
function setup() {
    const root = new Element(), lyrics = root.appendChild(new Element('side-panel'));
    lyrics.id = 'lyrics';
    const queue = root.appendChild(new Element('side-panel')); queue.id = 'queue';
    const header = queue.appendChild(new Element('side-panel-header-wrapper'));
    const heading = header.appendChild(new Element()); heading.setAttribute('data-testid', 'side-panel-header'); heading.textContent = 'In coda';
    const button = new Element(); button.setAttribute('aria-controls', 'queue');
    let renders = 0;
    const context = vm.createContext({
        document: {
            documentElement: { lang: 'it' }, createElement: () => new Element(),
            querySelector: selector => selector.includes('up-next-button') ? button : null,
            getElementById: id => root.querySelector('#' + id),
        },
        _t: key => t(key, 'it'), getComputedStyle: () => ({ direction: 'ltr' }),
        window: {}, _histEnabled: true, _histRender: () => renders++,
    });
    vm.runInContext(inject, context);
    return { context, lyrics, queue, heading, button, renders: () => renders };
}
test('history mounts only in the queue identified by its button, never in the first lyrics panel', () => {
    const s = setup();
    const legacy = s.lyrics.appendChild(new Element()); legacy.id = 'adam-history-section';
    s.context._histInject(); s.context._histInject();
    assert.equal(s.lyrics.children.length, 0);
    assert.equal(s.queue.querySelector('#adam-history-section').parentElement, s.queue);
    assert.equal(s.renders(), 1);
});
test('queue and history are exclusive views and disabling history restores the native queue', () => {
    const s = setup(); s.context._histInject();
    const section = s.queue.querySelector('#adam-history-section');
    const [queue, history] = s.queue.querySelector('.adam-queue-tabs').children;
    assert.equal(section.hidden, true);
    history.listeners.click();
    assert.equal(s.queue.dataset.adamQueueView, 'history');
    assert.equal(section.hidden, false);
    assert.equal(history.getAttribute('aria-selected'), 'true');
    assert.equal(queue.getAttribute('aria-selected'), 'false');
    assert.equal(s.heading.textContent, 'In coda', 'Apple owns its heading; selecting History must not mutate it');
    queue.listeners.click();
    assert.equal(section.hidden, true);
    assert.equal(s.heading.textContent, 'In coda');
    history.listeners.click(); s.context._histEnabled = false; s.context._histInject();
    assert.equal(s.queue.querySelector('#adam-history-section'), null);
    assert.equal(s.queue.querySelector('.adam-queue-tabs'), null);
    assert.equal(s.queue.dataset.adamQueueView, undefined);
    assert.equal(s.heading.textContent, 'In coda');
});
test('a lyrics-only panel without a mounted queue receives no history', () => {
    const s = setup(); s.button.setAttribute('aria-controls', 'missing');
    s.context._histInject();
    assert.equal(s.lyrics.children.length, 0);
    assert.equal(s.renders(), 0);
});


test('queue tabs provide roving keyboard selection without editing native headings', () => {
    const s = setup(); s.context._histInject();
    const tabs = s.queue.querySelector('.adam-queue-tabs');
    const [queue, history] = tabs.children;
    assert.equal(tabs.getAttribute('role'), 'tablist');
    assert.equal(history.getAttribute('role'), 'tab');
    let prevented = false;
    tabs.listeners.keydown({ key: 'ArrowRight', target: queue, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(history.focused, true);
    assert.equal(history.tabIndex, 0);
    assert.equal(queue.tabIndex, -1);
    assert.equal(history.getAttribute('aria-controls'), 'adam-history-section');
    tabs.listeners.keydown({ key: 'Home', target: history, preventDefault() {} });
    assert.equal(queue.tabIndex, 0);
    assert.equal(s.heading.textContent, 'In coda');
});
test('replaying an older history item moves it to the head without a duplicate', () => {
    const i = source.indexOf('function _histPush(item) {');
    const push = source.slice(i, source.indexOf('\nfunction _histClear()', i));
    const context = vm.createContext({
        _queueHistory: [{ id: 'a', catalogId: 'a' }, { id: 'b', catalogId: 'b' }], _HIST_MAX: 100,
        _histArtUrl() {}, _histFmtDur() {}, _histSaveAsync() {}, _histRender() {},
    });
    vm.runInContext(push, context);
    context._histPush({ id: 'b', attributes: { name: 'Song B' } });
    assert.equal(context._queueHistory.length, 2);
    assert.equal(context._queueHistory[0].id, 'b');
    assert.equal(context._queueHistory[1].id, 'a');
});
