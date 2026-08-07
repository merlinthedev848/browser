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
const loginAttempts = new Map(); // ip -> { count, lockUntil }

function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

app.use(express.json({ limit: '1kb' })); // Restrict JSON payload size to prevent DoS

// Inject security headers to prevent clickjacking, MIME sniffing, and cross-site scripting
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;");
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
    const { password } = req.body || {};
    const ip = getClientIp(req);

    if (typeof password !== 'string' || password.length > 128) {
        return res.status(400).json({ success: false, error: 'Invalid payload structure' });
    }

    const attempt = loginAttempts.get(ip) || { count: 0, lockUntil: 0 };
    if (Date.now() < attempt.lockUntil) {
        const waitSec = Math.ceil((attempt.lockUntil - Date.now()) / 1000);
        return res.status(429).json({ 
            success: false, 
            error: `Too many failed attempts. Locked out for ${waitSec} seconds.` 
        });
    }

    const inputHash = crypto.createHash('sha256').update(password).digest();
    const expectedHash = crypto.createHash('sha256').update(PASSWORD).digest();
    const isMatched = crypto.timingSafeEqual(inputHash, expectedHash);

    if (isMatched) {
        loginAttempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.set(token, { createdAt: Date.now() });

        for (const [t, v] of validTokens) {
            if (Date.now() - v.createdAt > 86_400_000) validTokens.delete(t);
        }
        res.json({ success: true, token });
    } else {
        attempt.count++;
        if (attempt.count >= 5) {
            const lockoutDuration = 60_000 * Math.pow(2, attempt.count - 5);
            attempt.lockUntil = Date.now() + lockoutDuration;
        }
        loginAttempts.set(ip, attempt);

        res.status(401).json({ 
            success: false, 
            error: attempt.count >= 5 
                ? 'Invalid password. You are now temporarily locked out.' 
                : 'Invalid password' 
        });
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

// ---------- Global Browser Instance & Adblocker ----------
let browser = null;
let adblocker = null;
let browserStarting = false;
let browserReady = false;

/** Send a frame to one client with explicit flow control */
function sendFrameToClient(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!ws.frameInFlight) {
        ws.frameInFlight = true;
        const buffer = Buffer.from(data, 'base64');
        ws.send(buffer);
    } else {
        ws.lastFrameData = data;
    }
}

function sendTabState(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const tabList = Array.from(ws.tabs.entries()).map(([id, t]) => ({
        id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        isActive: id === ws.activeTabId
    }));
    ws.send(JSON.stringify({ type: 'tab_state', tabs: tabList }));
}

// ---------- Screencast Control ----------
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

// ---------- Connection-scoped Tab Management ----------
async function createTab(ws) {
    const tabId = 'tab_' + (++ws.tabCounter);
    const page = await ws.context.newPage();

    if (adblocker) {
        await adblocker.enableBlockingInPage(page).catch(() => {});
    }

    const client = await page.context().newCDPSession(page);
    await client.send('Page.enable');

    ws.tabs.set(tabId, { page, client, title: 'New Tab', url: 'about:blank', favicon: '' });

    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        const t = ws.tabs.get(tabId);
        if (!t || page.isClosed()) return;

        t.url = frame.url();

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
                sendTabState(ws);
                if (tabId === ws.activeTabId) {
                    ws.send(JSON.stringify({ type: 'url_changed', url: t.url }));
                }
            });
    });

    client.on('Page.screencastFrame', ({ data, sessionId }) => {
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        if (tabId !== ws.activeTabId) return;
        sendFrameToClient(ws, data);
    });

    return tabId;
}

async function switchTab(ws, tabId) {
    if (!ws.tabs.has(tabId)) return;

    if (ws.activeTabId && ws.tabs.has(ws.activeTabId) && ws.activeTabId !== tabId) {
        await stopScreencast(ws.tabs.get(ws.activeTabId).client);
    }

    ws.activeTabId = tabId;
    const t = ws.tabs.get(tabId);

    ws.frameInFlight = false;
    ws.lastFrameData = null;

    sendTabState(ws);
    ws.send(JSON.stringify({ type: 'url_changed', url: t.url }));

    await startScreencast(t.client);
}

async function closeTab(ws, tabId) {
    if (!ws.tabs.has(tabId)) return;
    const t = ws.tabs.get(tabId);

    await stopScreencast(t.client);
    await t.page.close().catch(() => {});
    ws.tabs.delete(tabId);

    if (ws.activeTabId === tabId) {
        if (ws.tabs.size > 0) {
            await switchTab(ws, Array.from(ws.tabs.keys()).pop());
        } else {
            ws.activeTabId = null;
            sendTabState(ws);
            const newId = await createTab(ws);
            await switchTab(ws, newId);
            const p = ws.tabs.get(newId).page;
            p.goto('https://www.google.com').catch(e => console.warn(`[nav] ${e.message}`));
        }
    } else {
        sendTabState(ws);
    }
}

// ---------- Browser Lifecycle ----------
async function startBrowser() {
    if (browserReady || browserStarting) return;
    browserStarting = true;

    try {
        console.log('[*] Loading adblocker engine...');
        const cacheDir = path.join(__dirname, 'adblocker_cache');
        fs.mkdirSync(cacheDir, { recursive: true });
        const cachePath = path.join(cacheDir, 'adblocker.bin');

        adblocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch, {
            path: cachePath,
            read: async (p) => fs.promises.readFile(p),
            write: async (p, content) => fs.promises.writeFile(p, content)
        }).catch(e => {
            console.warn('[!] Adblocker failed to load:', e.message);
            return null;
        });

        console.log('[*] Launching Chromium...');
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-accelerated-2d-canvas',
                '--enable-font-antialiasing',
                '--disable-lcd-text'
            ]
        });

        browserReady = true;
        browserStarting = false;
        console.log('[*] Browser ready.');
    } catch (err) {
        browserStarting = false;
        throw err;
    }
}

