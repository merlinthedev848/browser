// ---------- DOM References ----------
const loginScreen   = document.getElementById('login-screen');
const loginForm     = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError    = document.getElementById('login-error');
const loginBtn      = document.getElementById('login-btn');
const appContainer  = document.getElementById('app-container');
const canvas        = document.getElementById('screencast');
const urlInput      = document.getElementById('url-input');
const goBtn         = document.getElementById('go-btn');
const statusDot     = document.querySelector('.status-dot');
const statusText    = document.querySelector('.status-text');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText   = document.getElementById('loading-text');
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn     = document.getElementById('new-tab-btn');

// Canvas 2D context — alpha:false skips compositing, desynchronized reduces latency
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// ---------- State ----------
let ws = null;
let appInitialized = false;
let reconnectTimer = null;

// Remote browser resolution — must match server.js viewport
const REMOTE_W = 1920;
const REMOTE_H = 1080;

// ---------- Canvas Setup ----------
function applyCanvasSettings() {
    // Must be called after every resize — setting canvas.width/height resets ALL context state
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
}

function resizeCanvas() {
    const parent = canvas.parentElement;
    const newW = parent.clientWidth;
    const newH = parent.clientHeight;
    if (canvas.width !== newW || canvas.height !== newH) {
        canvas.width  = newW;
        canvas.height = newH;
        applyCanvasSettings(); // Restore after reset
    }
}

// ---------- Session Persistence ----------
const storedToken = sessionStorage.getItem('vb_token');
if (storedToken) {
    loginScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    initApp(storedToken);
}

// ---------- Login ----------
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginError.classList.add('hidden');

    try {
        const res  = await fetch('/api/login', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ password: passwordInput.value })
        });
        const data = await res.json();

        if (data.success) {
            sessionStorage.setItem('vb_token', data.token);
            loginScreen.classList.add('hidden');
            appContainer.classList.remove('hidden');
            initApp(data.token);
        } else {
            loginError.textContent = data.error || 'Invalid password';
            loginError.classList.remove('hidden');
        }
    } catch {
        loginError.textContent = 'Connection error — is the server running?';
        loginError.classList.remove('hidden');
    } finally {
        loginBtn.disabled = false;
    }
});

// ---------- Main App ----------
function initApp(token) {
    if (appInitialized) return;
    appInitialized = true;

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    connectWS(token);
}

