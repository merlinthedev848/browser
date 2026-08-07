const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const data = JSON.stringify({ password: 'Ju3t1mprove123##' });
const options = {
  hostname: 'web.chriskendallvo.com',
  port: 443,
  path: '/api/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
};

const req = https.request(options, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const result = JSON.parse(body);
    if (!result.success) { console.log('Login failed'); return; }

    const ws = new WebSocket('wss://web.chriskendallvo.com/?token=' + result.token);
    ws.on('open', () => {
      console.log('Connected, waiting for frames...');
    });

    let jpegCount = 0;
    ws.on('message', (msg) => {
      // Check if it is a JPEG image (magic bytes FF D8)
      const isJpeg = msg instanceof Buffer && msg.length > 4 && msg[0] === 0xFF && msg[1] === 0xD8;
      
      if (isJpeg) {
        jpegCount++;
        console.log(`Received JPEG frame #${jpegCount}, size: ${msg.length} bytes`);
        ws.send(JSON.stringify({ type: 'frame_ack' }));

        if (jpegCount === 1) {
          console.log('Navigating to example.com...');
          ws.send(JSON.stringify({ type: 'goto', url: 'https://example.com' }));
        }

        if (jpegCount === 3) {
          const filename = path.join(__dirname, 'frame_example.jpg');
          fs.writeFileSync(filename, msg);
          console.log(`Saved ${filename}`);
          ws.close();
        }
      } else {
        try {
          const text = msg.toString();
          const m = JSON.parse(text);
          console.log('Received JSON message:', m.type);
        } catch(e) {
          console.log('Received raw non-JPEG message');
        }
      }
    });

    ws.on('close', () => console.log('WS closed.'));
  });
});
req.write(data);
req.end();
