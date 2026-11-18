/**
 * Fleet topology v23 (v1.36, Đội T6) — hình học của fleet: region /
 * zone / failure domain + bot group.
 *
 * Fleet v21 biết node và đặt run lên node (bin-packing + affinity /
 * anti-affinity ở mức RUN). Fleet v22 biết user/computer và điều phối
 * việc (delegation/handoff). Cả hai đều không biết fleet TRÔNG như thế
 * nào: node nào nằm chung zone, bot nào phải ở gần nhau, bot nào KHÔNG
 * được ở chung máy, một zone chết thì mất bao nhiêu bot. Module này
 * giữ hình học đó — thuần, không spawn gì thật.
 *
 * - Zone: một failure domain (một rack / một VM host / một region
 *   cloud). Node thuộc đúng 1 zone. Zone chết → mọi node trong zone
 *   chết theo (mô hình hoá, host thật báo zone chết).
 * - Bot group: tập bot có quan hệ với nhau. Mỗi group có:
 *   - `spreadMinZones`: bot trong group phải trải trên ít nhất N zone
 *     (chống mất cả group khi 1 zone chết).
 *   - `affinityBotIds`: bot phải đặt CHUNG node/zone với nhau (vd
 *     bot viết + bot review cùng dữ liệu local) — mức group, không
 *     phải mức run như v21.
 *   - `antiAffinityBotIds`: bot KHÔNG được đặt chung node với nhau
 *     (vd 2 bản sao của cùng một dịch vụ — 1 node chết không mất cả 2).
 * - Topology: tập zone + ánh xạ node → zone + tập group. Hàm ở đây
 *   kiểm tra spread, liệt kê vi phạm affinity/anti-affinity của một
 *   placement (botId → nodeId), và tính thiệt hại khi một zone chết
 *   (bao nhiêu bot mất, group nào mất quorum).
 *
 * Placement v2 (`placementV2.ts`) và rebalance v2 (`rebalanceV2.ts`)
 * dùng topology này làm ràng buộc cứng; module này chỉ giữ luật.
 */

/** Một zone — một failure domain. */
export interface FleetV23Zone {
  /** Id zone, vd `zone-a`. */
  id: string;
  /** Region chứa zone (vd `hcm`, `sin`, `local`). */
  region: string;
  /** Tên hiển thị. */
  name: string;
  /** Ghi chú (vd `rack 3 — chung nguồn điện với zone-b`). */
  note?: string;
}

/** Một bot group — tập bot có quan hệ placement với nhau. */
export interface FleetV23BotGroup {
  /** Id group. */
  id: string;
  /** Tên hiển thị. */
  name: string;
  /** Bot thuộc group (ít nhất 1). */
  botIds: string[];
  /** Bot trong group phải trải trên ít nhất N zone (1 = không yêu cầu spread). */
  spreadMinZones: number;
  /** Bot phải đặt chung node với bot này (trong group) — cặp botId. */
  affinityPairs: [string, string][];
  /** Bot KHÔNG được đặt chung node với bot này — cặp botId. */
  antiAffinityPairs: [string, string][];
  /** Số bot tối thiểu còn chạy để group được coi là "sống" (quorum). */
  quorum: number;
}

/** Tạo zone mới. */
export function createFleetV23Zone(input: {
  id: string;
  region: string;
  name?: string;
  note?: string;
}): FleetV23Zone {
  return {
    id: input.id,
    region: input.region,
    name: input.name ?? input.id,
    ...(input.note ? { note: input.note } : {}),
  };
}

/** Tạo bot group mới (quorum mặc định = đa số bot trong group). */
export function createFleetV23BotGroup(input: {
  id: string;
  name?: string;
  botIds: string[];
  spreadMinZones?: number;
  affinityPairs?: [string, string][];
  antiAffinityPairs?: [string, string][];
  quorum?: number;
}): FleetV23BotGroup {
  const botIds = [...new Set(input.botIds)];
  return {
    id: input.id,
    name: input.name ?? input.id,
    botIds,
    spreadMinZones: input.spreadMinZones ?? 1,
    affinityPairs: (input.affinityPairs ?? []).map(([a, b]) => [a, b] as [string, string]),
    antiAffinityPairs: (input.antiAffinityPairs ?? []).map(([a, b]) => [a, b] as [string, string]),
    quorum: input.quorum ?? Math.max(1, Math.floor(botIds.length / 2) + 1),
  };
}

