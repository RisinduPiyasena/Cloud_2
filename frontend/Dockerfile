# ── Frontend Dockerfile ────────────────────────────────────────────────────────
# Runs the Vite dev server inside Docker so the /api proxy works correctly.
# The VITE_GATEWAY_HOST env var (set in docker-compose.yml) tells the proxy
# to forward /api/* requests to http://api-gateway:3000 (Docker DNS).
 
FROM node:20-alpine
 
WORKDIR /app
 
# Install dependencies first (layer-cached unless package.json changes)
COPY package*.json ./
RUN npm install
 
# Copy source
COPY . .
 
# Expose Vite dev server port
EXPOSE 5173
 
# Start Vite — host 0.0.0.0 is required so Docker can route traffic in
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]