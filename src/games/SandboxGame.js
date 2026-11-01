// src/games/SandboxGame.js
import { S, $, showBanner } from '../core/State.js';
import { sfx } from '../core/AudioEngine.js';
import { updateEntityAnimation } from '../core/CharacterRig.js';
import { clearWorld, addSceneBlock, addCheckpointBlock, rebuildPhysicsArrays } from '../core/WorldRegistry.js';
import {
  clearEntities,
  spawnPlayer,
  refreshEntityTagWithHP,
  updateShopUI,
  selectSlot
} from '../core/EntityManager.js';

export const SandboxGame = {
  id: 'sandbox_template',
  title: 'Чистая Карта (Sandbox / Obby)',

  init() {
    clearWorld();
    clearEntities();

    // Базовая стартовая платформа (Baseplate) + 1 стартовый чекпоинт
    addSceneBlock({
      x: 0,
      y: 0,
      z: 0,
      w: 44,
      h: 2,
      d: 44,
      colorHex: '#55efc4',
      label: 'Стартовая Платформа (Baseplate)'
    });

    addCheckpointBlock(0, 0.4, -8, 1, 'Стартовый Чекпоинт', 50, 0);

    rebuildPhysicsArrays();
    spawnPlayer({ x: 0, y: 1.0, z: 6 });

    // Скрываем специфичный для "Очереди в Рай" UI
    const posPill = $('posTxt') ? $('posTxt').closest('.pill') : null;
    if (posPill) posPill.hidden = true;
    if ($('eyePill')) $('eyePill').hidden = true;
    if ($('leader')) $('leader').hidden = true;
    if ($('shopPanel')) $('shopPanel').hidden = true;
    if ($('bCut')) $('bCut').hidden = true;

    updateShopUI();
  },

  onEnterPlay() {
    if ($('shopPanel')) $('shopPanel').hidden = true;
    showBanner('🎮 Свободный режим! Строй свою игру в 3D Редакторе (F2)!', '#00e676');
  },

  onUpdateHUD() {},

  onSelectSlot(idx) {
    if (idx === 3 && S.player) {
      S.player.x = S.player.respawnX;
      S.player.y = S.player.respawnY + 1;
      S.player.z = S.player.respawnZ;
      S.player.vy = 0;
      sfx.coil();
      showBanner('☁️ Возврат на точку спавна!', '#56f0ff');
      setTimeout(() => selectSlot(0), 250);
      return true;
    }
    return false;
  },

  onActionKeyE() {},

  onMeleeAttack() {},

  onEntityKnockout(target) {
    showBanner(`🥊 Нокаутирован ${target.name}!`, '#00e676'); },  onCheckpointReached(cd, earned) { updateShopUI(); showBanner(`⭐ ${cd.title}! +${earned} R$!`, '#00e676');
  },

  getRespawnPoint(player) {
    return { x: player.respawnX, y: player.respawnY + 1, z: player.respawnZ };
  },

  getExtraTargets() {
    return [];
  },

  onUpdate(dt, moveLen) {
    const p = S.player;
    if (!p) return;

    if (p.hpBarTimer > 0) {
      p.hpBarTimer -= dt;
      if (p.hpBarTimer <= 0) refreshEntityTagWithHP(p);
    }

    updateEntityAnimation(p, dt, {
      moving: moveLen > 0.1,
      grounded: p.grounded,
      inLiquid: !!p.inLiquid
    });

    p.rig.g.position.set(p.x, p.y, p.z);
    p.rig.g.rotation.y = p.rot;
    p.tag.position.set(p.x, p.y + 3.35, p.z);
  },

  getHintText() {
    return 'Своя Игра · [WASD] Бег · [Пробел] Прыжок · [ЛКМ] Удар рукой · [F2] 3D Редактор';
  }
};