/** Validate zone từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23Zone(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['zone phải là object.'];
  const z = input as Record<string, unknown>;
  if (typeof z.id !== 'string' || z.id.trim().length === 0) errors.push('zone.id phải là chuỗi không rỗng.');
  if (typeof z.region !== 'string' || z.region.trim().length === 0) errors.push('zone.region phải là chuỗi không rỗng.');
  return errors;
}

/** Validate bot group từ dữ liệu ngoài (lỗi → danh sách). */
export function validateFleetV23BotGroup(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) return ['bot group phải là object.'];
  const g = input as Record<string, unknown>;
  if (typeof g.id !== 'string' || g.id.trim().length === 0) errors.push('group.id phải là chuỗi không rỗng.');
  if (!Array.isArray(g.botIds) || g.botIds.length === 0) {
    errors.push('group.botIds phải là mảng không rỗng.');
    return errors;
  }
  const bots = new Set(g.botIds as unknown[]);
  if (typeof g.spreadMinZones !== 'number' || !Number.isInteger(g.spreadMinZones) || (g.spreadMinZones as number) < 1) {
    errors.push('group.spreadMinZones phải là số nguyên >= 1.');
  }
  if ((g.spreadMinZones as number) > bots.size) {
    errors.push(`group.spreadMinZones (${g.spreadMinZones as number}) lớn hơn số bot trong group (${bots.size}) — không thể trải đủ.`);
  }
  const checkPairs = (field: string, label: string): void => {
    const pairs = g[field];
    if (pairs === undefined) return;
    if (!Array.isArray(pairs)) {
      errors.push(`group.${field} phải là mảng cặp [botA, botB].`);
      return;
    }
    for (const pair of pairs as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        errors.push(`group.${field} chứa cặp không hợp lệ (phải là [botA, botB]).`);
        continue;
      }
      const [a, b] = pair as [string, string];
      if (a === b) errors.push(`group.${field} có cặp tự trỏ chính mình ("${a}").`);
      if (!bots.has(a) || !bots.has(b)) {
        errors.push(`group.${field} cặp ("${a}", "${b}") có bot không thuộc group.`);
      }
    }
  };
  checkPairs('affinityPairs', 'affinity');
  checkPairs('antiAffinityPairs', 'anti-affinity');
  if (typeof g.quorum !== 'number' || !Number.isInteger(g.quorum) || (g.quorum as number) < 1) {
    errors.push('group.quorum phải là số nguyên >= 1.');
  }
  if (typeof g.quorum === 'number' && (g.quorum as number) > bots.size) {
    errors.push(`group.quorum (${g.quorum as number}) lớn hơn số bot trong group (${bots.size}).`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Topology: zone + node→zone + group
// ---------------------------------------------------------------------------

/** Topology của fleet: zone, ánh xạ node → zone, và các bot group. */
export interface FleetV23Topology {
  /** Zone trong fleet. */
  zones: FleetV23Zone[];
  /** Node → zone (node chưa gắn zone thì không có trong map). */
  nodeZones: ReadonlyMap<string, string>;
  /** Bot group trong fleet. */
  groups: FleetV23BotGroup[];
}

/** Tạo topology rỗng rồi thêm dần (bản sao mỗi lần, không mutate input). */
export function createFleetV23Topology(input: {
  zones?: FleetV23Zone[];
  nodeZones?: ReadonlyMap<string, string> | Record<string, string>;
  groups?: FleetV23BotGroup[];
} = {}): FleetV23Topology {
  const nodeZones =
    input.nodeZones instanceof Map
      ? new Map(input.nodeZones)
      : new Map(Object.entries(input.nodeZones ?? {}));
  return {
    zones: [...(input.zones ?? [])],
    nodeZones,
    groups: [...(input.groups ?? [])],
  };
}

/** Thêm zone (id trùng → throw). */
export function topologyAddZone(topology: FleetV23Topology, zone: FleetV23Zone): FleetV23Topology {
  if (topology.zones.some((z) => z.id === zone.id)) {
    throw new Error(`Zone "${zone.id}" đã có trong topology.`);
  }
  return { ...topology, zones: [...topology.zones, structuredClone(zone)] };
}

/** Gắn node vào zone (zone chưa có → throw; trả topology mới). */
export function topologyAssignNode(
  topology: FleetV23Topology,
  nodeId: string,
  zoneId: string,
): FleetV23Topology {
  if (!topology.zones.some((z) => z.id === zoneId)) {
    throw new Error(`Zone "${zoneId}" chưa có trong topology — thêm zone trước khi gắn node "${nodeId}".`);
  }
  const nodeZones = new Map(topology.nodeZones);
  nodeZones.set(nodeId, zoneId);
  return { ...topology, nodeZones };
}

/** Thêm bot group (id trùng → throw; group lỗi validate → throw). */
export function topologyAddGroup(topology: FleetV23Topology, group: FleetV23BotGroup): FleetV23Topology {
  if (topology.groups.some((g) => g.id === group.id)) {
    throw new Error(`Bot group "${group.id}" đã có trong topology.`);
  }
  const errors = validateFleetV23BotGroup(group);
  if (errors.length > 0) throw new Error(`Bot group "${group.id}" không hợp lệ: ${errors.join(' ')}`);
  return { ...topology, groups: [...topology.groups, structuredClone(group)] };
}

/** Zone của một node (undefined khi node chưa gắn zone). */
export function topologyZoneOfNode(topology: FleetV23Topology, nodeId: string): string | undefined {
  return topology.nodeZones.get(nodeId);
}

/** Node trong một zone. */
export function topologyNodesInZone(topology: FleetV23Topology, zoneId: string): string[] {
  return [...topology.nodeZones.entries()]
    .filter(([, z]) => z === zoneId)
    .map(([n]) => n)
    .sort();
}

/** Group chứa một bot (undefined khi bot không thuộc group nào). */
export function topologyGroupOfBot(topology: FleetV23Topology, botId: string): FleetV23BotGroup | undefined {
  return topology.groups.find((g) => g.botIds.includes(botId));
}

/** Số zone trong topology. */
export function topologyZoneCount(topology: FleetV23Topology): number {
  return topology.zones.length;
}

// ---------------------------------------------------------------------------
// Kiểm tra placement theo topology
// ---------------------------------------------------------------------------

/** Placement: botId → nodeId. */
export type FleetV23Placement = ReadonlyMap<string, string> | Record<string, string>;

function placementNode(placement: FleetV23Placement, botId: string): string | undefined {
  return placement instanceof Map ? placement.get(botId) : (placement as Record<string, string>)[botId];
}

/** Một vi phạm topology của placement. */
export interface FleetV23TopologyViolation {
  /** Loại: bot chưa đặt / affinity vỡ / anti-affinity vỡ / spread thiếu. */
  kind: 'unplaced-bot' | 'affinity-broken' | 'anti-affinity-broken' | 'spread-short' | 'unknown-zone';
  groupId: string;
  /** Bot liên quan. */
  botIds: string[];
  /** Giải thích 1 dòng. */
  reason: string;
}

/**
 * Kiểm tra placement của MỘT group theo topology:
 * - bot chưa đặt (không có node) → vi phạm;
 * - affinity pair đặt khác node → vi phạm;
 * - anti-affinity pair đặt chung node → vi phạm;
 * - số zone bot trải qua < spreadMinZones → vi phạm;
 * - node của bot chưa gắn zone → vi phạm (không biết bot ở zone nào).
 */
export function checkFleetV23GroupPlacement(
  topology: FleetV23Topology,
  group: FleetV23BotGroup,
  placement: FleetV23Placement,
): FleetV23TopologyViolation[] {
  const violations: FleetV23TopologyViolation[] = [];
  const zonesSeen = new Set<string>();
  for (const botId of group.botIds) {
    const nodeId = placementNode(placement, botId);
    if (nodeId === undefined) {
      violations.push({
        kind: 'unplaced-bot',
        groupId: group.id,
        botIds: [botId],
        reason: `Bot "${botId}" trong group "${group.id}" chưa được đặt lên node nào.`,
      });
      continue;
    }
    const zoneId = topologyZoneOfNode(topology, nodeId);
    if (zoneId === undefined) {
      violations.push({
        kind: 'unknown-zone',
        groupId: group.id,
        botIds: [botId],
        reason: `Node "${nodeId}" (bot "${botId}") chưa gắn zone nào — không kiểm được spread/affinity theo zone.`,
      });
    } else {
      zonesSeen.add(zoneId);
    }
  }
  for (const [a, b] of group.affinityPairs) {
    const nodeA = placementNode(placement, a);
    const nodeB = placementNode(placement, b);
    if (nodeA !== undefined && nodeB !== undefined && nodeA !== nodeB) {
      violations.push({
        kind: 'affinity-broken',
        groupId: group.id,
        botIds: [a, b],
        reason: `Bot "${a}" (node "${nodeA}") và bot "${b}" (node "${nodeB}") phải chung node (affinity) nhưng đang khác node.`,
      });
    }
  }
  for (const [a, b] of group.antiAffinityPairs) {
    const nodeA = placementNode(placement, a);
    const nodeB = placementNode(placement, b);
    if (nodeA !== undefined && nodeB !== undefined && nodeA === nodeB) {
      violations.push({
        kind: 'anti-affinity-broken',
        groupId: group.id,
        botIds: [a, b],
        reason: `Bot "${a}" và bot "${b}" không được chung node (anti-affinity) nhưng cùng ở node "${nodeA}".`,
      });
    }
  }
  if (zonesSeen.size < group.spreadMinZones) {
    violations.push({
      kind: 'spread-short',
      groupId: group.id,
      botIds: [...group.botIds],
      reason: `Group "${group.id}" trải trên ${zonesSeen.size} zone, cần ít nhất ${group.spreadMinZones} zone.`,
    });
  }
  return violations;
}

/** Kiểm tra placement của TOÀN BỘ group trong topology. */
export function checkFleetV23TopologyPlacement(
  topology: FleetV23Topology,
  placement: FleetV23Placement,
): FleetV23TopologyViolation[] {
  return topology.groups.flatMap((g) => checkFleetV23GroupPlacement(topology, g, placement));
}

/** true khi placement không vi phạm topology nào. */
export function placementSatisfiesTopologyV23(
  topology: FleetV23Topology,
  placement: FleetV23Placement,
): boolean {
  return checkFleetV23TopologyPlacement(topology, placement).length === 0;
}

// ---------------------------------------------------------------------------
// Thiệt hại khi một zone chết
// ---------------------------------------------------------------------------

/** Thiệt hại khi một zone chết: bot nào mất, group nào mất quorum. */
export interface FleetV23ZoneFailureImpact {
  zoneId: string;
  /** Bot mất (đang đặt trên node thuộc zone chết). */
  lostBotIds: string[];
  /** Node chết theo zone. */
  lostNodeIds: string[];
  /** Group còn sống (bot còn lại >= quorum) / mất quorum. */
  groupsAlive: string[];
  groupsLostQuorum: string[];
  /** Bot còn sống trong toàn placement. */
  survivingBotIds: string[];
}

/**
 * Tính thiệt hại khi một zone chết: mọi node trong zone chết, mọi bot
 * trên các node đó mất. Group mất quorum khi bot còn lại < quorum.
 * Placement ngoài zone chết không đổi.
 */
export function zoneFailureImpactV23(
  topology: FleetV23Topology,
  placement: FleetV23Placement,
  zoneId: string,
): FleetV23ZoneFailureImpact {
  const lostNodeIds = topologyNodesInZone(topology, zoneId);
  const lostNodeSet = new Set(lostNodeIds);
  const allBotIds = topology.groups.flatMap((g) => g.botIds);
  const uniqueBotIds = [...new Set(allBotIds)];
  // Bot ngoài group cũng có thể đặt trong placement — tính luôn.
  const placedBotIds = placement instanceof Map ? [...placement.keys()] : Object.keys(placement);
  const everyBotId = [...new Set([...uniqueBotIds, ...placedBotIds])];
  const lostBotIds: string[] = [];
  const survivingBotIds: string[] = [];
  for (const botId of everyBotId) {
    const nodeId = placementNode(placement, botId);
    if (nodeId !== undefined && lostNodeSet.has(nodeId)) lostBotIds.push(botId);
    else if (nodeId !== undefined) survivingBotIds.push(botId);
  }
  const groupsAlive: string[] = [];
  const groupsLostQuorum: string[] = [];
  for (const group of topology.groups) {
    const surviving = group.botIds.filter((b) => survivingBotIds.includes(b)).length;
    if (surviving >= group.quorum) groupsAlive.push(group.id);
    else groupsLostQuorum.push(group.id);
  }
  return {
    zoneId,
    lostBotIds: lostBotIds.sort(),
    lostNodeIds: [...lostNodeIds].sort(),
    groupsAlive,
    groupsLostQuorum,
    survivingBotIds: survivingBotIds.sort(),
  };
}

/** Zone nào chết thì thiệt hại nặng nhất (nhiều bot mất nhất; hoà → zone id nhỏ hơn). */
export function worstZoneFailureV23(
  topology: FleetV23Topology,
  placement: FleetV23Placement,
): FleetV23ZoneFailureImpact | null {
  if (topology.zones.length === 0) return null;
  let worst: FleetV23ZoneFailureImpact | null = null;
  for (const zone of topology.zones) {
    const impact = zoneFailureImpactV23(topology, placement, zone.id);
    if (
      worst === null ||
      impact.lostBotIds.length > worst.lostBotIds.length ||
      (impact.lostBotIds.length === worst.lostBotIds.length &&
        impact.groupsLostQuorum.length > worst.groupsLostQuorum.length) ||
      (impact.lostBotIds.length === worst.lostBotIds.length &&
        impact.groupsLostQuorum.length === worst.groupsLostQuorum.length &&
        impact.zoneId.localeCompare(worst.zoneId) < 0)
    ) {
      worst = impact;
    }
  }
  return worst;
}

/** Tóm tắt topology: bao nhiêu zone/region/group, bot nào chưa thuộc group. */
export function summarizeFleetV23Topology(topology: FleetV23Topology): {
  zones: number;
  regions: number;
  nodes: number;
  groups: number;
  bots: number;
  regionNames: string[];
} {
  const regions = new Set(topology.zones.map((z) => z.region));
  const bots = new Set(topology.groups.flatMap((g) => g.botIds));
  return {
    zones: topology.zones.length,
    regions: regions.size,
    nodes: topology.nodeZones.size,
    groups: topology.groups.length,
    bots: bots.size,
    regionNames: [...regions].sort(),
  };
}
