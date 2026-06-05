/**
 * AeroLink – Booking Service Unit Tests
 * Tests: health, flight listing, booking creation, booking lookup
 * Framework: Jest + Supertest
 */
const request = require('supertest');
const { app, dbReady } = require('./index');

// Wait for SQLite to initialise before any test runs
beforeAll(() => dbReady);

describe('Booking Service – Health', () => {
    test('GET /api/health returns 200 with healthy status', async () => {
        const res = await request(app).get('/api/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('healthy');
        expect(res.body.service).toBe('booking-service');
    });
});

describe('Booking Service – Flights', () => {
    test('GET /api/bookings/flights returns array of flights', async () => {
        const res = await request(app).get('/api/bookings/flights');
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array);
        expect(res.body.data.length).toBeGreaterThan(0);
        expect(res.body.source).toBe('SQLite Local');
    });

    test('Each flight has required fields', async () => {
        const res = await request(app).get('/api/bookings/flights');
        const flight = res.body.data[0];
        expect(flight).toHaveProperty('flight_id');
        expect(flight).toHaveProperty('origin');
        expect(flight).toHaveProperty('destination');
        expect(flight).toHaveProperty('available_seats');
        expect(flight).toHaveProperty('price');
        expect(flight).toHaveProperty('status');
    });
});

describe('Booking Service – Reserve', () => {
    test('POST /api/bookings/reserve rejects missing fields', async () => {
        const res = await request(app)
            .post('/api/bookings/reserve')
            .send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    test('POST /api/bookings/reserve rejects invalid flight ID', async () => {
        const res = await request(app)
            .post('/api/bookings/reserve')
            .send({ flightId: 'INVALID-999', passengerName: 'Test User' });
        expect(res.statusCode).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    test('POST /api/bookings/reserve creates booking and returns bookingId', async () => {
        const res = await request(app)
            .post('/api/bookings/reserve')
            .send({ flightId: 'AL-101', passengerName: 'James Smith', seatClass: 'Economy' });
        expect(res.statusCode).toBe(201);
        expect(res.body.bookingId).toMatch(/^BK-/);
        expect(res.body.seatAssigned).toBeGreaterThan(0);
        expect(res.body.passengerName).toBe('James Smith');
        expect(res.body.flightId).toBe('AL-101');
    });

    test('Seat count decrements after booking', async () => {
        const before = await request(app).get('/api/bookings/flights');
        const flight  = before.body.data.find(f => f.flight_id === 'AL-202');
        const seatsBefore = flight.available_seats;

        await request(app)
            .post('/api/bookings/reserve')
            .send({ flightId: 'AL-202', passengerName: 'Seat Test Passenger' });

        const after = await request(app).get('/api/bookings/flights');
        const updated = after.body.data.find(f => f.flight_id === 'AL-202');
        expect(updated.available_seats).toBe(seatsBefore - 1);
    });
});

describe('Booking Service – Lookup', () => {
    test('GET /api/bookings/:id returns booking data', async () => {
        // First create a booking to look up
        const create = await request(app)
            .post('/api/bookings/reserve')
            .send({ flightId: 'AL-101', passengerName: 'Lookup Test' });
        const bookingId = create.body.bookingId;

        const res = await request(app).get(`/api/bookings/${bookingId}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.data.booking_id).toBe(bookingId);
        expect(res.body.data.passenger_name).toBe('Lookup Test');
    });

    test('GET /api/bookings/:id returns 404 for invalid ID', async () => {
        const res = await request(app).get('/api/bookings/BK-00000');
        expect(res.statusCode).toBe(404);
    });
});

describe('Booking Service – All Bookings', () => {
    test('GET /api/bookings/all returns array', async () => {
        const res = await request(app).get('/api/bookings/all');
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array);
    });
});
