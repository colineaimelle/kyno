// api/lib/constantes.js
// Constantes nutritionnelles validées par Coline.

const RATION_G_PAR_KG_MIN = 15;
const RATION_G_PAR_KG_MAX = 120;
const DENSITE_KCAL_G_MIN  = 0.7;
const DENSITE_KCAL_G_MAX  = 2.5;

const TOLERANCE_KCAL_PCT    = 0.10; // ±10 % autour de la cible
const SEUIL_APPORTS_MIN_PCT = 80;   // protéines, calcium, oméga-3 à ≥ 80 % de leur cible

// Version des CGV acceptées (à mettre à jour à chaque nouvelle version)
const VERSION_CGV = '26 novembre 2026';

// Limites de messages de l'assistant, par chien et par jour (réinitialisées à minuit heure de Paris)
const MSG_LIMIT_PREMIERS_JOURS = 20; // pendant les DUREE premiers jours d'abonnement (toutes formules)
const MSG_LIMIT_KYNO            =  5; // après la période initiale, formule Kyno
const MSG_LIMIT_KYNO_PLUS       = 20; // après la période initiale, formule Kyno+ (fondateurs inclus)
const MSG_LIMIT_DUREE_JOURS     = 30; // durée de la période initiale en jours

module.exports = {
  VERSION_CGV,
  RATION_G_PAR_KG_MIN,
  RATION_G_PAR_KG_MAX,
  DENSITE_KCAL_G_MIN,
  DENSITE_KCAL_G_MAX,
  TOLERANCE_KCAL_PCT,
  SEUIL_APPORTS_MIN_PCT,
  MSG_LIMIT_PREMIERS_JOURS,
  MSG_LIMIT_KYNO,
  MSG_LIMIT_KYNO_PLUS,
  MSG_LIMIT_DUREE_JOURS,
};
