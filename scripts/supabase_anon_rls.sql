-- Beanthentic: allow anon role to access public tables via Supabase REST (RLS).
-- Applied via Supabase MCP; keep for reference / other environments.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY beanthentic_anon_select ON public.%I FOR SELECT TO anon USING (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY beanthentic_anon_insert ON public.%I FOR INSERT TO anon WITH CHECK (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY beanthentic_anon_update ON public.%I FOR UPDATE TO anon USING (true) WITH CHECK (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY beanthentic_anon_delete ON public.%I FOR DELETE TO anon USING (true)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;
