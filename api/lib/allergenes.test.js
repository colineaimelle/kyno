// api/lib/allergenes.test.js
// Usage : node api/lib/allergenes.test.js

const { getTermesExclus, getAlimentsProches, detecterTermeInterdit, detecterTermeNonNie } = require('./allergenes');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  ${message}`);
    failed++;
  }
}

function check(label, texte, allergies, shouldBeNull) {
  const termes = getTermesExclus(allergies);
  const result = detecterTermeInterdit(texte, termes);
  if (shouldBeNull) {
    assert(result === null, label + ` → autorisé (résultat: ${JSON.stringify(result)})`);
  } else {
    assert(result !== null, label + ` → interdit (résultat: ${JSON.stringify(result)})`);
  }
}

console.log('\n=== Tests allergenes.js ===\n');

// ── Pas de faux positifs ────────────────────────────────────────────────────────
console.log('-- Faux positifs --');
check('"boeuf haché" avec allergie œuf',        'boeuf haché',          ['œuf'],    true);
check('"nouveau menu" avec allergie bœuf',       'nouveau menu',         ['bœuf'],   true);
check('"possible" avec allergie gluten',         'possible',             ['gluten'], true);
check('"barquette de légumes" avec allergie poisson', 'barquette de légumes', ['poisson'], true);
check('"salade de laitue" avec allergie laitages', 'salade de laitue',   ['laitages'], true);
check('"foie de porc" avec allergie canard',     'foie de porc',         ['canard'], true);
check('"veau" non contenu dans "nouveau"',       'poulet au nouveau goût', ['bœuf'], true);

// ── Détections attendues ────────────────────────────────────────────────────────
console.log('\n-- Détections attendues --');
check('"foie de bœuf" avec allergie bœuf',      'foie de bœuf',         ['bœuf'],   false);
check('"semoule" avec allergie gluten (alias)',   'semoule',              ['gluten'], false);
check('"foie de volaille" avec allergie poulet', 'foie de volaille',     ['poulet'], false);
check('"volaille" seul avec allergie poulet',    'volaille',             ['poulet'], false);
check('"abats de volaille" avec allergie dinde', 'abats de volaille',    ['dinde'],  false);
check('"oeuf de poule" avec allergie œuf',       'oeuf de poule',        ['œuf'],    false);
check('"filet de saumon" avec allergie huile de poisson', 'filet de saumon', ['huile de poisson'], false);
check('"poulet rôti" avec allergie poulet',      'poulet rôti',          ['poulet'], false);
check('"blé" avec allergie gluten (alias)',       'blé',                  ['gluten'], false);

// ── Normalisation œ/æ ──────────────────────────────────────────────────────────
console.log('\n-- Normalisation --');
{
  const termes = getTermesExclus(['œuf']);
  assert(termes.includes('oeuf'), 'allergie "œuf" → terme normalisé "oeuf" dans la liste');
}
{
  const termes = getTermesExclus(['bœuf']);
  assert(termes.includes('boeuf'), 'allergie "bœuf" → terme normalisé "boeuf" dans la liste');
}

// ── Aliments proches ───────────────────────────────────────────────────────────
console.log('\n-- Aliments proches --');
{
  const proches = getAlimentsProches(['poulet']);
  assert(proches.includes('dinde'), 'allergie poulet → "dinde" dans les proches');
  const termes = getTermesExclus(['poulet']);
  const result = detecterTermeInterdit('dinde', termes);
  assert(result === null, 'allergie poulet → "dinde" autorisée (pas dans les termes exclus)');
}
{
  // "oie" ne doit pas être détectée dans "foie" (vérification par mot entier)
  const prochesCanard = getAlimentsProches(['canard']);
  assert(prochesCanard.includes('oie'), 'allergie canard → "oie" dans les proches');
  const result = detecterTermeInterdit('foie de boeuf', prochesCanard);
  assert(result === null, '"foie de boeuf" ne déclenche pas "oie" (mot entier)');
}

// ── Alias quiz ─────────────────────────────────────────────────────────────────
console.log('\n-- Alias quiz --');
{
  const termes = getTermesExclus(['laitages']);
  assert(termes.includes('lait'), 'alias laitages → termes lait inclus');
  assert(termes.includes('yaourt'), 'alias laitages → yaourt interdit');
}
{
  const termes = getTermesExclus(['huile de poisson']);
  assert(termes.includes('saumon'), 'alias huile de poisson → saumon interdit');
  assert(termes.includes('thon'), 'alias huile de poisson → thon interdit');
}
{
  const termes = getTermesExclus(['gluten']);
  assert(termes.includes('epeautre'), 'alias gluten → épeautre interdit');
}

// ── detecterTermeNonNie (textes libres avec contexte de négation) ───────────────
console.log('\n-- Textes libres avec négation --');

function checkFree(label, texte, allergies, shouldBeNull) {
  const termes = getTermesExclus(allergies);
  const result = detecterTermeNonNie(texte, termes);
  if (shouldBeNull) {
    assert(result === null, label + ` → ignoré (résultat: ${JSON.stringify(result)})`);
  } else {
    assert(result !== null, label + ` → détecté (résultat: ${JSON.stringify(result)})`);
  }
}

checkFree('"lot sans poulet" — mention niée, pas de violation',
  'lot sans poulet', ['poulet'], true);
checkFree('"recette sans ses allergènes" — mention niée',
  'recette sans ses allergènes', ['poulet'], true);
checkFree('"exclu : poulet" — mention niée',
  'exclu : poulet', ['poulet'], true);
checkFree('"adapté aux allergies de Pistache" — pas de terme interdit',
  'adapté aux allergies de Pistache', ['poulet'], true);
checkFree('"200 g de foie de volaille" — terme interdit non nié',
  '200 g de foie de volaille', ['poulet'], false);
checkFree('"riche en protéines de poulet" — terme interdit non nié',
  'riche en protéines de poulet', ['poulet'], false);
checkFree('"sans gluten, avec de la semoule" — "semoule" non niée (allergie gluten)',
  'sans gluten, avec de la semoule', ['gluten'], false);

// ── Résumé ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests : ${passed} passés, ${failed} échoués\n`);
if (failed > 0) process.exit(1);
