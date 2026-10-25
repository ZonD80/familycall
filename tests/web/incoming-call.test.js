// Tests for the incoming call Accept / Reject flow in server/web/app.js.
// Run with: node --test tests/web
//
// app.js is a plain browser script, so it is loaded into a VM context with a
// minimal fake DOM, fake timers and a fake WebSocket that records sent messages.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '../../server/web/app.js'), 'utf8');
const RING_TIMEOUT_MS = 45000;

function createElement(id) {
    const classes = new Set();
    const listeners = {};
    return {
        id,
        textContent: '',
        title: '',
        checked: false,
        style: {},
        srcObject: null,
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            contains: (c) => classes.has(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            }
        },
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        click: () => (listeners.click || []).forEach(fn => fn({ preventDefault() { }, stopPropagation() { } })),
        querySelector: () => null,
        contains: () => false,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        removeEventListener() { }
    };
}

function createStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
        data
    };
}

// Loads app.js into a fresh context and returns helpers to drive it
function loadApp({ askBeforeAnswer = false } = {}) {
    const elements = {};
    const getElement = (id) => (elements[id] = elements[id] || createElement(id));
    const callContainer = getElement('call-container');

    // Fake timers
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const addTimer = (fn, delay, interval) => {
        const id = nextTimerId++;
        timers.set(id, { fn, at: now + (delay || 0), interval: interval ? (delay || 0) : null });
        return id;
    };
    const clearTimer = (id) => { timers.delete(id); };
    const advance = (ms) => {
        const end = now + ms;
        for (; ;) {
            let next = null;
            for (const [id, timer] of timers) {
                if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
            }
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.interval !== null) timer.at = now + Math.max(timer.interval, 1);
            else timers.delete(id);
            timer.fn();
        }
        now = end;
    };

    const sent = [];
    const vibrations = [];
    const mediaRequests = [];
    const localStorage = createStorage(askBeforeAnswer ? { askBeforeAnswer: 'true' } : {});

    const context = {
        console: { log() { }, warn() { }, error() { }, info() { } },
        setTimeout: (fn, delay) => addTimer(fn, delay, false),
        clearTimeout: clearTimer,
        setInterval: (fn, delay) => addTimer(fn, delay, true),
        clearInterval: clearTimer,
        localStorage,
        sessionStorage: createStorage(),
        alert() { },
        URLSearchParams,
        WebSocket: { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 },
        navigator: {
            vibrate: (pattern) => { vibrations.push(pattern); return true; },
            mediaDevices: {
                getUserMedia: async (constraints) => {
                    mediaRequests.push(JSON.parse(JSON.stringify(constraints)));
                    throw new Error('no media in tests');
                },
                enumerateDevices: async () => []
            }
        },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        document: {
            getElementById: getElement,
            querySelector: (sel) => (sel === '.call-container' ? callContainer : null),
            querySelectorAll: (sel) => (sel === '.screen'
                ? ['login-screen', 'app-screen', 'call-screen'].map(getElement)
                : []),
            addEventListener() { }
        },
        location: { protocol: 'https:', host: 'example.test', pathname: '/', search: '' },
        history: { replaceState() { } },
        addEventListener() { },
        matchMedia: () => ({ matches: false }),
        innerWidth: 1024,
        innerHeight: 768
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(APP_JS, context, { filename: 'app.js' });

    // Layout-only helpers unrelated to call signaling
    context.makeLocalVideoDraggable = () => { };
    context.showInstallBannerIfNeeded = () => { };

    const run = (code) => vm.runInContext(code, context);
    // Parse in the host realm so assert.deepEqual works on sent messages
    context.__send = (s) => sent.push(JSON.parse(s));
    run(`
        currentUser = { id: 'me' };
        wsConnection = { readyState: 1, send: __send };
    `);

    return {
        run,
        advance,
        sent,
        vibrations,
        mediaRequests,
        localStorage,
        el: getElement,
        isRinging: () => callContainer.classList.contains('ringing'),
        currentCall: () => run('currentCall'),
        status: () => getElement('call-status').textContent,
        activeScreen: () => Object.values(elements).find(e => e.classList.contains('active'))?.id,
        receive: (message) => context.handleWebSocketMessage(message),
        sentOfType: (type) => sent.filter(m => m.type === type)
    };
}

function callRequest(from = 'grandkid', callType = 'video') {
    return { type: 'call-request', from, to: 'me', call_type: callType, data: { caller_username: 'Grandkid', caller_id: from } };
}

// Lets pending promise callbacks (async handlers) run
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

// --- Callee side ---

