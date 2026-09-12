/**
 * Ready-made GraphQL documents for the Nexus v2 API, plus a schema crib sheet.
 *
 * Rationale: discovering `mods(filter: ModsFilter, sort: [ModsSort!])` used to require several
 * introspection round-trips. Everything needed is captured here so an agent can search in a
 * single tool call and never has to introspect the schema again.
 */

/** Fields returned for every mod hit; kept small on purpose. */
const MOD_FIELDS = `
  modId
  name
  version
  author
  summary
  status
  adultContent
  downloads
  endorsements
  createdAt
  updatedAt
  game { domainName name }
  modCategory { name }
  uploader { name memberId }
`;

export const SEARCH_MODS = `
query SearchMods($filter: ModsFilter!, $sort: [ModsSort!], $count: Int, $offset: Int) {
  mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
    totalCount
    nodes {${MOD_FIELDS}}
  }
}`;

export type SearchModsResult = {
  mods: {
    totalCount: number;
    nodes: Array<Record<string, any>>;
  };
};

export type SortKey =
  | "relevance"
  | "name"
  | "downloads"
  | "uniqueDownloads"
  | "endorsements"
  | "createdAt"
  | "updatedAt"
  | "size"
  | "lastComment";

export const SORT_KEYS: SortKey[] = [
  "relevance",
  "name",
  "downloads",
  "uniqueDownloads",
  "endorsements",
  "createdAt",
  "updatedAt",
  "size",
  "lastComment",
];

export function buildSort(key: SortKey, direction: "ASC" | "DESC"): Array<Record<string, unknown>> {
  return [{ [key]: { direction } }];
}

/** Exposed as an MCP resource and summarised in the `nexus_graphql` description. */
export const GRAPHQL_CHEATSHEET = `# Nexus Mods GraphQL (API v2) - crib sheet

Endpoint: POST https://api.nexusmods.com/v2/graphql (tool: nexus_graphql)
Only read queries are accepted unless NEXUS_ALLOW_WRITES=true.
Do NOT run introspection queries: everything below is already verified against the live schema.

## Mod search

\`\`\`graphql
query SearchMods($filter: ModsFilter!, $sort: [ModsSort!], $count: Int, $offset: Int) {
  mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
    totalCount
    nodes { modId name version author summary status adultContent downloads endorsements
            createdAt updatedAt game { domainName name } modCategory { name }
            uploader { name memberId } }
  }
}
\`\`\`

Variables example:

\`\`\`json
{
  "filter": {
    "gameDomainName": [{ "value": "mountandblade2bannerlord", "op": "EQUALS" }],
    "nameStemmed": [{ "value": "party size" }]
  },
  "sort": [{ "endorsements": { "direction": "DESC" } }],
  "count": 10
}
\`\`\`

## ModsFilter

Every field takes a list of \`{ value: <String|Boolean>, op: <operator> }\`.
Combine groups with \`{ "op": "AND" | "OR", "filter": [ ...nested ModsFilter... ] }\`.

- Text: \`name\`, \`nameStemmed\`, \`description\`, \`author\`, \`uploader\`, \`tag\`,
  \`categoryName\`, \`languageName\`, \`status\`, \`gameName\`, \`gameDomainName\`, \`primaryImage\`
- Ids: \`modId\`, \`id\`, \`gameId\`, \`uploaderId\`
- Dates: \`createdAt\`, \`updatedAt\` (ISO-8601 strings with GT / GTE / LT / LTE)
- Numbers: \`downloads\`, \`endorsements\`, \`fileSize\`
- Booleans: \`adultContent\`, \`hasUpdated\`, \`supportsVortex\`, \`directDownloadEnabled\`

Operators: EQUALS, NOT_EQUALS, MATCHES, WILDCARD, GT, GTE, LT, LTE.

### Behaviour verified against the live API

- \`nameStemmed: [{ "value": "party size" }]\` - full-text on titles, AND semantics between terms.
  This is the reliable way to search by name.
- \`name: [{ "value": "Party Size Reunited", "op": "EQUALS" }]\` - exact full title only.
- \`name\` + \`WILDCARD\` returns **0 results** in practice (\`*Party*\`, \`Party*\`, ...). Do not use it;
  use \`nameStemmed\`, or \`description: [{ "value": "...", "op": "MATCHES" }]\` for a broader search.
- Boolean filters need real booleans: \`adultContent: [{ "value": false, "op": "EQUALS" }]\`
  (the string \`"false"\` is rejected with a coercion error).


## ModsSort

\`[{ <key>: { direction: ASC | DESC } }]\` with key in:
relevance, name, downloads, uniqueDownloads, endorsements, createdAt, updatedAt, size, lastComment.
(\`random\` also exists and takes a seed.)

## Other useful root fields

- \`game(domainName: String)\`, \`games(filter: GamesSearchFilter, ...)\`
- \`modFiles(modId: ID!, gameId: ID!)\` and \`mod(modId: ID!, gameId: ID!)\` - note these take the
  numeric **gameId**, not the domain name; the v1 tools (nexus_get_mod_files) are usually simpler.
- \`collectionsV2(filter: CollectionsSearchFilter, ...)\`, \`user(id: Int!)\`, \`userByName(name: String!)\`

## Reminder

Before writing raw GraphQL, check whether a dedicated tool already covers the need:
nexus_find_mods (search), nexus_mod_overview (full mod report), nexus_list_author_mods (catalogue).
`;


