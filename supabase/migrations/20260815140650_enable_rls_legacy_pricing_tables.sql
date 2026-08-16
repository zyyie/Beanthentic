-- Enable RLS on legacy pricing tables when they exist (idempotent for Preview DBs).

DO $$
BEGIN
  IF to_regclass('public.coffee_official_pricelist') IS NOT NULL THEN
    ALTER TABLE public.coffee_official_pricelist ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.coffee_official_pricelist FROM anon, authenticated;
    GRANT ALL ON TABLE public.coffee_official_pricelist TO service_role;
  END IF;

  IF to_regclass('public.farmer_price_applications') IS NOT NULL THEN
    ALTER TABLE public.farmer_price_applications ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.farmer_price_applications FROM anon, authenticated;
    GRANT ALL ON TABLE public.farmer_price_applications TO service_role;
  END IF;
END $$;
