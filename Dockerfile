FROM node:20-slim

# Install Chrome runtime dependencies.
# node:20-slim is Debian Bookworm where these package names are correct.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxfixes3 \
    libxshmfence1 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Skip the puppeteer postinstall download (we do it explicitly below)
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Download Puppeteer's own Chrome into ~/.cache/puppeteer
RUN npx puppeteer browsers install chrome

COPY . .

RUN npm run build

CMD ["npm", "start"]
