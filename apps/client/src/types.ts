import type { ServerAnnouncement } from "@streamer-ai/discovery";
export interface ClientState {
  clientId: string;
  selected: ServerAnnouncement | null;
}
export interface ClientBridge {
  state(): Promise<ClientState>;
  discover(): Promise<ServerAnnouncement[]>;
  connect(input: { address: string; expectedServerId?: string }): Promise<void>;
  forget(): Promise<void>;
}
declare global {
  interface Window {
    streamerClient: ClientBridge;
  }
}
