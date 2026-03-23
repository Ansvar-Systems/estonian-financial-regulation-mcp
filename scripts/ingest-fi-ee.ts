/**
 * Finantsinspektsioon Ingestion Crawler
 *
 * Scrapes the Estonian Financial Supervision Authority (Finantsinspektsioon)
 * website (fi.ee) and populates the SQLite database with:
 *   1. Juhendid (guidelines) — binding and advisory guidelines across sectors:
 *      banking & credit, insurance, payment services, investment
 *   2. Soovituslikud juhendid (recommendations) — non-binding recommendations
 *      adopting EBA/EIOPA/ESMA guidelines as Finantsinspektsioon guidance
 *   3. Ringkirjad / märgukirjad (circulars / notices) — supervisory notices
 *      on DORA, MiCA, AML, and other regulatory topics
 *   4. Enforcement actions (ettekirjutused / trahvid) — precepts, fines,
 *      licence revocations, and bans published on the fi.ee news feed
 *
 * The fi.ee website is Drupal-based. Guidelines are listed on category
 * pages under /et/juhendid/{sector}. Each guideline links to a detail
 * page with the full text, or to a PDF under /sites/default/files/.
 * Enforcement actions appear as news items under /et/uudised filtered
 * by keywords (ettekirjutus, trahv, tegevusluba).
 *
 * All content is in Estonian, as issued by the Finantsinspektsioon.
 *
 * Usage:
 *   npx tsx scripts/ingest-fi-ee.ts                  # full crawl
 *   npx tsx scripts/ingest-fi-ee.ts --resume          # resume from checkpoint
 *   npx tsx scripts/ingest-fi-ee.ts --dry-run         # log without inserting
 *   npx tsx scripts/ingest-fi-ee.ts --force           # drop and recreate DB
 *   npx tsx scripts/ingest-fi-ee.ts --enforcement-only # only crawl enforcement
 *   npx tsx scripts/ingest-fi-ee.ts --docs-only        # only crawl guidelines
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["EFSA_DB_PATH"] ?? "data/efsa.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.fi.ee";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const FETCH_TIMEOUT_MS = 30_000;

// Browser-like UA — institutional sites sometimes block bot-like agents
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const enforcementOnly = args.includes("--enforcement-only");
const docsOnly = args.includes("--docs-only");

// ---------------------------------------------------------------------------
// Guideline listing pages — one per sector
// ---------------------------------------------------------------------------

/** fi.ee guideline category pages. */
const GUIDELINE_LISTING_PAGES: Array<{
  sourcebookId: string;
  url: string;
  label: string;
}> = [
  {
    sourcebookId: "FI_JUHENDID",
    url: `${BASE_URL}/et/juhendid/pangandus-ja-krediit`,
    label: "Pangandus ja krediit (Banking & Credit)",
  },
  {
    sourcebookId: "FI_JUHENDID",
    url: `${BASE_URL}/et/juhendid/kindlustus`,
    label: "Kindlustus (Insurance)",
  },
  {
    sourcebookId: "FI_JUHENDID",
    url: `${BASE_URL}/et/juhendid/makseteenused`,
    label: "Makseteenused (Payment Services)",
  },
  {
    sourcebookId: "FI_SOOVITUSLIKUD_JUHENDID",
    url: `${BASE_URL}/et/juhendid`,
    label: "Juhendid ja märgukirjad (All Guidelines & Notices)",
  },
];

/** AML-specific guideline pages. */
const AML_PAGES: Array<{ url: string; label: string }> = [
  {
    url: `${BASE_URL}/et/teema/rahapesu-tokestamise-juhendid`,
    label: "Rahapesu tõkestamise juhendid (AML Guidelines)",
  },
];

