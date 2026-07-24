-- Run in Supabase SQL Editor (production_information).
-- Adds harvest, GCB classification/qty, and roasted classification/qty per variety.

ALTER TABLE production_information ADD COLUMN IF NOT EXISTS liberica_harvest_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS robusta_harvest_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS excelsa_harvest_qty_kg NUMERIC(10,2) DEFAULT 0;

ALTER TABLE production_information ADD COLUMN IF NOT EXISTS liberica_gcb_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS liberica_gcb_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS robusta_gcb_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS robusta_gcb_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS excelsa_gcb_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS excelsa_gcb_qty_kg NUMERIC(10,2) DEFAULT 0;

ALTER TABLE production_information ADD COLUMN IF NOT EXISTS liberica_roasted_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS liberica_roasted_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS robusta_roasted_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS robusta_roasted_qty_kg NUMERIC(10,2) DEFAULT 0;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS excelsa_roasted_classification VARCHAR(32) DEFAULT NULL;
ALTER TABLE production_information ADD COLUMN IF NOT EXISTS excelsa_roasted_qty_kg NUMERIC(10,2) DEFAULT 0;

ALTER TABLE production_information ADD COLUMN IF NOT EXISTS production_detail JSONB DEFAULT NULL;

-- Allowed values (documented for app/client):
-- GCB classification: small_beans | medium_beans | large_beans
-- Roasted classification: ground_beans | whole_beans
