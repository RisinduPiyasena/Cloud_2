const fs = require('fs');
const swaggerJsdoc = require('swagger-jsdoc');

const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink Flight Booking API',
      version: '1.0.0',
      description: 'API for searching flights, booking seats, tracking baggage, and checking in.',
    },
    servers: [
      {
        url: 'https://d2dnoz56aodoxl.cloudfront.net',
        description: 'Production CloudFront server',
      },
    ],
  },
  apis: ['./index.js'], // Look for swagger comments in the booking service
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
const targetDir = '../frontend/public/docs';

if (!fs.existsSync(targetDir)){
    fs.mkdirSync(targetDir, { recursive: true });
}

fs.writeFileSync(`${targetDir}/swagger.json`, JSON.stringify(swaggerSpec, null, 2));
console.log('✅ Successfully generated swagger.json to frontend/public/docs/');
