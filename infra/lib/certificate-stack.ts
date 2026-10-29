import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import { lookupZone } from './common.js';
import type { StageConfig } from './config.js';

export interface CertificateStackProps extends StackProps {
  readonly config: StageConfig;
  /** 証明書の用途。CloudFront 用は us-east-1、ALB 用は東京に作る */
  readonly purpose: 'cloudfront' | 'alb';
  /** テスト用。指定しない場合は Route 53 からホストゾーンを検索する */
  readonly hostedZoneId?: string;
}

/**
 * HTTPS 用の証明書（ACM）を DNS 検証で発行する。
 *
 * - 対象は `<appDomain>` と `*.<appDomain>`（ALB のオリジン名などのサブドメイン用）。
 * - DNS 検証レコードは Route 53 のホストゾーンに自動で登録される。
 * - 証明書は Web・App スタックへオブジェクトとして渡す。
 */
export class CertificateStack extends Stack {
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, props);
    const { stage, appDomain } = props.config;

    this.certificate = new Certificate(this, 'Certificate', {
      domainName: appDomain,
      subjectAlternativeNames: [`*.${appDomain}`],
      validation: CertificateValidation.fromDns(lookupZone(this, props.hostedZoneId)),
      certificateName: `schedule-app-${stage}-${props.purpose}`,
    });
  }
}
