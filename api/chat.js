// api/chat.js — v4 multi-chiens
// chien_id obligatoire (fallback auto si absent jusqu'à la Phase 3 espace-client).
// chat_history et observations lus/écrits sur la table `chien`.
// Vérification d'appartenance par JWT (ou email body en fallback).

const { getSaison, buildMultiDogMenuPrompt, buildEmailMenuHtml } = require('./lib/menuGen');

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { messages, profile, email, chien_id } = req.body;
    if (!messages || !profile) return res.status(400).json({ error: 'Données incomplètes' });

    // ── Vérification d'identité JWT ──────────────────────────────────────────
    const jwtEmail = getEmailFromJwt(req.headers['authorization']);
    const authedEmail = jwtEmail || email;
    if (!authedEmail) return res.status(401).json({ error: 'Authentification requise' });

    // ── Résolution du chien_id ───────────────────────────────────────────────
    let chienId = chien_id;
    if (!chienId && authedEmail) {
      // Fallback Phase 2 → 3 : premier chien actif du foyer
      const fallback = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(authedEmail)}&actif=eq.true&order=ordre.asc&limit=1&select=id`,
        { headers: supabaseHeaders() }
      );
      if (fallback.ok) {
        const rows = await fallback.json().catch(() => []);
        if (rows.length) chienId = rows[0].id;
      }
    }
    if (!chienId) return res.status(400).json({ error: 'chien_id manquant' });

    // ── Vérification d'appartenance du chien ────────────────────────────────
    const owned = await verifyChienOwnership(chienId, authedEmail);
    if (!owned) return res.status(403).json({ error: 'Accès interdit à ce chien' });

    // ── Contexte chat ────────────────────────────────────────────────────────
    const saison = getSaison();
    const pm  = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : 'inconnu';
    const nom = profile.prenom_chien || profile.prenom || 'ton chien';

    const sexe      = (profile.sexe || '').toLowerCase();
    const estFemelle = sexe.includes('femelle');
    const allergies  = Array.isArray(profile.allergies) ? profile.allergies : [];
    const objectifsStr = Array.isArray(profile.objectifs)
      ? profile.objectifs.join(', ')
      : (typeof profile.objectifs === 'string' ? profile.objectifs : 'non renseignés');

    const recettesActuelles = Array.isArray(profile.recettes) && profile.recettes.length > 0
      ? profile.recettes.map(r => `- ${r.moment} : ${r.titre} (${r.ration}g/repas)`).join('\n')
      : 'Aucun menu actif pour le moment.';

    const systemPrompt = `Tu es Kyno, expert en nutrition canine individualisée (NRC 2006, FEDIAF 2023).
Tu suis l'évolution de ${nom} (${profile.race || 'race inconnue'}, ${profile.poids ? profile.poids + ' kg' : 'poids inconnu'}, ${profile.sexe || 'sexe inconnu'}).
Tu es chaleureux, précis et direct. Tu tutoies toujours le propriétaire et parles du chien par son prénom.
Genre de ${nom} : ${profile.sexe || 'non renseigné'} — ${estFemelle ? 'utilise "elle", "la", "cette chienne".' : 'utilise "il", "le", "ce chien".'}

⚠️ ALLERGIES ET INTOLÉRANCES — INTERDICTION ABSOLUE :
${allergies.length > 0
  ? `${nom} est ALLERGIQUE/INTOLÉRANT(E) à : ${allergies.join(', ')}
Ces ingrédients sont STRICTEMENT INTERDITS dans toutes tes recommandations et tous les menus que tu génères.`
  : 'Aucune allergie ou intolérance connue.'}

MENU ACTUEL DE ${nom.toUpperCase()} :
${recettesActuelles}

PROFIL COMPLET :
- Race : ${profile.race || 'non renseignée'}
- Âge : ${profile.age || 'non renseigné'}
- Poids : ${profile.poids ? profile.poids + ' kg (PM : ' + pm + ' kg)' : 'non renseigné'}
- Sexe : ${profile.sexe || 'non renseigné'}
- Activité : ${profile.activite || 'non renseignée'}
- Environnement : ${profile.environnement || 'non renseigné'}
- Antécédents : ${profile.antecedents || 'aucun'}
- Objectifs : ${objectifsStr}
- Saison actuelle : ${saison}

