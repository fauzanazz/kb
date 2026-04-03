import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig } from '../config';
import { initLLM, chat } from '../llm';
import { getAllFiles, truncate, slugify } from '../utils';

type OutputFormat = 'markdown' | 'marp' | 'report';

const FORMAT_PROMPTS: Record<OutputFormat, string> = {
  markdown: `Write a clear, well-structured markdown document answering the question. Use headers, bullet points, and code blocks as appropriate.`,
  
  marp: `Create a Marp presentation (markdown slides). Rules:
- Start with a YAML frontmatter: ---\nmarp: true\ntheme: default\npaginator: true\n---
- Separate slides with ---
- First slide should be a title slide
- Use ## for slide headers
- Keep each slide concise (max 5-7 bullet points)
- Use markdown formatting (bold, lists, code blocks)
- Aim for 8-15 slides
- Include a summary/conclusion slide at the end`,
  
  report: `Write a comprehensive research report with:
- Executive Summary
- Table of Contents
- Detailed sections with subsections
- Key Findings
- Data and evidence from the knowledge base
- Conclusions and Recommendations
- References (cite wiki articles with [[wikilinks]])
Make it thorough and well-organized. Aim for 1000+ words.`,
};

export async function outputCommand(question: string, options: { format?: string; name?: string }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  initLLM(config);

  const format = (options.format || 'markdown') as OutputFormat;
  if (!FORMAT_PROMPTS[format]) {
    console.log(chalk.red(`✗ Unknown format: ${format}. Use: markdown, marp, report`));
    return;
  }

  // Load wiki context
  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  if (wikiFiles.length === 0) {
    console.log(chalk.yellow('⚠ No wiki articles found. Run `kb compile` first.'));
    return;
  }

  let wikiContext = '';
  let totalChars = 0;
  const MAX_CONTEXT = 120000;

  // Load index first
  const indexPath = join(kbRoot, config.paths.wiki, '_index.md');
  if (existsSync(indexPath)) {
    const indexContent = await readFile(indexPath, 'utf-8');
    wikiContext += `## Wiki Index\n\n${indexContent}\n\n`;
    totalChars += indexContent.length;
  }

  // Load articles
  for (const file of wikiFiles) {
    if (file.endsWith('_index.md')) continue;
    const content = await readFile(file, 'utf-8');
    if (totalChars + content.length > MAX_CONTEXT) {
      wikiContext += `\n---\n${truncate(content, 2000)}\n`;
    } else {
      wikiContext += `\n---\n${content}\n`;
    }
    totalChars += Math.min(content.length, 2000);
  }

  console.log(chalk.blue(`Generating ${format} output...\n`));

  const maxTokens = format === 'report' ? 8192 : format === 'marp' ? 6144 : 4096;

  const result = await chat([
    { role: 'system', content: `You are a research assistant creating outputs from a knowledge base wiki.\n\n${FORMAT_PROMPTS[format]}` },
    { role: 'user', content: `Knowledge base:\n\n${wikiContext}\n\n---\n\nCreate a ${format} output for: ${question}` },
  ], { maxTokens });

  // Determine file extension and name
  const ext = format === 'marp' ? '.marp.md' : '.md';
  const fileName = (options.name || slugify(question.slice(0, 60))) + ext;
  const outputDir = join(kbRoot, config.paths.output);
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, fileName);

  await writeFile(outputPath, result);

  console.log(result);
  console.log('');
  console.log(chalk.green(`✓ Saved to: ${outputPath}`));
  
  if (format === 'marp') {
    console.log(chalk.dim('  Tip: Open in Obsidian with Marp plugin, or run: npx @marp-team/marp-cli ' + outputPath));
  }
}
