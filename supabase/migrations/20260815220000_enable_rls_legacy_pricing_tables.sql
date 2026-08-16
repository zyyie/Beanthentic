-- Enable RLS on unused legacy pricing tables.
-- Live app uses coffee_pricelist + farmer_price_application (already RLS-protected).
-- Deny-by-default for anon/authenticated; service_role bypasses RLS.

ALTER TABLE public.coffee_official_pricelist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_price_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.coffee_official_pricelist FROM anon, authenticated;
REVOKE ALL ON TABLE public.farmer_price_applications FROM anon, authenticated;

GRANT ALL ON TABLE public.coffee_official_pricelist TO service_role;
GRANT ALL ON TABLE public.farmer_price_applications TO service_role;

-- Explicit deny policies (documents intent; blocks Data API roles)
DROP POLICY IF EXISTS coffee_official_pricelist_deny_anon ON public.coffee_official_pricelist;
DROP POLICY IF EXISTS coffee_official_pricelist_deny_authenticated ON public.coffee_official_pricelist;
CREATE POLICY coffee_official_pricelist_deny_anon
  ON public.coffee_official_pricelist
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);
CREATE POLICY coffee_official_pricelist_deny_authenticated
  ON public.coffee_official_pricelist
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS farmer_price_applications_deny_anon ON public.farmer_price_applications;
DROP POLICY IF EXISTS farmer_price_applications_deny_authenticated ON public.farmer_price_applications;
CREATE POLICY farmer_price_applications_deny_anon
  ON public.farmer_price_applications
  FOR ALL
  TO anon
  USING (false)
  WITH CHECK (false);
CREATE POLICY farmer_price_applications_deny_authenticated
  ON public.farmer_price_applications
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);
