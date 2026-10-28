import type { Pool } from 'pg';
import { tenantTransaction } from './database';
import { aiInputSchema, type AIInput } from './ai';
import type { secretBox } from './crypto';

export type JobEntry = { userId: string; workspaceId: string; id: string };
export async function processJob(pool: Pool, box: ReturnType<typeof secretBox>, entry: JobEntry, execute: (input: AIInput) => Promise<unknown>) {
    const claim = await tenantTransaction(pool, entry.userId, async client => {
        const { rows } = await client.query("UPDATE jobs SET status='running',lease_until=now()+interval '4 minutes',attempts=attempts+1 WHERE id=$1 AND workspace_id=$2 AND (status='queued' OR (status='running' AND lease_until<now())) RETURNING payload,attempts", [entry.id, entry.workspaceId]);
        return rows[0];
    });
    if (!claim) return false;
    let result: unknown;
    let failure: string | undefined;
    try {
        if (claim.attempts > 3) throw new Error('任务重试次数已用完，请重新发起。');
        result = await execute(aiInputSchema.parse(box.open(claim.payload)));
    } catch (error) { failure = error instanceof Error ? error.message : 'AI 任务失败。'; }
    const saved = await tenantTransaction(pool, entry.userId, async client => {
        const update = await client.query('UPDATE jobs SET status=$3,result=$4,error=$5,payload=$6,finished_at=now(),lease_until=NULL WHERE id=$1 AND workspace_id=$2 AND attempts=$7', [entry.id, entry.workspaceId, failure ? 'failed' : 'done', result ? JSON.stringify(result) : null, failure || null, box.seal({}), claim.attempts]);
        if (update.rowCount) await client.query('INSERT INTO audit_logs(workspace_id,action,resource_id) VALUES($1,$2,$3)', [entry.workspaceId, failure ? 'ai.failed' : 'ai.completed', entry.id]);
        return update.rowCount;
    });
    return !!saved;
}
