import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState, saveState } from '../config';
import { initLLM, chatJSON, chat } from '../llm';
import { getAllFiles, truncate, slugify } from '../utils';
import type { KBState } from '../types';

interface EnhanceAnalysis {
  gaps: Array<{
    topic: string;
    reason: string;
    searchQuery: string; // suggested web search to fill the gap
    priority: 'high' | 'medium' | 'low';
  }>;
  questions: string[]; // interesting questions to explore
  weakArticles: Array<{
    title: string;
    issue: string;
    suggestion: string;
  }>;
}

interface GeneratedArticle {
  title: string;
  category: string;
  summary: string;
  content: string;
  relatedTopics: string[];
}

const ANALYZE_PROMPT = `You are a knowledge base analyst. Review this wiki and identify:

1. GAPS: Topics that are referenced via [[wikilinks]] but don't have articles, or important related topics that should be covered
2. QUESTIONS: Interesting research questions that could be explored using this knowledge base
3. WEAK ARTICLES: Existing articles that are too short, lack detail, or could be improved

For each gap, suggest a web search query that would help fill it.
Prioritize gaps that are referenced most often or are most central to the knowledge base's themes.
Limit to the top 5 gaps, 5 questions, and 3 weak articles.`;

const FILL_PROMPT = `You are a knowledge base writer. Write a wiki article based on the provided information.

Rules:
- Write a clear, concise article (200-500 words)
- Use [[wikilinks]] to link to related concepts
- Include a brief summary at the top
- Focus on key facts, definitions, and relationships
- ALWAYS end with a complete sentence
- Base content on the provided search results and existing wiki context`;

