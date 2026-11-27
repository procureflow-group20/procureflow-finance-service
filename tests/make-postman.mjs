#!/usr/bin/env node
// Generates tests/Finance-Service-Evidence.postman_collection.json (owner: Ziyad Abdalla).
// Run the collection in order (Postman "Run collection", or: npx newman run <file> --env-var baseUrl=... --env-var password=...).
// It creates its own requests, so it works on any database state; amounts are computed from the live budget.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const status = (code) => `pm.test('status ${code}', () => pm.response.to.have.status(${code}));`;
const errorCode = (c) => `pm.test('error code ${c}', () => pm.expect(pm.response.json().error.code).to.eql('${c}'));`;
const setVar = (name, expr) => `pm.collectionVariables.set('${name}', ${expr});`;

function req(name, method, url, { token, body, tests = [], pre = [] } = {}) {
  return {
    name,
    event: [
      ...(pre.length ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: pre } }] : []),
      { listen: 'test', script: { type: 'text/javascript', exec: tests } },
    ],
    request: {
      method,
      header: [
        ...(token ? [{ key: 'Authorization', value: `Bearer {{${token}}}` }] : []),
        ...(body ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ],
      ...(body && { body: { mode: 'raw', raw: typeof body === 'string' ? body : JSON.stringify(body, null, 2) } }),
      url: `{{baseUrl}}${url}`,
    },
  };
}
const login = (who, email) => req(`Login ${who}`, 'POST', '/api/auth/login', {
  body: { email, password: '{{password}}' }, tests: [status(200), setVar(`tok_${who}`, 'pm.response.json().token')],
});
const requestBody = (title, amountVar) => `{
  "title": "${title}",
  "description": "Created by the Finance Service evidence collection",
  "quantity": 1,
  "suggestedPriority": "HIGH",
  "quotes": [{ "vendorId": "{{vendorId}}", "quoteNumber": "FIN-EV-{{$timestamp}}", "amount": {{${amountVar}}}, "currency": "EGP", "validUntil": "{{validUntil}}", "selected": true }]
}`;

