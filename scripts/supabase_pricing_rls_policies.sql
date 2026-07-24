-- Targeted RLS policies for Coffee Pricing flow in Beanthentic.
-- Run this in Supabase SQL Editor after creating tables from scripts/supabase_pricing_flow.sql

-- Ensure RLS is enabled.
ALTER TABLE public.coffee_pricelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_price_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmers ENABLE ROW LEVEL SECURITY;

-- Drop old policy names if they already exist (safe re-run).
DROP POLICY IF EXISTS beanthentic_pricelist_select_anon ON public.coffee_pricelist;
DROP POLICY IF EXISTS beanthentic_pricelist_insert_anon ON public.coffee_pricelist;
DROP POLICY IF EXISTS beanthentic_pricelist_update_anon ON public.coffee_pricelist;
DROP POLICY IF EXISTS beanthentic_pricelist_delete_anon ON public.coffee_pricelist;
DROP POLICY IF EXISTS beanthentic_applications_select_anon ON public.farmer_price_application;
DROP POLICY IF EXISTS beanthentic_applications_insert_anon ON public.farmer_price_application;
DROP POLICY IF EXISTS beanthentic_applications_update_anon ON public.farmer_price_application;
DROP POLICY IF EXISTS beanthentic_farmers_self_sale_select_anon ON public.farmers;
DROP POLICY IF EXISTS beanthentic_farmers_self_sale_update_anon ON public.farmers;

-- coffee_pricelist table access (admin backend uses anon key).
CREATE POLICY beanthentic_pricelist_select_anon
ON public.coffee_pricelist
FOR SELECT
TO anon
USING (true);

CREATE POLICY beanthentic_pricelist_insert_anon
ON public.coffee_pricelist
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY beanthentic_pricelist_update_anon
ON public.coffee_pricelist
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

CREATE POLICY beanthentic_pricelist_delete_anon
ON public.coffee_pricelist
FOR DELETE
TO anon
USING (true);

-- farmer_price_application table access (mobile app + admin review flow).
CREATE POLICY beanthentic_applications_select_anon
ON public.farmer_price_application
FOR SELECT
TO anon
USING (true);

CREATE POLICY beanthentic_applications_insert_anon
ON public.farmer_price_application
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY beanthentic_applications_update_anon
ON public.farmer_price_application
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

-- farmers.self_sale_enabled access used by /api/farmer-self-sale and app checks.
CREATE POLICY beanthentic_farmers_self_sale_select_anon
ON public.farmers
FOR SELECT
TO anon
USING (true);

CREATE POLICY beanthentic_farmers_self_sale_update_anon
ON public.farmers
FOR UPDATE
TO anon
USING (true)
WITH CHECK (true);

