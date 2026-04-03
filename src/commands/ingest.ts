import { readFile, writeFile, copyFile, mkdir } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState, saveState } from '../config';
import { contentHash, generateId, slugify } from '../utils';
import type { RawDocument } from '../types';

const MAX_RAW_CHARS = 50000; // Cap raw docs at ~50K chars (~12K tokens)

/**
 * Smart content extraction from HTML.
 * Targets main content areas, strips nav/sidebar/footer/scripts/noise.
 */
function extractContent(html: string): string {
  // Remove scripts, styles, SVGs, noscript
  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Try to extract main content area (in order of preference)
  const contentSelectors = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*(?:id|class)=["'][^"']*(?:content|article|post|entry|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    // Wikipedia specific
    /<div[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*id=["']mw-/i,
    /<div[^>]*class=["'][^"']*mw-parser-output[^"']*["'][^>]*>([\s\S]*)/i,
  ];

  for (const selector of contentSelectors) {
    const match = cleaned.match(selector);
    if (match && match[1] && match[1].length > 500) {
      cleaned = match[1];
      break;
    }
  }

  // Remove common noise elements
  cleaned = cleaned
    // Nav, header, footer, sidebar
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    // Wikipedia specific noise
    .replace(/<div[^>]*class=["'][^"']*(?:navbox|sidebar|infobox|toc|reflist|refbegin|mw-editsection|catlinks|noprint|metadata)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<table[^>]*class=["'][^"']*(?:navbox|sidebar|infobox|metadata)[^"']*["'][^>]*>[\s\S]*?<\/table>/gi, '')
    .replace(/<span[^>]*class=["'][^"']*mw-editsection[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
    // Reference markers [1], [2], etc.
    .replace(/<sup[^>]*class=["'][^"']*reference[^"']*["'][^>]*>[\s\S]*?<\/sup>/gi, '')
    // Forms, inputs
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<input[^>]*>/gi, '');

  // Convert HTML to markdown-ish text
  let text = cleaned
    // Headers
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
    // Paragraphs and breaks
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Lists
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    // Bold and italic
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
    .replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
    // Links - keep text only
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    // Code
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * Fetch URL with smart content extraction.
 * Falls back to basic stripping if smart extraction fails.
 */
async function fetchUrl(url: string): Promise<{ title: string; content: string }> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KBBot/1.0)',
      'Accept': 'text/html',
    },
  });
  const html = await response.text();
  
  // Extract title
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/ - Wikipedia$/, '').trim() || url;
  
  // Smart content extraction
  let content = extractContent(html);
  
  // If extraction produced too little, fall back to basic stripping
  if (content.length < 200) {
    content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  
  // Cap content size
  if (content.length > MAX_RAW_CHARS) {
    content = content.slice(0, MAX_RAW_CHARS) + '\n\n---\n*[Content truncated at ' + MAX_RAW_CHARS + ' characters]*';
    // Try to truncate at a paragraph boundary
    const lastParagraph = content.lastIndexOf('\n\n', MAX_RAW_CHARS);
    if (lastParagraph > MAX_RAW_CHARS * 0.8) {
      content = content.slice(0, lastParagraph) + '\n\n---\n*[Content truncated at paragraph boundary]*';
    }
  }
  
  return { title, content };
}

export async function ingestCommand(source: string, options: { type?: string; title?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state = await loadState(kbRoot);
  const docId = generateId();
  let title: string;
  let content: string;
  let docType = (options.type || 'article') as RawDocument['type'];
  let targetFileName: string;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // URL ingestion
    console.log(chalk.dim(`Fetching ${source}...`));
    const fetched = await fetchUrl(source);
    title = options.title || fetched.title;
    content = `---\nsource: ${source}\ningested: ${new Date().toISOString()}\ntype: ${docType}\n---\n\n# ${title}\n\n${fetched.content}`;
    targetFileName = slugify(title) + '.md';
    
    const charCount = fetched.content.length;
    if (charCount > MAX_RAW_CHARS * 0.9) {
      console.log(chalk.yellow(`  ⚠ Large content (${Math.round(charCount / 1000)}K chars) — truncated to fit`));
    }
  } else {
    // Local file ingestion
    if (!existsSync(source)) {
      console.log(chalk.red(`✗ File not found: ${source}`));
      return;
    }
    const fileContent = await readFile(source, 'utf-8');
    title = options.title || basename(source, extname(source));
    
    if (extname(source) === '.md') {
      // Already markdown, add frontmatter if missing
      if (fileContent.startsWith('---')) {
        content = fileContent;
      } else {
        content = `---\nsource: ${source}\ningested: ${new Date().toISOString()}\ntype: ${docType}\n---\n\n${fileContent}`;
      }
      targetFileName = basename(source);
    } else {
      content = `---\nsource: ${source}\ningested: ${new Date().toISOString()}\ntype: ${docType}\n---\n\n# ${title}\n\n${fileContent}`;
      targetFileName = slugify(title) + '.md';
    }
  }

  // Determine subdirectory based on type
  const typeDir = join(kbRoot, config.paths.raw, docType === 'paper' ? 'papers' : docType === 'note' ? 'notes' : 'articles');
  await mkdir(typeDir, { recursive: true });
  
  const targetPath = join(typeDir, targetFileName);
  await writeFile(targetPath, content);

  // Update state
  const doc: RawDocument = {
    id: docId,
    title,
    source,
    type: docType,
    ingestedAt: new Date().toISOString(),
    hash: contentHash(content),
    path: join(config.paths.raw, docType === 'paper' ? 'papers' : docType === 'note' ? 'notes' : 'articles', targetFileName),
  };
  state.rawDocuments[docId] = doc;
  await saveState(kbRoot, state);

  console.log(chalk.green(`✓ Ingested: ${title}`));
  console.log(chalk.dim(`  → ${doc.path} (${Math.round(content.length / 1000)}K chars)`));
  console.log(chalk.dim(`  ID: ${docId} | Type: ${docType} | Hash: ${doc.hash}`));
}
