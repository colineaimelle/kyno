// api/lib/allergenes.js
// Listes d'exclusion par allergène : termes interdits + aliments proches (avec message prudence).

// Table d'alias : valeurs quiz → clé ALLERGENES
const ALIAS = {
  'gluten':           'ble',
  'laitages':         'lait',
  'huile de poisson': 'poisson',
};

const ALLERGENES = {
  poulet: {
    termes: [
      'poulet', 'chicken',
      'foie de poulet', 'coeur de poulet', 'gesier de poulet',
      'volaille', 'foie de volaille', 'abats de volaille',
      'coeur de volaille', 'gesier de volaille',
      'bouillon de volaille', 'graisse de volaille',
      'proteine de poulet', 'hydrolysat de poulet', 'arome poulet',
      'gelatine de poulet', 'bouillon de poulet', 'collagene de poulet',
    ],
    proches: ['dinde', 'canard', 'oie', 'pintade', 'caille', 'oeuf'],
  },
  dinde: {
    termes: [
      'dinde', 'turkey',
      'foie de dinde', 'coeur de dinde', 'gesier de dinde',
      'volaille', 'foie de volaille', 'abats de volaille',
      'coeur de volaille', 'gesier de volaille',
      'bouillon de volaille', 'graisse de volaille',
      'proteine de dinde', 'hydrolysat de dinde', 'arome dinde',
      'bouillon de dinde',
    ],
    proches: ['poulet', 'canard', 'oie', 'pintade', 'caille', 'oeuf'],
  },
  canard: {
    termes: [
      'canard', 'duck',
      'foie de canard', 'coeur de canard', 'gesier de canard',
      'volaille', 'foie de volaille', 'abats de volaille',
      'coeur de volaille', 'gesier de volaille',
      'bouillon de volaille', 'graisse de volaille',
      'proteine de canard', 'hydrolysat de canard', 'arome canard',
      'bouillon de canard',
    ],
    proches: ['poulet', 'dinde', 'oie', 'pintade', 'caille', 'oeuf'],
  },
  boeuf: {
    termes: [
      'boeuf', 'beef', 'veau',
      'foie de boeuf', 'coeur de boeuf', 'tripe de boeuf',
      'proteine de boeuf', 'hydrolysat de boeuf', 'arome boeuf',
      'bouillon de boeuf', 'gelatine de boeuf', 'graisse de boeuf', 'collagene de boeuf',
    ],
    proches: ['agneau', 'chevre', 'fromage', 'lait', 'yaourt', 'beurre'],
  },
  agneau: {
    termes: [
      'agneau', 'lamb', 'mouton',
      "foie d'agneau", "coeur d'agneau",
      "proteine d'agneau", "hydrolysat d'agneau", "arome agneau",
      "bouillon d'agneau", "graisse d'agneau",
    ],
    proches: ['boeuf', 'chevre', 'cerf', 'sanglier'],
  },
  porc: {
    termes: [
      'porc', 'pork', 'cochon', 'jambon', 'bacon',
      'foie de porc', 'coeur de porc', 'rein de porc',
      'lard', 'graisse de porc', 'saindoux',
      'proteine de porc', 'hydrolysat de porc', 'arome porc',
      'bouillon de porc', 'gelatine de porc', 'collagene de porc',
    ],
    proches: ['sanglier'],
  },
  poisson: {
    termes: [
      'poisson', 'fish',
      'saumon', 'thon', 'cabillaud', 'merlu', 'hareng', 'maquereau',
      'sardine', 'truite', 'sole', 'daurade', 'bar', 'anchois', 'tilapia',
      'huile de poisson', 'farine de poisson', 'proteine de poisson',
      'hydrolysat de poisson', 'bouillon de poisson', 'fumet de poisson',
    ],
    proches: [],
  },
  oeuf: {
    termes: [
      'oeuf', 'egg',
      "blanc d'oeuf", "jaune d'oeuf",
      'albumine', "poudre d'oeuf", "proteine d'oeuf",
    ],
    proches: [],
  },
  lait: {
    termes: [
      'lait', 'milk', 'lactose', 'lactoserum', 'whey',
      'fromage', 'yaourt', 'yogourt', 'beurre', 'creme',
      'caseine', 'proteine laitiere',
    ],
    proches: [],
  },
  ble: {
    termes: [
      'ble', 'wheat', 'gluten',
      'farine de ble', 'son de ble', 'amidon de ble',
      'semoule', 'epeautre', 'kamut',
    ],
    proches: ['orge', 'seigle', 'avoine'],
  },
  soja: {
    termes: [
      'soja', 'soy', 'soya',
      'proteine de soja', 'farine de soja', 'lecithine de soja',
      'huile de soja', 'tofu',
    ],
    proches: ['pois', 'lentilles'],
  },
  levure: {
    termes: [
      'levure', 'levure de biere', 'levure nutritionnelle',
      'extrait de levure', 'levure alimentaire',
    ],
    proches: [],
  },
};

