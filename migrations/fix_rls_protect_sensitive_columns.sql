-- Migration : protection des colonnes sensibles de la table "user"
-- À exécuter dans l'éditeur SQL de Supabase (Settings > SQL Editor)
-- Idempotente : CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
--
-- Contexte : la policy RLS user_can_update_own_row autorise un utilisateur
-- authentifié à mettre à jour sa propre ligne, mais ne peut pas restreindre
-- les colonnes (limitation Supabase/PostgreSQL RLS). Ce trigger comble le trou.
--
-- Colonnes protégées (modifiables uniquement via service_role / routes API) :
--   plan, statut, menu_envoye, rapport_envoye,
--   dernier_menu_envoye_le, derniere_relance
--
-- Colonnes autorisées depuis le navigateur (rôle 'authenticated') :
--   derniere_connexion, objectifs, chat_history, jour_envoi, et tout champ
--   profil-chien non listé ci-dessus.

-- ── 1. Fonction trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION protect_user_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- auth.role() = 'authenticated' → requête depuis le navigateur (JWT utilisateur).
  -- auth.role() = 'service_role'  → routes API ; la protection ne s'applique pas.
  IF auth.role() = 'authenticated' THEN
    IF NEW.plan                  IS DISTINCT FROM OLD.plan                  OR
       NEW.statut                IS DISTINCT FROM OLD.statut                OR
       NEW.menu_envoye           IS DISTINCT FROM OLD.menu_envoye           OR
       NEW.rapport_envoye        IS DISTINCT FROM OLD.rapport_envoye        OR
       NEW.dernier_menu_envoye_le IS DISTINCT FROM OLD.dernier_menu_envoye_le OR
       NEW.derniere_relance      IS DISTINCT FROM OLD.derniere_relance
    THEN
      RAISE EXCEPTION
        'Modification de colonnes sensibles non autorisée '
        '(plan, statut, menu_envoye, rapport_envoye, dernier_menu_envoye_le, derniere_relance). '
        'Utilisez les routes API avec la clé service.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. Trigger BEFORE UPDATE ─────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_protect_sensitive_columns ON "user";
CREATE TRIGGER trg_protect_sensitive_columns
  BEFORE UPDATE ON "user"
  FOR EACH ROW
  EXECUTE FUNCTION protect_user_sensitive_columns();
