-- Drop unused leftover pricing tables (live app uses coffee_pricelist + farmer_price_application).

DROP TABLE IF EXISTS public.coffee_official_pricelist CASCADE;
DROP TABLE IF EXISTS public.farmer_price_applications CASCADE;
