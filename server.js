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
const PORT = parseInt(process.env.PORT || '3000', 10);
const PASSWORD = process.env.PASSWORD || 'password123';

// ---------- Global error protection ----------
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err.message, '\n', err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
});

// ---------- HTTP / Express ----------
const validTokens = new Map(); // token -> { createdAt }
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    if (password === PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.set(token, { createdAt: Date.now() });
        // Clean up tokens older than 24 hours
        for (const [t, v] of validTokens) {
            if (Date.now() - v.createdAt > 86_400_000) validTokens.delete(t);
        }
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

// ---------- WebSocket Server ----------
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

// ---------- Browser State ----------
let context = null;
let adblocker = null;
let activeTabId = null;
let tabCounter = 0;
let browserStarting = false;
let browserReady = false;

/** @type {Map<string, {page, client, title: string, url: string, favicon: string}>} */
const tabs = new Map();

// ---------- Helpers ----------
function connectedClients() {
    return [...wss.clients].filter(ws => ws.readyState === WebSocket.OPEN);
}

function broadcast(msgObj) {
    const msg = JSON.stringify(msgObj);
    for (const ws of connectedClients()) {
        ws.send(msg);
    }
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

/** Send a frame to one client with explicit flow control */
function sendFrameToClient(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!ws.frameInFlight) {
        ws.frameInFlight = true;
        // Convert base64 to binary buffer for 33% smaller transfer size and native browser decoding
        const buffer = Buffer.from(data, 'base64');
        ws.send(buffer);
    } else {
        ws.lastFrameData = data; // Always keep the most recent frame
    }
}

/** Check if any WS clients are watching this tab */
function hasWatchers() {
    return connectedClients().length > 0;
}

// ---------- Screencast control ----------
async function startScreencast(client) {
    await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        maxWidth: 1920,
        maxHeight: 1080,
        everyNthFrame: 1
    }).catch(() => {});
}

async function stopScreencast(client) {
    await client.send('Page.stopScreencast').catch(() => {});
}

// ---------- Tab Management ----------
async function createTab(targetUrl = 'https://www.google.com') {
    const tabId = 'tab_' + (++tabCounter);
    const page = await context.newPage();

    if (adblocker) {
        await adblocker.enableBlockingInPage(page).catch(() => {});
    }

    const client = await page.context().newCDPSession(page);
    await client.send('Page.enable');

    tabs.set(tabId, { page, client, title: 'New Tab', url: targetUrl, favicon: '' });

    // Update metadata on navigation
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        const t = tabs.get(tabId);
        if (!t || page.isClosed()) return;

        t.url = frame.url();

        // Non-blocking: fetch title then favicon, then broadcast
        page.title()
            .then(title => { if (t) t.title = title || 'New Tab'; })
            .catch(() => {})
            .then(() => page.evaluate(() => {
                const el = document.querySelector("link[rel~='icon'], link[rel='shortcut icon']");
                return el ? el.href : (location.origin + '/favicon.ico');
            }))
            .then(fav => { if (t) t.favicon = fav || ''; })
            .catch(() => {})
            .finally(() => {
                broadcastTabState();
                if (tabId === activeTabId) {
                    broadcast({ type: 'url_changed', url: t.url });
                }
            });
    });

    // Screencast frame relay
    client.on('Page.screencastFrame', ({ data, sessionId }) => {
        // Immediately ack to keep Playwright's internal frame buffer clear
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

        if (tabId !== activeTabId) return;
        if (!hasWatchers()) return;

        for (const ws of connectedClients()) {
            sendFrameToClient(ws, data);
        }
    });

    // Navigate without blocking the caller
    page.goto(targetUrl).catch(e => console.warn(`[Tab ${tabId}] nav error: ${e.message}`));
    return tabId;
}

async function switchTab(tabId) {
    if (!tabs.has(tabId)) return;

    // Stop screencast on old tab
    if (activeTabId && tabs.has(activeTabId) && activeTabId !== tabId) {
        await stopScreencast(tabs.get(activeTabId).client);
    }

    activeTabId = tabId;
    const t = tabs.get(tabId);

    // Reset all client flow-control state before new screencast starts
    for (const ws of connectedClients()) {
        ws.frameInFlight = false;
        ws.lastFrameData = null;
    }

    broadcastTabState();
    broadcast({ type: 'url_changed', url: t.url });

    if (hasWatchers()) {
        await startScreencast(t.client);
    }
}

