// Append-only finance audit log in DynamoDB (table finance-audit-log, key requestId + ts).
// The Lambda's IAM policy allows only PutItem and Query on this table: no UpdateItem, no DeleteItem.
const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { logger } = require('procureflow-lib');

const TABLE = process.env.AUDIT_TABLE || 'finance-audit-log';
let doc;
const client = () => { doc = doc || DynamoDBDocumentClient.from(new DynamoDBClient({})); return doc; };

async function record(entry) {
  const item = {
    requestId: entry.requestId,
    ts: `${new Date().toISOString()}#${crypto.randomBytes(3).toString('hex')}`,
    action: entry.action,
    actorId: entry.actorId,
    ...(entry.amount !== undefined && { amount: entry.amount }),
    ...(entry.budgetBefore !== undefined && { budgetBefore: entry.budgetBefore }),
    ...(entry.budgetAfter !== undefined && { budgetAfter: entry.budgetAfter }),
    ...(entry.reason && { reason: entry.reason }),
    ...(entry.period && { period: entry.period }),
  };
  try {
    // attribute_not_exists: an existing record can never be overwritten
    await client().send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(ts)' }));
  } catch (e) {
    // the decision is already committed in Postgres; the failure is logged so it can be alarmed on
    logger.error('AUDIT_WRITE_FAILED', { requestId: entry.requestId, action: entry.action, message: e.message });
  }
}

async function trail(requestId) {
  const out = await client().send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'requestId = :r',
    ExpressionAttributeValues: { ':r': requestId },
    ScanIndexForward: true,
  }));
  return out.Items || [];
}

module.exports = { record, trail };
