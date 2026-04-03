import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import YAML from 'yaml';
import type { KBConfig } from './types';

const KB_CONFIG_FILE = '.kb/config.yaml';
const KB_STATE_FILE = '.kb/state.json';

export function findKBRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(join(dir, '.kb'))) return dir;
    dir = join(dir, '..');
  }
  return null;
}

export async function loadConfig(kbRoot: string): Promise<KBConfig> {
  const configPath = join(kbRoot, KB_CONFIG_FILE);
  const content = await readFile(configPath, 'utf-8');
  return YAML.parse(content) as KBConfig;
}

export async function saveConfig(kbRoot: string, config: KBConfig): Promise<void> {
  const configPath = join(kbRoot, KB_CONFIG_FILE);
  await writeFile(configPath, YAML.stringify(config));
}

export async function loadState(kbRoot: string): Promise<any> {
  const statePath = join(kbRoot, KB_STATE_FILE);
  if (!existsSync(statePath)) {
    return { lastCompile: null, rawDocuments: {}, wikiArticles: {}, compiledHashes: {} };
  }
  const content = await readFile(statePath, 'utf-8');
  return JSON.parse(content);
}

export async function saveState(kbRoot: string, state: any): Promise<void> {
  const statePath = join(kbRoot, KB_STATE_FILE);
  await writeFile(statePath, JSON.stringify(state, null, 2));
}
