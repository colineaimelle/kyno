// tests/verifier-menu.test.js
// Lance avec : node tests/verifier-menu.test.js
// Vérifie verifierMenu sur des recettes d'exemple, sans appel IA.

const { verifierMenu } = require('../api/lib/verifierMenu');

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  OK  ${label}`);
    passed++;
  } catch (e) {
    console.log(`ECHEC ${label}`);
    console.log(`      ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion échouée');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Construit un mc (entrée chiens[i]) minimal pour les tests.
// ings : [[name, qty_g_jour], ...] — kcal_100g non utilisé (verifierMenu appelle kcalPour100g)
function buildMc({ chien_id, ings, batchSpecial = '', apports = [] }) {
  return {
    chien_id,
    recette: {
      ingredients: ings.map(([name]) => ({ name, qty: '10 g' })),
    },
    ingredients_grammes_crus: ings.map(([name, qty_g_jour]) => ({ name, qty_g_jour })),
    batch_special: batchSpecial,
    apports,
  };
}

// ── Chien 1 : chihuahua 2 kg senior (cible ≈ 170 kcal/j) ───────────────────
// Valeurs Ciqual : bœuf haché 5% → 121 kcal/100g, patate douce → 86, courgette → 16, huile de colza → 900
// CMV adulte → hors table → 0 kcal
console.log('\n── Chihuahua senior 2 kg (cible 170 kcal) ──');

const chihuahua  = { id: 'chi1', poids: 2, allergies: [] };
const ciblesChi  = { chi1: 170 };

test('Recette correcte (acceptée)', () => {
  // 90×121/100 + 30×86/100 + 20×16/100 + 3×900/100 = 108.9+25.8+3.2+27 = 164.9 kcal → ±3% de 170 ✓
  const menu = buildMc({
    chien_id: 'chi1',
    ings: [
      ['bœuf haché 5%',  90],
      ['patate douce',   30],
      ['courgette',      20],
      ['huile de colza',  3],
      ['CMV adulte',      1],
    ],
    batchSpecial: 'Ajouter 3 g huile de colza + 1 g CMV',
  });
  const { ok, raisons } = verifierMenu(menu, chihuahua, ciblesChi);
  assert(ok, `Attendu OK mais: ${raisons.join('; ')}`);
});

