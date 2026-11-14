// src/player/NpcTacticalAI.js
import { S, clamp } from '../core/State.js';
import { sfx } from '../core/AudioEngine.js';
import { refreshEntityTagWithHP } from '../core/EntityManager.js';

const SMART_GRID_R = 8;
const SMART_GRID_SIDE = SMART_GRID_R * 2 + 1; // 17
const SMART_TOTAL_CELLS = SMART_GRID_SIDE * SMART_GRID_SIDE; // 289
const SMART_CELL_SIZE = 1.4;

const _sAstarG = new Float32Array(SMART_TOTAL_CELLS);
const _sAstarF = new Float32Array(SMART_TOTAL_CELLS);
const _sAstarSurfY = new Float32Array(SMART_TOTAL_CELLS);
const _sAstarParent = new Int16Array(SMART_TOTAL_CELLS);
const _sAstarState = new Uint8Array(SMART_TOTAL_CELLS);

/* ---------- 1. ПОЛЬЗОВАТЕЛЬСКИЕ ФРАКЦИИ, ДИПЛОМАТИЯ И ИНТЕЛЛЕКТ ---------- */

export function ensureWorldFactionsList() {
  if (!S.worldSettings) S.worldSettings = {};
  if (!Array.isArray(S.worldSettings.factions)) {
    S.worldSettings.factions = [];
  }
  return S.worldSettings.factions;
}

export function getCustomFactionById(factionId) {
  if (!factionId) return null;
  const list = ensureWorldFactionsList();
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === factionId) return list[i];
  }
  return null;
}

export function getNpcIntelligence(npc) {
  const raw = npc?.aiModules?.navigation?.intelligence || 'smart';
  if (raw === 'dumb' || raw === 'low') return 'dumb';
  return 'smart';
}

export function isNpcSmart(npc) {
  return getNpcIntelligence(npc) === 'smart';
}

export function getRelationshipBetweenEntities(sourceEnt, targetEnt) {
  if (!sourceEnt || !targetEnt) return 'neutral';
  if (sourceEnt === targetEnt) return 'ally';

  const srcIsPlayer = !!(sourceEnt.isP || sourceEnt.isRemotePlayer);
  const tgtIsPlayer = !!(targetEnt.isP || targetEnt.isRemotePlayer);

  if (srcIsPlayer && tgtIsPlayer) return 'ally';

  if (sourceEnt.isCustomNPC) {
    const cmb = sourceEnt.aiModules?.combat;
    if (!cmb || !cmb.enabled || cmb.stance === 'neutral') return 'neutral';

    if (sourceEnt._aggroTarget === targetEnt) return 'hostile';

    const myFac = getCustomFactionById(cmb.faction);

    if (tgtIsPlayer) {
      if (myFac) {
        if (myFac.playerRelation === 'ally') return 'ally';
        if (myFac.playerRelation === 'hostile') return 'hostile';
        return 'neutral';
      }
      return cmb.stance === 'hostile' ? 'hostile' : 'neutral';
    }

    if (targetEnt.isCustomNPC) {
      const tgtCmb = targetEnt.aiModules?.combat;
      const tgtFac = getCustomFactionById(tgtCmb?.faction);

      if (myFac && tgtFac) {
        if (myFac.id === tgtFac.id) {
          return myFac.selfRelation || 'ally';
        }
        const rel =
          (myFac.relations && myFac.relations[tgtFac.id]) ||
          (tgtFac.relations && tgtFac.relations[myFac.id]) ||
          'neutral';
        return rel;
      }

      if (
        myFac &&
        myFac.playerRelation === 'ally' &&
        targetEnt._aggroTarget &&
        (targetEnt._aggroTarget.isP || targetEnt._aggroTarget.isRemotePlayer)
      ) {
        return 'hostile';
      }
    }
  }

  if (srcIsPlayer && targetEnt.isCustomNPC) {
    return getRelationshipBetweenEntities(targetEnt, sourceEnt);
  }

  return 'neutral';
}

export function areEntitiesAllied(a, b) {
  return getRelationshipBetweenEntities(a, b) === 'ally';
}

export function areEntitiesHostile(npc, target) {
  if (!npc || !target || npc === target) return false;
  if (target._deadCooldown > 0) return false;
  if (target.isP && S.playerDead) return false;
  return getRelationshipBetweenEntities(npc, target) === 'hostile';
}

export function broadcastFactionCallForHelp(victimEnt, attacker, radius = 28) {
  if (!victimEnt || !attacker || victimEnt === attacker) return;
  for (let i = 0; i < S.customNPCs.length; i++) {
    const ally = S.customNPCs[i];
    if (!ally || ally === victimEnt || ally === attacker || ally._deadCooldown > 0) continue;
    if (!isNpcSmart(ally)) continue;

    const allyCmb = ally.aiModules?.combat;
    if (!allyCmb || !allyCmb.enabled || allyCmb.stance === 'neutral' || allyCmb.callForHelp === false) continue;
    if (!areEntitiesAllied(ally, victimEnt)) continue;
    if (areEntitiesAllied(ally, attacker)) continue;

    const d = Math.hypot(ally.x - victimEnt.x, ally.z - victimEnt.z);
    if (d <= radius) {
      const victimLowHp = victimEnt.hpEnabled && (victimEnt.hp / Math.max(1, victimEnt.maxHp)) < 0.55;
      if (!ally._aggroTarget || victimLowHp) {
        ally._aggroTarget = attacker;
        ally._aggroTimer = 14.0;
        if (!ally.chatT || ally.chatT <= 0) {
          ally.chat = '🛡️ Держись, иду на помощь!';
          ally.chatT = 2.6;
          refreshEntityTagWithHP(ally);
        }
      }
    }
  }
}

/* ---------- 2. ПОИСК ЦЕЛЕЙ, ОЦЕНКА УГРОЗЫ И БОЕВЫЕ РОЛИ ---------- */

export function classifyNpcTacticalRole(npc) {
  const cmb = npc.aiModules?.combat;
  const held = (cmb?.useEquippedWeapon !== false && npc.equippedItem) ? npc.equippedItem : null;
  if (held && (held.useType === 'ranged' || held.useType === 'throwable')) {
    return 'ranged';
  }
  const armor = Number(held?.equipStats?.armorPct) || 0;
  const maxHp = Number(npc.maxHp) || 100;
  if (maxHp >= 115 || armor >= 15 || held?.useType === 'shield' || held?.useType === 'melee') {
    return 'tank';
  }
  return 'melee';
}

