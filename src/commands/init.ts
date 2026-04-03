import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import YAML from 'yaml';
import chalk from 'chalk';
import type { KBConfig, KBState } from '../types';

export async function initCommand(name: string, options: { path?: string }) {
  const targetDir = options.path || join(process.cwd(), name);
  
  if (existsSync(join(targetDir, '.kb'))) {
    console.log(chalk.yellow('⚠ Knowledge base already exists at this location'));
    return;
  }

  const config: KBConfig = {
    name,
    llm: {
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKey: 'droid-proxy-key',
      model: 'claude-sonnet-4-20250514',
    },
    paths: {
      raw: 'raw',
      wiki: 'wiki',
      output: 'output',
      meta: '.kb/meta',
    },
  };

  const state: KBState = {
    lastCompile: null,
    rawDocuments: {},
    wikiArticles: {},
    compiledHashes: {},
  };

  // Create directories
  const dirs = [
    '.kb', '.kb/meta',
    'raw', 'raw/articles', 'raw/papers', 'raw/notes', 'raw/images',
    'wiki', 'wiki/_categories',
    'output',
  ];
  
  for (const dir of dirs) {
    await mkdir(join(targetDir, dir), { recursive: true });
  }

  // Write config
  await writeFile(join(targetDir, '.kb/config.yaml'), YAML.stringify(config));
  await writeFile(join(targetDir, '.kb/state.json'), JSON.stringify(state, null, 2));
  
  // Create initial wiki index
  await writeFile(join(targetDir, 'wiki/_index.md'), `# ${name}\n\n> Knowledge base compiled by LLM\n\n## Articles\n\n_No articles yet. Run \`kb compile\` after ingesting documents._\n`);
  
  // Create .gitignore
  await writeFile(join(targetDir, '.gitignore'), '.kb/state.json\nnode_modules/\n');
  
  // Create README
  await writeFile(join(targetDir, 'README.md'), `# ${name}\n\nLLM-powered knowledge base. Managed by \`kb\` CLI.\n\n## Structure\n\n- \`raw/\` — Source documents (articles, papers, notes)\n- \`wiki/\` — LLM-compiled wiki articles\n- \`output/\` — Generated reports, slides, charts\n- \`.kb/\` — Configuration and state\n\n## Usage\n\n\`\`\`bash\nkb ingest <file-or-url>   # Add source documents\nkb compile                # Compile raw → wiki\nkb query "question"       # Ask questions\nkb lint                   # Health check\nkb search "term"          # Full-text search\n\`\`\`\n`);

  console.log(chalk.green(`✓ Knowledge base '${name}' created at ${targetDir}`));
  console.log(chalk.dim('  Next: add documents with `kb ingest <file-or-url>`'));
}
