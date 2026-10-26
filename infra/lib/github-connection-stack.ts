import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnConnection } from 'aws-cdk-lib/aws-codestarconnections';
import type { Construct } from 'constructs';
import { PROJECT } from './config.js';

/**
 * GitHub との接続（CodeConnections）。パイプラインがリポジトリを取得するために使う。
 * 作成直後は「保留中」なので、コンソールで一度だけ GitHub 側の承認を行う（手順は infra/README.md）。
 */
export class GitHubConnectionStack extends Stack {
  readonly connectionArn: string;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    const connection = new CfnConnection(this, 'GitHub', {
      connectionName: `${PROJECT}-github`,
      providerType: 'GitHub',
    });
    this.connectionArn = connection.attrConnectionArn;
    new CfnOutput(this, 'ConnectionArn', { value: this.connectionArn });
  }
}