test('auto-accepts incoming calls when ask-before-answer is off (default)', () => {
    const app = loadApp();
    app.receive(callRequest());

    assert.equal(app.sentOfType('call-accept').length, 1);
    assert.equal(app.sentOfType('call-accept')[0].to, 'grandkid');
    assert.equal(app.isRinging(), false);
    assert.equal(app.status(), 'waiting_for_offer');
});

test('rings instead of answering when ask-before-answer is on', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());

    assert.equal(app.sent.length, 0, 'nothing is sent to the caller while ringing');
    assert.equal(app.isRinging(), true);
    assert.equal(app.activeScreen(), 'call-screen');
    assert.equal(app.el('call-contact-name').textContent, 'Grandkid');
    assert.equal(app.status(), 'incoming_call');
    assert.ok(app.vibrations.length > 0, 'vibrates as a ringtone fallback');
});

test('Accept sends call-accept and stops ringing', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.run('acceptIncomingCall()');

    assert.deepEqual(app.sentOfType('call-accept').map(m => m.to), ['grandkid']);
    assert.equal(app.isRinging(), false);
    assert.equal(app.currentCall().ringing, false);
    assert.equal(app.status(), 'waiting_for_offer');

    // The ring timeout no longer applies once accepted
    app.advance(RING_TIMEOUT_MS * 2);
    assert.equal(app.sentOfType('call-reject').length, 0);
    assert.ok(app.currentCall());
});

test('Reject sends call-reject (not call-end) and closes the call screen', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.run('rejectIncomingCall()');

    assert.deepEqual(app.sent.map(m => m.type), ['call-reject']);
    assert.equal(app.sent[0].to, 'grandkid');
    assert.equal(app.currentCall(), null);
    assert.equal(app.isRinging(), false);
    assert.equal(app.activeScreen(), 'app-screen');
});

test('unanswered incoming call is dismissed after the ring timeout', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());

    app.advance(RING_TIMEOUT_MS - 1);
    assert.equal(app.isRinging(), true);

    app.advance(1);
    assert.deepEqual(app.sent.map(m => m.type), ['call-reject']);
    assert.equal(app.currentCall(), null);
    assert.equal(app.isRinging(), false);
});

test('caller hanging up while ringing dismisses the incoming call screen', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.receive({ type: 'call-end', from: 'grandkid', to: 'me' });

    assert.equal(app.status(), 'call_ended');
    app.advance(1000);
    assert.equal(app.currentCall(), null);
    assert.equal(app.isRinging(), false);
    assert.equal(app.sentOfType('call-accept').length, 0);
});

test('offer received while ringing does not turn on camera or microphone', async () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.receive({ type: 'offer', from: 'grandkid', to: 'me', call_type: 'video', data: { type: 'offer', sdp: 'x' } });
    await flushPromises();

    assert.equal(app.mediaRequests.length, 0);
    assert.equal(app.isRinging(), true);
});

test('unsolicited offer is ignored when ask-before-answer is on', async () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive({ type: 'offer', from: 'grandkid', to: 'me', call_type: 'video', data: { type: 'offer', sdp: 'x' } });
    await flushPromises();

    assert.equal(app.mediaRequests.length, 0);
    assert.equal(app.currentCall(), null);
});

test('offer after Accept requests media', async () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.run('acceptIncomingCall()');
    app.receive({ type: 'offer', from: 'grandkid', to: 'me', call_type: 'video', data: { type: 'offer', sdp: 'x' } });
    await flushPromises();

    assert.deepEqual(app.mediaRequests, [{ audio: true, video: true }]);
});

test('duplicate call-request from the same caller does not ring twice', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest());
    app.advance(10000);
    app.receive(callRequest());

    assert.equal(app.sent.length, 0);
    assert.equal(app.isRinging(), true);

    // The original ring timeout still applies (not restarted by the duplicate)
    app.advance(RING_TIMEOUT_MS - 10000);
    assert.equal(app.currentCall(), null);
});

test('second caller gets a busy rejection while already ringing or in a call', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.receive(callRequest('grandkid'));
    app.receive(callRequest('cousin'));

    assert.deepEqual(app.sentOfType('call-reject'), [{ type: 'call-reject', to: 'cousin', data: { reason: 'busy' }, from: 'me' }]);
    assert.equal(app.currentCall().contactId, 'grandkid');
    assert.equal(app.isRinging(), true);
});

test('call opened from a tapped push notification is answered without asking', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.run(`handleCallFromNotification({ caller_id: 'grandkid', caller_name: 'Grandkid', call_type: 'video' })`);
    app.receive(callRequest());

    assert.equal(app.sentOfType('call-accept').length, 1);
    assert.equal(app.isRinging(), false);

    // Only that one call is auto-answered; the next call from the same caller rings
    app.run('endCall()');
    app.sent.length = 0;
    app.receive(callRequest());
    assert.equal(app.sentOfType('call-accept').length, 0);
    assert.equal(app.isRinging(), true);
});

