// api/cron-menu.js — v3 multi-chiens
// Cron quotidien (5h UTC via GitHub Actions).
// Charge les chiens actifs par foyer et génère un menu par foyer.

const { getSaison, buildMultiDogMenuPrompt, buildEmailMenuHtml } = require('./lib/menuGen');
const { getTermesExclus, detecterTermeInterdit } = require('./lib/allergenes');

// ── HELPERS TIMEZONE ──────────────────────────────────────────
function getDayParis() {
  const parisDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const d = parisDate.getDay();
  return d === 0 ? 7 : d;
}

function getTodayParis() {
  return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

// ── SLEEP & RETRY ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.ok) return result;
    const retryable = result.status === 429 || result.status >= 500;
    if (!retryable || attempt === maxAttempts) return result;
    const delay = Math.pow(2, attempt) * 1000;
    console.warn(`[retry ${attempt}/${maxAttempts}] ${label} — statut ${result.status}, attente ${delay}ms`);
    await sleep(delay);
  }
}

// ── SUPABASE HELPERS ──────────────────────────────────────────
async function patchSupabase(email, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error(`Erreur PATCH user (${res.status}):`, errBody);
  }
}

async function patchChien(chienId, fields) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?id=eq.${encodeURIComponent(chienId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(fields)
    }
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error(`Erreur PATCH chien ${chienId} (${res.status}):`, errBody);
  }
}

