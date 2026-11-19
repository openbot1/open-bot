/**
 * A2A v1.0 Agent Card — build, validate, negotiate, tenant views (v11).
 *
 * The Agent Card is how an A2A agent introduces itself: name, endpoint,
 * protocol versions, skills, capabilities, tenants, and (in 1.0) an
 * optional signature. This module builds cards for the local agent,
 * validates cards received from peers, negotiates the protocol version
 * two agents will speak, and derives per-tenant card views for
 * multi-tenancy.
 *
 * Validation is fail-closed and purely structural: it checks shape,
 * URLs, versions, and expiry. Trust (is this peer allowed at all?)
 * lives in registry.ts; signature validity lives in signing.ts. A
 * card can be structurally valid and still untrusted — callers must
 * run all three checks before delegating.
 */

import {
  V11_PROTOCOL_VERSION,
  V11_PROTOCOL_VERSION_1_0_0,
  V11_SUPPORTED_PROTOCOL_VERSIONS,
  isV11HttpUrl,
  type V11AgentCard,
  type V11AgentSkill,
  type V11TenantInfo,
} from './types';

/** One validation problem found on a card. */
export interface V11CardIssue {
  field: string;
  message: string;
}

/** Result of validating a card (structural checks only). */
export interface V11CardValidation {
  valid: boolean;
  issues: V11CardIssue[];
  /** Protocol version the card claims, when it parses. */
  protocolVersion?: string;
  /** True when the card is past `validUntil` at `now`. */
  expired: boolean;
}

/** Options for building a local Agent Card. */
export interface V11BuildCardOptions {
  name: string;
  url: string;
  description?: string;
  version?: string;
  organization?: string;
  organizationUrl?: string;
  skills: V11AgentSkill[];
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  multiTenancy?: boolean;
  extendedCard?: boolean;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  tenants?: V11TenantInfo[];
  /** ISO-8601 expiry. Omit = no expiry (local dev only). */
  validUntil?: string;
  /** Protocol version to advertise as primary. Default: newest. */
  protocolVersion?: string;
}

/**
 * Build an Agent Card for the local agent. The card is unsigned here —
 * sign it with `signV11AgentCard` (signing.ts) before publishing.
 */
export function buildV11AgentCard(options: V11BuildCardOptions): V11AgentCard {
  const protocolVersion = options.protocolVersion ?? V11_PROTOCOL_VERSION;
  const card: V11AgentCard = {
    name: options.name,
    url: options.url,
    protocolVersion,
    supportedVersions: [...V11_SUPPORTED_PROTOCOL_VERSIONS],
    skills: options.skills.map((s) => ({ ...s })),
    capabilities: {
      streaming: options.streaming ?? true,
      pushNotifications: options.pushNotifications ?? false,
      stateTransitionHistory: options.stateTransitionHistory ?? true,
      multiTenancy: options.multiTenancy ?? (options.tenants?.length ?? 0) > 0,
      extendedCard: options.extendedCard ?? true,
    },
    defaultInputModes: options.defaultInputModes ?? ['text/plain'],
    defaultOutputModes: options.defaultOutputModes ?? ['text/plain'],
  };
  if (options.description !== undefined) card.description = options.description;
  if (options.version !== undefined) card.version = options.version;
  if (options.organization !== undefined || options.organizationUrl !== undefined) {
    card.provider = {
      ...(options.organization !== undefined ? { organization: options.organization } : {}),
      ...(options.organizationUrl !== undefined ? { url: options.organizationUrl } : {}),
    };
  }
  if (options.tenants !== undefined && options.tenants.length > 0) {
    card.tenants = options.tenants.map((t) => ({ ...t }));
  }
  if (options.validUntil !== undefined) card.validUntil = options.validUntil;
  return card;
}

/**
 * Validate a received card structurally. `now` is injectable so tests
 * can freeze time; production callers pass `new Date()` (default).
 */
