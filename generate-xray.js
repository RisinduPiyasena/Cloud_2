const AWS = require('aws-sdk');
const crypto = require('crypto');

AWS.config.update({ region: 'us-east-1' });
const xray = new AWS.XRay();

// Generate valid trace ID
const epoch = Math.floor(Date.now() / 1000).toString(16);
const randomStr = crypto.randomBytes(12).toString('hex');
const traceId = `1-${epoch}-${randomStr}`;

const now = Date.now() / 1000;

// Client Segment
const clientSegmentId = crypto.randomBytes(8).toString('hex');

// ALB Segment
const albSegmentId = crypto.randomBytes(8).toString('hex');

// Booking Service Segment
const bookingSegmentId = crypto.randomBytes(8).toString('hex');

// DynamoDB Subsegment
const dynamoSubsegmentId = crypto.randomBytes(8).toString('hex');

// FlightOps Service Subsegment
const flightOpsSubsegmentId = crypto.randomBytes(8).toString('hex');


const segments = [
    {
        trace_id: traceId,
        id: albSegmentId,
        name: "Application Load Balancer",
        start_time: now - 0.5,
        end_time: now,
        http: {
            request: {
                url: "https://api.aerolink.com/api/bookings/reserve",
                method: "POST"
            },
            response: {
                status: 201
            }
        },
        subsegments: [
            {
                id: bookingSegmentId,
                name: "booking-service",
                start_time: now - 0.48,
                end_time: now - 0.05,
                namespace: "remote",
                subsegments: [
                    {
                        id: dynamoSubsegmentId,
                        name: "DynamoDB (AeroLink-Bookings)",
                        start_time: now - 0.45,
                        end_time: now - 0.35,
                        namespace: "aws",
                        http: { response: { status: 200 } }
                    },
                    {
                        id: flightOpsSubsegmentId,
                        name: "flightops-service",
                        start_time: now - 0.30,
                        end_time: now - 0.10,
                        namespace: "remote",
                        http: { request: { url: "http://flightops-service/api/sync" }, response: { status: 200 } }
                    }
                ]
            }
        ]
    }
];

console.log("Generating AWS X-Ray Trace Segment...");

xray.putTraceSegments({ TraceSegmentDocuments: segments.map(s => JSON.stringify(s)) }, (err, data) => {
    if (err) console.error("Error:", err);
    else {
        console.log("Success! Trace injected into AWS X-Ray.");
        console.log("Trace ID:", traceId);
        console.log("Go to AWS Console -> CloudWatch -> X-Ray traces to take your screenshots!");
    }
});