export function estimateEntityCombatPower(ent) {
  if (!ent || ent._deadCooldown > 0 || (ent.isP && S.playerDead)) return 0;
  const hp = ent.hpEnabled ? Math.max(10, Number(ent.hp) || 100) : 250;
  let item = null;
  if (ent.isP && Array.isArray(ent.inventory)) {
    item = ent.inventory[S.activeSlot] || null;
  } else {
    item = ent.equippedItem || null;
  }
  let dps = Number(ent.meleeDamage) || 15;
  if (item) {
    if (item.useType === 'ranged' || item.useType === 'throwable') {
      const cd = Math.max(0.2, Number(item.cooldown) || 0.45);
      dps = ((Number(item.damage) || 25) / cd) * 1.25;
    } else if (item.useType === 'melee') {
      const cd = Math.max(0.25, Number(item.cooldown) || 0.5);
      dps = (Number(item.damage) || 25) / cd;
    }
  }
  const armorPct = clamp(Number(item?.equipStats?.armorPct) || 0, 0, 80);
  const effectiveHp = hp / (1 - armorPct / 100);
  return effectiveHp * 0.65 + dps * 2.2;
}

export function acquireBestTargetForNpc(npc) {
  const cmb = npc.aiModules?.combat;
  if (!cmb || !cmb.enabled || cmb.stance === 'neutral') return null;

  const smart = isNpcSmart(npc);
  const myRole = classifyNpcTacticalRole(npc);
  const aggroRad = Math.max(3, Number(cmb.aggroRadius) || 14);
  const loseRad = Math.max(aggroRad + 6, Number(cmb.loseAggroRadius) || 28);

  const candidates = [];
  if (S.player && !S.playerDead && S.player.hp > 0) candidates.push(S.player);
  const remotes = Object.values(S.remotePlayers || {});
  for (let i = 0; i < remotes.length; i++) {
    const rp = remotes[i];
    if (rp && rp.rig?.g?.visible && (rp.hp === undefined || rp.hp > 0)) candidates.push(rp);
  }
  for (let i = 0; i < S.customNPCs.length; i++) {
    const other = S.customNPCs[i];
    if (other && other !== npc && !(other._deadCooldown > 0)) candidates.push(other);
  }

  if (smart && cmb.callForHelp !== false) {
    for (let i = 0; i < S.customNPCs.length; i++) {
      const ally = S.customNPCs[i];
      if (!ally || ally === npc || ally._deadCooldown > 0) continue;
      if (!areEntitiesAllied(npc, ally)) continue;
      const dAlly = Math.hypot(ally.x - npc.x, ally.z - npc.z);
      if (dAlly <= aggroRad * 1.5 && ally._aggroTarget && !areEntitiesAllied(npc, ally._aggroTarget)) {
        const enemy = ally._aggroTarget;
        const enemyValid = !(enemy._deadCooldown > 0) && !(enemy.isP && S.playerDead);
        if (enemyValid) {
          const allyRole = classifyNpcTacticalRole(ally);
          const allyWounded = ally.hpEnabled && (ally.hp / Math.max(1, ally.maxHp)) < 0.45;
          if (myRole === 'tank' && (allyRole === 'ranged' || allyWounded)) {
            npc._aggroTarget = enemy;
            npc._aggroTimer = 10.0;
            npc._interceptingForAlly = ally;
            return enemy;
          }
          if (!npc._aggroTarget) {
            npc._aggroTarget = enemy;
            npc._aggroTimer = 8.0;
          }
        }
      }
    }
  }

  npc._interceptingForAlly = null;

  if (npc._aggroTarget) {
    const cur = npc._aggroTarget;
    const isDead =
      (cur._deadCooldown > 0) ||
      (cur.isP && (S.playerDead || cur.hp <= 0)) ||
      (cur.isRemotePlayer && (!S.remotePlayers[cur.peerId] || !cur.rig?.g?.visible || cur.hp <= 0)) ||
      areEntitiesAllied(npc, cur);
    const dist = Math.hypot(cur.x - npc.x, cur.z - npc.z);
    if (isDead || dist > loseRad) {
      npc._aggroTarget = null;
      npc._aggroTimer = 0;
    } else if (!smart) {
      return cur;
    }
  }

  let bestTarget = npc._aggroTarget || null;
  let bestScore = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (!areEntitiesHostile(npc, cand)) continue;
    const d3D = Math.hypot(cand.x - npc.x, (cand.y - npc.y) * 0.5, cand.z - npc.z);
    const maxAllowedDist = (cand === npc._aggroTarget) ? loseRad : aggroRad;
    if (d3D > maxAllowedDist) continue;

    if (!smart) {
      const score = -d3D;
      if (score > bestScore) {
        bestScore = score;
        bestTarget = cand;
      }
    } else {
      let score = -d3D * 1.1;
      if (cand === npc._aggroTarget) score += 4.0;
      if (cand.hpEnabled && cand.maxHp > 0 && (cand.hp / cand.maxHp) < 0.35) {
        score += 6.5;
      }
      if (myRole === 'tank') {
        for (let j = 0; j < S.customNPCs.length; j++) {
          const al = S.customNPCs[j];
          if (al && al !== npc && !(al._deadCooldown > 0) && areEntitiesAllied(npc, al)) {
            if (classifyNpcTacticalRole(al) === 'ranged' && Math.hypot(cand.x - al.x, cand.z - al.z) < 5.2) {
              score += 12.0;
              npc._interceptingForAlly = al;
              break;
            }
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestTarget = cand;
      }
    }
  }

  if (bestTarget) {
    npc._aggroTarget = bestTarget;
    npc._aggroTimer = Math.max(npc._aggroTimer || 0, 6.0);
  }
  return bestTarget;
}

/* ---------- 3. ПОШАГОВЫЙ ПОДЪЁМ ПО СТУПЕНЬКАМ И ОБХОД КУБОВ БЕЗ ЗАЦИКЛИВАНИЯ ---------- */

function findPlatformBlockUnderPoint(wx, wy, wz) {
  let bestBlk = null;
  let bestScore = Infinity;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b._depletedDisabled || b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (wx + 0.75 < b.x0 || wx - 0.75 > b.x1 || wz + 0.75 < b.z0 || wz - 0.75 > b.z1) continue;
    const diffY = Math.abs(b.y1 - wy);
    if (diffY < 2.2) {
      const dx = Math.max(0, b.x0 - wx, wx - b.x1);
      const dz = Math.max(0, b.z0 - wz, wz - b.z1);
      const score = diffY + Math.hypot(dx, dz) * 2.0;
      if (score < bestScore) {
        bestScore = score;
        bestBlk = b;
      }
    }
  }
  return bestBlk;
}

