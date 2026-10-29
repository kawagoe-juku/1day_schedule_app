import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DOMAIN } from './config.js';

/** リポジトリのルート（Docker イメージと画面ファイルの場所の基準） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** サーバへ転送するパス（CloudFront と ALB で共通） */
export const API_PATHS: readonly string[] = ['/api/*', '/agent/*'];

/** Route 53 のホストゾーン。hostedZoneId はテスト用（指定しない場合は検索する） */
export const lookupZone = (scope: Construct, hostedZoneId?: string): IHostedZone =>
  hostedZoneId
    ? HostedZone.fromHostedZoneAttributes(scope, 'Zone', { hostedZoneId, zoneName: ROOT_DOMAIN })
    : HostedZone.fromLookup(scope, 'Zone', { domainName: ROOT_DOMAIN });

/** スタックを消したときにリソースを残すか（config の retainOnDelete） */
export const removalPolicyOf = (retain: boolean): RemovalPolicy =>
  retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

/** ログの保持日数を CloudWatch Logs の設定値に変換する（config は 30 / 90 日を使う） */
export const toRetentionDays = (days: number): RetentionDays => {
  const map: Record<number, RetentionDays> = {
    30: RetentionDays.ONE_MONTH,
    90: RetentionDays.THREE_MONTHS,
  };
  const value = map[days];
  if (value === undefined) throw new Error(`未対応のログ保持日数です: ${days}`);
  return value;
};
