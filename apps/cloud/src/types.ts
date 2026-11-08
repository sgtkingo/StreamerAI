export interface Env {
  DB: D1Database;
  AUTH_ORIGIN: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BREVO_API_KEY?: string;
  MAIL_FROM?: string;
}

export interface Account {
  id: string;
  email: string;
  name: string;
}

export interface Principal {
  account: Account;
  method: "browser" | "device";
  deviceId?: string;
  householdId?: string;
  purpose?: "login" | "pin-reset";
  mergeAckRequired?: boolean;
  authenticatedAt?: number;
}

export interface SessionReader {
  getSession(
    request: Request,
  ): Promise<(Account & { authenticatedAt?: number }) | null>;
  handler(request: Request): Promise<Response>;
}

export interface Clock {
  now(): number;
}
