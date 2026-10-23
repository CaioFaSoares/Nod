// E06: the native bridge's wire framing (`electrobun/bun/facade/native.ts`).
//
// The Swift library is loaded in-process and answers one JSON string per request; these tests pin
// the contract a bug in `NodNative.swift` or in the client would break: the `id` echoes, a success
// always carries `result` (including null), a failure always carries `code`/`error`, and a response
// from another request is never accepted. Pure: no dylib is loaded and macOS is not required, so the
// suite runs on every host the repo's tests run on.
import { describe, expect, test } from 'bun:test';
import {
  NativeError,
  decodeNativeResponse,
  encodeNativeRequest,
  normalizeDialogTypes,
  type NativeWireRequest,
} from '../electrobun/bun/facade/native';
import { parseTrayIconSpec } from '../electrobun/bun/facade/tray-icon';

describe('encodeNativeRequest', () => {
  test('a keychain read carries the id, op and account', () => {
    const request: NativeWireRequest = { id: 'n-1', op: 'keychain.get', account: 'nod.bio.p1' };
    expect(JSON.parse(encodeNativeRequest(request))).toEqual({
      id: 'n-1',
      op: 'keychain.get',
      account: 'nod.bio.p1',
    });
  });

  test('the service is sent only when the caller pins one', () => {
    const pinned: NativeWireRequest = {
      id: 'n-2',
      op: 'keychain.delete',
      service: 'copland.nod.eb-dev',
      account: 'nod.bio.p1',
    };
    const defaulted: NativeWireRequest = { id: 'n-3', op: 'keychain.delete', account: 'nod.bio.p1' };
    expect(JSON.parse(encodeNativeRequest(pinned))).toHaveProperty('service', 'copland.nod.eb-dev');
    expect(JSON.parse(encodeNativeRequest(defaulted))).not.toHaveProperty('service');
  });

  test('a secret value survives quotes, backslashes and newlines without touching argv/env', () => {
    const value = 'bv1."quoted"\\back\nslash\u0000end';
    const request: NativeWireRequest = {
      id: 'n-4',
      op: 'keychain.set',
      account: 'nod.bio.p1',
      value,
    };
    const wire = encodeNativeRequest(request);
    expect(wire).not.toContain('\n');
    expect(JSON.parse(wire)).toMatchObject({ op: 'keychain.set', value });
  });

  test('a chrome target is a decimal string, so a pointer never loses precision', () => {
    const request: NativeWireRequest = {
      id: 'n-5',
      op: 'setWindowFrame',
      target: '140732204155392',
      frame: false,
    };
    expect(JSON.parse(encodeNativeRequest(request))).toEqual({
      id: 'n-5',
      op: 'setWindowFrame',
      target: '140732204155392',
      frame: false,
    });
  });

  test('a tray icon render carries the parsed kind, glyph and target directory', () => {
    const request: NativeWireRequest = {
      id: 'n-6',
      op: 'renderTrayIcon',
      kind: 'sf',
      value: 'rectangle.stack',
      dir: '/tmp/nod-cache',
    };
    expect(JSON.parse(encodeNativeRequest(request))).toEqual({
      id: 'n-6',
      op: 'renderTrayIcon',
      kind: 'sf',
      value: 'rectangle.stack',
      dir: '/tmp/nod-cache',
    });
    const emoji: NativeWireRequest = {
      id: 'n-7',
      op: 'renderTrayIcon',
      kind: 'emoji',
      value: '🔗',
      dir: '/tmp/nod-cache',
    };
    expect(JSON.parse(encodeNativeRequest(emoji))).toMatchObject({ kind: 'emoji', value: '🔗' });
  });

  test('the app hide has no payload beyond its op', () => {
    const request: NativeWireRequest = { id: 'n-8', op: 'hideApp' };
    expect(JSON.parse(encodeNativeRequest(request))).toEqual({ id: 'n-8', op: 'hideApp' });
  });

  test('the termination hold carries one boolean and nothing else', () => {
    const armed: NativeWireRequest = { id: 'n-9', op: 'setTerminationHold', enabled: true };
    expect(JSON.parse(encodeNativeRequest(armed))).toEqual({
      id: 'n-9',
      op: 'setTerminationHold',
      enabled: true,
    });
    const released: NativeWireRequest = { id: 'n-10', op: 'setTerminationHold', enabled: false };
    expect(JSON.parse(encodeNativeRequest(released))).toEqual({
      id: 'n-10',
      op: 'setTerminationHold',
      enabled: false,
    });
  });
});

