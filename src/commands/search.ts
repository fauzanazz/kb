import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig } from '../config';
import { getAllFiles } from '../utils';

const DB_PATH = '.kb/search.db';

function getDb(kbRoot: string): Database {
  const dbPath = join(kbRoot, DB_PATH);
  const db = new Database(dbPath);
  
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles USING fts5(
      title, path, category, content,
      tokenize='porter unicode61'
    );
  `);
  
  return db;
}

export async function indexCommand() {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const db = getDb(kbRoot);
  
  // Clear and rebuild
  db.exec('DELETE FROM articles');
  
  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  const insert = db.prepare('INSERT INTO articles (title, path, category, content) VALUES (?, ?, ?, ?)');
  
  let count = 0;
  for (const file of wikiFiles) {
    const content = readFileSync(file, 'utf-8');
    const relPath = relative(kbRoot, file);
    const titleMatch = content.match(/title:\s*"([^"]+)"/);
    const categoryMatch = content.match(/category:\s*(\S+)/);
    const title = titleMatch?.[1] || relPath.split('/').pop()?.replace('.md', '') || relPath;
    const category = categoryMatch?.[1] || 'uncategorized';
    
    // Strip frontmatter for indexing
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    insert.run(title, relPath, category, body);
    count++;
  }
  
  db.close();
  console.log(chalk.green(`✓ Indexed ${count} articles`));
}

export async function searchCommand(query: string, options: { json?: boolean; limit?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base.'));
    return;
  }

  const dbPath = join(kbRoot, DB_PATH);
  if (!existsSync(dbPath)) {
    console.log(chalk.yellow('⚠ Search index not found. Building...'));
    await indexCommand();
  }

  const db = new Database(dbPath);
  const limit = parseInt(options.limit || '10');
  
  const results = db.prepare(`
    SELECT title, path, category, 
           snippet(articles, 3, '>>>',  '<<<', '...', 40) as snippet,
           rank
    FROM articles 
    WHERE articles MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Array<{ title: string; path: string; category: string; snippet: string; rank: number }>;
  
  db.close();

  if (results.length === 0) {
    console.log(chalk.yellow(`No results for "${query}"`));
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(chalk.blue(`Found ${results.length} result(s) for "${query}":\n`));
  
  for (const [i, r] of results.entries()) {
    console.log(chalk.green(`  ${i + 1}. ${r.title}`) + chalk.dim(` [${r.category}]`));
    console.log(chalk.dim(`     ${r.path}`));
    const highlighted = r.snippet
      .replace(/>>>/g, chalk.yellow(''))
      .replace(/<<</g, chalk.reset(''));
    console.log(`     ${highlighted}`);
    console.log('');
  }
}
