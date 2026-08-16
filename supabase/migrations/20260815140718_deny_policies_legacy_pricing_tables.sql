-- Deny anon/authenticated on legacy pricing tables when they exist (idempotent).

DO $$
BEGIN
  IF to_regclass('public.coffee_official_pricelist') IS NOT NULL THEN
    DROP POLICY IF EXISTS coffee_official_pricelist_deny_anon ON public.coffee_official_pricelist;
    DROP POLICY IF EXISTS coffee_official_pricelist_deny_authenticated ON public.coffee_official_pricelist;
    CREATE POLICY coffee_official_pricelist_deny_anon
      ON public.coffee_official_pricelist
      FOR ALL TO anon
      USING (false) WITH CHECK (false);
    CREATE POLICY coffee_official_pricelist_deny_authenticated
      ON public.coffee_official_pricelist
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false);
  END IF;

  IF to_regclass('public.farmer_price_applications') IS NOT NULL THEN
    DROP POLICY IF EXISTS farmer_price_applications_deny_anon ON public.farmer_price_applications;
    DROP POLICY IF EXISTS farmer_price_applications_deny_authenticated ON public.farmer_price_applications;
    CREATE POLICY farmer_price_applications_deny_anon
      ON public.farmer_price_applications
      FOR ALL TO anon
      USING (false) WITH CHECK (false);
    CREATE POLICY farmer_price_applications_deny_authenticated
      ON public.farmer_price_applications
      FOR ALL TO authenticated
      USING (false) WITH CHECK (false);
  END IF;
END $$;