async function loadChiensForFoyer(email) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/chien?user_email=eq.${encodeURIComponent(email)}&actif=eq.true&order=ordre.asc&select=*`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    }
  );
  if (!res.ok) {
    console.error(`Erreur chargement chiens pour ${email}:`, res.status);
    return [];
  }
  return await res.json().catch(() => []);
}

// ── VÉRIFICATION ALLERGIES POST-GÉNÉRATION ────────────────────
// Retourne la liste des violations (terme interdit trouvé dans la recette d'un chien).
function verifierAllergiesMenu(menuData, chiens) {
  const chienMap = {};
  chiens.forEach(c => { chienMap[c.id] = c; });

  const violations = [];
  for (const mc of (menuData.chiens || [])) {
    const chien = chienMap[mc.chien_id];
    if (!chien) continue;
    const termesExclus = getTermesExclus(chien.allergies);
    if (!termesExclus.length) continue;

    for (const ing of (mc.recette?.ingredients || [])) {
      const found = detecterTermeInterdit(ing.name, termesExclus);
      if (found) violations.push({ chien: chien.prenom_chien, champ: `ingrédient "${ing.name}"`, terme: found });
    }
    for (const champ of ['titre', 'note']) {
      const found = detecterTermeInterdit(mc.recette?.[champ], termesExclus);
      if (found) violations.push({ chien: chien.prenom_chien, champ, terme: found });
    }
    const found = detecterTermeInterdit(mc.batch_special, termesExclus);
    if (found) violations.push({ chien: chien.prenom_chien, champ: 'batch_special', terme: found });
  }
  return violations;
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────
module.exports = async function handler(req, res) {

  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const emailTest = req.body?.email_test ? String(req.body.email_test).trim() : null;
    const jourParam = req.body?.jour ? parseInt(req.body.jour) : null;
    const jourCible = (jourParam >= 1 && jourParam <= 7) ? jourParam : getDayParis();
    const todayParis = getTodayParis();
    const cutoff5j  = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const cutoff14j = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    if (emailTest) {
      console.log(`[cron-menu] MODE TEST — email_test=${emailTest}`);
    } else {
      console.log(`[cron-menu] jour_cible=${jourCible}, today_paris=${todayParis}`);
    }

    const supabaseQuery = emailTest
      ? `${process.env.SUPABASE_URL}/rest/v1/user?email=eq.${encodeURIComponent(emailTest)}&select=*`
      : `${process.env.SUPABASE_URL}/rest/v1/user?statut=in.("beta","actif")&menu_envoye=eq.true&jour_envoi=eq.${jourCible}&select=*`;

    const usersRes = await fetch(supabaseQuery, {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
      }
    });

    const users = await usersRes.json();
    if (!Array.isArray(users) || !users.length) {
      console.log('[cron-menu] Aucun abonné pour ce jour.');
      return res.status(200).json({ success: true, processed: 0, envoyes: 0, ignores: 0, echecs: 0 });
    }

    const saison = getSaison();
    const recap = { envoyes: 0, ignores: 0, echecs: 0, relances: 0, details: [] };

    const BATCH_SIZE = 3;
    const BATCH_PAUSE = 2000;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const lot = users.slice(i, i + BATCH_SIZE);

      await Promise.all(lot.map(async foyer => {
        const nom = foyer.prenom_chien || foyer.email;

        // Anti-doublon
        if (foyer.dernier_menu_envoye_le && foyer.dernier_menu_envoye_le >= cutoff5j) {
          console.log(`[skip doublon] ${nom} — dernier envoi ${foyer.dernier_menu_envoye_le}`);
          recap.ignores++;
          recap.details.push({ email: foyer.email, status: 'ignore', reason: 'doublon' });
          return;
        }

        // Relance
        const derniereConnexion = foyer.derniere_connexion ? new Date(foyer.derniere_connexion) : null;
        if (!derniereConnexion || derniereConnexion < cutoff14j) {
          const cutoff7j = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (!foyer.derniere_relance || foyer.derniere_relance < cutoff7j) {
            try {
              await sendEmailRelance(foyer.email, foyer.prenom_chien || foyer.prenom || 'ton chien');
              await patchSupabase(foyer.email, { derniere_relance: todayParis });
              recap.relances++;
              console.log(`[relance] ${nom}`);
            } catch (relErr) {
              console.error(`[relance erreur] ${nom}:`, relErr.message);
            }
          }
        }

        // Chargement des chiens actifs du foyer
        const chiens = await loadChiensForFoyer(foyer.email);
        if (!chiens.length) {
          console.log(`[skip no-chien] ${foyer.email} — aucun chien actif en base`);
          recap.ignores++;
          recap.details.push({ email: foyer.email, status: 'ignore', reason: 'no-chien' });
          return;
        }

        // Génération du menu (par groupes de 4 chiens max)
        try {
          await generateMenuForFoyer(foyer, chiens, saison, todayParis);
          recap.envoyes++;
          recap.details.push({ email: foyer.email, status: 'ok', chiens: chiens.length });
          console.log(`[ok] Menu envoyé pour ${nom} (${chiens.length} chien(s))`);
        } catch (err) {
          recap.echecs++;
          recap.details.push({ email: foyer.email, status: 'error', error: err.message });
          console.error(`[erreur] ${nom}:`, err.message);
        }
      }));

      if (i + BATCH_SIZE < users.length) await sleep(BATCH_PAUSE);
    }

    console.log(`[cron-menu] Récap : ${recap.envoyes} envoyés, ${recap.ignores} ignorés, ${recap.echecs} échecs, ${recap.relances} relances`);
    const hasErrors = recap.echecs > 0;
    return res.status(hasErrors ? 500 : 200).json({ success: !hasErrors, jourCible, todayParis, ...recap });

  } catch (error) {
    console.error('Erreur cron-menu.js:', error);
    return res.status(500).json({ error: 'Erreur serveur', message: error.message });
  }
};

// ── GÉNÉRATION DU MENU POUR UN FOYER ─────────────────────────
async function generateMenuForFoyer(foyer, chiens, saison, todayParis) {
  const email = foyer.email;
  // Le brief limite à 4 chiens par appel. S'il y en a plus, on prend les 4 premiers actifs.
  const chiensToProcess = chiens.slice(0, 4);
  const nomsFoyer = chiensToProcess.map(c => c.prenom_chien || c.id).join(' & ');

  // ── 1. Archiver le menu actuel (backward compat — données foyer) ────────────
  if (Array.isArray(foyer.recettes) && foyer.recettes.length > 0) {
    const recetteActuelle = foyer.recettes[0];
    const existingHistorique = Array.isArray(foyer.historique_menus) ? foyer.historique_menus : [];
    const newEntry = {
      score: foyer.score_sante || 85,
      label: getLabelSemaine(),
      note:  recetteActuelle.titre || ''
    };
    await patchSupabase(email, { historique_menus: [...existingHistorique, newEntry].slice(-10) });
  }

  // ── 2. Archiver le poids du premier chien ──────────────────────────────────
  const premierChien = chiensToProcess[0];
  if (premierChien.poids) {
    const existingPoids = Array.isArray(foyer.poids_historique) ? foyer.poids_historique : [];
    const poidsEntry = { label: `S-${getIsoWeek()}`, poids: premierChien.poids };
    await patchSupabase(email, { poids_historique: [...existingPoids, poidsEntry].slice(-6) });
  }

  // ── 3. Générer le menu via Claude (max 2 tentatives si violation allergie) ──
  const systemPrompt = buildMultiDogMenuPrompt(chiensToProcess, foyer, saison);
  let menuData;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const menuRes = await withRetry(
      () => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: systemPrompt,
          messages: [{ role: 'user', content: 'Génère le menu de la semaine au format JSON demandé. Réponds uniquement avec le JSON, sans texte avant ni après, sans balises markdown.' }]
        })
      }),
      `Claude menu pour ${nomsFoyer} (tentative ${attempt})`
    );

    if (!menuRes.ok) {
      const err = await menuRes.json().catch(() => ({}));
      throw new Error(err.error?.message || `Erreur API Anthropic (${menuRes.status})`);
    }

    const menuResult = await menuRes.json();
    let rawText = menuResult.content[0].text.trim();
    rawText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const first = rawText.indexOf('{');
    const last  = rawText.lastIndexOf('}');
    if (first > 0 || last < rawText.length - 1) rawText = rawText.slice(first, last + 1);

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error(`Parsing JSON menu échoué: ${parseErr.message}`);
    }

    if (!Array.isArray(parsed.chiens) || !parsed.chiens.length) {
      throw new Error('Réponse Claude invalide : champ "chiens" manquant ou vide');
    }

    // Vérification allergies post-génération
    const violations = verifierAllergiesMenu(parsed, chiensToProcess);
    if (!violations.length) {
      menuData = parsed;
      break;
    }

    const violationsStr = violations.map(v => `${v.chien} — ${v.champ} contient "${v.terme}"`).join('; ');
    if (attempt === 2) {
      throw new Error(`Violations allergie après régénération : ${violationsStr}`);
    }
    console.warn(`[allergie][tentative ${attempt}] violations détectées, régénération : ${violationsStr}`);
  }

  // ── 4. Sauvegarder les données par chien dans la table `chien` ─────────────
  await Promise.all(menuData.chiens.map(async mc => {
    const chienPatch = {};
    if (mc.proteine_principale) chienPatch.proteine_principale = mc.proteine_principale;
    if (Array.isArray(mc.apports) && mc.apports.length) chienPatch.apports = mc.apports;
    if (mc.batch_special) chienPatch.batch_special = mc.batch_special;
    if (Object.keys(chienPatch).length) {
      await patchChien(mc.chien_id, chienPatch);
    }
  }));

  // ── 5. Sauvegarder les données foyer dans la table `user` (backward compat) ─
  const premierMenu = menuData.chiens[0];
  const corePayload = {
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
  await patchSupabase(email, corePayload);

  if (premierMenu.score_sante != null) {
    const scorePatch = { score_sante: premierMenu.score_sante };
    if (Array.isArray(premierMenu.score_bullets) && premierMenu.score_bullets.length) {
      scorePatch.score_bullets = premierMenu.score_bullets.slice(0, 3);
    }
    await patchSupabase(email, scorePatch);
  }
  if (premierMenu.proteine_principale) {
    await patchSupabase(email, { proteine_principale: premierMenu.proteine_principale });
  }
  if (Array.isArray(premierMenu.apports) && premierMenu.apports.length) {
    await patchSupabase(email, { apports: premierMenu.apports });
  }
  if (premierMenu.batch_special) {
    await patchSupabase(email, { batch_special: premierMenu.batch_special });
  }

  // ── 6. Envoyer l'email ─────────────────────────────────────────────────────
  await sendEmailMenu(foyer, chiensToProcess, menuData, saison);

  // ── 7. Marquer l'envoi ─────────────────────────────────────────────────────
  if (todayParis) {
    await patchSupabase(email, { dernier_menu_envoye_le: todayParis });
  }
}

// ── UTILITAIRES ───────────────────────────────────────────────
function getLabelSemaine() {
  const now = new Date();
  const mois = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'];
  return `Semaine du ${now.getDate()} ${mois[now.getMonth()]}`;
}

function getIsoWeek() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  return Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}

// ── EMAIL MENU ────────────────────────────────────────────────
async function sendEmailMenu(foyer, chiens, menuData, saison) {
  const prenom = chiens.length === 1
    ? (chiens[0].prenom_chien || 'ton chien')
    : chiens.map(c => c.prenom_chien || 'Chien').join(' & ');

  const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email: foyer.email, name: prenom }],
      subject: `Le menu de la semaine de ${prenom} ✦`,
      htmlContent: buildEmailMenuHtml(foyer, chiens, menuData, saison)
    })
  });

  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo menu ${emailRes.status}: ${errBody}`);
  }
}

