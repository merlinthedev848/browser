# Virtual Browser (BrowserBox Alternative)

A stunning, secure, and performant Remote Browser Isolation (RBI) tool built with Node.js and Playwright. 

## Features
- **Total Endpoint Isolation:** Browse safely. All code executes on the remote server.
- **Multi-Tab Support:** Open multiple pages and switch instantly.
- **Built-in Ad & Tracker Blocking:** Powered by Ghostery, saving massive bandwidth and CPU.
- **Persistent Sessions:** Remembers your logins and cookies across server restarts.
- **Stunning UI:** Glassmorphism, animations, and dark mode.
- **Full Input Passthrough:** Accurately routes complex keyboard shortcuts and modifiers.
- **Secure Authentication:** Protects the stream with session tokens.

## One-Line Quick Install (Debian/Ubuntu)

Run this single command on your fresh Debian server to automatically install dependencies, clone the repo, and start the secure browser:

```bash
curl -sSL https://raw.githubusercontent.com/merlinthedev848/browser/main/install.sh | bash
```

The script will prompt you to choose a secure password and will handle the rest!

## Manual Docker Deployment

```bash
git clone https://github.com/merlinthedev848/browser.git
cd browser
mkdir -p browser_data
docker build -t virtual-browser .
docker run -d -p 3000:3000 -e PASSWORD="my_secure_password" -v $(pwd)/browser_data:/usr/src/app/browser_data --name vbrowser virtual-browser
```

*(Note: For production use on the public internet, always run this behind a reverse proxy like Nginx or Caddy to secure the traffic with HTTPS and WSS).*
