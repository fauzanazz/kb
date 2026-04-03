import { Hono } from 'hono';

import { Database } from 'bun:sqlite';
import { readFile } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState } from '../config';
import { getAllFiles } from '../utils';

function getSearchDb(kbRoot: string): Database.Database | null {
  const dbPath = join(kbRoot, '.kb/search.db');
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath);
}

const HTML_TEMPLATE = (title: string, content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — KB</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; max-width: 900px; margin: 0 auto; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 1rem; font-size: 1.8rem; }
    h2 { color: #79c0ff; margin: 1.5rem 0 0.5rem; }
    h3 { color: #d2a8ff; margin: 1rem 0 0.5rem; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .search-box { width: 100%; padding: 0.75rem 1rem; font-size: 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9; margin-bottom: 1.5rem; }
    .search-box:focus { outline: none; border-color: #58a6ff; }
    .result { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; }
    .result h3 { margin: 0 0 0.25rem; color: #58a6ff; }
    .result .category { color: #8b949e; font-size: 0.85rem; }
    .result .snippet { color: #c9d1d9; margin-top: 0.5rem; font-size: 0.9rem; line-height: 1.5; }
    .result .snippet mark { background: #3b2e00; color: #f0c000; padding: 0 2px; border-radius: 2px; }
    .stats { color: #8b949e; font-size: 0.85rem; margin-bottom: 1rem; }
    .article-list { list-style: none; }
    .article-list li { padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
    .article-list .summary { color: #8b949e; font-size: 0.85rem; }
    .nav { display: flex; gap: 1rem; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #30363d; }
    .content { line-height: 1.7; }
    .content p { margin: 0.75rem 0; }
    .content ul, .content ol { margin: 0.75rem 0; padding-left: 1.5rem; }
    .content li { margin: 0.25rem 0; }
    .content code { background: #161b22; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    .content pre { background: #161b22; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
    .content blockquote { border-left: 3px solid #30363d; padding-left: 1rem; color: #8b949e; margin: 1rem 0; }
    .back { margin-bottom: 1rem; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/">🏠 Home</a>
    <a href="/search">🔍 Search</a>
    <a href="/articles">📚 Articles</a>
  </nav>
  ${content}
</body>
</html>`;

export async function serveCommand(options: { port?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const port = parseInt(options.port || '3333');
  const app = new Hono();

  // Home page
  app.get('/', async (c) => {
    const state = await loadState(kbRoot);
    const articleCount = Object.keys(state.wikiArticles || {}).length;
    const rawCount = Object.keys(state.rawDocuments || {}).length;
    const categories = [...new Set(Object.values(state.wikiArticles || {}).map((a: any) => a.category))];
    
    return c.html(HTML_TEMPLATE(config.name, `
      <h1>📚 ${config.name}</h1>
      <p class="stats">${articleCount} articles • ${rawCount} raw documents • ${categories.length} categories</p>
      
      <form action="/search" method="GET">
        <input class="search-box" type="text" name="q" placeholder="Search the knowledge base..." autofocus />
      </form>
      
      <h2>Categories</h2>
      <ul class="article-list">
        ${categories.sort().map(cat => {
          const catArticles = Object.values(state.wikiArticles || {}).filter((a: any) => a.category === cat);
          return `<li><a href="/articles?category=${encodeURIComponent(cat as string)}">${cat}</a> <span class="summary">(${catArticles.length} articles)</span></li>`;
        }).join('')}
      </ul>
      
      <h2>Recent</h2>
      <ul class="article-list">
        ${Object.values(state.wikiArticles || {}).sort((a: any, b: any) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 10).map((a: any) => 
          `<li><a href="/article/${encodeURIComponent(a.path)}">${a.title}</a> <span class="summary">${a.summary || ''}</span></li>`
        ).join('')}
      </ul>
    `));
  });

  // Search page
  app.get('/search', async (c) => {
    const query = c.req.query('q') || '';
    let resultsHtml = '';
    
    if (query) {
      const db = getSearchDb(kbRoot);
      if (!db) {
        resultsHtml = '<p>Search index not built. Run <code>kb search --reindex</code> first.</p>';
      } else {
        try {
          const results = db.prepare(`
            SELECT title, path, category,
                   snippet(articles, 3, '<mark>', '</mark>', '...', 50) as snippet,
                   rank
            FROM articles WHERE articles MATCH ?
            ORDER BY rank LIMIT 20
          `).all(query) as any[];
          db.close();
          
          if (results.length === 0) {
            resultsHtml = `<p>No results for "${query}"</p>`;
          } else {
            resultsHtml = `<p class="stats">${results.length} result(s)</p>` +
              results.map(r => `
                <div class="result">
                  <h3><a href="/article/${encodeURIComponent(r.path)}">${r.title}</a></h3>
                  <div class="category">${r.category}</div>
                  <div class="snippet">${r.snippet}</div>
                </div>
              `).join('');
          }
        } catch (e: any) {
          resultsHtml = `<p>Search error: ${e.message}. Try simpler terms.</p>`;
          try { db.close(); } catch {}
        }
      }
    }
    
    return c.html(HTML_TEMPLATE('Search', `
      <h1>🔍 Search</h1>
      <form action="/search" method="GET">
        <input class="search-box" type="text" name="q" value="${query}" placeholder="Search..." autofocus />
      </form>
      ${resultsHtml}
    `));
  });

  // Articles list
  app.get('/articles', async (c) => {
    const category = c.req.query('category');
    const state = await loadState(kbRoot);
    let articles = Object.values(state.wikiArticles || {}) as any[];
    
    if (category) {
      articles = articles.filter((a: any) => a.category === category);
    }
    articles.sort((a: any, b: any) => a.title.localeCompare(b.title));
    
    return c.html(HTML_TEMPLATE('Articles', `
      <h1>📚 Articles${category ? ` — ${category}` : ''}</h1>
      <p class="stats">${articles.length} articles</p>
      <ul class="article-list">
        ${articles.map((a: any) => 
          `<li><a href="/article/${encodeURIComponent(a.path)}">${a.title}</a> <span class="summary">[${a.category}] ${a.summary || ''}</span></li>`
        ).join('')}
      </ul>
    `));
  });

  // Single article view (simple markdown rendering)
  app.get('/article/*', async (c) => {
    const articlePath = c.req.path.replace('/article/', '');
    const fullPath = join(kbRoot, decodeURIComponent(articlePath));
    
    if (!existsSync(fullPath)) {
      return c.html(HTML_TEMPLATE('Not Found', '<h1>Article not found</h1><p><a href="/">Back to home</a></p>'), 404);
    }
    
    const content = await readFile(fullPath, 'utf-8');
    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    
    // Very basic markdown to HTML
    const html = body
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[\[([^\]]+)\]\]/g, '<a href="/search?q=$1">$1</a>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
    
    return c.html(HTML_TEMPLATE('Article', `
      <div class="back"><a href="/articles">← Back to articles</a></div>
      <div class="content">${html}</div>
    `));
  });

  // API endpoint for CLI tool integration
  app.get('/api/search', async (c) => {
    const query = c.req.query('q') || '';
    if (!query) return c.json({ results: [] });
    
    const db = getSearchDb(kbRoot);
    if (!db) return c.json({ error: 'No search index' }, 500);
    
    try {
      const results = db.prepare(`
        SELECT title, path, category,
               snippet(articles, 3, '>>>', '<<<', '...', 40) as snippet
        FROM articles WHERE articles MATCH ?
        ORDER BY rank LIMIT 20
      `).all(query);
      db.close();
      return c.json({ results });
    } catch (e: any) {
      try { db.close(); } catch {}
      return c.json({ error: e.message }, 400);
    }
  });

  console.log(chalk.green(`\n🚀 KB Server running at http://localhost:${port}`));
  console.log(chalk.dim(`   Knowledge base: ${config.name}`));
  console.log(chalk.dim(`   Press Ctrl+C to stop\n`));

  Bun.serve({ fetch: app.fetch, port });
}
