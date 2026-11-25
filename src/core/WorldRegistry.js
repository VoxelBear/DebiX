// src/core/WorldRegistry.js
import { S, clamp } from './State.js';
import { scene } from './SceneManager.js';
import { createBlockMaterial, syncBoxMaterialTiling, setMeshFrontSprite, createHaloSprite } from './TextureFactory.js';
import { makeTagSprite, updateTag, updateGroupRootHitbox } from './CharacterRig.js';
import { createDefaultParticleData, clearAllParticles } from './ParticleSystem.js';
import { createDefaultScriptData, resetAllScriptsRuntime, compileSandboxedScript, ensureScriptContainer } from './ScriptEngine.js';
import { buildBBModelGroup } from './BBModelLoader.js';
import {
  createDefaultStatusEffectsState,
  collectBurningLightCandidates,
  clearAllStatusEffectVisuals,
  resetAllStatusEffectsRuntime
} from './StatusEffects.js';
import {
  clearSurfaceWeatherLayer,
  resetSurfaceWeatherLayer
} from './SurfaceWeatherLayer.js';

const MAX_ACTIVE_POINT_LIGHTS = 12;
const pointLightPool = [];
const _vWorldLightPos = new THREE.Vector3();

export function removeBlockHalo(box) {
  if (box && box.haloSprite) {
    scene.remove(box.haloSprite);
    if (box.haloSprite.material) box.haloSprite.material.dispose();
    box.haloSprite = null;
  }
}

export function syncSceneVisibilityForMode(mode = S.state) {
  const isEdit = mode === 'edit';

  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || !b.m) continue;
    const isOff = Boolean(b.isDisabled || (!isEdit && b._depletedDisabled));
    const vis = !isOff && !(isEdit && b.editorHidden);
    b.m.visible = vis;
    if (b.bbmodelGroup) b.bbmodelGroup.visible = vis;
    if (b.cpVisualGroup) b.cpVisualGroup.visible = vis;
    if (b.haloSprite) b.haloSprite.visible = vis;
    if (b.emptyPivotHelper) {
      b.emptyPivotHelper.visible = isEdit && vis && !b.components?.geometry?.enabled;
    }
    updateBlockOBB(b);
  }

  for (let i = 0; i < S.customNPCs.length; i++) {
    const n = S.customNPCs[i];
    if (!n) continue;
    const isDead = !isEdit && (n._deadCooldown > 0 || n._permanentlyDead);
    const vis = !n.isDisabled && !isDead && !(isEdit && n.editorHidden);
    if (n.rig?.g) n.rig.g.visible = vis;
    if (n.tag) n.tag.visible = vis;
  }

  for (let i = 0; i < S.worldItems.length; i++) {
    const wi = S.worldItems[i];
    if (!wi) continue;
    const vis = !wi.isDisabled && !(isEdit && wi.editorHidden);
    if (wi.group) wi.group.visible = vis;
    if (wi.tag) wi.tag.visible = vis;
  }

  for (let i = 0; i < (S.emptyObjects || []).length; i++) {
    const emp = S.emptyObjects[i];
    if (!emp) continue;
    if (emp.helper) emp.helper.visible = isEdit && !emp.isDisabled && !emp.editorHidden;
  }
}

export function createBlockPivotHelperMesh() {
  const g = new THREE.Group();
  const mkMat = (col, op = 0.9) =>
    new THREE.MeshBasicMaterial({
      color: col,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: op
    });

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), mkMat('#56f0ff', 0.92));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 24), mkMat('#ffffff', 0.75));
  g.add(core, ring);

  const axX = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.02), mkMat('#ff4757', 0.9));
  axX.position.x = 0.13;
  const axY = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.02), mkMat('#00e676', 0.9));
  axY.position.y = 0.13;
  const axZ = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.26), mkMat('#00d2ff', 0.9));
  axZ.position.z = 0.13;
  g.add(axX, axY, axZ);

  g.traverse(o => {
    o.renderOrder = 998;
    o.userData.noCollider = true;
  });
  return g;
}

let _cachedWedgeGeo = null;
function getWedgeGeometry() {
  if (_cachedWedgeGeo) return _cachedWedgeGeo;
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, -0.5);
  shape.lineTo(0.5, -0.5);
  shape.lineTo(-0.5, 0.5);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    steps: 1
  });
  geo.center();
  geo.computeVertexNormals();
  _cachedWedgeGeo = geo;
  return geo;
}

