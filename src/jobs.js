// Event handlers invoked by EventBridge:
//  - rule "forwarded-to-finance": RequestForwarded (from manager-service) -> add to the finance queue
//  - scheduled rule "budget-rollover" (1st of every month): open the new month's budgets
const { logger, validateId, publish, db } = require('procureflow-lib');
const { ensurePeriod, currentPeriod } = require('./budget');
const { addToQueue } = require('./queue');

async function onRequestForwarded(detail) {
  const requestId = validateId(detail && detail.requestId, 'requestId');
  const added = await addToQueue(requestId);
  return { handled: 'RequestForwarded', requestId, added };
}

async function budgetRollover() {
  const period = currentPeriod();
  const opened = await ensurePeriod(db.query, period);
  logger.info('BUDGET_ROLLOVER', { period, opened });
  if (opened) await publish('BudgetPeriodOpened', { period, departments: opened });
  return { handled: 'budget-rollover', period, opened };
}

async function handleEvent(event) {
  if (event && event['detail-type'] === 'RequestForwarded') return onRequestForwarded(event.detail);
  if (event && event.source === 'aws.events') return budgetRollover();
  // the EventBridge rule only sends RequestForwarded; anything else is ignored on purpose
  logger.info('EVENT_IGNORED', { detailType: event && event['detail-type'], source: event && event.source });
  return { handled: false };
}

module.exports = { onRequestForwarded, budgetRollover, handleEvent };
