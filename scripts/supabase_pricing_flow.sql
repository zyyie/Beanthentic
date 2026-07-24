-- Coffee pricelist, farmer self-sale flag, and price applications (Supabase / PostgreSQL).
-- Run in Supabase SQL Editor or via psql against the Beanthentic app database.

ALTER TABLE farmers
  ADD COLUMN IF NOT EXISTS self_sale_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS coffee_pricelist (
  price_id SERIAL PRIMARY KEY,
  variety VARCHAR(32) NOT NULL,
  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
  classification VARCHAR(64) NOT NULL DEFAULT '',
  price_per_kg NUMERIC(10, 2) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'PHP',
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (variety, bean_type, classification)
);

CREATE TABLE IF NOT EXISTS farmer_price_application (
  application_id SERIAL PRIMARY KEY,
  farmer_id INT NOT NULL REFERENCES farmers (farmer_id) ON DELETE CASCADE,
  variety VARCHAR(32) NOT NULL,
  bean_type VARCHAR(32) NOT NULL DEFAULT 'gcb',
  classification VARCHAR(64) NOT NULL DEFAULT '',
  quantity_kg NUMERIC(10, 2) NOT NULL,
  sale_channel VARCHAR(32) NOT NULL DEFAULT 'self_sale',
  requested_price_per_kg NUMERIC(10, 2),
  reference_price_per_kg NUMERIC(10, 2),
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  farmer_notes TEXT,
  admin_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farmer_price_application_farmer
  ON farmer_price_application (farmer_id);

CREATE INDEX IF NOT EXISTS idx_farmer_price_application_status
  ON farmer_price_application (status, submitted_at DESC);

-- Optional seed rows (base GCB prices per variety).
INSERT INTO coffee_pricelist (variety, bean_type, classification, price_per_kg, notes)
VALUES
  ('liberica', 'gcb', '', 180.00, 'Default drop-off reference price'),
  ('excelsa', 'gcb', '', 170.00, 'Default drop-off reference price'),
  ('robusta', 'gcb', '', 150.00, 'Default drop-off reference price'),
  ('liberica', 'roasted', '', 220.00, 'Default drop-off reference price'),
  ('excelsa', 'roasted', '', 210.00, 'Default drop-off reference price'),
  ('robusta', 'roasted', '', 190.00, 'Default drop-off reference price')
ON CONFLICT (variety, bean_type, classification) DO NOTHING;
