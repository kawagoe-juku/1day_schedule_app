import {
  Annotations,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  Function as CfFunction,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  OriginSslPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
  type BehaviorOptions,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  AaaaRecord,
  ARecord,
  HostedZone,
  RecordTarget,
  type IHostedZone,
} from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN_VERIFY_HEADER, originDomain } from './app-stack.js';
import { PROJECT, ROOT_DOMAIN, type StageConfig } from './config.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Flutter Web のビルド成果物（`flutter build web` の出力先） */
export const DEFAULT_WEB_BUILD_DIR = join(REPO_ROOT, 'app/build/web');

/** API としてサーバ（ALB）へ転送するパス */
export const API_PATHS = ['/api/*', '/agent/*'] as const;

/**
 * 画面のパス（拡張子のない URL）を /index.html に読み替える（Flutter のページ遷移後の再読み込み対策）。
 * 既定の振り分け（S3）にだけ付けるので、/api・/agent の 404 は画面に置き換わらない。
 * /assets/ 以下は拡張子のない実ファイル（ライセンス表示用の NOTICES など）があるため読み替えない。
 */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('/assets/') === 0) {
    return request;
  }
  var last = request.uri.split('/').pop();
  if (last === '' || last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

export interface WebStackProps extends StackProps {
  readonly config: StageConfig;
  /** CloudFront 用の証明書（us-east-1）。crossRegionReferences で受け取る */
  readonly certificate: ICertificate;
  /** CloudFront だけが ALB に付けるヘッダーの値（App スタックが生成） */
  readonly originVerifySecret: ISecret;
  /**
   * 配置する画面ファイルのフォルダ。省略時は app/build/web（ビルド済みのときだけ配置する）。
   * false は配置しない（テスト用）。
   */
  readonly webBuildDir?: string | false;
  /** テスト用。指定しない場合は Route 53 からホストゾーンを検索する */
  readonly hostedZoneId?: string;
}

/**
 * WBS 2.6：S3＋CloudFront（要件定義書 4.1.1・4.2.3）。
 *
 * - `/*` は S3（Flutter Web）、`/api/*`・`/agent/*` は ALB（origin.<appDomain>）へ振り分ける。
 * - S3 は非公開で、CloudFront からだけ読める（OAC）。
 * - ALB へは秘密のヘッダーを付けて送り、ALB はそのヘッダーがある要求だけをサーバへ転送する（他人の CloudFront からの接続を防ぐ）。
 * - WAF・セキュリティヘッダーは 9.2、CloudFront のアクセスログは 9.1 で追加する。
 */
export class WebStack extends Stack {
  readonly distribution: Distribution;
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { stage, appDomain, database } = props.config;
    const retain = database.deletionProtection;

    this.bucket = new Bucket(this, 'WebBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true, // 誤って上書き・削除したときに戻せるように
      // 古い版は 30 日で消す（容量を増やし続けない）
      lifecycleRules: [
        { id: 'expire-old-versions', noncurrentVersionExpiration: Duration.days(30) },
      ],
      removalPolicy: retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    const spaRewrite = new CfFunction(this, 'SpaRewrite', {
      functionName: `${PROJECT}-${stage}-spa-rewrite`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(SPA_REWRITE_CODE),
      comment: 'Rewrite app paths to /index.html',
    });

    const apiOrigin = new HttpOrigin(originDomain(appDomain), {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [OriginSslPolicy.TLS_V1_2],
      readTimeout: Duration.seconds(30), // 計画生成のサーバ打ち切り（13秒）より長くする
      customHeaders: {
        // テンプレートには値を書かず、デプロイ時に Secrets Manager から読み込む
        [ORIGIN_VERIFY_HEADER]: props.originVerifySecret.secretValue.unsafeUnwrap(),
      },
    });
    const apiBehavior: BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY, // POST をリダイレクトしない
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED, // API はキャッシュしない
      // Authorization・検索条件・Cookie をそのまま渡す（Host は ALB の証明書に合わせて origin.<appDomain> のまま）
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
    };

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `${PROJECT} ${stage}`,
      domainNames: [appDomain],
      certificate: props.certificate,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      priceClass: PriceClass.PRICE_CLASS_200, // 日本を含む。利用者は国内のため
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: Object.fromEntries(API_PATHS.map((p) => [p, apiBehavior])),
    });

    const zone: IHostedZone = props.hostedZoneId
      ? HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: props.hostedZoneId,
          zoneName: ROOT_DOMAIN,
        })
      : HostedZone.fromLookup(this, 'Zone', { domainName: ROOT_DOMAIN });
    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, 'WebRecord', { zone, recordName: appDomain, target });
    new AaaaRecord(this, 'WebRecordIpv6', { zone, recordName: appDomain, target });

    // 画面ファイルの配置。ビルド済み（index.html がある）ときだけ行う。2.7 で自動デプロイに切り替える
    const webBuildDir = props.webBuildDir ?? DEFAULT_WEB_BUILD_DIR;
    if (webBuildDir !== false && !existsSync(join(webBuildDir, 'index.html'))) {
      Annotations.of(this).addWarning(
        `画面ファイル（${webBuildDir}）がないため S3 へ配置しません。先に flutter build web を実行してください`,
      );
    } else if (webBuildDir !== false) {
      new BucketDeployment(this, 'DeployWeb', {
        sources: [Source.asset(webBuildDir)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
        prune: true,
        memoryLimit: 512,
      });
    }

    new CfnOutput(this, 'WebUrl', { value: `https://${appDomain}` });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'WebBucketName', { value: this.bucket.bucketName });
  }
}
