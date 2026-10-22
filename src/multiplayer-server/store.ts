import { DatabaseSync } from "node:sqlite";
import type {
  MultiplayerManifestConfig,
  MultiplayerSnapshot,
  TurnCommand,
  TurnCommandResult,
} from "../shared/multiplayer-protocol.js";

export interface StoredMember {
  playerId: string;
  userId: string;
  banned?: boolean;
}
export interface StoredRoom {
  config: MultiplayerManifestConfig;
  snapshot: MultiplayerSnapshot;
  members: StoredMember[];
  inviteCodeHash: string;
  creationKeyHash: string;
  updatedAt: number;
}

/** Snapshot and command result commit together; retries survive process restarts. */
export class RoomStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, player_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (room_id, player_id, command_id));`);
  }
  save(
    room: StoredRoom,
    command?: {
      playerId: string;
      value: TurnCommand;
      result: TurnCommandResult;
    },
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(room.snapshot.roomId, JSON.stringify(room));
      if (command)
        this.db
          .prepare("INSERT INTO commands VALUES (?, ?, ?, ?, ?)")
          .run(
            room.snapshot.roomId,
            command.playerId,
            command.value.commandId,
            JSON.stringify(command.value),
            JSON.stringify(command.result),
          );
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }
  result(
    roomId: string,
    playerId: string,
    commandId: string,
  ): TurnCommandResult | undefined {
    const row = this.db
      .prepare(
        "SELECT result FROM commands WHERE room_id=? AND player_id=? AND command_id=?",
      )
      .get(roomId, playerId, commandId);
    return row
      ? (JSON.parse(String(row.result)) as TurnCommandResult)
      : undefined;
  }
  rooms(): StoredRoom[] {
    return this.db
      .prepare("SELECT data FROM rooms")
      .all()
      .map((row) => JSON.parse(String(row.data)) as StoredRoom);
  }
  prune(before: number): void {
    for (const room of this.rooms())
      if (room.updatedAt < before)
        this.db
          .prepare("DELETE FROM rooms WHERE id=?")
          .run(room.snapshot.roomId);
  }
  close(): void {
    this.db.close();
  }
}
