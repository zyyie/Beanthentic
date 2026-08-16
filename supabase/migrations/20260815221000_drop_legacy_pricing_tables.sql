-- Redundant safety drop (no-op if 20260815220000 already removed legacy tables).
DROP TABLE IF EXISTS public.coffee_official_pricelist CASCADE;
DROP TABLE IF EXISTS public.farmer_price_applications CASCADE;
