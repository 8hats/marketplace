import { z } from 'zod';

const cid = z.string().regex(/^[0-9A-F]{64}$/);
const author = z.object({ display_name: z.string().min(1), identity: cid, role: z.string().min(1) }).strict();
const common = { version: z.literal(1), room_id: z.string().min(1), room_name: z.string().min(1), at: z.string().datetime(), author };
const roomMessage = z.object({ ...common, kind: z.literal('room_msg'), message_id: z.string().min(1), text: z.string() }).strict();
const roomFile = z.object({ ...common, kind: z.literal('room_file'), file_id: z.string().min(1), filename: z.string().min(1), mime: z.string().min(1), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const envelope = z.discriminatedUnion('kind', [roomMessage, roomFile]);

export function parseRoomEnvelope(text, expectedRoom) {
  let value; try { value = JSON.parse(text); } catch { return null; }
  const parsed = envelope.safeParse(value); if (!parsed.success) return null;
  if (expectedRoom && parsed.data.room_name !== expectedRoom) return null;
  return parsed.data;
}
