// api/cron-menu.js — v3 multi-chiens
// Cron quotidien (5h UTC via GitHub Actions).
// Charge les chiens actifs par foyer et génère un menu par foyer.

const { getSaison, buildEmailMenuHtml } = require('./lib/menuGen');
const { genererMenuFoyer }              = require('./lib/genererMenuChien');

const SITE_URL = process.env.SITE_URL || (process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://kyno.fr');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'colinemngl@gmail.com';
const { detecterTermeNonNie } = require('./lib/allergenes');

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

        // Anti-doublon (ignoré en mode email_test)
        if (!emailTest && foyer.dernier_menu_envoye_le && foyer.dernier_menu_envoye_le >= cutoff5j) {
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
  const chiensToProcess = chiens.slice(0, 4);
  const nomsFoyer = chiensToProcess.map(c => c.prenom_chien || c.id).join(' & ');

  // ── 1. Archiver le menu actuel ──────────────────────────────
  if (Array.isArray(foyer.recettes) && foyer.recettes.length > 0) {
    const recetteActuelle = foyer.recettes[0];
    const existingHistorique = Array.isArray(foyer.historique_menus) ? foyer.historique_menus : [];
    const newEntry = { score: foyer.score_sante || 85, label: getLabelSemaine(), note: recetteActuelle.titre || '' };
    await patchSupabase(email, { historique_menus: [...existingHistorique, newEntry].slice(-10) });
  }

  // ── 2. Archiver le poids du premier chien ──────────────────
  const premierChien = chiensToProcess[0];
  if (premierChien.poids) {
    const existingPoids = Array.isArray(foyer.poids_historique) ? foyer.poids_historique : [];
    const poidsEntry = { label: `S-${getIsoWeek()}`, poids: premierChien.poids };
    await patchSupabase(email, { poids_historique: [...existingPoids, poidsEntry].slice(-6) });
  }

  // ── 3. Pipeline unifié (calcul cibles + Claude × 2 + verif + alerte) ──────
  const { menuData, ciblesKcal, echecs, stats } = await genererMenuFoyer(chiensToProcess, foyer, { saison });

  if (stats.resultat === 'bloque') {
    throw new Error(`Menu bloqué après 2 essais pour ${nomsFoyer}`);
  }

  console.log(`[cron] ${stats.resultat} — ${stats.nbOk}/${stats.nbTotal} chiens, ${stats.tentatives} essai(s)`);

  // ── 4. Enregistrer par chien ───────────────────────────────
  await Promise.all((menuData.chiens || []).map(async mc => {
    const chienPatch = {};
    if (mc.recette)                                                        chienPatch.recette             = mc.recette;
    if (mc.score_sante != null)                                            chienPatch.score_sante         = mc.score_sante;
    if (Array.isArray(mc.score_bullets) && mc.score_bullets.length)       chienPatch.score_bullets       = mc.score_bullets.slice(0, 3);
    if (mc.proteine_principale)                                            chienPatch.proteine_principale = mc.proteine_principale;
    if (Array.isArray(mc.apports) && mc.apports.length)                   chienPatch.apports             = mc.apports;
    if (mc.batch_special)                                                  chienPatch.batch_special       = mc.batch_special;
    if (Array.isArray(mc.ingredients_grammes_crus) && mc.ingredients_grammes_crus.length)
                                                                           chienPatch.ingredients_grammes_crus = mc.ingredients_grammes_crus;
    if (Object.keys(chienPatch).length) await patchChien(mc.chien_id, chienPatch);
  }));

  // ── 5. Enregistrer au niveau foyer ────────────────────────
  const premierMenu = (menuData.chiens || [])[0] || {};
  await patchSupabase(email, {
    menu_texte:   '',
    recettes:     (menuData.chiens || []).map(mc => mc.recette).filter(Boolean),
    batch_steps:  menuData.batch_cooking_commun || [],
    courses:      menuData.courses_commune || [],
    cout_semaine: menuData.cout_semaine || null,
    cout_indus:   menuData.cout_indus || null,
    economie:     menuData.economie || null,
    batch_time:   menuData.batch_time || null,
    menu_envoye:  true,
  });

  // ── 6. Envoyer l'email ─────────────────────────────────────
  await sendEmailMenu(foyer, chiensToProcess, menuData, saison, ciblesKcal);

  // ── 7. Marquer l'envoi ─────────────────────────────────────
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
async function sendEmailMenu(foyer, chiens, menuData, saison, ciblesKcal = {}) {
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
      subject: `Le menu de la semaine de ${prenom}`,
      htmlContent: buildEmailMenuHtml(foyer, chiens, menuData, saison, ciblesKcal)
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
      subject: `Des nouvelles de ${prenom} ?`,
      htmlContent: `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FFF4E0;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFF4E0;padding:32px 16px;">
  <tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border:3px solid #451A36;border-radius:20px;overflow:hidden;">
    <tr>
      <td style="padding:0;line-height:0;font-size:0;border-bottom:4px solid #451A36;">
        <img src="${SITE_URL}/email-entete-relance.png" width="600" height="150" alt="Kyno" style="display:block;width:100%;max-width:600px;">
      </td>
    </tr>
    <tr>
      <td style="padding:30px 32px 26px;">
        <h1 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.25;font-weight:700;color:#451A36;">
          Des nouvelles de <span style="display:inline-block;background:#F27A9B;border:3px solid #451A36;border-radius:10px;padding:0 8px 2px;">${prenom}</span>&nbsp;?
        </h1>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.7;color:#451A36;font-family:Arial,Helvetica,sans-serif;">
          &Ccedil;a fait deux semaines qu&apos;on n&apos;a pas eu de nouvelles. Son poids, sa digestion, son &eacute;nergie&nbsp;: dis-moi ce qui a chang&eacute;, et j&apos;ajuste son prochain menu.
        </p>
        <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
          <tr>
            <td bgcolor="#E5432F" style="border-radius:999px;border:3px solid #451A36;">
              <a href="${SITE_URL}/espace-client.html" style="display:inline-block;padding:14px 26px;color:#FFF4E0;font-family:Arial,Helvetica,sans-serif;font-size:17px;font-weight:700;text-decoration:none;white-space:nowrap;">Raconter sa semaine</a>
            </td>
          </tr>
        </table>
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
</body></html>`
    })
  });
  if (!emailRes.ok) {
    const errBody = await emailRes.text().catch(() => '');
    throw new Error(`Brevo relance ${emailRes.status}: ${errBody}`);
  }
}
