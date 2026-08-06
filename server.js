const express = require('express');
const { chromium } = require('playwright');
const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
const fetch = require('cross-fetch');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const url = require('url');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || 'password123';

const validTokens = new Set();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.add(token);
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const parsedUrl = url.parse(request.url, true);
    const token = parsedUrl.query.token;

    if (!token || !validTokens.has(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// --- Browser State ---
let context = null;
let adblocker = null;
let activeTabId = null;
let tabCounter = 0;
let browserStarting = false; // Guard against concurrent startBrowser calls

// Map of tabId -> { page, client, title, url, favicon }
const tabs = new Map();

// --- Broadcast helpers ---
function broadcast(msgObj) {
    const msg = JSON.stringify(msgObj);
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    });
}

function broadcastTabState() {
    const tabList = Array.from(tabs.entries()).map(([id, t]) => ({
        id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        isActive: id === activeTabId
    }));
    broadcast({ type: 'tab_state', tabs: tabList });
}

// --- Send a frame to a specific client, respecting flow control ---
function sendFrameToClient(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!ws.frameInFlight) {
        ws.frameInFlight = true;
        ws.send(JSON.stringify({ type: 'frame', data }));
    } else {
        ws.lastFrameData = data; // Keep only the latest pending frame
    }
}

// --- Tab Management ---
async function createTab(targetUrl = 'https://www.google.com') {
    const tabId = 'tab_' + (++tabCounter);
    const page = await context.newPage();

    if (adblocker) {
        await adblocker.enableBlockingInPage(page);
    }

    const client = await page.context().newCDPSession(page);
    await client.send('Page.enable');

    tabs.set(tabId, { page, client, title: 'New Tab', url: targetUrl, favicon: '' });

    // Update tab state on navigation
    page.on('framenavigated', async (frame) => {
        if (frame !== page.mainFrame()) return;
        const t = tabs.get(tabId);
        if (!t || page.isClosed()) return;

        t.url = frame.url();

        // Fetch title and favicon non-blocking
        page.title().then(title => { t.title = title || 'New Tab'; }).catch(() => {});
        page.evaluate(() => {
            const icon = document.querySelector("link[rel~='icon'], link[rel='shortcut icon']");
            return icon ? icon.href : (window.location.origin + '/favicon.ico');
        }).then(fav => { t.favicon = fav || ''; }).catch(() => {}).finally(() => {
            broadcastTabState();
            if (tabId === activeTabId) {
                broadcast({ type: 'url_changed', url: t.url });
            }
        });
    });

    // Stream frames to connected clients
    client.on('Page.screencastFrame', (frame) => {
        if (tabId !== activeTabId) return;
        const { data, sessionId } = frame;
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

        wss.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                sendFrameToClient(ws, data);
            }
        });
    });

    // Navigate without blocking — we'll stream frames as they come
    page.goto(targetUrl).catch(e => console.log(`[Tab ${tabId}] Navigation error: ${e.message}`));
    return tabId;
}

async function switchTab(tabId) {
    if (!tabs.has(tabId)) return;

    // Stop screencast on previous active tab
    if (activeTabId && tabs.has(activeTabId) && activeTabId !== tabId) {
        tabs.get(activeTabId).client.send('Page.stopScreencast').catch(() => {});
    }

    activeTabId = tabId;
    const t = tabs.get(tabId);

    broadcastTabState();
    broadcast({ type: 'url_changed', url: t.url });

    // Reset frame flow control for all clients on tab switch
    wss.clients.forEach(ws => {
        ws.frameInFlight = false;
        ws.lastFrameData = null;
    });

    await t.client.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 }).catch(() => {});
}

async function closeTab(tabId) {
    if (!tabs.has(tabId)) return;
    const t = tabs.get(tabId);
    t.client.send('Page.stopScreencast').catch(() => {});
    await t.page.close().catch(() => {});
    tabs.delete(tabId);

    if (activeTabId === tabId) {
        if (tabs.size > 0) {
            const lastTabId = Array.from(tabs.keys()).pop();
            await switchTab(lastTabId);
        } else {
            activeTabId = null;
            broadcastTabState();
            const newTabId = await createTab();
            await switchTab(newTabId);
        }
    } else {
        broadcastTabState();
    }
}

