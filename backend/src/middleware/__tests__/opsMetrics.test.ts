import { beforeEach, describe, expect, it } from 'vitest'
import { _resetOpsMetricsForTests, recordRequestMetric, renderPrometheus } from '../opsMetrics'

beforeEach(() => { _resetOpsMetricsForTests() })

describe('ops metrics', () => {
  it('counts requests, 5xx errors, and a cumulative latency histogram', () => {
    recordRequestMetric('/api/ping', 200, 40)
    recordRequestMetric('/api/ping', 500, 800)
    recordRequestMetric('/api/agent/c/stream', 200, 3000)
    recordRequestMetric('/health', 200, 1)
    recordRequestMetric('/ready', 200, 1)
    const text = renderPrometheus({ dbUp: 1, dailyPending: 4, apiPending: 0, dailyStale: 2, apiStale: 0 })
    expect(text).toContain('loop_http_requests_total{kind="http"} 2')
    expect(text).toContain('loop_http_errors_total{kind="http"} 1')
    expect(text).toContain('loop_http_requests_total{kind="stream"} 1')
    expect(text).toContain('loop_http_request_duration_ms_bucket{kind="http",le="50"} 1')
    expect(text).toContain('loop_http_request_duration_ms_bucket{kind="http",le="1000"} 2')
    expect(text).toContain('loop_http_request_duration_ms_bucket{kind="stream",le="2500"} 0')
    expect(text).toContain('loop_http_request_duration_ms_bucket{kind="stream",le="5000"} 1')
    expect(text).toContain('loop_db_up 1')
    expect(text).toContain('loop_settlement_pending{ledger="daily"} 4')
    expect(text).toContain('loop_settlement_stale{ledger="daily"} 2')
    expect(text).not.toContain('/health')
  })
})