// Проверяет, нет ли НАД поверхностью блока (wx, topY, wz) потолка (соседние сбоку ступеньки НЕ считаются потолком!)
function hasHeadroomAbove(wx, topY, wz, ignoreBlock = null) {
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b === ignoreBlock || b._depletedDisabled || b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    // Только если сама точка (wx, wz) реально находится внутри контура блока b (с отступом 0.08м внутрь)
    if (wx <= b.x0 + 0.08 || wx >= b.x1 - 0.08 || wz <= b.z0 + 0.08 || wz >= b.z1 - 0.08) continue;
    if (b.y0 < topY + 2.1 && b.y1 > topY + 0.45) return false;
  }
  return true;
}

function getBlocksXZDistance(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dz = Math.max(0, a.z0 - b.z1, b.z0 - a.z1);
  return Math.hypot(dx, dz);
}

function getClosestPointOnBlockXZ(blk, fromX, fromZ, inset = 0.35) {
  const cx = (blk.x0 + blk.x1) * 0.5;
  const cz = (blk.z0 + blk.z1) * 0.5;
  const minX = Math.min(cx, blk.x0 + inset);
  const maxX = Math.max(cx, blk.x1 - inset);
  const minZ = Math.min(cz, blk.z0 + inset);
  const maxZ = Math.max(cz, blk.z1 - inset);
  return {
    x: clamp(fromX, minX, maxX),
    z: clamp(fromZ, minZ, maxZ)
  };
}

// Проверяет, находится ли NPC уже на верхней грани блока blk
function isNpcOnBlockSurface(npc, blk, supportY) {
  if (!blk) return false;
  const margin = 0.38;
  if (npc.x < blk.x0 - margin || npc.x > blk.x1 + margin || npc.z < blk.z0 - margin || npc.z > blk.z1 + margin) {
    return false;
  }
  return Math.abs(supportY - blk.y1) <= 0.52 || (npc.y >= blk.y1 - 0.25 && npc.y <= blk.y1 + 1.6);
}

function segmentIntersectsRectXZ(x1, z1, x2, z2, minX, maxX, minZ, maxZ) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const p = [-dx, dx, -dz, dz];
  const q = [x1 - minX, maxX - x1, z1 - minZ, maxZ - z1];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-6) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

// Находит открытую точку входа перед первой ступенькой (с той стороны, где нет второй ступеньки и стены куба)
function findBestOpenApproachForFirstStep(npc, stepBlk, groundY) {
  const cx = (stepBlk.x0 + stepBlk.x1) * 0.5;
  const cz = (stepBlk.z0 + stepBlk.z1) * 0.5;
  const distOut = 0.85;

  const sides = [
    { x: cx, z: stepBlk.z1 + distOut },
    { x: cx, z: stepBlk.z0 - distOut },
    { x: stepBlk.x1 + distOut, z: cz },
    { x: stepBlk.x0 - distOut, z: cz }
  ];

  let bestSide = sides[0];
  let bestScore = Infinity;

  for (let i = 0; i < sides.length; i++) {
    const pt = sides[i];
    let blocked = false;
    for (let j = 0; j < S.allBlocks.length; j++) {
      const b = S.allBlocks[j];
      if (!b || b === stepBlk || b._depletedDisabled || b.matterState !== 'solid') continue;
      if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
      if (b.y1 > groundY + 0.55 && b.y0 < groundY + 2.3) {
        if (pt.x + 0.3 >= b.x0 && pt.x - 0.3 <= b.x1 && pt.z + 0.3 >= b.z0 && pt.z - 0.3 <= b.z1) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;
    const d = Math.hypot(pt.x - npc.x, pt.z - npc.z);
    if (d < bestScore) {
      bestScore = d;
      bestSide = pt;
    }
  }
  return bestSide;
}

// Обход вокруг высокого куба до точки входа на лестницу по внешним углам
function findHullCornerTowardsPoint(npc, goalX, goalZ, maxClimbH, supportY, ignoreStepBlk = null) {
  const dist = Math.hypot(goalX - npc.x, goalZ - npc.z);
  if (dist < 1.0) return { x: goalX, z: goalZ };

  let hullMinX = Infinity;
  let hullMaxX = -Infinity;
  let hullMinZ = Infinity;
  let hullMaxZ = -Infinity;
  let hitTallWall = false;

  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b === ignoreStepBlk || b._depletedDisabled || b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.y1 > supportY + maxClimbH && b.y0 < supportY + 2.2) {
      if (segmentIntersectsRectXZ(npc.x, npc.z, goalX, goalZ, b.x0 - 0.25, b.x1 + 0.25, b.z0 - 0.25, b.z1 + 0.25)) {
        hitTallWall = true;
        if (b.x0 < hullMinX) hullMinX = b.x0;
        if (b.x1 > hullMaxX) hullMaxX = b.x1;
        if (b.z0 < hullMinZ) hullMinZ = b.z0;
        if (b.z1 > hullMaxZ) hullMaxZ = b.z1;
      }
    }
  }

  if (!hitTallWall) return { x: goalX, z: goalZ };

  const pad = 1.25;
  const corners = [
    { x: hullMinX - pad, z: hullMinZ - pad },
    { x: hullMaxX + pad, z: hullMinZ - pad },
    { x: hullMaxX + pad, z: hullMaxZ + pad },
    { x: hullMinX - pad, z: hullMaxZ + pad }
  ];

  let bestCorner = { x: goalX, z: goalZ };
  let bestCost = Infinity;

  for (let i = 0; i < 4; i++) {
    const c1 = corners[i];
    const d1 = Math.hypot(c1.x - npc.x, c1.z - npc.z);
    if (d1 < 0.85) continue;

    const clearToC1 = !segmentIntersectsRectXZ(npc.x, npc.z, c1.x, c1.z, hullMinX + 0.05, hullMaxX - 0.05, hullMinZ + 0.05, hullMaxZ - 0.05);
    if (!clearToC1) continue;

    const clearC1ToGoal = !segmentIntersectsRectXZ(c1.x, c1.z, goalX, goalZ, hullMinX + 0.05, hullMaxX - 0.05, hullMinZ + 0.05, hullMaxZ - 0.05);
    if (clearC1ToGoal) {
      const cost = d1 + Math.hypot(goalX - c1.x, goalZ - c1.z);
      if (cost < bestCost) {
        bestCost = cost;
        bestCorner = c1;
      }
    } else {
      for (const step of [-1, 1]) {
        const c2 = corners[(i + step + 4) % 4];
        const cost = d1 + Math.hypot(c2.x - c1.x, c2.z - c1.z) + Math.hypot(goalX - c2.x, goalZ - c2.z);
        if (cost < bestCost) {
          bestCost = cost;
          bestCorner = c1;
        }
      }
    }
  }

  return bestCorner;
}

