/** Stable subscription identity, independent of credential rotation and pool slot. */
export function codexAccountIdentity(access: string, accountId: string): string {
  const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString());
  const user = claims["https://api.openai.com/auth"]?.chatgpt_user_id ?? claims.sub;
  if (typeof user !== "string" || !user || typeof accountId !== "string" || !accountId)
    throw new Error("Account identity unavailable");
  return new Bun.CryptoHasher("sha256").update(`codex:${accountId}:${user}`).digest("hex");
}

export function claudeAccountIdentity(profile: unknown): string {
  const id = (profile as { account?: { uuid?: unknown } })?.account?.uuid;
  if (typeof id !== "string" || !id) throw new Error("Account identity unavailable");
  return new Bun.CryptoHasher("sha256").update(`claude:${id}`).digest("hex");
}
