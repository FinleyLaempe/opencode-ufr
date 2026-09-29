/** OpenAI-format error with a whole-second Retry-After when a wait is known. */
export function errorResponse(status: number, type: string, message: string, retryAfterMs?: number): Response {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (retryAfterMs !== undefined && retryAfterMs > 0) headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  return new Response(JSON.stringify({ error: { message, type, code: status } }), { status, headers })
}
