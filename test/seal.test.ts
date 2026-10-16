import { describe, expect, test } from 'bun:test';

import type { SealPayload } from '../shared/seal';
import {
  SEAL_NONCE_LENGTH,
  SEAL_PUBLIC_LENGTH,
  SEAL_SIGNATURE_LENGTH,
  SEAL_VERSION,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  open,
  seal,
  sign,
  verify,
} from '../shared/seal';

/**
 * The two SP06 §3 vectors: produced once by this same module under Bun (2026-10-16) with a pinned
 * ephemeral pair and nonce, so the whole `sealed` string is reproducible. `test/smoke/run.ts` keeps
 * its own copy of the same values and re-seals them under the Bond runtime (txiki.js): the two
 * copies cannot drift silently, whichever stops matching fails. Vector 1 is a `send` with a
 * non-ASCII secret; vector 2 an `org` `assign`, so both payload shapes are covered.
 */
export interface SealVector {
  payload: SealPayload;
  /** PKCS#8 of the ephemeral X25519 pair, lowercase hex: it makes the seal reproducible. */
  ephemeralX25519PrivateKey: string;
  ephemeralX25519PublicKey: string;
  nonceHex: string;
  /** Ed25519 over the body (deterministic, RFC 8032), lowercase hex. */
  signatureHex: string;
  /** `base64url(body || sig)`: exactly what `POST /v1/shares` carries (SP03 §2). */
  sealed: string;
}

/** The recipient's and the sender's pairs of both vectors, as SP06 §2 stores them. */
const SEAL_KEYS = {
  recipientX25519PrivateKey:
    '302e020100300506032b656e04220420979ce251fae9a716fa5033a11766707e7597370e88001401ed2a823bc07109bf',
  recipientX25519PublicKey: '4961c6a9945d449d1fb9f2cb664a353c4081ba23dca968d091e9f9125ba8a227',
  senderEd25519PrivateKey:
    '302e020100300506032b657004220420514bed7caba48f93511fb909a915af4d7eedb6391901b7d277ecc6f6b384e27c',
  senderEd25519PublicKey: '9c8ba7c6523a23951cc8f3f30c7e1bd55ad04058bbc2f17023ee823753e6214c',
};

const SEAL_VECTORS: SealVector[] = [
  {
    payload: {
      v: 1,
      credentialId: '33333333-3333-4333-8333-333333333333',
      toolId: 'kanban',
      toolOrigin: 'https://kanban.example',
      label: 'Kanban',
      username: 'alice@example',
      secret: 's\u00ebnha-\u00danica-01',
      scope: 'role',
      from: '11111111-1111-4111-8111-111111111111',
      to: '22222222-2222-4222-8222-222222222222',
      kind: 'send',
      issuedAt: '2026-10-16T12:00:00.000Z',
    },
    ephemeralX25519PrivateKey:
      '302e020100300506032b656e04220420d76dbeb8ff72419eaa05fcd1c8007c6b191f7f35b26229bebc79f7293619e88a',
    ephemeralX25519PublicKey: '0836ad8a79bbbedfc97206aa33a98163468144c0d8f6a9a0ae70335a0c4b831b',
    nonceHex: '000102030405060708090a0b',
    signatureHex:
      '2f80e43a0cbfad3d40037162a3f7e0d464c8bee37a61a8379c86322666f655df69b5d1390c968e4ea16b901af82b575362dfa3bf247ae0be2123df72fc8e0608',
    sealed:
      'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL6pFA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYI',
  },
  {
    payload: {
      v: 1,
      credentialId: '44444444-4444-4444-8444-444444444444',
      toolId: 'jitsi-admin',
      toolOrigin: 'https://meet.example',
      label: 'Jitsi admin',
      username: 'admin@example',
      secret: 'plain-ascii-secret',
      scope: 'org',
      from: '11111111-1111-4111-8111-111111111111',
      to: '22222222-2222-4222-8222-222222222222',
      kind: 'assign',
      issuedAt: '2026-10-16T12:34:56.000Z',
    },
    ephemeralX25519PrivateKey:
      '302e020100300506032b656e042204205f1c181fe97ebf73f687ae7e06c4fc2cddf94f9f4c4e45375945613faf30a4ad',
    ephemeralX25519PublicKey: '6ca54d6dc051f9b5bad18a2a67cc284e23ab2eded8f6e3d16641c1ce4c0cc116',
    nonceHex: 'fffefdfcfbfaf9f8f7f6f5f4',
    signatureHex:
      '727d426e5cb1924235077519753f2acf64d6a75b853ed2ca9ae178afb456472614ac666523e95368e74f96199b75dd80683e4b14efdc8210515700860d969b00',
    sealed:
      'AWylTW3AUfm1utGKKmfMKE4jqy7e2Pbj0WZBwc5MDMEW__79_Pv6-fj39vX05ggTHpagshsTkGzD3RgFNAmECXHNlNuwlrZW83IlqD6BqyUnDCRcqsVPOxfRRb4jPjlXIhe__ClaBsf1lyME_k3p9WrTbEoTfeBdUAmOGOB-_qMuQoMO_7rUcGW7iVdVBpXNxyIU2V8h6qdVEuH90kQ_LMrjsrdWZIhVSo_ldECW9iaMLKF8pECaclBIIQ2Bhzf4ztdKnpEf5eTxbPIwcaBALtfWgF44Y2HqBw7HmegZlhKCMvsrUakoEZG_PwCxJFTfYrI5Nn0HKMUYkeo4i8Qam9oUassCmbqbfWIldZZ5WTL8dutZYk5EWmUQYFvI7H9oTrSW1vDlbblerIj1p75w1Baz07hvk-BvXi0w6wHwrNmpH8N-Tb8GErzpVM49rm-HFxDi_33uT7KzR9oY6h-GwC1Db5iHQCS7ZTWPOmgPMFtOpxqS_dhfBZFPhIrxuiFhGnr6cksA5JGVDuf02CZwJFMHnvTe8ObKiihRBcsEe76FGnJ9Qm5csZJCNQd1GXU_Ks9k1qdbhT7SyprheK-0VkcmFKxmZSPpU2jnT5YZm3XdgGg-SxTv3IIQUVcAhg2WmwA',
  },
];

