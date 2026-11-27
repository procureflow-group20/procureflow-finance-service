#!/usr/bin/env node
// Race test for the budget guard (owner: Ziyad Abdalla).
// Two forwarded requests each worth 60% of what is left in the IT budget are approved at the same time.
// Expected: exactly one 200 and one 409 BUDGET_EXCEEDED, and budget.spent never goes above allocated.
// Usage: BASE_URL=http://... PASSWORD=... node tests/concurrent-approve.mjs
const BASE = process.env.BASE_URL || 'http://localhost:8080';
const PASSWORD = process.env.PASSWORD;
if (!PASSWORD) { console.error('set PASSWORD (the seed password)'); process.exit(2); }

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}
const login = async (email) => (await call('POST', '/api/auth/login', null, { email, password: PASSWORD })).json.token;

const [emp, mgr, fin] = await Promise.all(['ahmed@procureflow.test', 'it.manager@procureflow.test', 'finance@procureflow.test'].map(login));
const dept = (await call('GET', '/api/auth/me', mgr)).json.user.departmentId;
const vendorId = (await call('GET', '/api/vendors', emp)).json.vendors[0].id;
const before = (await call('GET', `/api/finance/budgets/${dept}/current`, fin)).json.budget;
const amount = Math.floor(Number(before.remaining) * 0.6);
if (amount < 1) { console.error('IT budget has nothing left; raise the allocation first'); process.exit(2); }

const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const ids = [];
for (const n of [1, 2]) {
  const r = await call('POST', '/api/requests', emp, {
    title: `Race test ${n} - ${Date.now()}`, description: 'Concurrent approval test', quantity: 1, suggestedPriority: 'HIGH',
    quotes: [{ vendorId, quoteNumber: `RACE-${n}-${Date.now()}`, amount, currency: 'EGP', validUntil, selected: true }],
  });
  ids.push(r.json.request.id);
  await call('POST', `/api/manager/requests/${r.json.request.id}/forward`, mgr, { finalPriority: 'HIGH', note: 'race test' });
}

const results = await Promise.all(ids.map((id) => call('POST', `/api/finance/requests/${id}/approve`, fin, { amountEgp: amount })));
const after = (await call('GET', `/api/finance/budgets/${dept}/current`, fin)).json.budget;
const codes = results.map((r) => r.status).sort();

console.log(`IT budget before: allocated=${before.allocated} spent=${before.spent} remaining=${before.remaining}`);
console.log(`two approvals of ${amount} EGP sent in parallel -> ${results.map((r) => `${r.status}${r.json.error ? ` ${r.json.error.code}` : ''}`).join(', ')}`);
console.log(`IT budget after:  allocated=${after.allocated} spent=${after.spent} remaining=${after.remaining}`);
const ok = codes[0] === 200 && codes[1] === 409 && Number(after.spent) <= Number(after.allocated);
console.log(ok ? 'PASS: one approval won, the other got 409, spent <= allocated' : 'FAIL');
process.exit(ok ? 0 : 1);
