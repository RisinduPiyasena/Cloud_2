const https = require('https');

const URL = 'https://d2dnoz56aodoxl.cloudfront.net/api/flights';
const TOTAL_REQUESTS = 200;
const CONCURRENCY = 20;

let completed = 0;
let errors = 0;
let totalLatency = 0;
const start = Date.now();

function makeRequest() {
  return new Promise((resolve) => {
    const reqStart = Date.now();
    https.get(URL, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 400) errors++;
        totalLatency += (Date.now() - reqStart);
        completed++;
        resolve();
      });
    }).on('error', (e) => {
      errors++;
      totalLatency += (Date.now() - reqStart);
      completed++;
      resolve();
    });
  });
}

async function runTest() {
  console.log(`Starting load test on ${URL} with ${CONCURRENCY} concurrent users...`);
  
  const queue = Array(TOTAL_REQUESTS).fill(null);
  const workers = Array(CONCURRENCY).fill(null).map(async () => {
    while (queue.length > 0) {
      queue.pop();
      await makeRequest();
    }
  });

  await Promise.all(workers);
  
  const duration = (Date.now() - start) / 1000;
  const avgLatency = Math.round(totalLatency / TOTAL_REQUESTS);
  const throughput = Math.round(TOTAL_REQUESTS / duration);
  const errorRate = ((errors / TOTAL_REQUESTS) * 100).toFixed(2);

  console.log('\n--- LOAD TEST RESULTS ---');
  console.log(`Endpoint Tested     : GET /api/flights`);
  console.log(`Total Requests      : ${TOTAL_REQUESTS}`);
  console.log(`Duration            : ${duration.toFixed(2)}s`);
  console.log(`Average Latency (ms): ${avgLatency} ms`);
  console.log(`Throughput (req/s)  : ${throughput} req/s`);
  console.log(`Error Rate (%)      : ${errorRate}%`);
  console.log('\n| Endpoint | Requests | Avg Latency (ms) | Throughput (req/s) | Error % |');
  console.log(`| /api/flights | ${TOTAL_REQUESTS} | ${avgLatency} | ${throughput} | ${errorRate}% |`);
}

runTest();