export async function enhanceCommand(options: { auto?: boolean; limit?: string; nosearch?: boolean }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('\u2717 Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state: KBState = await loadState(kbRoot);
  initLLM(config);

  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  if (wikiFiles.length === 0) {
    console.log(chalk.yellow('\u26a0 No wiki articles found. Run `kb compile` first.'));
    return;
  }

  // Load all wiki content for analysis
  let wikiContent = '';
  for (const file of wikiFiles) {
    const content = await readFile(file, 'utf-8');
    wikiContent += `\n---\n${truncate(content, 2000)}\n`;
  }

  console.log(chalk.blue(`Analyzing ${wikiFiles.length} wiki articles for enhancement opportunities...\n`));

  // Step 1: Analyze the wiki
  const analysis = await chatJSON<EnhanceAnalysis>([
    { role: 'system', content: ANALYZE_PROMPT },
    { role: 'user', content: `Here is the wiki content:\n\n${truncate(wikiContent, 100000)}\n\nReturn JSON:\n{\n  "gaps": [{"topic": "...", "reason": "...", "searchQuery": "...", "priority": "high|medium|low"}],\n  "questions": ["..."],\n  "weakArticles": [{"title": "...", "issue": "...", "suggestion": "..."}]\n}` }
  ], { maxTokens: 4096 });

  // Display analysis
  console.log(chalk.cyan('\ud83d\udcca Analysis Results:\n'));

  if (analysis.gaps.length > 0) {
    console.log(chalk.yellow('\ud83d\udd73\ufe0f  Knowledge Gaps:'));
    for (const gap of analysis.gaps) {
      const icon = gap.priority === 'high' ? '\ud83d\udfe5' : gap.priority === 'medium' ? '\ud83d\udfe8' : '\ud83d\udfe9';
      console.log(`  ${icon} ${chalk.bold(gap.topic)} — ${gap.reason}`);
      console.log(chalk.dim(`     Search: "${gap.searchQuery}"`));
    }
    console.log('');
  }

  if (analysis.questions.length > 0) {
    console.log(chalk.cyan('\u2753 Suggested Questions to Explore:'));
    for (const q of analysis.questions) {
      console.log(chalk.dim(`  \u2022 ${q}`));
    }
    console.log('');
  }

  if (analysis.weakArticles.length > 0) {
    console.log(chalk.yellow('\u26a0\ufe0f  Weak Articles:'));
    for (const wa of analysis.weakArticles) {
      console.log(`  \u2022 ${chalk.bold(wa.title)}: ${wa.issue}`);
      console.log(chalk.dim(`    Suggestion: ${wa.suggestion}`));
    }
    console.log('');
  }

  // Save analysis report
  const reportPath = join(kbRoot, config.paths.output, 'enhance-report.md');
  await mkdir(join(kbRoot, config.paths.output), { recursive: true });
  const report = `# Enhancement Report\n\n> Generated: ${new Date().toISOString()}\n> Articles analyzed: ${wikiFiles.length}\n\n## Knowledge Gaps\n\n${analysis.gaps.map(g => `- **[${g.priority.toUpperCase()}]** ${g.topic} — ${g.reason}\n  - Search: \"${g.searchQuery}\"`).join('\n')}\n\n## Suggested Questions\n\n${analysis.questions.map(q => `- ${q}`).join('\n')}\n\n## Weak Articles\n\n${analysis.weakArticles.map(wa => `- **${wa.title}**: ${wa.issue}\n  - Suggestion: ${wa.suggestion}`).join('\n')}\n`;
  await writeFile(reportPath, report);
  console.log(chalk.dim(`Report saved: ${reportPath}`));

  // Step 2: Auto-fill gaps if --auto
  if (!options.auto) {
    console.log(chalk.dim('\nRun with --auto to automatically fill gaps.'));
    return;
  }

  const limit = parseInt(options.limit || '5');
  const gapsToFill = analysis.gaps.slice(0, limit);
  
  console.log(chalk.blue(`\n\u2728 Auto-filling ${gapsToFill.length} gap(s)...\n`));

  let filled = 0;
  for (const gap of gapsToFill) {
    console.log(chalk.dim(`  Filling: ${gap.topic}`));

    let searchContext = '';
    
    // Web search if not disabled
    if (!options.nosearch) {
      try {
        console.log(chalk.dim(`    Searching: "${gap.searchQuery}"`));
        const searchResponse = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(gap.searchQuery)}&format=json&no_html=1`);
        const searchData = await searchResponse.json() as any;
        
        if (searchData.Abstract) {
          searchContext = `\n\nWeb search results for "${gap.searchQuery}":\n${searchData.Abstract}`;
        }
        if (searchData.RelatedTopics?.length > 0) {
          const topics = searchData.RelatedTopics
            .filter((t: any) => t.Text)
            .slice(0, 5)
            .map((t: any) => `- ${t.Text}`)
            .join('\n');
          searchContext += `\n\nRelated topics:\n${topics}`;
        }
      } catch (err: any) {
        console.log(chalk.dim(`    Search failed: ${err.message}`));
      }
    }

    // Build existing articles context for dedup
    const currentArticlesList = Object.values(state.wikiArticles)
      .map(a => `- "${a.title}" [${a.category}]: ${a.summary}`)
      .join('\n');

    try {
      const article = await chatJSON<GeneratedArticle>([
        { role: 'system', content: FILL_PROMPT },
        { role: 'user', content: `Write a wiki article about: ${gap.topic}\n\nReason this gap exists: ${gap.reason}${searchContext}\n\nExisting wiki context:\n${truncate(wikiContent, 30000)}\n\nExisting articles (don't duplicate):\n${currentArticlesList}\n\nReturn JSON:\n{\n  "title": "${gap.topic}",\n  "category": "appropriate-category",\n  "summary": "1-2 sentence summary",\n  "content": "Full markdown article with [[wikilinks]]. 200-500 words.",\n  "relatedTopics": ["Topic A", "Topic B"]\n}` }
      ], { maxTokens: 4096 });

      // Write the article
      const articleSlug = slugify(article.title);
      const categoryDir = join(kbRoot, config.paths.wiki, slugify(article.category));
      await mkdir(categoryDir, { recursive: true });

      const articlePath = join(categoryDir, articleSlug + '.md');
      const fullContent = `---\ntitle: "${article.title}"\ncategory: ${article.category}\nsummary: "${article.summary.replace(/"/g, '\\"')}"\nsources:\n  - auto-enhanced\nupdated: ${new Date().toISOString()}\n---\n\n# ${article.title}\n\n> ${article.summary}\n\n${article.content}\n\n---\n*Related: ${(article.relatedTopics || []).map(t => `[[${t}]]`).join(', ')}*\n`;

      await writeFile(articlePath, fullContent);

      // Update state
      state.wikiArticles[articleSlug] = {
        id: articleSlug,
        title: article.title,
        category: article.category,
        summary: article.summary,
        sources: ['auto-enhanced'],
        path: join(config.paths.wiki, slugify(article.category), articleSlug + '.md'),
        updatedAt: new Date().toISOString(),
      };

      console.log(chalk.green(`    \u2713 Created: ${article.title}`));
      filled++;
    } catch (err: any) {
      console.log(chalk.red(`    \u2717 Failed: ${gap.topic}: ${err.message}`));
    }
  }

  // Rebuild index
  if (filled > 0) {
    const indexPath = join(kbRoot, config.paths.wiki, '_index.md');
    const articles = Object.values(state.wikiArticles);
    const categories = [...new Set(articles.map(a => a.category))];
    let index = `# ${config.name}\n\n> Knowledge base with ${articles.length} articles across ${categories.length} categories\n> Last compiled: ${new Date().toISOString()}\n\n`;
    for (const cat of categories.sort()) {
      const catArticles = articles.filter(a => a.category === cat);
      index += `## ${cat}\n\n`;
      for (const a of catArticles.sort((a, b) => a.title.localeCompare(b.title))) {
        index += `- [[${a.title}]] \u2014 ${a.summary}\n`;
      }
      index += '\n';
    }
    await writeFile(indexPath, index);
    await saveState(kbRoot, state);
  }

  console.log('');
  console.log(chalk.green(`\u2713 Enhancement complete! ${filled} article(s) created.`));
}