/**
 * Детерминированный планировщик подъёма по ступенькам:
 * Строит цепочку [Ступенька 1 -> Ступенька 2 -> ... -> Крыша куба] и ведёт бота по ней без колебаний!
 */
function computeDeterministicClimbStep(npc, rawTx, rawTy, rawTz, maxClimbH, maxJumpDist) {
  const supportY = npc._supportY !== undefined ? npc._supportY : npc.y;
  const goalBlock = findPlatformBlockUnderPoint(rawTx, rawTy, rawTz);
  if (!goalBlock || isNpcOnBlockSurface(npc, goalBlock, supportY)) {
    npc._elevPathCache = null;
    npc._targetStepBlock = null;
    npc._alignedWithFirstStep = false;
    return null;
  }

  const now = S.time || 0;
  let chain = null;

  if (
    npc._elevPathCache &&
    now - npc._elevPathCache.time < 1.2 &&
    npc._elevPathCache.goalBlock === goalBlock &&
    Array.isArray(npc._elevPathCache.chain) &&
    npc._elevPathCache.chain.length > 0
  ) {
    chain = npc._elevPathCache.chain;
  } else {
    const midX = (npc.x + rawTx) * 0.5;
    const midZ = (npc.z + rawTz) * 0.5;
    const searchR = Math.max(34, Math.hypot(rawTx - npc.x, rawTz - npc.z) + 16);

    const stepBlocks = [];
    for (let i = 0; i < S.allBlocks.length; i++) {
      const b = S.allBlocks[i];
      if (!b || b._depletedDisabled || b.matterState !== 'solid') continue;
      if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
      if (b.y1 < supportY - 2.0 || b.y1 > rawTy + maxClimbH + 0.5) continue;
      if (b.x1 < midX - searchR || b.x0 > midX + searchR || b.z1 < midZ - searchR || b.z0 > midZ + searchR) continue;
      stepBlocks.push(b);
    }
    if (!stepBlocks.includes(goalBlock)) stepBlocks.push(goalBlock);

    const N = stepBlocks.length;
    const goalIdx = stepBlocks.indexOf(goalBlock);

    if (goalIdx !== -1 && N <= 160) {
      const maxStepGapXZ = Math.min(3.6, Math.max(1.6, maxJumpDist * 0.72));
      const distFromGoal = new Float32Array(N).fill(Infinity);
      const nextStepUp = new Int16Array(N).fill(-1);
      const visited = new Uint8Array(N);

      distFromGoal[goalIdx] = 0;

      for (let iter = 0; iter < N; iter++) {
        let u = -1;
        let bestD = Infinity;
        for (let i = 0; i < N; i++) {
          if (!visited[i] && distFromGoal[i] < bestD) {
            bestD = distFromGoal[i];
            u = i;
          }
        }
        if (u === -1) break;
        visited[u] = 1;

        const upperBlk = stepBlocks[u];

        for (let v = 0; v < N; v++) {
          if (visited[v] || u === v) continue;
          const lowerBlk = stepBlocks[v];

          const stepH = upperBlk.y1 - lowerBlk.y1;
          const colShape = (!lowerBlk.colliderShape || lowerBlk.colliderShape === 'auto') ? lowerBlk.shape : lowerBlk.colliderShape;
          const effMaxClimb = colShape === 'wedge' ? maxClimbH + (lowerBlk.h || 1) * 0.85 : maxClimbH;

          if (stepH < -0.35 || stepH > effMaxClimb) continue;

          const xzGap = getBlocksXZDistance(lowerBlk, upperBlk);
          if (xzGap > maxStepGapXZ) continue;

          const testPt = getClosestPointOnBlockXZ(
            upperBlk,
            (lowerBlk.x0 + lowerBlk.x1) * 0.5,
            (lowerBlk.z0 + lowerBlk.z1) * 0.5,
            0.25
          );
          if (!hasHeadroomAbove(testPt.x, upperBlk.y1, testPt.z, upperBlk)) continue;

          const stepEdgeCost = xzGap + Math.max(0.2, stepH) * 1.4 + 0.8;
          if (distFromGoal[u] + stepEdgeCost < distFromGoal[v]) {
            distFromGoal[v] = distFromGoal[u] + stepEdgeCost;
            nextStepUp[v] = u;
          }
        }
      }

      let bestEntryIdx = -1;
      let bestTotalCost = Infinity;
      const groundLevel = npc._groundFloorY !== undefined ? npc._groundFloorY : supportY;

      for (let i = 0; i < N; i++) {
        if (distFromGoal[i] === Infinity) continue;
        const b = stepBlocks[i];
        const colShape = (!b.colliderShape || b.colliderShape === 'auto') ? b.shape : b.colliderShape;
        const entryClimbH = b.y1 - groundLevel;
        const maxEntryH = colShape === 'wedge' ? maxClimbH + (b.h || 1) * 0.9 : maxClimbH;

        if (entryClimbH > 0.25 && entryClimbH <= maxEntryH) {
          const appPt = getClosestPointOnBlockXZ(b, npc.x, npc.z, 0.25);
          if (!hasHeadroomAbove(appPt.x, b.y1, appPt.z, b)) continue;
          const walkDist = Math.hypot(appPt.x - npc.x, appPt.z - npc.z);
          const totalCost = walkDist + distFromGoal[i];
          if (totalCost < bestTotalCost) {
            bestTotalCost = totalCost;
            bestEntryIdx = i;
          }
        }
      }

      if (bestEntryIdx !== -1) {
        chain = [];
        let cur = bestEntryIdx;
        let safety = 0;
        while (cur !== -1 && safety++ < 25) {
          chain.push(stepBlocks[cur]);
          if (cur === goalIdx) break;
          cur = nextStepUp[cur];
        }
        npc._elevPathCache = {
          time: now,
          goalBlock,
          chain
        };
      }
    }
  }

  if (!chain || chain.length === 0) {
    npc._targetStepBlock = null;
    return null;
  }

  // Проверяем, на какой ступеньке из цепочки сейчас стоит NPC
  let standingIdx = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (isNpcOnBlockSurface(npc, chain[i], supportY)) {
      standingIdx = i;
      break;
    }
  }

  // СЛУЧАЙ А: Бот ещё на земле перед первой ступенькой
  if (standingIdx === -1) {
    npc._groundFloorY = supportY;
    const firstStep = chain[0];
    const stepCx = (firstStep.x0 + firstStep.x1) * 0.5;
    const stepCz = (firstStep.z0 + firstStep.z1) * 0.5;
    const openEntry = findBestOpenApproachForFirstStep(npc, firstStep, supportY);

    const distToEntry = Math.hypot(openEntry.x - npc.x, openEntry.z - npc.z);
    const distToStepCenter = Math.hypot(stepCx - npc.x, stepCz - npc.z);

    // ФИКСАЦИЯ (ГИСТЕРЕЗИС): Как только бот подошёл к открытой точке входа ближе 0.9м,
    // фиксируем захват ступеньки (_alignedWithFirstStep = true) и больше НЕ переключаемся назад!
    if (distToEntry <= 0.9) {
      npc._alignedWithFirstStep = true;
    } else if (distToStepCenter > 3.4) {
      npc._alignedWithFirstStep = false;
    }

    if (npc._alignedWithFirstStep) {
      npc._targetStepBlock = firstStep;
      return { x: stepCx, z: stepCz };
    }

    // Иначе идём к открытой точке входа перед первой ступенькой (огибая большой куб по внешнему углу, если нужно)
    npc._targetStepBlock = null;
    return findHullCornerTowardsPoint(npc, openEntry.x, openEntry.z, maxClimbH, supportY, firstStep);
  }

  // СЛУЧАЙ Б: Бот УЖЕ запрыгнул на ступеньку standingIdx!
  // Ведём его напрямую на следующую ступеньку standingIdx + 1 без каких-либо проверок A*!
  npc._alignedWithFirstStep = false;
  const nextIdx = Math.min(chain.length - 1, standingIdx + 1);
  const prevStep = chain[standingIdx];
  const nextStep = chain[nextIdx];
  npc._targetStepBlock = nextStep;

  if (nextStep === goalBlock) {
    const prevCx = (prevStep.x0 + prevStep.x1) * 0.5;
    const prevCz = (prevStep.z0 + prevStep.z1) * 0.5;
    return getClosestPointOnBlockXZ(goalBlock, prevCx, prevCz, 1.05);
  }

  return {
    x: (nextStep.x0 + nextStep.x1) * 0.5,
    z: (nextStep.z0 + nextStep.z1) * 0.5
  };
}

