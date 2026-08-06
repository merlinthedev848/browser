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

let ws = null;

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
            // Hide login, show app
            loginScreen.classList.add('hidden');
            appContainer.classList.remove('hidden');
            
            // Connect WebSocket with token
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
        // Focus canvas to catch key events immediately
        canvas.focus();
    };

    ws.onclose = () => {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
        loadingOverlay.classList.remove('hidden');
        canvas.classList.remove('ready');
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
                };
                img.src = 'data:image/jpeg;base64,' + msg.data;
            }
        } catch (e) {
            console.error("Error processing message:", e);
        }
    };

    // --- Input Passthrough ---
    function sendMsg(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function getMappedCoords(e) {
        const rect = canvas.getBoundingClientRect();
        // Assume default Playwright viewport 1280x720
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
        canvas.focus(); // Ensure canvas has focus for keyboard events
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
    
    // Helper to get active modifiers
    function getModifiers(e) {
        const mods = [];
        if (e.shiftKey) mods.push('Shift');
        if (e.ctrlKey) mods.push('Control');
        if (e.altKey) mods.push('Alt');
        if (e.metaKey) mods.push('Meta');
        return mods;
    }

    // List of keys to aggressively prevent default browser actions
    // so they are sent to the remote browser.
    const preventDefaultKeys = ['Tab', 'Backspace', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

    window.addEventListener('keydown', (e) => {
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
        
        // Prevent default browser shortcuts (Ctrl+T, Ctrl+R, etc) if canvas has focus
        if (document.activeElement === canvas) {
            if (e.ctrlKey || e.metaKey || e.altKey || preventDefaultKeys.includes(e.key)) {
                e.preventDefault();
            }
            sendMsg({ 
                type: 'keydown', 
                key: e.key, 
                modifiers: getModifiers(e)
            });
        }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
        if (document.activeElement === urlInput || document.activeElement === passwordInput) return;
        
        if (document.activeElement === canvas) {
            if (e.ctrlKey || e.metaKey || e.altKey || preventDefaultKeys.includes(e.key)) {
                e.preventDefault();
            }
            sendMsg({ 
                type: 'keyup', 
                key: e.key,
                modifiers: getModifiers(e)
            });
        }
    }, { passive: false });

    // Handle Copy/Paste (Basic)
    window.addEventListener('paste', (e) => {
        if (document.activeElement === canvas) {
            const text = e.clipboardData.getData('text');
            if (text) {
                // Send as direct typing to avoid complex key combo mapping
                sendMsg({ type: 'type', text: text });
            }
        }
    });

    // URL Navigation
    function navigate() {
        const url = urlInput.value.trim();
        if (url) {
            sendMsg({ type: 'goto', url });
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
