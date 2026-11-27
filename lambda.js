// Lambda entry point (handler = lambda.handler).
//  - EventBridge "RequestForwarded" (rule forwarded-to-finance) -> add the request to the finance queue
//  - EventBridge scheduled rule "budget-rollover" (source aws.events) -> open this month's budgets
//  - API Gateway HTTP events -> Express app
const serverless = require('serverless-http');
const app = require('./src/app');
const { handleEvent } = require('./src/jobs');

const http = serverless(app);

module.exports.handler = async (event, context) => {
  if (event && (event['detail-type'] === 'RequestForwarded' || event.source === 'aws.events')) return handleEvent(event);
  return http(event, context);
};