/** Vector 1 with one bit flipped in the body (inside the ciphertext) and one in the signature. */
const SEAL_TAMPERED = {
  bodyFlipped:
    'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL65FA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYI',
  signatureFlipped:
    'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4MbAAECAwQFBgcICQoL6pFA1tkIe_z2b5lUClTWjiYaw29pAzhVhcVDZAqcOM3BRTPWcAM_rmjNCcTxs_Qg0n1wjIN26BPJxX2Wr3fc3Gnr8TRnOTBKNMEMmAuUTIBOsAU1c6r3lrxC6Kr9lX-WUrjgZgq4-2VNW9X9s2RHh7UoaLpavW5Uu2O-BQ8qKabD-lfERpuCMc7vhHr8c40NIZ82pvVFKvFudvJlXulkAx8Fu9W9GQDBsRacmryRZhvv_A0P3hCf9lHpXobHQotZ-KhMACnEbDg6y_65gq973TxlbswhWBnCFVpz91X7rSaM9WWSH1YoDRWnM4bdYDaUrOmUXYIpd1JcUY0dYhlaO38lg8orsZwP5de484AbfQ_hnXU0reM1waMzY8yL03qYsHOzy50pnYXuxE95gCP2FrA_-QYJVJXNgZUQFiInBr1jxzhb1jnbsirQdlKpmYCoZbPzdG2z7cQpg4KqQG1UXNkSJ8AK1CxXq6AvgOQ6DL-tPUADcWKj9-DUZMi-43phqDechjImZvZV32m10TkMlo5OoWuQGvgrV1Ni36O_JHrgviEj33L8jgYJ',
};

/** `sign` over 29 raw bytes, deterministic: the pinned signature of a fixed message. */
const SEAL_SIGNATURE_VECTOR = {
  messageHex: '626f6e642f73302f7369676e61747572652d766563746f72',
  signatureHex:
    '5092a2c99da46d2c7b13b150624a5ce140de8b2cb07cfa6e8368c6e07d87d2c13824fc082272ab9ba817ba7975a63ea53957f9c4cdc9830cca57d391a601480f',
};

function bytesOf(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Only the test needs the wire decoding; `shared/seal.ts` keeps its own helpers private. */
function base64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4),
  );
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The options every opening of a pinned vector shares. */
function openOptions(vector: SealVector) {
  return {
    recipientPrivateKey: bytesOf(SEAL_KEYS.recipientX25519PrivateKey),
    recipientPublicKey: bytesOf(SEAL_KEYS.recipientX25519PublicKey),
    senderPublicKey: bytesOf(SEAL_KEYS.senderEd25519PublicKey),
    credentialId: vector.payload.credentialId,
    to: vector.payload.to,
  };
}

