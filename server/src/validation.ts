import type { z } from 'zod';
import { validationError, type ErrorDetail } from './errors.js';

type Issue = z.core.$ZodIssue;

/** zod の指摘を、利用者に見せられる日本語にする */
function toMessage(issue: Issue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? '必須の項目です' : '値の形式が正しくありません';
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
    message: toMessage(issue),
  }));
  throw validationError(details);
}