export function createBlockGeometryByShape(shape = 'box') {
  if (shape === 'bbmodel') return new THREE.BufferGeometry();
  if (shape === 'none') return new THREE.SphereGeometry(0.28, 8, 8);
  if (shape === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
  if (shape === 'sphere') return new THREE.SphereGeometry(0.5, 20, 16);
  if (shape === 'cone') return new THREE.ConeGeometry(0.5, 1, 20);
  if (shape === 'torus') return new THREE.TorusGeometry(0.36, 0.14, 12, 24);
  if (shape === 'plane') return new THREE.BoxGeometry(1, 0.08, 1);
  if (shape === 'wedge') return getWedgeGeometry();
  return new THREE.BoxGeometry(1, 1, 1);
}

export function createDefaultLightData(defaultColor = '#56f0ff', autoVisual = false) {
  return {
    mode: autoVisual ? 'visual' : 'none',
    color: defaultColor || '#56f0ff',
    intensity: autoVisual ? 1.2 : 1.4,
    distance: 14,
    pulseSpeed: 0
  };
}

export function createDefaultLogicData() {
  return {
    tag: '',
    trigger: 'none',
    action: 'door_slide',
    targetTag: '',
    cost: 0,
    oneTimeBuy: true,
    unlocked: false,
    cooldown: 1.0,
    stayTime: 4.0,
    speed: 4.5,
    moveX: 0,
    moveY: 5,
    moveZ: 0,
    tpX: 0,
    tpY: 6,
    tpZ: 0,
    perkType: 'speed',
    rewardCash: 25,
    promptText: '',
    showBadge: true
  };
}

export function createDefaultInteractionData(box = null) {
  return {
    trigger: 'touch', // 'none' | 'touch' | 'radius' | 'keyE' | 'hit'
    radiusDist: 3.5,
    actionType: 'none', // 'none' | 'health' | 'teleport' | 'checkpoint' | 'impulse' | 'reward' | 'ghost_pass'
    healthMode: 'damage', // 'damage' | 'heal' | 'kill'
    healthAmount: box && box.damageOnContact > 0 ? box.damageOnContact : 25,
    healthTick: 0.5,
    tpMode: box && box.teleportToCheckpoint ? 'checkpoint' : 'coords', // 'coords' | 'target' | 'checkpoint'
    tpX: 0,
    tpY: 6,
    tpZ: 0,
    tpTargetTag: '',
    cpStage: box?.checkpointData?.stage || 1,
    cpTitle: box?.checkpointData?.title || 'Чекпоинт',
    cpCash: box?.checkpointData?.rewardCash ?? 50,
    cpSkip: box?.checkpointData?.skipSpots ?? 2,
    impulseX: 0,
    impulseY: 16,
    impulseZ: 0,
    rewardType: 'cash', // 'cash' | 'speed' | 'grav' | 'halo' | 'heal' | 'damage'
    rewardCash: 25,
    ghostTime: 4.0,
    consumeMode: 'infinite', // 'infinite' | 'charges' | 'destroy_instant'
    maxCharges: 3,
    chargesLeft: 3,
    costPerUse: 1,
    depleteAction: 'respawn', // 'respawn' | 'destroy' | 'disable'
    respawnTime: 5.0,
    cooldown: 0.8,
    showBadge: true,
    promptText: ''
  };
}

export function createDefaultMotionData(box = null) {
  const w = box ? (box.w || 4) : 4;
  const h = box ? (box.h || 4) : 4;
  const d = box ? (box.d || 4) : 4;
  return {
    triggerMode: 'signal', // 'signal' | 'self' | 'auto_loop'
    pivotMode: 'center',   // 'center' | 'left' | 'right' | 'bottom' | 'top' | 'front' | 'back' | 'custom'
    pivotX: 0,
    pivotY: 0,
    pivotZ: 0,
    loopMode: 'toggle',    // 'toggle' | 'auto_return' | 'step' | 'one_shot' | 'ping_pong' | 'loop'
    speed: 1.5,
    stayTime: 3.0,
    cooldown: 0.4,
    activeWaypointIdx: 0,
    waypoints: [
      {
        id: 'wp_' + Date.now(),
        name: 'Точка #1',
        dx: 0,
        dy: 0,
        dz: 0,
        rx: 0,
        ry: 90,
        rz: 0,
        sx: w,
        sy: h,
        sz: d
      }
    ]
  };
}

export function createDefaultSignalData(box = null) {
  return {
    tag: box?.logicData?.tag || '',
    targetTag: box?.logicData?.targetTag || '',
    signalAction: 'toggle_motion', // 'toggle_motion' | 'forward_motion' | 'reverse_motion' | 'trigger_target'
    selfAnim: 'lever_tilt',        // 'none' | 'lever_tilt' | 'button_press'
    animAngle: 35,
    animOffset: 0.15
  };
}

export function createDefaultCostData(box = null) {
  return {
    amount: box?.logicData?.cost || 50,
    oneTimeBuy: box?.logicData ? box.logicData.oneTimeBuy !== false : true,
    unlocked: false,
    showPriceBadge: true
  };
}

export function ensureBlockComponents(box, opts = {}) {
  if (!box) return null;
  if (!box.colliderShape) box.colliderShape = 'auto';
  if (!box.interactionData) box.interactionData = createDefaultInteractionData(box);
  if (!box.motionData) box.motionData = createDefaultMotionData(box);
  if (!box.signalData) box.signalData = createDefaultSignalData(box);
  if (!box.costData) box.costData = createDefaultCostData(box);
  if (!box.scriptData) box.scriptData = createDefaultScriptData('block');

  if (!box.components) {
    const isRawEmpty = !!opts.isRawEmpty;
    const isRawPrim = !!opts.isRawPrimitive;
    const lg = box.logicData || {};
    const hasCp = Boolean(box.checkpointData && box.checkpointData.enabled);
    const hasSp = Boolean(box.spawnerData && box.spawnerData.mode && box.spawnerData.mode !== 'none');
    const hasDmg = (Number(box.damageOnContact) || 0) > 0 || !!box.teleportToCheckpoint;

    const hasLegacyDoor = Boolean(lg.trigger && lg.trigger !== 'none' && lg.action === 'door_slide' && !lg.targetTag);
    const hasLegacySignal = Boolean((lg.tag && lg.tag.length > 0) || (lg.targetTag && lg.targetTag.length > 0));
    const hasLegacyCost = (Number(lg.cost) || 0) > 0;
    const hasLegacyInteract = Boolean(hasCp || hasDmg || (lg.trigger && lg.trigger !== 'none'));

    if (hasCp) {
      box.interactionData.trigger = 'touch';
      box.interactionData.actionType = 'checkpoint';
      box.interactionData.cpStage = box.checkpointData.stage || 1;
      box.interactionData.cpTitle = box.checkpointData.title || 'Чекпоинт';
      box.interactionData.cpCash = box.checkpointData.rewardCash ?? 50;
      box.interactionData.cpSkip = box.checkpointData.skipSpots ?? 2;
    } else if (hasDmg) {
      box.interactionData.trigger = 'touch';
      box.interactionData.actionType = 'health';
      box.interactionData.healthMode = 'damage';
      box.interactionData.healthAmount = Number(box.damageOnContact) || 25;
    } else if (lg.trigger && lg.trigger !== 'none') {
      box.interactionData.trigger = lg.trigger;
      box.interactionData.promptText = lg.promptText || '';
      box.interactionData.showBadge = lg.showBadge !== false;
      box.interactionData.cooldown = lg.cooldown ?? 1.0;
      if (lg.action === 'teleport') {
        box.interactionData.actionType = 'teleport';
        box.interactionData.tpMode = lg.targetTag ? 'target' : 'coords';
        box.interactionData.tpTargetTag = lg.targetTag || '';
        box.interactionData.tpX = lg.tpX ?? 0;
        box.interactionData.tpY = lg.tpY ?? 6;
        box.interactionData.tpZ = lg.tpZ ?? 0;
      } else if (lg.action === 'buy_perk') {
        box.interactionData.actionType = 'reward';
        box.interactionData.rewardType = lg.perkType || 'speed';
      } else if (lg.action === 'give_cash') {
        box.interactionData.actionType = 'reward';
        box.interactionData.rewardType = 'cash';
        box.interactionData.rewardCash = lg.rewardCash || 25;
      } else if (lg.action === 'door_ghost') {
        box.interactionData.actionType = 'ghost_pass';
        box.interactionData.ghostTime = lg.stayTime ?? 4.0;
      } else if (lg.action === 'bounce_pad') {
        box.interactionData.actionType = 'impulse';
        box.interactionData.impulseY = 18;
      } else {
        box.interactionData.actionType = 'none';
      }
    }

    if (hasLegacyDoor) {
      box.motionData.triggerMode = 'self';
      box.motionData.loopMode = (lg.stayTime && lg.stayTime > 0) ? 'auto_return' : 'toggle';
      box.motionData.stayTime = lg.stayTime ?? 4.0;
      box.motionData.speed = clamp((Number(lg.speed) || 4.5) / 3.0, 0.2, 10);
      box.motionData.waypoints = [
        {
          id: 'wp_init_1',
          name: 'Точка #1',
          dx: Number(lg.moveX) || 0,
          dy: Number(lg.moveY) || 0,
          dz: Number(lg.moveZ) || 0,
          rx: 0,
          ry: 0,
          rz: 0,
          sx: box.w || 4,
          sy: box.h || 1,
          sz: box.d || 4
        }
      ];
    }

    box.components = {
      geometry: {
        enabled: !isRawEmpty,
        collapsed: false
      },
      visual: {
        enabled: !isRawEmpty && !isRawPrim,
        collapsed: false,
        surfaceType: box.surfaceType || (box.gold ? 'metal' : 'studs')
      },
      physics: {
        enabled: !isRawEmpty && !isRawPrim,
        collapsed: false
      },
      interaction: {
        enabled: !isRawEmpty && !isRawPrim && hasLegacyInteract,
        collapsed: false
      },
      motion: {
        enabled: !isRawEmpty && !isRawPrim && hasLegacyDoor,
        collapsed: false
      },
      signal: {
        enabled: !isRawEmpty && !isRawPrim && hasLegacySignal,
        collapsed: false
      },
      cost: {
        enabled: !isRawEmpty && !isRawPrim && hasLegacyCost,
        collapsed: false
      },
      item: {
        enabled: false,
        collapsed: false,
        itemData: null
      },
      spawner: {
        enabled: !isRawEmpty && !isRawPrim && hasSp,
        collapsed: false
      },
      script: {
        enabled: Boolean(box.scriptData && box.scriptData.enabled),
        collapsed: false
      }
    };
  } else {
    const keys = ['geometry', 'visual', 'physics', 'interaction', 'motion', 'signal', 'cost', 'item', 'spawner', 'script'];
    for (const k of keys) {
      if (!box.components[k]) {
        box.components[k] = { enabled: false, collapsed: false };
      }
    }
    if (box.components.checkpoint?.enabled && !box.components.interaction.enabled) {
      box.components.interaction.enabled = true;
      box.interactionData.actionType = 'checkpoint';
    }
  }

  if (box.isDynamicPhysics === undefined) {
    box.isDynamicPhysics = Boolean(box.components?.physics?.isDynamicPhysics);
  }
  if (box.weight === undefined || Number.isNaN(Number(box.weight))) {
    box.weight = box.components?.physics?.weight !== undefined ? Number(box.components.physics.weight) : 15;
  }
  if (box.weldToParent === undefined) {
    box.weldToParent = box.components?.physics?.weldToParent !== false;
  }
  if (box.liquidPhysicsEnabled === undefined) {
    box.liquidPhysicsEnabled = box.components?.physics?.liquidPhysicsEnabled !== false;
  }
  if (box.liquidBuoyancy === undefined || Number.isNaN(Number(box.liquidBuoyancy))) {
    box.liquidBuoyancy = Number(box.components?.physics?.liquidBuoyancy) || 85;
  }
  if (box.liquidDrag === undefined || Number.isNaN(Number(box.liquidDrag))) {
    box.liquidDrag = Number(box.components?.physics?.liquidDrag) || 3.5;
  }
  if (box.components?.physics) {
    box.components.physics.isDynamicPhysics = !!box.isDynamicPhysics;
    box.components.physics.weight = box.weight;
    box.components.physics.weldToParent = box.weldToParent;
    box.components.physics.liquidPhysicsEnabled = box.liquidPhysicsEnabled;
    box.components.physics.liquidBuoyancy = box.liquidBuoyancy;
    box.components.physics.liquidDrag = box.liquidDrag;
  }

  if (!box.surfaceType) {
    box.surfaceType = box.components.visual?.surfaceType || (box.gold ? 'metal' : 'studs');
  }
  return box.components;
}

export function syncLegacyFieldsFromModular(box) {
  if (!box || !box.components) return;
  const comps = box.components;
  const it = box.interactionData || createDefaultInteractionData(box);
  const md = box.motionData || createDefaultMotionData(box);
  const sg = box.signalData || createDefaultSignalData(box);
  const ct = box.costData || createDefaultCostData(box);

  if (!box.logicData) box.logicData = createDefaultLogicData();
  const lg = box.logicData;

  if (comps.interaction?.enabled && it.actionType === 'health' && it.trigger === 'touch') {
    box.damageOnContact = it.healthMode === 'damage' ? (Number(it.healthAmount) || 0) : (it.healthMode === 'kill' ? 9999 : 0);
  } else if (!comps.interaction?.enabled) {
    box.damageOnContact = 0;
  }

  if (box.checkpointData) {
    box.checkpointData.enabled = Boolean(comps.interaction?.enabled && it.actionType === 'checkpoint');
    if (box.checkpointData.enabled) {
      box.checkpointData.stage = Number(it.cpStage) || 1;
      box.checkpointData.title = it.cpTitle || 'Чекпоинт';
      box.checkpointData.rewardCash = Number(it.cpCash) ?? 50;
      box.checkpointData.skipSpots = Number(it.cpSkip) ?? 2;
    }
  }

  if (box.spawnerData && !comps.spawner?.enabled) {
    box.spawnerData.mode = 'none';
  }

  lg.tag = comps.signal?.enabled ? (sg.tag || '') : '';
  lg.targetTag = comps.signal?.enabled ? (sg.targetTag || '') : (it.actionType === 'teleport' && it.tpMode === 'target' ? (it.tpTargetTag || '') : '');
  lg.cost = comps.cost?.enabled ? (Number(ct.amount) || 0) : 0;
  lg.oneTimeBuy = comps.cost?.enabled ? ct.oneTimeBuy !== false : true;

  if (comps.interaction?.enabled) {
    lg.trigger = it.trigger || 'none';
    lg.cooldown = Number(it.cooldown) || 0.8;
    lg.showBadge = it.showBadge !== false;
    lg.promptText = it.promptText || '';
    if (it.actionType === 'teleport') {
      lg.action = 'teleport';
      lg.tpX = Number(it.tpX) || 0;
      lg.tpY = Number(it.tpY) || 6;
      lg.tpZ = Number(it.tpZ) || 0;
    } else if (it.actionType === 'reward') {
      if (it.rewardType === 'cash') {
        lg.action = 'give_cash';
        lg.rewardCash = Number(it.rewardCash) || 25;
      } else {
        lg.action = 'buy_perk';
        lg.perkType = it.rewardType || 'speed';
      }
    } else if (it.actionType === 'ghost_pass') {
      lg.action = 'door_ghost';
      lg.stayTime = Number(it.ghostTime) || 4.0;
    } else if (it.actionType === 'impulse') {
      lg.action = 'bounce_pad';
    } else if (comps.motion?.enabled || comps.signal?.enabled) {
      lg.action = 'door_slide';
    }
  } else if (comps.motion?.enabled && md.triggerMode === 'self') {
    lg.trigger = 'keyE';
    lg.action = 'door_slide';
  } else {
    lg.trigger = 'none';
  }

  if (comps.motion?.enabled && md.waypoints && md.waypoints.length > 0) {
    const wp0 = md.waypoints[0];
    lg.moveX = Number(wp0.dx) || 0;
    lg.moveY = Number(wp0.dy) || 0;
    lg.moveZ = Number(wp0.dz) || 0;
    lg.speed = (Number(md.speed) || 1.5) * 3.0;
    lg.stayTime = md.loopMode === 'auto_return' ? (Number(md.stayTime) || 3.0) : 0;
  }
}

export function syncBlockComponentsState(box) {
  if (!box || !box.m) return;
  const comps = ensureBlockComponents(box);
  const hasGeo = Boolean(comps.geometry && comps.geometry.enabled);
  const hasVis = Boolean(comps.visual && comps.visual.enabled);
  const hasPhys = Boolean(comps.physics && comps.physics.enabled);
  const isBBModel = hasGeo && box.shape === 'bbmodel' && box.bbmodelData;
  if (isBBModel) {
    const sig = (box.bbmodelData.id || box.bbmodelData.name) + '|' + (box.colorHex || '');
    if (!box.bbmodelGroup || box._bbmodelSig !== sig) {
      if (box.bbmodelGroup) box.m.remove(box.bbmodelGroup);
      box.bbmodelGroup = buildBBModelGroup(box.bbmodelData, box.colorHex || '#ffffff');
      box._bbmodelSig = sig;
      if (box.bbmodelGroup) {
        box.bbmodelGroup.traverse(o => {
          o.userData.editorRef = { kind: 'block', box };
        });
        box.m.add(box.bbmodelGroup);
      }
    }
    if (box.bbmodelGroup) box.bbmodelGroup.visible = !box.editorHidden;
  } else if (box.bbmodelGroup) {
    box.m.remove(box.bbmodelGroup);
    box.bbmodelGroup = null;
    box._bbmodelSig = '';
  }

  const targetShape = hasGeo ? (box.shape || 'box') : 'none';
  if (box._appliedShape !== targetShape) {
    box.m.geometry = createBlockGeometryByShape(targetShape);
    box._appliedShape = targetShape;
  }

  if (!hasGeo) {
    if (!box.emptyPivotHelper) {
      box.emptyPivotHelper = createBlockPivotHelperMesh();
      box.emptyPivotHelper.traverse(o => {
        o.userData.editorRef = { kind: 'block', box };
      });
      box.m.add(box.emptyPivotHelper);
    }
    box.emptyPivotHelper.visible = (S.state === 'edit') && !box.editorHidden;
    box.m.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false
    });
    box.m.castShadow = false;
    box.m.receiveShadow = false;
    setMeshFrontSprite(box.m, null);
    removeBlockHalo(box);
  } else {
    if (box.emptyPivotHelper) {
      box.emptyPivotHelper.visible = false;
    }

    const effMatter = hasPhys ? (box.matterState || 'solid') : 'solid';
    if (!hasVis) {
      box.m.material = new THREE.MeshStandardMaterial({
        color: 0xf1f5f9,
        roughness: 0.42,
        metalness: 0.05
      });
      box.m.castShadow = true;
      box.m.receiveShadow = true;
      setMeshFrontSprite(box.m, null);
      removeBlockHalo(box);
    } else {
      const surf = comps.visual.surfaceType || box.surfaceType || 'studs';
      box.surfaceType = surf;
      box.gold = surf === 'metal';
      const col = box.colorHex || '#f1f5f9';

      if (surf === 'smooth') {
        const isTransp = effMatter !== 'solid';
        box.m.material = new THREE.MeshStandardMaterial({
          color: col,
          roughness: 0.28,
          metalness: 0.08,
          transparent: isTransp,
          opacity: effMatter === 'liquid' ? 0.72 : (effMatter === 'gas' ? 0.55 : 1.0)
        });
      } else if (surf === 'glass') {
        box.m.material = new THREE.MeshStandardMaterial({
          color: col,
          roughness: 0.12,
          metalness: 0.1,
          transparent: true,
          opacity: 0.45
        });
      } else if (surf === 'neon') {
        box.m.material = new THREE.MeshStandardMaterial({
          color: col,
          emissive: new THREE.Color(col),
          emissiveIntensity: 1.8,
          roughness: 0.15,
          metalness: 0.0
        });
      } else {
        box.m.material = createBlockMaterial(
          col,
          Math.max(0.5, box.w / 2),
          Math.max(0.5, box.d / 2),
          surf === 'metal',
          null,
          effMatter
        );
        syncBoxMaterialTiling(box.m, box.w, box.h, box.d);
      }
      box.m.castShadow = effMatter === 'solid' && surf !== 'glass';
      box.m.receiveShadow = true;
      setMeshFrontSprite(box.m, box.customTexDataURL || null);
    }
  }

  if (isBBModel) {
    box.m.material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false
    });
    box.m.castShadow = false;
    box.m.receiveShadow = false;
  }

  syncLegacyFieldsFromModular(box);
  syncBlockLightVisuals(box);
  syncBlockSpecialVisuals(box);
  updateBlockOBB(box);
  const isEdit = S.state === 'edit';
  const vis = !box.isDisabled && !(isEdit && box.editorHidden) && (!(isEdit ? false : box._depletedDisabled));
  box.m.visible = vis;
  if (box.bbmodelGroup) box.bbmodelGroup.visible = vis;
  if (box.cpVisualGroup) box.cpVisualGroup.visible = vis;
  if (box.haloSprite) box.haloSprite.visible = vis;
  if (box.emptyPivotHelper) box.emptyPivotHelper.visible = isEdit && vis && !hasGeo;
}

