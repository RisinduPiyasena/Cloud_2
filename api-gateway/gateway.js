/**
 * AeroLink – API Gateway
 *
 * Features:
 *  - JWT Authentication + RBAC (Passenger / Staff / Admin)
 *  - Rate Limiting (express-rate-limit)
 *  - Helmet.js HTTP security headers
 *  - Circuit Breaker per downstream service
 *  - Retry logic with exponential backoff
 *  - Server-Sent Events (SSE) real-time event bus
 *  - Metrics endpoint (CloudWatch simulation)
 *  - Full Swagger / OpenAPI documentation
 *
 * Port: 3000
 */

const express    = require('express');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const axios      = require('axios');
const swaggerUi  = require('swagger-ui-express');
const swaggerDoc = require('./swagger.json');

const app   = express();
const PORT  = 3000;
const START = Date.now();

// Must match the secret used in auth-service/index.js
const JWT_SECRET = process.env.JWT_SECRET || 'AeroLinkSecureKey2026!';

// ─── Service Hosts ────────────────────────────────────────────────────────────
// All host names match Docker Compose service names so internal DNS resolves them.
const HOSTS = {
    auth:         { host: process.env.AUTH_HOST     || 'localhost', port: 4005 },
    booking:      { host: process.env.BOOKING_HOST  || 'localhost', port: 3001 },
    baggage:      { host: process.env.BAGGAGE_HOST  || 'localhost', port: 3002 },
    checkin:      { host: process.env.CHECKIN_HOST  || 'localhost', port: 3003 },
    'flight-ops': { host: process.env.FLIGHTS_HOST  || 'localhost', port: 3004 },
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] }));
app.use(express.json());

// Global rate limiter – 200 requests per minute
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Please retry in 60 seconds.' },
}));

// Stricter limiter for auth endpoints (anti-brute-force)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

// ─── Metrics Store ────────────────────────────────────────────────────────────
const metrics = {
    totalRequests: 0,
    totalErrors:   0,
    startTime:     START,
};

app.use((req, res, next) => {
    if (!req.path.startsWith('/api-docs') && !req.path.startsWith('/api/events')) {
        metrics.totalRequests++;
    }
    next();
});

// ─── SSE Event Bus ────────────────────────────────────────────────────────────
const sseClients   = [];
const recentEvents = [];

function emitEvent(event) {
    const payload = { ...event, id: Date.now() };
    recentEvents.unshift(payload);
    if (recentEvents.length > 100) recentEvents.pop();

    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try { sseClients[i].write(data); }
        catch (_) { sseClients.splice(i, 1); }
    }
}

// Keep-alive ping every 25 s to prevent proxy timeouts
setInterval(() => {
    const ping = `: ping\n\n`;
    for (let i = sseClients.length - 1; i >= 0; i--) {
        try { sseClients[i].write(ping); }
        catch (_) { sseClients.splice(i, 1); }
    }
}, 25000);

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
class CircuitBreaker {
    constructor(name, threshold = 3, timeout = 15000) {
        this.name        = name;
        this.state       = 'CLOSED';
        this.failures    = 0;
        this.threshold   = threshold;
        this.timeout     = timeout;
        this.nextAttempt = null;
    }

    canRequest() {
        if (this.state === 'CLOSED')    return true;
        if (this.state === 'HALF_OPEN') return true;
        if (Date.now() >= this.nextAttempt) {
            this.state = 'HALF_OPEN';
            console.log(`[CB] ${this.name} → HALF_OPEN`);
            return true;
        }
        return false;
    }

    onSuccess() {
        if (this.state !== 'CLOSED') console.log(`[CB] ${this.name} → CLOSED (recovered)`);
        this.failures = 0;
        this.state    = 'CLOSED';
    }

    onFailure() {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
            this.state       = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
            console.log(`[CB] ${this.name} → OPEN (retry in ${this.timeout / 1000}s)`);
        }
    }

    status() {
        return { name: this.name, state: this.state, failures: this.failures };
    }
}

const breakers = {
    booking:      new CircuitBreaker('booking-service'),
    baggage:      new CircuitBreaker('baggage-service'),
    checkin:      new CircuitBreaker('checkin-service'),
    'flight-ops': new CircuitBreaker('flight-ops-service'),
};

