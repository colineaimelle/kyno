-- Migration : création de la table chien (multi-chiens par foyer)
-- À exécuter dans l'éditeur SQL de Supabase (Settings > SQL Editor)
-- Idempotente : IF NOT EXISTS partout, INSERT protégé par NOT EXISTS.
-- Ne supprime aucune colonne de "user" (lectures seules conservées).

-- ── 1. Table chien ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chien (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email       text        NOT NULL REFERENCES "user"(email) ON DELETE CASCADE,

  -- Identité
  prenom_chien     text,
  race             text,
  poids            real,
  age              text,
  sexe             text,
  activite         text,

  -- Santé
  allergies        jsonb,
  sensibilites     jsonb,
  comportement     text,
  maladies         jsonb,
  traitements      text,
  reactions_allergiques text,
  reaction_statut  text,

  -- Alimentation
  mode_alimentaire    text,
  alimentation_actuelle jsonb,
  objectifs           text,
  observations        jsonb,

  -- Résultats cron
  proteine_principale text,
  apports             jsonb,
  batch_special       text,

  -- Chat
  chat_history        jsonb,

  -- Méta
  ordre            smallint    NOT NULL DEFAULT 1,
  actif            boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Index ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_chien_user_email ON chien (user_email);

-- ── 3. Copie des données existantes ──────────────────────────────────────────
-- Une ligne chien par foyer ayant un prenom_chien.
-- Le NOT EXISTS empêche les doublons si la migration est relancée.
INSERT INTO chien (
  user_email, prenom_chien, race, poids, age, sexe, activite,
  allergies, sensibilites, comportement, maladies, traitements,
  reactions_allergiques, reaction_statut,
  mode_alimentaire, alimentation_actuelle, objectifs, observations,
  proteine_principale, apports, batch_special, chat_history,
  ordre, actif, created_at
)
SELECT
  email, prenom_chien, race, poids, age, sexe, activite,
  allergies, sensibilites, comportement, maladies, traitements,
  reactions_allergiques, reaction_statut,
  mode_alimentaire, alimentation_actuelle, objectifs, observations,
  proteine_principale, apports, batch_special, chat_history,
  1, true, now()
FROM "user"
WHERE prenom_chien IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chien WHERE chien.user_email = "user".email
  );

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE chien ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'chien' AND policyname = 'chien_select_own'
  ) THEN
    CREATE POLICY chien_select_own ON chien
      FOR SELECT
      USING (auth.email() = user_email);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'chien' AND policyname = 'chien_update_own'
  ) THEN
    CREATE POLICY chien_update_own ON chien
      FOR UPDATE
      USING (auth.email() = user_email)
      WITH CHECK (auth.email() = user_email);
  END IF;
END$$;
