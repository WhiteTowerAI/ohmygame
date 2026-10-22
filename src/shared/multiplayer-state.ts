import { schema, t, type SchemaType } from "@colyseus/schema";

// One atomic JSON snapshot avoids coupling game adapters to Schema classes.
export const MultiplayerRoomState = schema(
  { snapshot: t.string() },
  "MultiplayerRoomState",
);
export type MultiplayerRoomState = SchemaType<typeof MultiplayerRoomState>;
