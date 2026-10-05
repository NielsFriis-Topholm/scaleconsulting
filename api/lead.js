// /api/lead — modtager kontaktformularen og leverer den til Slack, Genrise Lab CRM
// og GoHighLevel (kontakt, Brand = Scale, tag brand-scale, note, opportunity i
// Sales Pipeline / Klar til kald).
//
// Status (viser kun om miljøvariablerne er sat): https://scaleconsulting.dk/api/lead
//
// Miljøvariabler i Vercel (Settings -> Environment Variables):
//   GENRISE_WEBHOOK_URL  https://dshxogtxantiriupcbsn.supabase.co/functions/v1/scaleconsulting-leads
//   GENRISE_API_KEY      SCALECONSULTING_LEAD_SECRET (dedikeret token til dette site)
//   SLACK_WEBHOOK_URL    valgfri, den eksisterende Slack incoming webhook
//   GHL_API_TOKEN        Private Integration token fra GoHighLevel
//   GHL_LOCATION_ID      B2WfucvN3q69pjs5vzVO
//
// Begge destinationer leveres uafhængigt af hinanden: fejler den ene,
// blokerer den ikke den anden. Der svares kun fejl, hvis ALLE fejler.

import { sendLeadToGHL, ghlConfigured } from './_lib/ghl-lead.js';

const VERSION = 'v2-ghl';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const set = (v) => ((process.env[v] || '').trim() ? 'ok' : 'MANGLER');
    return res.status(200).json({
      service: 'scaleconsulting lead endpoint',
      deployed_version: VERSION,
      env: {
        SLACK_WEBHOOK_URL: set('SLACK_WEBHOOK_URL'),
        GENRISE_WEBHOOK_URL: set('GENRISE_WEBHOOK_URL'),
        GENRISE_API_KEY: set('GENRISE_API_KEY'),
        GHL_API_TOKEN: set('GHL_API_TOKEN'),
        GHL_LOCATION_ID: (process.env.GHL_LOCATION_ID || '').trim() || 'MANGLER',
      },
    });
  }

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

  // ---------- GoHighLevel ----------
  if (ghlConfigured()) {
    const en = (d.sprog || (source === 'Growth analysis' ? 'en' : 'da')) === 'en';
    const lines = [];
    if (udfordringer) lines.push(udfordringer);
    const info = [
      ['Webshop', website],
      ['Platform', platform],
      ['Rejse', rejse],
      ['Omsætning', omsaetning],
      ['Annonceforbrug', spend],
      ['Hørt om os via', kilde],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    if (info.length) lines.push(info.join('\n'));
    if (en) lines.push('Udfyldt på engelsk.');

    tasks.push(
      sendLeadToGHL({
        brand: 'Scale',
        name: navn,
        email,
        phone: telefon,
        company: virksomhed,
        website,
        message: lines.join('\n\n'),
        source: en ? 'scaleconsulting.dk/en/kontakt' : 'scaleconsulting.dk/kontakt',
      })
        .then(() => ({ target: 'ghl', ok: true, status: 200 }))
        .catch((err) => {
          // GHL må aldrig få formularen til at fejle; fejlen logges i Vercel.
          console.error('GHL sync fejlede', err);
          return { target: 'ghl', ok: false, status: err.status || 0 };
        })
    );
  }

  if (!tasks.length) {
    return res.status(500).json({ error: 'Ingen destination konfigureret' });
  }

  const results = await Promise.all(tasks);

  results
    .filter((r) => !r.ok)
    .forEach((r) => console.error(`Lead-levering fejlede: ${r.target} (status ${r.status})`));

  // Succes hvis mindst én destination tog imod — så nedbrud ét sted aldrig taber leadet
  if (!results.some((r) => r.ok)) {
    return res.status(502).json({ error: 'Alle destinationer fejlede' });
  }

  return res.status(200).json({ ok: true });
}
