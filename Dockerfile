# FINAL WORKING DOCKERFILE FOR CLOUD RUN
FROM node:20-bullseye-slim

# Install required native build packages for wrtc / @cubicleai/wrtc
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    pkg-config \
    python3 \
    git \
    libasound2 \
    libssl-dev \
    libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# COPY PACKAGE FILES
COPY package.json package-lock.json* ./  # include lockfile if available

# Install node-pre-gyp globally for wrtc native binaries
RUN npm install -g node-pre-gyp

# Install all dependencies (devDependencies needed to build native modules)
RUN npm install --no-audit --no-fund

# COPY APPLICATION SOURCE
COPY . .

# Clean up devDependencies to reduce image size
RUN npm prune --production

# Set environment variables for Cloud Run
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]















# # FINAL WORKING DOCKERFILE FOR CLOUD RUN
# FROM node:20-bullseye-slim

# # Install required native build packages for wrtc / @cubicleai/wrtc
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     build-essential \
#     pkg-config \
#     python3 \
#     git \
#     libasound2 \
#     libssl-dev \
#     libgstreamer1.0-dev \
#     libgstreamer-plugins-base1.0-dev \
#     ca-certificates \
#   && rm -rf /var/lib/apt/lists/*

# WORKDIR /app

# # ONLY COPY package.json (NO LOCKFILE)
# COPY package.json ./

# # INSTALL PRODUCTION DEPENDENCIES ONLY (NO npm ci)
# RUN npm install --omit=dev --no-audit --no-fund

# # COPY APP SOURCE
# COPY . .

# ENV NODE_ENV=production
# ENV PORT=8080

# EXPOSE 8080

# CMD ["node", "server.js"]






# # # Use Node LTS image (wrtc supports node 18/20; use a supported one)
# # FROM node:20-bullseye-slim

# # RUN apt-get update && apt-get install -y \
# #     build-essential pkg-config python3 git libasound2 libgstreamer1.0-dev \
# #     libgstreamer-plugins-base1.0-dev libssl-dev ca-certificates \
# #     && rm -rf /var/lib/apt/lists/*

# # WORKDIR /app
# # COPY package.json package-lock.json* ./
# # RUN npm ci --only=prod

# # COPY . .

# # ENV PORT=8080
# # EXPOSE 8080
# # CMD ["node", "server.js"]
