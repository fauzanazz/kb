import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState, saveState } from '../config';
import { initLLM, chatJSON, chat } from '../llm';
import { contentHash, slugify, getAllFiles, truncate } from '../utils';
import type { KBState, WikiArticle, CompileResult } from '../types';

const LOCK_FILE = '.kb/compile.lock';
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min — consider lock stale after this

async function acquireLock(kbRoot: string): Promise<boolean> {
  const lockPath = join(kbRoot, LOCK_FILE);
  if (existsSync(lockPath)) {
    try {
      const lockData = JSON.parse(await readFile(lockPath, 'utf-8'));
      const age = Date.now() - lockData.timestamp;
      if (age < LOCK_STALE_MS) {
        console.log(chalk.red(`✗ Another compile is running (PID ${lockData.pid}, started ${Math.round(age / 1000)}s ago).`));
        console.log(chalk.dim(`  Remove ${lockPath} manually if the process is dead.`));
        return false;
      }
      console.log(chalk.yellow(`⚠ Stale lock found (${Math.round(age / 60000)}min old). Overriding.`));
    } catch {
      // Corrupt lock file — override
    }
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
  return true;
}

async function releaseLock(kbRoot: string): Promise<void> {
  const lockPath = join(kbRoot, LOCK_FILE);
  try { await unlink(lockPath); } catch {}
}

const CHUNK_THRESHOLD = 30000; // If raw doc > 30K chars, chunk it

const COMPILE_SYSTEM_PROMPT = `You are a knowledge base compiler. Your job is to take raw source documents and compile them into well-structured wiki articles.

Rules:
- Write clear, concise wiki articles in markdown
- Use [[wikilinks]] to link between concepts (e.g. [[Machine Learning]], [[Transformer Architecture]])
- Each article should focus on ONE concept/topic
- Include a brief summary at the top of each article
- Categorize articles into logical categories
- Preserve important details, data, and citations from sources
- If a source covers multiple topics, create multiple articles
- Always maintain factual accuracy — don't hallucinate beyond the source material
- Keep each article CONCISE — aim for 200-500 words max. Focus on key facts, definitions, and relationships.
- If a topic is very large, create a focused overview article and link to sub-topic articles.
- ALWAYS end articles with a complete sentence. Never cut off mid-sentence.

CRITICAL — DEDUPLICATION:
- You will be given a list of EXISTING wiki articles.
- If the raw document covers a topic that ALREADY EXISTS in the wiki, you MUST use the EXACT SAME title as the existing article and set action to "update".
- Do NOT create a new article with a slightly different name (e.g. "Load Balancing in MoE" vs "Load Balancing in Mixture of Experts" — pick the existing one).
- Only set action to "create" for genuinely NEW topics not covered by any existing article.`;

interface CompileOutput {
  articles: Array<{
    action: 'create' | 'update';
    title: string;
    category: string;
    summary: string;
    content: string;
    relatedTopics: string[];
  }>;
}

export async function compileCommand(options: { full?: boolean; only?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state: KBState = await loadState(kbRoot);
  initLLM(config);

  // Acquire lock
  if (!await acquireLock(kbRoot)) return;

  try {
    await doCompile(kbRoot, config, state, options);
  } finally {
    await releaseLock(kbRoot);
  }
}

async function doCompile(kbRoot: string, config: any, state: KBState, options: { full?: boolean; only?: string }) {
  // Find raw documents to process
  const rawFiles = await getAllFiles(join(kbRoot, config.paths.raw));
  
  if (rawFiles.length === 0) {
    console.log(chalk.yellow('⚠ No raw documents found. Run `kb ingest` first.'));
    return;
  }

  // Filter by --only glob if provided
  const onlyPattern = options.only ? new RegExp(
    options.only.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i'
  ) : null;

  // Determine which files need processing
  let toProcess: Array<{ path: string; content: string; relPath: string }> = [];
  
  for (const filePath of rawFiles) {
    const relPath = relative(kbRoot, filePath);

    // Skip if --only is set and path doesn't match
    if (onlyPattern && !onlyPattern.test(relPath)) continue;

    const content = await readFile(filePath, 'utf-8');
    const hash = contentHash(content);
    
    // Find the raw doc entry by path
    const docEntry = Object.values(state.rawDocuments).find(d => d.path === relPath);
    const docId = docEntry?.id || relPath;
    
    if (options.full || !state.compiledHashes[docId] || state.compiledHashes[docId] !== hash) {
      toProcess.push({ path: filePath, content, relPath });
    }
  }

  if (toProcess.length === 0) {
    console.log(chalk.green('✓ Wiki is up to date. No new documents to compile.'));
    return;
  }

  console.log(chalk.blue(`Compiling ${toProcess.length} document(s)...\n`));

  const result: CompileResult = { newArticles: [], updatedArticles: [], totalRawProcessed: 0 };

  // Process each raw document
  for (const doc of toProcess) {
    console.log(chalk.dim(`  Processing: ${doc.relPath}`));
    
    try {
      // Chunk large documents by header sections
      const chunks = chunkDocument(doc.content);
      if (chunks.length > 1) {
        console.log(chalk.dim(`    Splitting into ${chunks.length} chunks (${Math.round(doc.content.length / 1000)}K chars)`));
      }

      // Process each chunk
      for (const [chunkIdx, chunk] of chunks.entries()) {
        if (chunks.length > 1) {
          console.log(chalk.dim(`    Chunk ${chunkIdx + 1}/${chunks.length}...`));
        }

        // Build the existing articles context (refreshed each iteration since state changes)
        const currentArticlesList = Object.values(state.wikiArticles)
          .map(a => `- "${a.title}" [${a.category}]: ${a.summary}`)
          .join('\n');

        const existingContext = currentArticlesList
          ? `\n\nEXISTING WIKI ARTICLES (use exact title for updates, do NOT create duplicates):\n${currentArticlesList}`
          : '';

        const compileOutput = await chatJSON<CompileOutput>([
          { role: 'system', content: COMPILE_SYSTEM_PROMPT },
          { role: 'user', content: `Here is the raw source document${chunks.length > 1 ? ` (part ${chunkIdx + 1} of ${chunks.length})` : ''}:\n\n${truncate(chunk, 60000)}${existingContext}\n\nCompile this into wiki articles. Return JSON:\n{\n  "articles": [\n    {\n      "action": "create or update",\n      "title": "Article Title (use EXACT existing title if updating)",\n      "category": "category-name",\n      "summary": "1-2 sentence summary",\n      "content": "Full markdown article content with [[wikilinks]]. MAX 500 words. Must end with a complete sentence.",\n      "relatedTopics": ["Topic A", "Topic B"]\n    }\n  ]\n}` }
        ], { maxTokens: 16384 });

      // Write articles
      for (const article of compileOutput.articles) {
        // Dedup: check if an existing article matches by slug
        const articleSlug = slugify(article.title);
        const existingArticle = state.wikiArticles[articleSlug];
        
        // Determine the category dir — prefer existing article's location for updates
        const categoryToUse = existingArticle ? existingArticle.category : article.category;
        const categoryDir = join(kbRoot, config.paths.wiki, slugify(categoryToUse));
        await mkdir(categoryDir, { recursive: true });
        
        const articleFileName = articleSlug + '.md';
        const articlePath = join(categoryDir, articleFileName);
        const wikiRelPath = join(config.paths.wiki, slugify(categoryToUse), articleFileName);
        
        // Truncation guard: check if content ends properly
        let articleContent = article.content.trim();
        if (articleContent.length > 0) {
          const lastChar = articleContent[articleContent.length - 1];
          if (!/[.!?)\]`*_\n]/.test(lastChar)) {
            // Content appears truncated — add marker
            articleContent += '\n\n> ⚠️ *This article may be incomplete. Run `kb compile --full` to regenerate.*';
            console.log(chalk.yellow(`    ⚠ Truncation detected: ${article.title}`));
          }
        }

        // Add frontmatter
        const sources = existingArticle 
          ? [...new Set([...existingArticle.sources, doc.relPath])]
          : [doc.relPath];
        
        const fullContent = `---\ntitle: "${article.title}"\ncategory: ${categoryToUse}\nsummary: "${article.summary.replace(/"/g, '\\"')}"\nsources:\n${sources.map(s => `  - ${s}`).join('\n')}\nupdated: ${new Date().toISOString()}\n---\n\n# ${article.title}\n\n> ${article.summary}\n\n${articleContent}\n\n---\n*Related: ${(article.relatedTopics ?? []).map(t => `[[${t}]]`).join(', ')}*\n`;
        
        const isNew = !existsSync(articlePath) && !existingArticle;
        await writeFile(articlePath, fullContent);
        
        // Update state
        state.wikiArticles[articleSlug] = {
          id: articleSlug,
          title: article.title,
          category: categoryToUse,
          summary: article.summary,
          sources,
          path: wikiRelPath,
          updatedAt: new Date().toISOString(),
        };
        
        if (isNew) {
          result.newArticles.push(article.title);
        } else {
          result.updatedArticles.push(article.title);
        }
        
        console.log(chalk.green(`    ${isNew ? '+ New' : '↻ Updated'}: ${article.title}`));
      }
      } // end chunk loop

      // Mark as compiled
      const docEntry = Object.values(state.rawDocuments).find(d => d.path === doc.relPath);
      if (docEntry) {
        state.compiledHashes[docEntry.id] = contentHash(doc.content);
      }
      result.totalRawProcessed++;
      
    } catch (err: any) {
      console.log(chalk.red(`    ✗ Failed to compile ${doc.relPath}: ${err.message}`));
    }
  }

  // Rebuild master index
  console.log(chalk.dim('\n  Rebuilding index...'));
  const indexPath = join(kbRoot, config.paths.wiki, '_index.md');
  const indexContent = await buildIndex(kbRoot, config, state);
  await writeFile(indexPath, indexContent);
  
  // Save state
  state.lastCompile = new Date().toISOString();
  await saveState(kbRoot, state);

  console.log('');
  console.log(chalk.green(`✓ Compilation complete!`));
  console.log(chalk.dim(`  ${result.totalRawProcessed} raw docs processed`));
  console.log(chalk.dim(`  ${result.newArticles.length} new articles, ${result.updatedArticles.length} updated`));
  
  // Report truncation warnings
  const truncatedCount = result.newArticles.length + result.updatedArticles.length;
}

/**
 * Split a large document into chunks by header sections.
 * Only chunks if the document exceeds CHUNK_THRESHOLD.
 * Each chunk gets the document's frontmatter/title for context.
 */
function chunkDocument(content: string): string[] {
  if (content.length <= CHUNK_THRESHOLD) {
    return [content];
  }

  // Extract frontmatter if present
  let frontmatter = '';
  let body = content;
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (fmMatch) {
    frontmatter = fmMatch[0];
    body = content.slice(fmMatch[0].length);
  }

  // Extract title (first H1)
  let title = '';
  const titleMatch = body.match(/^# .+$/m);
  if (titleMatch) {
    title = titleMatch[0] + '\n\n';
  }

  // Split by H2 sections
  const sections: string[] = [];
  const h2Pattern = /^## /m;
  const parts = body.split(h2Pattern);
  
  if (parts.length <= 1) {
    // No H2 headers — split by size
    const halfPoint = Math.floor(body.length / 2);
    const splitAt = body.indexOf('\n\n', halfPoint);
    if (splitAt > 0) {
      return [
        frontmatter + body.slice(0, splitAt),
        frontmatter + title + body.slice(splitAt),
      ];
    }
    return [content]; // Can't split meaningfully
  }

  // First part (before first H2)
  let currentChunk = frontmatter + parts[0];
  
  for (let i = 1; i < parts.length; i++) {
    const section = '## ' + parts[i];
    
    if (currentChunk.length + section.length > CHUNK_THRESHOLD) {
      // Current chunk is big enough, start a new one
      sections.push(currentChunk);
      currentChunk = frontmatter + title + section;
    } else {
      currentChunk += section;
    }
  }
  
  if (currentChunk.length > 0) {
    sections.push(currentChunk);
  }

  return sections.length > 0 ? sections : [content];
}

async function buildIndex(kbRoot: string, config: any, state: KBState): Promise<string> {
  const articles = Object.values(state.wikiArticles);
  const categories = [...new Set(articles.map(a => a.category))];
  
  let index = `# ${config.name}\n\n> Knowledge base with ${articles.length} articles across ${categories.length} categories\n> Last compiled: ${new Date().toISOString()}\n\n`;
  
  for (const cat of categories.sort()) {
    const catArticles = articles.filter(a => a.category === cat);
    index += `## ${cat}\n\n`;
    for (const article of catArticles.sort((a, b) => a.title.localeCompare(b.title))) {
      index += `- [[${article.title}]] — ${article.summary}\n`;
    }
    index += '\n';
  }
  
  return index;
}
