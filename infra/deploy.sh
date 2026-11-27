#!/usr/bin/env bash
# Deploys the Finance Approval & Budget Service to Floci (owner: Ziyad Abdalla).
#   npm run deploy        (from the procureflow-finance-service folder)
source "$(dirname "$0")/../../procureflow-shared/infra/common.sh"
cd "$(dirname "$0")/.."
FN=finance-service

say "DynamoDB table finance-audit-log (append-only)"
aws dynamodb create-table --table-name finance-audit-log \
  --attribute-definitions AttributeName=requestId,AttributeType=S AttributeName=ts,AttributeType=S \
  --key-schema AttributeName=requestId,KeyType=HASH AttributeName=ts,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST >/dev/null 2>&1 || true
aws dynamodb update-continuous-backups --table-name finance-audit-log \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null 2>&1 || true
ok "finance-audit-log (point-in-time recovery requested)"

say "Lambda $FN"
npm run zip --silent >/dev/null
ensure_lambda_role "$FN-role" infra/policy.json
deploy_lambda "$FN" lambda.zip "$FN-role" "$(common_env "$FN" procureflow/finance/db),AUDIT_TABLE=finance-audit-log"
register_routes "$FN" infra/routes.txt

say "EventBridge rules"
rule_to_lambda forwarded-to-finance "$BUS_NAME" \
  '{"source":["procureflow.manager"],"detail-type":["RequestForwarded"]}' "" "$FN"
rule_to_lambda budget-rollover default "" "cron(5 22 L * ? *)" "$FN"   # 00:05 Cairo on the 1st (22:05 UTC on the last day)

say "Monitoring"
metric_filter "/aws/lambda/$FN" BudgetExceeded409 BUDGET_EXCEEDED
metric_filter "/aws/lambda/$FN" Forbidden403Finance HTTP_403
metric_filter "/aws/lambda/$FN" AuditWriteFailed AUDIT_WRITE_FAILED
alarm procureflow-budget-exceeded BudgetExceeded409 3
alarm procureflow-finance-403 Forbidden403Finance 10
alarm procureflow-audit-write-failed AuditWriteFailed 0

echo; echo "Finance Approval & Budget Service deployed: $(api_url)/api/finance/health"
