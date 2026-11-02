// api/lib/menuGen.js
// Helpers partagés : prompt multi-chiens, ajustement rations, email HTML.
// Importé par cron-menu.js et chat.js.

const { getTermesExclus, getAlimentsProches, detecterTermeInterdit } = require('./allergenes');
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
        "color": "#2FA35E",
        "titre": "nom court de la recette de ${nom}",
        "ration": <grammes CRU par repas pour ${nom} = sum(ingredients_grammes_crus) / 2>,
        "ingredients": [
          {"name": "ingrédient", "qty": "quantité CRU par repas pour ${nom}, ex: 40 g (≈ 120 g cuit)"}
        ],
        "note": "1 phrase pourquoi cette recette est bonne pour ${nom}"
      },
      "ingredients_grammes_crus": [
        {"name": "ingrédient A", "qty_g_jour": <grammes CRU par JOUR pour ${nom}>, "kcal_100g": <kcal pour 100 g cru, source NRC/Ciqual>},
        {"name": "huile de colza", "qty_g_jour": <grammes CRU par JOUR, huiles comprises>, "kcal_100g": 900}
      ],
      "batch_special": "compléments à ajouter AU MOMENT DU REPAS uniquement pour ${nom} (huile, CMV…)",
      "apports": [
        {"nom": "Calories",  "unite": "kcal", "valeur": <n>, "cible": ${cibleParRepas}, "pct": <n>, "color": "#F2843C"},
        {"nom": "Protéines", "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#2FA35E"},
        {"nom": "Lipides",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#EC6592"},
        {"nom": "Calcium",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#3E8FC4"},
        {"nom": "Oméga-3",   "unite": "g",    "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#FFCE2E"}
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
- "ingredients_grammes_crus" : TOUS les ingrédients (huiles comprises) en grammes CRU par JOUR pour CE chien, avec une estimation "kcal_100g" (source NRC/Ciqual) pour chaque ingrédient. La somme de leurs kcal doit correspondre à la cible énergétique fournie dans le profil.
- "qty" dans recette.ingredients = quantité CRU par repas pour CE chien uniquement = qty_g_jour / 2
- "qty" dans courses_commune = quantité CRU TOTALE foyer = (poids cru par repas × nb chiens concernés) × 14 repas. Pour les féculents qui absorbent l'eau (riz × 3, lentilles × 2,5, pâtes × 2,5) : utilise le poids CRU. Exemple : 40 g riz cru/repas × 14 = 560 g cru
- "batch_cooking_commun" et "note" dans recette : NE JAMAIS écrire de grammes ni de quantités numériques dans les étapes ou les notes — désigner les ingrédients par leur nom ("la dinde hachée", "la quantité de riz indiquée dans les ingrédients"). Les chiffres n'apparaissent QUE dans "ingredients", "ingredients_grammes_crus" et "courses_commune", que le code recalcule.
- "batch_special" : compléments ajoutés au bol — jamais cuits (huile, CMV, levure…)
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
// ciblesKcal : { [chien_id]: number } — optionnel, pour afficher le besoin estimé
function buildEmailMenuHtml(foyer, chiens, menuData, saison, ciblesKcal = {}) {
  const menuChiens = Array.isArray(menuData.chiens) ? menuData.chiens : [];
  const courses_commune = menuData.courses_commune || [];
  const batch_cooking_commun = menuData.batch_cooking_commun || [];
  const batch_time = menuData.batch_time || '—';
  const weekLabel = getLabelSemaine();

  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  const pluriel = menuChiens.length > 1;

  const logoBar = `
      <tr>
        <td style="padding:0 8px 28px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;border:1.5px solid #2FA35E;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#2FA35E;font-family:Arial,sans-serif;">K</div>
            <span style="font-size:15px;font-weight:700;color:#2B3A2E;letter-spacing:0.04em;">kyno</span>
          </div>
        </td>
      </tr>`;

  const dogSvg = `<svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="26" cy="26" r="26" fill="#FBE4D8"/>
                  <path d="M16 20c0-2 1.5-4 3.2-4 1.2 0 2.2 1 2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
                  <path d="M36 20c0-2-1.5-4-3.2-4-1.2 0-2.2 1-2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
                  <ellipse cx="26" cy="29" rx="10" ry="8.5" fill="#F2843C"/>
                  <circle cx="22" cy="27" r="1.4" fill="#2B3A2E"/>
                  <circle cx="30" cy="27" r="1.4" fill="#2B3A2E"/>
                  <path d="M24 32c0.8 1 2.2 1 3 0" stroke="#2B3A2E" stroke-width="1.4" stroke-linecap="round" fill="none"/>
                  <ellipse cx="26" cy="30.5" rx="1.4" ry="1" fill="#2B3A2E"/>
                </svg>`;

  const stepsHtml = batch_cooking_commun.map(s => `${s.n}. ${s.text}`).join('<br>');
  const coursesHtml = courses_commune
    .map(cat => `${cat.cat} : ` + (cat.items || []).map(i => `${i.name} ${i.qty}`).join(', '))
    .join('<br>');

  // ── Cas 1 chien ──────────────────────────────────────────────────────────────
  if (!pluriel) {
    const mc = menuChiens[0] || {};
    const chien = chienMap[mc.chien_id] || chiens[0] || {};
    const prenom = chien.prenom_chien || 'ton chien';
    const race = chien.race || '';
    const poids = chien.poids ? chien.poids + ' kg' : '';
    const sousTitre = [race, poids].filter(Boolean).join(' · ');
    const recette = mc.recette || {};
    const cible = ciblesKcal[mc.chien_id];

    const prochesAlert = buildProchesAlert(chien, recette);


    return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F7F1;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F7F1;padding:48px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      ${logoBar}
      <tr>
        <td style="background:#FFFFFF;border-radius:20px 20px 0 0;padding:28px 32px;border:1px solid #E3EDE1;border-bottom:none;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="56" valign="top">${dogSvg}</td>
              <td valign="middle" style="padding-left:12px;">
                <p style="margin:0;font-size:17px;font-weight:700;color:#2B3A2E;">${prenom}</p>
                <p style="margin:2px 0 0;font-size:12px;color:#8A978A;">${sousTitre}</p>
              </td>
              <td align="right" valign="middle">
                <span style="display:inline-block;background:#E3EDE1;color:#2FA35E;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:6px 12px;border-radius:20px;">${weekLabel}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="background:#2B3A2E;padding:24px 32px;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7FBE98;font-weight:700;">Menu de la semaine</p>
          <p style="margin:0;font-size:22px;font-weight:700;color:#FBFDF7;line-height:1.3;">${recette.titre || 'Le menu de ' + prenom}</p>
        </td>
      </tr>
      <tr>
        <td style="background:#FFFFFF;padding:32px 32px 4px;border:1px solid #E3EDE1;border-top:none;">
          <p style="margin:0 0 24px;font-size:14.5px;color:#3C473D;line-height:1.9;">${recette.note || ''}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr>
              <td width="50%" style="background:#F3F7F1;border-radius:10px;padding:16px 20px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Besoin estimé</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${cible ? cible + ' kcal/j' : '—'}</p>
              </td>
              <td width="12"></td>
              <td width="50%" style="background:#F3F7F1;border-radius:10px;padding:16px 20px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Temps de prépa</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${batch_time}</p>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 24px;font-size:12px;color:#8A978A;"><strong>Portionnage :</strong> divise la préparation cuite en 14 boîtes égales (matin et soir, 7 jours).${recette.ration ? ` Ration crue totale : ≈ ${recette.ration} g/j.` : ''}</p>
          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;border-top:1px solid #EDF2EA;padding-top:22px;">Les étapes</h2>
          <p style="margin:0 0 24px;font-size:14.5px;color:#3C473D;line-height:1.9;">${stepsHtml}</p>
          ${mc.batch_special ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
            <tr>
              <td style="background:#FBE4D8;border-radius:10px;padding:16px 18px;">
                <p style="margin:0;font-size:13px;color:#8A4420;line-height:1.7;"><strong>Au moment du repas seulement :</strong> ${mc.batch_special}</p>
              </td>
            </tr>
          </table>` : ''}
          ${prochesAlert}
          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;">Liste de courses (7 jours)</h2>
          <p style="margin:0 0 28px;font-size:14.5px;color:#3C473D;line-height:1.9;">${coursesHtml}</p>
        </td>
      </tr>
      <tr>
        <td style="background:#FFFFFF;padding:8px 32px 36px;border:1px solid #E3EDE1;border-top:none;border-radius:0 0 20px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;padding-top:8px;">
              <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Voir le menu complet →</a>
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:11px;color:#9AA69B;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire.</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><span style="font-size:12px;font-weight:700;color:#5B6B5D;">kyno</span> <span style="font-size:11px;color:#9AA69B;">· Lyon, France</span></td>
              <td align="right"><a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:#9AA69B;text-decoration:none;">colinemngl@gmail.com</a></td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  // ── Cas N chiens ─────────────────────────────────────────────────────────────
  const noms = menuChiens.map(mc => (chienMap[mc.chien_id]?.prenom_chien || 'Chien')).join(' & ');

  const dogSectionsHtml = menuChiens.map(mc => {
    const chien = chienMap[mc.chien_id] || {};
    const nom = chien.prenom_chien || 'Chien';
    const race = chien.race || '';
    const poids = chien.poids ? chien.poids + ' kg' : '';
    const sousTitre = [race, poids].filter(Boolean).join(' · ');
    const recette = mc.recette || {};
    const cible = ciblesKcal[mc.chien_id];
    const prochesAlertDog = buildProchesAlert(chien, recette);

    return `
      <tr>
        <td style="background:#FFFFFF;padding:24px 32px 0;border:1px solid #E3EDE1;border-top:none;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="44" valign="top">${dogSvg}</td>
              <td valign="middle" style="padding-left:10px;">
                <p style="margin:0;font-size:16px;font-weight:700;color:#2B3A2E;">${nom}</p>
                <p style="margin:2px 0 0;font-size:11px;color:#8A978A;">${sousTitre}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="background:#FFFFFF;padding:12px 32px 20px;border:1px solid #E3EDE1;border-top:none;">
          <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#2B3A2E;">${recette.titre || 'Menu de la semaine'}</p>
          <p style="margin:0 0 10px;font-size:13px;color:#5B6B5D;line-height:1.7;">${recette.note || ''}</p>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
            <tr>
              <td style="background:#F3F7F1;border-radius:8px;padding:10px 16px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Besoin estimé</p>
                <p style="margin:0;font-size:18px;font-weight:700;color:#2B3A2E;">${cible ? cible + ' kcal/j' : '—'}</p>
              </td>
            </tr>
          </table>
          ${recette.ration ? `<p style="margin:0 0 10px;font-size:11px;color:#8A978A;">Ration crue : ≈ ${recette.ration} g/j</p>` : ''}
          ${mc.batch_special ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">
            <tr>
              <td style="background:#FBE4D8;border-radius:8px;padding:12px 16px;">
                <p style="margin:0;font-size:13px;color:#8A4420;line-height:1.7;"><strong>Au moment du repas :</strong> ${mc.batch_special}</p>
              </td>
            </tr>
          </table>` : ''}
          ${prochesAlertDog}
        </td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F7F1;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F7F1;padding:48px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      ${logoBar}
      <tr>
        <td style="background:#2B3A2E;border-radius:20px 20px 0 0;padding:24px 32px;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#7FBE98;font-weight:700;">Menu de la semaine</p>
          <p style="margin:0;font-size:21px;font-weight:700;color:#FBFDF7;line-height:1.3;">${noms}</p>
          <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.45);">${weekLabel}</p>
        </td>
      </tr>
      ${dogSectionsHtml}
      <tr>
        <td style="background:#FFFFFF;padding:24px 32px 4px;border:1px solid #E3EDE1;border-top:none;">
          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;border-top:1px solid #EDF2EA;padding-top:22px;">Batch cooking commun</h2>
          <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr>
              <td style="background:#F3F7F1;border-radius:8px;padding:10px 16px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Temps de prépa</p>
                <p style="margin:0;font-size:18px;font-weight:700;color:#2B3A2E;">${batch_time}</p>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 28px;font-size:14.5px;color:#3C473D;line-height:1.9;">${stepsHtml}</p>
          <h2 style="margin:0 0 10px;font-size:15px;font-weight:700;color:#2B3A2E;">Liste de courses du foyer (7 jours)</h2>
          <p style="margin:0 0 28px;font-size:14.5px;color:#3C473D;line-height:1.9;">${coursesHtml}</p>
        </td>
      </tr>
      <tr>
        <td style="background:#FFFFFF;padding:8px 32px 36px;border:1px solid #E3EDE1;border-top:none;border-radius:0 0 20px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="text-align:center;padding-top:8px;">
              <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Voir les menus complets →</a>
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:11px;color:#9AA69B;line-height:1.7;">⚠ Ce menu est éducatif et ne remplace pas un avis vétérinaire.</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td><span style="font-size:12px;font-weight:700;color:#5B6B5D;">kyno</span> <span style="font-size:11px;color:#9AA69B;">· Lyon, France</span></td>
              <td align="right"><a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:#9AA69B;text-decoration:none;">colinemngl@gmail.com</a></td>
            </tr>
          </table>
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
