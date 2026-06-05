const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();

const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'AeroLink Flight Booking API',
      version: '1.0.0',
      description: 'API for searching flights and booking seats',
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Local server',
      },
    ],
  },
  apis: ['./index.js'], // Look for swagger comments in the booking service
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`✅ Swagger UI is running locally!`);
  console.log(`👉 Open your browser to: http://localhost:${PORT}/api/docs`);
  console.log(`======================================================\n`);
});