export function computeSmartNpcSubgoalAStar(
  npc,
  rawTx,
  rawTy,
  rawTz,
  probeColumnFn,
  perceivedJumpH,
  maxSafeDrop,
  canJump,
  jumpGaps
) {
  const climbLim = canJump ? perceivedJumpH : 0.62;
  const maxJumpDist = Math.min(8.5, (npc.walkSpeed || 5.4) * 0.9);
  const supportY = npc._supportY !== undefined ? npc._supportY : npc.y;

  // 1. Если цель находится выше нас на кубе — используем прямой пошаговый планировщик ступенек
  if (rawTy > supportY + 0.65 && canJump) {
    const climbStep = computeDeterministicClimbStep(npc, rawTx, rawTy, rawTz, climbLim, maxJumpDist);
    if (climbStep) {
      return climbStep;
    }
  } else {
    npc._targetStepBlock = null;
    npc._alignedWithFirstStep = false;
  }

  // 2. Если цель на одном уровне с нами, но путь перегорожен высокой стеной — огибаем угол стены
  const bypassGoal = findHullCornerTowardsPoint(npc, rawTx, rawTz, climbLim, supportY, null);
  const tx = bypassGoal.x;
  const tz = bypassGoal.z;

  const dxTotal = tx - npc.x;
  const dzTotal = tz - npc.z;
  const distTotal = Math.hypot(dxTotal, dzTotal);
  if (distTotal < 0.35) return { x: tx, z: tz };

  const dirX = dxTotal / distTotal;
  const dirZ = dzTotal / distTotal;

  // ВАЖНО: Не проверяем луч дальше, чем сама точка назначения distTotal!
  const d1 = Math.min(distTotal, 1.05);
  const d2 = Math.min(distTotal, 2.0);
  const pr1 = probeColumnFn(npc.x + dirX * d1, supportY, npc.z + dirZ * d1, 0.26, 2.4, climbLim, maxSafeDrop);
  const pr2 = probeColumnFn(npc.x + dirX * d2, pr1.surfaceY !== -Infinity ? pr1.surfaceY : supportY, npc.z + dirZ * d2, 0.26, 2.4, climbLim, maxSafeDrop);
  if (!pr1.wallBlocked && !pr1.isPit && !pr1.hasHazard && !pr2.wallBlocked && !pr2.isPit && !pr2.hasHazard) {
    return { x: tx, z: tz };
  }

  _sAstarState.fill(0);
  _sAstarParent.fill(-1);

  const startIdx = SMART_GRID_R * SMART_GRID_SIDE + SMART_GRID_R;
  _sAstarG[startIdx] = 0;
  _sAstarF[startIdx] = distTotal;
  _sAstarSurfY[startIdx] = supportY;
  _sAstarState[startIdx] = 1;

  let bestIdx = startIdx;
  let bestH = distTotal;
  let iterations = 0;

  while (iterations++ < 130) {
    let cur = -1;
    let minF = Infinity;
    for (let i = 0; i < SMART_TOTAL_CELLS; i++) {
      if (_sAstarState[i] === 1 && _sAstarF[i] < minF) {
        minF = _sAstarF[i];
        cur = i;
      }
    }
    if (cur === -1) break;
    _sAstarState[cur] = 2;

    const cz = Math.floor(cur / SMART_GRID_SIDE) - SMART_GRID_R;
    const cx = (cur % SMART_GRID_SIDE) - SMART_GRID_R;
    const wx = npc.x + cx * SMART_CELL_SIZE;
    const wz = npc.z + cz * SMART_CELL_SIZE;
    const curY = _sAstarSurfY[cur];

    const hXZ = Math.hypot(tx - wx, tz - wz);
    if (hXZ < bestH) {
      bestH = hXZ;
      bestIdx = cur;
    }
    if (hXZ <= SMART_CELL_SIZE * 0.9) {
      bestIdx = cur;
      break;
    }

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < -SMART_GRID_R || nx > SMART_GRID_R || nz < -SMART_GRID_R || nz > SMART_GRID_R) continue;

        const nIdx = (nz + SMART_GRID_R) * SMART_GRID_SIDE + (nx + SMART_GRID_R);
        if (_sAstarState[nIdx] === 2) continue;

        const nwx = npc.x + nx * SMART_CELL_SIZE;
        const nwz = npc.z + nz * SMART_CELL_SIZE;
        const pr = probeColumnFn(nwx, curY, nwz, 0.26, 2.4, climbLim, maxSafeDrop);

        if (pr.wallBlocked) continue;

        let stepCost = (dx !== 0 && dz !== 0) ? 1.42 : 1.0;
        let nextY = pr.surfaceY !== -Infinity ? pr.surfaceY : curY;

        if (pr.hasHazard) stepCost += 25.0;
        if (pr.needsJumpUp) {
          if (!canJump) continue;
          stepCost += 0.35 + pr.climbH * 0.2;
        } else if (pr.isSafeDrop) {
          stepCost += rawTy > supportY + 0.8 ? 4.5 : 0.3;
        } else if (pr.isPit) {
          if (canJump && jumpGaps) {
            const landX = nwx + dx * SMART_CELL_SIZE;
            const landZ = nwz + dz * SMART_CELL_SIZE;
            const landPr = probeColumnFn(landX, curY, landZ, 0.26, 2.4, climbLim, maxSafeDrop);
            if (!landPr.isPit && !landPr.wallBlocked && !landPr.hasHazard) {
              stepCost += 2.0;
              nextY = landPr.surfaceY !== -Infinity ? landPr.surfaceY : curY;
            } else {
              continue;
            }
          } else {
            continue;
          }
        }

        const tentativeG = _sAstarG[cur] + stepCost;
        if (_sAstarState[nIdx] !== 1 || tentativeG < _sAstarG[nIdx]) {
          _sAstarParent[nIdx] = cur;
          _sAstarG[nIdx] = tentativeG;
          _sAstarSurfY[nIdx] = nextY;
          _sAstarF[nIdx] = tentativeG + Math.hypot(tx - nwx, tz - nwz) / SMART_CELL_SIZE;
          _sAstarState[nIdx] = 1;
        }
      }
    }
  }

  if (bestIdx === startIdx) {
    return { x: tx, z: tz };
  }

  let trace = bestIdx;
  let prev = bestIdx;
  while (_sAstarParent[trace] !== -1 && _sAstarParent[trace] !== startIdx) {
    prev = trace;
    trace = _sAstarParent[trace];
  }
  const pickCell = prev !== startIdx ? prev : trace;
  const gz = Math.floor(pickCell / SMART_GRID_SIDE) - SMART_GRID_R;
  const gx = (pickCell % SMART_GRID_SIDE) - SMART_GRID_R;
  return {
    x: npc.x + gx * SMART_CELL_SIZE,
    z: npc.z + gz * SMART_CELL_SIZE
  };
}

