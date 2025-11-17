# Dockerfile — resilient install for Cloud Build / Cloud Run
FROM node:20-bullseye-slim AS base

# Install build tools required for native modules (wrtc / forks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    python3 \
    git \
    ca-certificates \
    curl \
    libasound2 \
    libssl-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package manifests first to leverage Docker cache
COPY package.json package-lock.json* ./

# If package-lock.json exists we use `npm ci` (reproducible).
# Otherwise fall back to `npm install --omit=dev`.
# Use --unsafe-perm for native builds if needed.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy application source
COPY . .

# Optional: set NODE_ENV for production installs / runtime
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Start the app
CMD ["node", "server.js"]







# # Use Node LTS image (wrtc supports node 18/20; use a supported one)
# FROM node:20-bullseye-slim

# RUN apt-get update && apt-get install -y \
#     build-essential pkg-config python3 git libasound2 libgstreamer1.0-dev \
#     libgstreamer-plugins-base1.0-dev libssl-dev ca-certificates \
#     && rm -rf /var/lib/apt/lists/*

# WORKDIR /app
# COPY package.json package-lock.json* ./
# RUN npm ci --only=prod

# COPY . .

# ENV PORT=8080
# EXPOSE 8080
# CMD ["node", "server.js"]
