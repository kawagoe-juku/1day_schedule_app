// api/openapi.yaml を、Dart の API クライアント生成（swagger_parser）向けに整えて JSON で出力する。
// 使い方: node scripts/openapi-for-dart.mjs <入力の yaml> <出力の json>
//
// そのまま生成すると扱いにくい型になる箇所だけを書き換える。API の仕様そのものは変えない。
//   1. スキーマ名 Error → ApiError（Dart 標準の Error と重なり、Error2 という名前になるため）
//   2. 文字列・数値に名前を付けただけのスキーマ（Id・DateTime・TimeOfDay）は、参照元に展開する
//      （DateTime2 のような包み型ではなく、Dart の DateTime・String・int になる）
//   3. null を許す項目は「省略できる項目」にする（`X | null` の合成型ではなく、Dart の `X?` になる）。
//      サーバが返す null は、画面側の通信処理（lib/api/api_client.dart）が項目ごと取り除いてから読む。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'yaml';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('使い方: node scripts/openapi-for-dart.mjs <入力の yaml> <出力の json>');
}
const doc = parse(readFileSync(input, 'utf8'));
const schemas = doc.components.schemas;
const SCHEMA_REF = '#/components/schemas/';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 全ノードを深さ優先でたどり、子を処理し終えたオブジェクトを fn の戻り値に置き換える */
function mapNodes(node, fn) {
  if (Array.isArray(node)) return node.map((v) => mapNodes(v, fn));
  if (!isObject(node)) return node;
  const mapped = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, mapNodes(v, fn)]));
  return fn(mapped);
}

// 1. Error → ApiError
if (schemas.ApiError) throw new Error('スキーマ名 ApiError はすでに使われています');
schemas.ApiError = schemas.Error;
delete schemas.Error;
const renamed = mapNodes(doc, (node) =>
  node.$ref === `${SCHEMA_REF}Error` ? { ...node, $ref: `${SCHEMA_REF}ApiError` } : node,
);

// 2. 名前を付けただけの文字列・数値のスキーマを展開する（列挙は Dart の enum にしたいので残す）
const isAlias = (schema) =>
  ['string', 'integer', 'number', 'boolean'].includes(schema.type) && !schema.enum;
const aliases = Object.fromEntries(
  Object.entries(renamed.components.schemas).filter(([, schema]) => isAlias(schema)),
);
for (const name of Object.keys(aliases)) delete renamed.components.schemas[name];
const inlined = mapNodes(renamed, (node) => {
  const name =
    typeof node.$ref === 'string' && node.$ref.startsWith(SCHEMA_REF)
      ? node.$ref.slice(SCHEMA_REF.length)
      : undefined;
  if (name === undefined || !aliases[name]) return node;
  const { $ref: _ref, ...siblings } = node;
  const { examples: _examples, ...alias } = aliases[name];
  return { ...alias, ...siblings };
});

// 3. null を許す項目を「省略できる項目」にする
const isNullType = (schema) => isObject(schema) && schema.type === 'null';
/** null を許すスキーマなら null を許さない形を返す。そうでなければ undefined */
function withoutNull(schema) {
  for (const key of ['oneOf', 'anyOf']) {
    const variants = schema[key];
    if (!Array.isArray(variants) || !variants.some(isNullType)) continue;
    const rest = variants.filter((v) => !isNullType(v));
    const { [key]: _variants, ...siblings } = schema;
    return rest.length === 1 ? { ...siblings, ...rest[0] } : { ...siblings, [key]: rest };
  }
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = schema.type.filter((t) => t !== 'null');
    return { ...schema, type: rest.length === 1 ? rest[0] : rest };
  }
  return undefined;
}
const result = mapNodes(inlined, (node) => {
  if (!isObject(node.properties)) return node;
  const nullable = [];
  const properties = Object.fromEntries(
    Object.entries(node.properties).map(([name, schema]) => {
      const nonNull = isObject(schema) ? withoutNull(schema) : undefined;
      if (nonNull === undefined) return [name, schema];
      nullable.push(name);
      return [name, nonNull];
    }),
  );
  if (nullable.length === 0) return node;
  const required = (node.required ?? []).filter((name) => !nullable.includes(name));
  const { required: _required, ...rest } = node;
  return { ...rest, properties, ...(required.length > 0 ? { required } : {}) };
});

// 項目以外の場所（配列の要素など）に null が残っていたら、上の書き換えでは扱えないので止める
mapNodes(result, (node) => {
  if (isNullType(node) || (Array.isArray(node.type) && node.type.includes('null'))) {
    throw new Error(`項目以外の場所で null を許すスキーマは未対応です: ${JSON.stringify(node)}`);
  }
  return node;
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
