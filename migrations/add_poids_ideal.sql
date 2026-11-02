-- migrations/add_poids_ideal.sql
-- Ajoute la colonne poids_ideal (poids cible pour le calcul perte de poids) à la table chien.
-- Idempotente : n'échoue pas si la colonne existe déjà.
-- À exécuter dans l'éditeur SQL de Supabase.

ALTER TABLE chien
  ADD COLUMN IF NOT EXISTS poids_ideal real;

COMMENT ON COLUMN chien.poids_ideal IS
  'Poids idéal en kg, utilisé par le code pour le calcul énergétique en cas de perte de poids (1,0 × RER du poids idéal). Null si non renseigné.';
