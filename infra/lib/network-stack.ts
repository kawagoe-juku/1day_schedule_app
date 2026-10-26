import { Stack, type StackProps } from 'aws-cdk-lib';
import {
  GatewayVpcEndpointAwsService,
  IpAddresses,
  NatProvider,
  Peer,
  Port,
  PrefixList,
  SecurityGroup,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import { PROJECT, type StageConfig } from './config.js';

/** サーバ（ECS）が待ち受けるポート */
export const APP_PORT = 3000;
/** Aurora（PostgreSQL）のポート */
const DB_PORT = 5432;
/** CloudFront からオリジンへの接続元をまとめた AWS 管理のプレフィックスリスト */
const CLOUDFRONT_ORIGIN_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

export interface NetworkStackProps extends StackProps {
  readonly config: StageConfig;
  /** NAT Gateway に割り当てる固定 IP の割り当て ID（EgressIp スタック。NAT Gateway の数だけ必要） */
  readonly eipAllocationIds: string[];
  /** テスト用。指定しない場合はプレフィックスリストを検索する */
  readonly cloudFrontPrefixListId?: string;
}

/**
 * VPC・サブネット・NAT・セキュリティグループ（要件定義書 4.2.1）。
 *
 * - サブネットは 公開（ALB・NAT）／アプリ層（ECS）／データ層（Aurora、外部への経路なし）の3層。
 * - NAT Gateway には EgressIp の固定 IP を割り当てる（Google のサーバ用キーの IP 制限と一致させる）。
 * - SG：ALB は 443 を CloudFront からのみ／ECS は ALB からのみ／Aurora は ECS からのみ。
 *   送信は ALB→ECS(3000)、ECS→インターネット(443)・Aurora(5432) のみ。
 * - Bedrock 等の VPC エンドポイントは作らない（費用を抑えるため NAT 経由）。S3 のゲートウェイ型は無料なので付ける。
 */
export class NetworkStack extends Stack {
  readonly vpc: Vpc;
  readonly albSecurityGroup: SecurityGroup;
  readonly appSecurityGroup: SecurityGroup;
  readonly dbSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { stage, region, network } = props.config;
    const { eipAllocationIds } = props;
    if (eipAllocationIds.length < network.natGateways) {
      throw new Error(
        `NAT Gateway ${network.natGateways} 個に対して固定 IP が ${eipAllocationIds.length} 個しかありません`,
      );
    }

    this.vpc = new Vpc(this, 'Vpc', {
      vpcName: `${PROJECT}-${stage}`,
      ipAddresses: IpAddresses.cidr(network.vpcCidr),
      availabilityZones: ['a', 'c', 'd'].slice(0, network.azCount).map((s) => `${region}${s}`),
      natGateways: network.natGateways,
      natGatewayProvider: NatProvider.gateway({
        eipAllocationIds: eipAllocationIds.slice(0, network.natGateways),
      }),
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: {
          service: GatewayVpcEndpointAwsService.S3,
          subnets: [{ subnetType: SubnetType.PRIVATE_WITH_EGRESS }],
        },
      },
      restrictDefaultSecurityGroup: true,
    });

    const cloudFrontPrefixListId =
      props.cloudFrontPrefixListId ??
      PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
        prefixListName: CLOUDFRONT_ORIGIN_PREFIX_LIST,
      }).prefixListId;

    this.albSecurityGroup = new SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT}-${stage}-alb`,
      description: 'ALB: HTTPS 443 from CloudFront only',
      allowAllOutbound: false,
    });
    this.appSecurityGroup = new SecurityGroup(this, 'AppSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT}-${stage}-app`,
      description: `ECS: ${APP_PORT} from ALB only`,
      allowAllOutbound: false,
    });
    this.dbSecurityGroup = new SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      securityGroupName: `${PROJECT}-${stage}-db`,
      description: `Aurora: ${DB_PORT} from ECS only`,
      allowAllOutbound: false,
    });

    // CloudFront のプレフィックスリストは約55件分として SG ルールの上限（既定60）を消費する。
    // ALB の SG にこのリストのルールをもう1本足すと上限を超えるので、443 の1本だけにする。
    this.albSecurityGroup.addIngressRule(
      Peer.prefixList(cloudFrontPrefixListId),
      Port.tcp(443),
      'HTTPS from CloudFront',
    );
    this.albSecurityGroup.addEgressRule(this.appSecurityGroup, Port.tcp(APP_PORT), 'to ECS');
    this.appSecurityGroup.addIngressRule(this.albSecurityGroup, Port.tcp(APP_PORT), 'from ALB');
    this.dbSecurityGroup.addIngressRule(
      this.appSecurityGroup,
      Port.tcp(DB_PORT),
      'PostgreSQL from ECS',
    );
    // ECS の送信は HTTPS（NAT 経由で Bedrock・Secrets Manager・Google・NAVITIME、S3 はゲートウェイ経由）と DB だけ
    this.appSecurityGroup.addEgressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      'HTTPS to AWS and external APIs',
    );
    this.appSecurityGroup.addEgressRule(this.dbSecurityGroup, Port.tcp(DB_PORT), 'to Aurora');
  }
}
