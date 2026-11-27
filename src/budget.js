// Monthly department budgets. A budget row per department per month (period "YYYY-MM").
const { workflow } = require('procureflow-lib');

const { currentPeriod } = workflow;

// Opens the period for every department (idempotent). Called by the monthly rollover job and,
// as a safety net, before any budget read or approval.
async function ensurePeriod(q, period = currentPeriod()) {
  const r = await q(
    `INSERT INTO budgets (department_id, period, allocated)
     SELECT id, $1, monthly_allocation FROM departments
     ON CONFLICT (department_id, period) DO NOTHING RETURNING department_id`,
    [period],
  );
  return r.rowCount;
}

// Same, but at most once per budget period in each Lambda container: after the first call of the month
// it costs nothing, so read endpoints no longer write to the database on every request.
let ensuredPeriod = null;
async function ensureCurrentPeriodOnce(q) {
  const period = currentPeriod();
  if (ensuredPeriod === period) return 0;
  const opened = await ensurePeriod(q, period);
  ensuredPeriod = period;
  return opened;
}

async function currentBudget(q, departmentId, period = currentPeriod()) {
  const r = await q(
    `SELECT d.id AS department_id, d.name AS department_name, b.period, b.allocated, b.spent,
            (b.allocated - b.spent) AS remaining
       FROM departments d JOIN budgets b ON b.department_id = d.id AND b.period = $2
      WHERE d.id = $1`,
    [departmentId, period],
  );
  return r.rows[0] || null;
}

module.exports = { ensurePeriod, ensureCurrentPeriodOnce, currentBudget, currentPeriod };