// ── EMAIL RELANCE ─────────────────────────────────────────────
async function sendEmailRelance(email, prenom) {
  const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender: { name: 'Kyno', email: 'colinemngl@gmail.com' },
      to: [{ email, name: prenom }],
      subject: `Des nouvelles de ${prenom} ? 🐾`,
      htmlContent: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F7F1;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F7F1;padding:48px 20px;">
    <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
      <tr>
        <td style="padding:0 8px 28px;text-align:center;">
          <div style="display:inline-flex;align-items:center;gap:8px;">
            <div style="width:28px;height:28px;border-radius:50%;border:1.5px solid #2FA35E;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#2FA35E;font-family:Arial,sans-serif;">K</div>
            <span style="font-size:15px;font-weight:700;color:#2B3A2E;letter-spacing:0.04em;">kyno</span>
          </div>
        </td>
      </tr>
      <tr>
        <td style="background:#FFFFFF;border-radius:20px;padding:40px 36px;border:1px solid #E3EDE1;text-align:center;">
          <svg width="52" height="52" viewBox="0 0 52 52" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:16px;">
            <circle cx="26" cy="26" r="26" fill="#FBE4D8"/>
            <path d="M16 20c0-2 1.5-4 3.2-4 1.2 0 2.2 1 2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
            <path d="M36 20c0-2-1.5-4-3.2-4-1.2 0-2.2 1-2.6 2.4" stroke="#2B3A2E" stroke-width="1.6" stroke-linecap="round" fill="none"/>
            <ellipse cx="26" cy="29" rx="10" ry="8.5" fill="#F2843C"/>
            <circle cx="22" cy="27" r="1.4" fill="#2B3A2E"/>
            <circle cx="30" cy="27" r="1.4" fill="#2B3A2E"/>
            <path d="M24 32c0.8 1 2.2 1 3 0" stroke="#2B3A2E" stroke-width="1.4" stroke-linecap="round" fill="none"/>
            <ellipse cx="26" cy="30.5" rx="1.4" ry="1" fill="#2B3A2E"/>
          </svg>
          <p style="margin:0 0 10px;font-size:19px;font-weight:700;color:#2B3A2E;line-height:1.4;">Des nouvelles de <span style="color:#2FA35E;">${prenom}</span> ?</p>
          <p style="margin:0 0 28px;font-size:14px;color:#8A978A;line-height:1.8;max-width:380px;margin-left:auto;margin-right:auto;">Ça fait deux semaines qu'on ne t'a pas vue par ici. Le nouveau menu de la semaine est prêt quand tu veux faire le point.</p>
          <a href="https://project-jlc6z.vercel.app/espace-client.html" style="display:inline-block;background:#2FA35E;color:white;padding:14px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;">Voir l'espace de ${prenom} →</a>
        </td>
      </tr>
      <tr>
        <td style="padding:24px 32px 0;text-align:center;">
          <a href="mailto:colinemngl@gmail.com" style="font-size:11px;color:#9AA69B;text-decoration:none;">kyno · colinemngl@gmail.com</a>
        </td>
      </tr>
    </table>
    </td></tr>
  </table>
</body></html>`
    })
  });
  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo relance ${emailRes.status}: ${errBody}`);
  }
}