function ensurePointLightPool() {
  if (pointLightPool.length > 0) return;
  for (let i = 0; i < MAX_ACTIVE_POINT_LIGHTS; i++) {
    const pl = new THREE.PointLight(0xffffff, 0, 0.01, 1.5);
    pl.castShadow = false;
    pl.position.set(0, -9999, 0);
    scene.add(pl);
    pointLightPool.push(pl);
  }
}

export function syncBlockLightVisuals(box) {
  if (!box || !box.m || !box.m.material) return;
  if (!box.lightData) {
    box.lightData = createDefaultLightData(box.colorHex, false);
  }
  const comps = box.components;
  const visEnabled = !comps || (comps.geometry?.enabled && comps.visual?.enabled);
  if (!visEnabled) {
    removeBlockHalo(box);
    return;
  }

  const ld = box.lightData;
  const mat = box.m.material;

  if (!mat.emissive) return;

  const isLightMode = ld.mode === 'visual' || ld.mode === 'point';
  const isNeonSurf = box.surfaceType === 'neon';
  const isKillLaser = box.components?.physics?.enabled !== false && box.damageOnContact > 0 && box.colorHex === '#ff1e1e';

  if (isLightMode || isKillLaser || isNeonSurf) {
    const isPseudo = ld.mode === 'visual' || isNeonSurf;
    const glowHex = isLightMode ? (ld.color || box.colorHex || '#ffffff') : (box.colorHex || '#ff1e1e');
    const baseInt = clamp(Number(ld.intensity) || 1.4, 0.1, 5.0);

    mat.emissive.set(glowHex);
    if (isPseudo) {
      mat.emissiveIntensity = clamp(baseInt * 2.5, 1.8, 7.5);
      if (mat.roughness !== undefined && !mat.userData?.customTexDataURL) mat.roughness = 0.18;
      if (mat.metalness !== undefined && !mat.userData?.gold) mat.metalness = 0.0;
    } else if (ld.mode === 'point') {
      mat.emissiveIntensity = clamp(baseInt * 1.5, 1.1, 5.0);
    } else {
      mat.emissiveIntensity = 2.0;
    }

    const sx = Math.max(0.2, (box.m.scale && box.m.scale.x) || box.w || 1);
    const sy = Math.max(0.2, (box.m.scale && box.m.scale.y) || box.h || 1);
    const sz = Math.max(0.2, (box.m.scale && box.m.scale.z) || box.d || 1);
    const maxHoriz = Math.max(sx, sz);
    const minHoriz = Math.min(sx, sz);

    // Мягкое нелинейное масштабирование с ограничением сверху, чтобы огромные блоки («море лавы») не застилали небо
    const effHoriz = Math.min(11.5, Math.sqrt(minHoriz * maxHoriz) * 0.85 + 1.2);
    const effVert = Math.min(9.5, sy * 1.15 + Math.min(2.5, maxHoriz * 0.18));

    const haloScaleX = clamp(
      isPseudo ? (effHoriz * 1.25 + baseInt * 1.4) : (effHoriz * 1.1 + baseInt * 1.1),
      1.2,
      15.0
    );
    const haloScaleY = clamp(
      isPseudo ? (effVert * 1.25 + baseInt * 1.2) : (effVert * 1.1 + baseInt * 0.95),
      1.0,
      11.0
    );

    // На сверхкрупных поверхностях (шире 16м) плавно приглушаем спрайт ореола, оставляя ярким сам материал блока
    const giantDamp = maxHoriz > 16 ? clamp(16 / maxHoriz, 0.2, 1.0) : 1.0;
    const haloOpacity = (isPseudo
      ? clamp(baseInt * 0.44, 0.3, 0.9)
      : clamp(baseInt * 0.36, 0.22, 0.8)) * giantDamp;

    if (!box.haloSprite) {
      box.haloSprite = createHaloSprite(glowHex, haloScaleX, haloOpacity);
      scene.add(box.haloSprite);
    } else {
      box.haloSprite.visible = true;
      box.haloSprite.material.color.set(glowHex);
      box.haloSprite.material.opacity = haloOpacity;
    }
    box.haloSprite.scale.set(haloScaleX, haloScaleY, 1);
    box.haloSprite.position.copy(box.m.position);
    box.haloSprite.userData.baseScaleX = haloScaleX;
    box.haloSprite.userData.baseScaleY = haloScaleY;
    box.haloSprite.userData.baseOpacity = haloOpacity;
  } else {
    removeBlockHalo(box);
    mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
  }
}

