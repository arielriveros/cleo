// The host's self-signed certificate for WebTransport (docs/design/netsync.md §4.4).
//
// Peers pin it by hash (`serverCertificateHashes`), which browsers allow only for an ECDSA P-256 (never RSA)
// certificate whose whole validity is 14 days or less. So: P-256, 10 days, regenerated when less than a day
// is left. The hash is base64 SHA-256 of the DER bytes — the form HostEndpoint.webTransport.certHashes takes.

import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { X509Certificate, createHash, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const DAY = 24 * 60 * 60 * 1000;
const VALID_DAYS = 10;

export interface HostCertificate {
    /** PEM */
    cert: string;
    /** PEM, PKCS#8 */
    key: string;
    /** base64 SHA-256 of the certificate's DER bytes */
    hash: string;
    notAfter: string;
    /** The IP addresses in its subjectAltName. */
    addresses: string[];
}

/** This machine's IPv4 addresses, loopback first. */
export function localAddresses(): string[] {
    const out = ['127.0.0.1'];
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
}

export async function generateCertificate(validDays: number = VALID_DAYS): Promise<HostCertificate> {
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']) as CryptoKeyPair;
    const notBefore = new Date(Date.now() - 60 * 1000);
    const notAfter = new Date(notBefore.getTime() + validDays * DAY);
    const addresses = localAddresses();
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: Date.now().toString(16),
        name: 'CN=cleo-netsync-host',
        notBefore,
        notAfter,
        signingAlgorithm: alg,
        keys,
        extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), // serverAuth
            new x509.SubjectAlternativeNameExtension([
                { type: 'dns', value: 'localhost' },
                ...addresses.map((ip) => ({ type: 'ip' as const, value: ip })),
            ]),
        ],
    });
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
    const result: HostCertificate = {
        cert: cert.toString('pem'),
        key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`,
        hash: createHash('sha256').update(Buffer.from(cert.rawData)).digest('base64'),
        notAfter: notAfter.toISOString(),
        addresses,
    };
    new X509Certificate(result.cert); // throws if the PEM is malformed
    return result;
}

/**
 * A certificate made elsewhere (an allocator that starts this host and must know the hash before it is up), as PEM
 * text or base64 of the PEM (one line, for an environment variable).
 */
export function certificateFromPem(certText: string, keyText: string): HostCertificate {
    const pem = (t: string) => (t.includes('-----BEGIN') ? t : Buffer.from(t.trim(), 'base64').toString('utf8'));
    const cert = pem(certText), key = pem(keyText);
    const x = new X509Certificate(cert);
    return {
        cert, key,
        hash: createHash('sha256').update(x.raw).digest('base64'),
        notAfter: new Date(x.validTo).toISOString(),
        addresses: [],
    };
}

/**
 * The cached certificate in `cacheDir`, or a new one when there is none, it expires within a day, or this
 * machine has an address it does not name.
 */
export async function cachedCertificate(cacheDir: string): Promise<HostCertificate> {
    const file = path.join(cacheDir, 'host-cert.json');
    if (existsSync(file)) {
        try {
            const c = JSON.parse(readFileSync(file, 'utf8')) as HostCertificate;
            const fresh = new Date(c.notAfter).getTime() - Date.now() > DAY;
            if (fresh && localAddresses().every((a) => c.addresses.includes(a))) return c;
        } catch { /* regenerate */ }
    }
    const c = await generateCertificate();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(c, null, 2));
    return c;
}
