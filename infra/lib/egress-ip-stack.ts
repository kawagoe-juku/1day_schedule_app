import { CfnOutput, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { CfnEIP } from 'aws-cdk-lib/aws-ec2';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { PROJECT, ssmPath, type StageConfig } from './config.js';

export interface EgressIpStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * 外部 API（Google Maps など）から見える AWS 側の出口 IP を固定で確保する。
 *
 * - VPC より先に作り、Google のサーバ用キーの IP 制限に登録する。
 * - NAT Gateway は Network スタック（WBS 2.x）でこの IP を割り当てて作る。
 * - スタックを削除しても IP は解放しない（キーの登録を変えずに済むように）。
 */
export class EgressIpStack extends Stack {
  constructor(scope: Construct, id: string, props: EgressIpStackProps) {
    super(scope, id, props);
    const { stage } = props.config;
    const egressIpCount = props.config.network.natGateways;

    for (let i = 1; i <= egressIpCount; i++) {
      const eip = new CfnEIP(this, `EgressIp${i}`, { domain: 'vpc' });
      eip.applyRemovalPolicy(RemovalPolicy.RETAIN);
      Tags.of(eip).add('Name', `${PROJECT}-${stage}-egress-${i}`);

      new StringParameter(this, `EgressIp${i}AllocationIdParam`, {
        parameterName: ssmPath(stage, `network/egress-ip-${i}/allocation-id`),
        stringValue: eip.attrAllocationId,
        description: `NAT Gateway ${i} に割り当てる Elastic IP の割り当てID`,
      });
      new StringParameter(this, `EgressIp${i}PublicIpParam`, {
        parameterName: ssmPath(stage, `network/egress-ip-${i}/public-ip`),
        stringValue: eip.attrPublicIp,
        description: `外部 API の IP 制限に登録する出口 IP ${i}`,
      });

      new CfnOutput(this, `EgressIp${i}PublicIp`, {
        value: eip.attrPublicIp,
        description: `Google サーバ用キーの IP 制限に登録する値（出口 ${i}）`,
      });
    }
  }
}
