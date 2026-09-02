export type ConnectionTransport =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface Connection {
  id: string;
  displayName: string;
  source: "preset" | "user";
  enabled: boolean;
  editable: boolean;
  removable: boolean;
  transport: ConnectionTransport;
}

export interface SaveConnectionRequest {
  id: string;
  transport: ConnectionTransport;
}