// ─── Proxy with Circuit Breaker + Retry ──────────────────────────────────────
async function proxyRequest(serviceKey, req, res, eventConfig = null) {
    const breaker = breakers[serviceKey];
    const svc     = HOSTS[serviceKey];

    if (!breaker.canRequest()) {
        metrics.totalErrors++;
        return res.status(503).json({
            error:      `Circuit Breaker OPEN for ${serviceKey}. Service temporarily unavailable.`,
            retryAfter: `${Math.ceil((breaker.nextAttempt - Date.now()) / 1000)}s`,
        });
    }

    const MAX_RETRIES = 2;
    let lastErr;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const url = `http://${svc.host}:${svc.port}${req.originalUrl}`;
            const axiosRes = await axios({
                method:         req.method,
                url,
                data:           req.method !== 'GET' && req.body && Object.keys(req.body).length > 0
                                    ? req.body : undefined,
                headers:        { 'content-type': 'application/json' },
                validateStatus: () => true,
                timeout:        6000,
            });

            if (axiosRes.status >= 500) {
                metrics.totalErrors++;
                breaker.onFailure();
            } else {
                breaker.onSuccess();
                if (eventConfig && axiosRes.status < 300) {
                    emitEvent({
                        type:      eventConfig.type,
                        service:   serviceKey,
                        user:      req.user?.email || req.user?.username,
                        role:      req.user?.role,
                        data:      axiosRes.data,
                        timestamp: new Date().toISOString(),
                    });
                }
            }

            return res.status(axiosRes.status).json(axiosRes.data);

        } catch (err) {
            lastErr = err;
            metrics.totalErrors++;
            breaker.onFailure();
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
            }
        }
    }

    if (!res.headersSent) {
        res.status(503).json({ error: 'Service unavailable after retries', details: lastErr?.message });
    }
}

// ─── Authentication Middleware ────────────────────────────────────────────────
// Verifies JWTs issued by auth-service. Token payload: { id, email, role }
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token      = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access Denied: No token provided' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;   // { id, email, role }
        next();
    });
}

// ─── RBAC Role Enforcement ────────────────────────────────────────────────────
// Roles from auth-service are lowercase: 'user', 'staff', 'admin'
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error:    `Forbidden: requires role ${allowedRoles.join(' or ')}`,
                yourRole: req.user?.role || 'none',
            });
        }
        next();
    };
}

// ─── Swagger ──────────────────────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - START) / 1000) });
});

// ─── Auth Routes → proxied to auth-service (port 4005) ───────────────────────
//
//  POST /api/auth/login     → http://auth-service:4005/auth/login
//  POST /api/auth/register  → http://auth-service:4005/auth/register
//  GET  /api/auth/verify    → http://auth-service:4005/auth/verify
//
//  The gateway rewrites the path: strips /api and keeps /auth/*
//
app.use('/api/auth', authLimiter, async (req, res) => {
    const { host, port } = HOSTS.auth;

    // /api/auth/login  →  /auth/login
    const targetPath = '/auth' + req.path;
    const url        = `http://${host}:${port}${targetPath}`;

    try {
        const axiosRes = await axios({
            method:         req.method,
            url,
            data:           req.method !== 'GET' && req.body && Object.keys(req.body).length > 0
                                ? req.body : undefined,
            headers:        { 'content-type': 'application/json' },
            validateStatus: () => true,
            timeout:        6000,
        });

        // Emit SSE event on successful login or register
        if (axiosRes.status < 300 && (req.path === '/login' || req.path === '/register')) {
            emitEvent({
                type:      req.path === '/login' ? 'USER_LOGGED_IN' : 'USER_REGISTERED',
                user:      axiosRes.data.email,
                role:      axiosRes.data.role,
                timestamp: new Date().toISOString(),
            });
            console.log(JSON.stringify({
                level: 'INFO',
                event: req.path === '/login' ? 'AUTH_SUCCESS' : 'AUTH_REGISTER',
                email: axiosRes.data.email,
                role:  axiosRes.data.role,
            }));
        }

        return res.status(axiosRes.status).json(axiosRes.data);

    } catch (err) {
        metrics.totalErrors++;
        return res.status(503).json({ error: 'Auth service unavailable', details: err.message });
    }
});

