import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { findKBRoot, loadConfig, loadState } from '../config';
import { initLLM, chat } from '../llm';
import { truncate, slugify, getAllFiles } from '../utils';

const QUERY_SYSTEM_PROMPT = `You are a research assistant with access to a knowledge base wiki. Answer questions thoroughly based on the wiki content.

Rules:
- Base your answers on the wiki articles provided
- Reference specific articles when citing information: (see: [[Article Name]])
- If information is not in the wiki, clearly state what's missing
- Be thorough but concise
- Use markdown formatting for readability`;

export async function queryCommand(question: string, options: { save?: boolean; file?: boolean }) {
  const kbRoot = findKBRoot();
  if (!kbRoot) {
    console.log(chalk.red('✗ Not in a knowledge base. Run `kb init <name>` first.'));
    return;
  }

  const config = await loadConfig(kbRoot);
  const state = await loadState(kbRoot);
  initLLM(config);

  // Load the index
  const indexPath = join(kbRoot, config.paths.wiki, '_index.md');
  if (!existsSync(indexPath)) {
    console.log(chalk.yellow('⚠ Wiki index not found. Run `kb compile` first.'));
    return;
  }
  const indexContent = await readFile(indexPath, 'utf-8');

  // Load all wiki articles for context
  const wikiFiles = await getAllFiles(join(kbRoot, config.paths.wiki));
  let wikiContext = `## Wiki Index\n\n${indexContent}\n\n`;
  
  let totalChars = wikiContext.length;
  const MAX_CONTEXT = 150000; // Leave room for response
  
  for (const file of wikiFiles) {
    if (file.endsWith('_index.md')) continue;
    const content = await readFile(file, 'utf-8');
    if (totalChars + content.length > MAX_CONTEXT) {
      // Include truncated version
      wikiContext += `\n---\n${truncate(content, 2000)}\n`;
    } else {
      wikiContext += `\n---\n${content}\n`;
    }
    totalChars += content.length;
  }

  console.log(chalk.dim(`Searching ${wikiFiles.length} wiki articles...\n`));

  const answer = await chat([
    { role: 'system', content: QUERY_SYSTEM_PROMPT },
    { role: 'user', content: `Here is the knowledge base:\n\n${wikiContext}\n\n---\n\nQuestion: ${question}` },
  ], { maxTokens: 4096 });

  console.log(answer);

  // Save output if requested
  if (options.save || options.file) {
    const outputDir = join(kbRoot, options.file ? config.paths.wiki : config.paths.output);
    await mkdir(outputDir, { recursive: true });
    
    const fileName = slugify(question.slice(0, 60)) + '.md';
    const outputPath = join(outputDir, fileName);
    
    const outputContent = `---\nquery: "${question}"\ndate: ${new Date().toISOString()}\n---\n\n# ${question}\n\n${answer}\n`;
    await writeFile(outputPath, outputContent);
    
    console.log('');
    console.log(chalk.green(`✓ Saved to ${options.file ? 'wiki' : 'output'}: ${fileName}`));
  }
}
