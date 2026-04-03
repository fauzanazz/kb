import { createHash } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { join, relative, extname, basename } from 'path';
import { existsSync } from 'fs';

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function readMarkdownFile(path: string): Promise<string> {
  return readFile(path, 'utf-8');
}

export async function getAllFiles(dir: string, extensions: string[] = ['.md', '.txt', '.pdf']): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile() && extensions.includes(extname(e.name)))
    .map(e => join(e.parentPath || (e as any).path || dir, e.name));
}

export async function getFileInfo(filePath: string) {
  const s = await stat(filePath);
  return {
    size: s.size,
    modified: s.mtime.toISOString(),
    name: basename(filePath),
    ext: extname(filePath),
  };
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}
