// api/lib/energie.js
// Calcul du besoin énergétique journalier d'un chien (kcal/jour).
// Formule validée par la nutritionniste — NRC 2006 / FEDIAF 2023.

function normaliser(s) {
  return (s || '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COEFFICIENTS_ACTIVITE = {
  'tres sedentaire': 1.35,
  'sedentaire':      1.35,
  'modere':          1.60,
  'actif':           1.70,
  'tres actif':      1.80,
};

function coeffActivite(activite) {
  const key = normaliser(activite);
  if (!(key in COEFFICIENTS_ACTIVITE)) {
    console.warn(`[energie] activité non reconnue : "${activite}" — fallback 1,60`);
  }
  return COEFFICIENTS_ACTIVITE[key] ?? 1.60;
}

function estSterilise(sexe) {
  const s = normaliser(sexe);
  return s.includes('castre') || s.includes('sterilise');
}

// Convertit la tranche d'âge du quiz en âge médian en années.
// Fallback : extrait le premier nombre si le texte ne correspond à aucune tranche.
function ageEnAns(ageNorm) {
  if (ageNorm.includes('moins de 6 mois')) return 0;
  if (ageNorm.includes('6 mois'))          return 0.5;   // "6 mois à 1 an"
  if (ageNorm.includes('1 a 3'))           return 2;
  if (ageNorm.includes('3 a 7'))           return 5;
  if (ageNorm.includes('7 a 10'))          return 8.5;
  if (ageNorm.includes('plus de 10'))      return 11;
  const m = ageNorm.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// Seuil senior selon le poids de référence du chien (en kg).
// Règle Coline : petits < 10 kg → 10 ans, moyens 10–25 kg → 8 ans, grands > 25 kg → 7 ans.
function seuilSenior(poidsRef) {
  if (poidsRef < 10)  return 10;
  if (poidsRef <= 25) return 8;
  return 7;
}

// chien : { poids, poids_ideal?, age, sexe, activite, objectifs[] }
// Retourne les kcal/jour arrondis, ou null si données insuffisantes.
function besoinKcalJour(chien) {
  const poids = parseFloat(chien.poids) || 0;
  if (poids <= 0) return null;

  const rer = 70 * Math.pow(poids, 0.75);
  const age = normaliser(chien.age || '');

  // ── Chiots : coefficients spéciaux, remplacent activité et stérilisation ──────
  if (age.includes('moins de 6 mois')) return Math.round(3.0 * rer);
  if (age.includes('6 mois') && (age.includes('1 an') || age.includes('12 mois'))) {
    return Math.round(2.0 * rer);
  }

  // ── Adultes ───────────────────────────────────────────────────────────────────
  let coeff = coeffActivite(chien.activite);

  if (estSterilise(chien.sexe)) coeff *= 0.85;

  const poidsRef = parseFloat(chien.poids_ideal) > 0 ? parseFloat(chien.poids_ideal) : poids;
  if (ageEnAns(age) >= seuilSenior(poidsRef)) coeff *= 0.90;

  const objectifs = Array.isArray(chien.objectifs) ? chien.objectifs.map(normaliser) : [];
  const hasObj = kw => objectifs.some(o => o.includes(kw));

  if (hasObj('prise de masse') || hasObj('sport')) coeff *= 1.10;

  let kcal;

  if (hasObj('perte de poids')) {
    const poidsIdeal = parseFloat(chien.poids_ideal);
    if (poidsIdeal > 0) {
      // Plancher de sécurité = max(RER(ideal), RER(actuel))
      // Pour un chien en surpoids (actuel > ideal), cela donne 1,0 × RER(actuel).
      kcal = Math.max(70 * Math.pow(poidsIdeal, 0.75), rer);
    } else {
      // Sans poids idéal : besoin d'entretien × 0,8
      kcal = rer * coeff * 0.80;
      // Garde-fou : jamais sous 1,0 × RER du poids actuel
      kcal = Math.max(kcal, rer);
    }
  } else {
    kcal = rer * coeff;
    // Garde-fous : [1,0 × RER … 2,2 × RER] sur le poids actuel
    kcal = Math.max(kcal, rer);
    kcal = Math.min(kcal, 2.2 * rer);
  }

  return Math.round(kcal);
}

module.exports = { besoinKcalJour };
