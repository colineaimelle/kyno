// api/lib/menuGen.js
// Shared helpers : prompt multi-chiens, email HTML, utilitaires.
// Importé par cron-menu.js et chat.js.

const { getTermesExclus, getAlimentsProches, detecterTermeInterdit } = require('./allergenes');

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
// chiens : lignes Supabase de la table `chien` (id, prenom_chien, race, poids…)
// foyer  : ligne Supabase de la table `user` (equipement, temps_prep, courses_ou…)
function buildMultiDogMenuPrompt(chiens, foyer, saison) {
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
      topBlocks += `NE LES UTILISE JAMAIS dans la recette de ${nom}, même en traces. Inclure foie, abats, bouillon, graisse, hydrolysat ou arôme d'une protéine interdite est une violation.\n\n`;
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
    return `    {
      "chien_id": "${chien.id}",
      "recette": {
        "moment": "Matin et soir",
        "color": "#2FA35E",
        "titre": "nom court de la recette de ${nom}",
        "ration": <grammes par repas pour ${nom}>,
        "ingredients": [
          {"name": "ingrédient", "qty": "quantité CRU par repas pour ${nom}, ex: 40 g (≈ 120 g cuit)"}
        ],
        "note": "1 phrase pourquoi cette recette est bonne pour ${nom}"
      },
      "batch_special": "compléments à ajouter AU MOMENT DU REPAS uniquement pour ${nom} (huile, CMV…)",
      "apports": [
        {"nom": "Calories",  "unite": "kcal", "valeur": <n>, "cible": <n>, "pct": <n>, "color": "#F2843C"},
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
  : `1 SEULE recette, servie matin ET soir (×14 portions : 7 jours × 2 repas).`}
Conservation : jours 1-2-3 au réfrigérateur, jours 4-5-6-7 au congélateur en portions.
Les compléments sensibles (huile, CMV, etc.) sont ajoutés AU MOMENT DU REPAS, jamais à la cuisson.

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
- "ration" = grammes PAR REPAS pour ce chien (matin = soir)
- "qty" dans recette.ingredients = quantité CRU par repas pour CE chien uniquement
- "qty" dans courses_commune = quantité CRU TOTALE foyer = (poids cru par repas × nb chiens concernés) × 14 repas. Pour les féculents qui absorbent l'eau (riz × 3, lentilles × 2,5, pâtes × 2,5) : utilise le poids CRU, jamais le poids cuit. Exemple : 40 g riz cru/repas × 14 = 560 g cru (non : 120 g cuit × 14 = 1680 g, non : 350 g)
- "batch_special" : compléments ajoutés au bol — jamais cuits (huile, CMV, levure…)
- "proteine_principale" : une seule protéine en minuscules sans article
- "score_sante" : 85-100 excellent, 70-84 bonne forme, 55-69 à surveiller, <55 vigilance
- "score_bullets" : 2-3 points (mix positifs/négatifs) propres à CE chien
- Les chien_id dans "chiens" doivent correspondre EXACTEMENT aux chien_id fournis ci-dessus
- "apports" : NRC 2006 (130 × PM^0.75 × facteur activité sédentaire 1.0 / modéré 1.4 / actif 1.8) ÷ 2 = cible par repas. "valeur" et "cible" sont des nombres (pas des chaînes), "pct" = arrondi entier
- JSON strictement valide : pas de virgule finale, toutes les clés entre guillemets doubles`;
}

// ── EMAIL HTML (1 ou N chiens) ─────────────────────────────────────────────────
// foyer    : ligne `user`
// chiens   : lignes `chien` dans l'ordre du menu
// menuData : JSON parsé retourné par Claude (format multi-chiens)
function buildEmailMenuHtml(foyer, chiens, menuData, saison) {
  const menuChiens = Array.isArray(menuData.chiens) ? menuData.chiens : [];
  const courses_commune = menuData.courses_commune || [];
  const batch_cooking_commun = menuData.batch_cooking_commun || [];
  const batch_time = menuData.batch_time || '—';
  const weekLabel = getLabelSemaine();

  // Map chien_id → profil
  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  const pluriel = menuChiens.length > 1;

  // Éléments communs au template
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

  // ── Cas 1 chien : design identique à aujourd'hui ──────────────────────────────
  if (!pluriel) {
    const mc = menuChiens[0] || {};
    const chien = chienMap[mc.chien_id] || chiens[0] || {};
    const prenom = chien.prenom_chien || 'ton chien';
    const race = chien.race || '';
    const poids = chien.poids ? chien.poids + ' kg' : '';
    const sousTitre = [race, poids].filter(Boolean).join(' · ');
    const recette = mc.recette || {};

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
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Par repas</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${recette.ration || '—'} g</p>
              </td>
              <td width="12"></td>
              <td width="50%" style="background:#F3F7F1;border-radius:10px;padding:16px 20px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Temps de prépa</p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#2B3A2E;">${batch_time}</p>
              </td>
            </tr>
          </table>
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

  // ── Cas N chiens : sections par chien + liste de courses commune ──────────────
  const noms = menuChiens.map(mc => (chienMap[mc.chien_id]?.prenom_chien || 'Chien')).join(' & ');

  const dogSectionsHtml = menuChiens.map(mc => {
    const chien = chienMap[mc.chien_id] || {};
    const nom = chien.prenom_chien || 'Chien';
    const race = chien.race || '';
    const poids = chien.poids ? chien.poids + ' kg' : '';
    const sousTitre = [race, poids].filter(Boolean).join(' · ');
    const recette = mc.recette || {};
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
          <table cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
            <tr>
              <td style="background:#F3F7F1;border-radius:8px;padding:10px 16px;">
                <p style="margin:0 0 2px;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#8A978A;font-weight:700;">Par repas</p>
                <p style="margin:0;font-size:18px;font-weight:700;color:#2B3A2E;">${recette.ration || '—'} g</p>
              </td>
            </tr>
          </table>
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
// Détecte si des aliments proches d'un allergène sont présents dans la recette.
// Retourne un bloc HTML d'avertissement, ou '' si rien à signaler.
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

module.exports = { getSaison, getLabelSemaine, buildMultiDogMenuPrompt, buildEmailMenuHtml };
