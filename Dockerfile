# syntax=docker/dockerfile:1.6
FROM mcr.microsoft.com/playwright/python:v1.55.0-jammy

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=6060 \
    BASE_DIR=/app

WORKDIR /app

# Install system packages required for Node.js (Playwright Python image
# ships without npm). Use the NodeSource repo to get a modern Node 18
# build compatible with Playwright 1.55.0 tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_18.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first to leverage Docker layer caching
COPY requirements.txt ./
RUN if [ -f requirements.txt ]; then pip install -r requirements.txt; fi

# Install Node dependencies (Playwright CLI present via npm)
COPY package.json package-lock.json ./
RUN npm ci && npx playwright@1.55.0 install chromium

# Copy application source
COPY . .

EXPOSE 6060

CMD ["python", "proxy_server.py"]
