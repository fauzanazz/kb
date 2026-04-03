import OpenAI from 'openai';
import type { KBConfig } from './types';

let client: OpenAI | null = null;
let currentModel: string = 'claude-sonnet-4-20250514';

export function initLLM(config: KBConfig) {
  client = new OpenAI({
    baseURL: config.llm.baseUrl,
    apiKey: config.llm.apiKey,
  });
  currentModel = config.llm.model;
}

export async function chat(messages: Array<{role: 'system' | 'user' | 'assistant', content: string}>, options?: { maxTokens?: number, temperature?: number }): Promise<string> {
  if (!client) throw new Error('LLM not initialized. Run initLLM first.');
  
  const response = await client.chat.completions.create({
    model: currentModel,
    messages,
    max_tokens: options?.maxTokens ?? 8192,
    temperature: options?.temperature ?? 0.3,
  });
  
  return response.choices[0]?.message?.content ?? '';
}

export async function chatJSON<T = any>(messages: Array<{role: 'system' | 'user' | 'assistant', content: string}>, options?: { maxTokens?: number }): Promise<T> {
  const response = await chat([
    ...messages,
    { role: 'user', content: '\nRespond with valid JSON only. No markdown code fences, no explanation.' }
  ], { ...options, temperature: 0.1 });
  
  // Try to extract JSON from response
  let jsonStr = response.trim();
  // Remove code fences if present
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(jsonStr) as T;
}
