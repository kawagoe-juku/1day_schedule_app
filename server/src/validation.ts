import type { z } from 'zod';
import { validationError, type ErrorDetail } from './errors.js';

type Issue = z.core.$ZodIssue;

/** 入力値から、指摘のあった場所（例：frequentStations.0.stationName）の値を取り出す */
function valueAt(input: unknown, path: PropertyKey[]): unknown {
  let current = input;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** zod の指摘を、利用者に見せられる日本語にする */
function toMessage(issue: Issue, input: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      // zod は既定で入力値を指摘に含めないので、入力値からたどって「無い」のか「型が違う」のかを分ける
      return valueAt(input, issue.path) === undefined
        ? '必須の項目です'
        : '値の形式が正しくありません';
    case 'too_small':
      if (issue.origin === 'string') return `${issue.minimum}文字以上で入力してください`;
      if (issue.origin === 'array') return `${issue.minimum}件以上を指定してください`;
      return `${issue.minimum}以上の値を指定してください`;
    case 'too_big':
      if (issue.origin === 'string') return `${issue.maximum}文字以内で入力してください`;
      if (issue.origin === 'array') return `${issue.maximum}件以内で指定してください`;
      return `${issue.maximum}以下の値を指定してください`;
    case 'unrecognized_keys':
      return `指定できない項目です：${issue.keys.join('、')}`;
    case 'custom':
      // 各スキーマが日本語で書いたメッセージ
      return issue.message;
    default:
      return '値が正しくありません';
  }
}

/**
 * 入力値（要求の本文など）を zod のスキーマで確かめる。
 * 合わなければ、項目ごとの内容を付けた 400 VALIDATION_ERROR を投げる。
 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: ErrorDetail[] = result.error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: toMessage(issue, input),
  }));
  throw validationError(details);
}
