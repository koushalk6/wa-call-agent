
# FINAL OPTIMIZED DOCKERFILE FOR CLOUD RUN
FROM node:20-bullseye-slim

# Install system dependencies for wrtc + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    pkg-config \
    git \
    libssl-dev \
    libasound2 \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    ca-certificates \
    ffmpeg \
    && npm install -g node-pre-gyp \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (cache optimization)
COPY package*.json ./

# Install dependencies
RUN npm install --no-audit --no-fund

# Copy the rest of the source code
COPY . .

# Remove devDependencies to reduce final image
RUN npm prune --production

# Runtime environment
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Ensure Cloud Run uses PORT environment variable
CMD ["node", "server.js"]

















# # FINAL OPTIMIZED DOCKERFILE FOR CLOUD RUN
# FROM node:20-bullseye-slim

# # Install system dependencies for wrtc + ffmpeg
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     build-essential \
#     python3 \
#     pkg-config \
#     git \
#     libssl-dev \
#     libasound2 \
#     libgstreamer1.0-dev \
#     libgstreamer-plugins-base1.0-dev \
#     ca-certificates \
#     ffmpeg \
#   && npm install -g node-pre-gyp \
#   && rm -rf /var/lib/apt/lists/*

# # Set working directory
# WORKDIR /app

# # Copy package files first (cache optimization)
# COPY package.json package-lock.json* ./

# # Install all dependencies (wrtc requires build tools)
# RUN npm install --no-audit --no-fund

# # Copy the rest
# COPY . .

# # Remove devDependencies to reduce final image
# RUN npm prune --production

# # Runtime environment
# ENV NODE_ENV=production
# ENV PORT=8080

# EXPOSE 8080

# CMD ["node", "server.js"]















# # # FINAL OPTIMIZED DOCKERFILE FOR CLOUD RUN
# # FROM node:20-bullseye-slim

# # # Install only required packages to build wrtc / native modules
# # RUN apt-get update && apt-get install -y --no-install-recommends \
# #     build-essential \
# #     python3 \
# #     pkg-config \
# #     git \
# #     libssl-dev \
# #     libasound2 \
# #     libgstreamer1.0-dev \
# #     libgstreamer-plugins-base1.0-dev \
# #     ca-certificates \
# #   && npm install -g node-pre-gyp \
# #   && rm -rf /var/lib/apt/lists/*

# # # Set working directory
# # WORKDIR /app

# # # Copy package files first to leverage Docker cache
# # COPY package.json package-lock.json* ./

# # # Install all dependencies including devDependencies (needed to compile native modules)
# # RUN npm install --no-audit --no-fund

# # # Copy the rest of the application source
# # COPY . .

# # # Remove devDependencies to reduce final image size
# # RUN npm prune --production

# # # Cloud Run environment variables
# # ENV NODE_ENV=production
# # ENV PORT=8080

# # EXPOSE 8080

# # # Run the app
# # CMD ["node", "server.js"]












# # # # FINAL WORKING DOCKERFILE FOR CLOUD RUN
# # # FROM node:20-bullseye-slim

# # # # Install required native build packages for wrtc / @cubicleai/wrtc
# # # RUN apt-get update && apt-get install -y --no-install-recommends \
# # #     build-essential \
# # #     pkg-config \
# # #     python3 \
# # #     git \
# # #     libasound2 \
# # #     libssl-dev \
# # #     libgstreamer1.0-dev \
# # #     libgstreamer-plugins-base1.0-dev \
# # #     ca-certificates \
# # #   && rm -rf /var/lib/apt/lists/*

# # # WORKDIR /app

# # # # COPY PACKAGE FILES
# # # COPY package.json package-lock.json* ./  # include lockfile if available

# # # # Install node-pre-gyp globally for wrtc native binaries
# # # RUN npm install -g node-pre-gyp

# # # # Install all dependencies (devDependencies needed to build native modules)
# # # RUN npm install --no-audit --no-fund

# # # # COPY APPLICATION SOURCE
# # # COPY . .

# # # # Clean up devDependencies to reduce image size
# # # RUN npm prune --production

# # # # Set environment variables for Cloud Run
# # # ENV NODE_ENV=production
# # # ENV PORT=8080

# # # EXPOSE 8080

# # # CMD ["node", "server.js"]















# # # # # FINAL WORKING DOCKERFILE FOR CLOUD RUN
# # # # FROM node:20-bullseye-slim

# # # # # Install required native build packages for wrtc / @cubicleai/wrtc
# # # # RUN apt-get update && apt-get install -y --no-install-recommends \
# # # #     build-essential \
# # # #     pkg-config \
# # # #     python3 \
# # # #     git \
# # # #     libasound2 \
# # # #     libssl-dev \
# # # #     libgstreamer1.0-dev \
# # # #     libgstreamer-plugins-base1.0-dev \
# # # #     ca-certificates \
# # # #   && rm -rf /var/lib/apt/lists/*

# # # # WORKDIR /app

# # # # # ONLY COPY package.json (NO LOCKFILE)
# # # # COPY package.json ./

# # # # # INSTALL PRODUCTION DEPENDENCIES ONLY (NO npm ci)
# # # # RUN npm install --omit=dev --no-audit --no-fund

# # # # # COPY APP SOURCE
# # # # COPY . .

# # # # ENV NODE_ENV=production
# # # # ENV PORT=8080

# # # # EXPOSE 8080

# # # # CMD ["node", "server.js"]






# # # # # # Use Node LTS image (wrtc supports node 18/20; use a supported one)
# # # # # FROM node:20-bullseye-slim

# # # # # RUN apt-get update && apt-get install -y \
# # # # #     build-essential pkg-config python3 git libasound2 libgstreamer1.0-dev \
# # # # #     libgstreamer-plugins-base1.0-dev libssl-dev ca-certificates \
# # # # #     && rm -rf /var/lib/apt/lists/*

# # # # # WORKDIR /app
# # # # # COPY package.json package-lock.json* ./
# # # # # RUN npm ci --only=prod

# # # # # COPY . .

# # # # # ENV PORT=8080
# # # # # EXPOSE 8080
# # # # # CMD ["node", "server.js"]
