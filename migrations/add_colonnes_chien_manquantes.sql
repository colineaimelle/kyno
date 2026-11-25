-- Migration : colonnes de la table chien ajoutées par l'app mais absentes des fichiers de migration.
-- À exécuter dans Supabase → SQL Editor avant chaque déploiement qui touche à la génération des menus.
-- Idempotente : IF NOT EXISTS partout, aucune suppression, aucune modification de données existantes.

-- Résultats par chien (cron, generate-menu-chien, magic-link)
ALTER TABLE chien ADD COLUMN IF NOT EXISTS recette                 jsonb;
ALTER TABLE chien ADD COLUMN IF NOT EXISTS recette_verifiee        boolean DEFAULT false;
ALTER TABLE chien ADD COLUMN IF NOT EXISTS derniere_generation     date;
ALTER TABLE chien ADD COLUMN IF NOT EXISTS score_sante             smallint;
ALTER TABLE chien ADD COLUMN IF NOT EXISTS score_bullets           jsonb;
ALTER TABLE chien ADD COLUMN IF NOT EXISTS ingredients_grammes_crus jsonb;