/** News listing page — enforcement actions appear here. */
const NEWS_BASE = `${BASE_URL}/et/uudised`;
const NEWS_MAX_PAGES = 30; // safety cap

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface EnforcementRow {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

interface DiscoveredDoc {
  sourcebookId: string;
  title: string;
  url: string;
  /** Slug or unique identifier derived from the URL */
  docId: string;
  type: string;
}

interface Progress {
  completed_doc_urls: string[];
  completed_enforcement_urls: string[];
  enforcement_last_page: number;
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "et-EE,et;q=0.9,en;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  [katse ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchHtml(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  return resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const p = JSON.parse(raw) as Progress;
      console.log(
        `Edenemine laaditud (${p.last_updated}): ` +
          `${p.completed_doc_urls.length} dokumenti, ` +
          `${p.completed_enforcement_urls.length} ettekirjutust, ` +
          `viimane uudisteleht: ${p.enforcement_last_page}`,
      );
      return p;
    } catch {
      console.warn(
        "Edenemise faili ei saanud lugeda, alustan algusest",
      );
    }
  }
  return {
    completed_doc_urls: [],
    completed_enforcement_urls: [],
    enforcement_last_page: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Olemasolev andmebaas kustutatud: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Andmebaas alustatud: ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Sourcebook definitions
// ---------------------------------------------------------------------------

interface SourcebookDef {
  id: string;
  name: string;
  description: string;
}

const SOURCEBOOKS: SourcebookDef[] = [
  {
    id: "FI_JUHENDID",
    name: "FI Juhendid (Guidelines)",
    description:
      "Finantsinspektsiooni siduvad juhendid, mis kehtestavad üksikasjalikud nõuded järelevalve all olevatele ettevõtetele Eestis. Hõlmab panganduse, kindlustuse, makseteenuste ja investeerimisvaldkonna juhendeid.",
  },
  {
    id: "FI_SOOVITUSLIKUD_JUHENDID",
    name: "FI Soovituslikud Juhendid (Recommendations)",
    description:
      "Finantsinspektsiooni mittesiduvad soovituslikud juhendid, mis annavad suuniseid finantsturuosalistele parimate tavade kohta. Hõlmab EBA, EIOPA ja ESMA suuniste ülevõtmist Finantsinspektsiooni soovituslikena juhenditena.",
  },
  {
    id: "FI_RINGKIRJAD",
    name: "FI Ringkirjad (Circulars)",
    description:
      "Finantsinspektsiooni ringkirjad ja märgukirjad, mis annavad tõlgendavaid suuniseid ja järelevalveootusi turuosalistele. Hõlmab DORA, MiCA, rahapesu tõkestamise ja muid regulatiivseid teateid.",
  },
];

// ---------------------------------------------------------------------------
// Estonian month names for date parsing
// ---------------------------------------------------------------------------

const ESTONIAN_MONTHS: Record<string, string> = {
  jaanuar: "01",
  veebruar: "02",
  märts: "03",
  aprill: "04",
  mai: "05",
  juuni: "06",
  juuli: "07",
  august: "08",
  september: "09",
  oktoober: "10",
  november: "11",
  detsember: "12",
};

/**
 * Parse an Estonian date string into YYYY-MM-DD.
 * Handles formats like "15. märts 2024", "15.03.2024", "2024-03-15".
 */
function parseEstonianDate(text: string): string | null {
  // ISO format
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // DD.MM.YYYY
  const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    return `${dotMatch[3]}-${dotMatch[2]!.padStart(2, "0")}-${dotMatch[1]!.padStart(2, "0")}`;
  }

  // DD. month YYYY (Estonian)
  const namedMatch = text.match(
    /(\d{1,2})\.\s*(\w+)\s+(\d{4})/i,
  );
  if (namedMatch) {
    const monthNum = ESTONIAN_MONTHS[namedMatch[2]!.toLowerCase()];
    if (monthNum) {
      return `${namedMatch[3]}-${monthNum}-${namedMatch[1]!.padStart(2, "0")}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 1. Discover guidelines from listing pages
// ---------------------------------------------------------------------------

/**
 * Determine provision type from sourcebook ID.
 */
function typeForSourcebook(sourcebookId: string): string {
  switch (sourcebookId) {
    case "FI_JUHENDID":
      return "guideline";
    case "FI_SOOVITUSLIKUD_JUHENDID":
      return "recommendation";
    case "FI_RINGKIRJAD":
      return "circular";
    default:
      return "guideline";
  }
}

/**
 * Scrape a guideline listing page and return discovered document links.
 * fi.ee listing pages use Drupal's view system. Each guideline entry
 * is typically a link within a list item or a views-row div.
 */
async function discoverGuidelines(
  sourcebookId: string,
  listingUrl: string,
  label: string,
): Promise<DiscoveredDoc[]> {
  console.log(`\n--- ${label}: dokumentide avastamine ---`);
  console.log(`  URL: ${listingUrl}`);

  const html = await fetchHtml(listingUrl);
  const $ = cheerio.load(html);

  const docs: DiscoveredDoc[] = [];
  const seen = new Set<string>();

  // Pattern 1: links to guideline detail pages under /et/juhendid/
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href}`;

    // Only follow links to fi.ee guideline detail pages
    if (!fullUrl.startsWith(`${BASE_URL}/et/juhendid/`)) return;
    // Skip the listing page itself
    if (fullUrl === listingUrl || fullUrl === `${listingUrl}/`) return;
    // Must be a detail page (has a path deeper than the listing category)
    const pathParts = new URL(fullUrl).pathname.split("/").filter(Boolean);
    if (pathParts.length < 4) return; // /et/juhendid/{sector}/{slug}

    const slug = pathParts[pathParts.length - 1] ?? fullUrl;
    if (seen.has(slug)) return;

    const title = $(el).text().trim();
    if (title.length < 5) return;

    // Skip navigation and footer links
    const parent = $(el).closest(
      "nav, footer, .breadcrumb, .menu, header, .block-menu",
    );
    if (parent.length > 0) return;

    seen.add(slug);
    docs.push({
      sourcebookId,
      title,
      url: fullUrl,
      docId: slug,
      type: typeForSourcebook(sourcebookId),
    });
  });

  // Pattern 2: PDF download links from /sites/default/files/
  $('a[href*="/sites/default/files/"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (!href.endsWith(".pdf")) return;

    const fullUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href}`;

    // Extract filename as docId
    const filename = fullUrl.split("/").pop() ?? fullUrl;
    const docId = decodeURIComponent(filename).replace(/\.pdf$/, "");
    if (seen.has(docId)) return;
    seen.add(docId);

    const title = $(el).text().trim() || docId;

    // Skip navigation links
    const parent = $(el).closest(
      "nav, footer, .breadcrumb, .menu, header",
    );
    if (parent.length > 0) return;

    docs.push({
      sourcebookId,
      title,
      url: fullUrl,
      docId,
      type: typeForSourcebook(sourcebookId),
    });
  });

  console.log(`  ${docs.length} dokumenti avastatud`);
  return docs;
}

/**
 * Discover AML-specific guidelines from the dedicated AML topic page.
 */
async function discoverAmlGuidelines(): Promise<DiscoveredDoc[]> {
  console.log("\n--- Rahapesu tõkestamise juhendid (AML): avastamine ---");

  const docs: DiscoveredDoc[] = [];
  const seen = new Set<string>();

  for (const page of AML_PAGES) {
    try {
      const html = await fetchHtml(page.url);
      const $ = cheerio.load(html);

      // Links to guideline pages
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const fullUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href}`;

        if (!fullUrl.startsWith(BASE_URL)) return;

        const title = $(el).text().trim();
        if (title.length < 10) return;

        // Skip navigation
        const parent = $(el).closest(
          "nav, footer, .breadcrumb, .menu, header, .block-menu",
        );
        if (parent.length > 0) return;

        // Only relevant links
        const isRelevant =
          /juhend|soovitus|suunis|rahapesu|aml|terrorist|ringkiri/i.test(
            title,
          ) ||
          /juhend|rahapesu|aml/i.test(fullUrl);
        if (!isRelevant) return;

        const slug =
          fullUrl
            .replace(/\/$/, "")
            .split("/")
            .pop() ?? fullUrl;
        if (seen.has(slug)) return;
        seen.add(slug);

        docs.push({
          sourcebookId: "FI_RINGKIRJAD",
          title,
          url: fullUrl,
          docId: slug,
          type: "circular",
        });
      });

      // PDF links
      $('a[href*=".pdf"]').each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        const fullUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href}`;
        const filename = fullUrl.split("/").pop() ?? fullUrl;
        const docId = decodeURIComponent(filename).replace(/\.pdf$/, "");
        if (seen.has(docId)) return;
        seen.add(docId);

        const title = $(el).text().trim() || docId;
        docs.push({
          sourcebookId: "FI_RINGKIRJAD",
          title,
          url: fullUrl,
          docId,
          type: "circular",
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  AML-leht vahele jaetud (${page.url}): ${msg}`);
    }
  }

  console.log(`  ${docs.length} AML-dokumenti avastatud`);
  return docs;
}

