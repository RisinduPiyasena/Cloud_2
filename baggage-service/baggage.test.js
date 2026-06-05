/**
 * AeroLink – Baggage Service Unit Tests
 * Framework: Jest + Supertest
 */
const request = require('supertest');
const app = require('./index');

describe('Baggage Service – Health', () => {
    test('GET /api/health returns 200', async () => {
        const res = await request(app).get('/api/health');
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('healthy');
        expect(res.body.service).toBe('baggage-service');
    });
});

describe('Baggage Service – Track', () => {
    test('GET /api/baggage/track/BAG-77102 returns seeded record', async () => {
        const res = await request(app).get('/api/baggage/track/BAG-77102');
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toBeDefined();
        expect(res.body.data.baggage_id).toBe('BAG-77102');
        expect(res.body.data.passenger).toBe('Risindu');
        expect(res.body.data.status).toBeDefined();
    });

    test('GET /api/baggage/track/INVALID returns 404', async () => {
        const res = await request(app).get('/api/baggage/track/BAG-00000');
        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBeDefined();
    });

    test('Response uses data field (not document)', async () => {
        const res = await request(app).get('/api/baggage/track/BAG-77102');
        expect(res.body.data).toBeDefined();
        expect(res.body.document).toBeUndefined(); // Bug fix verification
    });
});

describe('Baggage Service – All Records', () => {
    test('GET /api/baggage/all returns array of records', async () => {
        const res = await request(app).get('/api/baggage/all');
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array);
        expect(res.body.data.length).toBeGreaterThan(0);
    });
});

describe('Baggage Service – Update', () => {
    test('POST /api/baggage/update rejects missing fields', async () => {
        const res = await request(app)
            .post('/api/baggage/update')
            .send({});
        expect(res.statusCode).toBe(400);
    });

    test('POST /api/baggage/update rejects invalid status', async () => {
        const res = await request(app)
            .post('/api/baggage/update')
            .send({ baggageId: 'BAG-77102', status: 'INVALID_STATUS' });
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/invalid status/i);
    });

    test('POST /api/baggage/update updates existing record', async () => {
        const res = await request(app)
            .post('/api/baggage/update')
            .send({ baggageId: 'BAG-77102', status: 'IN_TRANSIT', location: 'London (LHR)' });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.status).toBe('IN_TRANSIT');
        expect(res.body.data.location).toBe('London (LHR)');
        expect(res.body.data.lastUpdated).toBeDefined();
    });

    test('POST /api/baggage/update creates new record if tag not found (DynamoDB upsert)', async () => {
        const res = await request(app)
            .post('/api/baggage/update')
            .send({ baggageId: 'BAG-NEW-TEST', status: 'CHECK_IN_RECEIVED', location: 'Dubai (DXB)', passenger: 'New Passenger' });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.baggage_id).toBe('BAG-NEW-TEST');
    });
});
