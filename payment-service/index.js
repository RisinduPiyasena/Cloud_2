const express = require('express');
const cors = require('cors');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3004;
const USE_DYNAMODB = process.env.USE_DYNAMODB === 'true';
const TABLE_NAME = process.env.DYNAMODB_PAYMENTS_TABLE || 'AeroLink-Payments';

let docClient;
if (USE_DYNAMODB) {
    const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
    docClient = DynamoDBDocumentClient.from(ddbClient);
}

// In-memory fallback
let localPayments = [];

app.get('/api/health', (req, res) => res.json({ service: 'payment-service', status: 'healthy', database: USE_DYNAMODB ? 'DynamoDB' : 'In-Memory' }));

app.post('/api/payments/process', async (req, res) => {
    const { amount, currency, source, bookingId, passengerName } = req.body;
    
    if (!amount || !bookingId) {
        return res.status(400).json({ error: 'amount and bookingId are required' });
    }

    // Mocking 3rd party processing delay
    await new Promise(r => setTimeout(r, 1000));

    const transactionId = 'TXN-' + Math.floor(Math.random() * 9000000 + 1000000);
    const receipt = {
        transactionId,
        bookingId,
        passengerName: passengerName || 'Guest',
        amount,
        currency: currency || 'USD',
        status: 'PAID',
        processedAt: new Date().toISOString()
    };

    if (USE_DYNAMODB) {
        try {
            await docClient.send(new PutCommand({
                TableName: TABLE_NAME,
                Item: receipt
            }));
        } catch (err) {
            console.error('DynamoDB Error:', err);
            return res.status(500).json({ error: 'Failed to record transaction' });
        }
    } else {
        localPayments.push(receipt);
    }

    res.json({ success: true, receipt });
});

app.get('/api/payments/transactions', async (req, res) => {
    if (USE_DYNAMODB) {
        try {
            const data = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
            res.json({ transactions: data.Items || [] });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    } else {
        res.json({ transactions: localPayments });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Payment service listening on port ${PORT}`);
});
