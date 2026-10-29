import type { EnvBindings } from './types';

// Credential disclosure is opt-in for local development, never the fallback.
export function exposesDevelopmentTokens(env: EnvBindings): boolean {
  return env.ENVIRONMENT === 'dev';
}
