export type Session = {
  token: string;
  accountId: string;
  accountName: string;
  exp: number;
};

const COOKIE = "d1_desk";
const MAX_AGE_SEC = 60 * 60 * 24 * 7;

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64urlEncode(sig);
}

export async function signaturesEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

export async function makeCookie(
  session: Omit<Session, "exp">,
  secret: string,
  secure: boolean,
): Promise<string> {
  const payload: Session = { ...session, exp: Date.now() + MAX_AGE_SEC * 1000 };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await sign(secret, body);
  const parts = [
    `${COOKIE}=${body}.${sig}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure: boolean): string {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function readSession(request: Request, secret: string): Promise<Session | null> {
  const header = request.headers.get("Cookie") ?? "";
  const match = header
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(COOKIE.length + 1);
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await sign(secret, body);
  if (!(await signaturesEqual(sig, expected))) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(body));
    const session = JSON.parse(json) as Session;
    if (!session?.token || !session.accountId || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

export function originOk(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return request.method === "GET" || request.method === "HEAD";
  return origin === new URL(request.url).origin;
}
