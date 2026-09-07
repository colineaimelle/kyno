// api/ping-db.js
// Ping quotidien pour garder le projet Supabase actif
// (évite la pause automatique après une semaine sans requête)

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const pingRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/user?select=email&limit=1`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`
        }
      }
    );

    if (!pingRes.ok) {
      const errBody = await pingRes.text().catch(() => '');
      return res.status(502).json({ error: 'Ping Supabase échoué', status: pingRes.status, body: errBody });
    }

    return res.status(200).json({ success: true, message: 'Supabase actif' });
  } catch (error) {
    return res.status(500).json({ error: 'Erreur ping', message: error.message });
  }
};
