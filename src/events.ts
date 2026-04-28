import { randomId } from "./crypto";
import { nowIso, type Actor, type Env } from "./http";

export async function emitEvent(
  env: Env,
  input: {
    projectId: string;
    versionId?: string | null;
    taskId?: string | null;
    actor: Actor;
    type: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (id, project_id, version_id, task_id, actor_type, actor_id, event_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      randomId("evt"),
      input.projectId,
      input.versionId ?? null,
      input.taskId ?? null,
      input.actor.type,
      input.actor.id,
      input.type,
      JSON.stringify(input.payload ?? {}),
      nowIso()
    )
    .run();
}
