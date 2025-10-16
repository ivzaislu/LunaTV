# syntax=docker/dockerfile:1.6
FROM mcr.microsoft.com/playwright/python:v1.55.0-jammy

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=6060 \
    BASE_DIR=/app

WORKDIR /app

# Install Python dependencies first to leverage Docker layer caching
COPY requirements.txt ./
RUN if [ -f requirements.txt ]; then pip install -r requirements.txt; fi

# Install Node dependencies (Playwright already present in base image)
COPY package.json package-lock.json ./
RUN npm ci && npx playwright@1.55.0 install chromium

# Copy application source
COPY . .

EXPOSE 6060

CMD ["python", "proxy_server.py"]
