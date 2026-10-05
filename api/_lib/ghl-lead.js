/**
 * Sender et lead fra hjemmesidens formular ind i GoHighLevel (API v2).
 * Miljøvariabler: GHL_API_TOKEN, GHL_LOCATION_ID
 *
 * Ren JavaScript uden afhængigheder, så den samme fil kan bruges i både
 * Northpeak- og Scale-repoet. Ligger i api/_lib/, fordi filer med "_" i
 * api/ hverken bliver til endpoints eller serveres som statiske filer.
 *
 * @typedef {"Genrise" | "Northpeak" | "Scale"} Brand
 * @typedef {Object} Lead
 * @property {Brand} brand
 * @property {string} [name]
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [company]
 * @property {string} [website]
 * @property {string} [message]
 * @property {string} [source]  Hvilken side/formular leadet kom fra
 */

const API = "https://services.leadconnectorhq.com";
const PIPELINE_NAME = "Sales Pipeline";
const STAGE_NAME = "Klar til kald";
const BRAND_FIELD_KEY = "contact.brand";
const TIMEOUT_MS = 8000;

/** @type {Record<Brand, string>} */
const TAGS = {
  Genrise: "brand-genrise",
  Northpeak: "brand-northpeak",
  Scale: "brand-scale",
};

function env(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Mangler miljøvariabel ${name}`);
  return v;
}

export function ghlConfigured() {
  return Boolean((process.env.GHL_API_TOKEN || "").trim() && (process.env.GHL_LOCATION_ID || "").trim());
}

async function ghl(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("GHL_API_TOKEN")}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`GHL ${init.method || "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Slås op ved navn og caches i serverless-instansens levetid.
let cache = null;

async function lookupIds() {
  if (cache) return cache;
  const loc = env("GHL_LOCATION_ID");

  const { customFields } = await ghl(`/locations/${loc}/customFields?model=contact`);
  const brandField = (customFields || []).find((f) => f.fieldKey === BRAND_FIELD_KEY);
  if (!brandField) throw new Error(`Feltet ${BRAND_FIELD_KEY} findes ikke i GHL`);

  const { pipelines } = await ghl(`/opportunities/pipelines?locationId=${loc}`);
  const pipeline = (pipelines || []).find((p) => p.name === PIPELINE_NAME);
  if (!pipeline) throw new Error(`Pipelinen "${PIPELINE_NAME}" findes ikke i GHL`);
  const stage = (pipeline.stages || []).find((s) => s.name === STAGE_NAME);
  if (!stage) throw new Error(`Fasen "${STAGE_NAME}" findes ikke i "${PIPELINE_NAME}"`);

  cache = { brandFieldId: brandField.id, pipelineId: pipeline.id, stageId: stage.id };
  return cache;
}

/**
 * GHL afviser telefonnumre, den ikke kan parse. Danske 8-cifrede numre
 * får +45; "00"-præfiks bliver til "+". Alt andet sendes som det er.
 */
function normalizePhone(raw) {
  if (!raw) return undefined;
  let p = String(raw).replace(/[\s\-().]/g, "");
  if (p.startsWith("00")) p = `+${p.slice(2)}`;
  if (/^\d{8}$/.test(p)) p = `+45${p}`;
  return p || undefined;
}

/**
 * @param {Lead} lead
 * @returns {Promise<{contactId: string, opportunityId?: string, createdOpportunity: boolean}>}
 */
export async function sendLeadToGHL(lead) {
  if (!TAGS[lead.brand]) throw new Error(`Ukendt brand: ${lead.brand}`);
  if (!lead.email && !lead.phone) throw new Error("Lead skal have e-mail eller telefon");
  const loc = env("GHL_LOCATION_ID");
  const ids = await lookupIds();

  const [firstName, ...rest] = (lead.name || "").trim().split(/\s+/);
  const source = lead.source || `Hjemmeside (${lead.brand})`;
  const phone = normalizePhone(lead.phone);

  const contactBody = {
    locationId: loc,
    firstName: firstName || undefined,
    lastName: rest.join(" ") || undefined,
    email: lead.email || undefined,
    phone,
    companyName: lead.company || undefined,
    website: lead.website || undefined,
    source,
    customFields: [{ id: ids.brandFieldId, field_value: lead.brand }],
  };

  // 1. Opret eller opdater kontakten. Afviser GHL telefonnummeret, prøves
  //    igen uden, så leadet ikke går tabt (nummeret står stadig i noten).
  let contact;
  try {
    ({ contact } = await ghl(`/contacts/upsert`, { method: "POST", body: JSON.stringify(contactBody) }));
  } catch (err) {
    if (!(phone && lead.email && (err.status === 400 || err.status === 422))) throw err;
    console.warn("GHL afviste kontakten med telefon, prøver uden", err.message);
    ({ contact } = await ghl(`/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify({ ...contactBody, phone: undefined }),
    }));
  }

  // 2. Brand-tag. Tilføjes separat, så eksisterende tags (fx brand-genrise)
  //    på en kendt kontakt ikke bliver overskrevet af upserten.
  await ghl(`/contacts/${contact.id}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: [TAGS[lead.brand]] }),
  });

  // 3. Beskeden som note
  if (lead.message && lead.message.trim()) {
    await ghl(`/contacts/${contact.id}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: `Besked via ${source}:\n\n${lead.message.trim()}` }),
    });
  }

  // 4. Opportunity i pipelinen, medmindre der allerede er en åben
  const existing = await ghl(
    `/opportunities/search?location_id=${loc}&contact_id=${contact.id}&pipeline_id=${ids.pipelineId}&status=open`
  );
  if (existing.opportunities && existing.opportunities.length) {
    return { contactId: contact.id, opportunityId: existing.opportunities[0].id, createdOpportunity: false };
  }

  const displayName = lead.company || lead.name || lead.email || lead.phone || "Nyt lead";
  const { opportunity } = await ghl(`/opportunities/`, {
    method: "POST",
    body: JSON.stringify({
      locationId: loc,
      pipelineId: ids.pipelineId,
      pipelineStageId: ids.stageId,
      contactId: contact.id,
      name: `${displayName} (${lead.brand})`,
      status: "open",
      source,
    }),
  });

  return { contactId: contact.id, opportunityId: opportunity.id, createdOpportunity: true };
}
