export async function verifyWebhookSignature(
  raw: string,
  header: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!secret || raw.length > 2_000_000) return false;
  const parts = header.split(",").map((s) => s.trim().split("="));
  const timestamps = parts.filter(([k]) => k === "t");
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1])) return false;
  const timestamp = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${raw}`),
    ),
  );
  return parts
    .filter(([k]) => k === "v1")
    .some(([, hex]) => {
      if (!/^[a-f0-9]{64}$/i.test(hex)) return false;
      const received = Uint8Array.from(hex.match(/../g)!, (x) =>
        parseInt(x, 16),
      );
      let different = 0;
      for (let i = 0; i < signature.length; i++)
        different |= signature[i] ^ received[i];
      return different === 0;
    });
}
