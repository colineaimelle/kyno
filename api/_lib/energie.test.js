// api/lib/energie.test.js
// Usage : node api/lib/energie.test.js

const { besoinKcalJour } = require('./energie');
const { kcalPour100g, kcalTotale, TABLE_RAW } = require('./calories');

let passed = 0, failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  ✓  ${message}`); passed++; }
  else            { console.error(`  ✗  ${message}`); failed++; }
}

function assertApprox(val, expected, tolerancePct, message) {
  const ok = Math.abs(val - expected) / expected <= tolerancePct / 100;
  assert(ok, `${message} — résultat : ${val} (attendu ≈ ${expected} ±${tolerancePct}%)`);
}

// ── energie.js ─────────────────────────────────────────────────────────────────
console.log('\n=== Tests energie.js ===\n');

// Mâle entier, 13 kg, 3-7 ans, très actif
// RER = 70 × 13^0,75 = 70 × 6,849 = 479,4 | × 1,8 = 862,9 → ≈ 863
{
  const kcal = besoinKcalJour({
    poids: 13, age: '3 à 7 ans', sexe: 'mâle entier',
    activite: 'très actif', objectifs: [],
  });
  assertApprox(kcal, 863, 3, 'mâle entier 13 kg très actif → ≈ 863 kcal');
  assert(kcal >= 70 * Math.pow(13, 0.75), 'résultat ≥ 1,0 × RER');
}

// Femelle stérilisée, 12 kg, 3-7 ans, modérée
// RER = 70 × 12^0,75 = 451,2 | × 1,6 × 0,85 = 613,6 → ≈ 614
{
  const kcal = besoinKcalJour({
    poids: 12, age: '3 à 7 ans', sexe: 'femelle stérilisée',
    activite: 'modéré', objectifs: [],
  });
  assertApprox(kcal, 614, 3, 'femelle stérilisée 12 kg modérée → ≈ 614 kcal');
}

// Même chienne, objectif perte de poids, poids_ideal 10 kg
// Plancher = max(RER(10), RER(12)) = max(394, 451) = 451 kcal
{
  const kcal = besoinKcalJour({
    poids: 12, poids_ideal: 10, age: '3 à 7 ans', sexe: 'femelle stérilisée',
    activite: 'modéré', objectifs: ['perte de poids'],
  });
  assertApprox(kcal, 451, 3, 'perte de poids poids_ideal=10 kg, poids=12 kg → ≈ 451 kcal (plancher RER actuel)');
}

// Perte de poids avec poids_ideal = poids actuel → 1,0 × RER(actuel)
{
  const poids = 10;
  const rer = 70 * Math.pow(poids, 0.75);
  const kcal = besoinKcalJour({
    poids, poids_ideal: poids, age: '3 à 7 ans', sexe: 'femelle stérilisée',
    activite: 'modéré', objectifs: ['perte de poids'],
  });
  assertApprox(kcal, Math.round(rer), 3, `perte de poids poids_ideal=poids=10 kg → 1,0 × RER = ${Math.round(rer)} kcal`);
}

// Garde-fou perte de poids sans poids_ideal : très sédentaire stérilisée
// entretien × 0,8 = RER × 1,35 × 0,85 × 0,8 = RER × 0,918 < RER → plancher RER
{
  const poids = 10;
  const rer = 70 * Math.pow(poids, 0.75);
  const kcal = besoinKcalJour({
    poids, age: '3 à 7 ans', sexe: 'femelle stérilisée',
    activite: 'très sédentaire', objectifs: ['perte de poids'],
  });
  assert(kcal >= Math.round(rer), `garde-fou sans poids_ideal : résultat (${kcal}) ≥ 1,0 × RER (${Math.round(rer)})`);
}

// Chiot moins de 6 mois, 8 kg
// RER = 70 × 8^0,75 = 70 × 4,757 = 332,9 | × 3,0 = 998,8 → ≈ 999
{
  const kcal = besoinKcalJour({
    poids: 8, age: 'moins de 6 mois', sexe: 'mâle entier',
    activite: 'actif', objectifs: [],
  });
  assertApprox(kcal, 999, 3, 'chiot moins de 6 mois 8 kg → ≈ 999 kcal');
}

// Chiot 6 mois à 1 an, 10 kg
// RER = 393,6 | × 2,0 = 787 → ≈ 787
{
  const kcal = besoinKcalJour({
    poids: 10, age: '6 mois à 1 an', sexe: 'mâle entier',
    activite: 'actif', objectifs: [],
  });
  assertApprox(kcal, 787, 3, 'chiot 6 mois à 1 an 10 kg → ≈ 787 kcal');
}

// Garde-fou plafond : chien avec coeff très élevé ne dépasse pas 2,2 × RER
{
  const poids = 5;
  const rer = 70 * Math.pow(poids, 0.75);
  const kcal = besoinKcalJour({
    poids, age: '3 à 7 ans', sexe: 'mâle entier',
    activite: 'très actif', objectifs: ['prise de masse'],
  });
  assert(kcal <= Math.round(2.2 * rer) + 1, `garde-fou plafond : résultat (${kcal}) ≤ 2,2 × RER (${Math.round(2.2 * rer)})`);
}

// Multiplicateur âge 7-10 ans
// femelle stérilisée, 12 kg, modérée, 7-10 ans
// 614 × 0,9 = 552,7 → ≈ 553
{
  const kcal = besoinKcalJour({
    poids: 12, age: '7 à 10 ans', sexe: 'femelle stérilisée',
    activite: 'modéré', objectifs: [],
  });
  assertApprox(kcal, 553, 3, 'femelle stérilisée 12 kg modérée 7-10 ans → ≈ 553 kcal');
}

// null si poids manquant
{
  const kcal = besoinKcalJour({ age: '3 à 7 ans', activite: 'modéré', objectifs: [] });
  assert(kcal === null, 'poids manquant → null');
}

// Warning activité inconnue — ne doit pas planter, retourne 1,6
{
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  const kcal = besoinKcalJour({ poids: 10, age: '3 à 7 ans', sexe: 'mâle entier', activite: 'turbo-actif', objectifs: [] });
  console.warn = origWarn;
  assert(warns.length >= 1 && warns[0].includes('turbo-actif'), 'activité inconnue → console.warn émis');
  assert(typeof kcal === 'number' && kcal > 0, 'activité inconnue → fallback 1,6, résultat numérique');
}

// ── calories.js ────────────────────────────────────────────────────────────────
console.log('\n=== Tests calories.js ===\n');

// Lookups de base
assert(kcalPour100g('bœuf maigre') === 125,           '"bœuf maigre" → 125');
assert(kcalPour100g('bœuf haché') === 150,            '"bœuf haché" → 150 (générique)');
assert(kcalPour100g('bœuf haché 5% MG') === 121,      '"bœuf haché 5%" → 121 (Ciqual 2013)');
assert(kcalPour100g('bœuf haché 10% MG') === 169,     '"bœuf haché 10%" → 169 (Ciqual 2013)');
assert(kcalPour100g('bœuf haché 15% MG') === 199,     '"bœuf haché 15%" → 199 (Ciqual 2013)');
assert(kcalPour100g('bœuf haché 20% MG') === 285,     '"bœuf haché 20%" → 285 (Ciqual 2013)');
assert(kcalPour100g('agneau') === 128,                '"agneau" → 128 (Ciqual 2013)');
assert(kcalPour100g('gigot') === 128,                 '"gigot" → 128 (Ciqual 2013)');
assert(kcalPour100g('canard') === 132,                '"canard" → 132 sans peau (USDA)');
assert(kcalPour100g('saumon') === 208,                '"saumon" → 208');
assert(kcalPour100g('riz blanc') === 356,             '"riz blanc" → 356');
assert(kcalPour100g('riz') === 356,                  '"riz" → 356');
assert(kcalPour100g('carotte') === 41,                '"carotte" → 41');
assert(kcalPour100g('huile de colza') === 900,        '"huile de colza" → 900');
assert(kcalPour100g('huile') === 900,                 '"huile" → 900 (générique)');
assert(kcalPour100g('foie de poulet') === 116,        '"foie de poulet" → 116');
assert(kcalPour100g('ingrédient inconnu xyz') === null, '"inconnu xyz" → null');

// Variantes avec accents / apostrophes
assert(kcalPour100g("huile d'olive") !== null,    '"huile d\'olive" → trouvé');
assert(kcalPour100g('flocons d\'avoine') === 374,  '"flocons d\'avoine" → 374');
assert(kcalPour100g('épinards') === 23,            '"épinards" → 23');

// Pas de faux positifs
assert(kcalPour100g('salade verte') === null,     '"salade verte" → null (hors table)');

// ── Ajustement de ration (test intégration) ─────────────────────────────────
console.log('\n=== Test ajustement ration ===\n');

// Recette à ≈ 510 kcal, cible 860 kcal → ajustement proportionnel → ≈ 860 kcal
{
  const ingredients = [
    { name: 'bœuf maigre', qty_g_jour: 200 },
    { name: 'riz',         qty_g_jour: 60  },
    { name: 'carotte',     qty_g_jour: 50  },
    { name: 'huile de colza', qty_g_jour: 3 },
  ];

  const { kcal: kcalAvant, inconnus } = kcalTotale(ingredients);
  assert(inconnus.length === 0, 'aucun ingrédient inconnu dans la recette test');
  assertApprox(kcalAvant, 511, 3, `kcal initiales ≈ 511 (calculé : ${Math.round(kcalAvant)})`);

  const cible = 860;
  const factor = cible / kcalAvant;
  const scaled = ingredients.map(ing => {
    const k = kcalPour100g(ing.name);
    return k !== null
      ? { ...ing, qty_g_jour: Math.round(ing.qty_g_jour * factor) }
      : ing;
  });

  const { kcal: kcalApres } = kcalTotale(scaled);
  assertApprox(kcalApres, cible, 3, `kcal après ajustement ≈ 860 (calculé : ${Math.round(kcalApres)})`);
}

// ── Résumé ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests : ${passed} passés, ${failed} échoués\n`);
if (failed > 0) process.exit(1);
