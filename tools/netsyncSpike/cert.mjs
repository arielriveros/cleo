// The host's development certificate: self-signed ECDSA P-256, valid for 10 days (WebTransport's
// serverCertificateHashes accepts a certificate only when its whole validity is <= 14 days and its key is not RSA).
// Cached in .cache/cert.json and regenerated when less than a day is left.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { webcrypto, createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

x509.cryptoProvider.set(webcrypto);

const DAY = 24 * 60 * 60 * 1000;
const VALID_DAYS = 10;

/** Every IPv4 address of this machine plus localhost, so LAN devices can open the HTTPS page too. */
export function localAddresses() {
    const out = ['127.0.0.1'];
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
    return out;
}

async function generate() {
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const notBefore = new Date(Date.now() - 60 * 1000);
    const notAfter = new Date(notBefore.getTime() + VALID_DAYS * DAY);
    const sans = [{ type: 'dns', value: 'localhost' }, ...localAddresses().map(ip => ({ type: 'ip', value: ip }))];
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: Date.now().toString(16),
        name: 'CN=cleo-netsync-dev',
        notBefore, notAfter,
        signingAlgorithm: alg,
        keys,
        extensions: [
            new x509.BasicConstraintsExtension(false, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
            new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), // serverAuth
            new x509.SubjectAlternativeNameExtension(sans),
        ],
    });
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    const der = Buffer.from(cert.rawData);
    return {
        cert: cert.toString('pem'),
        key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
        hash: createHash('sha256').update(der).digest('base64'),
        notAfter: notAfter.toISOString(),
        addresses: localAddresses(),
    };
}

/** Load the cached certificate, or make a new one if it is missing, near expiry, or misses an address. */
export async function devCertificate(cacheDir) {
    const file = path.join(cacheDir, 'cert.json');
    if (existsSync(file)) {
        const c = JSON.parse(readFileSync(file, 'utf8'));
        const fresh = new Date(c.notAfter).getTime() - Date.now() > DAY;
        const sameAddresses = localAddresses().every(a => c.addresses?.includes(a));
        if (fresh && sameAddresses) return c;
    }
    const c = await generate();
    new X509Certificate(c.cert); // throws if the PEM is malformed
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(c, null, 2));
    return c;
}