export function updateWorldLights(camPos) {
  ensurePointLightPool();
  const t = S.time || (performance.now() * 0.001);
  const pointCandidates = [];

  const pushRealLightCandidate = (worldPos, colorHex, intensity, distance, pulseMult = 1.0) => {
    const dx = camPos ? worldPos.x - camPos.x : 0;
    const dy = camPos ? worldPos.y - camPos.y : 0;
    const dz = camPos ? worldPos.z - camPos.z : 0;
    const distSq = dx * dx + dy * dy + dz * dz;
    const maxRange = (Number(distance) || 14) + 55;
    if (distSq <= maxRange * maxRange) {
      pointCandidates.push({
        pos: worldPos.clone(),
        color: colorHex || '#ffffff',
        intensity: Number(intensity) || 1.5,
        distance: Number(distance) || 14,
        distSq,
        pulseMult
      });
    }
  };

  for (let i = 0; i < S.allBlocks.length; i++) {
    const box = S.allBlocks[i];
    if (box.isDisabled || box._depletedDisabled) continue;
    const ld = box.lightData;

    if (box.haloSprite && box.haloSprite.visible) {
      box.haloSprite.position.copy(box.m.position);
    }

    if (box.components && (!box.components.geometry?.enabled || !box.components.visual?.enabled)) continue;
    if (!ld || ld.mode === 'none') continue;

    let pulseMult = 1.0;
    if (ld.pulseSpeed && ld.pulseSpeed > 0) {
      pulseMult = 0.65 + 0.35 * Math.sin(t * ld.pulseSpeed * 3.0 + i);
      if (box.m.material && box.m.material.emissive) {
        const baseInt = clamp(Number(ld.intensity) || 1.4, 0.1, 5.0);
        const normInt = ld.mode === 'visual'
          ? clamp(baseInt * 2.5, 1.8, 7.5)
          : clamp(baseInt * 1.5, 1.1, 5.0);
        box.m.material.emissiveIntensity = normInt * pulseMult;
      }
      if (box.haloSprite && box.haloSprite.visible) {
        const baseSX = box.haloSprite.userData.baseScaleX || box.haloSprite.userData.baseScale || 3.0;
        const baseSY = box.haloSprite.userData.baseScaleY || box.haloSprite.userData.baseScale || 3.0;
        const pFactor = 0.92 + 0.08 * pulseMult;
        box.haloSprite.scale.set(baseSX * pFactor, baseSY * pFactor, 1);
        box.haloSprite.material.opacity = (box.haloSprite.userData.baseOpacity || 0.6) * pulseMult;
      }
    }

    if (ld.mode === 'point') {
      pushRealLightCandidate(
        box.m.position,
        ld.color || box.colorHex || '#ffffff',
        ld.intensity,
        ld.distance,
        pulseMult
      );
    }
  }

  const collectGroupRealLights = group => {
    if (!group || !group.visible) return;
    const ownerItem = group.userData?.itemData;
    if (
      ownerItem &&
      ownerItem.useType === 'torch' &&
      ownerItem.lightData &&
      !ownerItem.lightData.realLight &&
      !ownerItem.lightData.pseudoLight &&
      !ownerItem.lightData.enabled
    ) {
      return;
    }

    const partMeshes = group.userData?.partMeshes;
    let addedFromPart = false;
    if (Array.isArray(partMeshes)) {
      for (let i = 0; i < partMeshes.length; i++) {
        const pm = partMeshes[i];
        const pt = pm.userData?.effectPart || pm.userData?.itemPart || pm.userData?.cosmeticPart;
        if (pt && pt.realLight && pm.visible) {
          pm.getWorldPosition(_vWorldLightPos);
          pushRealLightCandidate(
            _vWorldLightPos,
            pt.lightColor || pt.color || '#ffce3a',
            pt.lightIntensity || 1.6,
            pt.lightDistance || 14,
            1.0
          );
          addedFromPart = true;
        }
      }
    }

    if (
      !addedFromPart &&
      ownerItem &&
      ownerItem.lightData &&
      (ownerItem.lightData.realLight || ownerItem.lightData.enabled)
    ) {
      group.getWorldPosition(_vWorldLightPos);
      pushRealLightCandidate(
        _vWorldLightPos,
        ownerItem.lightData.color || '#ff9f43',
        ownerItem.lightData.intensity || 1.8,
        ownerItem.lightData.distance || 16,
        1.0
      );
    }
  };

  for (const wi of S.worldItems) {
    if (wi && !wi.isDisabled && wi.group) collectGroupRealLights(wi.group);
  }
  for (const prj of S.activeProjectiles || []) {
    if (prj && (prj.mesh || prj.m || prj.group)) collectGroupRealLights(prj.mesh || prj.m || prj.group);
  }

  const collectEntityRealLights = ent => {
    if (!ent || !ent.rig) return;
    if (ent.rig.heldItemMesh) collectGroupRealLights(ent.rig.heldItemMesh);
    if (ent.rig.carriedItemMesh) collectGroupRealLights(ent.rig.carriedItemMesh);
    if (Array.isArray(ent.rig.customCosMeshes)) {
      for (const cg of ent.rig.customCosMeshes) {
        collectGroupRealLights(cg);
      }
    }
  };

  if (S.player) collectEntityRealLights(S.player);
  for (const npc of S.customNPCs) { if (npc && !npc.isDisabled && !(npc._deadCooldown > 0) && !npc._permanentlyDead) collectEntityRealLights(npc); }
  for (const q of S.queueLine) {
    if (!q.isP) collectEntityRealLights(q);
  }
  if (S.archangelEnt) collectEntityRealLights(S.archangelEnt);
  if (S.workbenchPreviewGroup) collectGroupRealLights(S.workbenchPreviewGroup);
  if (S.studioMannequinRig) collectEntityRealLights(S.studioMannequinRig);
  collectBurningLightCandidates(pushRealLightCandidate);

  if (pointCandidates.length > MAX_ACTIVE_POINT_LIGHTS) {
    pointCandidates.sort((a, b) => a.distSq - b.distSq);
  }

  for (let i = 0; i < MAX_ACTIVE_POINT_LIGHTS; i++) {
    const pl = pointLightPool[i];
    const cand = pointCandidates[i];
    if (cand) {
      pl.color.set(cand.color || '#ffffff');
      pl.intensity = clamp(Number(cand.intensity) || 1.4, 0.1, 6.0) * cand.pulseMult;
      pl.distance = clamp(Number(cand.distance) || 14, 2, 80);
      pl.position.copy(cand.pos);
    } else {
      pl.intensity = 0;
      pl.distance = 0.01;
      pl.position.set(0, -9999, 0);
    }
  }
}

