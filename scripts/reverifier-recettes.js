// scripts/reverifier-recettes.js
// Audit en lecture seule : vérifie toutes les recettes existantes via verifierMenu.
// Ne modifie rien en base.
//
// Lancement :
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_KEY=<service_role_key> \
//   node scripts/reverifier-recettes.js

'use strict';

const { verifierMenu } = require('../api/_lib/verifierMenu');
const { besoinKcalJour } = require('../api/_lib/energie');
const { kcalTotale } = require('../api/_lib/calories');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Variables manquantes : SUPABASE_URL et SUPABASE_SERVICE_KEY requis.');
  process.exit(1);
}

async function fetchChiens() {
  const url = `${SUPABASE_URL}/rest/v1/chien?actif=eq.true&not.recette=is.null&select=*`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  const chiens = await fetchChiens();
  console.log(`\n${chiens.length} chien(s) actif(s) avec une recette enregistrée.\n`);

  let nbOk = 0;
  let nbEchec = 0;

  for (const chien of chiens) {
    const nom   = chien.prenom_chien || chien.id;
    const poids = parseFloat(chien.poids) || 0;
    const cible = besoinKcalJour(chien) || null;

    // Reconstruit le "mc" tel qu'attendu par verifierMenu
    const mc = {
      chien_id:               chien.id,
      recette:                chien.recette                || null,
      ingredients_grammes_crus: Array.isArray(chien.ingredients_grammes_crus)
                                ? chien.ingredients_grammes_crus : [],
      batch_special:          chien.batch_special          || '',
      apports:                Array.isArray(chien.apports) ? chien.apports : [],
    };

    if (!cible) {
      console.log(`⚠  ${nom} (${chien.id}) — cible kcal incalculable (profil incomplet)`);
      continue;
    }

    const ciblesKcal = { [chien.id]: cible };
    const { ok, raisons } = verifierMenu(mc, chien, ciblesKcal);

    // Kcal réels
    const ingsCrus = mc.ingredients_grammes_crus;
    const { kcal: kcalReels } = ingsCrus.length ? kcalTotale(ingsCrus) : { kcal: 0 };

    if (ok) {
      nbOk++;
      console.log(
        `OK  ${nom} | id: ${chien.id} | poids: ${poids} kg` +
        ` | cible: ${cible} kcal | réels: ${Math.round(kcalReels)} kcal`
      );
    } else {
      nbEchec++;
      console.log(
        `ÉCHEC  ${nom} | id: ${chien.id} | poids: ${poids} kg` +
        ` | cible: ${cible} kcal | réels: ${Math.round(kcalReels)} kcal`
      );
      raisons.forEach(r => console.log(`       → ${r}`));
    }
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`OK : ${nbOk}  |  ÉCHEC : ${nbEchec}  |  Total : ${chiens.length}`);

  if (nbEchec > 0) {
    console.log('\nPour les chiens en ÉCHEC : régénère leur menu via le bouton dans l\'espace client,');
    console.log('ou attends le prochain cron. Le pipeline imposera la double vérification.');
  }
}

main().catch(err => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
