// Finance Approval & Budget Service - owner: Ziyad Abdalla (225244)
// Pending-approvals dashboard, approve (full or reduced) with an atomic budget check, reject,
// request more information, monthly department budgets, vendors and the decision audit log.

const {
  express, createApp, ah, db, validate, validateId, verifyJwt, requireRole, publish, logger, isLambda,
  AppError, notFound, forbidden, conflict, camel, camelAll, workflow,
} = require('procureflow-lib');
const { ensurePeriod, currentBudget, currentPeriod } = require('./budget');
const { reconcile, priorityRank } = require('./queue');
const audit = require('./audit');
const jobs = require('./jobs');

const { STATUS, PRIORITIES, addHistory, addMessage, timeline } = workflow;
const MAX_EGP = 10000000;

async function lockPendingRequest(c, id) {
  const r = await c.query('SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw notFound('Request');
  const row = r.rows[0];
  if (row.status !== STATUS.PENDING_FINANCE) throw conflict('WRONG_STATUS', `Finance cannot decide while the request is ${row.status}`);
  return row;
}

// ------------------------------------------------------------------ finance router
const fin = express.Router();
fin.use(verifyJwt());

// F1: pending-approvals queue, sorted by final priority then waiting time.
fin.get('/pending', requireRole('FINANCE'), ah(async (req, res) => {
  const q = validate({ department: { type: 'uuid' }, priority: { type: 'enum', values: PRIORITIES } }, req.query);
  await ensurePeriod(db.query);
  await reconcile();
  const params = [currentPeriod()];
  let where = "p.status = 'PENDING_FINANCE'";
  if (q.department) { params.push(q.department); where += ` AND p.department_id = $${params.length}`; }
  if (q.priority) { params.push(q.priority); where += ` AND f.final_priority = $${params.length}`; }
  const r = await db.query(
    `SELECT p.id, p.title, p.total_amount_egp, f.final_priority, f.forwarded_at, p.manager_note,
            d.name AS department_name, p.department_id, u.name AS requester_name, v.name AS vendor_name,
            (b.allocated - b.spent) AS department_remaining,
            CASE WHEN p.total_amount_egp <= b.allocated - b.spent THEN 'WITHIN' ELSE 'OVER' END AS budget_fit,
            f.budget_fit AS budget_fit_when_forwarded
       FROM finance_queue f
       JOIN purchase_requests p ON p.id = f.request_id
       JOIN departments d ON d.id = p.department_id
       JOIN users u ON u.id = p.requester_id
       JOIN budgets b ON b.department_id = p.department_id AND b.period = $1
       LEFT JOIN request_quotes rq ON rq.request_id = p.id AND rq.is_selected
       LEFT JOIN vendors v ON v.id = rq.vendor_id
      WHERE ${where}
      ORDER BY ${priorityRank('f.final_priority')} DESC, f.forwarded_at ASC
      LIMIT 100`, params,
  );
  res.json({ period: currentPeriod(), items: camelAll(r.rows) });
}));

// F1: dashboard counters and the budget of every department.
fin.get('/dashboard', requireRole('FINANCE'), ah(async (req, res) => {
  const period = currentPeriod();
  await ensurePeriod(db.query);
  await reconcile();
  const [byStatus, oldest, budgets, approvedThisMonth] = await Promise.all([
    db.query('SELECT status, count(*)::int AS count, coalesce(sum(total_amount_egp),0) AS total_egp FROM purchase_requests GROUP BY status'),
    db.query("SELECT min(forwarded_at) AS oldest_pending FROM purchase_requests WHERE status = 'PENDING_FINANCE'"),
    db.query(
      `SELECT d.id AS department_id, d.name AS department_name, b.allocated, b.spent, (b.allocated - b.spent) AS remaining,
              coalesce((SELECT sum(total_amount_egp) FROM purchase_requests p WHERE p.department_id = d.id AND p.status = 'PENDING_FINANCE'), 0) AS pending_amount
         FROM departments d JOIN budgets b ON b.department_id = d.id AND b.period = $1 ORDER BY d.name`, [period]),
    db.query("SELECT count(*)::int AS count, coalesce(sum(amount_egp),0) AS total_amount FROM decisions WHERE decision = 'APPROVED' AND budget_period = $1", [period]),
  ]);
  res.json({
    period,
    byStatus: camelAll(byStatus.rows),
    oldestPending: oldest.rows[0].oldest_pending,
    budgets: camelAll(budgets.rows),
    approvedThisMonth: camel(approvedThisMonth.rows[0]),
  });
}));

fin.get('/requests/:id', requireRole('FINANCE'), ah(async (req, res) => {
  const id = validateId(req.params.id);
  const r = await db.query(
    `SELECT p.*, u.name AS requester_name, u.email AS requester_email, d.name AS department_name
       FROM purchase_requests p JOIN users u ON u.id = p.requester_id JOIN departments d ON d.id = p.department_id
      WHERE p.id = $1`, [id],
  );
  if (!r.rowCount) throw notFound('Request');
  const row = r.rows[0];
  await ensurePeriod(db.query);
  const [quotes, tl, decision, budget] = await Promise.all([
    db.query(
      `SELECT q.id, v.name AS vendor_name, q.quote_number, q.amount, q.currency, q.fx_rate, q.fx_date, q.amount_egp,
              q.valid_until, q.is_selected, q.file_type, (q.file_key IS NOT NULL) AS has_file
         FROM request_quotes q JOIN vendors v ON v.id = q.vendor_id WHERE q.request_id = $1 ORDER BY q.created_at`, [id]),
    timeline(db.query, id),
    db.query('SELECT decision, amount_egp, reason, decided_at, budget_period FROM decisions WHERE request_id = $1', [id]),
    currentBudget(db.query, row.department_id),
  ]);
  res.json({
    request: camel(row),
    quotes: camelAll(quotes.rows),
    messages: camelAll(tl.messages),
    history: camelAll(tl.history),
    decision: camel(decision.rows[0]) || null,
    budget: camel(budget),
    budgetFit: budget && Number(row.total_amount_egp) <= Number(budget.remaining) ? 'WITHIN' : 'OVER',
  });
}));

// F2: approve the full or a reduced amount. Budget check + deduction + status change in one transaction.
fin.post('/requests/:id/approve', requireRole('FINANCE'), ah(async (req, res) => {
  const id = validateId(req.params.id);
  const body = validate({
    amountEgp: { type: 'number', required: true, gt: 0, max: MAX_EGP, decimals: 2 },
    note: { type: 'string', max: 500 },
  }, req.body);
  const period = currentPeriod();
  await ensurePeriod(db.query, period);
  const result = await db.tx(async (c) => {
    const row = await lockPendingRequest(c, id);
    if (body.amountEgp > Number(row.total_amount_egp)) {
      throw new AppError(400, 'AMOUNT_ABOVE_REQUESTED', `Approved amount cannot be more than the requested ${row.total_amount_egp} EGP`);
    }
    // Conditional update: only succeeds if enough budget is left. Two officers approving at the
    // same moment are serialised by the row lock, so the department can never be overspent.
    const b = await c.query(
      `UPDATE budgets SET spent = spent + $3, updated_at = now()
        WHERE department_id = $1 AND period = $2 AND allocated - spent >= $3
      RETURNING allocated, spent`,
      [row.department_id, period, body.amountEgp],
    );
    if (!b.rowCount) {
      const cur = await currentBudget(c.query.bind(c), row.department_id, period);
      logger.warn('BUDGET_EXCEEDED', { requestId: id, userId: req.user.id, amountEgp: body.amountEgp, remaining: cur && Number(cur.remaining) });
      throw new AppError(409, 'BUDGET_EXCEEDED',
        `Only ${cur ? Number(cur.remaining).toFixed(2) : 0} EGP is left in this department's budget for ${period}`);
    }
    const u = await c.query(
      `UPDATE purchase_requests SET status = 'APPROVED', approved_amount_egp = $2, decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING_FINANCE' RETURNING id`, [id, body.amountEgp],
    );
    if (!u.rowCount) throw conflict('WRONG_STATUS', 'The request was changed by someone else');
    await c.query(
      `INSERT INTO decisions (request_id, finance_user_id, decision, amount_egp, reason, budget_period)
       VALUES ($1, $2, 'APPROVED', $3, $4, $5)`, [id, req.user.id, body.amountEgp, body.note || null, period],
    );
    await c.query('DELETE FROM finance_queue WHERE request_id = $1', [id]);
    const reduced = body.amountEgp < Number(row.total_amount_egp);
    await addHistory(c, {
      requestId: id, from: row.status, to: STATUS.APPROVED, actor: req.user,
      note: reduced ? `Approved a reduced amount: ${body.amountEgp} EGP` : 'Approved in full',
    });
    if (body.note) await addMessage(c, { requestId: id, author: req.user, recipientRole: 'EMPLOYEE', body: body.note });
    const after = b.rows[0];
    return {
      departmentId: row.department_id, reduced,
      budgetBefore: Number(after.allocated) - Number(after.spent) + body.amountEgp,
      budgetAfter: Number(after.allocated) - Number(after.spent),
    };
  });
  await audit.record({
    requestId: id, action: 'APPROVED', actorId: req.user.id, amount: body.amountEgp,
    budgetBefore: result.budgetBefore, budgetAfter: result.budgetAfter, period, reason: body.note,
  });
  await publish('RequestApproved', { requestId: id, departmentId: result.departmentId, amountEgp: body.amountEgp, period });
  logger.info('REQUEST_APPROVED', { requestId: id, userId: req.user.id, amountEgp: body.amountEgp, reduced: result.reduced });
  res.json({ id, status: STATUS.APPROVED, approvedAmountEgp: body.amountEgp, remainingBudget: result.budgetAfter });
}));

// F2: reject with a reason.
fin.post('/requests/:id/reject', requireRole('FINANCE'), ah(async (req, res) => {
  const id = validateId(req.params.id);
  const { reason } = validate({ reason: { type: 'string', required: true, min: 5, max: 500 } }, req.body);
  const deptId = await db.tx(async (c) => {
    const row = await lockPendingRequest(c, id);
    await c.query("UPDATE purchase_requests SET status = 'REJECTED', decided_at = now(), updated_at = now() WHERE id = $1", [id]);
    await c.query(
      `INSERT INTO decisions (request_id, finance_user_id, decision, reason, budget_period)
       VALUES ($1, $2, 'REJECTED', $3, $4)`, [id, req.user.id, reason, currentPeriod()],
    );
    await c.query('DELETE FROM finance_queue WHERE request_id = $1', [id]);
    await addMessage(c, { requestId: id, author: req.user, recipientRole: 'EMPLOYEE', body: `Rejected by finance: ${reason}` });
    await addHistory(c, { requestId: id, from: row.status, to: STATUS.REJECTED, actor: req.user, note: reason });
    return row.department_id;
  });
  await audit.record({ requestId: id, action: 'REJECTED', actorId: req.user.id, reason });
  await publish('RequestRejected', { requestId: id, departmentId: deptId, by: 'FINANCE' });
  logger.info('REQUEST_REJECTED_BY_FINANCE', { requestId: id, userId: req.user.id });
  res.json({ id, status: STATUS.REJECTED });
}));

// F2: ask the employee, the manager or both. The request comes back to finance after every target answered.
fin.post('/requests/:id/request-info', requireRole('FINANCE'), ah(async (req, res) => {
  const id = validateId(req.params.id);
  const body = validate({
    target: { type: 'enum', required: true, values: ['EMPLOYEE', 'MANAGER', 'BOTH'] },
    question: { type: 'string', required: true, min: 5, max: 1000 },
  }, req.body);
  await db.tx(async (c) => {
    const row = await lockPendingRequest(c, id);
    await c.query(
      `UPDATE purchase_requests SET status = 'NEEDS_INFO', info_asked_by = 'FINANCE', info_target = $2,
              info_pending_employee = $3, info_pending_manager = $4, updated_at = now() WHERE id = $1`,
      [id, body.target, body.target !== 'MANAGER', body.target !== 'EMPLOYEE'],
    );
    await addMessage(c, { requestId: id, author: req.user, recipientRole: body.target, body: body.question });
    await addHistory(c, { requestId: id, from: row.status, to: STATUS.NEEDS_INFO, actor: req.user, note: `Finance asked ${body.target.toLowerCase()}` });
  });
  await audit.record({ requestId: id, action: `INFO_REQUESTED_${body.target}`, actorId: req.user.id, reason: body.question });
  await publish('InfoRequested', { requestId: id, askedBy: 'FINANCE', target: body.target });
  res.json({ id, status: STATUS.NEEDS_INFO, target: body.target });
}));

// F3: departments and monthly budgets.
fin.get('/departments', requireRole('FINANCE'), ah(async (req, res) => {
  const r = await db.query(
    `SELECT d.id, d.name, d.cost_center, d.monthly_allocation, u.name AS manager_name
       FROM departments d LEFT JOIN users u ON u.id = d.manager_id ORDER BY d.name`,
  );
  res.json({ departments: camelAll(r.rows) });
}));

fin.post('/departments', requireRole('FINANCE'), ah(async (req, res) => {
  const body = validate({
    name: { type: 'string', required: true, min: 2, max: 80 },
    costCenter: { type: 'string', required: true, min: 2, max: 20, pattern: /^[A-Z0-9-]+$/, patternMessage: 'costCenter uses capital letters, digits and -' },
    monthlyAllocation: { type: 'number', required: true, min: 0, max: MAX_EGP, decimals: 2 },
  }, req.body);
  const d = await db.tx(async (c) => {
    const r = await c.query(
      'INSERT INTO departments (name, cost_center, monthly_allocation) VALUES ($1,$2,$3) RETURNING *',
      [body.name, body.costCenter, body.monthlyAllocation],
    );
    await c.query('INSERT INTO budgets (department_id, period, allocated) VALUES ($1, $2, $3)', [r.rows[0].id, currentPeriod(), body.monthlyAllocation]);
    return r.rows[0];
  });
  await audit.record({ requestId: `BUDGET#${d.id}`, action: 'DEPARTMENT_CREATED', actorId: req.user.id, amount: body.monthlyAllocation, period: currentPeriod() });
  res.status(201).json({ department: camel(d) });
}));

fin.get('/budgets', requireRole('FINANCE'), ah(async (req, res) => {
  const { period } = validate({ period: { type: 'string', pattern: /^\d{4}-(0[1-9]|1[0-2])$/, patternMessage: 'period must be YYYY-MM' } }, req.query);
  const p = period || currentPeriod();
  if (p === currentPeriod()) await ensurePeriod(db.query, p);
  const r = await db.query(
    `SELECT d.id AS department_id, d.name AS department_name, d.monthly_allocation, b.period, b.allocated, b.spent,
            (b.allocated - b.spent) AS remaining
       FROM departments d LEFT JOIN budgets b ON b.department_id = d.id AND b.period = $1 ORDER BY d.name`, [p],
  );
  res.json({ period: p, budgets: camelAll(r.rows) });
}));

// Used by the Manager page too: a manager may read only his/her own department's budget.
fin.get('/budgets/:deptId/current', requireRole('FINANCE', 'MANAGER'), ah(async (req, res) => {
  const deptId = validateId(req.params.deptId, 'department id');
  if (req.user.role === 'MANAGER' && req.user.departmentId !== deptId) {
    logger.warn('DEPARTMENT_DENIED', { userId: req.user.id, departmentId: deptId, what: 'budget' });
    throw forbidden('Managers can only see their own department budget');
  }
  await ensurePeriod(db.query);
  const b = await currentBudget(db.query, deptId);
  if (!b) throw notFound('Department');
  res.json({ budget: camel(b) });
}));

fin.put('/budgets/:deptId', requireRole('FINANCE'), ah(async (req, res) => {
  const deptId = validateId(req.params.deptId, 'department id');
  const { monthlyAllocation } = validate({ monthlyAllocation: { type: 'number', required: true, min: 0, max: MAX_EGP, decimals: 2 } }, req.body);
  const period = currentPeriod();
  await ensurePeriod(db.query, period);
  const out = await db.tx(async (c) => {
    const cur = await c.query('SELECT allocated, spent FROM budgets WHERE department_id = $1 AND period = $2 FOR UPDATE', [deptId, period]);
    if (!cur.rowCount) throw notFound('Department');
    if (monthlyAllocation < Number(cur.rows[0].spent)) {
      throw conflict('BELOW_SPENT', `This month ${cur.rows[0].spent} EGP is already spent; the allocation cannot be lower`);
    }
    await c.query('UPDATE departments SET monthly_allocation = $2 WHERE id = $1', [deptId, monthlyAllocation]);
    await c.query('UPDATE budgets SET allocated = $3, updated_at = now() WHERE department_id = $1 AND period = $2', [deptId, period, monthlyAllocation]);
    return { before: Number(cur.rows[0].allocated) };
  });
  await audit.record({ requestId: `BUDGET#${deptId}`, action: 'ALLOCATION_CHANGED', actorId: req.user.id, budgetBefore: out.before, budgetAfter: monthlyAllocation, period });
  logger.info('BUDGET_CHANGED', { departmentId: deptId, userId: req.user.id, from: out.before, to: monthlyAllocation });
  res.json({ budget: camel(await currentBudget(db.query, deptId, period)) });
}));

// Decision audit log: one request's trail from DynamoDB, or the latest decisions.
fin.get('/audit', requireRole('FINANCE'), ah(async (req, res) => {
  const { requestId } = validate({ requestId: { type: 'uuid' } }, req.query);
  if (requestId) return res.json({ requestId, trail: await audit.trail(requestId) });
  const r = await db.query(
    `SELECT dc.request_id, p.title, d.name AS department_name, dc.decision, dc.amount_egp, dc.reason, dc.budget_period,
            dc.decided_at, u.name AS finance_user
       FROM decisions dc JOIN purchase_requests p ON p.id = dc.request_id JOIN departments d ON d.id = p.department_id
       JOIN users u ON u.id = dc.finance_user_id ORDER BY dc.decided_at DESC LIMIT 50`,
  );
  return res.json({ decisions: camelAll(r.rows) });
}));

// ------------------------------------------------------------------ vendors router
const vendors = express.Router();
vendors.use(verifyJwt());

vendors.get('/', requireRole('EMPLOYEE', 'MANAGER', 'FINANCE'), ah(async (req, res) => {
  const q = validate({ active: { type: 'enum', values: ['true', 'false'] }, q: { type: 'string', max: 60 } }, req.query);
  const isFinance = req.user.role === 'FINANCE';
  const params = [];
  const where = [];
  if (!isFinance || q.active === 'true') where.push("status = 'ACTIVE'");
  if (isFinance && q.active === 'false') where.push("status = 'INACTIVE'");
  if (q.q) { params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`name ILIKE $${params.length}`); }
  const cols = isFinance ? 'id, name, contact_email, phone, status, created_at' : 'id, name';
  const r = await db.query(`SELECT ${cols} FROM vendors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT 200`, params);
  res.json({ vendors: camelAll(r.rows) });
}));