// --- Browser Lifecycle ---
async function startBrowser() {
    if (context || browserStarting) return;
    browserStarting = true;

    const userDataDir = path.join(__dirname, 'browser_data');
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
    }

    console.log('Initializing Adblocker Engine...');
    adblocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).catch(e => {
        console.error('Failed to load adblocker lists:', e.message);
        return null;
    });

    console.log('Launching persistent browser context...');
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,720'
        ]
    });

    // Cursor sync: listen to computed cursor style changes in pages
    await context.exposeBinding('reportCursor', (source, cursor) => {
        if (source.page.isClosed()) return;
        const tab = Array.from(tabs.values()).find(t => t.page === source.page);
        if (tab && activeTabId && tabs.get(activeTabId) === tab) {
            broadcast({ type: 'cursor', cursor });
        }
    });

    await context.addInitScript(() => {
        document.addEventListener('mouseover', (e) => {
            try {
                const style = window.getComputedStyle(e.target).cursor;
                window.reportCursor(style);
            } catch (_) {}
        }, true);
    });

    // Close any blank pages opened by persistent context on startup
    for (const p of context.pages()) {
        await p.close().catch(() => {});
    }

    browserStarting = false;
    console.log('Browser context ready.');
}

// Pre-start browser at server boot so first connection is instant
startBrowser().then(async () => {
    const initialTabId = await createTab();
    await switchTab(initialTabId);
}).catch(err => console.error('Failed to pre-start browser:', err));

// --- WebSocket Connection Handler ---
wss.on('connection', async (ws) => {
    console.log('Client connected');
    ws.frameInFlight = false;
    ws.lastFrameData = null;

    // Wait for browser to be ready if it's still starting
    let waited = 0;
    while (browserStarting && waited < 30000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
    }

    if (!context) {
        // Fallback: start browser if pre-start somehow failed
        await startBrowser().catch(err => console.error('startBrowser failed:', err));
    }

    if (tabs.size === 0) {
        const initialTabId = await createTab();
        await switchTab(initialTabId);
    } else {
        // Send current state to new connecting client
        broadcastTabState();
        if (activeTabId && tabs.has(activeTabId)) {
            const t = tabs.get(activeTabId);
            ws.send(JSON.stringify({ type: 'url_changed', url: t.url }));
            // Start screencast for this new client
            await t.client.send('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 }).catch(() => {});
        }
    }

    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);

            // Flow control: client signals it rendered the last frame
            if (msg.type === 'frame_ack') {
                ws.frameInFlight = false;
                if (ws.lastFrameData) {
                    const data = ws.lastFrameData;
                    ws.lastFrameData = null;
                    sendFrameToClient(ws, data);
                }
                return;
            }

            // Tab management
            if (msg.type === 'new_tab') {
                const newTabId = await createTab(msg.url || 'https://www.google.com');
                await switchTab(newTabId);
                return;
            }
            if (msg.type === 'switch_tab') {
                await switchTab(msg.tabId);
                return;
            }
            if (msg.type === 'close_tab') {
                await closeTab(msg.tabId);
                return;
            }

            // Input — routed to active tab's page
            if (!activeTabId || !tabs.has(activeTabId)) return;
            const activePage = tabs.get(activeTabId).page;
            if (activePage.isClosed()) return;

            switch (msg.type) {
                case 'mousemove':
                    activePage.mouse.move(msg.x, msg.y).catch(() => {});
                    break;
                case 'mousedown':
                    activePage.mouse.down({ button: msg.button || 'left' }).catch(() => {});
                    break;
                case 'mouseup':
                    activePage.mouse.up({ button: msg.button || 'left' }).catch(() => {});
                    break;
                case 'keydown':
                    // Press modifiers first, then the key
                    if (msg.modifiers && msg.modifiers.length > 0) {
                        for (const mod of msg.modifiers) {
                            await activePage.keyboard.down(mod).catch(() => {});
                        }
                    }
                    await activePage.keyboard.down(msg.key).catch(() => {});
                    break;
                case 'keyup':
                    // Release the key first, then modifiers
                    await activePage.keyboard.up(msg.key).catch(() => {});
                    if (msg.modifiers && msg.modifiers.length > 0) {
                        for (const mod of msg.modifiers) {
                            await activePage.keyboard.up(mod).catch(() => {});
                        }
                    }
                    break;
                case 'wheel':
                    activePage.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0).catch(() => {});
                    break;
                case 'goto': {
                    if (!msg.url) break;
                    let finalUrl = msg.url.trim();
                    // Normalize URL
                    if (!/^https?:\/\//i.test(finalUrl)) {
                        // Check if it looks like a search query or a domain
                        const looksLikeDomain = /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(finalUrl)
                            || finalUrl.startsWith('localhost');
                        finalUrl = looksLikeDomain
                            ? 'https://' + finalUrl
                            : 'https://www.google.com/search?q=' + encodeURIComponent(finalUrl);
                    }
                    // Navigate without awaiting — keeps the WS message handler responsive
                    activePage.goto(finalUrl).catch(e => console.log(`Navigation error: ${e.message}`));
                    break;
                }
                case 'type':
                    activePage.keyboard.type(msg.text).catch(() => {});
                    break;
            }
        } catch (err) {
            console.error('Error handling WebSocket message:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Virtual Browser listening on 0.0.0.0:${port}`);
});
