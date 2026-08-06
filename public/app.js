// --- Auth Elements ---
const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password-input');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const appContainer = document.getElementById('app-container');

// --- App Elements ---
const canvas = document.getElementById('screencast');
const ctx = canvas.getContext('2d');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const loadingOverlay = document.getElementById('loading-overlay');
const tabsContainer = document.getElementById('tabs-container');
const newTabBtn = document.getElementById('new-tab-btn');

let ws = null;

// --- Session Persistence ---
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
        loginError.textContent = 'Connection error';
        loginError.classList.remove('hidden');
    } finally {
        loginBtn.disabled = false;
    }
});


// --- Main App Logic ---
function initApp(token) {
    function resizeCanvas() {
        const parent = canvas.parentElement;
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

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
        loadingOverlay.classList.remove('hidden');
        canvas.classList.remove('ready');
        // If connection closes gracefully or token expires, we might want to clear it, but let's leave it for now.
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'frame') {
                const img = new Image();
                img.onload = () => {
                    if (!canvas.classList.contains('ready')) {
                        loadingOverlay.classList.add('hidden');
                        canvas.classList.add('ready');
                    }
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    sendMsg({ type: 'frame_ack' });
                };
                img.onerror = () => {
                    sendMsg({ type: 'frame_ack' });
                };
                img.src = 'data:image/jpeg;base64,' + msg.data;
            } else if (msg.type === 'url_changed') {
                urlInput.value = msg.url;
            } else if (msg.type === 'tab_state') {
                renderTabs(msg.tabs);
            } else if (msg.type === 'cursor') {
                // Sync cursor style
                canvas.style.cursor = msg.cursor || 'default';
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    };

    // --- Tab Rendering ---
    function renderTabs(tabs) {
        tabsContainer.innerHTML = '';
        tabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = `tab ${tab.isActive ? 'active' : ''}`;
            
            if (tab.favicon) {
                const iconEl = document.createElement('img');
                iconEl.className = 'tab-icon';
                iconEl.src = tab.favicon;
                // Fallback icon if image fails to load
                iconEl.onerror = () => { iconEl.style.display = 'none'; };
                tabEl.appendChild(iconEl);
            }
            
            const titleEl = document.createElement('span');
            titleEl.className = 'tab-title';
            titleEl.textContent = tab.title || 'New Tab';
            
            const closeBtn = document.createElement('div');
            closeBtn.className = 'tab-close';
            closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            
            tabEl.appendChild(titleEl);
            tabEl.appendChild(closeBtn);
            
            // Event Listeners
            tabEl.addEventListener('click', () => {
                if (!tab.isActive) {
                    loadingOverlay.querySelector('p').textContent = 'Switching tabs...';
                    loadingOverlay.classList.remove('hidden');
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


    // --- Input Passthrough ---
    function sendMsg(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function getMappedCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = 1280 / rect.width;
        const scaleY = 720 / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
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

    canvas.addEventListener('mousemove', (e) => {
        const coords = getMappedCoords(e);
        sendMsg({ type: 'mousemove', x: coords.x, y: coords.y });
    });

    canvas.addEventListener('mousedown', (e) => {
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

    // --- Advanced Keyboard Passthrough ---
    function getModifiers(e) {
        const mods = [];
        if (e.shiftKey) mods.push('Shift');
        if (e.ctrlKey) mods.push('Control');
        if (e.altKey) mods.push('Alt');
        if (e.metaKey) mods.push('Meta');
        return mods;
    }

    const preventDefaultKeys = ['Tab', 'Backspace', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

    window.addEventListener('keydown', (e) => {
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
        
        if (document.activeElement === canvas) {
            if (e.ctrlKey || e.metaKey || e.altKey || preventDefaultKeys.includes(e.key)) {
                e.preventDefault();
            }
            sendMsg({ type: 'keydown', key: e.key, modifiers: getModifiers(e) });
        }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
        
        if (document.activeElement === canvas) {
            if (e.ctrlKey || e.metaKey || e.altKey || preventDefaultKeys.includes(e.key)) {
                e.preventDefault();
            }
            sendMsg({ type: 'keyup', key: e.key, modifiers: getModifiers(e) });
        }
    }, { passive: false });

    window.addEventListener('paste', (e) => {
        if (document.activeElement === canvas) {
            const text = e.clipboardData.getData('text');
            if (text) {
                sendMsg({ type: 'type', text: text });
            }
        }
    });

    // Smart URL Navigation
    function navigate() {
        const input = urlInput.value.trim();
        if (input) {
            // Regex to check if it looks like a URL or domain
            const isUrl = /^(https?:\/\/)?([\w.-]+)\.([a-z]{2,})(:\d{1,5})?(\/.*)?$/i.test(input) || input.startsWith('localhost:');
            
            let finalUrl = input;
            if (isUrl) {
                if (!input.startsWith('http://') && !input.startsWith('https://')) {
                    finalUrl = 'https://' + input;
                }
            } else {
                // If not a URL, perform a Google search
                finalUrl = 'https://www.google.com/search?q=' + encodeURIComponent(input);
            }
            
            sendMsg({ type: 'goto', url: finalUrl });
            canvas.focus();
        }
    }

    goBtn.addEventListener('click', navigate);
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            navigate();
        }
    });
}
