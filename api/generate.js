// api/generate.js
// Vercel Serverless Function — Kyno
// Reçoit les données du quiz, appelle l'API Anthropic, retourne le rapport

export default async function handler(req, res) {

  // CORS — autoriser les requêtes depuis le site Kyno
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const data = req.body;

    // Validation basique
    if (!data.prenom || !data.race) {
      return res.status(400).json({ error: 'Données du quiz incomplètes' });
    }

    const plan = data.plan || 'essentiel';
    const saison = getSaison();
    const pm = data.poids ? Math.pow(data.poids, 0.75).toFixed(2) : 'à calculer';

    // Construction du prompt système
    const systemPrompt = buildPrompt(data, plan, saison, pm);

    // Appel API Anthropic — clé sécurisée côté serveur
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: 'Génère le rapport nutritionnel personnalisé pour ce chien.'
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Erreur API Anthropic');
    }

    const result = await response.json();
    const rapport = result.content[0].text;

    return res.status(200).json({
      success: true,
      rapport: rapport,
      prenom: data.prenom
    });

  } catch (error) {
    console.error('Erreur generate.js:', error);
    return res.status(500).json({
      error: 'Erreur lors de la génération du rapport',
      message: error.message
    });
  }
}

// ── BUILD PROMPT ─────────────────────────────────────────
function buildPrompt(data, plan, saison, pm) {
  const sante = Array.isArray(data.sante) ? data.sante.filter(v => v !== 'aucun') : [];
  const pelage = Array.isArray(data.pelage) ? data.pelage.filter(v => v !== 'brillant') : [];
  const odeurs = Array.isArray(data.odeurs) ? data.odeurs.filter(v => v !== 'aucune') : [];
  const intolerances = Array.isArray(data.intolerances) ? data.intolerances.filter(v => v !== 'aucune') : [];
  const equipement = Array.isArray(data.equipement) ? data.equipement : [];

  const moduleRecettes = plan === 'beta' || plan === 'complet' ? `
## MODULE RECETTES — ACTIF

Génère un menu complet pour la première semaine incluant :
1. Le détail de chaque repas (ingrédients + quantités en grammes)
2. La méthode de cuisson recommandée (vapeur prioritaire)
3. Le planning batch cooking (2 sessions maximum par semaine)
4. Les conseils de conservation (48h frigo, 3 mois congélateur)
5. Le coût estimé à la semaine selon le budget : ${data.budget}
6. Rappel CMV obligatoire (Vit'i5 ou équivalent)
7. Ajouter l'huile froide dans la gamelle au moment du service uniquement

Intolérances à exclure absolument : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}
Mode alimentaire souhaité : ${data.modeAlimentaire}
Équipement disponible : ${equipement.join(', ')}
Temps de préparation disponible : ${data.tempsPrep}
` : `
## MODULE RECETTES — NON ACTIF

Ne génère pas de recettes ni de quantités précises.
Mentionne à la fin que les menus mensuels avec quantités exactes sont disponibles dans l'abonnement à 19€/mois.
`;

  return `Tu es Kyno, expert en nutrition canine individualisée basé sur les références NRC 2006 et FEDIAF 2023. Tu génères des rapports nutritionnels personnalisés pour des propriétaires de chiens en France. Ton ton est chaleureux, expert et direct. Tu vouvoies le propriétaire et parles du chien par son prénom.

## PROFIL DE ${data.prenom.toUpperCase()}
- Prénom : ${data.prenom}
- Race : ${data.race}
- Âge : ${data.age}
- Poids : ${data.poids ? data.poids + ' kg' : 'non renseigné'}
- Poids métabolique : ${pm} kg PM
- Sexe/Statut : ${data.sexe}
- Niveau d'activité : ${data.activite}
- Environnement : ${data.environnement}
- Saison actuelle en France : ${saison}

## SANTÉ ET ALIMENTATION
- Alimentation actuelle : ${data.alimentation}
- Problèmes de santé : ${sante.length > 0 ? sante.join(', ') : 'aucun déclaré'}
- Traitements en cours : ${data.traitements || 'aucun'}
- État du pelage : ${pelage.length > 0 ? pelage.join(', ') : 'bon état général'}
- Qualité des selles : ${data.selles}
- Odeurs : ${odeurs.length > 0 ? odeurs.join(', ') : 'aucune'}
- Intolérances connues : ${intolerances.length > 0 ? intolerances.join(', ') : 'aucune'}

## PROJET ALIMENTAIRE
- Mode souhaité : ${data.modeAlimentaire}
- Budget mensuel : ${data.budget}
- Objectif principal : ${data.objectif}

## CALCUL BEE
Calcule BEE = 110 × (${data.poids})^0.75 et applique le coefficient :
- Stérilisé(e) sédentaire : × 0.9-1.0
- Entier(e) modéré : × 1.2-1.4
- Actif : × 1.6-1.8
- Très actif : × 2.0-2.5
Explique le résultat simplement au propriétaire.

## PRÉDISPOSITIONS RACIALES
Identifie les alertes nutritionnelles pour la race "${data.race}" :
- DCM/taurine : Golden Retriever, Boxer, Doberman, Cocker, Terre-Neuve
- Cuivre : Bedlington, Labrador, Westie
- MDR1 : Border Collie, Berger Australien, Colley, Shetland
- Obésité : Labrador, Golden, Basset
- EPI/digestif : Berger Allemand
- Brachycéphales : Bouledogue, Carlin, Boxer
- Épagneul Breton : articulations, tendons, énergie élevée
Si aucune prédisposition connue, ne pas inventer.

## AJUSTEMENT SAISONNIER — ${saison.toUpperCase()}
${saison === 'Printemps' ? 'Mue intense : renforcer acides aminés soufrés, zinc, biotine, oméga-3. Aliments de saison : agneau, maquereau, haricots verts, carottes primeurs.' : ''}
${saison === 'Été' ? 'Hydratation prioritaire — besoin hydrique peut doubler. Alimentation humide recommandée. Repas aux heures fraîches. Aliments : sardines fraîches, dinde, courgettes, concombre.' : ''}
${saison === 'Automne' ? 'Renforcement immunitaire : zinc, oméga-3, probiotiques. Aliments : hareng, porc, courge, carottes, panais. Gibier toujours cuit à cœur.' : ''}
${saison === 'Hiver' ? 'Chien intérieur : rations stables. Chien actif extérieur : +10-20% calories si perte de poids. Aliments : bœuf, dinde, courge butternut, patate douce, cabillaud. Repas tièdes.' : ''}

${moduleRecettes}

## COMPLÉMENTS PRIORITAIRES
Identifie les 3-5 compléments les plus importants pour ce profil.
Explique pourquoi en termes simples.
${plan === 'beta' || plan === 'complet' ? 'Inclus les dosages calculés selon le poids métabolique.' : 'Ne pas donner les dosages exacts — réservés à l\'abonnement.'}
Rappeler toujours : oméga-3 + vitamine E ensemble, CMV obligatoire en ration ménagère.

## ALERTES
- Aliments interdits : raisin, oignon/ail/poireau, chocolat, xylitol, os cuits, avocat, macadamia
- Interactions médicaments si traitements déclarés : ${data.traitements || 'aucun'}
- Signaux d'alerte vétérinaire pertinents pour ce profil

## FORMAT DU RAPPORT (600-900 mots)

Structure :
1. Titre accrocheur personnalisé avec le prénom
2. Résumé percutant du profil en 3-4 lignes
3. BEE calculé expliqué simplement
4. Analyse de l'alimentation actuelle et ce qui manque
5. Besoins nutritionnels spécifiques
6. Alertes raciales si pertinent pour "${data.race}"
7. Ajustement saisonnier ${saison}
${plan === 'beta' || plan === 'complet' ? '8. Menu complet de la première semaine avec quantités\n9. Planning batch cooking\n10. Compléments avec dosages\n11. Aliments à éviter\n12. Ce que ça va changer en 4-6 semaines' : '8. Les 3-5 compléments prioritaires expliqués simplement\n9. Aliments à éviter absolument\n10. Ce que ça va changer en 4-6 semaines\n11. Section "Et maintenant ?" — menus mensuels disponibles en abonnement à 19€/mois'}

Note légale finale : Ce rapport est éducatif et ne remplace pas un avis vétérinaire. En cas de pathologie ou traitement en cours, consulter un vétérinaire avant tout changement alimentaire.`;
}

// ── SAISON AUTOMATIQUE ───────────────────────────────────
function getSaison() {
  const m = new Date().getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Printemps';
  if (m >= 6 && m <= 8) return 'Été';
  if (m >= 9 && m <= 11) return 'Automne';
  return 'Hiver';
}
