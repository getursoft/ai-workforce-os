# Built-in Skills

Sprint 6.1 ships five built-in skill adapters, all registered in
`apps/api/src/skills-platform/skill-platform.module.ts` and synced into the database by
`SkillPublisherService` on every boot (`docs/skills/publishing.md`). All five are version `1.0.0`,
`author: "AI Workforce OS"`, `visibility: "PUBLIC"`.

## Document Reader (`document-reader`)

**File**: `apps/api/src/skills-platform/built-in/document-reader.skill.ts`

**Purpose**: Extracts structured text, tables, and metadata from PDF, DOCX, XLSX, CSV, TXT,
Markdown, JSON, XML, and ZIP documents. Explicitly does *not* upload anything to Knowledge — it
reuses the platform's `KnowledgeExtractorRegistry`/`normalizeKnowledgeText` (the same extractors
Knowledge document upload uses) but returns the parsed result to the caller instead.

**Input** (`DocumentReaderInput`): `{ fileName?, mimeType, objectKey?, content?, text? }`. Exactly
one of `objectKey` (read via the `object.read` capability), `content` (base64 bytes supplied
directly), or `text` (plain text, for text-native formats) must be present — `validate()` throws
`SKILL_INPUT_INVALID` if none is.

**Output** (`DocumentReaderOutput`): `{ fileName, mimeType, text, markdown, sections, tables, sheets,
metadata, warnings }`. CSV is parsed into `tables` via `xlsx`; JSON is pretty-printed; XML has tags
stripped; PDF/DOCX/XLSX/ZIP go through the shared knowledge extractor and populate `sections`/
`metadata.pageCount`.

**Manifest**: `requiredPermissions: ["skill.execute"]`, `requiredCapabilities: ["object.read"]`,
`billingCategory: "DETERMINISTIC"`, `timeoutMs: 60_000`, no retries. Not AI-backed, no fallback
behavior to describe — deterministic parsing only. A 50MB buffer size cap throws
`SKILL_PAYLOAD_TOO_LARGE`.

## Text Summarization (`text-summarization`)

**File**: `apps/api/src/skills-platform/built-in/text-summarization.skill.ts`

**Purpose**: Produces a concise, structured summary of a text block.

**Input**: `{ text, requestedLength?: "SHORT"|"MEDIUM"|"LONG", style?: "BULLET"|"PARAGRAPH",
language?, maxOutputTokens? }`.

**Output**: `{ summary, keyPoints, language, model, usage }`.

**Manifest**: `requiredCapabilities: ["ai.provider.execute"]`, `billingCategory:
"AI_PROVIDER_BACKED"`, `timeoutMs: 30_000`, 1 retry.

**AI-vs-deterministic fallback**: if `context.capabilities.ai` is present, it prompts the provider
for JSON `{ summary, keyPoints }`; on either no AI capability or a thrown provider error, it falls
through (`catch { /* fall through */ }`) to `extractiveSummary()` — a purely local, dependency-free
extractive summarizer that takes the first N sentences of the input (`N = 2/4/8` for
SHORT/MEDIUM/LONG) as the summary and the first 3 sentences as key points. A failing AI provider
never fails the skill call; it silently degrades to extractive summarization.

## Entity Extraction (`entity-extraction`)

**File**: `apps/api/src/skills-platform/built-in/entity-extraction.skill.ts`

**Purpose**: Extracts structured fields from free text according to a fully **caller-supplied**
schema — the skill has no hardcoded knowledge of any employee's domain (Travel/HR/Finance/etc.);
field names and types are entirely defined by whoever calls it.

**Input**: `{ text, entitySchema: Record<string, "string"|"number"|"boolean"|"date">, context? }`.
`entitySchema` must declare 1-50 fields; `validate()` rejects an unsupported declared type.

**Output**: `{ entities: Record<string, unknown>, confidence: number (0-1), warnings: string[] }`.

**Manifest**: `requiredCapabilities: ["ai.provider.execute"]`, `billingCategory:
"AI_PROVIDER_BACKED"`, `timeoutMs: 30_000`, 1 retry, optional `configurationSchema.minConfidence`.

