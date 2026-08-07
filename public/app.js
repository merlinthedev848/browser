// --- Auth Elements ---
const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const appContainer = document.getElementById('app-container');

// --- App Elements ---
const canvas = document.getElementById('screencast');
// alpha:false skips alpha compositing — measurably faster canvas draw
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
// Enable high-quality bilinear downscaling for crisp text
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');

let ws = null;
let appInitialized = false;

// --- Session Persistence ---
// Try to reconnect with stored token on page load
const storedToken = sessionStorage.getItem('vb_token');
if (storedToken) {
    loginScreen.classList.add('hidden');
    appContainer.classList.remove('hidden');
    initApp(storedToken);
}

// --- Authentication Flow ---
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value;

    loginBtn.disabled = true;
    loginError.classList.add('hidden');

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();

        if (data.success) {
            sessionStorage.setItem('vb_token', data.token);
            loginScreen.classList.add('hidden');
            appContainer.classList.remove('hidden');
            initApp(data.token);
        } else {
            loginError.textContent = data.error || 'Login failed';
            loginError.classList.remove('hidden');
        }
    } catch (err) {
        loginError.textContent = 'Connection error. Is the server running?';
        loginError.classList.remove('hidden');
    } finally {
        loginBtn.disabled = false;
    }
});

// --- Main App Logic ---
function initApp(token) {
    if (appInitialized) return;
    appInitialized = true;

    // --- Canvas Resize ---
    function resizeCanvas() {
        const parent = canvas.parentElement;
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // --- WebSocket Connection ---
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/?token=${token}`);

    ws.onopen = () => {
        statusDot.classList.add('connected');
        statusDot.classList.remove('disconnected');
        statusText.textContent = 'Secure Session';
        canvas.focus();
    };

    ws.onclose = () => {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
        showOverlay('Disconnected. Reconnecting...');
        canvas.classList.remove('ready');

        // Auto-reconnect after 3 seconds
        setTimeout(() => {
            appInitialized = false;
            sessionStorage.removeItem('vb_token');

            // Re-authenticate and reconnect
            fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: '' }) // Will fail — shows login screen
            }).catch(() => {});

            // Show login screen
            appContainer.classList.add('hidden');
            loginScreen.classList.remove('hidden');
        }, 3000);
    };

    ws.onerror = () => {
        statusText.textContent = 'Connection Error';
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);

            if (msg.type === 'frame') {
                // Fast base64 decode using fetch API — avoids slow atob() loop
                fetch('data:image/jpeg;base64,' + msg.data)
                    .then(r => r.blob())
                    .then(blob => createImageBitmap(blob, { resizeQuality: 'high' }))
                    .then(bitmap => {
                        if (!canvas.classList.contains('ready')) {
                            hideOverlay();
                            canvas.classList.add('ready');
                        }
                        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                        bitmap.close();
                        sendMsg({ type: 'frame_ack' });
                    }).catch(() => {
                        sendMsg({ type: 'frame_ack' });
                    });

            } else if (msg.type === 'url_changed') {
                // Only update if user isn't currently typing in the bar
                if (document.activeElement !== urlInput) {
                    urlInput.value = msg.url;
                }
            } else if (msg.type === 'tab_state') {
                renderTabs(msg.tabs);
            } else if (msg.type === 'cursor') {
                canvas.style.cursor = msg.cursor || 'default';
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    };

    // --- Overlay Helpers ---
    function showOverlay(text) {
        if (loadingText) loadingText.textContent = text || 'Initializing Stream...';
        loadingOverlay.classList.remove('hidden');
    }
    function hideOverlay() {
        loadingOverlay.classList.add('hidden');
    }

    // --- Tab Rendering ---
    function renderTabs(tabs) {
        tabsContainer.innerHTML = '';
        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = `tab${tab.isActive ? ' active' : ''}`;

            if (tab.favicon) {
                const iconEl = document.createElement('img');
                iconEl.className = 'tab-icon';
                iconEl.src = tab.favicon;
                iconEl.onerror = () => { iconEl.style.display = 'none'; };
                tabEl.appendChild(iconEl);
            }

            const titleEl = document.createElement('span');
            titleEl.className = 'tab-title';
            titleEl.textContent = tab.title || 'New Tab';
            tabEl.appendChild(titleEl);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'tab-close';
            closeBtn.setAttribute('aria-label', 'Close tab');
            closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            tabEl.appendChild(closeBtn);

            tabEl.addEventListener('click', () => {
                if (!tab.isActive) {
                    showOverlay('Switching tabs...');
                    canvas.classList.remove('ready');
                    sendMsg({ type: 'switch_tab', tabId: tab.id });
                }
            });

            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendMsg({ type: 'close_tab', tabId: tab.id });
            });

            tabsContainer.appendChild(tabEl);
        });
    }

    newTabBtn.addEventListener('click', () => {
        sendMsg({ type: 'new_tab' });
    });

    // --- Message Sending ---
    function sendMsg(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    // --- Coordinate Mapping (browser renders at 1920x1080) ---
    const REMOTE_W = 1920;
    const REMOTE_H = 1080;
    function getMappedCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = REMOTE_W / rect.width;
        const scaleY = REMOTE_H / rect.height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY)
        };
    }

    const mapButton = (e) => {
        switch (e.button) {
            case 0: return 'left';
            case 1: return 'middle';
            case 2: return 'right';
            default: return 'left';
        }
    };

    // --- Mouse Input (throttled to 30 events/sec to avoid flooding WebSocket) ---
    let lastMouseMove = 0;
    canvas.addEventListener('mousemove', (e) => {
        const now = Date.now();
        if (now - lastMouseMove < 33) return; // ~30fps
        lastMouseMove = now;
        const c = getMappedCoords(e);
        sendMsg({ type: 'mousemove', x: c.x, y: c.y });
    });

    canvas.addEventListener('mousedown', (e) => {
        e.preventDefault();
        canvas.focus();
        sendMsg({ type: 'mousedown', button: mapButton(e) });
    });

    canvas.addEventListener('mouseup', (e) => {
        sendMsg({ type: 'mouseup', button: mapButton(e) });
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendMsg({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
    }, { passive: false });

    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // --- Keyboard Input ---
    function getModifiers(e) {
        const mods = [];
        if (e.shiftKey) mods.push('Shift');
        if (e.ctrlKey) mods.push('Control');
        if (e.altKey) mods.push('Alt');
        if (e.metaKey) mods.push('Meta');
        return mods;
    }

    const interceptedKeys = new Set([
        'Tab', 'Backspace', 'Delete', 'Escape', 'Enter',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Home', 'End', 'PageUp', 'PageDown',
        'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
        'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
    ]);

    window.addEventListener('keydown', (e) => {
        // Never intercept when typing in our own UI inputs
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;

        if (document.activeElement === canvas) {
            if (e.ctrlKey || e.metaKey || e.altKey || interceptedKeys.has(e.key)) {
                e.preventDefault();
            }
            sendMsg({ type: 'keydown', key: e.key, modifiers: getModifiers(e) });
        }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;

        if (document.activeElement === canvas) {
            sendMsg({ type: 'keyup', key: e.key, modifiers: getModifiers(e) });
        }
    });

    window.addEventListener('paste', (e) => {
        if (document.activeElement === canvas) {
            const text = e.clipboardData.getData('text');
            if (text) sendMsg({ type: 'type', text });
        }
    });

    // --- URL Bar Navigation ---
    function navigate() {
        const input = urlInput.value.trim();
        if (!input) return;
        // Send raw input to server which handles URL vs search detection
        sendMsg({ type: 'goto', url: input });
        canvas.focus();
    }

    goBtn.addEventListener('click', navigate);

    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            navigate();
        }
        // Escape returns focus to canvas
        if (e.key === 'Escape') {
            canvas.focus();
        }
    });

    // Clicking the URL bar should select all text for easy editing
    urlInput.addEventListener('focus', () => {
        urlInput.select();
    });
}
