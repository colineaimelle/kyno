// api/lib/menuGen.js
// Helpers partagés : prompt multi-chiens, ajustement rations, email HTML.
// Importé par cron-menu.js et chat.js.

const { getTermesExclus, getAlimentsProches, detecterTermeInterdit } = require('./allergenes');

const SITE_URL = process.env.SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://kyno.fr');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'colinemngl@gmail.com';
const { kcalPour100g, kcalTotale } = require('./calories');

function normaliser(s) {
  return (s || '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}

function getLabelSemaine() {
  const now = new Date();
  const mois = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
  return `Semaine du ${now.getDate()} ${mois[now.getMonth()]}`;
}

// ── PROMPT MULTI-CHIENS ────────────────────────────────────────────────────────
// chiens     : lignes Supabase de la table `chien`
// foyer      : ligne Supabase de la table `user`
// saison     : string
// ciblesKcal : { [chien_id]: number } — kcal/jour calculées par le code
function buildMultiDogMenuPrompt(chiens, foyer, saison, ciblesKcal = {}) {
  const pluriel = chiens.length > 1;

  // ── Blocs allergie + rotation par chien ──────────────────────────────────────
  let topBlocks = '';
  chiens.forEach(chien => {
    const nom = chien.prenom_chien || 'ce chien';
    const intolerances = Array.isArray(chien.allergies) ? chien.allergies : [];
    if (intolerances.length > 0) {
      const termesExclus = getTermesExclus(intolerances);
      const alimentsProches = getAlimentsProches(intolerances);
      topBlocks += `⚠️ INTERDICTION ABSOLUE pour ${nom} — LIS EN PREMIER :\n`;
      topBlocks += `Ces ingrédients ET TOUS LEURS DÉRIVÉS sont STRICTEMENT INTERDITS dans la recette de ${nom} :\n`;
      topBlocks += termesExclus.map(t => `  • ${t}`).join('\n') + '\n';
      topBlocks += `NE LES UTILISE JAMAIS dans la recette de ${nom}, même en traces. Inclure foie, abats, bouillon, graisse, hydrolysat ou arôme d'une protéine interdite est une violation.\n`;
      topBlocks += `Dans les textes libres (note, titre) : NE JAMAIS nommer un ingrédient interdit, même pour dire qu'il est absent. Écris à la place « adapté aux allergies de ${nom} » ou « sans ses allergènes ».\n\n`;
      if (alimentsProches.length > 0) {
        topBlocks += `ℹ️ Aliments proches autorisés mais à éviter si possible pour ${nom} : ${alimentsProches.join(', ')}. Si tu en utilises, ils seront signalés au propriétaire.\n\n`;
      }
    }
    if (chien.proteine_principale) {
      topBlocks += `⚠️ ROTATION PROTÉINES pour ${nom} : menu précédent = ${chien.proteine_principale}. Choisis OBLIGATOIREMENT une protéine différente pour ${nom} cette semaine.\n\n`;
    }
  });

  // ── Profils ──────────────────────────────────────────────────────────────────
  let profilesSection = '';
  chiens.forEach((chien, i) => {
    const nom = chien.prenom_chien || `Chien ${i + 1}`;
    const pm = chien.poids ? Math.pow(chien.poids, 0.75).toFixed(2) : 'à calculer';
    const cible = ciblesKcal[chien.id];
    const intolerances = Array.isArray(chien.allergies) ? chien.allergies : [];
    const alimentation = Array.isArray(chien.alimentation_actuelle)
      ? chien.alimentation_actuelle.join(', ')
      : (typeof chien.alimentation_actuelle === 'string' ? chien.alimentation_actuelle : 'non renseigné');
    const maladies = Array.isArray(chien.maladies) ? chien.maladies : [];

    profilesSection += `### ${nom}  (chien_id: "${chien.id}")\n`;
    profilesSection += `- Race : ${chien.race || 'non renseignée'}\n`;
    profilesSection += `- Poids : ${chien.poids ? chien.poids + ' kg' : 'non renseigné'} — PM : ${pm} kg\n`;
    profilesSection += `- Âge : ${chien.age || 'non renseigné'}  |  Sexe : ${chien.sexe || 'non renseigné'}\n`;
    profilesSection += `- Activité : ${chien.activite || 'non renseigné'}\n`;
    profilesSection += `- Cible énergétique : ${cible ? `**${cible} kcal/jour** (calculé par le code — à respecter)` : 'calculer selon NRC 2006'}\n`;
    profilesSection += `- Mode alimentaire : ${chien.mode_alimentaire || 'ration ménagère'}\n`;
    profilesSection += `- Alimentation actuelle : ${alimentation}\n`;
    if (intolerances.length > 0) {
      profilesSection += `- INTOLÉRANCES INTERDITES : ${intolerances.join(', ')}\n`;
    }
    if (maladies.length > 0) {
      profilesSection += `- Maladies : ${maladies.join(', ')}\n`;
    }
    if (chien.traitements) {
      profilesSection += `- Traitements : ${chien.traitements}\n`;
    }
    if (chien.comportement) {
      profilesSection += `- Comportement : ${chien.comportement}\n`;
    }
    profilesSection += '\n';
  });

  // ── Exemple de structure JSON attendue ───────────────────────────────────────
  const chiensJsonExample = chiens.map(chien => {
    const nom = chien.prenom_chien || 'ce chien';
    const cible = ciblesKcal[chien.id];
    const cibleParRepas = cible ? Math.round(cible / 2) : '<n>';
    return `    {
      "chien_id": "${chien.id}",
      "recette": {
        "moment": "Matin et soir",
        "color": "#8A3A7C",
        "titre": "nom court de la recette de ${nom}",
        "ration": <grammes CRU par repas pour ${nom} = sum(ingredients_grammes_crus) / 2>,
        "ingredients": [
          {"name": "ingrédient", "qty": "quantité CRU par repas pour ${nom}, ex: 40 g (≈ 120 g cuit)"},
          {"name": "huile de colza", "qty": "X g par repas (= qty_g_jour / 2)"},
          {"name": "CMV adulte", "qty": "X g par repas selon notice"}
        ],
        "note": "1 phrase pourquoi cette recette est bonne pour ${nom}"
      },
      "ingredients_grammes_crus": [
        {"name": "ingrédient A", "qty_g_jour": <grammes CRU par JOUR pour ${nom}>, "kcal_100g": <kcal pour 100 g cru, source NRC/Ciqual>},
        {"name": "huile de colza", "qty_g_jour": <grammes par JOUR>, "kcal_100g": 900},
        {"name": "CMV adulte", "qty_g_jour": <grammes par JOUR selon notice>, "kcal_100g": 0}
      ],
      "batch_special": "résumé des compléments à ajouter AU MOMENT DU REPAS pour ${nom} (ex: huile de colza + CMV — déjà dans recette.ingredients)",
      "apports": [
        {"nom": "Calories",  "unite": "kcal", "valeur": <n>, "cible": ${cibleParRepas}, "pct": <n>, "color": "#FF5A3C"},
        {"nom": "Protéines", "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#8A3A7C"},
        {"nom": "Lipides",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#C93417"},
        {"nom": "Calcium",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#3E8FC4"},
        {"nom": "Oméga-3",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#FFE83D"}
      ],
      "proteine_principale": "protéine en minuscules sans article (ex: dinde)",
      "score_sante": <0-100>,
      "score_bullets": [
        {"ok": true,  "text": "point positif pour ${nom}"},
        {"ok": false, "text": "point à surveiller pour ${nom}"}
      ]
    }`;
  }).join(',\n');

  const noms = chiens.map(c => c.prenom_chien || 'ce chien').join(' et ');
  const equipement = Array.isArray(foyer.equipement) ? foyer.equipement.join(', ') : 'standard';
  const coursesOu = Array.isArray(foyer.courses_ou) ? foyer.courses_ou.join(', ') : 'non renseigné';

  return `${topBlocks}Tu es Kyno, expert en nutrition canine. Tu génères des menus hebdomadaires pratiques basés sur NRC 2006 et FEDIAF 2023. Tu tutoies le propriétaire. Tu réponds UNIQUEMENT en JSON valide, sans texte avant ni après, sans balises markdown.

## FOYER
- Saison : ${saison}
- Équipement : ${equipement}
- Temps de préparation : ${foyer.temps_prep || 'non renseigné'}
- Lieux de courses : ${coursesOu}

## ${chiens.length} CHIEN${pluriel ? 'S' : ''} DU FOYER
${profilesSection}
## CONCEPT DU MENU
Le propriétaire cuisine UNE SEULE FOIS par semaine — une grande session de batch cooking.
${pluriel
  ? `Génère une recette adaptée à chaque chien. Quand les profils sont compatibles, partage la même protéine principale et les mêmes légumes. Si les allergies sont incompatibles, sépare les lots dans batch_cooking_commun en précisant quel lot est pour quel chien.
Ne jamais utiliser dans la recette d'un chien un ingrédient qui figure dans ses INTOLÉRANCES INTERDITES.
Un ingrédient interdit pour un chien peut figurer dans la recette d'un autre chien si ce dernier ne l'a pas dans ses intolérances.`
  : `1 SEULE recette, servie matin ET soir (14 repas sur 7 jours).`}
Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur.

## PORTIONNAGE (étape OBLIGATOIRE dans batch_cooking_commun)
${(() => {
    if (!pluriel) {
      return `La DERNIÈRE étape de batch_cooking_commun doit être exactement :
"Divise la préparation cuite en 14 boîtes égales (matin et soir, 7 jours)."
Ne parle JAMAIS de portions journalières ni de grammes dans cette étape.`;
    }
    const total = Object.values(ciblesKcal).reduce((s, v) => s + (v || 0), 0);
    const parts = chiens.map(c => {
      const pct = total > 0 ? Math.round((ciblesKcal[c.id] || 0) / total * 100) : Math.round(100 / chiens.length);
      return { nom: c.prenom_chien || 'Chien', pct };
    });
    // Ajuster arrondi pour sommer à 100
    const diff = 100 - parts.reduce((s, p) => s + p.pct, 0);
    if (diff !== 0) parts[0].pct += diff;
    const pctStr = parts.map(p => `${p.pct} % à ${p.nom}`).join(' et ');
    return `La DERNIÈRE étape de batch_cooking_commun doit reprendre EXACTEMENT l'une des deux formulations suivantes (au choix selon ta décision sur les lots) :
— Si tu prépares UNE SEULE préparation commune pour tous les chiens :
  "Pèse la préparation cuite, donne ${pctStr}, puis divise chaque part en 14 boîtes égales (matin et soir, 7 jours)."
— Si les lots sont SÉPARÉS (allergies incompatibles) :
${chiens.map(c => `  "Divise le lot de ${c.prenom_chien || 'Chien'} en 14 boîtes égales (matin et soir, 7 jours)."`).join('\n')}
Ne parle JAMAIS de portions journalières ni de grammes dans cette étape.`;
  })()}
Les compléments sensibles (huile, CMV, etc.) sont ajoutés AU MOMENT DU REPAS, jamais à la cuisson.
Le canard est toujours utilisé SANS PEAU (viande seule) pour maîtriser l'apport en graisses.

## STRUCTURE JSON EXACTE À RESPECTER

{
  "chiens": [
${chiensJsonExample}
  ],
  "courses_commune": [
    {"cat": "Viandes & poissons", "items": [{"name": "ingrédient", "qty": "quantité CRU TOTALE pour tous les chiens × 14 repas"}]},
    {"cat": "Légumes & féculents", "items": [{"name": "ingrédient", "qty": "quantité CRU TOTALE foyer (pour les féculents : poids cru avant cuisson × 14 repas)"}]},
    {"cat": "Compléments",         "items": [{"name": "ingrédient", "qty": "quantité totale foyer"}]}
  ],
  "batch_cooking_commun": [
    {"n": 1, "text": "étape${pluriel ? ' (précise pour quel chien si les lots sont séparés)' : ' détaillée avec temps de cuisson'}"},
    {"n": 2, "text": "..."},
    {"n": 3, "text": "..."},
    {"n": 4, "text": "..."}
  ],
  "batch_time": "≈ XX min de prépa",
  "cout_semaine": "XX,XX € pour ${noms}",
  "cout_indus": "XX €",
  "economie": "XX,XX €"
}

## RÈGLES IMPORTANTES
- "ration" = sum(ingredients_grammes_crus.qty_g_jour) / 2 pour ce chien (poids CRU par repas)
- "ingredients_grammes_crus" : TOUS les ingrédients (huiles ET CMV compris) en grammes CRU par JOUR pour CE chien, avec une estimation "kcal_100g" (source NRC/Ciqual) pour chaque ingrédient. La somme de leurs kcal doit correspondre à la cible énergétique fournie dans le profil. Huile et CMV DOIVENT apparaître ici avec qty_g_jour > 0.
- "qty" dans recette.ingredients = quantité CRU par repas pour CE chien uniquement = qty_g_jour / 2
- "qty" dans courses_commune = quantité CRU TOTALE foyer = (poids cru par repas × nb chiens concernés) × 14 repas. Pour les féculents qui absorbent l'eau (riz × 3, lentilles × 2,5, pâtes × 2,5) : utilise le poids CRU. Exemple : 40 g riz cru/repas × 14 = 560 g cru
- "batch_cooking_commun" et "note" dans recette : NE JAMAIS écrire de grammes ni de quantités numériques dans les étapes ou les notes — désigner les ingrédients par leur nom ("la dinde hachée", "la quantité de riz indiquée dans les ingrédients"). Les chiffres n'apparaissent QUE dans "ingredients", "ingredients_grammes_crus" et "courses_commune", que le code recalcule.
- "batch_special" : résumé des compléments ajoutés au bol (jamais cuits) — ils doivent AUSSI figurer dans recette.ingredients et ingredients_grammes_crus avec leurs quantités
- "batch_cooking_commun" : écrire les prénoms des chiens avec une MAJUSCULE (ex: "Tetu", "Patte", pas "tetu" ni "patte")
- "recette.ingredients" : INCLURE huile et CMV comme ingrédients à part entière (avec leur qty par repas)
- "proteine_principale" : une seule protéine en minuscules sans article
- "score_sante" : 85-100 excellent, 70-84 bonne forme, 55-69 à surveiller, <55 vigilance
- "score_bullets" : 2-3 points (mix positifs/négatifs) propres à CE chien
- Les chien_id dans "chiens" doivent correspondre EXACTEMENT aux chien_id fournis ci-dessus
- "apports" Calories : cible = cible fournie ÷ 2 (par repas). Protéines, lipides, calcium, oméga-3 selon NRC 2006. "valeur" et "cible" sont des nombres (pas des chaînes), "pct" = arrondi entier
- JSON strictement valide : pas de virgule finale, toutes les clés entre guillemets doubles`;
}

// ── AJUSTEMENT DES RATIONS ─────────────────────────────────────────────────────
// Résolution kcal/100g : table Ciqual en priorité, estimation IA en fallback.
function _resolveKcal(ing, nom) {
  const fromTable = kcalPour100g(ing.name);
  if (fromTable !== null) return fromTable;
  const aiVal = parseFloat(ing.kcal_100g);
  if (!isNaN(aiVal) && aiVal > 0) {
    console.warn(`[calories] ${nom} — "${ing.name}" : hors table, estimation IA utilisée (${aiVal} kcal/100g)`);
    return aiVal;
  }
  return null;
}

// Si les kcal calculées s'écartent de plus de 5 % de la cible, ajuste
// proportionnellement les quantités connues et reconstruit ration + courses.
//
// menuData   : JSON parsé retourné par Claude (format multi-chiens)
// chienMap   : { [id]: profil chien } — pour les logs
// ciblesKcal : { [chien_id]: number }
// Retourne menuData muté.
function ajusterRations(menuData, chienMap, ciblesKcal) {
  if (!Array.isArray(menuData.chiens)) return menuData;

  let unChienAjuste = false;

  for (const mc of menuData.chiens) {
    const cible = ciblesKcal[mc.chien_id];
    if (!cible) continue;

    const ingsCrus = mc.ingredients_grammes_crus;
    if (!Array.isArray(ingsCrus) || ingsCrus.length === 0) continue;

    const nom = chienMap[mc.chien_id]?.prenom_chien || mc.chien_id;
    const totalPoidsJour = ingsCrus.reduce((s, i) => s + (i.qty_g_jour || 0), 0);

    // Bloquer si un ingrédient inconnu représente >10 % du poids total
    const blocages = [];
    for (const ing of ingsCrus) {
      if (_resolveKcal(ing, nom) === null) {
        const pct = totalPoidsJour > 0 ? ing.qty_g_jour / totalPoidsJour : 0;
        if (pct > 0.10) {
          blocages.push(`"${ing.name}" (${Math.round(pct * 100)}% du poids)`);
        } else {
          console.warn(`[calories] ${nom} — "${ing.name}" : kcal inconnues, <10% du poids, ignoré dans le calcul`);
        }
      }
    }
    if (blocages.length > 0) {
      console.error(`[calories] ${nom} — ajustement annulé, ingrédients inconnus >10% : ${blocages.join(', ')}`);
      continue;
    }

    const kcalActuel = ingsCrus.reduce((s, ing) => {
      const k = _resolveKcal(ing, nom);
      return s + (k !== null ? ing.qty_g_jour * k / 100 : 0);
    }, 0);

    if (kcalActuel === 0) continue;

    const ecart = Math.abs(kcalActuel - cible) / cible;
    if (ecart <= 0.05) continue;

    console.log(`[calories] ${nom} — écart ${Math.round(ecart * 100)}% (${Math.round(kcalActuel)} vs ${cible} kcal), factor=${(cible / kcalActuel).toFixed(3)}`);

    const factor = cible / kcalActuel;

    // Ajuste les ingrédients dont les kcal sont résolvables (table ou IA)
    for (const ing of ingsCrus) {
      if (_resolveKcal(ing, nom) !== null) {
        ing.qty_g_jour = Math.round(ing.qty_g_jour * factor);
      }
    }

    // Reconstruire recette.ingredients (qty CRU par repas = qty_g_jour / 2)
    if (mc.recette && Array.isArray(mc.recette.ingredients)) {
      for (const recIng of mc.recette.ingredients) {
        const match = ingsCrus.find(ig =>
          normaliser(ig.name).includes(normaliser(recIng.name)) ||
          normaliser(recIng.name).includes(normaliser(ig.name))
        );
        if (match) {
          const parRepas = Math.round(match.qty_g_jour / 2);
          recIng.qty = `${parRepas} g`;
        }
      }
    }

    // Reconstruire ration (total cru / 2)
    const totalJour = ingsCrus.reduce((s, i) => s + i.qty_g_jour, 0);
    if (mc.recette) mc.recette.ration = Math.round(totalJour / 2);

    unChienAjuste = true;
  }

  if (unChienAjuste) {
    menuData.courses_commune = _rebuildCourses(menuData.chiens);
  }

  return menuData;
}

// Reconstruit courses_commune depuis les ingredients_grammes_crus de tous les chiens × 7 jours.
function _rebuildCourses(chiens) {
  const totals = {};

  for (const mc of chiens) {
    if (!Array.isArray(mc.ingredients_grammes_crus)) continue;
    for (const ing of mc.ingredients_grammes_crus) {
      const key = normaliser(ing.name);
      if (!totals[key]) totals[key] = { name: ing.name, total: 0 };
      totals[key].total += ing.qty_g_jour * 7;
    }
  }

  const viandes = [], legumes = [], complements = [];

  const MOTS_VIANDE = ['boeuf', 'veau', 'poulet', 'dinde', 'agneau', 'porc', 'canard', 'lapin', 'cheval', 'saumon', 'thon', 'sardine', 'cabillaud', 'merlan', 'maquereau', 'hareng', 'truite', 'foie', 'coeur', 'rognon', 'rate', 'poumon', 'estomac', 'gibier', 'bison', 'sanglier', 'cerf', 'viande', 'poisson', 'abats', 'volaille'];
  const MOTS_COMP  = ['huile', 'cmv', 'levure', 'spiruline', 'complement', 'vitamine', 'supplement', 'oeuf', 'kelp', 'algue', 'probioti', 'kefir', 'yaourt'];

  for (const { name, total } of Object.values(totals)) {
    const n = normaliser(name);
    const qty = total >= 1000 ? `${(total / 1000).toFixed(1)} kg` : `${Math.round(total)} g`;
    const item = { name, qty };
    if (MOTS_VIANDE.some(m => n.includes(m)))    viandes.push(item);
    else if (MOTS_COMP.some(m => n.includes(m))) complements.push(item);
    else                                          legumes.push(item);
  }

  const cats = [];
  if (viandes.length)    cats.push({ cat: 'Viandes & poissons', items: viandes });
  if (legumes.length)    cats.push({ cat: 'Légumes & féculents', items: legumes });
  if (complements.length) cats.push({ cat: 'Compléments', items: complements });
  return cats;
}

// ── EMAIL HTML (1 ou N chiens) ─────────────────────────────────────────────────
// foyer      : ligne `user`
// chiens     : lignes `chien` dans l'ordre du menu
// menuData   : JSON parsé retourné par Claude (format multi-chiens)
// saison     : string
// ciblesKcal : { [chien_id]: number } — optionnel
function buildEmailMenuHtml(foyer, chiens, menuData, saison, ciblesKcal = {}) {
  const menuChiens = Array.isArray(menuData.chiens) ? menuData.chiens : [];
  const courses_commune = menuData.courses_commune || [];
  const batch_cooking_commun = menuData.batch_cooking_commun || [];
  const batch_time = menuData.batch_time || '';
  const cout_semaine = menuData.cout_semaine || '';
  const accessUrl = `${SITE_URL}/espace-client.html`;

  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  const pluriel = menuChiens.length > 1;
  const noms = menuChiens.map(mc => (chienMap[mc.chien_id]?.prenom_chien || 'Chien')).join(' &amp; ');
  const nomsDisplay = menuChiens.map(mc => (chienMap[mc.chien_id]?.prenom_chien || 'Chien')).join(' & ');

  const stepsHtml = batch_cooking_commun.map(s => `${s.n}. ${s.text}`).join('<br>');
  const coursesHtml = courses_commune
    .map(cat => `<strong>${cat.cat}</strong> : ` + (cat.items || []).map(i => `${i.name} ${i.qty}`).join(', '))
    .join('<br><br>');

  // ── Recap table ──────────────────────────────────────────────────────────────
  const recapRowsSingle = (mc) => {
    const recette = mc.recette || {};
    const rows = [];
    if (recette.titre) rows.push(`<tr><td style="padding:11px 16px;background:#DDF3F1;font-weight:700;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">${recette.titre}</td></tr>`);
    if (recette.ration) rows.push(`<tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Sa ration&nbsp;&nbsp;&nbsp;<b>${recette.ration}&nbsp;g/repas</b></td></tr>`);
    if (batch_time) rows.push(`<tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Temps de pr&eacute;pa&nbsp;&nbsp;&nbsp;<b>${batch_time}</b></td></tr>`);
    if (cout_semaine) rows.push(`<tr><td style="padding:11px 16px;border-top:2px solid #E8DCC6;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Co&ucirc;t de la semaine&nbsp;&nbsp;&nbsp;<b>${cout_semaine}</b></td></tr>`);
    return rows.join('');
  };

  const recapTableMulti = menuChiens.map(mc => {
    const chien = chienMap[mc.chien_id] || {};
    const nom = chien.prenom_chien || 'Chien';
    const recette = mc.recette || {};
    const rows = [];
    rows.push(`<tr><td style="padding:8px 16px 2px;font-size:11px;font-weight:700;letter-spacing:0.06em;color:#6E4A63;font-family:Arial,Helvetica,sans-serif;text-transform:uppercase;">${nom}</td></tr>`);
    if (recette.titre) rows.push(`<tr><td style="padding:4px 16px 8px;font-weight:700;font-size:15px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">${recette.titre}</td></tr>`);
    if (recette.ration) rows.push(`<tr><td style="padding:4px 16px 8px;border-top:2px solid #E8DCC6;font-size:14px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Ration&nbsp;&nbsp;&nbsp;<b>${recette.ration}&nbsp;g/repas</b></td></tr>`);
    return rows.join('');
  }).join('<tr><td style="padding:0;border-top:3px solid #451A36;"></td></tr>');

  const recapTableMultiRows = recapTableMulti +
    (batch_time ? `<tr><td style="padding:8px 16px;border-top:3px solid #451A36;font-size:14px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Temps de pr&eacute;pa&nbsp;&nbsp;&nbsp;<b>${batch_time}</b></td></tr>` : '') +
    (cout_semaine ? `<tr><td style="padding:8px 16px;border-top:2px solid #E8DCC6;font-size:14px;color:#451A36;font-family:Arial,Helvetica,sans-serif;">Co&ucirc;t de la semaine&nbsp;&nbsp;&nbsp;<b>${cout_semaine}</b></td></tr>` : '');

  // ── Sections par chien (batch_special + proches) ──────────────────────────
  const dogExtrasHtml = menuChiens.map(mc => {
    const chien = chienMap[mc.chien_id] || {};
    const nom = chien.prenom_chien || 'Chien';
    const recette = mc.recette || {};
    const prochesAlert = buildProchesAlert(chien, recette);
    if (!mc.batch_special && !prochesAlert) return '';
    return `
      ${mc.batch_special ? `<p style="margin:0 0 10px;font-size:14px;color:#451A36;font-family:Arial,Helvetica,sans-serif;"><strong>${pluriel ? nom + ' — ' : ''}Au moment du repas&nbsp;:</strong> ${mc.batch_special}</p>` : ''}
      ${prochesAlert}`;
  }).join('');

  const hasExtras = dogExtrasHtml.trim().length > 0;

  // ── Btn Outlook-safe ──────────────────────────────────────────────────────
  const btnLabel = pluriel ? 'Ouvrir leurs menus' : 'Ouvrir son menu';
  const btnHtml = `<table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td bgcolor="#E5432F" style="border-radius:999px;border:3px solid #451A36;">
              <a href="${accessUrl}" style="display:inline-block;padding:14px 26px;color:#FFF4E0;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;text-decoration:none;white-space:nowrap;">${btnLabel}</a>
            </td>
          </tr>
        </table>`;

  const footerHtml = `<table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="background:#FCEBC4;border:2px solid #451A36;border-radius:14px;padding:12px 14px;font-size:13px;line-height:1.5;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
              Kyno est un outil &eacute;ducatif et ne remplace pas un avis v&eacute;t&eacute;rinaire. En cas de pathologie ou de traitement en cours, consulte ton v&eacute;t&eacute;rinaire avant tout changement alimentaire.
            </td>
          </tr>
        </table>`;

  // ── Recap table HTML ──────────────────────────────────────────────────────
  const recapRows = pluriel ? recapTableMultiRows : recapRowsSingle(menuChiens[0] || {});
  const recapTableHtml = recapRows
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:3px solid #451A36;border-radius:16px;overflow:hidden;margin:0 0 20px;">${recapRows}</table>`
    : '';

  // ── Titre prénoms avec stickers ───────────────────────────────────────────
  const nomStickers = menuChiens.map(mc => {
    const nom = chienMap[mc.chien_id]?.prenom_chien || 'Chien';
    return `<span style="display:inline-block;background:#F27A9B;border:3px solid #451A36;border-radius:10px;padding:0 8px 2px;">${nom}</span>`;
  }).join(' &amp; ');

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FFF4E0;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF4E0;padding:32px 16px;">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:3px solid #451A36;border-radius:20px;overflow:hidden;">

    <tr>
      <td style="padding:0;line-height:0;font-size:0;border-bottom:4px solid #451A36;">
        <img src="${SITE_URL}/email-entete-menu.png" width="600" height="150" alt="Kyno" style="display:block;width:100%;max-width:600px;">
      </td>
    </tr>

    <tr>
      <td style="padding:30px 32px 26px;">
        <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.25;font-weight:700;color:#451A36;">
          Le menu de la semaine de ${nomStickers}
        </h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          ${pluriel ? 'Leurs menus' : 'Son menu'} de la semaine ${pluriel ? 'sont pr&ecirc;ts' : 'est pr&ecirc;t'}.
        </p>
        ${recapTableHtml}
        ${hasExtras ? `<div style="margin:0 0 20px;font-size:14px;line-height:1.75;color:#451A36;">${dogExtrasHtml}</div>` : ''}
        <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          Ta liste de courses et ton batch cooking t&apos;attendent dans ton espace Kyno.
        </p>
        ${btnHtml}
        ${footerHtml}
      </td>
    </tr>

    <tr>
      <td style="background:#FFF4E0;border-top:3px solid #E8DCC6;padding:16px 32px;font-size:13px;line-height:1.6;color:#6E4A63;font-family:Arial,Helvetica,sans-serif;">
        Kyno &middot; nutrition canine individualis&eacute;e &middot; Lyon, France<br>
        Une question&nbsp;? &Eacute;cris-nous &agrave; <a href="mailto:${CONTACT_EMAIL}" style="color:#451A36;text-decoration:none;">${CONTACT_EMAIL}</a>.
      </td>
    </tr>

  </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── ALERTE ALIMENTS PROCHES ────────────────────────────────────────────────────
function buildProchesAlert(chien, recette) {
  const allergies = Array.isArray(chien.allergies) ? chien.allergies : [];
  if (!allergies.length) return '';
  const alimentsProches = getAlimentsProches(allergies);
  if (!alimentsProches.length) return '';

  const detected = new Set();
  for (const proche of alimentsProches) {
    for (const ing of (recette.ingredients || [])) {
      if (detecterTermeInterdit(ing.name, [proche])) {
        detected.add(proche);
        break;
      }
    }
  }
  if (!detected.size) return '';

  const liste = [...detected].join(', ');
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin:10px 0 0;">
    <tr>
      <td style="background:#FFF8E1;border-radius:8px;padding:12px 16px;border-left:3px solid #F59E0B;">
        <p style="margin:0;font-size:12px;color:#78350F;line-height:1.7;">⚠️ <strong>${liste}</strong> est proche des allergènes de ${chien.prenom_chien || 'ton chien'}. À introduire progressivement et à mentionner à ton vétérinaire.</p>
      </td>
    </tr>
  </table>`;
}

module.exports = { getSaison, getLabelSemaine, buildMultiDogMenuPrompt, ajusterRations, buildEmailMenuHtml };