export function clearWorld() {
  clearAllParticles();
  clearAllStatusEffectVisuals();
  clearSurfaceWeatherLayer();
  clearStudioMotionHelpers();
  for (const pl of pointLightPool) {
    pl.intensity = 0;
    pl.position.set(0, -9999, 0);
  }
  for (const b of S.allBlocks) {
    removeBlockHalo(b);
    scene.remove(b.m);
    if (b.cpVisualGroup) scene.remove(b.cpVisualGroup);
  }
  S.allBlocks.length = 0;

  for (const c of S.spawnedCoins) {
    scene.remove(c.m);
  }
  S.spawnedCoins.length = 0;

  for (const ch of S.colliderHelpers) {
    scene.remove(ch);
  }
  S.colliderHelpers.length = 0;

  S.queueCoords = [];
  S.blockIdCounter = 1;
}

export function addSceneBlock(opts) {
  const {
    x = 0,
    y = 0,
    z = 0,
    w = 4,
    h = 4,
    d = 4,
    colorHex = '#ecf5ff',
    gold = false,
    surfaceType = null,
    colliderShape = 'auto',
    customTexDataURL = null,
    matterState = 'solid',
    isDynamicPhysics = false,
    weight = 15,
    liquidPhysicsEnabled = true,
    liquidBuoyancy = 45,
    liquidDrag = 3.5,
    liquidTemp = 'neutral',
    effectSource = 'none',
    isFlammable = false,
    takesFireDamage = false,
    maxFireHp = 100,
    statusEffects = null,
    bounciness = 0,
    conveyorVz = 0,
    conveyorVx = 0,
    damageOnContact = 0,
    teleportToCheckpoint = false,
    spinSpeed = 0,
    checkpointData = null,
    spawnerData = null,
    particleData = null,
    lightData = null,
    logicData = null,
    interactionData = null,
    motionData = null,
    signalData = null,
    costData = null,
    components = null,
    scriptData = null,
    bbmodelData = null,
    isRawEmpty = false,
    isRawPrimitive = false,
    label = 'Блок',
    shape = 'box',
    isCustom = false
  } = opts;

  const geo = createBlockGeometryByShape(isRawEmpty ? 'none' : shape);

  const normalizedHex = colorHex.startsWith('#')
    ? colorHex
    : '#' + new THREE.Color(colorHex).getHexString();

  const mat = createBlockMaterial(
    normalizedHex,
    w / 2.2,
    d / 2.2,
    gold,
    null,
    matterState
  );

  const m = new THREE.Mesh(geo, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y - h / 2, z);
  m.castShadow = matterState === 'solid';
  m.receiveShadow = true;
  scene.add(m);

  const isKillLaserDefault = !isRawEmpty && !isRawPrimitive && damageOnContact > 0 && matterState === 'solid' && normalizedHex === '#ff1e1e';
  const resolvedLightData = Object.assign(
    createDefaultLightData(normalizedHex, isKillLaserDefault),
    lightData || {}
  );
  const resolvedLogicData = Object.assign(createDefaultLogicData(), logicData || {});

  for (let i = 0; i < S.allBlocks.length; i++) {
    const existingId = S.allBlocks[i]?.id;
    if (typeof existingId === 'string' && existingId.startsWith('blk_')) {
      const num = parseInt(existingId.slice(4), 10);
      if (!Number.isNaN(num) && num >= S.blockIdCounter) {
        S.blockIdCounter = num + 1;
      }
    }
  }
  const id = 'blk_' + S.blockIdCounter++;
  const box = {
    id,
    label: label || 'Объект #' + S.blockIdCounter,
    shape: shape || 'box',
    colliderShape: colliderShape || 'auto',
    surfaceType: surfaceType || (gold ? 'metal' : 'studs'),
    x0: x - w / 2,
    x1: x + w / 2,
    y0: y - h,
    y1: y,
    z0: z - d / 2,
    z1: z + d / 2,
    w,
    h,
    d,
    hx: w / 2,
    hy: h / 2,
    hz: d / 2,
    invQuat: new THREE.Quaternion(),
    axisX: new THREE.Vector3(1, 0, 0),
    axisY: new THREE.Vector3(0, 1, 0),
    axisZ: new THREE.Vector3(0, 0, 1),
    isRotated: false,
    boundRadius: Math.hypot(w / 2, h / 2, d / 2),
    m,
    colorHex: normalizedHex,
    gold: !!gold,
    customTexDataURL: customTexDataURL || null,
    matterState,
    isDynamicPhysics: !!isDynamicPhysics,
    weight: clamp(Number.isNaN(Number(weight)) ? 15 : Number(weight), -5000, 10000),
    weldToParent: opts.weldToParent !== false,
    liquidPhysicsEnabled: liquidPhysicsEnabled !== false,
    liquidBuoyancy: clamp(Number(liquidBuoyancy) || 85, 1, 5000),
    liquidDrag: clamp(Number(liquidDrag) || 3.5, 0.1, 30),
    liquidTemp: liquidTemp || 'neutral',
    effectSource: effectSource || 'none',
    isFlammable: Boolean(isFlammable),
    takesFireDamage: Boolean(takesFireDamage),
    maxFireHp: Math.max(10, Number(maxFireHp) || 100),
    fireHp: Math.max(10, Number(maxFireHp) || 100),
    statusEffects: statusEffects ? JSON.parse(JSON.stringify(statusEffects)) : createDefaultStatusEffectsState(),
    physVx: 0,
    physVy: 0,
    physVz: 0,
    physWx: 0,
    physWy: 0,
    physWz: 0,
    physGrounded: false,
    physInLiquid: false,
    _isCarriedByPlayer: false,
    bounciness: Number(bounciness) || 0,
    conveyorVz: Number(conveyorVz) || 0,
    conveyorVx: Number(conveyorVx) || 0,
    damageOnContact: Number(damageOnContact) || 0,
    teleportToCheckpoint: !!teleportToCheckpoint,
    spinSpeed: Number(spinSpeed) || 0,
    colliderScale: { x: 1, y: 1, z: 1 },
    checkpointData: checkpointData || {
      enabled: false,
      stage: 1,
      title: 'Чекпоинт',
      rewardCash: 50,
      skipSpots: 2
    },
    spawnerData: spawnerData || {
      mode: 'none',
      interval: 5,
      timer: 5,
      spawnType: 'npc'
    },
    particleData: Object.assign(createDefaultParticleData(), particleData || {}),
    lightData: resolvedLightData,
    logicData: resolvedLogicData,
    interactionData: interactionData ? JSON.parse(JSON.stringify(interactionData)) : null,
    motionData: motionData ? JSON.parse(JSON.stringify(motionData)) : null,
    signalData: signalData ? JSON.parse(JSON.stringify(signalData)) : null,
    costData: costData ? JSON.parse(JSON.stringify(costData)) : null,
    scriptData: scriptData ? JSON.parse(JSON.stringify(scriptData)) : createDefaultScriptData('block'),
    bbmodelData: bbmodelData ? JSON.parse(JSON.stringify(bbmodelData)) : null,
    components: components ? JSON.parse(JSON.stringify(components)) : null,
    logicRuntime: {
      basePos: null,
      baseQuat: null,
      baseScale: null,
      openT: 0,
      targetU: 0,
      targetOpen: false,
      stayTimer: 0,
      cdTimer: 0,
      ghostOpen: false
    },
    cpVisualGroup: null,
    emptyPivotHelper: null,
    isDisabled: Boolean(opts.isDisabled),
    editorHidden: Boolean(opts.editorHidden),
    isCustom
  };

  ensureBlockComponents(box, { isRawEmpty, isRawPrimitive });
  m.userData.editorRef = { kind: 'block', box };

  S.allBlocks.push(box);
  syncBlockComponentsState(box);
  
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  return box;
}

export function updateBlockOBB(box) {
  const m = box.m;
  const w = Math.max(0.15, Math.abs(m.scale.x));
  const h = Math.max(0.1, Math.abs(m.scale.y));
  const d = Math.max(0.15, Math.abs(m.scale.z));
  box.w = w;
  box.h = h;
  box.d = d;

  if ((box.components && !box.components.physics?.enabled) || box._depletedDisabled || box.isDisabled) {
    box.hx = w * 0.5;
    box.hy = h * 0.5;
    box.hz = d * 0.5;
    box.boundRadius = 0;
    box.x0 = -999999;
    box.x1 = -999999;
    box.y0 = -999999;
    box.y1 = -999999;
    box.z0 = -999999;
    box.z1 = -999999;
    return;
  }

  const cs = box.colliderScale || { x: 1, y: 1, z: 1 };
  const cw = w * cs.x;
  const ch = h * cs.y;
  const cd = d * cs.z;
  box.hx = cw * 0.5;
  box.hy = ch * 0.5;
  box.hz = cd * 0.5;
  box.effectiveColliderShape = (!box.colliderShape || box.colliderShape === 'auto')
    ? (box.shape || 'box')
    : box.colliderShape;
  box.boundRadius = Math.hypot(box.hx, box.hy, box.hz);

  m.updateMatrixWorld();
  box.invQuat.copy(m.quaternion).invert();
  box.axisX.set(1, 0, 0).applyQuaternion(m.quaternion).normalize();
  box.axisY.set(0, 1, 0).applyQuaternion(m.quaternion).normalize();
  box.axisZ.set(0, 0, 1).applyQuaternion(m.quaternion).normalize();
  box.isRotated =
    Math.abs(m.rotation.x) > 0.0005 ||
    Math.abs(m.rotation.y) > 0.0005 ||
    Math.abs(m.rotation.z) > 0.0005;

  const cx = m.position.x;
  const cy = m.position.y;
  const cz = m.position.z;
  const ex =
    Math.abs(box.axisX.x) * box.hx +
    Math.abs(box.axisY.x) * box.hy +
    Math.abs(box.axisZ.x) * box.hz;
  const ey =
    Math.abs(box.axisX.y) * box.hx +
    Math.abs(box.axisY.y) * box.hy +
    Math.abs(box.axisZ.y) * box.hz;
  const ez =
    Math.abs(box.axisX.z) * box.hx +
    Math.abs(box.axisY.z) * box.hy +
    Math.abs(box.axisZ.z) * box.hz;

  box.x0 = cx - ex;
  box.x1 = cx + ex;
  box.y0 = cy - ey;
  box.y1 = cy + ey;
  box.z0 = cz - ez;
  box.z1 = cz + ez;
}

