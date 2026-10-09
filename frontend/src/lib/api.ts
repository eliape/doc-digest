export type Health = { status: string }

/** Ask the backend whether it is up. */
export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<Health> {
  const res = await fetchFn('/api/health')
  if (!res.ok) throw new Error(`Backend returned ${res.status}`)
  return (await res.json()) as Health
}
