import { asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { agentSession } from '../schema.js';

export type AgentSession = typeof agentSession.$inferSelect;
export type NewAgentSession = Omit<
  typeof agentSession.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

export const agentSessionRepository = (db: DbExecutor) => ({
  async insert(values: NewAgentSession): Promise<AgentSession> {
    const rows = await db.insert(agentSession).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('agent_session の作成に失敗しました');
    return row;
  },

  /** 記録した順 */
  async listByPlan(planId: number): Promise<AgentSession[]> {
    return db
      .select()
      .from(agentSession)
      .where(eq(agentSession.planId, planId))
      .orderBy(asc(agentSession.id));
  },
});