function connectWS(token) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/?token=${token}`);
    ws.binaryType = 'blob';

    ws.onopen = () => {
        statusDot.classList.replace('disconnected', 'connected');
        statusText.textContent = 'Connected';
        canvas.focus();
    };

    ws.onclose = () => {
        statusDot.classList.replace('connected', 'disconnected');
        statusText.textContent = 'Reconnecting...';
        showOverlay('Reconnecting...');
        canvas.classList.remove('ready');

        // Retry immediately with the same token — no login screen flash
        reconnectTimer = setTimeout(() => connectWS(token), 3000);
    };

    ws.onerror = () => {
        // onclose will fire right after — let that handle UI
    };

    ws.onmessage = (event) => {
        let isBinary = false;
        let blob = null;

        if (event.data instanceof Blob) {
            isBinary = true;
            blob = event.data;
        } else if (event.data instanceof ArrayBuffer) {
            isBinary = true;
            blob = new Blob([event.data], { type: 'image/jpeg' });
        }

        if (isBinary && blob) {
            if (typeof createImageBitmap === 'function') {
                createImageBitmap(blob)
                    .then(bitmap => {
                        if (!canvas.classList.contains('ready')) {
                            hideOverlay();
                            canvas.classList.add('ready');
                        }
                        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                        bitmap.close();
                        sendMsg({ type: 'frame_ack' });
                    })
                    .catch(() => {
                        renderWithObjectURL(blob);
                    });
            } else {
                renderWithObjectURL(blob);
            }
            return;
        }

        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
            case 'url_changed':
                if (document.activeElement !== urlInput) {
                    urlInput.value = msg.url;
                }
                break;

            case 'tab_state':
                renderTabs(msg.tabs);
                break;

            case 'cursor':
                canvas.style.cursor = msg.cursor || 'default';
                break;
    };
}

function renderWithObjectURL(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
        if (!canvas.classList.contains('ready')) {
            hideOverlay();
            canvas.classList.add('ready');
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url); // Immediately free memory
        sendMsg({ type: 'frame_ack' });
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        sendMsg({ type: 'frame_ack' });
    };
    img.src = url;
}

// ---------- Overlay ----------
function showOverlay(text) {
    if (loadingText) loadingText.textContent = text || 'Loading...';
    loadingOverlay.classList.remove('hidden');
}
function hideOverlay() {
    loadingOverlay.classList.add('hidden');
}

// ---------- Messaging ----------
function sendMsg(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// ---------- Tabs ----------
// Keep DOM nodes for tabs so we can diff-update instead of full rebuild
const tabDomMap = new Map(); // tabId -> tabEl

function renderTabs(tabs) {
    const seenIds = new Set();

    tabs.forEach(tab => {
        seenIds.add(tab.id);
        let tabEl = tabDomMap.get(tab.id);

        if (!tabEl) {
            // Create new tab element
            tabEl = document.createElement('div');
            tabEl.dataset.tabId = tab.id;

            const iconEl = document.createElement('img');
            iconEl.className = 'tab-icon';
            iconEl.style.display = 'none';
            iconEl.onerror = () => { iconEl.style.display = 'none'; };

            const titleEl = document.createElement('span');
            titleEl.className = 'tab-title';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-close';
            closeBtn.setAttribute('aria-label', 'Close tab');
            closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

            tabEl.appendChild(iconEl);
            tabEl.appendChild(titleEl);
            tabEl.appendChild(closeBtn);

            tabEl.addEventListener('click', () => {
                if (!tabEl.classList.contains('active')) {
                    showOverlay('Switching tabs...');
                    canvas.classList.remove('ready');
                    sendMsg({ type: 'switch_tab', tabId: tab.id });
                }
            });

            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendMsg({ type: 'close_tab', tabId: tab.id });
            });

            tabDomMap.set(tab.id, tabEl);
            tabsContainer.appendChild(tabEl);
        }

        // Diff-update: only change what actually changed
        const iconEl  = tabEl.querySelector('.tab-icon');
        const titleEl = tabEl.querySelector('.tab-title');

        const newTitle = tab.title || 'New Tab';
        if (titleEl.textContent !== newTitle) titleEl.textContent = newTitle;

        if (tab.favicon && iconEl.src !== tab.favicon) {
            iconEl.src = tab.favicon;
            iconEl.style.display = '';
        }

        const isActive = tab.isActive;
        tabEl.className = `tab${isActive ? ' active' : ''}`;
    });

    // Remove tabs that no longer exist
    for (const [id, el] of tabDomMap) {
        if (!seenIds.has(id)) {
            el.remove();
            tabDomMap.delete(id);
        }
    }

    // Ensure DOM order matches server order
    tabs.forEach(tab => {
        const el = tabDomMap.get(tab.id);
        if (el) tabsContainer.appendChild(el); // appendChild moves if already in DOM
    });
}

newTabBtn.addEventListener('click', () => sendMsg({ type: 'new_tab' }));

// ---------- Coordinate Mapping ----------
function getMappedCoords(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.round((e.clientX - rect.left) * (REMOTE_W / rect.width)),
        y: Math.round((e.clientY - rect.top)  * (REMOTE_H / rect.height))
    };
}

const mapButton = (e) => ['left', 'middle', 'right'][e.button] ?? 'left';

// ---------- Mouse Events ----------
let lastMoveTime = 0;
canvas.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMoveTime < 33) return; // Cap at ~30fps
    lastMoveTime = now;
    const c = getMappedCoords(e);
    sendMsg({ type: 'mousemove', x: c.x, y: c.y });
});

canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    canvas.focus();
    const c = getMappedCoords(e);
    sendMsg({ type: 'mousedown', x: c.x, y: c.y, button: mapButton(e) });
});

canvas.addEventListener('mouseup', (e) => {
    const c = getMappedCoords(e);
    sendMsg({ type: 'mouseup', x: c.x, y: c.y, button: mapButton(e) });
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    sendMsg({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
}, { passive: false });

// ---------- Keyboard ----------
function getModifiers(e) {
    const mods = [];
    if (e.ctrlKey)  mods.push('Control');
    if (e.shiftKey) mods.push('Shift');
    if (e.altKey)   mods.push('Alt');
    if (e.metaKey)  mods.push('Meta');
    return mods;
}

const INTERCEPT_KEYS = new Set([
    'Tab', 'Backspace', 'Delete', 'Escape', 'Enter', 'Space',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'
]);

window.addEventListener('keydown', (e) => {
    if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
    if (document.activeElement !== canvas) return;

    if (e.ctrlKey || e.metaKey || e.altKey || INTERCEPT_KEYS.has(e.key)) {
        e.preventDefault();
    }
    sendMsg({ type: 'keydown', key: e.key, modifiers: getModifiers(e) });
}, { passive: false });

window.addEventListener('keyup', (e) => {
    if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
    if (document.activeElement !== canvas) return;
    sendMsg({ type: 'keyup', key: e.key, modifiers: getModifiers(e) });
});

window.addEventListener('paste', (e) => {
    if (document.activeElement !== canvas) return;
    const text = e.clipboardData?.getData('text');
    if (text) sendMsg({ type: 'type', text });
});

// ---------- URL Bar ----------
function navigate() {
    const input = urlInput.value.trim();
    if (!input) return;
    sendMsg({ type: 'goto', url: input });
    canvas.focus();
}

goBtn.addEventListener('click', navigate);

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); navigate(); }
    if (e.key === 'Escape') { canvas.focus(); }
});

urlInput.addEventListener('focus', () => urlInput.select());