describe('seal (SP06 §3)', () => {
  test('the pinned vectors seal to the pinned bytes', async () => {
    for (const vector of SEAL_VECTORS) {
      const sealed = await seal(
        vector.payload,
        bytesOf(SEAL_KEYS.recipientX25519PublicKey),
        bytesOf(SEAL_KEYS.senderEd25519PrivateKey),
        {
          ephemeral: {
            publicKey: bytesOf(vector.ephemeralX25519PublicKey),
            privateKey: bytesOf(vector.ephemeralX25519PrivateKey),
          },
          nonce: bytesOf(vector.nonceHex),
        },
      );

      expect(sealed).toBe(vector.sealed);
    }
  });

  test('the body is 0x01 || ephemeral public || nonce || ciphertext || signature', () => {
    for (const vector of SEAL_VECTORS) {
      const bytes = base64urlToBytes(vector.sealed);
      const bodyLength = bytes.length - SEAL_SIGNATURE_LENGTH;

      expect(bytes[0]).toBe(SEAL_VERSION);
      expect(hexOf(bytes.slice(1, 1 + SEAL_PUBLIC_LENGTH))).toBe(vector.ephemeralX25519PublicKey);
      expect(
        hexOf(bytes.slice(1 + SEAL_PUBLIC_LENGTH, 1 + SEAL_PUBLIC_LENGTH + SEAL_NONCE_LENGTH)),
      ).toBe(vector.nonceHex);
      expect(hexOf(bytes.slice(bodyLength))).toBe(vector.signatureHex);
    }
  });

  test('the sealed bytes carry no username and no secret in clear', () => {
    for (const vector of SEAL_VECTORS) {
      const text = new TextDecoder().decode(base64urlToBytes(vector.sealed));

      expect(text).not.toContain(vector.payload.secret);
      expect(text).not.toContain(vector.payload.username);
    }
  });

  test('two seals of the same payload differ (fresh ephemeral key and nonce)', async () => {
    const vector = SEAL_VECTORS[0];
    const args = [
      vector.payload,
      bytesOf(SEAL_KEYS.recipientX25519PublicKey),
      bytesOf(SEAL_KEYS.senderEd25519PrivateKey),
    ] as const;

    expect(await seal(...args)).not.toBe(await seal(...args));
  });
});

describe('open (SP06 §3)', () => {
  test('the pinned vectors open to the pinned payload', async () => {
    for (const vector of SEAL_VECTORS) {
      expect(await open(vector.sealed, openOptions(vector))).toEqual(vector.payload);
    }
  });

  test('a share sealed for a fresh pair opens with it', async () => {
    const recipient = await generateX25519KeyPair();
    const sender = await generateEd25519KeyPair();
    const payload: SealPayload = { ...SEAL_VECTORS[0].payload, to: 'me', from: 'them' };

    const sealed = await seal(payload, recipient.publicKey, sender.privateKey);

    expect(sealed).not.toBe(SEAL_VECTORS[0].sealed);
    expect(
      await open(sealed, {
        recipientPrivateKey: recipient.privateKey,
        recipientPublicKey: recipient.publicKey,
        senderPublicKey: sender.publicKey,
        credentialId: payload.credentialId,
        to: payload.to,
      }),
    ).toEqual(payload);
  });

  test('a flipped bit in the body is refused', async () => {
    const vector = SEAL_VECTORS[0];

    expect(await open(SEAL_TAMPERED.bodyFlipped, openOptions(vector))).toBeNull();
  });

  test('a flipped bit in the signature is refused', async () => {
    const vector = SEAL_VECTORS[0];

    expect(await open(SEAL_TAMPERED.signatureFlipped, openOptions(vector))).toBeNull();
  });

  test('another credential id in the AAD is refused', async () => {
    const vector = SEAL_VECTORS[0];
    const options = openOptions(vector);

    expect(
      await open(vector.sealed, { ...options, credentialId: SEAL_VECTORS[1].payload.credentialId }),
    ).toBeNull();
  });

  test('another person in the AAD is refused', async () => {
    const vector = SEAL_VECTORS[0];
    const options = openOptions(vector);

    expect(await open(vector.sealed, { ...options, to: '99999999-9999-4999-8999-999999999999' })).toBeNull();
  });

  test('another recipient pair is refused', async () => {
    const options = openOptions(SEAL_VECTORS[0]);
    const other = await generateX25519KeyPair();

    expect(
      await open(SEAL_VECTORS[0].sealed, {
        ...options,
        recipientPrivateKey: other.privateKey,
        recipientPublicKey: other.publicKey,
      }),
    ).toBeNull();
  });

  test('another sender key is refused', async () => {
    const options = openOptions(SEAL_VECTORS[0]);
    const other = await generateEd25519KeyPair();

    expect(await open(SEAL_VECTORS[0].sealed, { ...options, senderPublicKey: other.publicKey })).toBeNull();
  });

  test('a payload addressed to somebody else is refused', async () => {
    const recipient = await generateX25519KeyPair();
    const sender = await generateEd25519KeyPair();
    const payload: SealPayload = { ...SEAL_VECTORS[0].payload, to: 'them' };
    const sealed = await seal(payload, recipient.publicKey, sender.privateKey);

    expect(
      await open(sealed, {
        recipientPrivateKey: recipient.privateKey,
        recipientPublicKey: recipient.publicKey,
        senderPublicKey: sender.publicKey,
        credentialId: payload.credentialId,
        to: 'me',
      }),
    ).toBeNull();
  });

  test('malformed input is refused without throwing', async () => {
    const options = openOptions(SEAL_VECTORS[0]);
    const short = 'AQg2rYp5u77fyXIGqjOpgWNGgUTA2PapoK5wM1oMS4Mb';

    expect(await open('', options)).toBeNull();
    expect(await open('not+base64url', options)).toBeNull();
    expect(await open('AAAA', options)).toBeNull();
    expect(await open(SEAL_VECTORS[0].sealed.slice(0, -8), options)).toBeNull();
    expect(await open(short, options)).toBeNull();
    expect(await open(`${SEAL_VECTORS[0].sealed}=`, options)).toBeNull();
  });
});