export function validateV11AgentCard(
  input: unknown,
  now: Date = new Date(),
): V11CardValidation {
  const issues: V11CardIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, issues: [{ field: '', message: 'card must be an object' }], expired: false };
  }
  const card = input as Partial<V11AgentCard>;
  if (typeof card.name !== 'string' || card.name.trim().length === 0) {
    issues.push({ field: 'name', message: 'name must be a non-empty string' });
  }
  if (!isV11HttpUrl(card.url)) {
    issues.push({ field: 'url', message: 'url must be an http(s) URL' });
  }
  let protocolVersion: string | undefined;
  if (typeof card.protocolVersion !== 'string' || card.protocolVersion.length === 0) {
    issues.push({ field: 'protocolVersion', message: 'protocolVersion must be a non-empty string' });
  } else {
    protocolVersion = card.protocolVersion;
    if (!(V11_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      issues.push({
        field: 'protocolVersion',
        message: `unsupported protocol version ${protocolVersion} (supported: ${V11_SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`,
      });
    }
  }
  if (card.supportedVersions !== undefined) {
    if (!Array.isArray(card.supportedVersions) || card.supportedVersions.some((v) => typeof v !== 'string')) {
      issues.push({ field: 'supportedVersions', message: 'supportedVersions must be an array of strings' });
    } else if (
      protocolVersion !== undefined &&
      !card.supportedVersions.includes(protocolVersion)
    ) {
      issues.push({
        field: 'supportedVersions',
        message: 'supportedVersions must include protocolVersion',
      });
    }
  }
  if (!Array.isArray(card.skills)) {
    issues.push({ field: 'skills', message: 'skills must be an array' });
  } else {
    card.skills.forEach((skill, i) => {
      if (!skill || typeof skill.id !== 'string' || skill.id.trim().length === 0) {
        issues.push({ field: `skills[${i}].id`, message: 'skill id must be a non-empty string' });
      }
      if (!skill || typeof skill.name !== 'string' || skill.name.trim().length === 0) {
        issues.push({ field: `skills[${i}].name`, message: 'skill name must be a non-empty string' });
      }
    });
    const ids = card.skills
      .filter((s) => s && typeof s.id === 'string')
      .map((s) => (s as V11AgentSkill).id);
    if (new Set(ids).size !== ids.length) {
      issues.push({ field: 'skills', message: 'skill ids must be unique' });
    }
  }
  if (card.capabilities !== undefined && typeof card.capabilities !== 'object') {
    issues.push({ field: 'capabilities', message: 'capabilities must be an object' });
  }
  let expired = false;
  if (card.validUntil !== undefined) {
    const until = new Date(card.validUntil);
    if (Number.isNaN(until.getTime())) {
      issues.push({ field: 'validUntil', message: 'validUntil must be ISO-8601' });
    } else if (until.getTime() <= now.getTime()) {
      expired = true;
      issues.push({ field: 'validUntil', message: 'card is expired' });
    }
  }
  if (card.tenants !== undefined) {
    if (!Array.isArray(card.tenants)) {
      issues.push({ field: 'tenants', message: 'tenants must be an array' });
    } else {
      card.tenants.forEach((tenant, i) => {
        if (!tenant || typeof tenant.tenantId !== 'string' || tenant.tenantId.trim().length === 0) {
          issues.push({ field: `tenants[${i}].tenantId`, message: 'tenantId must be a non-empty string' });
        }
        if (tenant?.url !== undefined && !isV11HttpUrl(tenant.url)) {
          issues.push({ field: `tenants[${i}].url`, message: 'tenant url must be an http(s) URL' });
        }
      });
      const tenantIds = card.tenants
        .filter((t) => t && typeof t.tenantId === 'string')
        .map((t) => (t as V11TenantInfo).tenantId);
      if (new Set(tenantIds).size !== tenantIds.length) {
        issues.push({ field: 'tenants', message: 'tenant ids must be unique' });
      }
    }
  }
  if (card.signature !== undefined) {
    const sig = card.signature;
    if (!sig || typeof sig.algorithm !== 'string' || typeof sig.keyId !== 'string' ||
        typeof sig.value !== 'string' || sig.value.length === 0) {
      issues.push({ field: 'signature', message: 'signature must carry algorithm, keyId and a non-empty value' });
    }
    if (sig && typeof sig.signedAt === 'string') {
      const signedAt = new Date(sig.signedAt);
      if (Number.isNaN(signedAt.getTime())) {
        issues.push({ field: 'signature.signedAt', message: 'signedAt must be ISO-8601' });
      } else if (signedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
        issues.push({ field: 'signature.signedAt', message: 'signature is from the future (clock skew > 5m)' });
      }
    }
  }
  return { valid: issues.length === 0, issues, protocolVersion, expired };
}

