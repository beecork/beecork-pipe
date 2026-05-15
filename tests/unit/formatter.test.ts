import { describe, it, expect } from 'vitest';
import { chunkText } from '../../src/util/text.js';

describe('chunkText', () => {
  it('should not split short text', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('should split at Telegram limit (4096)', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(904);
  });

  it('should split at newline boundary when possible', () => {
    const line = 'x'.repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith('\n' + line)).toBe(true);
  });

  it('should split at space when no newline', () => {
    const text = ('word '.repeat(1000)).trim();
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  it('should handle custom max length', () => {
    const text = 'hello world this is a test';
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
  });
});