─────────────────────────────────────────────────
FORMAT DE RÉPONSE OBLIGATOIRE — JSON STRICT
─────────────────────────────────────────────────
Tu réponds TOUJOURS avec ce JSON exact, sans texte avant ni après, sans balises markdown :

{
  "reply": "ta réponse au propriétaire, en texte naturel. Utilise **texte** pour le gras.",
  "updates": {
    // Uniquement les champs CONFIRMÉS à mettre à jour, vide {} si rien ne change.
    // Champs modifiables : poids (number), allergies (array — nouvelles allergies SEULEMENT),
    // sensibilites (array), objectifs (array), activite (string), comportement (string), antecedents (string), score_sante (number)
  },
  "observations": [
    // Observations informelles sur l'état de ${nom} mentionnées dans ce message du propriétaire.
    // Ex: [{ "texte": "mange mieux depuis 3 jours" }, { "texte": "poils plus brillants" }]
    // [] si aucune observation informelle dans ce message.
  ],
  "generer_menu": false
}

RÈGLES SUR observations :
- Extrais les informations informelles sur l'état de ${nom} mentionnées par le propriétaire, sans confirmation formelle
- Exemples valides : "mange mieux", "moins d'énergie", "poils plus brillants", "dort plus", "boit davantage", "a vomi", "selles molles", etc.
- Ne pas dupliquer ce qui va dans "updates" (les mises à jour formelles confirmées)
- Tableau vide [] si aucune observation dans ce message

RÈGLES DE MISE À JOUR DU PROFIL :
- Si le propriétaire mentionne un changement (poids, nouvelle allergie, activité, etc.), demande TOUJOURS confirmation avant de mettre à jour : "Je note X, je mets à jour la fiche de ${nom} ?"
- Mets "updates": {} tant que le propriétaire n'a pas confirmé explicitement
- Quand le propriétaire confirme ("oui", "exactement", "c'est ça", etc.), remplis "updates" avec les valeurs confirmées

CHAMPS VERROUILLÉS — REFUS POLI :
- Si le propriétaire demande à modifier race, sexe, age, prenom_chien ou email, réponds : "Ces informations ne peuvent être modifiées que par notre support technique à colinemngl@gmail.com."
- Ne mets JAMAIS ces champs dans "updates"

RÈGLES SUR generer_menu :
- true si : demande explicite de mise à jour/génération du menu, nouvelle allergie confirmée, changement de poids > 5%, problème digestif persistant, changement d'activité majeur
- false pour tout le reste (questions de suivi, encouragements, premier message)
- Ne mets JAMAIS true deux fois dans la même conversation sauf si la première génération a eu lieu il y a plus de 7 messages