/** True when a card passes structural validation (not trust!). */
export function isV11CardStructurallyValid(input: unknown, now: Date = new Date()): boolean {
  return validateV11AgentCard(input, now).valid;
}

/** Outcome of negotiating a protocol version with a peer. */
export interface V11NegotiationResult {
  /** Agreed version, or undefined when no common version exists. */
  version?: string;
  /** Versions the peer offered (from its card). */
  peerVersions: string[];
  /** Versions we offered. */
  ourVersions: readonly string[];
  /** True when the peer's primary version is newer than ours. */
  peerIsNewer: boolean;
  reason?: string;
}

/**
 * Negotiate the protocol version: pick the newest version BOTH sides
 * support. Our list is newest-first; the peer's `supportedVersions`
 * (falling back to its single `protocolVersion`) is honoured in the
 * peer's own order only as a tiebreak — newest common wins.
 */
export function negotiateV11ProtocolVersion(
  peerCard: V11AgentCard,
  ourVersions: readonly string[] = V11_SUPPORTED_PROTOCOL_VERSIONS,
): V11NegotiationResult {
  const peerVersions =
    peerCard.supportedVersions && peerCard.supportedVersions.length > 0
      ? [...peerCard.supportedVersions]
      : [peerCard.protocolVersion];
  const peerIsNewer =
    peerVersions.length > 0 &&
    !ourVersions.includes(peerVersions[0] as string) &&
    peerVersions[0] !== V11_PROTOCOL_VERSION_1_0_0 &&
    peerVersions[0] !== V11_PROTOCOL_VERSION;
  for (const ours of ourVersions) {
    if (peerVersions.includes(ours)) {
      return { version: ours, peerVersions, ourVersions, peerIsNewer };
    }
  }
  return {
    peerVersions,
    ourVersions,
    peerIsNewer,
    reason: `no common protocol version (peer: ${peerVersions.join(', ')}; ours: ${[...ourVersions].join(', ')})`,
  };
}

/**
 * Downgrade a 1.0.1 card to its 1.0.0 view: 1.0.0 peers never see
 * `supportedVersions` entries above 1.0.0 and never see ListTasks
 * advertised via capabilities. The card itself is untouched (a copy
 * is returned); a downgraded card must be re-signed by the caller.
 */
export function downgradeV11CardTo100(card: V11AgentCard): V11AgentCard {
  const copy: V11AgentCard = JSON.parse(JSON.stringify(card)) as V11AgentCard;
  copy.protocolVersion = V11_PROTOCOL_VERSION_1_0_0;
  copy.supportedVersions = (copy.supportedVersions ?? [copy.protocolVersion]).filter(
    (v) => v === V11_PROTOCOL_VERSION_1_0_0,
  );
  delete copy.signature;
  return copy;
}

/**
 * Derive the card view for one tenant: the tenant's own URL wins,
 * `tenantId` is stamped, and other tenants are dropped so a tenant
 * never learns about its neighbours.
 */
export function v11CardForTenant(card: V11AgentCard, tenantId: string): V11AgentCard | undefined {
  const tenant = (card.tenants ?? []).find((t) => t.tenantId === tenantId);
  if (!tenant && (card.tenants ?? []).length > 0) return undefined;
  const view: V11AgentCard = { ...card, tenantId };
  delete view.tenants;
  delete view.signature; // tenant views must be re-signed by the caller
  if (tenant?.url) view.url = tenant.url;
  return view;
}

/** Find a skill on a card by id. */
export function v11FindSkill(card: V11AgentCard, skillId: string): V11AgentSkill | undefined {
  return card.skills.find((s) => s.id === skillId);
}

/** One-line human summary of a card (safe to show in UI / logs). */
export function summarizeV11AgentCard(card: V11AgentCard): string {
  const skills = card.skills.map((s) => s.id).join(', ') || 'no skills';
  const tenant = card.tenantId ? ` tenant=${card.tenantId}` : '';
  const signed = card.signature ? ' signed' : ' unsigned';
  return `${card.name} v${card.version ?? '?'} (${card.protocolVersion})${tenant}${signed} — ${skills}`;
}
