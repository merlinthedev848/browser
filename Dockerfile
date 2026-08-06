# Use the official Node.js image based on Debian 12 (Bookworm - which is currently the most stable standard. Debian 13 "Trixie" is currently testing, but Bookworm packages are extremely compatible, or we can specify node:20-bookworm)
FROM node:20-bookworm

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install application dependencies
RUN npm install

# Install Playwright browsers and their OS dependencies
# Playwright provides a command to install all necessary system libraries for Chromium
RUN npx playwright install chromium --with-deps

# Copy application source code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD [ "node", "server.js" ]