CAPACITÉS : Tu ES capable de générer et mettre à jour le menu de ${nom} directement dans son espace client. Quand quelqu'un te demande de mettre à jour le menu ou de le générer, tu réponds positivement, tu annonces ce que tu vas faire, et tu mets generer_menu à true. Ne dis JAMAIS que tu n'as pas accès à l'espace client — tu y as accès via la génération de menu.`;

    const formattedMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));

    if (!formattedMessages.length || formattedMessages[0].role !== 'user') {
      return res.status(400).json({ error: "Le premier message doit être de l'utilisateur" });
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: systemPrompt,
        messages: formattedMessages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Erreur API Anthropic');
    }

    const claudeResult = await claudeRes.json();
    let rawText = claudeResult.content[0].text.trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const first = rawText.indexOf('{');
    const last  = rawText.lastIndexOf('}');
    if (first > 0 || last < rawText.length - 1) rawText = rawText.slice(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error('Parsing JSON réponse chat échoué:', e.message);
      return res.status(200).json({ success: true, reply: rawText, menuGenere: false });
    }

    const reply          = parsed.reply || '';
    const updates        = parsed.updates || {};
    const genererMenu    = parsed.generer_menu === true;
    const newObservations = Array.isArray(parsed.observations) ? parsed.observations : [];

    // ── Mises à jour du profil chien ────────────────────────────────────────
    if (authedEmail && Object.keys(updates).length > 0) {
      const patch = { ...updates };

      if (Array.isArray(updates.allergies) && updates.allergies.length > 0) {
        patch.allergies = [...new Set([...allergies, ...updates.allergies])];
      }

      // poids_historique → reste sur user (backward compat)
      let userPatch = {};
      if (updates.poids != null && updates.poids !== profile.poids) {
        const existingPoids = Array.isArray(profile.poids_historique) ? profile.poids_historique : [];
        const today = new Date().toISOString().split('T')[0];
        userPatch.poids_historique = [...existingPoids, { label: today, poids: updates.poids }].slice(-6);
      }

      // Champs chien → table chien
      const CHIEN_FIELDS = new Set(['poids', 'allergies', 'sensibilites', 'objectifs', 'activite', 'comportement',
        'race', 'age', 'sexe', 'maladies', 'traitements', 'reactions_allergiques', 'reaction_statut',
        'mode_alimentaire', 'alimentation_actuelle', 'observations', 'proteine_principale', 'apports', 'batch_special']);
      const chienPatch = {};
      Object.entries(patch).forEach(([k, v]) => {
        if (CHIEN_FIELDS.has(k)) chienPatch[k] = v;
        else userPatch[k] = v;
      });

      if (Object.keys(chienPatch).length > 0) await patchChien(chienId, chienPatch);
      if (Object.keys(userPatch).length > 0)  await patchSupabase(authedEmail, userPatch);
      Object.assign(profile, patch);
    }

    // ── Historique du chat → chien ───────────────────────────────────────────
    if (authedEmail) {
      const updatedHistory = [...messages, { role: 'assistant', content: reply }];
      await saveChatHistory(chienId, updatedHistory);
    }

    // ── Observations → chien ─────────────────────────────────────────────────
    if (authedEmail && newObservations.length > 0) {
      await saveObservations(chienId, newObservations);
    }

    // ── Génération du menu du foyer entier ───────────────────────────────────
    let menuGenere = false;
    if (genererMenu && authedEmail) {
      try {
        const updatedPm = profile.poids ? Math.pow(profile.poids, 0.75).toFixed(2) : pm;
        menuGenere = await generateAndSaveMenu(authedEmail, chienId, profile, saison, updatedPm);
      } catch (menuErr) {
        console.error('Erreur génération menu depuis chat:', menuErr);
      }
    }

    return res.status(200).json({ success: true, reply, menuGenere });

  } catch (error) {
    console.error('Erreur chat.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

// ── HELPERS AUTH ──────────────────────────────────────────────
function getEmailFromJwt(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function verifyChienOwnership(chienId, email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}&user_email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
    { headers: supabaseHeaders() }
  );
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return rows.length > 0;
}

// ── HELPERS SUPABASE ──────────────────────────────────────────
function supabaseHeaders() {
  return {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
  };
}

async function patchSupabase(email, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('Erreur PATCH user:', res.status, errBody);
  }
}

async function patchChien(chienId, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error(`Erreur PATCH chien ${chienId}:`, res.status, errBody);
  }
}

async function saveChatHistory(chienId, messages) {
  await patchChien(chienId, { chat_history: messages });
}

