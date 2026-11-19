import { describe, expect, test } from 'bun:test';
import { nativeHostArch } from '../scripts/build-nod-native';

describe('macOS native helper architecture', () => {
  test('Node/Bun x64 maps to the Intel Swift target, never arm64', () => {
    expect(nativeHostArch('x64')).toBe('x86_64');
  });
  test('explicit Intel spelling remains Intel', () => {
    expect(nativeHostArch('x86_64')).toBe('x86_64');
  });
  test('Apple silicon remains arm64', () => {
    expect(nativeHostArch('arm64')).toBe('arm64');
  });
});
