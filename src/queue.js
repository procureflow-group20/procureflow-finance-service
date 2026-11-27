// Finance's own queue (table finance_queue). Filled by the RequestForwarded event and
// reconciled on every read, so the queue is correct even if an event was lost.
const { db, logger, workflow } = require('procureflow-lib');
const { ensurePeriod, currentPeriod } = require('./budget');

async function addToQueue(requestId) {
  await ensurePeriod(db.query);
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

async function reconcile() {
  const r = await db.query(
    `SELECT p.id FROM purchase_requests p
      WHERE p.status = 'PENDING_FINANCE' AND NOT EXISTS (SELECT 1 FROM finance_queue f WHERE f.request_id = p.id)`,
  );
  for (const row of r.rows) await addToQueue(row.id);
  if (r.rowCount) logger.warn('QUEUE_RECONCILED', { added: r.rowCount });
  return r.rowCount;
}

module.exports = { addToQueue, reconcile, priorityRank: workflow.priorityRank };