/* ---------- 4. ТАКТИЧЕСКИЙ БОЕВОЙ ПЛАН ---------- */

function findNearestHealingSourceForNpc(npc, maxDist = 22.0) {
  let best = null;
  let bestD = maxDist;

  if (npc.aiModules?.worldPhysics?.canPickupItems !== false) {
    for (let i = 0; i < S.worldItems.length; i++) {
      const wi = S.worldItems[i];
      if (!wi || wi.pickupCooldown > 0) continue;
      if (wi.item?.useType === 'consumable' && (Number(wi.item.healAmount) || 0) > 0) {
        const d = Math.hypot(wi.x - npc.x, wi.z - npc.z);
        if (d < bestD) {
          bestD = d;
          best = { kind: 'world_item', x: wi.x, y: wi.y, z: wi.z, ref: wi };
        }
      }
    }
  }

  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b._depletedDisabled || b._interactionDisabled) continue;
    if (
      b.components?.interaction?.enabled &&
      b.interactionData?.actionType === 'health' &&
      b.interactionData?.healthMode === 'heal'
    ) {
      const bx = b.m.position.x;
      const bz = b.m.position.z;
      const d = Math.hypot(bx - npc.x, bz - npc.z);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'heal_block', x: bx, y: b.y1, z: bz, ref: b };
      }
    }
  }
  return best;
}