export function getLogicBadgeStrings(box) {
  const comps = box.components;
  const it = box.interactionData;
  const ct = box.costData;
  const sg = box.signalData;

  const hasInteract = comps?.interaction?.enabled && it && it.trigger !== 'none';
  const hasSelfMotion = comps?.motion?.enabled && box.motionData?.triggerMode === 'self';
  if (comps?.script?.enabled && box.scriptData) {
    ensureScriptContainer(box.scriptData, 'block');
  }
  const hasScriptInteract = Boolean(comps?.script?.enabled && box.scriptData?.enabled && box.scriptData?.hasInteractHook);
  if (!hasInteract && !hasSelfMotion && !hasScriptInteract) return null;

  const trig = hasInteract ? it.trigger : 'keyE';
  const trigBadge = trig === 'keyE'
    ? '[E]'
    : trig === 'touch'
    ? '[КАСАНИЕ]'
    : trig === 'radius'
    ? `[РАДИУС ${it.radiusDist || 3}м]`
    : '[УДАР ЛКМ]';

  const hasCost = Boolean(comps?.cost?.enabled && ct && ct.amount > 0);
  const needPay = hasCost && !(ct.oneTimeBuy && ct.unlocked);
  const priceTag = needPay ? `💰 ${ct.amount} R$` : (hasCost && ct.unlocked ? '✅ КУПЛЕНО' : '');

  let title = (it && it.promptText) ? it.promptText.trim() : '';
  if (!title) {
    if (hasInteract && it.actionType === 'teleport') title = `🌀 ТЕЛЕПОРТ ${trigBadge}`;
    else if (hasInteract && it.actionType === 'health') {
      title = it.healthMode === 'heal'
        ? `💚 +${it.healthAmount} HP ${trigBadge}`
        : `🚨 УРОН -${it.healthAmount} HP ${trigBadge}`;
    } else if (hasInteract && it.actionType === 'reward') {
      title = it.rewardType === 'cash'
        ? `🪙 +${it.rewardCash || 25} R$ ${trigBadge}`
        : `🛒 БОНУС ${trigBadge}`;
    } else if (hasInteract && it.actionType === 'impulse') {
      title = `🚀 ИМПУЛЬС ${trigBadge}`;
    } else if (comps?.motion?.enabled) {
      title = `🚪 ${box.label || 'ДВИЖЕНИЕ'} ${trigBadge}`;
    } else if (comps?.signal?.enabled && sg?.targetTag) {
      title = `🔘 АКТИВАТОР ${trigBadge}`;
    } else {
      title = `⚡ ${box.label || 'ОБЪЕКТ'} ${trigBadge}`;
    }
  }

  let chargesTxt = '';
  if (hasInteract && it.consumeMode === 'charges') {
    chargesTxt = `🔋 ${it.chargesLeft ?? it.maxCharges}/${it.maxCharges}`;
  }
  const targetTxt = (comps?.signal?.enabled && sg?.targetTag) ? `Цель: #${sg.targetTag}` : '';
  const sub = [priceTag, chargesTxt, targetTxt].filter(Boolean).join(' · ') || box.label;
  return { title, sub, trigBadge };
}

export function syncBlockSpecialVisuals(box) {
  if (box.cpVisualGroup) {
    scene.remove(box.cpVisualGroup);
    box.cpVisualGroup = null;
  }

  const comps = box.components;
  const it = box.interactionData;

  if (comps?.interaction?.enabled && it?.actionType === 'checkpoint') {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 0.22, 20),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    pad.position.set(0, box.h / 2 + 0.11, 0);
    const spr = makeTagSprite(320, 90, 3.8, 1.05);
    spr.position.set(0, box.h / 2 + 2.6, 0);
    const subText = it.cpSkip > 0
      ? `+${it.cpCash} R$ и -${it.cpSkip} мест!`
      : `+${it.cpCash} R$`;
    updateTag(spr, `⭐ ЧЕКПОИНТ #${it.cpStage}`, it.cpTitle || 'Чекпоинт', subText);
    g.add(pad, spr);
    g.position.copy(box.m.position);
    g.rotation.copy(box.m.rotation);
    g.traverse(o => {
      o.userData.editorRef = { kind: 'block', box };
    });
    scene.add(g);
    box.cpVisualGroup = g;
    return;
  }

  const showBadge = comps?.interaction?.enabled ? (it?.showBadge !== false) : true;
  if (showBadge) {
    const info = getLogicBadgeStrings(box);
    if (info) {
      const g = new THREE.Group();
      const spr = makeTagSprite(320, 90, 3.6, 1.0);
      spr.position.set(0, box.h / 2 + 2.1, 0);
      const tagStr = (comps?.signal?.enabled && box.signalData?.tag) ? `#${box.signalData.tag}` : '';
      updateTag(spr, info.title, info.sub, tagStr);
      g.add(spr);
      g.position.copy(box.m.position);
      g.traverse(o => {
        o.userData.editorRef = { kind: 'block', box };
      });
      scene.add(g);
      box.cpVisualGroup = g;
    }
  }
}

export function getBlockLocalPivotOffset(box, scaleVec = null) {
  const md = box?.motionData;
  const sx = scaleVec ? scaleVec.x : (box?.w || 1);
  const sy = scaleVec ? scaleVec.y : (box?.h || 1);
  const sz = scaleVec ? scaleVec.z : (box?.d || 1);
  if (!md || !md.pivotMode || md.pivotMode === 'center') {
    return new THREE.Vector3(0, 0, 0);
  }
  if (md.pivotMode === 'left') return new THREE.Vector3(-sx * 0.5, 0, 0);
  if (md.pivotMode === 'right') return new THREE.Vector3(sx * 0.5, 0, 0);
  if (md.pivotMode === 'bottom') return new THREE.Vector3(0, -sy * 0.5, 0);
  if (md.pivotMode === 'top') return new THREE.Vector3(0, sy * 0.5, 0);
  if (md.pivotMode === 'front') return new THREE.Vector3(0, 0, sz * 0.5);
  if (md.pivotMode === 'back') return new THREE.Vector3(0, 0, -sz * 0.5);
  if (md.pivotMode === 'custom') {
    return new THREE.Vector3(Number(md.pivotX) || 0, Number(md.pivotY) || 0, Number(md.pivotZ) || 0);
  }
  return new THREE.Vector3(0, 0, 0);
}

export function computeBlockMotionTransformAtState(box, baseTransform, stateSpec) {
  const bPos = baseTransform.pos;
  const bQuat = baseTransform.quat;
  const bScale = baseTransform.scale;

  const targetScale = new THREE.Vector3(
    Math.max(0.1, Number(stateSpec.sx) || bScale.x),
    Math.max(0.1, Number(stateSpec.sy) || bScale.y),
    Math.max(0.1, Number(stateSpec.sz) || bScale.z)
  );

  const deltaEuler = new THREE.Euler(
    THREE.MathUtils.degToRad(Number(stateSpec.rx) || 0),
    THREE.MathUtils.degToRad(Number(stateSpec.ry) || 0),
    THREE.MathUtils.degToRad(Number(stateSpec.rz) || 0),
    'XYZ'
  );
  const deltaQuat = new THREE.Quaternion().setFromEuler(deltaEuler);
  const targetQuat = bQuat.clone().multiply(deltaQuat);

  const basePivotLocal = getBlockLocalPivotOffset(box, bScale);
  const curPivotLocal = getBlockLocalPivotOffset(box, targetScale);

  const hingeWorldStart = basePivotLocal.clone().applyQuaternion(bQuat).add(bPos);
  const hingeWorldCur = hingeWorldStart.clone().add(
    new THREE.Vector3(Number(stateSpec.dx) || 0, Number(stateSpec.dy) || 0, Number(stateSpec.dz) || 0)
  );

  const targetPos = hingeWorldCur.clone().sub(curPivotLocal.clone().applyQuaternion(targetQuat));

  return {
    pos: targetPos,
    quat: targetQuat,
    scale: targetScale,
    hingePos: hingeWorldCur,
    hingeStart: hingeWorldStart
  };
}

