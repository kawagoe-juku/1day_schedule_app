import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app.js';

const app = new App();
buildApp(app, app.node.tryGetContext('stage') as string | undefined);