test('notification auto-answer expires if the call-request never arrives', () => {
    const app = loadApp({ askBeforeAnswer: true });
    app.run(`handleCallFromNotification({ caller_id: 'grandkid', caller_name: 'Grandkid', call_type: 'video' })`);
    app.advance(15000);

    app.receive(callRequest());
    assert.equal(app.sentOfType('call-accept').length, 0);
    assert.equal(app.isRinging(), true);
});

test('ask-before-answer setting persists in localStorage', () => {
    const app = loadApp();
    assert.equal(app.run('isAskBeforeAnswerEnabled()'), false);
    app.run('setAskBeforeAnswer(true)');
    assert.equal(app.localStorage.data.askBeforeAnswer, 'true');
    assert.equal(app.run('isAskBeforeAnswerEnabled()'), true);
    app.run('setAskBeforeAnswer(false)');
    assert.equal(app.run('isAskBeforeAnswerEnabled()'), false);
});

// --- Caller side ---

async function startOutgoingCall(app) {
    await app.run(`initiateCall('grandma', 'grandma', 'video', 'Grandma')`);
    assert.equal(app.currentCall().waitingForConnection, true);
}

test('outgoing call gives up after the ring timeout and notifies the callee', async () => {
    const app = loadApp();
    await startOutgoingCall(app);

    app.advance(RING_TIMEOUT_MS);
    assert.equal(app.status(), 'no_answer');
    app.advance(2000);

    assert.deepEqual(app.sentOfType('call-end').map(m => m.to), ['grandma']);
    assert.equal(app.currentCall(), null);
});

test('rejected outgoing call shows "declined" and ends without sending call-end', async () => {
    const app = loadApp();
    await startOutgoingCall(app);
    app.receive({ type: 'call-reject', from: 'grandma', to: 'me' });

    assert.equal(app.status(), 'call_declined');
    app.advance(2000);
    assert.equal(app.currentCall(), null);
    assert.equal(app.sentOfType('call-end').length, 0);

    // The no-answer timer was cancelled
    app.advance(RING_TIMEOUT_MS);
    assert.notEqual(app.status(), 'no_answer');
});

test('busy rejection shows "contact busy"', async () => {
    const app = loadApp();
    await startOutgoingCall(app);
    app.receive({ type: 'call-reject', from: 'grandma', to: 'me', data: { reason: 'busy' } });

    assert.equal(app.status(), 'contact_busy');
});

test('call-reject from someone else does not end the outgoing call', async () => {
    const app = loadApp();
    await startOutgoingCall(app);
    app.receive({ type: 'call-reject', from: 'stranger', to: 'me' });
    app.advance(2000);

    assert.equal(app.currentCall().contactId, 'grandma');
});

test('accepted outgoing call cancels the no-answer timeout', async () => {
    const app = loadApp();
    await startOutgoingCall(app);
    app.receive({ type: 'call-accept', from: 'grandma', to: 'me' });
    await flushPromises();

    app.advance(RING_TIMEOUT_MS);
    assert.notEqual(app.status(), 'no_answer');
    assert.equal(app.sentOfType('call-end').length, 0);
});

// --- WebSocket authentication ---

function installFakeWebSocket(app) {
    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 1;
            this.sent = [];
            sockets.push(this);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
    }
    FakeWebSocket.OPEN = 1;
    app.run('globalThis').WebSocket = FakeWebSocket;
    app.run(`authToken = 'jwt-token'`);
    return sockets;
}

test('WebSocket authenticates with the token as its first message, not a user_id in the URL', () => {
    const app = loadApp();
    const sockets = installFakeWebSocket(app);
    app.run('connectWebSocket()');
    sockets[0].onopen();

    assert.equal(sockets[0].url, 'wss://example.test/ws');
    assert.deepEqual(sockets[0].sent[0], { type: 'auth', token: 'jwt-token' });
});

test('WebSocket does not reconnect after the server rejects the token', () => {
    const app = loadApp();
    const sockets = installFakeWebSocket(app);
    app.run('connectWebSocket()');

    sockets[0].onclose({ code: 1008 });
    app.advance(10000);
    assert.equal(sockets.length, 1);

    // Other disconnects still reconnect
    app.run('connectWebSocket()');
    sockets[1].onclose({ code: 1006 });
    app.advance(3000);
    assert.equal(sockets.length, 3);
});
