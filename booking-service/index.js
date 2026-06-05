/**
 * AeroLink – Flight Booking Service
 * Port: 3001
 * Updated for AWS Aurora PostgreSQL (with local SQLite fallback)
 */
const express = require('express');
const app     = express();
const http = require('http');
const PORT    = 3001;
app.use(express.json());

const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'AeroLinkSecureKey2026!';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized: Missing Token' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Unauthorized: Invalid Token' });
        req.user = user;
        next();
    });
}

const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'AeroLink API',
            version: '1.0.0',
            description: 'AeroLink Global Airline Platform API Documentation',
        },
        servers: [ { url: '/' } ],
    },
    apis: ['./index.js'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/flights/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const USE_POSTGRES = !!process.env.DB_HOST;

let db;
let pool;

if (USE_POSTGRES) {
    const { Pool } = require('pg');
    pool = new Pool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 5432,
    });
} else {
    const sqlite3 = require('sqlite3').verbose();
    db = new sqlite3.Database(':memory:');
}

const dbReady = new Promise(async (resolve, reject) => {
    if (USE_POSTGRES) {
        try {
            await pool.query(`CREATE TABLE IF NOT EXISTS flights (
                id              SERIAL PRIMARY KEY,
                flight_id       VARCHAR(255) UNIQUE NOT NULL,
                flight_number   VARCHAR(255) NOT NULL,
                airline         VARCHAR(255) DEFAULT 'AeroLink',
                origin          VARCHAR(255) NOT NULL,
                destination     VARCHAR(255) NOT NULL,
                available_seats INTEGER NOT NULL,
                total_seats     INTEGER NOT NULL,
                departure_time  VARCHAR(255),
                arrival_time    VARCHAR(255),
                price           NUMERIC DEFAULT 0,
                status          VARCHAR(255) DEFAULT 'Scheduled'
            )`);
            
            await pool.query(`CREATE TABLE IF NOT EXISTS bookings (
                id              SERIAL PRIMARY KEY,
                booking_ref     VARCHAR(255) UNIQUE,
                flight_id       VARCHAR(255) NOT NULL,
                user_name       VARCHAR(255) NOT NULL,
                seats_booked    INTEGER DEFAULT 1,
                payment_status  VARCHAR(255) DEFAULT 'pending',
                payment_method  VARCHAR(255),
                transaction_ref VARCHAR(255),
                status          VARCHAR(255) DEFAULT 'Confirmed',
                booked_at       VARCHAR(255) NOT NULL
            )`);
            resolve();
        } catch (err) {
            console.error("Postgres initialization error", err);
            reject(err);
        }
    } else {
        db.serialize(() => {
            db.run(`CREATE TABLE flights (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                flight_id       TEXT UNIQUE NOT NULL,
                flight_number   TEXT NOT NULL,
                airline         TEXT DEFAULT 'AeroLink',
                origin          TEXT NOT NULL,
                destination     TEXT NOT NULL,
                available_seats INTEGER NOT NULL,
                total_seats     INTEGER NOT NULL,
                departure_time  TEXT,
                arrival_time    TEXT,
                price           REAL DEFAULT 0,
                status          TEXT DEFAULT 'Scheduled'
            )`);

            db.run(`CREATE TABLE bookings (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                booking_ref     TEXT UNIQUE,
                flight_id       TEXT NOT NULL,
                user_name       TEXT NOT NULL,
                seats_booked    INTEGER DEFAULT 1,
                payment_status  TEXT DEFAULT 'pending',
                payment_method  TEXT,
                transaction_ref TEXT,
                status          TEXT DEFAULT 'Confirmed',
                booked_at       TEXT NOT NULL
            )`);

            const flights = [
                ['AL-101', 'AL101', 'AeroLink', 'Colombo (CMB)', 'London (LHR)',    148, 150, '2026-06-01T08:00:00Z', '2026-06-01T21:00:00Z', 450.00, 'Scheduled'],
                ['AL-202', 'AL202', 'AeroLink', 'London (LHR)',  'New York (JFK)',   200, 200, '2026-06-02T10:00:00Z', '2026-06-02T17:00:00Z', 620.00, 'Scheduled'],
                ['AL-303', 'AL303', 'AeroLink', 'Dubai (DXB)',   'Colombo (CMB)',     10, 180, '2026-06-01T14:00:00Z', '2026-06-01T19:30:00Z', 280.00, 'Scheduled'],
                ['AL-404', 'AL404', 'AeroLink', 'London (LHR)',  'Dubai (DXB)',       85, 150, '2026-06-03T06:30:00Z', '2026-06-03T14:30:00Z', 380.00, 'Scheduled'],
                ['AL-505', 'AL505', 'AeroLink', 'New York (JFK)','Colombo (CMB)',     50, 200, '2026-06-04T22:00:00Z', '2026-06-05T18:00:00Z', 890.00, 'Delayed'  ],
            ];
            const stmt = db.prepare('INSERT INTO flights (flight_id,flight_number,airline,origin,destination,available_seats,total_seats,departure_time,arrival_time,price,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
            flights.forEach(f => stmt.run(...f));
            stmt.finalize(resolve);
        });
    }
});

function rowToFlight(r) {
    return {
        id:              r.id,
        flight_id:       r.flight_id,
        flight_number:   r.flight_number,
        airline:         r.airline,
        origin:          r.origin,
        destination:     r.destination,
        available_seats: r.available_seats,
        total_seats:     r.total_seats,
        departure_time:  r.departure_time,
        arrival_time:    r.arrival_time,
        price:           Number(r.price),
        status:          r.status,
        flightId:        r.flight_id,
        flightNumber:    r.flight_number,
        from:            r.origin,
        to:              r.destination,
        availableSeats:  r.available_seats,
        totalSeats:      r.total_seats,
        departureTime:   r.departure_time,
        arrivalTime:     r.arrival_time,
    };
}

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check
 *     description: Returns the health status of the booking service.
 *     responses:
 *       200:
 *         description: Service is healthy.
 */
app.get('/api/health', (req, res) => res.json({ service: 'booking-service', status: 'healthy', database: USE_POSTGRES ? 'Aurora PostgreSQL' : 'SQLite In-Memory', timestamp: new Date().toISOString() }));

// ── Flights ──────────────────────────────────────────────────────────────────
/**
 * @swagger
 * /api/flights:
 *   get:
 *     summary: Retrieve a list of flights
 *     description: Retrieve a list of available flights from AeroLink.
 *     responses:
 *       200:
 *         description: A list of flights.
 */
app.get('/api/flights', async (req, res) => {
    try {
        if (USE_POSTGRES) {
            const { rows } = await pool.query('SELECT * FROM flights ORDER BY departure_time ASC');
            res.json(rows.map(rowToFlight));
        } else {
            db.all('SELECT * FROM flights ORDER BY departure_time ASC', [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json(rows.map(rowToFlight));
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/flights:
 *   post:
 *     summary: Add a new flight
 *     description: Create a new flight in the AeroLink system.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               flightNumber:
 *                 type: string
 *               from:
 *                 type: string
 *               to:
 *                 type: string
 *               totalSeats:
 *                 type: integer
 *               departureTime:
 *                 type: string
 *               arrivalTime:
 *                 type: string
 *               price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Flight added successfully.
 */
app.post('/api/flights', async (req, res) => {
    try {
        const { flightNumber, from, to, availableSeats, totalSeats, departureTime, arrivalTime, price, status } = req.body;
        const flightId = req.body.flightId || `AL-${Math.floor(Math.random() * 900 + 100)}`;
        const aSeats = availableSeats || totalSeats || 100;
        const tSeats = totalSeats || 100;
        
        if (USE_POSTGRES) {
            await pool.query(
                'INSERT INTO flights (flight_id, flight_number, airline, origin, destination, available_seats, total_seats, departure_time, arrival_time, price, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
                [flightId, flightNumber, 'AeroLink', from, to, aSeats, tSeats, departureTime, arrivalTime, price, status || 'Scheduled']
            );
            notifyOps(req.headers.host, { flight_id: flightId, flightNumber, origin: from, destination: to, status: status || 'Scheduled' });
            res.json({ message: 'Flight added', flightId });
        } else {
            db.run(
                'INSERT INTO flights (flight_id, flight_number, airline, origin, destination, available_seats, total_seats, departure_time, arrival_time, price, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [flightId, flightNumber, 'AeroLink', from, to, aSeats, tSeats, departureTime, arrivalTime, price, status || 'Scheduled'],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    notifyOps(req.headers.host, { flight_id: flightId, flightNumber, origin: from, destination: to, status: status || 'Scheduled' });
                    res.json({ message: 'Flight added', flightId });
                }
            );
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function notifyOps(host, flightData) {
    try {
        const body = JSON.stringify(flightData);
        const req = http.request({
            hostname: host ? host.split(':')[0] : 'localhost',
            port: host && host.includes(':') ? host.split(':')[1] : 80,
            path: '/api/flights/schedule-sync',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        });
        req.on('error', () => {});
        req.write(body);
        req.end();
    } catch(e) {}
}

function notifyOpsDelete(host, flightId) {
    try {
        const req = http.request({
            hostname: host ? host.split(':')[0] : 'localhost',
            port: host && host.includes(':') ? host.split(':')[1] : 80,
            path: `/api/flights/schedule-sync/${flightId}`,
            method: 'DELETE'
        });
        req.on('error', () => {});
        req.end();
    } catch(e) {}
}

/**
 * @swagger
 * /api/flights/{id}:
 *   delete:
 *     summary: Delete a flight
 *     description: Remove a flight by its flight_id.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Flight deleted.
 */
app.delete('/api/flights/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (USE_POSTGRES) {
            await pool.query('DELETE FROM flights WHERE flight_id = $1', [id]);
            notifyOpsDelete(req.headers.host, id);
            res.json({ message: 'Flight deleted' });
        } else {
            db.run('DELETE FROM flights WHERE flight_id = ?', [id], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                notifyOpsDelete(req.headers.host, id);
                res.json({ message: 'Flight deleted' });
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bookings/flights:
 *   get:
 *     summary: Get flights for booking
 *     description: Returns a list of flights available for booking.
 *     responses:
 *       200:
 *         description: A list of flights.
 */
app.get('/api/bookings/flights', async (req, res) => {
    try {
        if (USE_POSTGRES) {
            const { rows } = await pool.query('SELECT * FROM flights ORDER BY departure_time ASC');
            res.json({ source: 'Aurora PostgreSQL', count: rows.length, data: rows.map(rowToFlight) });
        } else {
            db.all('SELECT * FROM flights ORDER BY departure_time ASC', [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ source: 'SQLite Local', count: rows.length, data: rows.map(rowToFlight) });
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bookings/reserve:
 *   post:
 *     summary: Reserve a flight
 *     description: Create a new booking for a passenger on a specific flight.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               flightId:
 *                 type: string
 *               passengerName:
 *                 type: string
 *               email:
 *                 type: string
 *               paymentMethod:
 *                 type: string
 *     responses:
 *       201:
 *         description: Booking confirmed.
 *       400:
 *         description: Missing fields or flight full.
 *       404:
 *         description: Flight not found.
 */
app.post('/api/bookings/reserve', authenticateToken, async (req, res) => {
    try {
        const { flightId, passengerName, paymentMethod, email, seatClass } = req.body;
        if (!flightId || (!passengerName && !email)) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const bookingRef = 'BK-' + Math.floor(Math.random() * 90000 + 10000);
        const bookedAt = new Date().toISOString();

        if (USE_POSTGRES) {
            const { rows: flightRows } = await pool.query('SELECT * FROM flights WHERE flight_id = $1', [flightId]);
            if (flightRows.length === 0) return res.status(404).json({ error: 'Flight not found' });
            if (flightRows[0].available_seats <= 0) return res.status(400).json({ error: 'Flight full' });

            await pool.query(
                'INSERT INTO bookings (booking_ref, flight_id, user_name, payment_method, booked_at) VALUES ($1, $2, $3, $4, $5)',
                [bookingRef, flightId, passengerName || email, paymentMethod, bookedAt]
            );
            await pool.query(
                'UPDATE flights SET available_seats = available_seats - 1 WHERE flight_id = $1 AND available_seats > 0',
                [flightId]
            );
            res.status(201).json({ message: 'Booking confirmed', bookingId: bookingRef, seatAssigned: 1, passengerName: passengerName || email, flightId });
        } else {
            db.get('SELECT * FROM flights WHERE flight_id = ?', [flightId], (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Flight not found' });
                if (row.available_seats <= 0) return res.status(400).json({ error: 'Flight full' });

                db.run(
                    'INSERT INTO bookings (booking_ref, flight_id, user_name, payment_method, booked_at) VALUES (?, ?, ?, ?, ?)',
                    [bookingRef, flightId, passengerName || email, paymentMethod, bookedAt],
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });
                        db.run('UPDATE flights SET available_seats = available_seats - 1 WHERE flight_id = ? AND available_seats > 0', [flightId], function(err2) {
                            if (err2) return res.status(500).json({ error: err2.message });
                            res.status(201).json({ message: 'Booking confirmed', bookingId: bookingRef, seatAssigned: 1, passengerName: passengerName || email, flightId });
                        });
                    }
                );
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bookings/all:
 *   get:
 *     summary: Get all bookings
 *     description: Retrieve all bookings made in the system.
 *     responses:
 *       200:
 *         description: A list of bookings.
 */
app.get('/api/bookings/all', authenticateToken, async (req, res) => {
    try {
        if (USE_POSTGRES) {
            const { rows } = await pool.query('SELECT * FROM bookings');
            res.json({ data: rows.map(r => ({ ...r, booking_id: r.booking_ref, passenger_name: r.user_name })) });
        } else {
            db.all('SELECT * FROM bookings', [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ data: rows.map(r => ({ ...r, booking_id: r.booking_ref, passenger_name: r.user_name })) });
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bookings/{id}:
 *   get:
 *     summary: Get a specific booking
 *     description: Retrieve booking details by booking reference.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Booking details.
 *       404:
 *         description: Booking not found.
 */
app.get('/api/bookings/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (USE_POSTGRES) {
            const { rows } = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [id]);
            if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
            const r = rows[0];
            res.json({ data: { ...r, booking_id: r.booking_ref, passenger_name: r.user_name } });
        } else {
            db.get('SELECT * FROM bookings WHERE booking_ref = ?', [id], (err, r) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!r) return res.status(404).json({ error: 'Not found' });
                res.json({ data: { ...r, booking_id: r.booking_ref, passenger_name: r.user_name } });
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/bookings/flights/{flightId}/status:
 *   patch:
 *     summary: Update flight status
 *     description: Update the status of a flight.
 *     parameters:
 *       - in: path
 *         name: flightId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated.
 */
app.patch('/api/bookings/flights/:flightId/status', async (req, res) => {
    try {
        const { flightId } = req.params;
        const { status, gate } = req.body;
        
        if (USE_POSTGRES) {
            await pool.query('UPDATE flights SET status = $1 WHERE flight_id = $2', [status, flightId]);
            res.json({ message: 'Status updated' });
        } else {
            db.run('UPDATE flights SET status = ? WHERE flight_id = ?', [status, flightId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'Status updated' });
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

if (require.main === module) {
    dbReady.then(() => app.listen(PORT, () =>
        console.log(JSON.stringify({ level: 'INFO', service: 'booking-service', port: PORT, status: 'started', database: USE_POSTGRES ? 'Aurora PostgreSQL' : 'SQLite' }))
    ));
}
module.exports = { app, dbReady };