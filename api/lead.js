// /api/lead — modtager kontaktformularen og leverer den til Slack + Genrise Lab CRM
//
// Miljøvariabler i Vercel (Settings -> Environment Variables):
//   GENRISE_WEBHOOK_URL  https://dshxogtxantiriupcbsn.supabase.co/functions/v1/scaleconsulting-leads
//   GENRISE_API_KEY      SCALECONSULTING_LEAD_SECRET (dedikeret token til dette site)
//   SLACK_WEBHOOK_URL    valgfri, den eksisterende Slack incoming webhook
//
// Begge destinationer leveres uafhængigt af hinanden: fejler den ene,
// blokerer den ikke den anden. Der svares kun fejl, hvis ALLE fejler.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const d = req.body || {};

  // Honeypot: skjult felt som mennesker aldrig ser. Er det udfyldt, er det en bot.
  // Svar 200, så botten tror alt gik godt — men send ingenting videre.
  if (d.botcheck || d.company_website_hp) {
    return res.status(200).json({ ok: true });
  }

  // Understøt både de danske feltnavne og engelske fallbacks
  const navn = d.navn || d.name || '';
  const email = d.email || '';
  const telefon = d.telefon || d.phone || '';
  const virksomhed = d.virksomhed || d.company || '';
  const website = d.website || '';
  const omsaetning = d.omsaetning || d.revenue || '';
  const udfordringer = d.udfordringer || d.message || '';
  const platform = d.platform || '';
  const rejse = d.rejse || '';
  const spend = d.spend || '';
  const kilde = d.kilde || '';
  const source = d.source || 'Vækstanalyse';

  if (!navn || !email) {
    return res.status(400).json({ error: 'Navn og e-mail er påkrævet' });
  }

  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  const crmUrl = process.env.GENRISE_WEBHOOK_URL;
  const crmKey = process.env.GENRISE_API_KEY;

  if (!slackUrl && !crmUrl) {
    return res.status(500).json({ error: 'Ingen destination konfigureret' });
  }

  const tasks = [];

  // ---------- Slack (samme format som hidtil) ----------
  if (slackUrl) {
    const row = (label, value) => (value ? `*${label}:* ${value}` : null);
    const fields = [
      row('Navn', navn),
      row('E-mail', email),
      row('Telefon', telefon),
      row('Virksomhed', virksomhed),
      row('Webshop', website),
      row('Platform', platform),
      row('Rejse', rejse),
      row('Omsætning', omsaetning),
      row('Annonceforbrug', spend),
      row('Hørt om os via', kilde),
      row('Udfordringer', udfordringer),
    ].filter(Boolean);

    const payload = {
      text: `NEW FORM ENTRY — ${source} (scaleconsulting.dk)`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🟢 NEW FORM ENTRY — ${source}`, emoji: true },
        },
        { type: 'section', text: { type: 'mrkdwn', text: fields.join('\n') } },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Kilde: scaleconsulting.dk · ${new Date().toLocaleString('da-DK', {
                timeZone: 'Europe/Copenhagen',
              })}`,
            },
          ],
        },
      ],
    };

    tasks.push(
      fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then((r) => ({ target: 'slack', ok: r.ok, status: r.status }))
        .catch(() => ({ target: 'slack', ok: false, status: 0 }))
    );
  }

  // ---------- Genrise Lab CRM ----------
  if (crmUrl) {
    // Endpointet (scaleconsulting-leads) forstår selv de danske feltnavne:
    // navn/telefon/virksomhed/udfordringer mappes til kolonner, og alt øvrigt
    // (platform, rejse, spend, kilde) gemmes struktureret i form_data.
    // Derfor sender vi felterne råt i stedet for at folde dem ind i message.
    //
    // Bemærk: 'source' sendes IKKE med — CRM'et sætter selv enum-værdien
    // 'scaleconsulting'. Sprog/formular sendes i stedet som egne felter,
    // så de lander i form_data og kan segmenteres på.
    const headers = { 'Content-Type': 'application/json' };
    if (crmKey) headers['Authorization'] = `Bearer ${crmKey}`;

    tasks.push(
      fetch(crmUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          navn,
          email,
          telefon,
          virksomhed,
          website,
          udfordringer,
          platform,
          rejse,
          omsaetning,
          spend,
          kilde,
          formular: source,
          sprog: d.sprog || (source === 'Growth analysis' ? 'en' : 'da'),
          submitted_at: new Date().toISOString(),
          page: d.page || req.headers.referer || '',
        }),
      })
        .then((r) => ({ target: 'crm', ok: r.ok, status: r.status }))
        .catch(() => ({ target: 'crm', ok: false, status: 0 }))
    );
  }

  const results = await Promise.all(tasks);

  results
    .filter((r) => !r.ok)
    .forEach((r) => console.error(`Lead-levering fejlede: ${r.target} (status ${r.status})`));

  // Succes hvis mindst én destination tog imod — så nedbrud ét sted aldrig taber leadet
  if (!results.some((r) => r.ok)) {
    return res.status(502).json({ error: 'Alle destinationer fejlede' });
  }

  return res.status(200).json({ ok: true, delivered: results });
}
