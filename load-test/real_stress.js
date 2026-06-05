const https = require('https');

const URL = 'https://d2dnoz56aodoxl.cloudfront.net/api/flights';
const TOTAL_REQUESTS = 1000;
const CONCURRENCY = 60; // Pushes Fargate hard enough to spike latency, but safely

let completed = 0;
let errors = 0;
let totalLatency = 0;
const start = Date.now();

function makeRequest() {
  return new Promise((resolve) => {
    const reqStart = Date.now();
    
    // Setting a strict timeout to simulate real-world failure under stress
    const req = https.get(URL, { timeout: 3000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 400) errors++;
        totalLatency += (Date.now() - reqStart);
        completed++;
        resolve();
      });
    });

    req.on('timeout', () => {
      req.destroy();
      errors++;
      totalLatency += (Date.now() - reqStart);
      completed++;
      resolve();
    });

    req.on('error', (e) => {
      errors++;
      totalLatency += (Date.now() - reqStart);
      completed++;
      resolve();
    });
  });
}

async function runStressTest() {
  console.log(`Initiating REAL STRESS TEST on ${URL}`);
  console.log(`Firing ${TOTAL_REQUESTS} requests with ${CONCURRENCY} concurrent users...`);
  console.log('Expect latency spikes and connection timeouts as ECS Fargate saturates.\n');
  
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

  console.log('--- STRESS TEST RESULTS ---');
  console.log(`Peak Virtual Users  : ${CONCURRENCY}`);
  console.log(`Total Requests      : ${TOTAL_REQUESTS}`);
  console.log(`Duration            : ${duration.toFixed(2)}s`);
  console.log(`Average Latency (ms): ${avgLatency} ms`);
  console.log(`Throughput (req/s)  : ${throughput} req/s`);
  console.log(`Error Rate (%)      : ${errorRate}%`);

  console.log('\n| Metric | Recorded Value at Peak Stress |');
  console.log('| :--- | :--- |');
  console.log(`| Concurrent Virtual Users | ${CONCURRENCY} |`);
  console.log(`| Total Requests Handled | ${TOTAL_REQUESTS} |`);
  console.log(`| Peak Throughput | ${throughput} req/s |`);
  console.log(`| Average Latency | ${avgLatency} ms |`);
  console.log(`| Error Rate | ${errorRate}% |`);
}

runStressTest();