// ─── SSE Event Stream ─────────────────────────────────────────────────────────
app.get('/api/events/stream', (req, res) => {
    const token = req.query.token;
    if (token) {
        try { jwt.verify(token, JWT_SECRET); }
        catch (_) { return res.status(401).json({ error: 'Invalid token for SSE' }); }
    }

    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({
        type:      'STREAM_CONNECTED',
        message:   'Real-time AeroLink event stream established',
        timestamp: new Date().toISOString(),
    })}\n\n`);

    recentEvents.slice(0, 5).reverse().forEach(ev => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
    });

    sseClients.push(res);

    req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

// ─── Metrics Endpoint ─────────────────────────────────────────────────────────
app.get('/api/metrics', authenticateToken, (req, res) => {
    const uptime    = Math.floor((Date.now() - metrics.startTime) / 1000);
    const errorRate = metrics.totalRequests > 0
        ? ((metrics.totalErrors / metrics.totalRequests) * 100).toFixed(2)
        : '0.00';

    res.json({
        gateway: {
            total_requests: metrics.totalRequests,
            total_errors:   metrics.totalErrors,
            error_rate_pct: parseFloat(errorRate),
            uptime_seconds: uptime,
            sse_clients:    sseClients.length,
        },
        circuit_breakers: Object.values(breakers).map(b => b.status()),
        services: Object.entries(HOSTS).map(([name, cfg]) => ({
            name,
            port:          cfg.port,
            circuit_state: breakers[name]?.state || 'N/A',
        })),
        recent_events: recentEvents.slice(0, 10),
        timestamp: new Date().toISOString(),
    });
});

// ─── Booking Service ──────────────────────────────────────────────────────────
app.use('/api/bookings', authenticateToken, (req, res) => {
    const eventCfg = req.method === 'POST' && req.path === '/reserve'
        ? { type: 'SEAT_RESERVED' } : null;
    proxyRequest('booking', req, res, eventCfg);
});

app.use('/api/payments', authenticateToken, (req, res) => {
    proxyRequest('booking', req, res);
});

// ─── Baggage Service ──────────────────────────────────────────────────────────
app.use('/api/baggage', authenticateToken, (req, res) => {
    const isUpdate = req.method === 'POST' && req.path === '/update';
    const isPutStatus = req.method === 'PUT';
    if (isUpdate || isPutStatus) {
        return requireRole('staff', 'admin')(req, res, () => {
            proxyRequest('baggage', req, res, { type: 'BAGGAGE_STATUS_UPDATED' });
        });
    }
    proxyRequest('baggage', req, res);
});

// ─── Check-In Service ─────────────────────────────────────────────────────────
app.use('/api/checkin', authenticateToken, (req, res) => {
    const eventCfg = req.method === 'POST' ? { type: 'PASSENGER_CHECKED_IN' } : null;
    proxyRequest('checkin', req, res, eventCfg);
});
// /api/checkins alias used by Dashboard.jsx
app.use('/api/checkins', authenticateToken, (req, res) => {
    // rewrite path so checkin-service sees /api/checkin* or /api/checkins*
    proxyRequest('checkin', req, res, req.method === 'POST' ? { type: 'PASSENGER_CHECKED_IN' } : null);
});

// ─── Notifications (served by baggage-service) ────────────────────────────────
app.use('/api/notifications', authenticateToken, (req, res) => {
    proxyRequest('baggage', req, res);
});

// ─── Airport Events (served by flight-ops-service) ────────────────────────────
app.use('/api/airport', authenticateToken, (req, res) => {
    const isMutation = req.method === 'POST';
    if (isMutation) {
        return requireRole('staff', 'admin')(req, res, () => {
            proxyRequest('flight-ops', req, res, { type: 'AIRPORT_EVENT' });
        });
    }
    proxyRequest('flight-ops', req, res);
});

// ─── Flight Routes ────────────────────────────────────────────────────────────
// Flight CRUD (create/delete/update) → booking-service (has the SQLite store)
// Flight status update + schedule/pricing → flight-ops-service

// GET all flights → booking-service
app.get('/api/flights', authenticateToken, (req, res) => proxyRequest('booking', req, res));

// GET flight-ops specific routes (schedule, pricing, ops-log) → flight-ops-service
app.get('/api/flights/schedule',  authenticateToken, (req, res) => proxyRequest('flight-ops', req, res));
app.get('/api/flights/pricing',   authenticateToken, (req, res) => proxyRequest('flight-ops', req, res));
app.get('/api/flights/ops-log',   authenticateToken, (req, res) => proxyRequest('flight-ops', req, res));

// POST create flight → booking-service (staff/admin)
app.post('/api/flights', authenticateToken, requireRole('staff', 'admin'), (req, res) =>
    proxyRequest('booking', req, res, { type: 'FLIGHT_CREATED' })
);

// POST update-status → flight-ops-service (staff/admin)
app.post('/api/flights/update-status', authenticateToken, requireRole('staff', 'admin'), (req, res) =>
    proxyRequest('flight-ops', req, res, { type: 'FLIGHT_STATUS_UPDATED' })
);

// DELETE flight → booking-service (staff/admin)
app.delete('/api/flights/:id', authenticateToken, requireRole('staff', 'admin'), (req, res) =>
    proxyRequest('booking', req, res, { type: 'FLIGHT_DELETED' })
);

// PUT update flight fields → booking-service (staff/admin)
app.put('/api/flights/:id', authenticateToken, requireRole('staff', 'admin'), (req, res) =>
    proxyRequest('booking', req, res, { type: 'FLIGHT_UPDATED' })
);

// PATCH internal status sync from flight-ops → booking-service
app.patch('/api/bookings/flights/:id/status', (req, res) => proxyRequest('booking', req, res));

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({
        level:   'INFO',
        service: 'api-gateway',
        port:    PORT,
        swagger: `http://localhost:${PORT}/api-docs`,
        status:  'started',
    }));
});