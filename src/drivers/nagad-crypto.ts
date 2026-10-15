import { GatewayError } from '../core/errors.js';
import { nodeCrypto } from '../core/util.js';

type KeyObject = import('node:crypto').KeyObject;
type NodeCrypto = typeof import('node:crypto');

/**
 * RSA PKCS#1 v1.5 decryption, which Nagad's protocol uses. Node 20's OpenSSL
 * refuses it for private keys (CVE-2023-46809, the Marvin timing attack);
 * Node 22+ allows it again through OpenSSL's implicit rejection. On Node 20
 * this decrypts without padding and removes the PKCS#1 v1.5 padding itself,
 * without branching on secret bytes. Only Nagad's own TLS responses are ever
 * decrypted here, so the package is not a decryption oracle.
 */
export function rsaPkcs1v15Decrypt(crypto: NodeCrypto, key: KeyObject | string, data: Buffer): Buffer {
  try {
    return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, data);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('CVE-2023-46809')) {
      throw error;
    }
  }

  const em = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, data);

  // EM = 0x00 || 0x02 || PS (at least 8 non-zero bytes) || 0x00 || M
  let bad = (em[0] ?? 1) | ((em[1] ?? 0) ^ 0x02);
  let separator = 0;
  let found = 0;

  for (let i = 2; i < em.length; i++) {
    const isZero = ((em[i] ?? 0) - 1) >>> 31; // 1 when the byte is 0
    const first = isZero & (found ^ 1);
    separator |= first * i;
    found |= isZero;
  }

  bad |= found ^ 1;
  bad |= separator < 10 ? 1 : 0;

  if (bad !== 0) {
    throw new Error('RSA decryption failed.');
  }

  return em.subarray(separator + 1);
}

export type NagadSignatureAlgorithm = 'sha256' | 'sha1';

const ALGORITHMS: Record<string, NagadSignatureAlgorithm> = {
  sha256: 'sha256',
  sha1: 'sha1',
};

/**
 * The RSA envelope Nagad wraps sensitive request and response fields in.
 *
 * Outbound: the plain JSON is encrypted with Nagad's public key (PKCS#1 v1.5)
 * and signed with the merchant's private key. Inbound: Nagad encrypts with the
 * merchant's public key, so the merchant private key decrypts, and Nagad's
 * public key verifies Nagad's signature.
 *
 * Keys may be PEM text (PKCS#1 or PKCS#8, with literal "\n" escapes as often
 * found in .env files), a bare base64 body, or a path to a PEM file.
 */
export class NagadCrypto {
  private gatewayKey: KeyObject | null = null;
  private merchantKey: KeyObject | null = null;
  readonly algorithm: NagadSignatureAlgorithm;

  constructor(
    private readonly gatewayPublicKey: string,
    private readonly merchantPrivateKey: string,
    algorithm = 'sha256',
    private readonly gateway = 'nagad',
  ) {
    this.algorithm = NagadCrypto.algorithm(algorithm, gateway);
  }

  /**
   * "sha256" (default, what working integrations use) or "sha1". Also accepts
   * the Java-style names "SHA256withRSA" / "SHA1withRSA".
   */
  static algorithm(name: string, gateway = 'nagad'): NagadSignatureAlgorithm {
    const key = name.toLowerCase().replace(/withrsa|-|_/g, '');
    const algorithm = ALGORITHMS[key];

    if (!algorithm) {
      throw new GatewayError(`Unsupported Nagad signature algorithm [${name}]; use sha256 or sha1.`, gateway);
    }

    return algorithm;
  }

