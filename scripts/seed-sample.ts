/**
 * Seed the Finantsinspektsioon database with sample provisions for testing.
 *
 * Inserts representative provisions from EFSA guidelines, recommendations,
 * and circulars so MCP tools can be tested without running a full crawl.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["EFSA_DB_PATH"] ?? "data/efsa.db";
const force = process.argv.includes("--force");

// -- Bootstrap database --

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// -- Sourcebooks --

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "FI_JUHENDID",
    name: "FI Juhendid (Guidelines)",
    description:
      "Finantsinspektsioon binding guidelines setting out detailed requirements for supervised entities in Estonia.",
  },
  {
    id: "FI_SOOVITUSLIKUD_JUHENDID",
    name: "FI Soovituslikud Juhendid (Recommendations)",
    description:
      "Non-binding recommendations issued by Finantsinspektsioon on best practices for financial market participants.",
  },
  {
    id: "FI_RINGKIRJAD",
    name: "FI Ringkirjad (Circulars)",
    description:
      "EFSA circulars providing interpretive guidance and supervisory expectations to market participants.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// -- Sample provisions --

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // -- FI_JUHENDID — Binding Guidelines --
  {
    sourcebook_id: "FI_JUHENDID",
    reference: "FI_J_2021_01",
    title: "IT-riskide juhtimise juhend (IT Risk Management Guideline)",
    text: "Krediidiasutused ja investeerimisühingud peavad kehtestama IT-riskide juhtimise raamistiku, mis hõlmab IT-süsteemide turvalisust, andmete terviklust ja talitluspidevust. Juhend kohustab laiaulatuslikku riskihindamist vähemalt kord aastas ning intsidentide lahendamise protseduuride olemasolu.",
    type: "guideline",
    status: "in_force",
    effective_date: "2021-04-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "FI_JUHENDID",
    reference: "FI_J_2021_02",
    title: "IT-riskide juhtimise juhend — andmehalduse nõuded",
    text: "Finantsinstitutsioonid peavad tagama andmekaitse ja küberturvalisuse meetmete rakendamise vastavalt EBA suunistele IKT ja turvariskide juhtimise kohta. Andmete varundamine, krüptimine ja juurdepääsukontroll peavad vastama kehtivatele tehnilistele standarditele.",
    type: "guideline",
    status: "in_force",
    effective_date: "2021-04-01",
    chapter: "1",
    section: "1.2",
  },
  {
    sourcebook_id: "FI_JUHENDID",
    reference: "FI_J_2022_03",
    title: "Rahapesu ja terrorismi rahastamise tõkestamise juhend (AML/CFT Guideline)",
    text: "Kõik Finantsinspektsiooniga järelevalve all olevad ettevõtted peavad rakendama rahapesu ja terrorismi rahastamise tõkestamise meetmeid vastavalt Rahapesu ja Terrorismi Rahastamise Tõkestamise Seaduse nõuetele. Juhend täpsustab kliendi hoolsuskohustuse, tehingute jälgimise ja kahtlastest tehingutest teavitamise nõudeid.",
    type: "guideline",
    status: "in_force",
    effective_date: "2022-01-01",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "FI_JUHENDID",
    reference: "FI_J_2023_04",
    title: "Juhtimis- ja haldusstruktuuri juhend (Corporate Governance Guideline)",
    text: "Krediidiasutused peavad tagama tugeva juhtimisstruktuuri, mis hõlmab selgelt määratletud vastutuse jaotust, piisavalt mitmekesist juhatust ning tõhusat siseriskikontrolli. Nõukogu liikmed peavad olema piisava pädevuse ja sobivusega vastavalt EBA suunistele juhtimis- ja haldusstruktuuri kohta.",
    type: "guideline",
    status: "in_force",
    effective_date: "2023-07-01",
    chapter: "3",
    section: "3.1",
  },
  // -- FI_SOOVITUSLIKUD_JUHENDID — Recommendations --
  {
    sourcebook_id: "FI_SOOVITUSLIKUD_JUHENDID",
    reference: "FI_SJ_2020_01",
    title: "Soovitus küberjulgeoleku meetmete rakendamiseks",
    text: "Finantsinspektsioon soovitab finantsteenuste osutajatel rakendada mitmekihilise küberturvalisuse raamistiku, mis hõlmab regulaarset haavatavuse testimist, intsidentidele reageerimise plaane ja töötajate küberjulgeoleku koolitust vähemalt kord aastas.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2020-03-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "FI_SOOVITUSLIKUD_JUHENDID",
    reference: "FI_SJ_2022_02",
    title: "Soovitus keskkonna-, sotsiaal- ja juhtimisriskide (ESG) hindamiseks",
    text: "Finantsinspektsioon soovitab krediidiasutustel ja fondivalitsejatel integreerida ESG-riskid oma riskijuhtimise raamistikesse ning avalikustada ESG-faktorite mõju oma investeerimis- ja laenuotsustele vastavalt SFDR ja taksonoomia määruse nõuetele.",
    type: "recommendation",
    status: "in_force",
    effective_date: "2022-06-01",
    chapter: "2",
    section: "2.1",
  },
  // -- FI_RINGKIRJAD — Circulars --
  {
    sourcebook_id: "FI_RINGKIRJAD",
    reference: "FI_R_2023_01",
    title: "Ringkiri DORA rakendamise kohta",
    text: "Käesolev ringkiri teavitab finantssektori ettevõtteid DORA (Digitaalse tegevuskerksuse seadus, EL 2022/2554) rakendamise nõuetest. DORA kohustab IKT riskijuhtimise raamistiku kehtestamist, kriitiliste IKT-teenuse osutajate haldamist ja digitaalse tegevuskerksuse testimist. Kohaldatav alates 17. jaanuarist 2025.",
    type: "circular",
    status: "in_force",
    effective_date: "2023-10-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "FI_RINGKIRJAD",
    reference: "FI_R_2023_02",
    title: "Ringkiri MiCA rakendamise kohta krüptovarateenuse osutajatele",
    text: "Finantsinspektsioon teavitab, et alates 30. detsembrist 2024 peavad kõik krüptovarateenuse osutajad vastama Krüptovaraturgude määruse (MiCA, EL 2023/1114) nõuetele. Ringkiri selgitab tegevusloa taotlemise protsessi, usaldatavusnõudeid ja tarbijakaitse kohustusi.",
    type: "circular",
    status: "in_force",
    effective_date: "2023-11-15",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "FI_RINGKIRJAD",
    reference: "FI_R_2024_01",
    title: "Ringkiri operatsiooniriski juhtimise nõuete kohta",
    text: "Krediidiasutused ja investeerimisühingud peavad tagama operatsiooniriski juhtimise raamistiku vastavuse CRR/CRD nõuetele ning EBA operatsiooniriski suunistele. Ringkiri rõhutab sisemise kapitali adekvaatsuse hindamise protsessi (ICAAP) ja stressitestide tähtsust.",
    type: "circular",
    status: "in_force",
    effective_date: "2024-01-15",
    chapter: "3",
    section: "3.1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// -- Sample enforcement actions --

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "AS LHV Pank",
    reference_number: "4.1-1/2023-001",
    action_type: "warning",
    amount: 0,
    date: "2023-03-15",
    summary:
      "Finantsinspektsioon andis AS LHV Pangale ettekirjutuse seoses puudustega rahapesu tõkestamise siseprotseduurides. Pank ei taganud piisavat tehingute jälgimist kõrge riskiga klientide puhul. Pank täiendas protsesse ja süsteeme ettekirjutuse täitmiseks.",
    sourcebook_references: "FI_J_2022_03",
  },
  {
    firm_name: "Aforti Finance OÜ",
    reference_number: "4.1-1/2022-015",
    action_type: "ban",
    amount: 0,
    date: "2022-09-28",
    summary:
      "Finantsinspektsioon peatas Aforti Finance OÜ tegevusloa seoses raskete rikkumistega, mis hõlmasid klientide varade ebaõiget käitlemist ja ebapiisavat kapitali. Ettevõttele keelati uute tehingute tegemine ning alustati tegevusloa tühistamise menetlust.",
    sourcebook_references: "FI_J_2021_01, FI_J_2023_04",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// -- Summary --

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
