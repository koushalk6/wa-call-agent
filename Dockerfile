





# Use Node LTS image (wrtc supports node 18/20; use a supported one)
FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    build-essential pkg-config python3 git libasound2 libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=prod

COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
