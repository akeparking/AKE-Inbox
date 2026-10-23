export function allowedWorkspaceOrigin(origin: string | null, fallback: string) {
  if (!origin) return false;
  const configured = [process.env.WORKSPACE_PUBLIC_ORIGIN || fallback,
    ...(process.env.WORKSPACE_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)];
  return configured.includes(origin);
}
