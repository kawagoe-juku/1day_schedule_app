// OpenAPI定義の簡易チェック（$ref解決・operationId重複・パスパラメータ・要件APIの網羅）
// 使い方: node scripts/check-openapi.mjs [api/openapi.yaml]
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const file = process.argv[2] ?? new URL('../api/openapi.yaml', import.meta.url);
const doc = parse(readFileSync(file, 'utf8'));
const errors = [];

const resolve = (ref) =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((o, k) => (o == null ? o : o[k]), doc);
(function walk(node, path) {
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && resolve(node.$ref) === undefined)
      errors.push(`未解決の$ref: ${node.$ref}（${path}）`);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  }
})(doc, '$');

const methods = ['get', 'put', 'post', 'delete', 'patch'];
const opIds = new Map();
for (const [p, item] of Object.entries(doc.paths)) {
  const names = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  for (const m of methods) {
    const op = item[m];
    if (!op) continue;
    if (!op.operationId) errors.push(`operationIdなし: ${m.toUpperCase()} ${p}`);
    else if (opIds.has(op.operationId)) errors.push(`operationId重複: ${op.operationId}`);
    else opIds.set(op.operationId, `${m.toUpperCase()} ${p}`);
    if (!op.responses || Object.keys(op.responses).length === 0)
      errors.push(`responsesなし: ${m.toUpperCase()} ${p}`);
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x) =>
      x.$ref ? resolve(x.$ref) : x,
    );
    for (const n of names)
      if (!params.some((x) => x.in === 'path' && x.name === n))
        errors.push(`パスパラメータ未定義: {${n}} in ${m.toUpperCase()} ${p}`);
  }
}

// 要件定義書3.4・見積書3.3のAPI（Web版で対象外のpush-subscriptionsを除く）
const required = [
  'POST /agent/plans',
  'GET /agent/plans/{planId}',
  'POST /agent/plans/{planId}/clarify',
  'POST /agent/plans/{planId}/revise',
  'POST /agent/plans/{planId}/replan',
  'POST /agent/plans/{planId}/departure-detected',
  'DELETE /agent/plans/{planId}/items/{itemId}',
  'GET /api/profile',
  'PUT /api/profile',
  'GET /api/geo/address-suggestions',
  'GET /api/geo/station-suggestions',
  'GET /api/memos',
  'POST /api/memos',
  'PUT /api/memos/{memoId}',
  'DELETE /api/memos/{memoId}',
  'GET /api/routines',
  'POST /api/routines',
  'PUT /api/routines/{routineId}',
  'DELETE /api/routines/{routineId}',
  'PUT /api/routines/{routineId}/skip',
  'GET /api/calendar/events',
  'POST /api/integrations/{provider}',
  'DELETE /api/integrations/{provider}',
  'GET /api/notification-settings',
  'PUT /api/notification-settings',
  'GET /api/privacy-settings',
  'PUT /api/privacy-settings',
  'GET /api/point-programs',
  'PUT /api/point-programs',
  'POST /api/account/logout-all',
  'POST /api/speech/transcribe',
  'DELETE /api/account',
];
const defined = new Set(opIds.values());
for (const r of required) if (!defined.has(r)) errors.push(`要件のAPIが未定義: ${r}`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`OK: ${opIds.size} operations, ${Object.keys(doc.components.schemas).length} schemas`);
