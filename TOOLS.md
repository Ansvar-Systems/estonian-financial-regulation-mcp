# Tool Reference

All tools exposed by the Estonian Financial Regulation MCP server. Tool prefix: `ee_fin_`.

---

## ee_fin_search_regulations

Full-text search across Finantsinspektsioon (EFSA) regulatory provisions. Returns matching guidelines, recommendations, and circulars on financial services regulation in Estonia.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Estonian or English (e.g., `IT riskijuhtimine`, `AML nõuded`, `corporate governance`) |
| `sourcebook` | string | No | Filter by sourcebook ID (e.g., `FI_Juhendid`, `FI_Soovituslikud_Juhendid`, `FI_Ringkirjad`) |
| `status` | enum | No | Filter by provision status: `in_force`, `deleted`, or `not_yet_in_force` |
| `limit` | number | No | Maximum number of results to return. Defaults to 20, max 100. |

**Returns** `{ results: Provision[], count: number, _meta: Meta }`

---

## ee_fin_get_regulation

Get a specific Finantsinspektsioon provision by sourcebook and reference.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourcebook` | string | Yes | Sourcebook identifier (e.g., `FI_Juhendid`, `FI_Ringkirjad`) |
| `reference` | string | Yes | Provision reference (e.g., `FI_J_2021_01`, `FI_R_2023_05`) |

**Returns** `Provision & { _citation: CitationMetadata, _meta: Meta }` or error if not found.

---

## ee_fin_list_sourcebooks

List all Finantsinspektsioon sourcebook categories with their names and descriptions.

**Inputs** None

**Returns** `{ sourcebooks: Sourcebook[], count: number, _meta: Meta }`

---

## ee_fin_search_enforcement

Search Finantsinspektsioon enforcement actions — supervisory decisions, fines, activity prohibitions, and warnings.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., firm name, type of breach, `rahapesu`, `AML`) |
| `action_type` | enum | No | Filter by action type: `fine`, `ban`, `restriction`, or `warning` |
| `limit` | number | No | Maximum number of results to return. Defaults to 20, max 100. |

**Returns** `{ results: EnforcementAction[], count: number, _meta: Meta }`

---

## ee_fin_check_currency

Check whether a specific Finantsinspektsioon provision reference is currently in force.

**Inputs**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | Provision reference to check (e.g., `FI_J_2021_01`) |

**Returns** `{ reference: string, status: string, effective_date: string|null, found: boolean, _meta: Meta }`

---

## ee_fin_about

Return metadata about this MCP server: version, data source, tool list.

**Inputs** None

**Returns** `{ name: string, version: string, description: string, data_source: string, tools: ToolSummary[], _meta: Meta }`

---

## ee_fin_list_sources

List the data sources used by this MCP server, including authority names, URLs, and coverage details.

**Inputs** None

**Returns** `{ sources: Source[], _meta: Meta }`

---

## ee_fin_check_data_freshness

Check when the database was last updated and whether data may be stale (threshold: 30 days).

**Inputs** None

**Returns** `{ db_path: string, last_modified: string|null, is_stale: boolean|null, freshness_threshold_days: number, note: string, _meta: Meta }`

---

## Response shapes

### Provision

```typescript
{
  id: number;
  sourcebook_id: string;       // e.g. "FI_Juhendid"
  reference: string;           // e.g. "FI_J_2021_01"
  title: string | null;
  text: string;
  type: string | null;
  status: string;              // "in_force" | "deleted" | "not_yet_in_force"
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}
```

### EnforcementAction

```typescript
{
  id: number;
  firm_name: string;
  reference_number: string | null;
  action_type: string | null;  // "fine" | "ban" | "restriction" | "warning"
  amount: number | null;
  date: string | null;
  summary: string | null;
  sourcebook_references: string | null;
}
```

### CitationMetadata (_citation)

```typescript
{
  canonical_ref: string;
  display_text: string;
  aliases?: string[];
  source_url?: string;
  lookup: { tool: string; args: Record<string, string> };
}
```

### Meta (_meta)

```typescript
{
  disclaimer: string;
  copyright: string;
  source_url: string;
}
```
