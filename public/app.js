const canvas = document.getElementById('screencast');
const ctx = canvas.getContext('2d');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const loadingOverlay = document.getElementById('loading-overlay');

// Ensure canvas resolution matches display size
function resizeCanvas() {
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Establish WebSocket connection
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

ws.onopen = () => {
    statusDot.classList.add('connected');
    statusDot.classList.remove('disconnected');
    statusText.textContent = 'Connected';
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
                // First frame received, hide loading
                if (!canvas.classList.contains('ready')) {
                    loadingOverlay.classList.add('hidden');
                    canvas.classList.add('ready');
                }
                
                // Draw the image, scaling to fit canvas while maintaining aspect ratio or stretching?
                // Playwright sends frames. Let's just stretch it for now, 
                // or we can map coordinates accurately if we maintain aspect ratio.
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
            img.src = 'data:image/jpeg;base64,' + msg.data;
        }
    } catch (e) {
        console.error("Error processing message:", e);
    }
};

// Input Handling
function sendMsg(msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

// Coordinate mapping (since canvas size might differ from Playwright window size (1280x720))
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

// Mouse Events
canvas.addEventListener('mousemove', (e) => {
    const coords = getMappedCoords(e);
    sendMsg({ type: 'mousemove', x: coords.x, y: coords.y });
});

canvas.addEventListener('mousedown', (e) => {
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

// Keyboard Events
// Map web keyboard events to Playwright keys
window.addEventListener('keydown', (e) => {
    // Don't intercept if user is typing in the URL bar
    if (document.activeElement === urlInput) return;
    
    e.preventDefault();
    sendMsg({ type: 'keydown', key: e.key });
});

window.addEventListener('keyup', (e) => {
    if (document.activeElement === urlInput) return;
    e.preventDefault();
    sendMsg({ type: 'keyup', key: e.key });
});

// URL Navigation
function navigate() {
    const url = urlInput.value.trim();
    if (url) {
        sendMsg({ type: 'goto', url });
    }
}

goBtn.addEventListener('click', navigate);
urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        navigate();
    }
});