export function evaluateBlockMotionAtProgress(box, uProgress) {
  const rt = box.logicRuntime || {};
  const baseTransform = {
    pos: rt.basePos ? rt.basePos.clone() : box.m.position.clone(),
    quat: rt.baseQuat ? rt.baseQuat.clone() : box.m.quaternion.clone(),
    scale: rt.baseScale ? rt.baseScale.clone() : box.m.scale.clone()
  };

  const md = box.motionData;
  const wps = (md && Array.isArray(md.waypoints) && md.waypoints.length > 0) ? md.waypoints : [];
  const states = [
    {
      dx: 0, dy: 0, dz: 0,
      rx: 0, ry: 0, rz: 0,
      sx: baseTransform.scale.x,
      sy: baseTransform.scale.y,
      sz: baseTransform.scale.z
    },
    ...wps
  ];

  const maxSeg = Math.max(0, states.length - 1);
  if (maxSeg === 0) {
    return computeBlockMotionTransformAtState(box, baseTransform, states[0]);
  }

  const clampedU = clamp(uProgress, 0, maxSeg);
  const idxA = Math.min(maxSeg - 1, Math.floor(clampedU));
  const idxB = idxA + 1;
  const localT = clampedU - idxA;
  const smoothT = localT * localT * (3 - 2 * localT);

  const stA = states[idxA];
  const stB = states[idxB];
  const interpSpec = {
    dx: (Number(stA.dx) || 0) + ((Number(stB.dx) || 0) - (Number(stA.dx) || 0)) * smoothT,
    dy: (Number(stA.dy) || 0) + ((Number(stB.dy) || 0) - (Number(stA.dy) || 0)) * smoothT,
    dz: (Number(stA.dz) || 0) + ((Number(stB.dz) || 0) - (Number(stA.dz) || 0)) * smoothT,
    rx: (Number(stA.rx) || 0) + ((Number(stB.rx) || 0) - (Number(stA.rx) || 0)) * smoothT,
    ry: (Number(stA.ry) || 0) + ((Number(stB.ry) || 0) - (Number(stA.ry) || 0)) * smoothT,
    rz: (Number(stA.rz) || 0) + ((Number(stB.rz) || 0) - (Number(stA.rz) || 0)) * smoothT,
    sx: (Number(stA.sx) || baseTransform.scale.x) + ((Number(stB.sx) || baseTransform.scale.x) - (Number(stA.sx) || baseTransform.scale.x)) * smoothT,
    sy: (Number(stA.sy) || baseTransform.scale.y) + ((Number(stB.sy) || baseTransform.scale.y) - (Number(stA.sy) || baseTransform.scale.y)) * smoothT,
    sz: (Number(stA.sz) || baseTransform.scale.z) + ((Number(stB.sz) || baseTransform.scale.z) - (Number(stA.sz) || baseTransform.scale.z)) * smoothT
  };

  return computeBlockMotionTransformAtState(box, baseTransform, interpSpec);
}

let studioMotionHelperGroup = null;

function createGizmoStyleWaypointMarkerMesh(colorHex = 0x00e676, isStart = false) {
  const g = new THREE.Group();
  const mkMat = (col, op = 0.94) =>
    new THREE.MeshBasicMaterial({
      color: col,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: op,
      side: THREE.DoubleSide
    });

  const core = new THREE.Mesh(new THREE.OctahedronGeometry(isStart ? 0.11 : 0.14, 0), mkMat(colorHex, 0.96));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(isStart ? 0.17 : 0.22, 0.022, 10, 28), mkMat(0xffffff, 0.88));
  g.add(core, ring);

  const makeMiniAxisArrow = (axis, col) => {
    const grp = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.28, 10), mkMat(col, 0.92));
    shaft.position.y = 0.14;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.14, 12), mkMat(col, 0.96));
    tip.position.y = 0.32;
    grp.add(shaft, tip);
    if (axis === 'X') grp.rotation.z = -Math.PI / 2;
    else if (axis === 'Z') grp.rotation.x = Math.PI / 2;
    return grp;
  };

  g.add(
    makeMiniAxisArrow('X', 0xff4757),
    makeMiniAxisArrow('Y', 0x00e676),
    makeMiniAxisArrow('Z', 0x00d2ff)
  );

  const pickSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 10, 8),
    mkMat(0xffffff, 0.0)
  );
  g.add(pickSphere);

  g.traverse(o => {
    o.renderOrder = 997;
    o.userData.noCollider = true;
  });
  return g;
}

export function clearStudioMotionHelpers() {
  if (!studioMotionHelperGroup) return;
  scene.remove(studioMotionHelperGroup);
  studioMotionHelperGroup = null;
}

export function syncStudioMotionAndSignalHelpers() {
  clearStudioMotionHelpers();
  if (S.state !== 'edit' || !S.selectedRef || S.selectedRef.kind !== 'block') return;
  const box = S.selectedRef.box;
  if (!box || !box.m) return;

  const comps = ensureBlockComponents(box);
  const hasMotion = Boolean(comps.motion?.enabled);
  const hasSignal = Boolean(comps.signal?.enabled && box.signalData?.targetTag);
  const hasTpTarget = Boolean(comps.interaction?.enabled && box.interactionData?.actionType === 'teleport' && box.interactionData?.tpMode === 'target' && box.interactionData?.tpTargetTag);

  if (!hasMotion && !hasSignal && !hasTpTarget) return;

  studioMotionHelperGroup = new THREE.Group();
  studioMotionHelperGroup.name = 'StudioMotionAndSignalHelpers';
  studioMotionHelperGroup.userData.noCollider = true;

  if (hasMotion) {
    const md = box.motionData;
    const rt = box.logicRuntime || {};
    const baseTransform = {
      pos: (rt.basePos && S.selectedRef.editMode === 'motion_wp') ? rt.basePos.clone() : box.m.position.clone(),
      quat: (rt.baseQuat && S.selectedRef.editMode === 'motion_wp') ? rt.baseQuat.clone() : box.m.quaternion.clone(),
      scale: (rt.baseScale && S.selectedRef.editMode === 'motion_wp') ? rt.baseScale.clone() : box.m.scale.clone()
    };

    if (S.selectedRef.editMode !== 'motion_wp') {
      if (!box.logicRuntime) box.logicRuntime = {};
      box.logicRuntime.basePos = baseTransform.pos.clone();
      box.logicRuntime.baseQuat = baseTransform.quat.clone();
      box.logicRuntime.baseScale = baseTransform.scale.clone();
    }

    if (md.pivotMode && md.pivotMode !== 'center') {
      const startState = computeBlockMotionTransformAtState(box, baseTransform, {
        dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0,
        sx: baseTransform.scale.x, sy: baseTransform.scale.y, sz: baseTransform.scale.z
      });
      const hingeGroup = new THREE.Group();
      hingeGroup.position.copy(startState.hingeStart);
      hingeGroup.quaternion.copy(baseTransform.quat);

      const hingeMat = new THREE.MeshBasicMaterial({
        color: 0xffce3a,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      });
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, Math.max(0.8, baseTransform.scale.y * 0.9), 12), hingeMat);
      const rTop = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.025, 8, 20), hingeMat);
      rTop.rotation.x = Math.PI / 2;
      rTop.position.y = Math.max(0.3, baseTransform.scale.y * 0.35);
      const rBot = rTop.clone();
      rBot.position.y = -Math.max(0.3, baseTransform.scale.y * 0.35);
      hingeGroup.add(pin, rTop, rBot);
      hingeGroup.traverse(o => {
        o.renderOrder = 996;
        o.userData.noCollider = true;
      });
      studioMotionHelperGroup.add(hingeGroup);
    }

    const startMarker = createGizmoStyleWaypointMarkerMesh(0x56f0ff, true);
    startMarker.position.copy(baseTransform.pos);
    startMarker.quaternion.copy(baseTransform.quat);
    studioMotionHelperGroup.add(startMarker);

    const wps = Array.isArray(md.waypoints) ? md.waypoints : [];
    const curvePoints = [];
    const totalSegments = wps.length;
    const stepsPerSeg = 16;

    for (let s = 0; s <= totalSegments * stepsPerSeg; s++) {
      const u = s / stepsPerSeg;
      const evalSt = evaluateBlockMotionAtProgress(box, u);
      curvePoints.push(evalSt.pos.clone());
    }

    if (curvePoints.length >= 2) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(curvePoints);
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x00e676,
        depthTest: false,
        transparent: true,
        opacity: 0.92
      });
      const trajLine = new THREE.Line(lineGeo, lineMat);
      trajLine.renderOrder = 995;
      trajLine.userData.noCollider = true;
      studioMotionHelperGroup.add(trajLine);

      const dotGeo = new THREE.OctahedronGeometry(0.065, 0);
      const dotMat = new THREE.MeshBasicMaterial({
        color: 0xffce3a,
        depthTest: false,
        transparent: true,
        opacity: 0.9
      });
      for (let i = 4; i < curvePoints.length - 2; i += 6) {
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(curvePoints[i]);
        dot.renderOrder = 996;
        dot.userData.noCollider = true;
        studioMotionHelperGroup.add(dot);
      }
    }

    box._motionWaypointProxies = [];
    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];
      const isSelectedWp = (md.activeWaypointIdx ?? 0) === i;
      const st = computeBlockMotionTransformAtState(box, baseTransform, wp);

      const wpMarker = createGizmoStyleWaypointMarkerMesh(isSelectedWp ? 0xffce3a : 0x00e676, false);
      wpMarker.position.copy(st.pos);
      wpMarker.quaternion.copy(st.quat);
      wpMarker.scale.set(
        Math.max(0.1, Number(wp.sx) || baseTransform.scale.x),
        Math.max(0.1, Number(wp.sy) || baseTransform.scale.y),
        Math.max(0.1, Number(wp.sz) || baseTransform.scale.z)
      );

      const invSX = 1 / wpMarker.scale.x;
      const invSY = 1 / wpMarker.scale.y;
      const invSZ = 1 / wpMarker.scale.z;
      for (const ch of wpMarker.children) {
        ch.scale.set(invSX, invSY, invSZ);
      }

      const ghostWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(createBlockGeometryByShape(box.shape || 'box')),
        new THREE.LineBasicMaterial({
          color: isSelectedWp ? 0xffce3a : 0x56f0ff,
          depthTest: false,
          transparent: true,
          opacity: isSelectedWp ? 0.85 : 0.45
        })
      );
      ghostWire.renderOrder = 995;
      ghostWire.userData.noCollider = true;
      wpMarker.add(ghostWire);

      wpMarker.traverse(o => {
        o.userData.noCollider = true;
        o.userData.editorRef = {
          kind: 'block',
          box,
          editMode: 'motion_wp',
          wpIdx: i
        };
      });

      studioMotionHelperGroup.add(wpMarker);
      box._motionWaypointProxies.push(wpMarker);
    }
  }

  const targetTag = (hasSignal && box.signalData?.targetTag) || (hasTpTarget && box.interactionData?.tpTargetTag);
  if (targetTag) {
    const targetBox = S.allBlocks.find(
      b => b !== box && (b.id === targetTag || b.signalData?.tag === targetTag || b.logicData?.tag === targetTag || b.label === targetTag)
    );
    if (targetBox && targetBox.m) {
      const p1 = box.m.position.clone();
      const p2 = targetBox.m.position.clone();
      const mid = p1.clone().lerp(p2, 0.5);
      mid.y += 1.2;

      const curve = new THREE.QuadraticBezierCurve3(p1, mid, p2);
      const pts = curve.getPoints(24);
      const linkGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const linkMat = new THREE.LineBasicMaterial({
        color: 0xff9f43,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      });
      const linkLine = new THREE.Line(linkGeo, linkMat);
      linkLine.renderOrder = 996;
      linkLine.userData.noCollider = true;
      studioMotionHelperGroup.add(linkLine);
    }
  }

  scene.add(studioMotionHelperGroup);
}