const collection = {
  info: {
    name: 'Finance Service - Evidence (Ziyad Abdalla 225244)',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Finance Approval & Budget Service tests: 200/201, 400, 401, 403, 409. Variables: baseUrl, password.',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:8080' }, { key: 'password', value: '' },
    { key: 'validUntil', value: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10) },
  ],
  item: [
    { name: '0 Setup (logins, vendor, two forwarded requests)', item: [
      login('emp', 'ahmed@procureflow.test'), login('mgr', 'it.manager@procureflow.test'),
      login('mkmgr', 'marketing.manager@procureflow.test'), login('fin', 'finance@procureflow.test'),
      req('Manager profile (IT department id)', 'GET', '/api/auth/me', { token: 'tok_mgr', tests: [status(200), setVar('itDept', 'pm.response.json().user.departmentId')] }),
      req('Active vendor', 'GET', '/api/vendors', { token: 'tok_emp', tests: [status(200), setVar('vendorId', 'pm.response.json().vendors[0].id')] }),
      req('IT budget now (sets the amounts)', 'GET', '/api/finance/budgets/{{itDept}}/current', { token: 'tok_fin', tests: [
        status(200),
        'const b = pm.response.json().budget;',
        "pm.collectionVariables.set('smallAmount', 1000);",
        "pm.collectionVariables.set('reducedAmount', 900);",
        "pm.collectionVariables.set('bigAmount', Math.round(b.remaining) + 5000);",
      ] }),
      req('Employee creates request A (1,000 EGP)', 'POST', '/api/requests', { token: 'tok_emp', body: requestBody('Finance evidence A - keyboards', 'smallAmount'),
        tests: [status(201), setVar('reqA', 'pm.response.json().request.id')] }),
      req('Employee creates request B (more than the IT budget left)', 'POST', '/api/requests', { token: 'tok_emp', body: requestBody('Finance evidence B - servers', 'bigAmount'),
        tests: [status(201), setVar('reqB', 'pm.response.json().request.id')] }),
      req('Manager forwards A', 'POST', '/api/manager/requests/{{reqA}}/forward', { token: 'tok_mgr', body: { finalPriority: 'HIGH', note: 'Approved by IT manager' }, tests: [status(200)] }),
      req('Manager forwards B', 'POST', '/api/manager/requests/{{reqB}}/forward', { token: 'tok_mgr', body: { finalPriority: 'URGENT', note: 'Needed for the data centre' }, tests: [status(200)] }),
    ] },
    { name: '1 Finance Service checks', item: [
      req('F01 No token on the pending queue -> 401', 'GET', '/api/finance/pending', { tests: [status(401)] }),
      req('F02 Employee on the pending queue -> 403', 'GET', '/api/finance/pending', { token: 'tok_emp', tests: [status(403)] }),
      req('F03 Manager on the pending queue -> 403', 'GET', '/api/finance/pending', { token: 'tok_mgr', tests: [status(403)] }),
      req('F04 Pending queue contains A and B (sorted by priority)', 'GET', '/api/finance/pending', { token: 'tok_fin', tests: [
        status(200),
        "const ids = pm.response.json().items.map((i) => i.id);",
        "pm.test('A and B are in the queue', () => { pm.expect(ids).to.include(pm.collectionVariables.get('reqA')); pm.expect(ids).to.include(pm.collectionVariables.get('reqB')); });",
        "pm.test('B is marked over budget', () => pm.expect(pm.response.json().items.find((i) => i.id === pm.collectionVariables.get('reqB')).budgetFit).to.eql('OVER'));",
      ] }),
      req('F05 Dashboard (counters + budget of every department)', 'GET', '/api/finance/dashboard', { token: 'tok_fin', tests: [status(200), "pm.test('4+ departments', () => pm.expect(pm.response.json().budgets.length).to.be.at.least(4));"] }),
      req('F06 Manager reads his own department budget -> 200', 'GET', '/api/finance/budgets/{{itDept}}/current', { token: 'tok_mgr', tests: [status(200)] }),
      req('F07 Manager of Marketing reads the IT budget -> 403', 'GET', '/api/finance/budgets/{{itDept}}/current', { token: 'tok_mkmgr', tests: [status(403)] }),
      req('F08 Approve more than requested -> 400', 'POST', '/api/finance/requests/{{reqA}}/approve', { token: 'tok_fin', body: { amountEgp: 1000000 }, tests: [status(400), errorCode('AMOUNT_ABOVE_REQUESTED')] }),
      req('F09 Approve a reduced amount (900 of 1,000) -> 200', 'POST', '/api/finance/requests/{{reqA}}/approve', { token: 'tok_fin', body: '{ "amountEgp": {{reducedAmount}}, "note": "Approved without the extra cables" }', tests: [status(200), "pm.test('APPROVED', () => pm.expect(pm.response.json().status).to.eql('APPROVED'));"] }),
      req('F10 Decide the same request again -> 409', 'POST', '/api/finance/requests/{{reqA}}/reject', { token: 'tok_fin', body: { reason: 'Second decision attempt' }, tests: [status(409), errorCode('WRONG_STATUS')] }),
      req('F11 Approve B above the remaining budget -> 409', 'POST', '/api/finance/requests/{{reqB}}/approve', { token: 'tok_fin', body: '{ "amountEgp": {{bigAmount}} }', tests: [status(409), errorCode('BUDGET_EXCEEDED')] }),
      req('F12 Ask employee and manager (BOTH) about B -> 200', 'POST', '/api/finance/requests/{{reqB}}/request-info', { token: 'tok_fin', body: { target: 'BOTH', question: 'Can this be split over two months?' }, tests: [status(200)] }),
      req('F13 Reject B while it waits for answers -> 409', 'POST', '/api/finance/requests/{{reqB}}/reject', { token: 'tok_fin', body: { reason: 'Too expensive this month' }, tests: [status(409)] }),
      req('F14 Audit trail of A (DynamoDB, append-only)', 'GET', '/api/finance/audit?requestId={{reqA}}', { token: 'tok_fin', tests: [status(200), "pm.test('APPROVED recorded', () => pm.expect(pm.response.json().trail.map((t) => t.action)).to.include('APPROVED'));"] }),
      req('F15 Allocation below what is already spent -> 409', 'PUT', '/api/finance/budgets/{{itDept}}', { token: 'tok_fin', body: { monthlyAllocation: 0 }, tests: [status(409), errorCode('BELOW_SPENT')] }),
      req('F16 Negative allocation -> 400', 'PUT', '/api/finance/budgets/{{itDept}}', { token: 'tok_fin', body: { monthlyAllocation: -5 }, tests: [status(400)] }),
      req('F17 Add a vendor -> 201', 'POST', '/api/vendors', { token: 'tok_fin', pre: ["pm.collectionVariables.set('vendorName', 'Evidence Supplies ' + Date.now());"], body: '{ "name": "{{vendorName}}", "contactEmail": "sales@evidence.example" }', tests: [status(201)] }),
      req('F18 Same vendor name again -> 409', 'POST', '/api/vendors', { token: 'tok_fin', body: '{ "name": "{{vendorName}}" }', tests: [status(409)] }),
      req('F19 Employee adds a vendor -> 403', 'POST', '/api/vendors', { token: 'tok_emp', body: { name: 'Not allowed Ltd' }, tests: [status(403)] }),
    ] },
  ],
};

const file = path.join(HERE, 'Finance-Service-Evidence.postman_collection.json');
fs.writeFileSync(file, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`written ${path.relative(process.cwd(), file)}`);
