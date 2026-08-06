const express = require('express');
const { chromium } = require('playwright');
const WebSocket = require('ws');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const url = require('url');

const app = express();
const port = process.env.PORT || 3000;
const PASSWORD = process.env.PASSWORD || 'password123'; // Default password

// Store active session tokens
const validTokens = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Endpoint
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === PASSWORD) {
        // Generate a random token
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.add(token);
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade manually to check authentication
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

let browser, page, client;

async function startBrowser() {
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1280,720'
        ]
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1
    });
    page = await context.newPage();
    
    // Create CDP Session for screencast
    client = await page.context().newCDPSession(page);
    await client.send('Page.enable');
    
    // Go to a default page
    await page.goto('https://www.google.com');

    // Handle screencast frames
    client.on('Page.screencastFrame', (frame) => {
        const { data, sessionId } = frame;
        // Acknowledge the frame to receive the next one
        client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        
        // Broadcast the frame to all connected WebSocket clients
        wss.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'frame', data }));
            }
        });
    });

    console.log('Browser started successfully.');
}

wss.on('connection', async (ws) => {
    console.log('Client connected securely');
    
    if (!page) {
        await startBrowser();
    }
    
    // Start screencast for this client (or ensure it's running)
    await client.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 80,
        everyNthFrame: 1
    });

    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);
            if (!page) return;

            switch (msg.type) {
                case 'mousemove':
                    await page.mouse.move(msg.x, msg.y);
                    break;
                case 'mousedown':
                    await page.mouse.down({ button: msg.button });
                    break;
                case 'mouseup':
                    await page.mouse.up({ button: msg.button });
                    break;
                case 'keydown':
                    // Map special modifiers if passed
                    if (msg.modifiers) {
                        for (const mod of msg.modifiers) {
                            await page.keyboard.down(mod);
                        }
                    }
                    await page.keyboard.down(msg.key);
                    break;
                case 'keyup':
                    await page.keyboard.up(msg.key);
                    if (msg.modifiers) {
                        for (const mod of msg.modifiers) {
                            await page.keyboard.up(mod);
                        }
                    }
                    break;
                case 'wheel':
                    await page.mouse.wheel(msg.deltaX, msg.deltaY);
                    break;
                case 'goto':
                    if (msg.url) {
                        let finalUrl = msg.url;
                        if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
                            finalUrl = 'http://' + finalUrl;
                        }
                        await page.goto(finalUrl);
                    }
                    break;
                case 'type':
                    // Direct typing for characters that might not map 1:1 with down/up
                    await page.keyboard.type(msg.text);
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
