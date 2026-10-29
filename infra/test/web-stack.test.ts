import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CertificateStack } from '../lib/certificate-stack.js';
import { STAGES } from '../lib/config.js';
import { SPA_REWRITE_CODE, WebStack } from '../lib/web-stack.js';

const account = '123456789012';
const zoneId = 'Z0000000000000000000';

const synth = (stage: keyof typeof STAGES, webBuildDir: string | false = false) => {
  const app = new App();
  const config = STAGES[stage];
  const cert = new CertificateStack(app, `T-${stage}-CertCloudFront`, {
    config,
    purpose: 'cloudfront',
    hostedZoneId: zoneId,
    crossRegionReferences: true,
    env: { account, region: 'us-east-1' },
  });
  const secrets = new Stack(app, `T-${stage}-Secrets`, {
    env: { account, region: 'ap-northeast-1' },
  });
  const originVerifySecret = new Secret(secrets, 'OriginVerify');
  const stack = new WebStack(app, `T-${stage}-Web`, {
    config,
    certificate: cert.certificate,
    originVerifySecret,
    webBuildDir,
    hostedZoneId: zoneId,
    crossRegionReferences: true,
    env: { account, region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
};

type Behavior = {
  PathPattern?: string;
  TargetOriginId: string;
  CachePolicyId: string;
  OriginRequestPolicyId?: string;
  ViewerProtocolPolicy: string;
  AllowedMethods?: string[];
  FunctionAssociations?: unknown[];
};
type DistConfig = {
  Aliases: string[];
  ViewerCertificate: Record<string, unknown>;
  HttpVersion: string;
  PriceClass: string;
  DefaultRootObject: string;
  DefaultCacheBehavior: Behavior;
  CacheBehaviors: Behavior[];
  Origins: {
    Id: string;
    DomainName: unknown;
    S3OriginConfig?: unknown;
    OriginAccessControlId?: unknown;
    CustomOriginConfig?: Record<string, unknown>;
    OriginCustomHeaders?: { HeaderName: string; HeaderValue: unknown }[];
  }[];
};
const distConfig = (t: Template): DistConfig =>
  (
    Object.values(t.findResources('AWS::CloudFront::Distribution'))[0] as {
      Properties: { DistributionConfig: DistConfig };
    }
  ).Properties.DistributionConfig;

// マネージドポリシーの ID（AWS 公開値）
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const ALL_VIEWER_EXCEPT_HOST_HEADER = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

describe('WebStack', () => {
  it('独自ドメイン・us-east-1 の証明書・TLS 1.2 以上・HTTP/2 と HTTP/3・PriceClass 200', () => {
    const c = distConfig(synth('dev'));
    expect(c.Aliases).toEqual(['dev.super-ai-schedule-app.com']);
    expect(c.ViewerCertificate).toMatchObject({
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
    expect(c.ViewerCertificate.AcmCertificateArn).toBeDefined();
    expect(c.HttpVersion).toBe('http2and3');
    expect(c.PriceClass).toBe('PriceClass_200');
    expect(c.DefaultRootObject).toBe('index.html');
  });

  it('既定は S3（OAC・キャッシュあり・HTTPS へ転送）で、画面パスの読み替えはここだけに付く', () => {
    const c = distConfig(synth('dev'));
    const d = c.DefaultCacheBehavior;
    expect(d.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(d.CachePolicyId).toBe(CACHING_OPTIMIZED);
    expect(d.FunctionAssociations).toHaveLength(1);
    expect(d.FunctionAssociations![0]).toMatchObject({ EventType: 'viewer-request' });
    const s3 = c.Origins.find((o) => o.Id === d.TargetOriginId)!;
    expect(s3.OriginAccessControlId).toBeDefined();
    for (const b of c.CacheBehaviors) expect(b.FunctionAssociations).toBeUndefined();
  });

  it('/api/* と /agent/* は ALB（origin.<appDomain>）へ、キャッシュなし・全メソッド・HTTPS のみ', () => {
    const c = distConfig(synth('dev'));
    expect(c.CacheBehaviors.map((b) => b.PathPattern)).toEqual(['/api/*', '/agent/*']);
    for (const b of c.CacheBehaviors) {
      expect(b.CachePolicyId).toBe(CACHING_DISABLED);
      expect(b.ViewerProtocolPolicy).toBe('https-only');
      expect(b.AllowedMethods).toHaveLength(7);
      // Authorization・検索条件・Cookie を渡す（Host 以外のヘッダーをすべて渡すマネージドポリシー）
      expect(b.OriginRequestPolicyId).toBe(ALL_VIEWER_EXCEPT_HOST_HEADER);
      const origin = c.Origins.find((o) => o.Id === b.TargetOriginId)!;
      expect(origin.DomainName).toBe('origin.dev.super-ai-schedule-app.com');
      expect(origin.CustomOriginConfig).toMatchObject({
        OriginProtocolPolicy: 'https-only',
        OriginSSLProtocols: ['TLSv1.2'],
      });
    }
  });

  it('ALB へは秘密のヘッダーを付け、値はデプロイ時に Secrets Manager から読む', () => {
    const c = distConfig(synth('dev'));
    const api = c.Origins.find((o) => o.CustomOriginConfig)!;
    expect(api.OriginCustomHeaders).toHaveLength(1);
    expect(api.OriginCustomHeaders![0]!.HeaderName).toBe('X-Origin-Verify');
    expect(JSON.stringify(api.OriginCustomHeaders![0]!.HeaderValue)).toContain(
      '{{resolve:secretsmanager:',
    );
  });

  it('S3 は非公開・暗号化・HTTPS のみ・バージョニングあり', () => {
    const t = synth('dev');
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    const statements = Object.values(t.findResources('AWS::S3::BucketPolicy')).flatMap(
      (p) =>
        (
          p as {
            Properties: {
              PolicyDocument: {
                Statement: { Effect: string; Principal: unknown; Condition?: unknown }[];
              };
            };
          }
        ).Properties.PolicyDocument.Statement,
    );
    // 誰にでも許可する文がない（HTTPS 以外を拒否する文は Principal が * の Deny）
    const isAnyone = (p: unknown) => p === '*' || JSON.stringify(p) === '{"AWS":"*"}';
    expect(statements.filter((s) => s.Effect === 'Allow' && isAnyone(s.Principal))).toEqual([]);
    expect(
      statements.some(
        (s) => s.Effect === 'Deny' && JSON.stringify(s.Condition).includes('aws:SecureTransport'),
      ),
    ).toBe(true);
    // CloudFront からの読み取りは、この配信からだけに限る（OAC）
    const oac = statements.find(
      (s) => JSON.stringify(s.Principal) === '{"Service":"cloudfront.amazonaws.com"}',
    )!;
    expect(oac.Effect).toBe('Allow');
    expect(JSON.stringify(oac.Condition)).toContain('AWS:SourceArn');
  });

  it('画面パスの読み替え：拡張子のない URL だけを /index.html にする', () => {
    const handler = new Function(`${SPA_REWRITE_CODE}; return handler;`)() as (e: {
      request: { uri: string };
    }) => { uri: string };
    const run = (uri: string) => handler({ request: { uri } }).uri;
    expect(run('/')).toBe('/index.html');
    expect(run('/plans/123')).toBe('/index.html');
    expect(run('/settings/')).toBe('/index.html');
    expect(run('/main.dart.js')).toBe('/main.dart.js');
    expect(run('/assets/fonts/a.ttf')).toBe('/assets/fonts/a.ttf');
    expect(run('/assets/NOTICES')).toBe('/assets/NOTICES'); // 拡張子のない実ファイル
  });

  it('dev.<ドメイン> の A・AAAA を CloudFront に向ける', () => {
    const t = synth('dev');
    for (const type of ['A', 'AAAA']) {
      t.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'dev.super-ai-schedule-app.com.',
        Type: type,
        AliasTarget: Match.objectLike({ HostedZoneId: Match.anyValue() }),
      });
    }
  });

  it('画面ファイルはビルド済みのときだけ配置し、キャッシュを消す', () => {
    expect(Object.keys(synth('dev').findResources('Custom::CDKBucketDeployment'))).toHaveLength(0);
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      synth('dev', dir).hasResourceProperties('Custom::CDKBucketDeployment', {
        Prune: true,
        DistributionPaths: ['/*'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('本番のバケットは削除時も残す', () => {
    synth('prod').hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });
});
