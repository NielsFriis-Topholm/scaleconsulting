// /api/lead — modtager kontaktformularen og sender den til Slack
// Kræver miljøvariablen SLACK_WEBHOOK_URL i Vercel (Settings -> Environment Variables)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const d = req.body || {};

  // Honeypot: hvis det skjulte felt er udfyldt, er det en bot — lad som om alt gik godt
  if (d.botcheck) {
    return res.status(200).json({ ok: true });
  }

  // Minimal validering
  if (!d.navn || !d.email) {
    return res.status(400).json({ error: 'Navn og e-mail er påkrævet' });
  }

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return res.status(500).json({ error: 'SLACK_WEBHOOK_URL er ikke sat i Vercel' });
  }

  const row = (label, value) => (value ? `*${label}:* ${value}` : null);

  const fields = [
    row('Navn', d.navn),
    row('E-mail', d.email),
    row('Telefon', d.telefon),
    row('Virksomhed', d.virksomhed),
    row('Webshop', d.website),
    row('Platform', d.platform),
    row('Rejse', d.rejse),
    row('Omsætning', d.omsaetning),
    row('Annonceforbrug', d.spend),
    row('Hørt om os via', d.kilde),
    row('Udfordringer', d.udfordringer),
  ].filter(Boolean);

  const payload = {
    text: 'NEW FORM ENTRY — Vækstanalyse (scaleconsulting.dk)', // fallback til notifikationer
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🟢 NEW FORM ENTRY — Vækstanalyse', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: fields.join('\n') },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Kilde: scaleconsulting.dk · ${new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}` }],
      },
    ],
  };

  try {
    const slackRes = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!slackRes.ok) throw new Error(`Slack svarede ${slackRes.status}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Slack-fejl:', err);
    return res.status(502).json({ error: 'Kunne ikke sende til Slack' });
  }
}