test('Recette à 75 kcal (refusée — calories trop basses)', () => {
  // 43×121/100 + 19×86/100 + 15×16/100 + 2×900/100 = 52.0+16.3+2.4+18 = 88.7 kcal → -48% de 170 ✗
  const menu = buildMc({
    chien_id: 'chi1',
    ings: [
      ['bœuf haché 5%',  43],
      ['patate douce',   19],
      ['courgette',      15],
      ['huile de colza',  2],
      ['CMV adulte',    0.5],
    ],
    batchSpecial: 'Ajouter huile + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, chihuahua, ciblesChi);
  assert(!ok, 'Attendu ECHEC mais vérification passée');
  assert(raisons.some(r => r.includes('Calories')), `Raison calorie manquante: ${raisons.join('; ')}`);
});

test('Recette sans CMV (refusée)', () => {
  const menu = buildMc({
    chien_id: 'chi1',
    ings: [
      ['bœuf haché 5%',  90],
      ['patate douce',   30],
      ['courgette',      20],
      ['huile de colza',  3],
    ],
    batchSpecial: 'Ajouter 3 g huile de colza',
  });
  const { ok, raisons } = verifierMenu(menu, chihuahua, ciblesChi);
  assert(!ok, 'Attendu ECHEC mais vérification passée');
  assert(raisons.some(r => r.includes('CMV')), `Raison CMV manquante: ${raisons.join('; ')}`);
});

// ── Chien 2 : braque 25 kg (poids de forme, cible 1200 kcal/j) ───────────────
// Valeurs Ciqual : poulet → 119 kcal/100g, patate douce → 86, courgette → 16, huile → 900
console.log('\n── Braque 25 kg (cible 1200 kcal) ──');

const braque    = { id: 'bra1', poids: 25, allergies: [] };
const ciblesBra = { bra1: 1200 };

test('Braque recette correcte (acceptée)', () => {
  // 600×119/100 + 150×86/100 + 50×16/100 + 30×900/100 = 714+129+8+270 = 1121 kcal → ±6.6% de 1200 ✓
  const menu = buildMc({
    chien_id: 'bra1',
    ings: [
      ['poulet',          600],
      ['patate douce',    150],
      ['courgette',        50],
      ['huile de colza',   30],
      ['CMV adulte',        5],
    ],
    batchSpecial: 'Ajouter huile de colza + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, braque, ciblesBra);
  assert(ok, `Attendu OK mais: ${raisons.join('; ')}`);
});

// ── Chien 3 : chien 21 kg allergique au poisson ──────────────────────────────
// Valeurs Ciqual : dinde → 130, courgette → 16, huile de saumon → 900, haricots verts → 31
console.log('\n── Chien 21 kg allergique au poisson (cible 1000 kcal) ──');

const chienPoisson  = { id: 'poi1', poids: 21, allergies: ['poisson'] };
const ciblesPoi     = { poi1: 1000 };

test('Recette avec huile de saumon (refusée — allergie)', () => {
  // calories ~768 kcal (< 900) ET allergie saumon → double échec, allergie présente ✓
  const menu = buildMc({
    chien_id: 'poi1',
    ings: [
      ['dinde',          500],
      ['courgette',       80],
      ['huile de saumon', 10],
      ['CMV adulte',       5],
      ['haricots verts',  50],
    ],
    batchSpecial: 'Ajouter huile de saumon + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, chienPoisson, ciblesPoi);
  assert(!ok, 'Attendu ECHEC mais vérification passée');
  assert(raisons.some(r => r.includes('Allergie')), `Raison allergie manquante: ${raisons.join('; ')}`);
});

test('Recette avec colza et lin (acceptée — pas de poisson)', () => {
  // 580×130/100 + 120×86/100 + 50×16/100 + 15×900/100 = 754+103+8+135 = 1000.2 kcal ✓
  // graine de lin hors table → kcal ignorées, poids <1% total → non bloquant
  const menu = buildMc({
    chien_id: 'poi1',
    ings: [
      ['dinde',           580],
      ['patate douce',    120],
      ['courgette',        50],
      ['huile de colza',   15],
      ['graine de lin',     5],
      ['CMV adulte',        5],
    ],
    batchSpecial: 'Ajouter huile de colza + graine de lin + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, chienPoisson, ciblesPoi);
  assert(ok, `Attendu OK mais: ${raisons.join('; ')}`);
});

// ── Chien 4 : épagneul 13 kg actif ───────────────────────────────────────────
// Valeurs Ciqual : bœuf haché 5% → 121, patate douce → 86, courgette → 16, huile → 900
// bœuf haché (générique) → 150
console.log('\n── Épagneul 13 kg actif (cible 850 kcal) ──');

const epagneul  = { id: 'epa1', poids: 13, allergies: [] };
const ciblesEpa = { epa1: 850 };

test('Épagneul recette correcte (acceptée)', () => {
  // 500×121/100 + 100×86/100 + 50×16/100 + 15×900/100 = 605+86+8+135 = 834 kcal → ±1.9% ✓
  const menu = buildMc({
    chien_id: 'epa1',
    ings: [
      ['bœuf haché 5%',  500],
      ['patate douce',   100],
      ['courgette',       50],
      ['huile de colza',  15],
      ['CMV adulte',       5],
    ],
    batchSpecial: 'Ajouter huile de colza + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, epagneul, ciblesEpa);
  assert(ok, `Attendu OK mais: ${raisons.join('; ')}`);
});

test('Épagneul recette à 138 % de la cible (refusée — calories trop hautes)', () => {
  // bœuf haché (générique 150) : 600×150/100 + 150×86/100 + 50×16/100 + 15×900/100
  //   = 900+129+8+135 = 1172 kcal → 138% de 850 → -38% de cible (>10%) ✗
  const menu = buildMc({
    chien_id: 'epa1',
    ings: [
      ['bœuf haché',     600],
      ['patate douce',   150],
      ['courgette',       50],
      ['huile de colza',  15],
      ['CMV adulte',       5],
    ],
    batchSpecial: 'Ajouter huile de colza + CMV',
  });
  const { ok, raisons } = verifierMenu(menu, epagneul, ciblesEpa);
  assert(!ok, 'Attendu ECHEC mais vérification passée');
  assert(raisons.some(r => r.includes('Calories')), `Raison calorie manquante: ${raisons.join('; ')}`);
});

// ── Résultats ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Résultat : ${passed} OK, ${failed} ÉCHEC`);
if (failed > 0) {
  console.log('BILAN : TESTS ÉCHOUÉS');
  process.exit(1);
} else {
  console.log('BILAN : TOUS LES TESTS PASSENT');
  process.exit(0);
}
