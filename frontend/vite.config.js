import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When running inside Docker, the API Gateway container is reachable
// via its service name "api-gateway" on port 3000 (Docker internal DNS).
// When running locally (npm run dev outside Docker), it hits localhost:3000.
const GATEWAY_HOST = process.env.VITE_GATEWAY_HOST || 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],

  server: {
    // Bind to 0.0.0.0 so Docker can expose the port to the host machine
    host: '0.0.0.0',
    port: 5173,

    proxy: {
      // Every /api/* request from the browser is forwarded to the API Gateway.
      // This includes /api/auth, /api/bookings, /api/flights, /api/baggage,
      // /api/checkin, /api/metrics, and /api/events/stream (SSE).
      '/api': {
        target:      GATEWAY_HOST,
        changeOrigin: true,
        // Keep the /api prefix — the gateway expects it
        rewrite:     (path) => path,

        // Required for SSE (Server-Sent Events) — disable response buffering
        // so event-stream frames are forwarded to the browser immediately.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            // Pass the original host header through so JWT issuer checks pass
            proxyReq.setHeader('X-Forwarded-Host', req.headers.host || '');
          });
        },
      },
    },
  },

  // Production build output goes to dist/
  build: {
    outDir: 'dist',
  },
});