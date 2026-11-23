-- $20 per two-human child, paid once by the host when the partner joins
-- (docs/superpowers/specs/2026-07-31-coparent-matchmaking-design.md,
-- "Pricing and who pays"; server/src/payments/).
--
-- No foreign key to games: a payment is a financial record and must outlive
-- a deleted game (player erasure, admin deletion).

CREATE TABLE IF NOT EXISTS partner_payments (
  game_id            TEXT        PRIMARY KEY,
  status             TEXT        NOT NULL CHECK (status IN ('due', 'paid', 'refunded')),
  amount_cents       INTEGER     NOT NULL,
  currency           TEXT        NOT NULL,
  due_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at            TIMESTAMPTZ,
  paid_session_id    TEXT,
  payment_intent_id  TEXT,
  livemode           BOOLEAN,
  refund_id          TEXT,
  refunded_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every Checkout Session created for a child. More than one only when an
-- earlier one expired; a second *paid* one is refunded automatically and
-- marked duplicate_refunded.
CREATE TABLE IF NOT EXISTS partner_payment_sessions (
  session_id         TEXT        PRIMARY KEY,
  game_id            TEXT        NOT NULL,
  url                TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  status             TEXT        NOT NULL CHECK (status IN ('open', 'paid', 'expired', 'duplicate_refunded')),
  payment_intent_id  TEXT,
  refund_id          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_payment_sessions_game ON partner_payment_sessions (game_id);

-- Stripe webhook events already processed (at-most-once handling).
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     TEXT        PRIMARY KEY,
  type         TEXT        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
