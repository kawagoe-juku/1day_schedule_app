/** リポジトリの入口。`repositories(db)` または `repositories(tx)` で全テーブル分をまとめて得る */
import type { DbExecutor } from '../client.js';
import { agentSessionRepository } from './agent-session-repository.js';
import { calendarEventRepository } from './calendar-event-repository.js';
import { calendarIntegrationRepository } from './calendar-integration-repository.js';
import { departureLogRepository } from './departure-log-repository.js';
import { generationQuotaRepository } from './generation-quota-repository.js';
import { memoRepository } from './memo-repository.js';
import { planItemRepository } from './plan-item-repository.js';
import { planRepository } from './plan-repository.js';
import { pointProgramRepository } from './point-program-repository.js';
import { routineRepository } from './routine-repository.js';
import { slotEvaluationRepository } from './slot-evaluation-repository.js';
import { userRepository } from './user-repository.js';

export const repositories = (db: DbExecutor) => ({
  users: userRepository(db),
  plans: planRepository(db),
  planItems: planItemRepository(db),
  slotEvaluations: slotEvaluationRepository(db),
  agentSessions: agentSessionRepository(db),
  routines: routineRepository(db),
  memos: memoRepository(db),
  calendarIntegrations: calendarIntegrationRepository(db),
  calendarEvents: calendarEventRepository(db),
  departureLogs: departureLogRepository(db),
  pointPrograms: pointProgramRepository(db),
  generationQuotas: generationQuotaRepository(db),
});

export type Repositories = ReturnType<typeof repositories>;
