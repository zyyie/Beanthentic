-- Beanthentic dual-store tables (calendar notes, self-sale audit, admin notification state)
-- Apply via Supabase SQL editor or: supabase db push / migration apply

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.calendar_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_date date NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'other',
  created_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_notes_note_date
  ON public.calendar_notes (note_date);

CREATE TABLE IF NOT EXISTS public.self_sale_unlock_audit (
  farmer_id bigint PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  unlocked_by text NOT NULL DEFAULT '',
  unlocked_by_phone text NOT NULL DEFAULT '',
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  pricelist_status text,
  records_unlocked boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.admin_notification_state (
  id text PRIMARY KEY DEFAULT 'default',
  read_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  dismissed_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.admin_notification_state (id, read_ids, dismissed_ids)
VALUES ('default', '[]'::jsonb, '[]'::jsonb)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.calendar_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.self_sale_unlock_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_notification_state ENABLE ROW LEVEL SECURITY;

-- Anon key used by Beanthentic admin/app; tighten policies for production as needed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_notes' AND policyname = 'calendar_notes_all'
  ) THEN
    CREATE POLICY calendar_notes_all ON public.calendar_notes
      FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'self_sale_unlock_audit' AND policyname = 'self_sale_unlock_audit_all'
  ) THEN
    CREATE POLICY self_sale_unlock_audit_all ON public.self_sale_unlock_audit
      FOR ALL USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_notification_state' AND policyname = 'admin_notification_state_all'
  ) THEN
    CREATE POLICY admin_notification_state_all ON public.admin_notification_state
      FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