// Normalise un texte pour comparaison : minuscules, ligatures, diacritiques, apostrophes.
function normalise(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['']/g, "'");
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Recherche par mot entier (insensible aux accents/casse).
function motEntierTrouve(texteNorm, termeNorm) {
  if (!termeNorm) return false;
  return new RegExp('\\b' + escapeRegex(termeNorm) + '\\b').test(texteNorm);
}

// Résout l'allergie déclarée → clé ALLERGENES (gère alias et normalisation).
function resoudreAllergie(allergie) {
  const norm = normalise(allergie);
  if (ALIAS[norm]) return ALIAS[norm];
  // Correspondance directe avec une clé
  for (const k of Object.keys(ALLERGENES)) {
    if (normalise(k) === norm) return k;
  }
  return null; // allergie non répertoriée → traitement comme terme simple
}

// Retourne tous les termes interdits pour un chien d'après ses allergies déclarées.
function getTermesExclus(allergies) {
  if (!Array.isArray(allergies) || !allergies.length) return [];
  const termes = new Set();
  allergies.forEach(allergie => {
    const cle = resoudreAllergie(allergie);
    if (cle && ALLERGENES[cle]) {
      // Stocker les termes déjà normalisés pour éviter les doublons accent/non-accent
      ALLERGENES[cle].termes.forEach(t => termes.add(normalise(t)));
    } else {
      // Allergie non répertoriée : l'inclure telle quelle comme terme simple
      termes.add(normalise(allergie));
    }
  });
  return [...termes];
}

// Retourne les aliments proches (autorisés mais avec message prudence).
function getAlimentsProches(allergies) {
  if (!Array.isArray(allergies) || !allergies.length) return [];
  const proches = new Set();
  allergies.forEach(allergie => {
    const cle = resoudreAllergie(allergie);
    if (cle && ALLERGENES[cle]) {
      ALLERGENES[cle].proches.forEach(p => proches.add(p));
    }
  });
  return [...proches];
}

// Retourne le premier terme interdit trouvé dans un texte (mot entier), ou null.
// Utiliser pour les champs structurés (ingrédients, batch_special) : zéro tolérance.
function detecterTermeInterdit(texte, termesExclus) {
  if (!texte || !termesExclus.length) return null;
  const norm = normalise(texte);
  for (const terme of termesExclus) {
    // termesExclus contient déjà des termes normalisés (depuis getTermesExclus)
    // ou des chaînes brutes (depuis buildProchesAlert) — on normalise dans les deux cas
    if (motEntierTrouve(norm, normalise(terme))) return terme;
  }
  return null;
}

// Mots qui annulent la mention d'un terme (contexte des 40 caractères précédents).
const NEGATIFS = ['sans', 'pas de', 'aucun', 'exclu', 'exclus', 'exclure', 'exclut', 'evite', 'eviter', 'interdit', 'interdits', 'allergene', 'allergie'];

// Retourne le premier terme interdit trouvé dans un texte libre, en ignorant
// les mentions niées (ex : « sans poulet »). Utiliser pour note et titre.
function detecterTermeNonNie(texte, termesExclus) {
  if (!texte || !termesExclus.length) return null;
  const norm = normalise(texte);
  for (const terme of termesExclus) {
    const termeNorm = normalise(terme);
    const regex = new RegExp('\\b' + escapeRegex(termeNorm) + '\\b', 'g');
    let match;
    while ((match = regex.exec(norm)) !== null) {
      const contextBefore = norm.slice(Math.max(0, match.index - 20), match.index);
      const estNie = NEGATIFS.some(neg => contextBefore.includes(neg));
      if (!estNie) return terme;
    }
  }
  return null;
}

module.exports = { ALLERGENES, ALIAS, getTermesExclus, getAlimentsProches, detecterTermeInterdit, detecterTermeNonNie };