describe('Ed25519 signature (SP06 §3)', () => {
  test('the pinned signature is deterministic and verifies', async () => {
    const message = bytesOf(SEAL_SIGNATURE_VECTOR.messageHex);
    const publicKey = bytesOf(SEAL_KEYS.senderEd25519PublicKey);

    expect(hexOf(await sign(message, bytesOf(SEAL_KEYS.senderEd25519PrivateKey)))).toBe(
      SEAL_SIGNATURE_VECTOR.signatureHex,
    );
    expect(await verify(bytesOf(SEAL_SIGNATURE_VECTOR.signatureHex), message, publicKey)).toBe(true);
  });

  test('a flipped bit in the signature or in the message is refused', async () => {
    const message = bytesOf(SEAL_SIGNATURE_VECTOR.messageHex);
    const signature = bytesOf(SEAL_SIGNATURE_VECTOR.signatureHex);
    const publicKey = bytesOf(SEAL_KEYS.senderEd25519PublicKey);
    const flippedSignature = new Uint8Array(signature);
    flippedSignature[0] ^= 0x01;
    const flippedMessage = new Uint8Array(message);
    flippedMessage[0] ^= 0x01;

    expect(await verify(flippedSignature, message, publicKey)).toBe(false);
    expect(await verify(signature, flippedMessage, publicKey)).toBe(false);
  });

  test('another key and a truncated signature are refused', async () => {
    const message = bytesOf(SEAL_SIGNATURE_VECTOR.messageHex);
    const signature = bytesOf(SEAL_SIGNATURE_VECTOR.signatureHex);
    const other = await generateEd25519KeyPair();

    expect(await verify(signature, message, other.publicKey)).toBe(false);
    expect(
      await verify(signature.slice(0, 32), message, bytesOf(SEAL_KEYS.senderEd25519PublicKey)),
    ).toBe(false);
  });
});

describe('key pairs (SP06 §2)', () => {
  test('both pairs export a raw 32-byte public key and a PKCS#8 private key', async () => {
    const x25519 = await generateX25519KeyPair();
    const ed25519 = await generateEd25519KeyPair();

    for (const [pair, curve] of [
      [x25519, '6e'],
      [ed25519, '70'],
    ] as const) {
      expect(pair.publicKey.length).toBe(SEAL_PUBLIC_LENGTH);
      // RFC 8410: SEQUENCE, version 0, AlgorithmIdentifier id-ecPublicKey + the curve OID.
      expect(hexOf(pair.privateKey.slice(0, 11))).toBe('302e020100300506032b65');
      expect(hexOf(pair.privateKey.slice(11, 12))).toBe(curve);
      expect(pair.privateKey.length).toBe(48);
    }
  });

  test('two generations differ', async () => {
    const first = await generateX25519KeyPair();
    const second = await generateX25519KeyPair();

    expect(hexOf(first.publicKey)).not.toBe(hexOf(second.publicKey));
    expect(hexOf(first.privateKey)).not.toBe(hexOf(second.privateKey));
  });
});