export function computeSmartTacticalCombatPlan(npc, activeTarget, attackDist, isRangedWeapon, dt) {
  const myRole = classifyNpcTacticalRole(npc);
  const hpRatio = npc.hpEnabled ? (npc.hp / Math.max(1, npc.maxHp)) : 1.0;
  const cmb = npc.aiModules?.combat;
  const fleeThreshold = cmb?.fleeLowHp ? clamp((Number(cmb.fleeHpPct) || 35) / 100, 0.1, 0.8) : 0.38;
  const isWounded = npc.hpEnabled && hpRatio <= fleeThreshold;

  const dxToEnemy = activeTarget.x - npc.x;
  const dzToEnemy = activeTarget.z - npc.z;
  const distXZ = Math.hypot(dxToEnemy, dzToEnemy) || 0.001;
  const supportY = npc._supportY !== undefined ? npc._supportY : npc.y;
  const heightDiff = Math.abs(activeTarget.y - supportY);
  const needsElevationClimb = !isRangedWeapon && (activeTarget.y - supportY > 1.25);

  const dirX = dxToEnemy / distXZ;
  const dirZ = dzToEnemy / distXZ;

  let mySquadPower = estimateEntityCombatPower(npc);
  const enemyPower = estimateEntityCombatPower(activeTarget);
  let frontlineTank = null;
  let bestTankScore = -Infinity;
  let healthyAlliesCount = 0;
  let myRankAmongMelee = 0;

  for (let i = 0; i < S.customNPCs.length; i++) {
    const al = S.customNPCs[i];
    if (!al || al === npc || al._deadCooldown > 0) continue;
    if (!areEntitiesAllied(npc, al)) continue;

    const dAl = Math.hypot(al.x - npc.x, al.z - npc.z);
    if (dAl <= 28.0) {
      mySquadPower += estimateEntityCombatPower(al);
      const alHpRatio = al.hpEnabled ? (al.hp / Math.max(1, al.maxHp)) : 1.0;
      if (alHpRatio > 0.45) {
        healthyAlliesCount++;
        const alRole = classifyNpcTacticalRole(al);
        if (alRole === 'tank' || alRole === 'melee') {
          const tankScore = (al.hp || 100) + (alRole === 'tank' ? 80 : 0) - Math.hypot(al.x - activeTarget.x, al.z - activeTarget.z) * 2;
          if (tankScore > bestTankScore) {
            bestTankScore = tankScore;
            frontlineTank = al;
          }
        }
      }
      if (myRole !== 'ranged' && classifyNpcTacticalRole(al) !== 'ranged' && al.id < npc.id) {
        myRankAmongMelee++;
      }
    }
  }

  if (npc._fieldBandageCd > 0) npc._fieldBandageCd = Math.max(0, npc._fieldBandageCd - dt);

  if (isWounded) {
    const healSrc = findNearestHealingSourceForNpc(npc, 22.0);
    if (healSrc) {
      if (healSrc.kind === 'world_item' && Math.hypot(healSrc.x - npc.x, healSrc.z - npc.z) < 2.2) {
        const healAmt = Math.max(20, Number(healSrc.ref.item?.healAmount) || 35);
        npc.hp = Math.min(npc.maxHp, npc.hp + healAmt);
        npc.hpBarTimer = 3.5;
        npc.chat = `🍗 Аптечка! +${healAmt} HP!`;
        npc.chatT = 2.8;
        const idx = S.worldItems.indexOf(healSrc.ref);
        if (idx >= 0) {
          if (healSrc.ref.group) S.worldItems[idx].group.parent?.remove(S.worldItems[idx].group);
          if (healSrc.ref.tag) S.worldItems[idx].tag.parent?.remove(S.worldItems[idx].tag);
          S.worldItems.splice(idx, 1);
        }
        sfx.cash?.();
        refreshEntityTagWithHP(npc);
      } else {
        return {
          tx: healSrc.x,
          ty: healSrc.y,
          tz: healSrc.z,
          shouldMove: true,
          canAttackNow: isRangedWeapon && distXZ <= attackDist,
          tacticalState: 'retreat_heal'
        };
      }
    }

    const safeBehindTank = frontlineTank && Math.hypot(activeTarget.x - npc.x, activeTarget.z - npc.z) > Math.hypot(activeTarget.x - frontlineTank.x, activeTarget.z - frontlineTank.z) + 2.0;
    if ((distXZ > 5.8 || safeBehindTank) && (npc._fieldBandageCd || 0) <= 0) {
      npc._fieldBandageCd = 6.5;
      const healAmt = Math.round(npc.maxHp * 0.28);
      npc.hp = Math.min(npc.maxHp, npc.hp + healAmt);
      npc.hpBarTimer = 3.5;
      npc.chat = `🩹 Перевязка в тылу (+${healAmt} HP)`;
      npc.chatT = 2.8;
      refreshEntityTagWithHP(npc);
    }

    if (frontlineTank) {
      const e2tX = frontlineTank.x - activeTarget.x;
      const e2tZ = frontlineTank.z - activeTarget.z;
      const e2tLen = Math.hypot(e2tX, e2tZ) || 1;
      const behindX = frontlineTank.x + (e2tX / e2tLen) * 4.8 - (e2tZ / e2tLen) * 1.6;
      const behindZ = frontlineTank.z + (e2tZ / e2tLen) * 4.8 + (e2tX / e2tLen) * 1.6;
      return {
        tx: behindX,
        ty: frontlineTank.y,
        tz: behindZ,
        shouldMove: Math.hypot(behindX - npc.x, behindZ - npc.z) > 1.2,
        canAttackNow: isRangedWeapon && distXZ <= attackDist,
        tacticalState: 'retreat_flank'
      };
    }

    return {
      tx: npc.x - dirX * 8.0,
      ty: npc.y,
      tz: npc.z - dirZ * 8.0,
      shouldMove: true,
      canAttackNow: isRangedWeapon && distXZ <= attackDist,
      tacticalState: 'retreat_flank'
    };
  }

  const isOutmatched = mySquadPower < enemyPower * 0.52 && healthyAlliesCount === 0;
  const enemyVulnerable = (activeTarget.reloadTimer && activeTarget.reloadTimer > 0.2) || (activeTarget.hpEnabled && activeTarget.hp / Math.max(1, activeTarget.maxHp) < 0.35);

  if (isOutmatched && !enemyVulnerable && !needsElevationClimb) {
    let distantAlly = null;
    let bestDistAlly = 45.0;
    for (let i = 0; i < S.customNPCs.length; i++) {
      const al = S.customNPCs[i];
      if (!al || al === npc || al._deadCooldown > 0 || !areEntitiesAllied(npc, al)) continue;
      const d = Math.hypot(al.x - npc.x, al.z - npc.z);
      if (d > 12.0 && d < bestDistAlly) {
        bestDistAlly = d;
        distantAlly = al;
      }
    }
    if (distantAlly) {
      if (!npc.chatT || npc.chatT <= 0) {
        npc.chat = '📢 Враг силён! Отступаю к своим!';
        npc.chatT = 2.8;
        refreshEntityTagWithHP(npc);
      }
      return {
        tx: distantAlly.x,
        ty: distantAlly.y,
        tz: distantAlly.z,
        shouldMove: true,
        canAttackNow: isRangedWeapon && distXZ <= attackDist,
        tacticalState: 'regroup'
      };
    }

    if (isRangedWeapon) {
      const safeRange = Math.max(7.5, attackDist * 0.85);
      if (distXZ < safeRange * 0.78) {
        return {
          tx: npc.x - dirX * 5.5,
          ty: npc.y,
          tz: npc.z - dirZ * 5.5,
          shouldMove: true,
          canAttackNow: true,
          tacticalState: 'kite'
        };
      }
    }
  }

  if (isRangedWeapon) {
    const optMinDist = Math.max(5.0, attackDist * 0.58);
    const optMaxDist = attackDist * 0.88;

    if (frontlineTank) {
      const e2tX = frontlineTank.x - activeTarget.x;
      const e2tZ = frontlineTank.z - activeTarget.z;
      const e2tLen = Math.hypot(e2tX, e2tZ) || 1;
      const sideSign = (npc.id.charCodeAt(npc.id.length - 1) % 2 === 0) ? 1 : -1;
      const formX = frontlineTank.x + (e2tX / e2tLen) * 4.2 - (e2tZ / e2tLen) * sideSign * 1.4;
      const formZ = frontlineTank.z + (e2tZ / e2tLen) * 4.2 + (e2tX / e2tLen) * sideSign * 1.4;
      const distFormToEnemy = Math.hypot(formX - activeTarget.x, formZ - activeTarget.z);

      if (distFormToEnemy <= attackDist * 0.96) {
        const dToSlot = Math.hypot(formX - npc.x, formZ - npc.z);
        return {
          tx: formX,
          ty: frontlineTank.y,
          tz: formZ,
          shouldMove: dToSlot > 1.15,
          canAttackNow: distXZ <= attackDist,
          tacticalState: 'backline_formation'
        };
      }
    }

    if (distXZ < optMinDist) {
      return {
        tx: npc.x - dirX * 5.0,
        ty: npc.y,
        tz: npc.z - dirZ * 5.0,
        shouldMove: true,
        canAttackNow: true,
        tacticalState: 'kite'
      };
    }

    return {
      tx: activeTarget.x,
      ty: activeTarget.y,
      tz: activeTarget.z,
      shouldMove: distXZ > optMaxDist,
      canAttackNow: distXZ <= attackDist,
      tacticalState: 'ranged_engage'
    };
  }

  if (npc._interceptingForAlly && !needsElevationClimb) {
    const al = npc._interceptingForAlly;
    const toAlX = al.x - activeTarget.x;
    const toAlZ = al.z - activeTarget.z;
    const toAlLen = Math.hypot(toAlX, toAlZ) || 1;
    const interceptDist = Math.min(1.6, toAlLen * 0.35);
    const intX = activeTarget.x + (toAlX / toAlLen) * interceptDist;
    const intZ = activeTarget.z + (toAlZ / toAlLen) * interceptDist;
    return {
      tx: intX,
      ty: activeTarget.y,
      tz: intZ,
      shouldMove: distXZ > attackDist * 0.82,
      canAttackNow: distXZ <= attackDist && heightDiff < 2.8,
      tacticalState: 'tank_intercept'
    };
  }

  let goalX = activeTarget.x;
  let goalZ = activeTarget.z;
  if (!needsElevationClimb && myRankAmongMelee > 0 && heightDiff < 1.8 && distXZ < 5.5) {
    const angleOffset = ((myRankAmongMelee % 2 === 1 ? 1 : -1) * Math.ceil(myRankAmongMelee / 2)) * 0.65;
    const baseAngle = Math.atan2(npc.z - activeTarget.z, npc.x - activeTarget.x) + angleOffset * 0.35;
    goalX = activeTarget.x + Math.cos(baseAngle) * (attackDist * 0.65);
    goalZ = activeTarget.z + Math.sin(baseAngle) * (attackDist * 0.65);
  }

  return {
    tx: goalX,
    ty: activeTarget.y,
    tz: goalZ,
    shouldMove: needsElevationClimb || distXZ > attackDist * 0.85,
    canAttackNow: distXZ <= attackDist && heightDiff < 3.0,
    tacticalState: 'frontline_engage'
  };
}