  /** base64(RSA-encrypt(plain, Nagad public key, PKCS#1 v1.5)). */
  async encrypt(plain: string): Promise<string> {
    const { publicEncrypt, constants } = await nodeCrypto();
    const key = await this.gatewayPublic();

    try {
      return publicEncrypt(
        { key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(plain, 'utf8'),
      ).toString('base64');
    } catch {
      throw new GatewayError(
        'Could not encrypt the Nagad payload (too long for the key, or a bad Nagad public key).',
        this.gateway,
      );
    }
  }

  /** base64(RSA-sign(plain, merchant private key)). */
  async sign(plain: string): Promise<string> {
    const { createSign } = await nodeCrypto();
    const key = await this.merchantPrivate();

    try {
      return createSign(this.algorithm).update(plain, 'utf8').sign(key).toString('base64');
    } catch {
      throw new GatewayError('Could not sign the Nagad payload with the merchant private key.', this.gateway);
    }
  }

  /** Decrypt a base64 field Nagad encrypted with the merchant public key. */
  async decrypt(encrypted: string): Promise<string> {
    const crypto = await nodeCrypto();
    const raw = strictBase64(encrypted);

    if (raw === null || raw.length === 0) {
      throw new GatewayError(
        'Could not decrypt the Nagad response with the merchant private key.',
        this.gateway,
      );
    }

    const key = await this.merchantPrivate();

    try {
      return rsaPkcs1v15Decrypt(crypto, key, raw).toString('utf8');
    } catch {
      throw new GatewayError(
        'Could not decrypt the Nagad response with the merchant private key.',
        this.gateway,
      );
    }
  }

  /** Check a signature Nagad made over `plain` with its private key. */
  async verify(plain: string, signature: string): Promise<boolean> {
    const raw = strictBase64(signature);

    if (raw === null || raw.length === 0) {
      return false;
    }

    const { createVerify } = await nodeCrypto();
    const key = await this.gatewayPublic();

    try {
      return createVerify(this.algorithm).update(plain, 'utf8').verify(key, raw);
    } catch {
      return false;
    }
  }

  private async gatewayPublic(): Promise<KeyObject> {
    this.gatewayKey ??= await load(this.gatewayPublicKey, true, this.gateway);

    return this.gatewayKey;
  }

  private async merchantPrivate(): Promise<KeyObject> {
    this.merchantKey ??= await load(this.merchantPrivateKey, false, this.gateway);

    return this.merchantKey;
  }
}

async function load(key: string, isPublic: boolean, gateway: string): Promise<KeyObject> {
  const { createPublicKey, createPrivateKey } = await nodeCrypto();
  const labels = isPublic ? ['PUBLIC KEY', 'RSA PUBLIC KEY'] : ['PRIVATE KEY', 'RSA PRIVATE KEY'];

  for (const pem of await candidates(key, labels)) {
    try {
      return isPublic ? createPublicKey(pem) : createPrivateKey(pem);
    } catch {
      // Try the next label.
    }
  }

  throw new GatewayError(
    `Could not read the ${isPublic ? 'Nagad public key' : 'merchant private key'}. Use PEM text, a bare base64 key, or a path to a PEM file.`,
    gateway,
  );
}

async function candidates(input: string, labels: string[]): Promise<string[]> {
  let key = input.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').trim();

  if (key !== '' && !key.includes('-----BEGIN') && key.length < 4096) {
    const contents = await readFileIfExists(key);

    if (contents !== null) {
      key = contents.trim();
    }
  }

  if (key.includes('-----BEGIN')) {
    return [key];
  }

  const compact = key.replace(/\s+/g, '');
  const body = (compact.match(/.{1,64}/g) ?? []).map((line) => `${line}\n`).join('');

  return labels.map((label) => `-----BEGIN ${label}-----\n${body}-----END ${label}-----`);
}

/** A key given as a path to a PEM file. Loaded lazily, so runtimes without node:fs only lose this option. */
async function readFileIfExists(path: string): Promise<string | null> {
  try {
    const { readFile, stat } = await import('node:fs/promises');

    return (await stat(path)).isFile() ? await readFile(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/** base64_decode($value, true): null when anything outside the alphabet is present. */
function strictBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, '');

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return null;
  }

  return Buffer.from(compact, 'base64');
}