describe('decodeNativeResponse', () => {
  test('a success echoes the id and keeps a null result', () => {
    expect(decodeNativeResponse('{"id":"n-1","ok":true,"result":null}', 'n-1')).toEqual({
      id: 'n-1',
      ok: true,
      result: null,
    });
  });

  test('a failure exposes the native code and message', () => {
    expect(
      decodeNativeResponse(
        '{"id":"n-2","ok":false,"code":"keychain","error":"keychain get: User canceled."}',
        'n-2',
      ),
    ).toEqual({
      id: 'n-2',
      ok: false,
      code: 'keychain',
      error: 'keychain get: User canceled.',
    });
  });

  test('a poll answer is a normal success result', () => {
    expect(decodeNativeResponse('{"id":"n-3","ok":true,"result":{"status":"pending"}}', 'n-3')).toEqual(
      { id: 'n-3', ok: true, result: { status: 'pending' } },
    );
  });

  test('a response for another request is refused', () => {
    expect(() => decodeNativeResponse('{"id":"n-9","ok":true,"result":true}', 'n-1')).toThrow(
      NativeError,
    );
    try {
      decodeNativeResponse('{"id":"n-9","ok":true,"result":true}', 'n-1');
    } catch (error) {
      expect((error as NativeError).code).toBe('protocol');
    }
  });

  test('malformed JSON is a protocol error, not a silent null', () => {
    for (const raw of ['', 'not json', '[]', 'null', '"ok"', '42']) {
      expect(() => decodeNativeResponse(raw)).toThrow(NativeError);
    }
  });

  test('a success without a result is refused', () => {
    expect(() => decodeNativeResponse('{"id":"n-1","ok":true}', 'n-1')).toThrow(NativeError);
  });

  test('a failure without code and error is refused', () => {
    expect(() => decodeNativeResponse('{"id":"n-1","ok":false,"code":"x"}', 'n-1')).toThrow(
      NativeError,
    );
  });

  test('a response without a string id or boolean ok is refused', () => {
    expect(() => decodeNativeResponse('{"ok":true,"result":true}')).toThrow(NativeError);
    expect(() => decodeNativeResponse('{"id":"n-1","ok":"yes","result":true}')).toThrow(NativeError);
  });
});

describe('normalizeDialogTypes', () => {
  test('drops the dot, trims, keeps the order and removes duplicates', () => {
    expect(normalizeDialogTypes(['.json', ' jsonl ', 'json', '', '  ', 'nodvault'])).toEqual([
      'json',
      'jsonl',
      'nodvault',
    ]);
  });

  test('absent or empty types mean no restriction', () => {
    expect(normalizeDialogTypes(undefined)).toEqual([]);
    expect(normalizeDialogTypes([])).toEqual([]);
  });

  test('preserves the case of an extension', () => {
    expect(normalizeDialogTypes(['NODVAULT'])).toEqual(['NODVAULT']);
  });
});

describe('parseTrayIconSpec', () => {
  test('an SF Symbol name is trimmed and keeps the kind', () => {
    expect(parseTrayIconSpec('sf:rectangle.stack')).toEqual({
      kind: 'sf',
      value: 'rectangle.stack',
    });
    expect(parseTrayIconSpec('sf:  doc.text  ')).toEqual({ kind: 'sf', value: 'doc.text' });
  });

  test('an emoji glyph is kept verbatim, including a multi-codepoint one', () => {
    expect(parseTrayIconSpec('emoji:🔗')).toEqual({ kind: 'emoji', value: '🔗' });
    expect(parseTrayIconSpec('emoji:👩‍💻')).toEqual({ kind: 'emoji', value: '👩‍💻' });
  });

  test('a png path is not a spec, so the caller keeps the path as given', () => {
    expect(parseTrayIconSpec('tray.png')).toBeNull();
    expect(parseTrayIconSpec('/tmp/icons/tray.png')).toBeNull();
    expect(parseTrayIconSpec('views://bridge/tray.png')).toBeNull();
  });

  test('an empty name or glyph falls back instead of rendering nothing', () => {
    expect(parseTrayIconSpec('sf:')).toBeNull();
    expect(parseTrayIconSpec('sf:   ')).toBeNull();
    expect(parseTrayIconSpec('emoji:')).toBeNull();
    expect(parseTrayIconSpec('emoji:  ')).toBeNull();
  });
});