// Pre-start browser at server boot
startBrowser().catch(err => {
    console.error('[!] Pre-warm failed, will retry on first connection:', err.message);
});

// ---------- WebSocket Connection Handler ----------
wss.on('connection', async (ws) => {
    console.log('[+] Client connected');

    // Setup connection-scoped state
    ws.frameInFlight = false;
    ws.lastFrameData = null;
    ws.tabs = new Map();
    ws.activeTabId = null;
    ws.tabCounter = 0;

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

    // Create client-isolated BrowserContext
    try {
        ws.context = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1
        });

        // Set up cursor reporting binding for this client's context
        await ws.context.exposeBinding('__reportCursor', (source, cursor) => {
            if (source.page.isClosed()) return;
            const tab = Array.from(ws.tabs.values()).find(t => t.page === source.page);
            if (tab && ws.activeTabId && ws.tabs.get(ws.activeTabId) === tab) {
                ws.send(JSON.stringify({ type: 'cursor', cursor }));
            }
        });

        await ws.context.addInitScript(() => {
            document.addEventListener('mouseover', (e) => {
                try {
                    window.__reportCursor(window.getComputedStyle(e.target).cursor);
                } catch (_) {}
            }, { passive: true, capture: true });
        });
    } catch (err) {
        console.error('[!] Failed to create browser context:', err.message);
        ws.close(1011, 'Failed to initialize session');
        return;
    }

    // Initialize first tab for this connection
    const tabId = await createTab(ws);
    await switchTab(ws, tabId);
    const initialPage = ws.tabs.get(tabId).page;
    initialPage.goto('https://www.google.com').catch(e => console.warn(`[nav] ${e.message}`));

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        try {
            if (msg.type === 'frame_ack') {
                ws.frameInFlight = false;
                if (ws.lastFrameData) {
                    const data = ws.lastFrameData;
                    ws.lastFrameData = null;
                    sendFrameToClient(ws, data);
                }
                return;
            }

            if (msg.type === 'new_tab') {
                const id = await createTab(ws);
                await switchTab(ws, id);
                const p = ws.tabs.get(id).page;
                p.goto(msg.url || 'https://www.google.com').catch(e => console.warn(`[nav] ${e.message}`));
                return;
            }
            if (msg.type === 'switch_tab') { await switchTab(ws, msg.tabId); return; }
            if (msg.type === 'close_tab')  { await closeTab(ws, msg.tabId);  return; }

            if (!ws.activeTabId || !ws.tabs.has(ws.activeTabId)) return;
            const p = ws.tabs.get(ws.activeTabId).page;
            if (p.isClosed()) return;

            switch (msg.type) {
                case 'mousemove':
                    p.mouse.move(msg.x, msg.y).catch(() => {});
                    break;
                case 'mousedown':
                    console.log(`[ws] Click down at (${msg.x}, ${msg.y}) button: ${msg.button}`);
                    p.mouse.move(msg.x, msg.y).catch(() => {});
                    p.mouse.down({ button: msg.button || 'left' }).catch(() => {});
                    break;
                case 'mouseup':
                    console.log(`[ws] Click up at (${msg.x}, ${msg.y}) button: ${msg.button}`);
                    p.mouse.move(msg.x, msg.y).catch(() => {});
                    p.mouse.up({ button: msg.button || 'left' }).catch(() => {});
                    break;

                case 'keydown': {
                    if (msg.modifiers?.length) {
                        for (const mod of msg.modifiers) {
                            if (mod !== msg.key) await p.keyboard.down(mod).catch(() => {});
                        }
                    }
                    await p.keyboard.down(msg.key).catch(() => {});
                    break;
                }
                case 'keyup': {
                    await p.keyboard.up(msg.key).catch(() => {});
                    if (msg.modifiers?.length) {
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
                    console.log(`[ws] URL request: "${target}"`);
                    
                    let isAutoprepended = false;
                    if (!/^https?:\/\//i.test(target)) {
                        const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(target);
                        const looksLikeDomain = looksLikeIp
                            || /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(target)
                            || target.toLowerCase().startsWith('localhost')
                            || target.startsWith('127.0.0.1');

                        if (looksLikeDomain) {
                            const useHttp = looksLikeIp 
                                || target.toLowerCase().startsWith('localhost') 
                                || target.startsWith('127.0.0.1');
                            target = (useHttp ? 'http://' : 'https://') + target;
                            isAutoprepended = !useHttp;
                        } else {
                            target = 'https://www.google.com/search?q=' + encodeURIComponent(target);
                        }
                    }
                    console.log(`[ws] Final resolved navigation target: "${target}"`);
                    
                    p.goto(target).catch(async (e) => {
                        console.warn(`[nav] ${e.message}`);
                        // If HTTPS fails and we auto-prepended it, fall back to HTTP
                        if (isAutoprepended && target.startsWith('https://')) {
                            const fallbackUrl = target.replace('https://', 'http://');
                            console.log(`[ws] HTTPS failed, trying HTTP fallback: "${fallbackUrl}"`);
                            await p.goto(fallbackUrl).catch(err => console.warn(`[nav fallback] ${err.message}`));
                        }
                    });
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

    ws.on('close', async () => {
        console.log('[-] Client disconnected');
        // Close browser context associated with this client to clear memory, history, cookies, and localstorage
        if (ws.context) {
            await ws.context.close().catch(() => {});
        }
    });

    ws.on('error', (err) => {
        console.error('[!] WebSocket error:', err.message);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[*] Virtual Browser listening on 0.0.0.0:${PORT}`);
});