async function closeTab(tabId) {
    if (!tabs.has(tabId)) return;
    const t = tabs.get(tabId);

    await stopScreencast(t.client);
    await t.page.close().catch(() => {});
    tabs.delete(tabId);

    if (activeTabId === tabId) {
        if (tabs.size > 0) {
            await switchTab(Array.from(tabs.keys()).pop());
        } else {
            activeTabId = null;
            broadcastTabState();
            const newId = await createTab();
            await switchTab(newId);
        }
    } else {
        broadcastTabState();
    }
}

// ---------- Browser Lifecycle ----------
async function startBrowser() {
    if (browserReady || browserStarting) return;
    browserStarting = true;

    try {
        const userDataDir = path.join(__dirname, 'browser_data');
        fs.mkdirSync(userDataDir, { recursive: true });

        // FIX: Remove Chromium's singleton lock if left from a crash
        // Without this, Chromium refuses to launch after a container restart
        // Note: SingletonLock is a symlink on Linux and fs.existsSync returns false for broken symlinks.
        // We must attempt to unlink directly.
        for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            const lockPath = path.join(userDataDir, lockFile);
            try {
                fs.unlinkSync(lockPath);
                console.log(`[*] Removed stale lock: ${lockFile}`);
            } catch (_) {}
        }

        // Adblocker — cached to disk so restarts are instant
        console.log('[*] Loading adblocker engine...');
        const cachePath = path.join(userDataDir, 'adblocker.bin');
        adblocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch, {
            path: cachePath,
            read: async (p) => fs.promises.readFile(p),
            write: async (p, content) => fs.promises.writeFile(p, content)
        }).catch(e => {
            console.warn('[!] Adblocker failed to load:', e.message);
            return null;
        });

        console.log('[*] Launching Chromium...');
        context = await chromium.launchPersistentContext(userDataDir, {
            headless: true,
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--window-size=1920,1080',
                '--force-device-scale-factor=1',
                // Improve text rendering in headless software mode
                '--enable-font-antialiasing',
                '--disable-lcd-text'
            ]
        });

        // Cursor style sync — injected into every new page
        await context.exposeBinding('__reportCursor', (source, cursor) => {
            if (source.page.isClosed()) return;
            const tab = Array.from(tabs.values()).find(t => t.page === source.page);
            if (tab && activeTabId && tabs.get(activeTabId) === tab) {
                broadcast({ type: 'cursor', cursor });
            }
        });

        await context.addInitScript(() => {
            document.addEventListener('mouseover', (e) => {
                try {
                    window.__reportCursor(window.getComputedStyle(e.target).cursor);
                } catch (_) {}
            }, { passive: true, capture: true });
        });

        // Close any stale pages opened by the persistent context
        for (const p of context.pages()) {
            await p.close().catch(() => {});
        }

        browserReady = true;
        browserStarting = false;
        console.log('[*] Browser ready.');
    } catch (err) {
        browserStarting = false; // FIX: Always reset so retries are possible
        throw err;
    }
}

// ---------- Pre-warm at startup ----------
(async () => {
    try {
        await startBrowser();
        const tabId = await createTab();
        await switchTab(tabId);
        console.log('[*] Server fully ready and waiting for connections.');
    } catch (err) {
        console.error('[!] Pre-warm failed, will retry on first connection:', err.message);
    }
})();

