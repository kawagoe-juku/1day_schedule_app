/**
 * API 仕様（api/openapi.yaml）のスキーマで、応答の形を確かめるための部品。
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const document = parse(
  readFileSync(new URL('../../../api/openapi.yaml', import.meta.url), 'utf8'),
) as { components: { schemas: Record<string, unknown> } };

// examples などの注釈は検証に使わないので、知らないキーワードを許す
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addSchema({ $id: 'openapi', components: document.components });

/** 値が、API 仕様の名前付きスキーマ（例：Plan）に合わない点の一覧（合っていれば空） */
export function schemaErrors(name: string, value: unknown): string[] {
  const validate = ajv.getSchema(`openapi#/components/schemas/${name}`);
  if (!validate) throw new Error(`API 仕様にスキーマがありません：${name}`);
  validate(value);
  return (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
