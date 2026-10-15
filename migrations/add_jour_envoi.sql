-- Migration : ajout du choix du jour d'envoi de menu
-- À exécuter dans l'éditeur SQL de Supabase (Settings > SQL Editor)
-- Idempotente : utilise IF NOT EXISTS / IF EXISTS partout.

-- ── 1. Nouvelles colonnes ──────────────────────────────────────────────────
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS jour_envoi smallint NOT NULL DEFAULT 1
    CONSTRAINT jour_envoi_range CHECK (jour_envoi >= 1 AND jour_envoi <= 7),
  ADD COLUMN IF NOT EXISTS dernier_menu_envoye_le date NULL,
  ADD COLUMN IF NOT EXISTS derniere_relance date NULL;

COMMENT ON COLUMN "user".jour_envoi IS
  '1=Lundi … 7=Dimanche (ISO). Jour de réception hebdomadaire du menu.';

COMMENT ON COLUMN "user".dernier_menu_envoye_le IS
  'Date ISO du dernier menu envoyé avec succès. Anti-doublon cron.';

COMMENT ON COLUMN "user".derniere_relance IS
  'Date ISO de la dernière relance envoyée. Anti-spam cron (max 1/7 jours).';

-- ── 2. Index pour filtrage rapide dans le cron ────────────────────────────
CREATE INDEX IF NOT EXISTS idx_user_jour_envoi_statut
  ON "user" (jour_envoi, statut)
  WHERE statut IN ('beta', 'actif');

-- ── 3. Policy RLS – lecture (si RLS activé sur la table) ─────────────────
-- Un utilisateur authentifié peut lire sa propre ligne.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user' AND policyname = 'user_can_read_own_row'
  ) THEN
    CREATE POLICY user_can_read_own_row ON "user"
      FOR SELECT
      USING (auth.email() = email);
  END IF;
END$$;

-- ── 4. Policy RLS – mise à jour des colonnes non-sensibles ───────────────
-- NB : Supabase ne supporte pas les policies par colonne en natif.
-- Cette policy autorise UPDATE sur la ligne entière côté client.
-- La protection des colonnes sensibles (plan, statut, menu_envoye, rapport_envoye)
-- doit passer par un trigger ou une route API dédiée (voir ticket sécurité).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user' AND policyname = 'user_can_update_own_row'
  ) THEN
    CREATE POLICY user_can_update_own_row ON "user"
      FOR UPDATE
      USING (auth.email() = email)
      WITH CHECK (auth.email() = email);
  END IF;
END$$;

-- ── 5. Activer RLS si ce n'est pas encore fait ───────────────────────────
-- Décommenter si RLS n'est pas encore activé sur la table.
-- ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
