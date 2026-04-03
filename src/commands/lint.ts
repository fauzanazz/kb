import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState, saveState } from '../config';
import { initLLM, chatJSON, chat } from '../llm';
import { getAllFiles, truncate } from '../utils';
import type { KBState } from '../types';

interface LintIssue {
  type: 'inconsistency' | 'missing_data' | 'broken_link' | 'orphaned' | 'suggestion';
  severity: 'error' | 'warning' | 'info';
  article: string;
  description: string;
  fix?: string;
}

interface LintResult {
  issues: LintIssue[];
  suggestions: string[];
}

const LINT_SYSTEM_PROMPT = `You are a knowledge base quality auditor. Analyze wiki articles for issues and suggest improvements.

Check for:
1. INCONSISTENCIES: contradictory information across articles
2. MISSING DATA: topics mentioned but not explained, incomplete sections
3. BROKEN LINKS: [[wikilinks]] that reference non-existent articles
4. ORPHANED: articles with no incoming links from other articles
5. SUGGESTIONS: potential new articles, interesting connections, questions to explore

Be thorough but practical. Focus on actionable issues.`;

export async function lintCommand(options: { fix?: boolean }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state: KBState = await loadState(kbRoot);
  initLLM(config);

  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  if (wikiFiles.length === 0) {
    console.log(chalk.yellow('⚠ No wiki articles found. Run `kb compile` first.'));
    return;
  }

  console.log(chalk.blue(`Linting ${wikiFiles.length} wiki articles...\n`));

  // Collect all wiki content
  const articles: Array<{ name: string; content: string }> = [];
  const articleTitles = new Set<string>();
  const allLinks = new Set<string>();

  for (const file of wikiFiles) {
    const content = await readFile(file, 'utf-8');
    const name = file.split('/').pop()?.replace('.md', '') || '';
    articles.push({ name, content });
    
    // Extract title from frontmatter
    const titleMatch = content.match(/title:\s*"([^"]+)"/);
    if (titleMatch) articleTitles.add(titleMatch[1]);
    
    // Extract wikilinks
    const links = content.match(/\[\[([^\]]+)\]\]/g) || [];
    links.forEach(l => allLinks.add(l.replace(/[\[\]]/g, '')));
  }

  // Local checks first (no LLM needed)
  const localIssues: LintIssue[] = [];
  
  // Check for broken links
  for (const link of allLinks) {
    if (!articleTitles.has(link)) {
      localIssues.push({
        type: 'broken_link',
        severity: 'warning',
        article: 'Multiple',
        description: `Wikilink [[${link}]] references a non-existent article`,
        fix: `Create a new article for "${link}"`
      });
    }
  }

  // Check for orphaned articles (no incoming links)
  for (const title of articleTitles) {
    if (title === '_index') continue;
    let hasIncoming = false;
    for (const article of articles) {
      if (article.content.includes(`[[${title}]]`)) {
        hasIncoming = true;
        break;
      }
    }
    if (!hasIncoming) {
      localIssues.push({
        type: 'orphaned',
        severity: 'info',
        article: title,
        description: `Article "${title}" has no incoming wikilinks from other articles`,
      });
    }
  }

  // LLM-powered deep analysis
  console.log(chalk.dim('  Running LLM analysis...'));
  const wikiContent = articles.map(a => `## ${a.name}\n${truncate(a.content, 3000)}`).join('\n\n---\n\n');
  
  let llmResult: LintResult;
  try {
    llmResult = await chatJSON<LintResult>([
      { role: 'system', content: LINT_SYSTEM_PROMPT },
      { role: 'user', content: `Analyze this wiki for issues:\n\n${truncate(wikiContent, 100000)}\n\nExisting article titles: ${[...articleTitles].join(', ')}\n\nReturn JSON:\n{\n  "issues": [{"type": "inconsistency|missing_data|broken_link|orphaned|suggestion", "severity": "error|warning|info", "article": "article name", "description": "what's wrong", "fix": "suggested fix"}],\n  "suggestions": ["suggested new articles or explorations"]\n}` }
    ], { maxTokens: 4096 });
  } catch (err: any) {
    console.log(chalk.yellow(`  ⚠ LLM analysis failed: ${err.message}`));
    llmResult = { issues: [], suggestions: [] };
  }

  const allIssues = [...localIssues, ...llmResult.issues];

  // Display results
  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const infos = allIssues.filter(i => i.severity === 'info');

  if (errors.length > 0) {
    console.log(chalk.red(`\n✗ Errors (${errors.length}):`));
    errors.forEach(i => console.log(chalk.red(`  • [${i.type}] ${i.article}: ${i.description}`)));
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow(`\n⚠ Warnings (${warnings.length}):`));
    warnings.forEach(i => console.log(chalk.yellow(`  • [${i.type}] ${i.article}: ${i.description}`)));
  }

  if (infos.length > 0) {
    console.log(chalk.blue(`\nℹ Info (${infos.length}):`));
    infos.forEach(i => console.log(chalk.dim(`  • [${i.type}] ${i.article}: ${i.description}`)));
  }

  if (llmResult.suggestions.length > 0) {
    console.log(chalk.cyan(`\n💡 Suggestions:`));
    llmResult.suggestions.forEach(s => console.log(chalk.cyan(`  • ${s}`)));
  }

  if (allIssues.length === 0) {
    console.log(chalk.green('\n✓ Wiki looks healthy! No issues found.'));
  }

  // Save lint report
  const reportPath = join(kbRoot, config.paths.output, 'lint-report.md');
  const report = `# Lint Report\n\n> Generated: ${new Date().toISOString()}\n> Articles scanned: ${wikiFiles.length}\n\n## Issues (${allIssues.length})\n\n${allIssues.map(i => `- **[${i.severity.toUpperCase()}]** [${i.type}] ${i.article}: ${i.description}${i.fix ? ` → Fix: ${i.fix}` : ''}`).join('\n')}\n\n## Suggestions\n\n${llmResult.suggestions.map(s => `- ${s}`).join('\n')}\n`;
  
  const { mkdir } = await import('fs/promises');
  await mkdir(join(kbRoot, config.paths.output), { recursive: true });
  await writeFile(reportPath, report);
  console.log(chalk.dim(`\nReport saved: ${reportPath}`));

  // Auto-fix if requested
  if (options.fix && allIssues.some(i => i.fix)) {
    console.log(chalk.blue('\nApplying fixes...'));
    const fixableIssues = allIssues.filter(i => i.fix && i.type === 'broken_link');
    
    if (fixableIssues.length > 0) {
      // For broken links, create stub articles
      for (const issue of fixableIssues) {
        const linkName = issue.description.match(/\[\[([^\]]+)\]\]/)?.[1];
        if (!linkName) continue;
        
        console.log(chalk.dim(`  Creating stub: ${linkName}`));
        try {
          const stubContent = await chat([
            { role: 'system', content: 'Write a brief wiki article stub for the given topic. Include a summary, key points, and [[wikilinks]] to related topics. Keep it under 300 words.' },
            { role: 'user', content: `Write a wiki article stub for: ${linkName}\n\nContext from the wiki index:\n${truncate(articles[0]?.content || '', 5000)}` }
          ], { maxTokens: 2048 });
          
          const { slugify } = await import('../utils');
          const stubPath = join(kbRoot, config.paths.wiki, slugify(linkName) + '.md');
          const fullStub = `---\ntitle: "${linkName}"\ncategory: uncategorized\nsummary: "Auto-generated stub article"\nsources: []\nupdated: ${new Date().toISOString()}\n---\n\n${stubContent}\n`;
          await writeFile(stubPath, fullStub);
          console.log(chalk.green(`    ✓ Created: ${linkName}`));
        } catch (err: any) {
          console.log(chalk.red(`    ✗ Failed: ${linkName}: ${err.message}`));
        }
      }
    }
    console.log(chalk.green('\n✓ Fixes applied.'));
  }

  console.log('');
  console.log(chalk.dim(`Summary: ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info, ${llmResult.suggestions.length} suggestions`));
}
