/**
 * AeroLink – Flight Operations Service (NEW)
 * Manages flight schedules, dynamic pricing, and status management
 * Simulates Lambda + DynamoDB for operational events
 * Port: 3004
 */

const express = require('express');
const http    = require('http');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const PORT = 3004;

const BOOKING_HOST = process.env.BOOKING_HOST || 'localhost';

const USE_DYNAMODB = process.env.NODE_ENV === 'production' || process.env.USE_DYNAMODB === 'true';
const dbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(dbClient);
const TABLE_NAME = process.env.DYNAMODB_FLIGHTOPS_TABLE || 'AeroLink-FlightOps';

function notifyBookingService(flightId, status, gate) {
    const body = JSON.stringify({ status, gate });
    const req  = http.request({
        hostname: BOOKING_HOST, port: process.env.BOOKING_PORT || 3001,
        path: `/api/bookings/flights/${flightId}/status`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.on('error', () => {}); // fire-and-forget
    req.write(body);
    req.end();
}

app.use(express.json());

// ─── In-Memory Flight Operations Store (Fallback) ─────────────────────────────
let flightSchedule = [
    { flight_id: 'AL-101', origin: 'Colombo (CMB)', destination: 'London (LHR)', departure_time: '2026-06-01T08:00:00Z', arrival_time: '2026-06-01T21:00:00Z', duration_hrs: 10.5, aircraft: 'Boeing 787-9', status: 'ON_TIME', gate: 'A12', base_price: 450.00, total_seats: 150 },
    { flight_id: 'AL-202', origin: 'London (LHR)', destination: 'New York (JFK)', departure_time: '2026-06-02T10:00:00Z', arrival_time: '2026-06-02T17:00:00Z', duration_hrs: 7.5, aircraft: 'Airbus A350-900', status: 'ON_TIME', gate: 'B7', base_price: 620.00, total_seats: 200 },
    { flight_id: 'AL-303', origin: 'Dubai (DXB)', destination: 'Colombo (CMB)', departure_time: '2026-06-01T14:00:00Z', arrival_time: '2026-06-01T19:30:00Z', duration_hrs: 3.5, aircraft: 'Airbus A320neo', status: 'ON_TIME', gate: 'C1', base_price: 280.00, total_seats: 180 },
    { flight_id: 'AL-404', origin: 'London (LHR)', destination: 'Dubai (DXB)', departure_time: '2026-06-03T06:30:00Z', arrival_time: '2026-06-03T14:30:00Z', duration_hrs: 6.5, aircraft: 'Boeing 777-300ER', status: 'ON_TIME', gate: 'D9', base_price: 380.00, total_seats: 150 },
    { flight_id: 'AL-505', origin: 'New York (JFK)', destination: 'Colombo (CMB)', departure_time: '2026-06-04T22:00:00Z', arrival_time: '2026-06-05T18:00:00Z', duration_hrs: 17.0, aircraft: 'Boeing 777X', status: 'DELAYED', gate: 'C22', delay_reason: 'Air Traffic Control hold', delay_mins: 90, base_price: 890.00, total_seats: 200 }
];

// Seed DB if empty
async function seedDynamoDB() {
    if (!USE_DYNAMODB) return;
    try {
        const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
        if (!result.Items || result.Items.length === 0) {
            for (const f of flightSchedule) {
                // Ensure primary key matches table schema: flightId
                f.flightId = f.flight_id;
                await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: f }));
            }
            console.log("DynamoDB Seeded with flights.");
        }
    } catch(e) {
        console.error("Seed error", e);
    }
}
seedDynamoDB();

const pricingRules = [
    { tier: 'Economy Saver',   occupancy_pct_max: 40,  multiplier: 0.85,  description: 'Low demand discount' },
    { tier: 'Economy Standard',occupancy_pct_max: 70,  multiplier: 1.00,  description: 'Base fare' },
    { tier: 'Economy Flex',    occupancy_pct_max: 85,  multiplier: 1.20,  description: 'High demand premium' },
    { tier: 'Last Minute',     occupancy_pct_max: 95,  multiplier: 1.45,  description: 'Near-full surcharge' },
    { tier: 'Final Seat',      occupancy_pct_max: 100, multiplier: 1.80,  description: 'Final seat pricing' },
];

