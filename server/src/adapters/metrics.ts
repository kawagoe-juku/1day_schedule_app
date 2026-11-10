/**
 * 外部 API の呼び出し回数のメトリクス。
 * CloudWatch の Embedded Metric Format（EMF）の1行を標準出力に書く。ECS のログ（CloudWatch Logs）に
 * 入ると、CloudWatch がメトリクスとして取り込む（SDK の呼び出しや IAM の追加は不要）。
 */

/** 呼び出し1回（リトライも1回ずつ数える）の結果 */
export type CallOutcome = 'success' | 'client_error' | 'server_error' | 'timeout' | 'network_error';

export interface ExternalApiCall {
  /** 呼び出し先（google_maps・navitime など） */
  service: string;
  /** API の種類（geocode・route_transit など） */
  operation: string;
  outcome: CallOutcome;
  durationMs: number;
}

export interface ExternalApiMetrics {
  record(call: ExternalApiCall): void;
}

/** 何も出さない（テストや、メトリクスが要らない場面用） */
export const noopMetrics: ExternalApiMetrics = { record() {} };

export interface EmfMetricsOptions {
  /** 環境名（dev・stg・prod）。メトリクスを環境ごとに分ける */
  stage?: string;
  /** 出力先（既定は標準出力）。1回の呼び出しで JSON 1行を渡す */
  write?: (line: string) => void;
  now?: () => number;
}

export const METRICS_NAMESPACE = 'ScheduleApp/ExternalApi';

export function createEmfMetrics(options: EmfMetricsOptions = {}): ExternalApiMetrics {
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const stage = options.stage ?? 'local';
  return {
    record(call) {
      write(
        JSON.stringify({
          _aws: {
            Timestamp: now(),
            CloudWatchMetrics: [
              {
                Namespace: METRICS_NAMESPACE,
                // 呼び出し先ごとの合計と、API・結果ごとの内訳の両方を見られるようにする
                Dimensions: [
                  ['Stage', 'Service'],
                  ['Stage', 'Service', 'Operation', 'Outcome'],
                ],
                Metrics: [
                  { Name: 'CallCount', Unit: 'Count' },
                  { Name: 'DurationMs', Unit: 'Milliseconds' },
                ],
              },
            ],
          },
          Stage: stage,
          Service: call.service,
          Operation: call.operation,
          Outcome: call.outcome,
          CallCount: 1,
          DurationMs: Math.round(call.durationMs),
        }),
      );
    },
  };
}
