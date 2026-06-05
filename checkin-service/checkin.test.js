/**
 * AeroLink – Check-In Service Unit Tests
 * Framework: Jest + Supertest
 */
const request = require('supertest');
const app = require('./index');

describe('Check-In Service – Health', () => {
    test('GET /api/health returns 200', async () => {
        const res = await request(app).get('/api/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('healthy');
        expect(res.body.service).toBe('checkin-service');
    });
});

describe('Check-In Service – Process', () => {
    test('POST /api/checkin/process rejects missing fields', async () => {
        const res = await request(app)
            .post('/api/checkin/process')
            .send({});
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    test('POST /api/checkin/process rejects missing flightId', async () => {
        const res = await request(app)
            .post('/api/checkin/process')
            .send({ passengerName: 'James Smith' });
        expect(res.statusCode).toBe(400);
    });

    test('POST /api/checkin/process issues a boarding pass', async () => {
        const res = await request(app)
            .post('/api/checkin/process')
            .send({ passengerName: 'James Smith', flightId: 'AL-101', baggageCount: 2 });
        expect(res.statusCode).toBe(201);
        expect(res.body.boardingPass).toBeDefined();
        expect(res.body.boardingPass.passenger).toBe('James Smith');
        expect(res.body.boardingPass.flightId).toBe('AL-101');
        expect(res.body.boardingPass.seat).toMatch(/^\d+[A-F]$/);
        expect(res.body.boardingPass.gate).toBeDefined();
        expect(res.body.boardingPass.checkinId).toMatch(/^CHK-/);
    });

    test('Boarding pass includes baggage manifest', async () => {
        const res = await request(app)
            .post('/api/checkin/process')
            .send({ passengerName: 'Sara Ahmed', flightId: 'AL-202', baggageCount: 1 });
        expect(res.statusCode).toBe(201);
        expect(res.body.baggageManifest).toBeDefined();
        expect(res.body.baggageManifest.pieces).toBe(1);
        expect(res.body.baggageManifest.tokens).toHaveLength(1);
        expect(res.body.baggageManifest.tokens[0]).toMatch(/^BAG-/);
        expect(res.body.baggageManifest.initialStatus).toBe('CHECK_IN_RECEIVED');
    });

    test('Check-in with 0 bags creates empty baggage manifest', async () => {
        const res = await request(app)
            .post('/api/checkin/process')
            .send({ passengerName: 'No Bag Passenger', flightId: 'AL-303', baggageCount: 0 });
        expect(res.statusCode).toBe(201);
        expect(res.body.baggageManifest.pieces).toBe(0);
        expect(res.body.baggageManifest.tokens).toHaveLength(0);
    });
});

describe('Check-In Service – Status Lookup', () => {
    test('GET /api/checkin/status/:id returns check-in record', async () => {
        // Create a check-in first
        const create = await request(app)
            .post('/api/checkin/process')
            .send({ passengerName: 'Lookup Passenger', flightId: 'AL-101', baggageCount: 1 });
        const checkinId = create.body.boardingPass.checkinId;

        const res = await request(app).get(`/api/checkin/status/${checkinId}`);
        expect(res.statusCode).toBe(200);
        expect(res.body.data.checkinId).toBe(checkinId);
        expect(res.body.data.status).toBe('CHECKED_IN');
    });

    test('GET /api/checkin/status/:id returns 404 for unknown ID', async () => {
        const res = await request(app).get('/api/checkin/status/CHK-00000');
        expect(res.statusCode).toBe(404);
    });
});
