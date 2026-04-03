import { readFile, writeFile, mkdir, readdir, copyFile } from 'fs/promises';
import { join, relative, basename } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState } from '../config';
import { getAllFiles } from '../utils';

type ExportFormat = 'html' | 'json' | 'single';

function mdToHtml(md: string): string {
  return md
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/\[\[([^\]]+)\]\]/g, (_, title) => {
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return `<a href="${slug}.html" class="wikilink">${title}</a>`;
    })
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<)/, '<p>')
    .replace(/(?!>)$/, '</p>');
}

const HTML_TEMPLATE = (title: string, nav: string, content: string, kbName: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${kbName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; min-height: 100vh; }
    .sidebar { width: 280px; background: #161b22; border-right: 1px solid #30363d; padding: 1.5rem; overflow-y: auto; position: fixed; height: 100vh; }
    .sidebar h2 { color: #58a6ff; font-size: 1.2rem; margin-bottom: 1rem; }
    .sidebar h3 { color: #8b949e; font-size: 0.85rem; text-transform: uppercase; margin: 1rem 0 0.5rem; }
    .sidebar ul { list-style: none; }
    .sidebar li { padding: 0.2rem 0; }
    .sidebar a { color: #c9d1d9; text-decoration: none; font-size: 0.9rem; }
    .sidebar a:hover { color: #58a6ff; }
    .sidebar a.active { color: #58a6ff; font-weight: 600; }
    .main { margin-left: 280px; padding: 2rem 3rem; max-width: 800px; flex: 1; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; font-size: 1.8rem; }
    h2 { color: #79c0ff; margin: 1.5rem 0 0.75rem; }
    h3 { color: #d2a8ff; margin: 1rem 0 0.5rem; }
    h4 { color: #c9d1d9; margin: 0.75rem 0 0.5rem; }
    p { line-height: 1.7; margin: 0.75rem 0; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.wikilink { color: #79c0ff; border-bottom: 1px dashed #30363d; }
    a.wikilink:hover { border-bottom-color: #79c0ff; }
    blockquote { border-left: 3px solid #30363d; padding-left: 1rem; color: #8b949e; margin: 1rem 0; font-style: italic; }
    code { background: #161b22; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    pre { background: #161b22; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 1rem 0; }
    pre code { padding: 0; background: none; }
    ul, ol { margin: 0.75rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; line-height: 1.6; }
    strong { color: #f0f6fc; }
    hr { border: none; border-top: 1px solid #21262d; margin: 2rem 0; }
    .meta { color: #8b949e; font-size: 0.85rem; margin-bottom: 1.5rem; }
    .search-box { width: 100%; padding: 0.5rem; font-size: 0.85rem; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; margin-bottom: 1rem; }
    .search-box:focus { outline: none; border-color: #58a6ff; }
    @media (max-width: 768px) {
      .sidebar { display: none; }
      .main { margin-left: 0; padding: 1rem; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <h2><a href="index.html">${kbName}</a></h2>
    <input class="search-box" type="text" placeholder="Filter articles..." oninput="filterNav(this.value)" />
    ${nav}
  </aside>
  <main class="main">
    ${content}
  </main>
  <script>
    function filterNav(query) {
      const q = query.toLowerCase();
      document.querySelectorAll('.sidebar li').forEach(li => {
        li.style.display = li.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;

export async function exportCommand(options: { format?: string; output?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('\u2717 Not in a knowledge base.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state = await loadState(kbRoot);
  const format = (options.format || 'html') as ExportFormat;
  const outputDir = options.output || join(kbRoot, 'export', format);

  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  if (wikiFiles.length === 0) {
    console.log(chalk.yellow('\u26a0 No wiki articles found.'));
    return;
  }

  await mkdir(outputDir, { recursive: true });
  console.log(chalk.blue(`Exporting ${wikiFiles.length} articles as ${format}...\n`));

  if (format === 'json') {
    await exportJSON(kbRoot, config, state, wikiFiles, outputDir);
  } else if (format === 'single') {
    await exportSingle(kbRoot, config, state, wikiFiles, outputDir);
  } else if (format === 'html') {
    await exportHTML(kbRoot, config, state, wikiFiles, outputDir);
  } else {
    console.log(chalk.red(`\u2717 Unknown format: ${format}. Use: html, json, single`));
    return;
  }

  console.log(chalk.green(`\n\u2713 Exported to: ${outputDir}`));
}

async function exportJSON(kbRoot: string, config: any, state: any, wikiFiles: string[], outputDir: string) {
  const articles: any[] = [];
  
  for (const file of wikiFiles) {
    const content = await readFile(file, 'utf-8');
    const relPath = relative(kbRoot, file);
    const titleMatch = content.match(/title:\s*"([^"]+)"/);
    const categoryMatch = content.match(/category:\s*(\S+)/);
    const summaryMatch = content.match(/summary:\s*"([^"]+)"/);
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    
    articles.push({
      title: titleMatch?.[1] || basename(file, '.md'),
      category: categoryMatch?.[1] || 'uncategorized',
      summary: summaryMatch?.[1] || '',
      path: relPath,
      content: body,
    });
  }

  const dump = {
    name: config.name,
    exportedAt: new Date().toISOString(),
    articleCount: articles.length,
    articles,
  };

  const outputPath = join(outputDir, `${config.name}.json`);
  await writeFile(outputPath, JSON.stringify(dump, null, 2));
  console.log(chalk.dim(`  Written: ${outputPath} (${articles.length} articles)`));
}

async function exportSingle(kbRoot: string, config: any, state: any, wikiFiles: string[], outputDir: string) {
  const articles = Object.values(state.wikiArticles || {}) as any[];
  const categories = [...new Set(articles.map((a: any) => a.category))] as string[];

  let combined = `# ${config.name}\n\n> Exported: ${new Date().toISOString()}\n> ${articles.length} articles\n\n---\n\n## Table of Contents\n\n`;

  for (const cat of categories.sort()) {
    combined += `### ${cat}\n`;
    const catArticles = articles.filter((a: any) => a.category === cat);
    for (const a of catArticles.sort((a: any, b: any) => a.title.localeCompare(b.title))) {
      combined += `- [${a.title}](#${a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')})\n`;
    }
    combined += '\n';
  }

  combined += '\n---\n\n';

  // Add each article
  for (const file of wikiFiles.sort()) {
    if (file.endsWith('_index.md')) continue;
    const content = await readFile(file, 'utf-8');
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    combined += body + '\n\n---\n\n';
  }

  const outputPath = join(outputDir, `${config.name}.md`);
  await writeFile(outputPath, combined);
  const wordCount = combined.split(/\s+/).length;
  console.log(chalk.dim(`  Written: ${outputPath} (${wordCount} words)`));
}

async function exportHTML(kbRoot: string, config: any, state: any, wikiFiles: string[], outputDir: string) {
  const articles = Object.values(state.wikiArticles || {}) as any[];
  const categories = [...new Set(articles.map((a: any) => a.category))] as string[];

  // Build sidebar navigation
  let nav = '';
  for (const cat of categories.sort()) {
    nav += `<h3>${cat}</h3><ul>`;
    const catArticles = articles.filter((a: any) => a.category === cat);
    for (const a of catArticles.sort((a: any, b: any) => a.title.localeCompare(b.title))) {
      const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      nav += `<li><a href="${slug}.html">${a.title}</a></li>`;
    }
    nav += '</ul>';
  }

  // Generate index page
  const indexContent = `
    <h1>${config.name}</h1>
    <p class="meta">${articles.length} articles \u2022 ${categories.length} categories \u2022 Exported ${new Date().toLocaleDateString()}</p>
    ${categories.sort().map(cat => {
      const catArticles = articles.filter((a: any) => a.category === cat);
      return `<h2>${cat}</h2><ul>${catArticles.sort((a: any, b: any) => a.title.localeCompare(b.title)).map((a: any) => {
        const slug = a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `<li><a href="${slug}.html">${a.title}</a> \u2014 <span style="color:#8b949e">${a.summary || ''}</span></li>`;
      }).join('')}</ul>`;
    }).join('')}
  `;
  await writeFile(join(outputDir, 'index.html'), HTML_TEMPLATE('Home', nav, indexContent, config.name));
  console.log(chalk.dim('  Written: index.html'));

  // Generate article pages
  let count = 0;
  for (const file of wikiFiles) {
    if (file.endsWith('_index.md')) continue;
    const content = await readFile(file, 'utf-8');
    const titleMatch = content.match(/title:\s*"([^"]+)"/);
    const categoryMatch = content.match(/category:\s*(\S+)/);
    const title = titleMatch?.[1] || basename(file, '.md');
    const category = categoryMatch?.[1] || 'uncategorized';
    const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
    const html = mdToHtml(body);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const articleHtml = `
      <div class="meta"><a href="index.html">\u2190 Home</a> \u2022 ${category}</div>
      ${html}
    `;

    await writeFile(join(outputDir, `${slug}.html`), HTML_TEMPLATE(title, nav, articleHtml, config.name));
    count++;
  }

  console.log(chalk.dim(`  Written: ${count} article pages`));
}