const operationsLog = [];

app.get('/api/health', (req, res) => {
    res.json({ service: 'flight-ops-service', status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/flights/schedule', async (req, res) => {
    if (USE_DYNAMODB) {
        try {
            const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            res.json({ source: 'DynamoDB', count: (result.Items||[]).length, data: result.Items||[] });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.json({ source: 'Local Memory', count: flightSchedule.length, data: flightSchedule });
    }
});

app.post('/api/flights/schedule-sync', async (req, res) => {
    try {
        const f = req.body;
        if (USE_DYNAMODB) {
            f.flightId = f.flightId || f.flight_id;
            await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: f }));
            res.json({ message: 'Flight synced to FlightOps', flightId: f.flightId });
        } else {
            flightSchedule.push(f);
            res.json({ message: 'Flight synced locally' });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/flights/schedule-sync/:flightId', async (req, res) => {
    try {
        const { flightId } = req.params;
        if (USE_DYNAMODB) {
            const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
            await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { flightId } }));
            res.json({ message: 'Flight deleted from FlightOps' });
        } else {
            flightSchedule = flightSchedule.filter(f => f.flight_id !== flightId && f.flightId !== flightId);
            res.json({ message: 'Flight deleted locally' });
        }
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/flights/pricing', async (req, res) => {
    let schedule = flightSchedule;
    if (USE_DYNAMODB) {
        try {
            const result = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            if (result.Items) schedule = result.Items;
        } catch(e) {}
    }

    const pricingData = schedule.map(flight => {
        const occupancyPct = Math.floor(Math.random() * 80) + 10;
        const rule = pricingRules.find(r => occupancyPct <= r.occupancy_pct_max) || pricingRules[pricingRules.length - 1];
        const currentPrice = parseFloat((flight.base_price * rule.multiplier).toFixed(2));
        return {
            flight_id:      flight.flight_id || flight.flightId,
            route:          `${flight.origin} → ${flight.destination}`,
            base_price_usd: flight.base_price,
            current_price_usd: currentPrice,
            pricing_tier:   rule.tier,
            demand_factor:  rule.multiplier,
            occupancy_pct:  occupancyPct,
            description:    rule.description
        };
    });

    res.json({ source: USE_DYNAMODB ? 'DynamoDB' : 'Local Memory', rules: pricingRules, pricing: pricingData, generatedAt: new Date().toISOString() });
});

app.post('/api/flights/update-status', async (req, res) => {
    const { flightId, status, gate, delayMins, delayReason } = req.body;
    if (!flightId || !status) return res.status(400).json({ error: 'flightId and status are required' });

    let flight;
    if (USE_DYNAMODB) {
        try {
            const getRes = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { flightId } }));
            flight = getRes.Item;
            if (!flight) return res.status(404).json({ error: `Flight ${flightId} not found` });
            
            flight.status = status;
            if (gate) flight.gate = gate;
            if (delayMins) flight.delay_mins = delayMins;
            if (delayReason) flight.delay_reason = delayReason;
            if (status !== 'DELAYED') { delete flight.delay_mins; delete flight.delay_reason; }
            
            await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: flight }));
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    } else {
        flight = flightSchedule.find(f => f.flight_id === flightId);
        if (!flight) return res.status(404).json({ error: `Flight ${flightId} not found` });
        flight.status = status;
        if (gate) flight.gate = gate;
        if (delayMins) flight.delay_mins = delayMins;
        if (delayReason) flight.delay_reason = delayReason;
        if (status !== 'DELAYED') { delete flight.delay_mins; delete flight.delay_reason; }
    }

    notifyBookingService(flightId, status, gate);
    res.json({ message: 'Flight status updated successfully', flight });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`Flight Ops Service running on port ${PORT}`));
}
module.exports = app;
