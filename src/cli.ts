#!/usr/bin/env bun
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { ingestCommand } from './commands/ingest';
import { compileCommand } from './commands/compile';
import { queryCommand } from './commands/query';
import { lintCommand } from './commands/lint';
import { searchCommand, indexCommand } from './commands/search';
import { outputCommand } from './commands/output';
import { serveCommand } from './commands/serve';
import { enhanceCommand } from './commands/enhance';
import { exportCommand } from './commands/export';

const program = new Command();

program
  .name('kb')
  .description('LLM-powered Knowledge Base CLI')
  .version('0.3.0');

// Phase 1 — Core
program
  .command('init <name>')
  .description('Create a new knowledge base')
  .option('-p, --path <path>', 'Custom path for the knowledge base')
  .action(initCommand);

program
  .command('ingest <source>')
  .description('Add a document to the knowledge base (file path or URL)')
  .option('-t, --type <type>', 'Document type: article, paper, repo, note', 'article')
  .option('--title <title>', 'Custom title for the document')
  .action(ingestCommand);

program
  .command('compile')
  .description('Compile raw documents into wiki articles')
  .option('-f, --full', 'Full recompile (ignore cache)', false)
  .option('-o, --only <pattern>', 'Only compile files matching glob pattern (e.g. "*rag*", "*ai-*")')
  .action(compileCommand);

program
  .command('query <question>')
  .description('Ask a question against the knowledge base')
  .option('-s, --save', 'Save the answer to output/', false)
  .option('--file', 'File the answer back into the wiki', false)
  .action(queryCommand);

// Phase 2 — Enhancement
program
  .command('lint')
  .description('Health check the wiki for issues and suggestions')
  .option('--fix', 'Auto-fix issues (creates stub articles for broken links)', false)
  .action(lintCommand);

program
  .command('search <query>')
  .description('Full-text search across wiki articles')
  .option('--json', 'Output results as JSON', false)
  .option('-l, --limit <n>', 'Max results', '10')
  .action(searchCommand);

program
  .command('reindex')
  .description('Rebuild the search index')
  .action(indexCommand);

program
  .command('output <question>')
  .description('Generate formatted output (markdown, marp slides, report)')
  .option('-f, --format <format>', 'Output format: markdown, marp, report', 'markdown')
  .option('-n, --name <name>', 'Custom output filename')
  .action(outputCommand);

program
  .command('serve')
  .description('Start web UI for browsing and searching the wiki')
  .option('-p, --port <port>', 'Port number', '3333')
  .action(serveCommand);

// Phase 3 — Advanced
program
  .command('enhance')
  .description('Analyze wiki for gaps and auto-fill with new articles')
  .option('-a, --auto', 'Automatically fill gaps (creates new articles)', false)
  .option('-l, --limit <n>', 'Max gaps to fill in auto mode', '5')
  .option('--nosearch', 'Skip web search when filling gaps', false)
  .action(enhanceCommand);

program
  .command('export')
  .description('Export wiki to HTML site, JSON dump, or single markdown file')
  .option('-f, --format <format>', 'Export format: html, json, single', 'html')
  .option('-o, --output <path>', 'Custom output directory')
  .action(exportCommand);

program.parse();