**AI-vs-deterministic fallback**: with an AI capability, it prompts for JSON `{ entities, confidence
}` with an explicit system-prompt instruction never to invent values not present in the text; parsed
output is filtered to only the fields declared in `entitySchema` (extra fields in a noisy AI response
are dropped, never merged in). Without an AI capability (or on an unrecoverable provider error —
`SkillError`s are re-thrown, not swallowed, but other thrown errors fall through), it calls
`deterministicExtract()`: a regex-only best-effort pass that fills `number`-typed fields from the
first number-like match and `date`-typed fields from the first `YYYY-MM-DD`-shaped match in the text,
leaving every `string`-typed field `null` (the code comment explains why: "guessing free text without
an LLM is unreliable"). The deterministic path always emits a warning that no AI provider was
configured, and reports `confidence: 0.4` if any entity was filled, else `0`.

## Translation (`translation`)

**File**: `apps/api/src/skills-platform/built-in/translation.skill.ts`

**Purpose**: Translates text into a target language.

**Input**: `{ text, sourceLanguage?, targetLanguage }`.

**Output**: `{ translatedText, sourceLanguage, targetLanguage, model, usage }`.

**Manifest**: `requiredCapabilities: ["ai.provider.execute"]`, `billingCategory:
"AI_PROVIDER_BACKED"`, `timeoutMs: 30_000`, 1 retry.

**AI-vs-deterministic fallback**: this skill is built around an explicit `TranslationAdapter`
abstraction (`AiProviderTranslationAdapter` / `DeterministicTranslationAdapter`) rather than an
inline branch — the skill's own code never talks to a concrete provider directly. If
`context.capabilities.ai` exists, `AiProviderTranslationAdapter` is used; otherwise
`DeterministicTranslationAdapter`. Unlike the other two AI-backed skills, the deterministic fallback
here is **not** a best-effort real translation — it returns `[<targetLanguage>] <original text>`
verbatim, a stable, reversible tag. The code comment is explicit that this is "not attempt[ing] real
translation" — it exists so tests and an offline mode have a deterministic, dependency-free
contract to assert against, not so an org gets usable translations without an AI provider configured.
If the AI adapter throws, `execute()` catches it and falls back to the deterministic adapter inline
(`translation.skill.ts:151-159`).

## File Validation (`file-validation`)

**File**: `apps/api/src/skills-platform/built-in/file-validation.skill.ts`

**Purpose**: Validates a file's MIME type, extension, size, checksum, and archive safety before it
is trusted elsewhere. The manifest description states plainly: "Supplements — never replaces —
server-side upload security."

**Input** (`FileValidationInput`): `{ fileName, mimeType, sizeBytes, content?, expectedChecksumSha256?
}`. `content` (base64) and `expectedChecksumSha256` are optional — name/extension/size/MIME checks
run on metadata alone; checksum and archive inspection require `content`.

**Output** (`FileValidationOutput`): `{ valid, errors, warnings, checks: { extensionAllowed,
mimeTypeConsistentWithExtension, sizeWithinLimit, checksumVerified, archiveSafe, pathSafe } }`.

**Manifest**: `requiredCapabilities: []` (no capabilities needed — pure computation on the supplied
input), `billingCategory: "DETERMINISTIC"`, `timeoutMs: 15_000`, no retries. Optional
`configurationSchema`: `{ allowedExtensions?: string[], maxSizeBytes?: number }` — an organization may
*narrow* the default allowed-extension set, never widen it beyond the built-in known-safe MIME↔
extension map.

**Concrete security checks**:

- **Path safety** (`isPathSafe()`): rejects a filename that is empty, contains a NUL byte, starts
  with `/` or `\`, matches a Windows drive-letter prefix (`^[a-zA-Z]:[\\/]/`), or has any path
  segment equal to `..`. Applied both to the top-level `fileName` and to every entry name inside an
  archive.
- **Extension/MIME consistency**: `KNOWN_MIME_BY_EXTENSION` is a small, deliberately conservative
  map (`.pdf`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.md`, `.json`, `.xml`, `.zip`) — a file whose
  declared `mimeType` doesn't match its extension's known MIME types is flagged as an error even if
  the extension itself is allowed.
- **Size limit**: `sizeBytes` must be `> 0` and `<= maxSizeBytes` (configurable, default 50MB).
- **Checksum**: when `expectedChecksumSha256` is supplied, computes `sha256` over the decoded
  `content` buffer and compares — a mismatch is an error, not just a warning.
- **Archive safety** (only for `.zip`/`.docx`/`.xlsx`, since DOCX/XLSX are themselves zip containers),
  via `checkArchiveSafety()` using `JSZip.loadAsync()`:
  - `ZIP_MAX_ENTRIES = 200` — an archive with more entries is rejected outright ("Archive contains
    too many entries").
  - `ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024` (100MB) — running total of each entry's
    uncompressed size is checked after every entry; exceeding it aborts with "Archive exceeds the
    maximum allowed uncompressed size (zip-bomb defense)".
  - Every entry name is checked with the same `isPathSafe()` used on the top-level filename — a
    path-traversal entry name (e.g. `../../etc/passwd`) is rejected as "Archive entry has an unsafe
    path".
  - A corrupt or unparseable archive is treated as unsafe ("Archive could not be read; it may be
    corrupt or unsafe"), not silently passed.

`valid` in the output is `errors.length === 0`. This skill produces a verdict; it does not itself
block an upload — callers (like `attachment.service.ts`, if wired to call it, which it currently is
not for validation purposes) are responsible for acting on the result. Its own manifest description
is the authoritative statement of scope: this is a supplementary check, not the platform's only or
primary upload defense.
