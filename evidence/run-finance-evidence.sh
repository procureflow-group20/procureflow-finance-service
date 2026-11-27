#!/usr/bin/env bash
# Finance Approval & Budget Service - evidence run on Floci (owner: Ziyad Abdalla, 225244).
#
# Run from Git Bash after run-all.sh is done and the website works:
#     bash procureflow-finance-service/evidence/run-finance-evidence.sh
# Redeploys the finance Lambda, runs the tests and saves the AWS outputs in evidence/out-<date-time>/
# JWTs and connection strings are masked before anything is written.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"            # procureflow-finance-service
OUT="$ROOT/evidence/out-$(date +%Y%m%d-%H%M)"
mkdir -p "$OUT"
export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
PASSWORD="${PASSWORD:-Demo123456}"                   # the demo seed password (same for every demo user)
FN=finance-service

mask() { sed -E -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[JWT-MASKED]/g' \
                -e 's#(postgres(ql)?://[^:/ ]+:)[^@ ]+@#\1****@#g'; }
step() { printf '\n\033[1;36m##### %s\033[0m\n' "$*"; }
save() { local f="$OUT/$1"; shift; { echo "\$ $*"; "$@" 2>&1; } | mask | tee "$f"; }   # save <file> <command...>
pause_exit() { read -rp "Press Enter to close..." _; exit "${1:-0}"; }

step "0/9 Checks"
docker info >/dev/null 2>&1 || { echo "Docker is not running."; pause_exit 1; }
[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" = "000000000000" ] \
  || { echo "Floci is not answering on port 4566 (or the floci AWS profile is missing). Run run-all.sh first."; pause_exit 1; }
API_ID="$(aws apigatewayv2 get-apis --query "Items[?Name=='procureflow-api'].ApiId | [0]" --output text)"
[ -n "$API_ID" ] && [ "$API_ID" != "None" ] || { echo "procureflow-api not found. Run run-all.sh first."; pause_exit 1; }
BASE="http://$API_ID.execute-api.localhost.floci.io:4566"
echo "API: $BASE" | tee "$OUT/00-api-url.txt"

step "1/9 Redeploy finance-service (dashboard fix)"
( cd "$ROOT" && npm install --no-audit --no-fund && npm run deploy ) 2>&1 | mask | tee "$OUT/01-deploy.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "deploy failed - see $OUT/01-deploy.txt"; pause_exit 1; }
for i in $(seq 1 20); do curl -s -m 15 "$BASE/api/finance/health" | grep -q '"ok"' && break; sleep 3; done
save 01b-health.txt curl -s -m 15 "$BASE/api/finance/health"

step "2/9 Postman collection (19 finance checks)"
( cd "$ROOT" && npx --yes newman@6 run tests/Finance-Service-Evidence.postman_collection.json \
    --env-var "baseUrl=$BASE" --env-var "password=$PASSWORD" --reporters cli --color off --timeout-request 30000 ) \
  2>&1 | mask | tee "$OUT/02-postman-finance.txt"

step "3/9 Two approvals at the same moment (budget race)"
( cd "$ROOT" && BASE_URL="$BASE" PASSWORD="$PASSWORD" node tests/concurrent-approve.mjs ) 2>&1 | mask | tee "$OUT/03-concurrent-approve.txt"

step "4/9 Lambda configuration"
{
  save 04a-lambda-config.txt aws lambda get-function-configuration --function-name "$FN" \
    --query '{Function:FunctionName,Runtime:Runtime,MemoryMB:MemorySize,TimeoutSec:Timeout,Role:Role,Env:Environment.Variables}' --output json
  save 04b-lambda-concurrency.txt aws lambda get-function-concurrency --function-name "$FN"
} >/dev/null

step "5/9 IAM least privilege (finance-service-role)"
save 05-iam-policy.txt aws iam get-role-policy --role-name finance-service-role --policy-name finance-service-role-policy --output json >/dev/null

step "6/9 DynamoDB audit log"
REQ_A="$(grep -oE 'requests/[0-9a-f-]{36}/approve' "$OUT/02-postman-finance.txt" | head -1 | cut -d/ -f2)"
{
  save 06a-audit-table.txt aws dynamodb describe-table --table-name finance-audit-log \
    --query 'Table.{Name:TableName,Status:TableStatus,Keys:KeySchema,Billing:BillingModeSummary.BillingMode,Items:ItemCount}' --output json
  save 06b-audit-pitr.txt aws dynamodb describe-continuous-backups --table-name finance-audit-log --output json
  if [ -n "$REQ_A" ]; then
    save 06c-audit-items.txt aws dynamodb query --table-name finance-audit-log \
      --key-condition-expression 'requestId = :r' --expression-attribute-values "{\":r\":{\"S\":\"$REQ_A\"}}" --output json
  fi
} >/dev/null

step "7/9 EventBridge rules and targets"
{
  save 07a-rule-forwarded.txt aws events describe-rule --name forwarded-to-finance --event-bus-name procureflow-events --output json
  save 07b-rule-forwarded-targets.txt aws events list-targets-by-rule --rule forwarded-to-finance --event-bus-name procureflow-events --output json
  save 07c-rule-rollover.txt aws events describe-rule --name budget-rollover --output json
  save 07d-rule-rollover-targets.txt aws events list-targets-by-rule --rule budget-rollover --output json
} >/dev/null

step "8/9 CloudWatch logs, metric filters and alarms"
SINCE=$(( ($(date +%s) - 3600) * 1000 ))
{
  save 08a-metric-filters.txt aws logs describe-metric-filters --log-group-name "/aws/lambda/$FN" \
    --query 'metricFilters[].{Name:filterName,Pattern:filterPattern,Metric:metricTransformations[0].metricName}' --output table
  save 08b-alarms.txt aws cloudwatch describe-alarms --alarm-name-prefix procureflow- \
    --query 'MetricAlarms[].[AlarmName,MetricName,Threshold,StateValue]' --output table
  save 08c-log-budget-exceeded.txt aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --start-time "$SINCE" \
    --filter-pattern '{ $.action = "BUDGET_EXCEEDED" }' --query 'events[-5:].message' --output text
  save 08d-log-403.txt aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --start-time "$SINCE" \
    --filter-pattern '{ $.action = "HTTP_403" }' --query 'events[-5:].message' --output text
  save 08e-log-approved.txt aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --start-time "$SINCE" \
    --filter-pattern '{ $.action = "REQUEST_APPROVED" }' --query 'events[-5:].message' --output text
} >/dev/null
echo "saved 08a..08e"

step "9/9 Dashboard stress test (k6) + repository secret scan"
if command -v k6 >/dev/null 2>&1; then
  ( cd "$ROOT" && k6 run -e BASE_URL="$BASE" -e PASSWORD="$PASSWORD" -e LEVELS=5,10,15,20 -e STEP=20 \
      --summary-export "$OUT/09a-k6-dashboard-summary.json" tests/dashboard-stress-k6.js ) 2>&1 | mask | tee "$OUT/09a-k6-dashboard.txt"
  mask < "$OUT/09a-k6-dashboard-summary.json" > "$OUT/tmp.json" && mv "$OUT/tmp.json" "$OUT/09a-k6-dashboard-summary.json"
else
  echo "k6 not installed - skipped (install: winget install k6 --source winget)" | tee "$OUT/09a-k6-dashboard.txt"
fi
if git -C "$ROOT" rev-parse >/dev/null 2>&1; then
  {
    echo "commit: $(git -C "$ROOT" log -1 --format='%H  %an  %ad  %s' --date=short)"
    echo "remote: $(git -C "$ROOT" remote get-url origin 2>/dev/null || echo none)"
    echo; echo "tracked files that must NOT be in git (.env, lambda.zip, node_modules):"
    git -C "$ROOT" ls-files | grep -E '(^|/)\.env$|lambda\.zip|node_modules/' || echo "  none"
    echo; echo "secret patterns in tracked files (connection strings with passwords, JWTs, AWS keys, Neon passwords):"
    git -C "$ROOT" grep -nIE 'postgres(ql)?://[^:/ ]+:[^@ ]+@|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|npg_[A-Za-z0-9]{8,}' -- . ':!evidence/out-*' || echo "  none"
  } | tee "$OUT/09b-secret-scan.txt"
fi

echo; echo "JWTs left in the evidence folder (must be 0): $(grep -rlE 'eyJ[A-Za-z0-9_-]{10,}\.' "$OUT" | wc -l)"
printf '\n\033[1;32mDONE.\033[0m Evidence saved in: %s\n' "$OUT"
pause_exit 0
