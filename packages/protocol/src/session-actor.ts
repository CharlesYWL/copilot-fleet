import { z } from "zod";

export const SessionActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator"), operatorId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("node_console"), nodeId: z.string().min(1) }).strict(),
]);
export type SessionActor = z.infer<typeof SessionActorSchema>;

export function sessionActor(
  actor: SessionActor | undefined,
  operatorId: string | undefined,
): SessionActor | undefined {
  return actor ?? (operatorId ? { kind: "operator", operatorId } : undefined);
}

export function sessionActorId(actor: SessionActor): string {
  return actor.kind === "operator" ? actor.operatorId : actor.nodeId;
}