const VENDOR_FIELDS = {
  name: { type: 'string', min: 2, max: 120 },
  contactEmail: { type: 'email' },
  phone: { type: 'string', max: 30, pattern: /^[0-9+()\s-]{6,30}$/, patternMessage: 'phone may contain digits, spaces, +, - and ()' },
};

vendors.post('/', requireRole('FINANCE'), ah(async (req, res) => {
  const body = validate({ ...VENDOR_FIELDS, name: { ...VENDOR_FIELDS.name, required: true } }, req.body);
  try {
    const r = await db.query(
      'INSERT INTO vendors (name, contact_email, phone) VALUES ($1,$2,$3) RETURNING *',
      [body.name, body.contactEmail || null, body.phone || null],
    );
    logger.info('VENDOR_CREATED', { vendorId: r.rows[0].id, userId: req.user.id });
    res.status(201).json({ vendor: camel(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw conflict('VENDOR_EXISTS', 'A vendor with this name already exists');
    throw e;
  }
}));

vendors.patch('/:id', requireRole('FINANCE'), ah(async (req, res) => {
  const id = validateId(req.params.id, 'vendor id');
  const body = validate({ ...VENDOR_FIELDS, status: { type: 'enum', values: ['ACTIVE', 'INACTIVE'] } }, req.body);
  const map = { name: 'name', contactEmail: 'contact_email', phone: 'phone', status: 'status' };
  const keys = Object.keys(body);
  if (!keys.length) throw new AppError(400, 'VALIDATION_ERROR', 'Nothing to update');
  const sets = keys.map((k, i) => `${map[k]} = $${i + 2}`);
  try {
    const r = await db.query(
      `UPDATE vendors SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...keys.map((k) => body[k])],
    );
    if (!r.rowCount) throw notFound('Vendor');
    logger.info('VENDOR_UPDATED', { vendorId: id, userId: req.user.id, fields: keys });
    res.json({ vendor: camel(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw conflict('VENDOR_EXISTS', 'A vendor with this name already exists');
    throw e;
  }
}));

// Local development only: lets the local event forwarder call the same event handlers that
// EventBridge invokes on Floci. Never mounted inside Lambda.
function localOnly(app) {
  if (isLambda() || process.env.LOCAL_EVENTS !== '1') return;
  app.post('/_local/events', express.json(), ah(async (req, res) => res.json(await jobs.handleEvent(req.body))));
}

module.exports = createApp('finance-service', [['/api/finance', fin], ['/api/vendors', vendors]], localOnly);