// ---------------------------------------------------------------------------
// 2. Crawl individual guideline pages
// ---------------------------------------------------------------------------

/**
 * Build a reference string from a discovered document.
 */
function buildReference(doc: DiscoveredDoc, sectionIndex: number): string {
  const prefix =
    doc.sourcebookId === "FI_JUHENDID"
      ? "FI_J"
      : doc.sourcebookId === "FI_SOOVITUSLIKUD_JUHENDID"
        ? "FI_SJ"
        : "FI_R";
  const base = `${prefix}_${doc.docId}`;
  return sectionIndex > 0 ? `${base}_osa_${sectionIndex}` : base;
}

/**
 * Crawl a single guideline detail page and return provision rows.
 * For HTML pages, extract main content and split by headings.
 * For PDFs, store metadata.
 */
async function crawlGuideline(doc: DiscoveredDoc): Promise<ProvisionRow[]> {
  const provisions: ProvisionRow[] = [];

  try {
    const resp = await rateLimitedFetch(doc.url);
    const contentType = resp.headers.get("content-type") ?? "";

    if (contentType.includes("application/pdf")) {
      // PDF binary — store metadata (title from listing page)
      provisions.push({
        sourcebook_id: doc.sourcebookId,
        reference: buildReference(doc, 0),
        title: doc.title,
        text: `[PDF-dokument] ${doc.title}. Allikas: ${doc.url}`,
        type: doc.type,
        status: "in_force",
        effective_date: null,
        chapter: null,
        section: null,
      });
      return provisions;
    }

    // HTML content — parse with cheerio
    const html = await resp.text();
    const $ = cheerio.load(html);

    // Remove non-content elements
    $(
      "nav, header, footer, .sidebar, script, style, .menu, .breadcrumb, " +
        ".block-menu, .tabs, .contextual-links, .field--name-field-tags",
    ).remove();

    // Extract effective date from page
    let effectiveDate: string | null = null;
    const bodyText = $("body").text();

    // Drupal date fields: "Kehtib alates", "Joustunud", "Kinnitatud"
    const datePatterns = [
      /(?:Kehtib\s+alates|Jõustunud|Kinnitatud|Avaldatud|Kuupäev)[:\s]*(\d{1,2}\.\s*\w+\s+\d{4})/i,
      /(?:Kehtib\s+alates|Jõustunud|Kinnitatud|Avaldatud|Kuupäev)[:\s]*(\d{1,2}\.\d{1,2}\.\d{4})/i,
      /(\d{1,2}\.\d{1,2}\.\d{4})/,
    ];
    for (const pat of datePatterns) {
      const match = bodyText.match(pat);
      if (match) {
        effectiveDate = parseEstonianDate(match[1]!);
        if (effectiveDate) break;
      }
    }

    // Strategy 1: split by headings (h2, h3) into sections
    const headings = $("h2, h3");
    if (headings.length > 0) {
      let sectionIdx = 0;
      headings.each((_i, heading) => {
        const headingText = $(heading).text().trim();
        if (headingText.length < 3) return;

        // Collect sibling content until next heading
        let sectionText = "";
        let next = $(heading).next();
        while (next.length > 0 && !next.is("h2, h3")) {
          sectionText += next.text().trim() + "\n";
          next = next.next();
        }

        sectionText = sectionText.replace(/\s+/g, " ").trim();
        if (sectionText.length < 50) return;

        sectionIdx++;
        const chapterNum = String(sectionIdx);
        provisions.push({
          sourcebook_id: doc.sourcebookId,
          reference: buildReference(doc, sectionIdx),
          title: headingText,
          text: sectionText,
          type: doc.type,
          status: "in_force",
          effective_date: effectiveDate,
          chapter: chapterNum,
          section: `${chapterNum}.1`,
        });
      });
    }

    // Strategy 2: if no headings produced results, take full content
    if (provisions.length === 0) {
      const mainText =
        $("main").text().trim() ||
        $(".field--name-body").text().trim() ||
        $("article").text().trim() ||
        $(".node__content").text().trim() ||
        $("body").text().trim();

      const cleanText = mainText.replace(/\s+/g, " ").trim();
      if (cleanText.length > 100) {
        const pageTitle =
          $("h1").first().text().trim() || doc.title;
        provisions.push({
          sourcebook_id: doc.sourcebookId,
          reference: buildReference(doc, 0),
          title: pageTitle,
          text: cleanText.slice(0, 50_000), // cap at 50k chars
          type: doc.type,
          status: "in_force",
          effective_date: effectiveDate,
          chapter: null,
          section: null,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Viga dokumendi laadimisel ${doc.url}: ${msg}`);
  }

  return provisions;
}

// ---------------------------------------------------------------------------
// 3. Crawl enforcement actions (ettekirjutused / trahvid)
// ---------------------------------------------------------------------------

interface NewsListEntry {
  title: string;
  url: string;
  date: string | null;
}

/**
 * Keywords that identify enforcement-related news items in Estonian.
 */
const ENFORCEMENT_KEYWORDS =
  /ettekirjutus|trahv|trahvi|keeld|tegevusloa|tegevusluba|litsents|rikkum|sanktsioon|karistus|maksimumtrahv|hoiatus/i;

/**
 * Scrape one page of the news listing and return enforcement entries.
 * fi.ee news pages are at /et/uudised?page=N (Drupal pager, 0-indexed).
 */
async function scrapeNewsPage(
  pageNum: number,
): Promise<{ entries: NewsListEntry[]; hasNext: boolean }> {
  const url =
    pageNum <= 0
      ? NEWS_BASE
      : `${NEWS_BASE}?page=${pageNum}`;

  console.log(`  Uudisteleht ${pageNum}: ${url}`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const entries: NewsListEntry[] = [];

  // Drupal views: each news item is a .views-row or article
  $(".views-row, article, .node--type-news, .node-teaser").each((_i, el) => {
    const titleEl = $(el).find("h2 a, h3 a, .node__title a, .field--name-title a").first();
    let title = titleEl.text().trim();
    let href = titleEl.attr("href");

    // Fallback: any link in the element
    if (!title || !href) {
      const anyLink = $(el).find("a").first();
      title = anyLink.text().trim();
      href = anyLink.attr("href");
    }

    if (!title || !href) return;

    // Only enforcement-related news
    if (!ENFORCEMENT_KEYWORDS.test(title)) return;

    const fullUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href}`;

    // Extract date from the news item
    let date: string | null = null;
    const timeEl = $(el).find("time, .date, .field--name-created, .node__date").first();
    const datetime = timeEl.attr("datetime");
    if (datetime) {
      date = datetime.slice(0, 10);
    } else {
      const dateText = timeEl.text().trim() || $(el).text();
      const parsed = parseEstonianDate(dateText);
      if (parsed) {
        date = parsed;
      }
    }

    entries.push({ title, url: fullUrl, date });
  });

  // Fallback: scan all links on the page for enforcement-related headlines
  if (entries.length === 0) {
    const seenUrls = new Set<string>();
    $("a[href]").each((_i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href");
      if (!href || !text) return;
      if (text.length < 20) return;
      if (!ENFORCEMENT_KEYWORDS.test(text)) return;

      const fullUrl = href.startsWith("http")
        ? href
        : `${BASE_URL}${href}`;
      if (!fullUrl.startsWith(BASE_URL)) return;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      // Skip navigation
      const parent = $(el).closest(
        "nav, footer, .breadcrumb, .menu, header",
      );
      if (parent.length > 0) return;

      entries.push({ title: text, url: fullUrl, date: null });
    });
  }

  // Check if a next page exists (Drupal pager)
  const hasNext =
    $(`a[href*="page=${pageNum + 1}"]`).length > 0 ||
    $(".pager__item--next, .pager-next, li.next").length > 0;

  return { entries, hasNext };
}

/**
 * Parse a single enforcement-action news page and return a row.
 */
async function crawlEnforcementPage(
  entry: NewsListEntry,
): Promise<EnforcementRow | null> {
  try {
    const html = await fetchHtml(entry.url);
    const $ = cheerio.load(html);

    // Remove non-content
    $(
      "nav, header, footer, .sidebar, script, style, .menu, .breadcrumb, " +
        ".block-menu, .tabs, .contextual-links",
    ).remove();

    const bodyText =
      $(".field--name-body").text().trim() ||
      $(".node__content").text().trim() ||
      $("article").text().trim() ||
      $("main").text().trim();

    const summary = bodyText.replace(/\s+/g, " ").trim().slice(0, 10_000);
    if (summary.length < 50) return null;

    // Extract firm name from title
    // Patterns: "Finantsinspektsioon tegi X-ile ettekirjutuse"
    //           "Finantsinspektsioon trahvis X-i"
    //           "X sai Finantsinspektsioonilt trahvi"
    let firmName = "Teadmata";
    const firmPatterns = [
      // "tegi X-ile ettekirjutuse" / "tegi X-ile trahvi"
      /tegi\s+(.+?)(?:-ile|-le)\s+(?:ettekirjutuse|trahvi|maksimumtrahvi)/i,
      // "trahvis X-i" / "karistas X-i"
      /(?:trahvis|karistas)\s+(.+?)(?:-i|-t)\s/i,
      // "X sai trahvi" / "X sai ettekirjutuse"
      /^(.+?)\s+(?:sai|sai Finantsinspektsioonilt)/i,
      // English pattern: "fined X" / "issued a precept to X"
      /(?:fined|precept\s+to)\s+(.+?)(?:\s+for|\s+\d|$)/i,
      // Fallback: extract entity name (AS, OÜ patterns)
      /(?:AS|OÜ|SE)\s+[A-ZÄÖÜÕ][\w\s]+(?:AS|OÜ|SE|Pank|Bank|Finance|Liising|Fondid)/i,
    ];

    for (const pat of firmPatterns) {
      const match = entry.title.match(pat);
      if (match && match[1]) {
        firmName = match[1].trim();
        break;
      }
    }

    // If no pattern matched, try to find entity names in the title
    if (firmName === "Teadmata") {
      const entityMatch = entry.title.match(
        /(?:AS|OÜ)\s+[\wÄÖÜÕäöüõ][\w\s]*[\wÄÖÜÕäöüõ]/,
      );
      if (entityMatch) {
        firmName = entityMatch[0].trim();
      }
    }

    // Determine action type
    let actionType = "precept";
    const titleLower = entry.title.toLowerCase();
    if (/trahv|trahvis|maksimumtrahv|fine/i.test(titleLower)) {
      actionType = "fine";
    } else if (
      /tegevusloa\s*(?:tühist|kehtet|peatat)|tegevusluba\s*(?:tühist|kehtet|peatat)|keeld|ban|revok/i.test(
        titleLower,
      )
    ) {
      actionType = "ban";
    } else if (/hoiatus|warning/i.test(titleLower)) {
      actionType = "warning";
    }

    // Try to extract monetary amount
    let amount: number | null = null;
    const amountPatterns = [
      /(\d[\d\s]*\d)\s*(?:eurot|euro|EUR|€)/i,
      /(?:EUR|€)\s*(\d[\d\s]*\d)/i,
      /(\d{1,3}(?:\s?\d{3})*)\s*(?:eurot|euro|EUR|€)/i,
    ];
    for (const pat of amountPatterns) {
      const match = summary.match(pat) ?? entry.title.match(pat);
      if (match) {
        amount = parseFloat(
          match[1]!.replace(/\s/g, "").replace(",", "."),
        );
        break;
      }
    }

    // Extract date from the page if not from the listing
    let date = entry.date;
    if (!date) {
      const timeEl = $("time").first();
      const datetime = timeEl.attr("datetime");
      if (datetime) {
        date = datetime.slice(0, 10);
      } else {
        date = parseEstonianDate(summary.slice(0, 200));
      }
    }

    // Extract referenced laws from body text
    let sourcebookRefs: string | null = null;
    const lawRefs: string[] = [];
    const lawPatterns = [
      /(?:Krediidiasutuste\s+seadus|KAS)/g,
      /(?:Rahapesu\s+ja\s+terrorismi\s+rahastamise\s+tõkestamise\s+seadus|RahaPTS)/g,
      /(?:Kindlustustegevuse\s+seadus|KindlTS)/g,
      /(?:Väärtpaberituru\s+seadus|VPTS)/g,
      /(?:Makseasutuste\s+ja\s+e-raha\s+asutuste\s+seadus|MERAS)/g,
      /(?:Investeerimisfondide\s+seadus|IFS)/g,
      /(?:Tarbijakaitseseadus|TKS)/g,
      /(?:Finantsinspektsiooni\s+seadus|FIS)/g,
      /DORA|MiCA/g,
      /CRR|CRD/g,
    ];
    for (const pat of lawPatterns) {
      const matches = summary.match(pat);
      if (matches) {
        for (const m of matches) {
          if (!lawRefs.includes(m)) lawRefs.push(m);
        }
      }
    }
    if (lawRefs.length > 0) {
      sourcebookRefs = lawRefs.join(", ");
    }

    return {
      firm_name: firmName,
      reference_number: null,
      action_type: actionType,
      amount,
      date,
      summary,
      sourcebook_references: sourcebookRefs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Viga ettekirjutuse laadimisel ${entry.url}: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Database insertion helpers
// ---------------------------------------------------------------------------

function insertSourcebooks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (const sb of SOURCEBOOKS) {
      stmt.run(sb.id, sb.name, sb.description);
    }
  });
  tx();
  console.log(`${SOURCEBOOKS.length} allikaid sisestatud/uuendatud`);
}

function insertProvision(db: Database.Database, p: ProvisionRow): void {
  db.prepare(
    `INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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

function referenceExists(db: Database.Database, reference: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM provisions WHERE reference = ? LIMIT 1")
    .get(reference);
  return row !== undefined;
}

function insertEnforcement(db: Database.Database, e: EnforcementRow): void {
  db.prepare(
    `INSERT INTO enforcement_actions
       (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.firm_name,
    e.reference_number,
    e.action_type,
    e.amount,
    e.date,
    e.summary,
    e.sourcebook_references,
  );
}

function enforcementExists(
  db: Database.Database,
  firmName: string,
  date: string | null,
): boolean {
  if (date) {
    const row = db
      .prepare(
        "SELECT 1 FROM enforcement_actions WHERE firm_name = ? AND date = ? LIMIT 1",
      )
      .get(firmName, date);
    return row !== undefined;
  }
  const row = db
    .prepare(
      "SELECT 1 FROM enforcement_actions WHERE firm_name = ? LIMIT 1",
    )
    .get(firmName);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

interface Stats {
  docsDiscovered: number;
  docsSkipped: number;
  provisionsInserted: number;
  enforcementPagesScraped: number;
  enforcementInserted: number;
  enforcementSkipped: number;
  errors: number;
}

function newStats(): Stats {
  return {
    docsDiscovered: 0,
    docsSkipped: 0,
    provisionsInserted: 0,
    enforcementPagesScraped: 0,
    enforcementInserted: 0,
    enforcementSkipped: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Finantsinspektsiooni andmete laadimine ===");
  console.log(`  Andmebaas:     ${DB_PATH}`);
  console.log(`  Režiim:        ${dryRun ? "kuivkäivitus" : "toodang"}`);
  console.log(`  Jätka:         ${resume ? "jah" : "ei"}`);
  console.log(`  Sunni:         ${force ? "jah" : "ei"}`);
  console.log("");

  const db = dryRun ? null : initDatabase();
  if (db && !dryRun) {
    insertSourcebooks(db);
  }

  const progress = loadProgress();
  const stats = newStats();

  // ---- Phase 1: Guidelines (Juhendid, Soovituslikud juhendid, Ringkirjad) ----

  if (!enforcementOnly) {
    const allDocs: DiscoveredDoc[] = [];

    // Standard listing pages
    for (const listing of GUIDELINE_LISTING_PAGES) {
      try {
        const docs = await discoverGuidelines(
          listing.sourcebookId,
          listing.url,
          listing.label,
        );
        allDocs.push(...docs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  VIGA ${listing.label} puhul: ${msg}`);
        stats.errors++;
      }
    }

    // AML-specific pages
    try {
      const amlDocs = await discoverAmlGuidelines();
      allDocs.push(...amlDocs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  VIGA AML-juhendite puhul: ${msg}`);
      stats.errors++;
    }

    // Deduplicate by URL
    const deduped: DiscoveredDoc[] = [];
    const seenUrls = new Set<string>();
    for (const doc of allDocs) {
      if (!seenUrls.has(doc.url)) {
        seenUrls.add(doc.url);
        deduped.push(doc);
      }
    }

    stats.docsDiscovered = deduped.length;
    console.log(`\nAvastatud dokumente kokku: ${deduped.length}`);

    // Crawl each document
    for (let i = 0; i < deduped.length; i++) {
      const doc = deduped[i]!;

      // Skip if already processed (resume mode)
      if (resume && progress.completed_doc_urls.includes(doc.url)) {
        stats.docsSkipped++;
        continue;
      }

      console.log(
        `\n[${i + 1}/${deduped.length}] ${doc.title.slice(0, 80)}`,
      );
      console.log(`  URL: ${doc.url}`);

      const provisions = await crawlGuideline(doc);

      if (dryRun) {
        console.log(`  -> ${provisions.length} sätet (kuivkäivitus)`);
        for (const p of provisions) {
          console.log(
            `     ${p.reference}: ${(p.title ?? "").slice(0, 60)} (${p.text.length} tähemärki)`,
          );
        }
      } else if (db) {
        let inserted = 0;
        for (const p of provisions) {
          if (!referenceExists(db, p.reference)) {
            insertProvision(db, p);
            inserted++;
          }
        }
        stats.provisionsInserted += inserted;
        console.log(
          `  -> ${inserted} sätet sisestatud (${provisions.length} leitud)`,
        );
      }

      // Update progress
      progress.completed_doc_urls.push(doc.url);
      if (!dryRun) {
        saveProgress(progress);
      }
    }
  }

  // ---- Phase 2: Enforcement actions (Ettekirjutused / Trahvid) ----

  if (!docsOnly) {
    console.log("\n\n=== Ettekirjutused ja trahvid ===");

    const startPage = resume
      ? Math.max(progress.enforcement_last_page, 0)
      : 0;

    for (let page = startPage; page <= NEWS_MAX_PAGES; page++) {
      let result: { entries: NewsListEntry[]; hasNext: boolean };
      try {
        result = await scrapeNewsPage(page);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  VIGA leheküljel ${page}: ${msg}`);
        stats.errors++;
        break;
      }

      stats.enforcementPagesScraped++;
      console.log(
        `  Lehekülg ${page}: ${result.entries.length} kirjet leitud`,
      );

      for (const entry of result.entries) {
        // Skip if already processed
        if (
          resume &&
          progress.completed_enforcement_urls.includes(entry.url)
        ) {
          stats.enforcementSkipped++;
          continue;
        }

        console.log(`    -> ${entry.title.slice(0, 80)}`);

        const row = await crawlEnforcementPage(entry);
        if (!row) {
          stats.errors++;
          continue;
        }

        if (dryRun) {
          console.log(
            `       ${row.firm_name} | ${row.action_type} | ${row.amount ?? "-"} EUR | ${row.date ?? "kuupäev puudub"}`,
          );
        } else if (db) {
          if (!enforcementExists(db, row.firm_name, row.date)) {
            insertEnforcement(db, row);
            stats.enforcementInserted++;
          } else {
            stats.enforcementSkipped++;
          }
        }

        progress.completed_enforcement_urls.push(entry.url);
      }

      progress.enforcement_last_page = page;
      if (!dryRun) {
        saveProgress(progress);
      }

      if (!result.hasNext) {
        console.log(
          `  Rohkem uudistelehti pärast lehekülge ${page} ei ole`,
        );
        break;
      }
    }
  }

  // ---- Summary ----

  console.log("\n\n=== Kokkuvõte ===");
  console.log(`  Dokumente avastatud:       ${stats.docsDiscovered}`);
  console.log(`  Dokumente vahele jäetud:   ${stats.docsSkipped}`);
  console.log(`  Sätteid sisestatud:        ${stats.provisionsInserted}`);
  console.log(`  Uudistelehti kraabitud:    ${stats.enforcementPagesScraped}`);
  console.log(`  Ettekirjutusi sisestatud:  ${stats.enforcementInserted}`);
  console.log(`  Ettekirjutusi vahele:      ${stats.enforcementSkipped}`);
  console.log(`  Vigu:                      ${stats.errors}`);

  if (!dryRun && db) {
    const provCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sbCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
        cnt: number;
      }
    ).cnt;
    const enfCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\nAndmebaasi kokkuvõte:");
    console.log(`  Allikaid:            ${sbCount}`);
    console.log(`  Sätteid:             ${provCount}`);
    console.log(`  Ettekirjutusi:       ${enfCount}`);
    console.log(`  FTS-kirjeid:         ${ftsCount}`);

    db.close();
  }

  console.log(`\nValmis. Edenemine salvestatud: ${PROGRESS_FILE}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Kriitiline viga:", err);
  process.exit(1);
});
