import { createHmac, timingSafeEqual } from "crypto";

/**
 * A deliberately small Stripe REST client: form-encoded requests with an
 * idempotency key, no SDK dependency. RI needs five calls (Checkout create /
 * retrieve / expire, refund create, and Identity in stranger mode); a vendored
 * SDK would add a supply-chain surface for that.
 */

export type StripeParams = Record<string, string | number | boolean | undefined>;

export class StripeError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "StripeError";
  }
}

export interface StripeRest {
  request<T>(method: "GET" | "POST", path: string, params?: StripeParams, idempotencyKey?: string): Promise<T>;
}

export function createStripeRest(secretKey: string, fetchImpl: typeof fetch = fetch): StripeRest {
  return {
    async request<T>(method: "GET" | "POST", path: string, params: StripeParams = {}, idempotencyKey?: string): Promise<T> {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) body.append(k, String(v));
      }
      const url = method === "GET" && body.toString() ? `https://api.stripe.com${path}?${body}` : `https://api.stripe.com${path}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": "2024-06-20",
      };
      if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      const res = await fetchImpl(url, {
        method,
        headers,
        body: method === "POST" ? body.toString() : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      if (!res.ok) {
        // Never include the request body: it can carry return URLs with game ids.
        throw new StripeError(json.error?.message ?? `Stripe ${res.status}`, res.status, json.error?.code);
      }
      return json as T;
    },
  };
}

/** The Checkout Session fields RI reads. */
export interface CheckoutSession {
  id: string;
  object?: "checkout.session";
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  currency: string | null;
  mode: "payment" | "setup" | "subscription";
  metadata: Record<string, string> | null;
  client_reference_id: string | null;
  payment_intent: string | null;
  livemode: boolean;
  /** Unix seconds. */
  expires_at: number;
}

export interface Refund {
  id: string;
  status: string;
}

/** What the partner-payment service needs from Stripe. Faked in tests. */
export interface CheckoutApi {
  createCheckoutSession(params: StripeParams, idempotencyKey: string): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession>;
  expireCheckoutSession(id: string): Promise<void>;
  createRefund(
    paymentIntentId: string,
    idempotencyKey: string,
    reason: "duplicate" | "requested_by_customer",
    metadata: Record<string, string>
  ): Promise<Refund>;
}

export function createCheckoutApi(rest: StripeRest): CheckoutApi {
  return {
    createCheckoutSession: (params, key) => rest.request<CheckoutSession>("POST", "/v1/checkout/sessions", params, key),
    retrieveCheckoutSession: (id) =>
      rest.request<CheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`),
    expireCheckoutSession: async (id) => {
      await rest.request("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`);
    },
    createRefund: (pi, key, reason, metadata) => {
      const params: StripeParams = { payment_intent: pi, reason };
      for (const [k, v] of Object.entries(metadata)) params[`metadata[${k}]`] = v;
      return rest.request<Refund>("POST", "/v1/refunds", params, key);
    },
  };
}

/** Five minutes, Stripe's own recommended tolerance. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify a `Stripe-Signature` header (`t=…,v1=…[,v1=…]`) over the raw body.
 * Any malformed header, stale timestamp or mismatch returns false; never throws.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") timestamp = Number(v);
    else if (k === "v1") signatures.push(v);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const exp = Buffer.from(expected, "hex");
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const got = Buffer.from(sig, "hex");
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

/** Build a valid signature header — for tests and local tooling only. */
export function signWebhookPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