async function saveObservations(chienId, newObs) {
  const getRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}&select=observations`,
    { headers: supabaseHeaders() }
  );

  let existing = [];
  if (getRes.ok) {
    const data = await getRes.json().catch(() => []);
    if (data?.[0] && Array.isArray(data[0].observations)) {
      existing = data[0].observations;
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const toAdd = newObs
    .filter(o => o && typeof o.texte === 'string' && o.texte.trim())
    .map(o => ({ date: today, texte: o.texte.trim(), source: 'chat' }));

  await patchChien(chienId, { observations: [...existing, ...toAdd] });
  console.log(`${toAdd.length} observation(s) sauvegardée(s) sur chien ${chienId}`);
}

// ── GÉNÉRATION DU MENU DU FOYER ENTIER ───────────────────────
async function generateAndSaveMenu(email, chienId, profile, saison, pm) {
  // Charger tous les chiens actifs du foyer
  const chiensRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&actif=eq.true&order=ordre.asc&select=*`,
    { headers: supabaseHeaders() }
  );
  let chiens = chiensRes.ok ? await chiensRes.json().catch(() => []) : [];

  // Mettre à jour le chien courant avec les données fraîches du profil en mémoire
  chiens = chiens.map(c => c.id === chienId ? { ...c, ...profile, id: c.id } : c);
  if (!chiens.length) chiens = [{ id: chienId, user_email: email, ...profile }];

  const chiensToProcess = chiens.slice(0, 4);

  // Charger les données foyer
  const foyerRes = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}&select=*`,
    { headers: supabaseHeaders() }
  );
  const foyer = foyerRes.ok
    ? ((await foyerRes.json().catch(() => []))[0] || {})
    : {};

  const menuRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      system: buildMultiDogMenuPrompt(chiensToProcess, foyer, saison),
      messages: [{ role: 'user', content: 'Génère le menu de la semaine au format JSON demandé. Réponds uniquement avec le JSON, sans texte avant ni après, sans balises markdown.' }]
    })
  });

  if (!menuRes.ok) {
    const err = await menuRes.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Erreur API Anthropic menu');
  }

  const menuResult = await menuRes.json();
  let rawText = menuResult.content[0].text.trim();
  rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const first = rawText.indexOf('{');
  const last  = rawText.lastIndexOf('}');
  if (first > 0 || last < rawText.length - 1) rawText = rawText.slice(first, last + 1);

  let menuData;
  try {
    menuData = JSON.parse(rawText);
  } catch (parseErr) {
    console.error('Erreur parsing JSON menu (chat):', parseErr.message);
    throw parseErr;
  }

  if (!Array.isArray(menuData.chiens) || !menuData.chiens.length) {
    throw new Error('Réponse Claude invalide: champ chiens manquant');
  }

  // Sauvegarder par chien
  await Promise.all(menuData.chiens.map(async mc => {
    const patch = {};
    if (mc.proteine_principale) patch.proteine_principale = mc.proteine_principale;
    if (Array.isArray(mc.apports) && mc.apports.length) patch.apports = mc.apports;
    if (mc.batch_special) patch.batch_special = mc.batch_special;
    if (Object.keys(patch).length) await patchChien(mc.chien_id, patch);
  }));

  // Sauvegarder au niveau foyer (backward compat)
  const premierMenu = menuData.chiens[0];
  const foyerPatch = {
    menu_texte:   '',
    recettes:     menuData.chiens.map(mc => mc.recette).filter(Boolean),
    batch_steps:  menuData.batch_cooking_commun || [],
    courses:      menuData.courses_commune || [],
    cout_semaine: menuData.cout_semaine || null,
    cout_indus:   menuData.cout_indus || null,
    economie:     menuData.economie || null,
    batch_time:   menuData.batch_time || null,
    menu_envoye:  true,
  };
  if (premierMenu.proteine_principale) foyerPatch.proteine_principale = premierMenu.proteine_principale;
  if (Array.isArray(premierMenu.apports) && premierMenu.apports.length) foyerPatch.apports = premierMenu.apports;
  if (premierMenu.batch_special) foyerPatch.batch_special = premierMenu.batch_special;
  await patchSupabase(email, foyerPatch);

  // Envoyer l'email
  const nomLog = chiensToProcess.map(c => c.prenom_chien || 'Chien').join(' & ');
  await sendEmailMenu(email, nomLog, buildEmailMenuHtml(foyer, chiensToProcess, menuData, saison));

  console.log(`Menu chat généré pour ${nomLog} (${email})`);
  return true;
}

async function sendEmailMenu(email, prenom, htmlContent) {
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Le nouveau menu de ${prenom} est prêt ✦`,
      htmlContent
    })
  });
}
