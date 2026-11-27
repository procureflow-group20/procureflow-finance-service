// Finance's own queue (table finance_queue). Filled by the RequestForwarded event (EventBridge rule
// forwarded-to-finance). A reconcile step adds anything an event missed; it is one SQL statement and
// runs at most once a minute per Lambda container, so it no longer slows down every dashboard read.
const { db, logger, workflow } = require('procureflow-lib');
const { ensureCurrentPeriodOnce, currentPeriod } = require('./budget');

async function addToQueue(requestId) {
  await ensureCurrentPeriodOnce(db.query);
  const r = await db.query(
    `INSERT INTO finance_queue (request_id, department_id, final_priority, amount_egp, budget_fit, forwarded_at)
     SELECT p.id, p.department_id, coalesce(p.final_priority, p.suggested_priority), p.total_amount_egp,
            CASE WHEN p.total_amount_egp <= b.allocated - b.spent THEN 'WITHIN' ELSE 'OVER' END,
            coalesce(p.forwarded_at, p.updated_at)
       FROM purchase_requests p
       JOIN budgets b ON b.department_id = p.department_id AND b.period = $2
      WHERE p.id = $1 AND p.status = 'PENDING_FINANCE'
     ON CONFLICT (request_id) DO UPDATE SET final_priority = EXCLUDED.final_priority,
            amount_egp = EXCLUDED.amount_egp, budget_fit = EXCLUDED.budget_fit
     RETURNING budget_fit`,
    [requestId, currentPeriod()],
  );
  if (r.rowCount) logger.info('QUEUE_ENTRY_ADDED', { requestId, budgetFit: r.rows[0].budget_fit });
  return r.rowCount;
}

const RECONCILE_EVERY_MS = 60 * 1000;
let lastReconcile = 0;

// Adds every PENDING_FINANCE request that is missing from the queue, in one statement.
async function reconcile() {
  const r = await db.query(
    `INSERT INTO finance_queue (request_id, department_id, final_priority, amount_egp, budget_fit, forwarded_at)
     SELECT p.id, p.department_id, coalesce(p.final_priority, p.suggested_priority), p.total_amount_egp,
            CASE WHEN p.total_amount_egp <= b.allocated - b.spent THEN 'WITHIN' ELSE 'OVER' END,
            coalesce(p.forwarded_at, p.updated_at)
       FROM purchase_requests p
       JOIN budgets b ON b.department_id = p.department_id AND b.period = $1
      WHERE p.status = 'PENDING_FINANCE' AND NOT EXISTS (SELECT 1 FROM finance_queue f WHERE f.request_id = p.id)
     ON CONFLICT (request_id) DO NOTHING`,
    [currentPeriod()],
  );
  if (r.rowCount) logger.warn('QUEUE_RECONCILED', { added: r.rowCount });
  return r.rowCount;
}

// Run before the queue and dashboard reads: open this month's budgets (once a month per container)
// and reconcile the queue (at most once a minute per container).
async function housekeeping() {
  await ensureCurrentPeriodOnce(db.query);
  const now = Date.now();
  if (now - lastReconcile >= RECONCILE_EVERY_MS) {
    lastReconcile = now;
    await reconcile();
  }
}

module.exports = { addToQueue, reconcile, housekeeping, priorityRank: workflow.priorityRank };
