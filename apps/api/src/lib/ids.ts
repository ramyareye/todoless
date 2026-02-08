export function newId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
}

export function defaultWorkspaceName(email: string): string {
  const localPart = email.split('@')[0] || 'workspace';
  return `${localPart} workspace`;
}

export function makeWorkspaceSlug(input: string): string {
  const base =
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 32) || 'workspace';

  const suffix = randomHex(3);
  return `${base}-${suffix}`;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
