// api/lib/constantes.js
// Constantes nutritionnelles validées par Coline.

const RATION_G_PAR_KG_MIN = 15;
const RATION_G_PAR_KG_MAX = 120;
const DENSITE_KCAL_G_MIN  = 0.7;
const DENSITE_KCAL_G_MAX  = 2.5;

const TOLERANCE_KCAL_PCT    = 0.10; // ±10 % autour de la cible
const SEUIL_APPORTS_MIN_PCT = 80;   // protéines, calcium, oméga-3 à ≥ 80 % de leur cible

module.exports = {
  RATION_G_PAR_KG_MIN,
  RATION_G_PAR_KG_MAX,
  DENSITE_KCAL_G_MIN,
  DENSITE_KCAL_G_MAX,
  TOLERANCE_KCAL_PCT,
  SEUIL_APPORTS_MIN_PCT,
};
