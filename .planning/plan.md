# P1 Fixes — Plan

## Fix 1: Duplicate Articles

### Approach
Pass the existing wiki article titles + summaries into the compile prompt so the LLM knows what already exists. Instruct it to UPDATE existing articles instead of creating new ones when topics overlap.

### Changes to `src/commands/compile.ts`:
1. Before processing each raw doc, build a list of existing article titles + summaries from state
2. Include this list in the compile prompt as "Existing Wiki Articles"
3. Add explicit instruction: "If an existing article covers the same topic, output it as an UPDATE with the exact same title — do NOT create a new article with a different name"
4. In the JSON schema, add an `action` field: `"create" | "update"`
5. When writing articles, match by slugified title to detect updates vs creates

### Prompt Changes:
```
Existing wiki articles (DO NOT create duplicates — update these instead if the topic overlaps):
{list of title + summary pairs}

For each article in your output, set action to "update" if it matches an existing article, or "create" if it's genuinely new.
Use the EXACT SAME title as the existing article when updating.
```

## Fix 2: Truncated Articles

### Approach
Two-pronged:
1. **Reduce articles per call**: Instruct the LLM to keep each article focused and concise (max ~500 words)
2. **Increase output budget**: Bump maxTokens from 8192 to 16384 for compile calls
3. **Add truncation guard**: After receiving articles, check if any end mid-sentence and flag them for retry

### Changes to `src/commands/compile.ts`:
1. Update compile prompt: "Keep each article concise — max 500 words. Focus on key facts. If a topic is too large, split into sub-articles."
2. Bump `maxTokens` to 16384
3. Add post-processing: check if article content ends with proper punctuation or markdown structure
4. If truncated, log a warning (future: retry with smaller batch)

## Implementation Order
1. Fix compile.ts prompt (both fixes together since they touch the same code)
2. Test with overlapping docs
3. Test with large docs

## Files Changed
- `src/commands/compile.ts` — main changes
