/** 日本時間（JST）の日時の小道具 */
export const MINUTE = 60_000;
const jst = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString();
/** YYYY-MM-DD */
export const jstDate = (date: Date) => jst(date).slice(0, 10);
/** HH:mm */
export const jstTime = (date: Date) => jst(date).slice(11, 16);
/** オフセット付きの ISO 8601 */
export const toIso = (date: Date) => `${jst(date).slice(0, 19)}+09:00`;
/** 日付（YYYY-MM-DD）と時刻（HH:mm）から、オフセット付きの ISO 8601 */
export const atJst = (date: string, time: string) => `${date}T${time}:00+09:00`;
