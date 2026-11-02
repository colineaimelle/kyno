// api/lib/calories.js
// Table des kcal pour 100 g CRU.
// Sources : Ciqual 2013 (ANSES) ; canard sans peau d'après USDA.

function normaliser(s) {
  return (s || '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[''%()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// [clé normalisée, kcal/100g cru]
// Trié par longueur décroissante pour que les clés les plus spécifiques soient testées en premier.
const TABLE_RAW = [
  // ── Viandes ────────────────────────────────────────────────────────────────────
  ['boeuf hache 5',         121],  // bœuf haché 5% MG — Ciqual 2013
  ['boeuf hache 10',        169],  // bœuf haché 10% MG — Ciqual 2013
  ['boeuf hache 15',        199],  // bœuf haché 15% MG — Ciqual 2013
  ['boeuf hache 20',        285],  // bœuf haché 20% MG — Ciqual 2013
  ['boeuf hache',           150],  // bœuf haché générique (moyenne)
  ['steak hache',           150],
  ['boeuf maigre',          125],  // rumsteck, tende de tranche…
  ['boeuf',                 125],
  ['veau',                  107],
  ['blanc de poulet',       110],
  ['filet de poulet',       110],
  ['poulet blanc',          110],
  ['cuisse de poulet',      130],
  ['poulet entier',         119],
  ['poulet',                119],
  ['blanc de dinde',        107],
  ['filet de dinde',        107],
  ['dinde blanc',           107],
  ['dinde',                 130],
  ['agneau',                128],  // Ciqual 2013
  ['gigot',                 128],  // Ciqual 2013
  ['porc maigre',           108],
  ['filet de porc',         108],
  ['epaule de porc',        145],
  ['porc',                  120],
  ['canard',                132],  // sans peau — USDA
  ['lapin',                 114],
  ['cheval',                108],
  ['cerf',                  109],
  ['sanglier',              122],
  ['bison',                 109],
  ['autruche',              105],
  ['viande hachee',         150],
  ['volaille',              119],

  // ── Abats ──────────────────────────────────────────────────────────────────────
  ['foie de boeuf',         137],
  ['foie de veau',          139],
  ['foie de poulet',        116],
  ['foie de porc',          141],
  ['foie de volaille',      116],
  ['foie',                  130],  // générique
  ['coeur de boeuf',        115],
  ['coeur de poulet',       128],
  ['coeur de dinde',        128],
  ['coeur',                 120],  // générique
  ['rognons de boeuf',      100],
  ['rognons',               100],
  ['rate',                   95],
  ['poumons',                85],
  ['estomac',                95],
  ['tripes',                 65],
  ['abats de volaille',     116],
  ['abats',                 120],

  // ── Poissons ───────────────────────────────────────────────────────────────────
  ['saumon atlantique',     208],
  ['saumon sauvage',        183],
  ['saumon',                208],
  ['thon rouge',            144],
  ['thon en conserve',      185],
  ['thon',                  144],
  ['sardine',               185],
  ['cabillaud',              82],
  ['morue',                  72],
  ['merlan',                 72],
  ['maquereau',             205],
  ['hareng',                158],
  ['truite',                119],

  // ── Œufs ───────────────────────────────────────────────────────────────────────
  ['oeuf de poule',         143],
  ['oeuf',                  143],

  // ── Féculents (poids CRU avant cuisson) ────────────────────────────────────────
  ['riz complet',           349],
  ['riz blanc',             356],
  ['riz',                   356],
  ['pates seches',          370],
  ['pates',                 370],
  ['quinoa',                368],
  ['lentilles corail',      339],
  ['lentilles vertes',      339],
  ['lentilles',             339],
  ['lentille',              339],
  ['patate douce',           86],
  ['pomme de terre',         77],
  ['flocons d avoine',      374],
  ['avoine',                374],
  ['flocons',               374],
  ['orge',                  354],
  ['millet',                354],
  ['sarrasin',              343],
  ['pois chiches',          360],
  ['pois casse',            340],

  // ── Légumes ────────────────────────────────────────────────────────────────────
  ['haricots verts',         31],
  ['haricot vert',           31],
  ['courgette',              16],
  ['carotte',                41],
  ['epinards',               23],
  ['epinard',                23],
  ['brocoli',                34],
  ['betterave',              43],
  ['celeri branche',         16],
  ['celeri rave',            40],
  ['celeri',                 16],
  ['potiron',                26],
  ['potimarron',             45],
  ['courge',                 26],
  ['chou vert',              26],
  ['chou fleur',             25],
  ['chou',                   26],
  ['concombre',              12],
  ['poivron',                20],
  ['tomate',                 18],
  ['fenouil',                12],
  ['panais',                 65],
  ['navet',                  22],
  ['radis',                  16],
  ['asperge',                20],

  // ── Huiles (toutes ≈ 900 kcal/100 g) ─────────────────────────────────────────
  ['huile de colza',        900],
  ['huile de coco',         862],
  ['huile de saumon',       900],
  ['huile de krill',        900],
  ['huile de lin',          884],
  ['huile d olive',         884],
  ['huile de tournesol',    884],
  ['huile de poisson',      900],
  ['huile',                 900],  // générique
];

// Pré-traitement : normaliser les clés et trier par longueur décroissante
const TABLE = TABLE_RAW
  .map(([key, kcal]) => ({ key: normaliser(key), kcal }))
  .sort((a, b) => b.key.length - a.key.length);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Retourne les kcal/100 g CRU pour un ingrédient, ou null si inconnu.
// Cherche d'abord la clé la plus longue compatible (mot entier ou expression).
function kcalPour100g(nom) {
  const n = normaliser(nom);
  const padded = ' ' + n + ' ';
  for (const { key, kcal } of TABLE) {
    const re = new RegExp(`(?:^| )${escapeRe(key)}(?= |$)`);
    if (re.test(padded)) return kcal;
  }
  return null;
}

// Calcule les kcal totales d'une liste [{name, qty_g_jour}].
// Retourne { kcal, inconnus: [noms] }
function kcalTotale(ingredients) {
  let kcal = 0;
  const inconnus = [];
  for (const ing of ingredients) {
    const k = kcalPour100g(ing.name);
    if (k !== null) {
      kcal += ing.qty_g_jour * k / 100;
    } else {
      inconnus.push(ing.name);
    }
  }
  return { kcal, inconnus };
}

module.exports = { kcalPour100g, kcalTotale, TABLE_RAW };