export function resetAllLogicRuntime(reanchorCurrentAsBase = false) {
  if (S.player && S.player.carriedPhysicsBlock) {
    S.player.carriedPhysicsBlock._isCarriedByPlayer = false;
    S.player.carriedPhysicsBlock = null;
    if (S.player.holdPose === 'carry') S.player.holdPose = null;
  }
  for (const box of S.allBlocks) {
    if (!box.logicRuntime) {
      box.logicRuntime = {
        basePos: null,
        baseQuat: null,
        baseScale: null,
        openT: 0,
        targetU: 0,
        targetOpen: false,
        stayTimer: 0,
        cdTimer: 0,
        ghostOpen: false
      };
    }
    const rt = box.logicRuntime;
    if (reanchorCurrentAsBase || !rt.basePos) {
      rt.basePos = box.m.position.clone();
      rt.baseQuat = box.m.quaternion.clone();
      rt.baseScale = box.m.scale.clone();
    } else {
      box.m.position.copy(rt.basePos);
      if (rt.baseQuat) box.m.quaternion.copy(rt.baseQuat);
      if (rt.baseScale) box.m.scale.copy(rt.baseScale);
      box.m.rotation.setFromQuaternion(box.m.quaternion);
    }
    rt.openT = 0;
    rt.targetU = 0;
    rt.targetOpen = false;
    rt.stayTimer = 0;
    rt.cdTimer = 0;
    box.physVx = 0;
    box.physVy = 0;
    box.physVz = 0;
    box.physWx = 0;
    box.physWy = 0;
    box.physWz = 0;
    box.physGrounded = false;
    box.physInLiquid = false;
    box._isCarriedByPlayer = false;
    box._externalLoadWeight = 0;
    box._externalTorqueX = 0;
    box._externalTorqueZ = 0;
    box._depletedDisabled = false;
    box._interactionDisabled = false;
    delete box._weatherBaseH;
    delete box._weatherBaseY0;
    box._weatherRunoffAccum = 0;
    const isEditMode = S.state === 'edit';
    const vis = !box.isDisabled && !(isEditMode && box.editorHidden);
    box.m.visible = vis;
    if (box.bbmodelGroup) box.bbmodelGroup.visible = vis;
    if (box.haloSprite) box.haloSprite.visible = vis;
    if (box.interactionData && box.interactionData.maxCharges) {
      box.interactionData.chargesLeft = box.interactionData.maxCharges;
    }
    if (rt.ghostOpen && box.m.material) {
      rt.ghostOpen = false;
      box.m.material.transparent = box.matterState !== 'solid';
      box.m.material.opacity = box.matterState === 'solid' ? 1.0 : (box.matterState === 'liquid' ? 0.72 : 0.55);
    }
    updateBlockOBB(box);
    if (box.cpVisualGroup) {
      box.cpVisualGroup.position.copy(box.m.position);
      box.cpVisualGroup.visible = vis;
    }
  }
  if (Array.isArray(S.physicsConstraints)) {
    for (let i = S.physicsConstraints.length - 1; i >= 0; i--) {
      if (S.physicsConstraints[i]._createdInPlay) {
        S.physicsConstraints.splice(i, 1);
      }
    }
  }
  if (S.gmodTool) {
    S.gmodTool.firstHit = null;
  }
  resetSurfaceWeatherLayer(false);
  resetAllStatusEffectsRuntime();
  resetAllScriptsRuntime();
}

function createColliderShapeGeometry(shape, hx, hy, hz) {
  if (shape === 'sphere') {
    const g = new THREE.SphereGeometry(1, 14, 10);
    g.scale(hx, hy, hz);
    return g;
  }
  if (shape === 'cylinder' || shape === 'capsule') {
    const g = new THREE.CylinderGeometry(1, 1, 2, 16);
    g.scale(hx, hy, hz);
    return g;
  }
  if (shape === 'wedge') {
    const g = getWedgeGeometry().clone();
    g.scale(hx * 2, hy * 2, hz * 2);
    return g;
  }
  return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
}

export function rebuildPhysicsArrays() {
  for (const ch of S.colliderHelpers) scene.remove(ch);
  S.colliderHelpers.length = 0;

  for (const box of S.allBlocks) {
    updateBlockOBB(box);
    syncBlockLightVisuals(box);
    const m = box.m;

    if (S.state === 'edit' && box.logicRuntime && S.selectedRef?.editMode !== 'motion_wp' && !box._isPreviewingMotion) {
      box.logicRuntime.basePos = m.position.clone();
      box.logicRuntime.baseQuat = m.quaternion.clone();
      box.logicRuntime.baseScale = m.scale.clone();
      box.logicRuntime.openT = 0;
      box.logicRuntime.targetOpen = false;
      box.logicRuntime.stayTimer = 0;
    }

    syncBoxMaterialTiling(m, box.w, box.h, box.d);
    if (box.cpVisualGroup) {
      box.cpVisualGroup.position.copy(m.position);
      if (box.checkpointData && box.checkpointData.enabled) {
        box.cpVisualGroup.rotation.copy(m.rotation);
      }
    }

    if (box.emptyPivotHelper) {
      box.emptyPivotHelper.visible = (S.state === 'edit') && !box.editorHidden && !box.components?.geometry?.enabled;
    }
    const hasActivePhys = !box.components || Boolean(box.components.physics?.enabled);
    if (S.state === 'edit' && S.showColliders && hasActivePhys && box.matterState !== 'gas') {
      const effColShape = (!box.colliderShape || box.colliderShape === 'auto') ? (box.shape || 'box') : box.colliderShape;
      const colGeo = createColliderShapeGeometry(effColShape, box.hx, box.hy, box.hz);
      const colWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(colGeo),
        new THREE.LineBasicMaterial({
          color: box.damageOnContact > 0 ? 0xff3e3e : 0x00ff88
        })
      );
      colWire.position.copy(m.position);
      colWire.rotation.copy(m.rotation);
      scene.add(colWire);
      S.colliderHelpers.push(colWire);
    }
  }

  if (S.state === 'edit' && S.showColliders) {
    const addEntityColliderHelpers = (ent, wireColor = 0x56f0ff) => {
      if (!ent || !ent.rig || !ent.rig.g) return;
      const pr = (ent.colliderRadius || 0.42) * (ent.rig.g.scale.x || 1);
      const ph = (ent.colliderHeight || 2.5) * (ent.rig.g.scale.y || 1);
      const pWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(pr * 2, ph, pr * 2)),
        new THREE.LineBasicMaterial({ color: wireColor })
      );
      pWire.position.set(ent.x, ent.y + ph / 2, ent.z);
      scene.add(pWire);
      S.colliderHelpers.push(pWire);
    };

    if (S.player) addEntityColliderHelpers(S.player, 0x56f0ff);
    for (const npc of S.customNPCs) addEntityColliderHelpers(npc, 0xff9f43);
  }

  syncStudioMotionAndSignalHelpers();
}

export function addCheckpointBlock(x, y, z, stage, title, rewardCash, skipSpots = 0) {
  return addSceneBlock({
    x,
    y,
    z,
    w: 6.4,
    h: 0.8,
    d: 6.4,
    colorHex: '#ffeaa7',
    gold: true,
    label: `Чекпоинт Обби #${stage}`,
    checkpointData: { enabled: true, stage, title, rewardCash, skipSpots }
  });
}