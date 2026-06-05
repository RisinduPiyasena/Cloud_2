/**
 * AeroLink – Passenger Check-In Service
 * Port: 3003
 */
const express = require('express');
const http    = require('http');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

// Configure axios-retry for exponential backoff
axiosRetry(axios, { 
    retries: 3, 
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
    }
});

const app     = express();
const PORT    = 3003;
app.use(express.json());

const USE_DYNAMODB = process.env.NODE_ENV === 'production' || process.env.USE_DYNAMODB === 'true';
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dbClient);
const TABLE_NAME = process.env.DYNAMODB_CHECKIN_TABLE || 'AeroLink-Checkins';

let checkinStore = {};

const GATES     = ['A12', 'A14', 'B3', 'B7', 'C1', 'C22', 'D9', 'D14'];
const SEAT_COLS = ['A', 'B', 'C', 'D', 'E', 'F'];

function generateSeat() {
    return `${Math.floor(Math.random() * 30) + 1}${SEAT_COLS[Math.floor(Math.random() * 6)]}`;
}

function boardingTime(departureISO) {
    if (!departureISO) return null;
    const d = new Date(departureISO);
    d.setMinutes(d.getMinutes() - 45);
    return d.toISOString();
}

// ── Circuit Breaker Implementation ──────────────────────────────────────────────
class CircuitBreaker {
    constructor(name, threshold = 3, timeout = 10000) {
        this.name = name;
        this.state = 'CLOSED';
        this.failures = 0;
        this.threshold = threshold;
        this.timeout = timeout;
        this.nextAttempt = null;
    }

    async fire(requestFn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error(`Circuit Breaker OPEN for ${this.name}`);
            }
            this.state = 'HALF_OPEN';
        }

        try {
            const response = await requestFn();
            if (this.state === 'HALF_OPEN') this.state = 'CLOSED';
            this.failures = 0;
            return response;
        } catch (error) {
            this.failures++;
            if (this.failures >= this.threshold || this.state === 'HALF_OPEN') {
                this.state = 'OPEN';
                this.nextAttempt = Date.now() + this.timeout;
                console.warn(`[CB] ${this.name} flipped to OPEN`);
            }
            throw error;
        }
    }
}

const bookingBreaker = new CircuitBreaker('BookingService');
const baggageBreaker = new CircuitBreaker('BaggageService');

async function internalGet(host, port, path) {
    return bookingBreaker.fire(async () => {
        const url = `http://${host}:${port}${path}`;
        const res = await axios.get(url, { validateStatus: () => true, timeout: 5000 });
        return { status: res.status, body: res.data };
    });
}

async function internalPost(host, port, path, body) {
    return baggageBreaker.fire(async () => {
        const url = `http://${host}:${port}${path}`;
        const res = await axios.post(url, body, { validateStatus: () => true, timeout: 5000 });
        return res.data;
    });
}

const BOOKING_HOST = process.env.BOOKING_HOST || 'localhost';
const BAGGAGE_HOST = process.env.BAGGAGE_HOST || 'localhost';

app.get('/api/health', (req, res) =>
    res.json({ service: 'checkin-service', status: 'healthy', passengersCheckedIn: Object.keys(checkinStore).length, timestamp: new Date().toISOString() })
);

