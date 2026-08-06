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

// Browser State
let context = null;
let adblocker = null;
let activeTabId = null;
let tabCounter = 0;

// Map of tabId -> { page, client, title, url }
const tabs = new Map(); 

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

async function createTab(targetUrl = 'https://www.google.com') {
    const tabId = 'tab_' + (++tabCounter);
    const page = await context.newPage();
    
    if (adblocker) {
        await adblocker.enableBlockingInPage(page);
    }

    const client = await page.context().newCDPSession(page);
    await client.send('Page.enable');

    tabs.set(tabId, { page, client, title: 'New Tab', url: targetUrl, favicon: '' });
    
    // Page events
    page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
            const t = tabs.get(tabId);
            if (t) {
                t.url = frame.url();
                try {
                    t.title = await page.title();
                    t.favicon = await page.evaluate(() => {
                        const icon = document.querySelector("link[rel~='icon']");
                        return icon ? icon.href : new URL(window.location.href).origin + '/favicon.ico';
                    });
                } catch(e) {
                    t.title = 'Loading...';
                }
                
                broadcastTabState();
                if (tabId === activeTabId) {
                    broadcast({ type: 'url_changed', url: t.url });
                }
            }
        }
    });

    client.on('Page.screencastFrame', (frame) => {
        if (tabId !== activeTabId) return; // Ignore frames from inactive tabs
        const { data, sessionId } = frame;
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        broadcast({ type: 'frame', data });
    });

    await page.goto(targetUrl);
    return tabId;
}

async function switchTab(tabId) {
    if (!tabs.has(tabId)) return;
    
    // Stop screencast on old tab
    if (activeTabId && tabs.has(activeTabId)) {
        tabs.get(activeTabId).client.send('Page.stopScreencast').catch(() => {});
    }

    activeTabId = tabId;
    const t = tabs.get(tabId);
    
    broadcastTabState();
    broadcast({ type: 'url_changed', url: t.url });

    // Start screencast on new tab
    await t.client.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }).catch(() => {});
}

async function closeTab(tabId) {
    if (!tabs.has(tabId)) return;
    const t = tabs.get(tabId);
    await t.page.close().catch(() => {});
    tabs.delete(tabId);
    
    if (activeTabId === tabId) {
        if (tabs.size > 0) {
            // switch to the last available tab
            const lastTabId = Array.from(tabs.keys()).pop();
            await switchTab(lastTabId);
        } else {
            activeTabId = null;
            broadcastTabState();
            // Optionally close the browser or open a new blank tab
            await createTab();
            const newTabId = Array.from(tabs.keys()).pop();
            await switchTab(newTabId);
        }
    } else {
        broadcastTabState();
    }
}

async function startBrowser() {
    const userDataDir = path.join(__dirname, 'browser_data');
    if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir);
    }

    // Initialize Adblocker
    console.log('Initializing Adblocker Engine...');
    adblocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch).catch(e => {
        console.error('Failed to load adblocker lists', e);
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
    
    // Cursor Sync Binding
    await context.exposeBinding('reportCursor', (source, cursor) => {
        if (source.page.isClosed()) return;
        // Only broadcast if this page is the active tab
        const tab = Array.from(tabs.values()).find(t => t.page === source.page);
        if (tab && activeTabId && tabs.get(activeTabId) === tab) {
            broadcast({ type: 'cursor', cursor });
        }
    });

    await context.addInitScript(() => {
        document.addEventListener('mouseover', (e) => {
            const style = window.getComputedStyle(e.target).cursor;
            window.reportCursor(style);
        }, true);
    });

    // Close any default blank pages launched by persistent context
    const pages = context.pages();
    for (const p of pages) {
        await p.close();
    }

    console.log('Browser context ready.');
}

wss.on('connection', async (ws) => {
    console.log('Client connected securely');
    
    if (!context) {
        await startBrowser();
    }
    
    if (tabs.size === 0) {
        const initialTabId = await createTab();
        await switchTab(initialTabId);
    } else {
        // Just send current state to new client
        broadcastTabState();
        if (activeTabId) {
            const t = tabs.get(activeTabId);
            ws.send(JSON.stringify({ type: 'url_changed', url: t.url }));
            await t.client.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 }).catch(() => {});
        }
    }

    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);
            
            // Tab Management Commands
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

            // Input commands routed to active tab
            if (!activeTabId || !tabs.has(activeTabId)) return;
            const activePage = tabs.get(activeTabId).page;

            switch (msg.type) {
                case 'mousemove':
                    await activePage.mouse.move(msg.x, msg.y);
                    break;
                case 'mousedown':
                    await activePage.mouse.down({ button: msg.button });
                    break;
                case 'mouseup':
                    await activePage.mouse.up({ button: msg.button });
                    break;
                case 'keydown':
                    if (msg.modifiers) {
                        for (const mod of msg.modifiers) await activePage.keyboard.down(mod);
                    }
                    await activePage.keyboard.down(msg.key);
                    break;
                case 'keyup':
                    await activePage.keyboard.up(msg.key);
                    if (msg.modifiers) {
                        for (const mod of msg.modifiers) await activePage.keyboard.up(mod);
                    }
                    break;
                case 'wheel':
                    await activePage.mouse.wheel(msg.deltaX, msg.deltaY);
                    break;
                case 'goto':
                    if (msg.url) {
                        let finalUrl = msg.url;
                        if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
                            finalUrl = 'http://' + finalUrl;
                        }
                        await activePage.goto(finalUrl);
                    }
                    break;
                case 'type':
                    await activePage.keyboard.type(msg.text);
                    break;
            }
        } catch (err) {
            console.error('Error handling WebSocket message:', err);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

server.listen(port, () => {
    console.log(`Secure Virtual Browser running at http://localhost:${port}`);
});
