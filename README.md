# Finance Approval & Budget Service - owner: Ziyad Abdalla (225244)

Part of **ProcureFlow** (Group 20). Finance officers approve forwarded requests against the department's monthly
budget, reject or ask for more information, and manage budgets and vendors.

| Function | Endpoints |
|---|---|
| F1 Pending-approvals dashboard (sorted by final priority, then waiting time; budget per department) | `GET /api/finance/pending`, `GET /api/finance/dashboard`, `GET /api/finance/requests/{id}` |
| F2 Decide: approve full or reduced amount (atomic budget check), reject, request info (employee / manager / both) | `POST /api/finance/requests/{id}/approve`, `/reject`, `/request-info` |
| F3 Manage monthly budgets (automatic monthly rollover) and departments | `GET /api/finance/budgets`, `GET /api/finance/budgets/{deptId}/current`, `PUT /api/finance/budgets/{deptId}`, `GET/POST /api/finance/departments` |
| Other: vendors, audit log | `GET/POST /api/vendors`, `PATCH /api/vendors/{id}`, `GET /api/finance/audit` |

**How approval cannot overspend:** in one transaction the request row is locked, then
`UPDATE budgets SET spent = spent + $amount WHERE ... AND allocated - spent >= $amount` - if no row is updated the
budget is not enough -> rollback + `409 BUDGET_EXCEEDED`. The database also has `CHECK (spent <= allocated)`.
Two officers approving at the same moment are serialised by the row lock (tested: one 200, one 409).

**AWS services used by this component:** Lambda (`finance-service`), DynamoDB (`finance-audit-log`, append-only:
IAM allows PutItem/Query and explicitly denies UpdateItem/DeleteItem), EventBridge (rule `forwarded-to-finance`
consumes `RequestForwarded`; scheduled rule `budget-rollover` on the 1st of every month; publishes `RequestApproved`,
`RequestRejected`, `InfoRequested`), Secrets Manager (`procureflow/finance/db`), CloudWatch (metric filters
`BudgetExceeded409`, `Forbidden403Finance`, `AuditWriteFailed` with alarms), IAM role `finance-service-role`.

**Security in this service:** FINANCE role on every route (managers may read only their own department's current
budget); 0 < approved amount <= requested; decisions can never be edited (database role `finance_svc` has no
UPDATE/DELETE on `decisions`); every finance action is written to the audit log with the approver id from the JWT.

```
src/app.js     routes + rules           src/budget.js  monthly periods        src/queue.js  finance queue (event + reconcile)
src/audit.js   DynamoDB audit log       src/jobs.js    event handlers         lambda.js     entry (HTTP + events)
infra/deploy.sh  table, IAM, Lambda, routes, rules, alarms on Floci  (npm run deploy)
```
Local run: `cp .env.example .env && npm install && npm run dev` (port 3003); job: `npm run job:rollover`.
