import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createSqliteStorage } from '@allorc/a423-sdk/storage';
import { createAuthority, createCredentialVerifier } from '@allorc/a423-sdk/authority';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('A423 0.4 authority', () => {
  it('enrolls with an organization signature, issues, expires and revokes credentials', async () => {
    const storage = createSqliteStorage({ filename: ':memory:' });
    let now = 1_700_000_000_000;
    const authorityKeys = keypair();
    const org = keypair();
    const agent = keypair();
    const authority = createAuthority({
      issuer: 'test-issuer',
      audience: 'test-audience',
      privateKey: authorityKeys.privateKey,
      kv: storage.kv,
      credentialTtlSeconds: 60,
      challengeTtlSeconds: 30,
      now: () => now,
    });
    await authority.registerOrganization({ id: 'org-1', name: 'Org One', publicKey: org.publicKey });
    const scopes = ['workflow', 'spend'];
    const statement = authority.registration({ organization: 'org-1', agentId: 'agent-1', publicKey: agent.publicKey, scopes });
    const organizationSignature = sign(null, Buffer.from(JSON.stringify(statement)), org.privateKey).toString('base64url');
    await authority.registerAgent({ organization: 'org-1', agentId: 'agent-1', publicKey: agent.publicKey, scopes, organizationSignature });
    expect(await authority.isActive('agent-1')).toBe(true);

    const challenge = await authority.challenge('agent-1');
    const challengeSignature = sign(null, Buffer.from(JSON.stringify(challenge)), agent.privateKey).toString('base64url');
    const issued = await authority.exchange({ challengeId: challenge.id, signature: challengeSignature });
    const verified = await authority.verifyCredential(issued.credential);
    expect(verified.sub).toBe('agent-1');
    expect(verified.org).toBe('org-1');
    expect(verified.scopes).toContain('workflow');

    // A challenge is single-use.
    await expect(authority.exchange({ challengeId: challenge.id, signature: challengeSignature })).rejects.toThrow();

    // Expiry is enforced against the issuer's clock.
    now += 61_000;
    await expect(authority.verifyCredential(issued.credential)).rejects.toThrow(/Expired|invalid/i);

    // Renewal requires a new proof of key possession.
    const renewedChallenge = await authority.challenge('agent-1');
    const renewedSig = sign(null, Buffer.from(JSON.stringify(renewedChallenge)), agent.privateKey).toString('base64url');
    const renewed = await authority.exchange({ challengeId: renewedChallenge.id, signature: renewedSig });
    expect((await authority.verifyCredential(renewed.credential)).sub).toBe('agent-1');

    // A receiver verifies offline with the public key and an explicit status lookup.
    const verifier = createCredentialVerifier({
      issuer: 'test-issuer',
      audience: 'test-audience',
      publicKey: authority.publicKey,
      isActive: (payload) => authority.isActive(payload.sub),
      now: () => now,
    });
    expect((await verifier(renewed.credential)).sub).toBe('agent-1');

    // Revocation is enforced immediately.
    await authority.revokeAgent('agent-1');
    expect(await authority.isActive('agent-1')).toBe(false);
    await expect(authority.verifyCredential(renewed.credential)).rejects.toThrow(/revoked|Unknown/i);
    await expect(verifier(renewed.credential)).rejects.toThrow();
  });
});
