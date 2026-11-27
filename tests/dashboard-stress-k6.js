// Finance dashboard stress test (owner: Ziyad Abdalla). Sends a fixed number of requests per second
// to GET /api/finance/dashboard, 30 s per level (5 -> 40 req/s), to find the highest load without errors.
//   k6 run -e BASE_URL=<api url> -e PASSWORD=<seed password> tests/dashboard-stress-k6.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const LEVELS = (__ENV.LEVELS || '5,10,15,20,30,40').split(',').map(Number);
const STEP = Number(__ENV.STEP || 30);
const BASE = __ENV.BASE_URL;
const codes = new Counter('status_codes');

const scenarios = {};
const thresholds = {};
LEVELS.forEach((rate, i) => {
  const name = `rps_${String(rate).padStart(3, '0')}`;
  scenarios[name] = {
    executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration: `${STEP}s`,
    startTime: `${i * (STEP + 5)}s`, preAllocatedVUs: Math.max(10, rate * 2), maxVUs: rate * 6,
  };
  // listed only to print one line per level in the summary (never fail the run)
  thresholds[`http_req_duration{scenario:${name}}`] = ['p(95)>=0'];
  thresholds[`http_req_failed{scenario:${name}}`] = ['rate>=0'];
});
['200', '401', '429', '500', '502', '503', '504'].forEach((c) => { thresholds[`status_codes{code:${c}}`] = ['count>=0']; });
export const options = { scenarios, thresholds, summaryTrendStats: ['med', 'p(95)', 'max'] };

export function setup() {
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: 'finance@procureflow.test', password: __ENV.PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
  return { token: r.json('token') };
}

export default function (t) {
  const r = http.get(`${BASE}/api/finance/dashboard`, { headers: { Authorization: `Bearer ${t.token}` } });
  codes.add(1, { code: String(r.status) });
  check(r, { 'dashboard 200': (x) => x.status === 200 });
}
