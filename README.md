# Finance Approval & Budget Service (Ziyad Abdalla, 225244)

Part of ProcureFlow, Group 20. This service is used by the finance officer. After a manager forwards a request, finance can approve it (full amount or less), reject it, or ask the employee / manager for more information. It also keeps the monthly budget of every department and the vendor list.

## Endpoints

| Function | Endpoints |
|---|---|
| F1 Pending approvals dashboard (sorted by priority, then waiting time, with the budget of each department) | `GET /api/finance/pending`, `GET /api/finance/dashboard`, `GET /api/finance/requests/{id}` |
| F2 Decide on a request: approve full or reduced amount, reject, request info (employee, manager or both) | `POST /api/finance/requests/{id}/approve`, `/reject`, `/request-info` |
| F3 Monthly budgets (new month opens automatically) and departments | `GET /api/finance/budgets`, `GET /api/finance/budgets/{deptId}/current`, `PUT /api/finance/budgets/{deptId}`, `GET/POST /api/finance/departments` |
| Other: vendors and audit log | `GET/POST /api/vendors`, `PATCH /api/vendors/{id}`, `GET /api/finance/audit` |

## How we make sure the budget is never overspent

Approve runs in one transaction. First the request row is locked, then:

```sql
UPDATE budgets SET spent = spent + $amount
WHERE department_id = $dept AND period = $month AND allocated - spent >= $amount
```

If no row is updated, there is not enough budget left, so we roll back and return `409 BUDGET_EXCEEDED`. The table also has `CHECK (spent <= allocated)`. I tested two approvals at the same moment: one gets 200 and the other gets 409.

## AWS services

- Lambda `finance-service` with its own IAM role `finance-service-role`
- DynamoDB `finance-audit-log` (append only: the role can only PutItem and Query, UpdateItem and DeleteItem are denied)
- EventBridge: rule `forwarded-to-finance` (gets `RequestForwarded` from the manager service) and the monthly rule `budget-rollover`. The service publishes `RequestApproved`, `RequestRejected` and `InfoRequested`.
- Secrets Manager: `procureflow/finance/db`
- CloudWatch: metric filters `BudgetExceeded409`, `Forbidden403Finance`, `AuditWriteFailed` with alarms

## Security

- Every route needs the FINANCE role. A manager can only read his own department's current budget.
- Approved amount must be more than 0 and not more than the requested amount.
- Decisions can't be edited: the DB role `finance_svc` has no UPDATE/DELETE on `decisions`.
- Every finance action goes to the audit log with the approver id taken from the JWT.

## Dashboard problem we found with k6

In the first Floci load test the dashboard failed 12% of the requests. The old version did about 6 DB round trips per call (open the month's budgets, re-sync the queue, then 4 queries) with a pool of only 2 connections, so the Lambda reached its reserved concurrency (10) and extra calls were refused.

What I changed: the month's budgets are opened once per container per month, the queue re-sync runs at most once a minute, and the dashboard is now a single SQL query. On Floci after the fix: 0% failed at 10 and 15 req/s, 0.5% at 20 req/s (all 503, no 429).

## Files

```
src/app.js      routes and rules             src/budget.js   monthly periods
src/queue.js    finance queue                src/audit.js    DynamoDB audit log
src/jobs.js     EventBridge handlers         lambda.js       Lambda entry (HTTP + events)
infra/deploy.sh creates the table, IAM role, Lambda, routes, rules and alarms on Floci (npm run deploy)
```

Run locally: `cp .env.example .env && npm install && npm run dev` (port 3003). Monthly job by hand: `npm run job:rollover`.

## Tests

| File | What it checks |
|---|---|
| `tests/Finance-Service-Evidence.postman_collection.json` | 19 checks: 401, 403 (employee, manager, other department), 400, 409 (decided twice, over budget, allocation below spent), vendors 201/409/403. You can rebuild it with `node tests/make-postman.mjs` |
| `tests/concurrent-approve.mjs` | two approvals at the same time, one 200 and one 409 |
| `tests/dashboard-stress-k6.js` | fixed req/s on the dashboard and the status code of every failure |
| `evidence/run-finance-evidence.sh` | runs everything on Floci and saves the AWS outputs in `evidence/out-*` (tokens are masked) |