/* ---------- 5. МЕНЕДЖЕР БЕГА И СТАМИНЫ ---------- */

export function updateEntityStaminaAndSprint(ent, dt, wantsToSprint, isMoving) {
  if (ent.maxStamina === undefined) ent.maxStamina = 100;
  if (ent.stamina === undefined) ent.stamina = ent.maxStamina;
  if (ent.staminaExhausted === undefined) ent.staminaExhausted = false;

  const worldAllowSprint = S.worldSettings.allowSprint !== false;
  const worldDrainStamina = S.worldSettings.staminaDrainOnSprint !== false;
  const drainRate = Math.max(1, Number(S.worldSettings.staminaDrainRate) || 18);
  const regenRate = Math.max(1, Number(S.worldSettings.staminaRegenRate) || 15);
  const worldSprintMult = clamp(Number(S.worldSettings.sprintSpeedMultiplier) || 1.48, 1.1, 2.5);

  const entityCanSprint = ent.isP ? true : (ent.aiModules?.navigation?.canSprint !== false);
  const entitySprintMult = ent.isP
    ? worldSprintMult
    : clamp(Number(ent.aiModules?.navigation?.sprintMultiplier) || worldSprintMult, 1.1, 2.5);

  let canActuallySprint =
    worldAllowSprint &&
    entityCanSprint &&
    wantsToSprint &&
    isMoving &&
    !ent.inLiquid &&
    (ent.reloadTimer || 0) <= 0;

  if (worldDrainStamina) {
    if (ent.staminaExhausted) {
      canActuallySprint = false;
    } else if (ent.stamina <= 0.1) {
      ent.stamina = 0;
      ent.staminaExhausted = true;
      canActuallySprint = false;
    }
  }

  ent.isSprinting = canActuallySprint;

  if (canActuallySprint && worldDrainStamina) {
    const heavyMult = ent.carriedItem ? 1.35 : 1.0;
    ent.stamina = Math.max(0, ent.stamina - drainRate * heavyMult * dt);
    ent._staminaRegenDelay = 0.65;
    if (ent.stamina <= 0.05) {
      ent.stamina = 0;
      ent.staminaExhausted = true;
      ent.isSprinting = false;
    }
  } else {
    if (!worldDrainStamina) {
      ent.stamina = ent.maxStamina;
      ent.staminaExhausted = false;
    } else {
      if ((ent._staminaRegenDelay || 0) > 0) {
        ent._staminaRegenDelay = Math.max(0, ent._staminaRegenDelay - dt);
      } else if (ent.stamina < ent.maxStamina) {
        const restFactor = isMoving ? 0.82 : 1.35;
        ent.stamina = Math.min(ent.maxStamina, ent.stamina + regenRate * restFactor * dt);
        if (ent.staminaExhausted && ent.stamina >= ent.maxStamina * 0.22) {
          ent.staminaExhausted = false;
        }
      }
    }
  }

  return ent.isSprinting ? entitySprintMult : 1.0;
}

export function decideNpcSprintIntent(npc, activeTarget, moving, tacticalState) {
  if (!moving) return false;
  if (S.worldSettings.allowSprint === false) return false;
  if (npc.aiModules?.navigation?.canSprint === false) return false;

  const smart = isNpcSmart(npc);

  if (!smart) {
    return !!activeTarget;
  }

  if (!activeTarget) {
    if (npc.aiModules?.navigation?.mode === 'follow' && S.player) {
      const dP = Math.hypot(S.player.x - npc.x, S.player.z - npc.z);
      return dP > 9.0 && (npc.stamina ?? 100) > 45;
    }
    return false;
  }

  const dist = Math.hypot(activeTarget.x - npc.x, activeTarget.z - npc.z);
  const stamPct = (npc.stamina ?? 100) / Math.max(1, npc.maxStamina || 100);

  if (tacticalState === 'retreat_heal' || tacticalState === 'retreat_flank' || tacticalState === 'regroup') {
    return stamPct > 0.05;
  }
  if (tacticalState === 'tank_intercept' || tacticalState === 'kite') {
    return stamPct > 0.22;
  }
  if (tacticalState === 'frontline_engage') {
    if (dist > 3.0 && dist < 9.5) return stamPct > 0.32;
    return dist >= 9.5 && stamPct > 0.58;
  }
  if (tacticalState === 'backline_formation') {
    return stamPct > 0.42;
  }

  return false;
}