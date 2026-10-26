import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { STAGES } from '../lib/config.js';
import { CertificateStack } from '../lib/certificate-stack.js';

const synth = (stage: keyof typeof STAGES, purpose: 'cloudfront' | 'alb') =>
  Template.fromStack(
    new CertificateStack(new App(), `Test-${stage}-${purpose}`, {
      config: STAGES[stage],
      purpose,
      hostedZoneId: 'Z0000000000000000000',
      env: {
        account: '123456789012',
        region: purpose === 'cloudfront' ? 'us-east-1' : 'ap-northeast-1',
      },
    }),
  );

describe('CertificateStack', () => {
  it('dev は dev.<ドメイン> とそのサブドメインの証明書を DNS 検証で作る', () => {
    synth('dev', 'cloudfront').hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'dev.super-ai-schedule-app.com',
      SubjectAlternativeNames: ['*.dev.super-ai-schedule-app.com'],
      ValidationMethod: 'DNS',
    });
  });

  it('本番はドメインそのものを対象にする', () => {
    synth('prod', 'alb').hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'super-ai-schedule-app.com',
    });
  });
});