// ---------- WebSocket Connection Handler ----------
wss.on('connection', async (ws) => {
    console.log('[+] Client connected');
    ws.frameInFlight = false;
    ws.lastFrameData = null;

    // Wait up to 60s for the browser to be ready (handles slow cold starts)
    let waited = 0;
    while (browserStarting && waited < 60_000) {
        await new Promise(r => setTimeout(r, 250));
        waited += 250;
    }

    if (!browserReady) {
        console.log('[*] Browser not ready, starting now...');
        try {
            await startBrowser();
        } catch (err) {
            console.error('[!] startBrowser failed:', err.message);
            ws.close(1011, 'Browser failed to start');
            return;
        }
    }

    if (tabs.size === 0) {
        const tabId = await createTab();
        await switchTab(tabId);
    } else {
        // Reconnecting client — resend full current state
        broadcastTabState();
        if (activeTabId && tabs.has(activeTabId)) {
            const t = tabs.get(activeTabId);
            ws.send(JSON.stringify({ type: 'url_changed', url: t.url }));
            await startScreencast(t.client);
        }
    }

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        try {
            // --- Flow control ---
            if (msg.type === 'frame_ack') {
                ws.frameInFlight = false;
                if (ws.lastFrameData) {
                    const data = ws.lastFrameData;
                    ws.lastFrameData = null;
                    sendFrameToClient(ws, data);
                }
                return;
            }

            // --- Tab management ---
            if (msg.type === 'new_tab') {
                const id = await createTab(msg.url || 'https://www.google.com');
                await switchTab(id);
                return;
            }
            if (msg.type === 'switch_tab') { await switchTab(msg.tabId); return; }
            if (msg.type === 'close_tab')  { await closeTab(msg.tabId);  return; }

            // --- Input routing ---
            if (!activeTabId || !tabs.has(activeTabId)) return;
            const p = tabs.get(activeTabId).page;
            if (p.isClosed()) return;

            switch (msg.type) {
                case 'mousemove':
                    p.mouse.move(msg.x, msg.y).catch(() => {});
                    break;
                case 'mousedown':
                    p.mouse.down({ button: msg.button || 'left' }).catch(() => {});
                    break;
                case 'mouseup':
                    p.mouse.up({ button: msg.button || 'left' }).catch(() => {});
                    break;

                case 'keydown': {
                    const modKeys = new Set(['Control', 'Shift', 'Alt', 'Meta']);
                    // Press modifiers (skip if the key itself is a modifier to avoid double-press)
                    if (msg.modifiers?.length) {
                        for (const mod of msg.modifiers) {
                            if (mod !== msg.key) await p.keyboard.down(mod).catch(() => {});
                        }
                    }
                    await p.keyboard.down(msg.key).catch(() => {});
                    break;
                }
                case 'keyup': {
                    // Release key first, then release modifiers
                    await p.keyboard.up(msg.key).catch(() => {});
                    if (msg.modifiers?.length) {
                        const modKeys = new Set(['Control', 'Shift', 'Alt', 'Meta']);
                        for (const mod of msg.modifiers) {
                            if (mod !== msg.key) await p.keyboard.up(mod).catch(() => {});
                        }
                    }
                    break;
                }

                case 'wheel':
                    p.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0).catch(() => {});
                    break;

                case 'goto': {
                    if (!msg.url) break;
                    let target = msg.url.trim();
                    if (!/^https?:\/\//i.test(target)) {
                        const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(target);
                        const looksLikeDomain = looksLikeIp
                            || /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(target)
                            || target.toLowerCase().startsWith('localhost')
                            || target.startsWith('127.0.0.1');

                        if (looksLikeDomain) {
                            // Local IPs and localhosts default to http://, public domains default to https://
                            const useHttp = looksLikeIp 
                                || target.toLowerCase().startsWith('localhost') 
                                || target.startsWith('127.0.0.1');
                            target = (useHttp ? 'http://' : 'https://') + target;
                        } else {
                            target = 'https://www.google.com/search?q=' + encodeURIComponent(target);
                        }
                    }
                    // Non-blocking navigation
                    p.goto(target).catch(e => console.warn(`[nav] ${e.message}`));
                    break;
                }

                case 'type':
                    p.keyboard.type(msg.text).catch(() => {});
                    break;
            }
        } catch (err) {
            console.error('[!] Message handler error:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('[-] Client disconnected');
        // If no more clients, stop wasting CPU on screencast
        if (connectedClients().length === 0 && activeTabId && tabs.has(activeTabId)) {
            stopScreencast(tabs.get(activeTabId).client);
        }
    });

    ws.on('error', (err) => {
        console.error('[!] WebSocket error:', err.message);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[*] Virtual Browser listening on 0.0.0.0:${PORT}`);
});
