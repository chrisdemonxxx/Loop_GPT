/**
 * Process-local request counters and a latency histogram. No extra
 * dependency: GET /metrics renders Prometheus text from these numbers.
 * Health probes are omitted so they don't flatten the latency signal.
 */

const BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000]
export type MetricKind = 'http' | 'stream'

interface Series {
  count: number
  errors: number
  clientErrors: number
  sumMs: number
  /** Cumulative counts per BUCKETS_MS entry, plus an implicit +Inf. */
  buckets: number[]
}

function emptySeries(): Series {
  return { count: 0, errors: 0, clientErrors: 0, sumMs: 0, buckets: BUCKETS_MS.map(() => 0) }
}

const series: Record<MetricKind, Series> = { http: emptySeries(), stream: emptySeries() }

export function metricKind(path: string): MetricKind | null {
  if (path === '/metrics' || path === '/health' || path === '/ready') return null
  return /\/(stream|events)(\/|$)/.test(path) ? 'stream' : 'http'
}

export function recordRequestMetric(path: string, status: number, durationMs: number): void {
  const kind = metricKind(path)
  if (!kind) return
  const row = series[kind]
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  row.count += 1
  row.sumMs += duration
  if (status >= 500) row.errors += 1
  else if (status >= 400) row.clientErrors += 1
  for (let i = 0; i < BUCKETS_MS.length; i++) {
    if (duration <= BUCKETS_MS[i]) row.buckets[i] += 1
  }
}

export function _resetOpsMetricsForTests(): void {
  series.http = emptySeries()
  series.stream = emptySeries()
}

export interface OpsGauges {
  dbUp: number
  dailyPending: number
  apiPending: number
  dailyStale: number
  apiStale: number
}

function line(name: string, labels: string, value: number): string {
  const metric = labels ? `${name}{${labels}}` : name
  return `${metric} ${Number.isFinite(value) ? value : 0}`
}

/** Prometheus text exposition. Gauges are filled in by the /metrics handler. */
export function renderPrometheus(gauges: OpsGauges): string {
  const lines: string[] = [
    '# HELP loop_http_requests_total Completed requests, excluding health probes.',
    '# TYPE loop_http_requests_total counter',
    '# HELP loop_http_errors_total Completed requests with HTTP status >= 500.',
    '# TYPE loop_http_errors_total counter',
    '# HELP loop_http_client_errors_total Completed requests with HTTP status 400-499.',
    '# TYPE loop_http_client_errors_total counter',
    '# HELP loop_http_request_duration_ms Request duration histogram in milliseconds.',
    '# TYPE loop_http_request_duration_ms histogram',
  ]
  for (const kind of ['http', 'stream'] as const) {
    const row = series[kind]
    const label = `kind="${kind}"`
    lines.push(line('loop_http_requests_total', label, row.count))
    lines.push(line('loop_http_errors_total', label, row.errors))
    lines.push(line('loop_http_client_errors_total', label, row.clientErrors))
    // recordRequestMetric stores cumulative bucket counts.
    for (let i = 0; i < BUCKETS_MS.length; i++) {
      lines.push(line('loop_http_request_duration_ms_bucket', `${label},le="${BUCKETS_MS[i]}"`, row.buckets[i]))
    }
    lines.push(line('loop_http_request_duration_ms_bucket', `${label},le="+Inf"`, row.count))
    lines.push(line('loop_http_request_duration_ms_sum', label, Math.round(row.sumMs)))
    lines.push(line('loop_http_request_duration_ms_count', label, row.count))
  }
  lines.push(
    '# HELP loop_db_up 1 when the API can run a query against Postgres.',
    '# TYPE loop_db_up gauge',
    line('loop_db_up', '', gauges.dbUp),
    '# HELP loop_settlement_pending Settlement intents in pending or processing.',
    '# TYPE loop_settlement_pending gauge',
    line('loop_settlement_pending', 'ledger="daily"', gauges.dailyPending),
    line('loop_settlement_pending', 'ledger="api"', gauges.apiPending),
    '# HELP loop_settlement_stale Pending or processing intents older than 10 minutes.',
    '# TYPE loop_settlement_stale gauge',
    line('loop_settlement_stale', 'ledger="daily"', gauges.dailyStale),
    line('loop_settlement_stale', 'ledger="api"', gauges.apiStale),
    '',
  )
  return lines.join('\n')
}