// ── POST /api/checkins  (Dashboard.jsx flow: select booking → check in) ───────
app.post('/api/checkins', async (req, res) => {
    const { bookingId, flightId, passengerName, baggageCount, departureTime } = req.body;
    if (!passengerName || !flightId) return res.status(400).json({ error: 'passengerName and flightId are required' });

    // Strictly verify booking exists
    let flightDeparture = departureTime || null;
    let validBooking = false;
    let resolvedBookingId = bookingId;

    try {
        const bookingPort = process.env.BOOKING_PORT || 3001;
        if (bookingId) {
            const result = await internalGet(BOOKING_HOST, bookingPort, `/api/bookings/${bookingId}`);
            if (result.status === 404) return res.status(404).json({ error: `Booking ${bookingId} not found` });
            if (result.status === 200 && result.body.data) {
                const bName = result.body.data.user_name || result.body.data.passenger_name;
                if (bName && bName.toLowerCase() !== passengerName.toLowerCase()) {
                    return res.status(400).json({ error: `Passenger name mismatch for this booking` });
                }
                validBooking = true;
                flightDeparture = flightDeparture || result.body.data.departure_time;
            }
        } else {
            const result = await internalGet(BOOKING_HOST, bookingPort, `/api/bookings/all`);
            if (result.status === 200 && result.body.data) {
                const match = result.body.data.find(b => 
                    (b.user_name?.toLowerCase() === passengerName.toLowerCase() || b.passenger_name?.toLowerCase() === passengerName.toLowerCase()) && 
                    (b.flight_id === flightId || b.flightId === flightId || b.flight_number === flightId)
                );
                if (match) {
                    validBooking = true;
                    resolvedBookingId = match.booking_id || match.booking_ref;
                    flightDeparture = flightDeparture || match.departure_time;
                }
            }
        }
    } catch (err) {
        console.error("Booking validation failed:", err.message);
    }

    if (!validBooking) {
        return res.status(404).json({ error: 'Validation failed: No valid reservation found for this passenger and flight.' });
    }

    const checkinId         = 'CHK-' + Math.floor(Math.random() * 90000 + 10000);
    const boardingPassNumber = 'BP-' + Math.floor(Math.random() * 900000 + 100000);
    const seatNumber        = generateSeat();
    const gate              = GATES[Math.floor(Math.random() * GATES.length)];
    const numBags           = Math.min(Math.max(parseInt(baggageCount) || 0, 0), 5);
    const baggageTokens     = [];

    for (let i = 0; i < numBags; i++) {
        baggageTokens.push('BAG-' + Math.floor(Math.random() * 90000 + 10000));
    }

    const record = {
        id:                checkinId,
        boardingPassNumber,
        passengerName,
        bookingId:         resolvedBookingId || null,
        flightId,
        seatNumber,
        gate,
        checkInStatus:     'Checked In',
        boardingTime:      boardingTime(flightDeparture),
        issuedAt:          new Date().toISOString(),
        baggageTokens,
    };
    if (USE_DYNAMODB) {
        await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: record }));
    } else {
        checkinStore[checkinId] = record;
    }

    // Register baggage tokens in baggage-service
    for (const token of baggageTokens) {
        try {
            const baggagePort = process.env.BAGGAGE_PORT || 3002;
            await internalPost(BAGGAGE_HOST, baggagePort, '/api/baggage/update', {
                baggageId: token, status: 'CHECK_IN_RECEIVED', location: 'Check-in desk',
                passenger: passengerName, flightId,
            });
        } catch (_) {}
    }

    console.log(JSON.stringify({ level: 'INFO', event: 'PASSENGER_CHECKED_IN', checkinId, boardingPassNumber, passengerName, flightId, seatNumber, gate, timestamp: new Date().toISOString() }));

    res.status(201).json({
        message:  'Check-In Complete',
        checkin:  record,
        // also expose as boardingPass for backward compat
        boardingPass: { checkinId, passenger: passengerName, flightId, seat: seatNumber, gate, class: 'Economy', boardingTime: boardingTime(flightDeparture), issuedAt: record.issuedAt },
        baggageManifest: { tokens: baggageTokens, pieces: numBags, initialStatus: 'CHECK_IN_RECEIVED' }
    });
});

// alias for existing code
app.post('/api/checkin/process', async (req, res) => {
    req.url = '/api/checkins';
    app.handle(req, res);
});

// ── GET /api/checkins ─────────────────────────────────────────────────────────
app.get('/api/checkins', async (req, res) => {
    if (USE_DYNAMODB) {
        try {
            const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            res.json(result.Items || []);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.json(Object.values(checkinStore).reverse());
    }
});

app.get('/api/checkin/all', async (req, res) => {
    if (USE_DYNAMODB) {
        try {
            const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            res.json({ count: (result.Items || []).length, data: result.Items || [] });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.json({ count: Object.keys(checkinStore).length, data: Object.values(checkinStore) });
    }
});

app.get('/api/checkin/status/:id', async (req, res) => {
    if (USE_DYNAMODB) {
        try {
            const result = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { id: req.params.id } }));
            if (!result.Item) return res.status(404).json({ error: `Check-in ${req.params.id} not found` });
            res.json({ data: result.Item });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        const record = checkinStore[req.params.id];
        if (!record) return res.status(404).json({ error: `Check-in ${req.params.id} not found` });
        res.json({ data: record });
    }
});

if (require.main === module) {
    app.listen(PORT, () =>
        console.log(JSON.stringify({ level: 'INFO', service: 'checkin-service', port: PORT, status: 'started' }))
    );
}
module.exports = app;