export interface CursorToken {
  ts: string;
  id: string;
}

export function parseLimit(raw: string | undefined, fallback: number, max = 100): number {
  const parsed = Number.parseInt(raw ?? `${fallback}`, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, max));
}

export function encodeCursor(cursor: CursorToken): string {
  return btoa(JSON.stringify(cursor));
}

export function decodeCursor(raw: string | undefined): CursorToken | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(atob(raw));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.ts === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return { ts: parsed.ts, id: parsed.id };
    }
  } catch {
    return null;
  }

  return null;
}
