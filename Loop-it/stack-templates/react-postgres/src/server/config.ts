// Server configuration. Every value here is read from the process environment
// and stays server-side. There is deliberately no mechanism to forward any of
// this to the browser — client config is a separate, VITE_-prefixed allowlist
// read by Vite at build time (see src/client/config.ts). Keeping the two apart
// is what prevents a server secret from ever landing in the client bundle.

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function list(name: string, fallback: string[] = []): string[] {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly jwtSecret: string;
  readonly jwtAlgorithms: string[];
  readonly corsAllowedOrigins: string[];
  readonly port: number;
}

export function loadConfig(): ServerConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    jwtAlgorithms: list('JWT_ALGORITHMS', ['HS256']),
    corsAllowedOrigins: list('CORS_ALLOWED_ORIGINS'),
    port: Number.parseInt(process.env.PORT ?? '8080', 10),
  };
}
