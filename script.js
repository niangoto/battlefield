// script.js
// Пълна реализация — Lanchester-style 2-player duel
// Author: assistant (example). Запиши и отвори index.html

/* ========== ПАРАМЕТРИ ========== */
const CANVAS_W = 1000;
const CANVAS_H = 600;
const MAX_MOVE = 140;                  // максимално разстояние за движение/достъп
const ATTACK_ANGLE_DEG = 90;           // конус ±90°
const MIN_FRACTION = 1/20;             // под това се премахва
const COLLIDE_BUFFER = 4;              // минимално разстояние преди считане за припокриване
const MOVE_ANIM_MS = 700;              // продължителност на анимацията в ms
const K_LANCH = 0.02;                  // коефициент за щети (tweakable)
const MIN_PLACEMENT_SPACING = 28;      // min spacing при разполагане
const SIZE_BASE = 12;                  // базов визуален параметър
const MERGE_THRESHOLD_DEFAULT = 0.5;   // прагове за сливане

/* ========== DOM ========== */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

const startBtn = document.getElementById('startBtn');
const readyBtn = document.getElementById('readyBtn');
const resetBtn = document.getElementById('resetBtn');
const phaseInfo = document.getElementById('phaseInfo');
const playerInfo = document.getElementById('playerInfo');
const allowOverlapInput = document.getElementById('allowOverlap');
const mergeThreshInput = document.getElementById('mergeThresh');
const p1countInput = document.getElementById('p1count');
const p2countInput = document.getElementById('p2count');
const p1valInput = document.getElementById('p1val');
const p2valInput = document.getElementById('p2val');

let allowOverlap = allowOverlapInput.checked;
let mergeThresh = Number(mergeThreshInput.value);

/* ========== ИГРОВО СЪСТОЯНИЕ ========== */
let phase = 'idle'; // 'placement', 'movementSetup', 'battle', 'animation'
let currentPlacingPlayer = 1;
let currentPlanningPlayer = 1;
let placedCounts = {1:0,2:0};
let plannedCounts = {1:0,2:0};

let units = []; // масив от обекти: {id, player, x,y, strength, initialStrength, dir:{x,y}, planned:{dir,len}, orderGiven, visible}
let nextId = 1;

/* ========== HELPERS ========== */
function genId(){ return nextId++; }
function len(v){ return Math.hypot(v.x, v.y); }
function norm(v){ const L = len(v)||1; return {x:v.x/L,y:v.y/L}; }
function dot(a,b){return a.x*b.x + a.y*b.y;}
function degToRad(d){return d*Math.PI/180;}
function radToDeg(r){return r*180/Math.PI;}
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function angleBetween(a,b){ const d = clamp(dot(norm(a), norm(b)), -1, 1); return Math.acos(d); }

/* ========== UI ИНИЦИАЛИЗАЦИЯ ========== */
function uiUpdate(){
  phaseInfo.textContent = `Фаза: ${phase}`;
  playerInfo.textContent = `Разполагане: ${currentPlacingPlayer}, Планиране: ${currentPlanningPlayer}`;
  allowOverlap = allowOverlapInput.checked;
  mergeThresh = Number(mergeThreshInput.value);
}
allowOverlapInput.addEventListener('change', uiUpdate);
mergeThreshInput.addEventListener('input', uiUpdate);

startBtn.addEventListener('click', ()=> {
  resetGame();
  // prepare counts/values
  const p1count = clampInt(Number(p1countInput.value||5),1,20);
  const p2count = clampInt(Number(p2countInput.value||5),1,20);
  const p1val = Math.max(1, Math.floor(Number(p1valInput.value||100)));
  const p2val = Math.max(1, Math.floor(Number(p2valInput.value||100)));
  settings.p1count = p1count; settings.p2count = p2count;
  settings.p1val = p1val; settings.p2val = p2val;
  phase = 'placement';
  currentPlacingPlayer = 1;
  placedCounts = {1:0,2:0};
  uiUpdate();
  draw();
});

readyBtn.addEventListener('click', ()=>{
  if (phase === 'placement'){
    // if currently in placement: move to next player or movementSetup if done
    // rule: alternate placing 1 by 1
    // if both completed -> to movementSetup
    if (placedCounts[1] >= settings.p1count && placedCounts[2] >= settings.p2count){
      phase = 'movementSetup';
      currentPlanningPlayer = 1;
      plannedCounts = {1:0,2:0};
    } else {
      // toggle placing player if other still not finished
      const other = currentPlacingPlayer===1 ? 2 : 1;
      if (placedCounts[other] < (other===1?settings.p1count:settings.p2count)){
        currentPlacingPlayer = other;
      }
    }
    uiUpdate();
  } else if (phase === 'movementSetup'){
    // mark this player's planning finished and switch; when both ready -> battle
    // require orderGiven for all their units? We'll allow proceed if player presses ready; we count plannedCounts to approximate
    const other = currentPlanningPlayer===1?2:1;
    if (plannedCounts[other] >= (other===1?settings.p1count:settings.p2count)){
      // both have planned -> start battle
      phase = 'battle';
      uiUpdate();
      startBattleCycle();
    } else {
      currentPlanningPlayer = other;
      uiUpdate();
    }
  } else if (phase === 'battle'){
    // during battle, ready acts as 'skip' to go to next round after anim
  }
});

resetBtn.addEventListener('click', resetGame);

function clampInt(v,min,max){ v = Math.floor(v||0); if (isNaN(v)) v=min; return Math.max(min, Math.min(max, v)); }

const settings = {
  p1count: 5,
  p2count: 5,
  p1val: 120,
  p2val: 120
}

/* ========== INPUT HANDLING ========== */
let mouse = {x:0,y:0, down:false};
let selectedId = null;

canvas.addEventListener('mousemove', (e)=>{
  const r = canvas.getBoundingClientRect();
  mouse.x = e.clientX - r.left;
  mouse.y = e.clientY - r.top;
});

canvas.addEventListener('mousedown', (e)=>{
  if (e.button !== 0) return;
  mouse.down = true;
  handleClick(e);
});

canvas.addEventListener('mouseup', (e)=>{
  mouse.down = false;
});

canvas.addEventListener('dblclick', (e)=>{
  // split unit if possible
  const u = unitAtPoint(mouse.x, mouse.y);
  if (!u) return;
  // restrict split: half must be >= 2 * initial*MIN_FRACTION ? Use user's phrase interpretation
  const minAllowed = 2 * (u.initialStrength * MIN_FRACTION);
  const half = Math.floor(u.strength / 2);
  if (half < minAllowed || half < 1) return; // cannot split
  // place second half offset a bit
  u.strength = half;
  const angle = Math.random()*Math.PI*2;
  const offset = Math.min(30, 10 + Math.sqrt(half));
  const nx = clamp(u.x + Math.cos(angle)*offset, 20, CANVAS_W-20);
  const ny = clamp(u.y + Math.sin(angle)*offset, 20, CANVAS_H-20);
  const newUnit = {
    id: genId(),
    player: u.player,
    x: nx, y: ny,
    strength: Math.floor( (u.strength) ), // already modified
    initialStrength: u.initialStrength,
    dir: {...u.dir},
    planned: null,
    orderGiven: false,
    visible: true
  };
  units.push(newUnit);
  draw();
});

function handleClick(e){
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  if (phase === 'placement'){
    placeUnitAt(x,y);
  } else if (phase === 'movementSetup'){
    const u = unitAtPoint(x,y);
    if (u && u.player === currentPlanningPlayer){
      // select unit to plan movement
      selectedId = u.id;
    } else if (selectedId){
      // set planned movement for selected
      const su = units.find(z => z.id === selectedId);
      if (!su) { selectedId = null; return; }
      const v = {x: x - su.x, y: y - su.y};
      const d = len(v);
      if (d < 8){ // tiny => clear planned
        su.planned = null;
      } else {
        const dir = norm(v);
        const lenPlanned = clamp(d, 10, MAX_MOVE);
        su.planned = { dir, len: lenPlanned };
        su.orderGiven = true;
        // update facing dir to planned direction
        su.dir = {...dir};
        plannedCounts[su.player] = (plannedCounts[su.player]||0) + 1;
      }
      selectedId = null;
    }
    draw();
  }
}

/* ========== PLACEMENT ========== */
function placeUnitAt(x,y){
  // must be in player's half
  const area = currentPlacingPlayer === 1 ? {x:0, w:CANVAS_W/2} : {x:CANVAS_W/2, w:CANVAS_W/2};
  if (x < area.x + 20 || x > area.x + area.w - 20) return;
  // enforce spacing among own units
  const coll = units.some(u => u.player === currentPlacingPlayer && dist(u,{x,y}) < MIN_PLACEMENT_SPACING);
  if (coll) return;
  // create unit
  const val = currentPlacingPlayer === 1 ? settings.p1val : settings.p2val;
  const u = {
    id: genId(),
    player: currentPlacingPlayer,
    x: x, y: y,
    strength: val,
    initialStrength: val,
    dir: {x: currentPlacingPlayer===1 ? 1: -1, y:0}, // facing outward
    planned: null,
    orderGiven: false,
    visible: true
  };
  units.push(u);
  placedCounts[currentPlacingPlayer] += 1;
  // alternate placing if other not finished
  const other = currentPlacingPlayer===1?2:1;
  if (placedCounts[other] < (other===1?settings.p1count:settings.p2count)){
    currentPlacingPlayer = other;
  } else {
    // continue placing same player until done
    if (placedCounts[currentPlacingPlayer] >= (currentPlacingPlayer===1?settings.p1count:settings.p2count)){
      // if both done -> movementSetup
      if (placedCounts[1] >= settings.p1count && placedCounts[2] >= settings.p2count){
        phase = 'movementSetup';
        currentPlanningPlayer = 1;
        plannedCounts = {1:0,2:0};
      }
    }
  }
  uiUpdate();
  draw();
}

/* ========== BATTLE CYCLE ========== */
function startBattleCycle(){
  // Hide only arrows in drawing; execute attack/resolution; animate movement according to rules
  // 1) determine which units attack which (within MAX_MOVE and within ATTACK_ANGLE_DEG)
  // 2) attackers split their strength among their chosen targets -> contributions
  // 3) defenders accumulate incoming; defenders that don't attack contribute only 1/10 of strength
  // 4) compute losses using K_LANCH multiplier (discrete)
  // 5) determine for each unit if it retreats (incomingSum > own strength): compute aggregate attack direction, retreatDir=-agg; compare with planned dir; choose direction accordingly
  // 6) animate movements with collision blocking; after animation apply resulting strengths and merges; remove weak units; return to movementSetup

  phase = 'animation';
  uiUpdate();
  draw(true); // hide arrows
  // compute attack maps
  const attackersTargets = new Map(); // attackerId -> [defenderIds]
  const defendersIncoming = new Map(); // defenderId -> [{attackerId, value, dir}]

  // helper: for each unit, build facing (planned.dir if exists else dir)
  const facings = new Map();
  units.forEach(u => {
    const f = u.planned ? u.planned.dir : u.dir;
    facings.set(u.id, norm(f));
  });

  // find targets
  for (const u of units){
    const f = facings.get(u.id);
    const targets = [];
    for (const v of units){
      if (v.player === u.player) continue;
      const rel = {x: v.x - u.x, y: v.y - u.y};
      const d = len(rel);
      if (d <= MAX_MOVE + 1e-6){
        const dirTo = norm(rel);
        const ang = Math.abs(radToDeg(angleBetween(dirTo, f)));
        if (ang <= ATTACK_ANGLE_DEG){
          targets.push({id: v.id, dist: d});
        }
      }
    }
    attackersTargets.set(u.id, targets.map(t=>t.id));
  }

  // contributions
  for (const u of units){
    const t = attackersTargets.get(u.id) || [];
    if (t.length === 0) continue;
    const per = u.strength / t.length;
    for (const did of t){
      if (!defendersIncoming.has(did)) defendersIncoming.set(did, []);
      defendersIncoming.get(did).push({ attackerId: u.id, value: per, dir: facings.get(u.id) });
    }
  }

  // compute casualties and plan retreat/movement vectors
  const postUnits = units.map(u => ({ ...u })); // shallow copy
  const movePlans = []; // {id, dir:{}, len}
  // compute per-defender losses and attacker losses
  for (const du of postUnits){
    const incoming = defendersIncoming.get(du.id) || [];
    const incomingSum = incoming.reduce((s,a)=>s+a.value, 0);
    const defenderAttacks = (attackersTargets.get(du.id) || []).length > 0;
    const effectiveDefense = defenderAttacks ? du.strength : du.strength * 0.1;

    // defender loss is scaled by incomingSum
    const defenderLoss = Math.min(du.strength, Math.ceil(K_LANCH * incomingSum));
    du.strength = Math.max(0, du.strength - defenderLoss);

    // attacker losses distributed proportionally to contribution
    if (incomingSum > 0){
      for (const inc of incoming){
        const attacker = postUnits.find(x => x.id === inc.attackerId);
        if (!attacker) continue;
        const frac = inc.value / incomingSum;
        const attackerLoss = Math.ceil(frac * (K_LANCH * effectiveDefense));
        attacker.strength = Math.max(0, attacker.strength - attackerLoss);
      }
    }
  }

  // determine moves/retreats for surviving units (based on pre-loss incoming sums)
  for (const u of units){
    if (u.strength <= 0) {
      // skip dead (they may be removed later)
      movePlans.push({id:u.id, dir:{x:0,y:0}, len:0});
      continue;
    }
    const incoming = defendersIncoming.get(u.id) || [];
    const incomingSum = incoming.reduce((s,a)=>s+a.value,0);
    // if incomingSum > current strength (note: use pre-modified? we used original incoming sums)
    // Choose retreat vs assigned dir
    let assignedDir = u.planned ? u.planned.dir : u.dir;
    if (!assignedDir) assignedDir = u.dir || {x:1,y:0};
    assignedDir = norm(assignedDir);

    if (incomingSum > u.strength){
      // compute weighted attack vector
      const agg = incoming.reduce((acc,a)=>({x:acc.x + a.dir.x*a.value, y:acc.y + a.dir.y*a.value}), {x:0,y:0});
      if (len(agg) === 0){
        // fallback: retreat opposite of assigned dir
        var retreatDir = {x:-assignedDir.x, y:-assignedDir.y};
      } else {
        var retreatDir = norm({x:-agg.x, y:-agg.y}); // opposite of aggregate attack direction
      }
      // compare retreatDir and assignedDir
      const ang = Math.abs(radToDeg(angleBetween(retreatDir, assignedDir)));
      if (ang > 90){
        // execute retreat
        const retreatLen = clamp(40 + incomingSum*0.2, 20, MAX_MOVE);
        movePlans.push({id:u.id, dir:retreatDir, len:retreatLen});
      } else {
        // keep assigned
        const plannedLen = u.planned ? u.planned.len : Math.min(80, 20 + u.strength*0.1);
        movePlans.push({id:u.id, dir:assignedDir, len:plannedLen});
      }
    } else {
      // no retreat -> follow assigned (but if none, stay)
      const plannedLen = u.planned ? u.planned.len : 0;
      movePlans.push({id:u.id, dir:assignedDir, len:plannedLen});
    }
  }

  // apply losses computed in postUnits back to units by id
  for (const pu of postUnits){
    const original = units.find(u=>u.id===pu.id);
    if (original) original.tempNewStrength = pu.strength; // store temporary, we'll commit after animation
  }

  // animate moves with collision avoidance
  animateMoves(movePlans, ()=> {
    // after animation commit strengths, merge, remove weak, clear planned flags, go to movementSetup
    for (const u of units){
      if (u.tempNewStrength !== undefined) {
        u.strength = u.tempNewStrength;
        delete u.tempNewStrength;
      }
      // reset planned (commands executed)
      u.planned = null;
      u.orderGiven = false;
    }
    mergeOverlaps();
    removeWeak();
    phase = 'movementSetup';
    // alternate planning start to player 1
    currentPlanningPlayer = 1;
    plannedCounts = {1:0,2:0};
    uiUpdate();
    draw();
  });
}

/* ========== ANIMATION + COLLISION HANDLING ========== */
function animateMoves(movePlans, onComplete){
  // Build start & target positions
  const startPositions = new Map();
  const targets = new Map();
  for (const u of units){
    startPositions.set(u.id, {x:u.x, y:u.y});
  }
  for (const mp of movePlans){
    const s = startPositions.get(mp.id);
    if (!s){ targets.set(mp.id, {x:s.x, y:s.y}); continue; }
    const tgt = { x: s.x + mp.dir.x * mp.len, y: s.y + mp.dir.y * mp.len };
    // clamp to canvas bounds
    tgt.x = clamp(tgt.x, 16, CANVAS_W-16);
    tgt.y = clamp(tgt.y, 16, CANVAS_H-16);
    targets.set(mp.id, tgt);
  }

  const startTime = performance.now();
  const duration = MOVE_ANIM_MS;
  const ids = Array.from(startPositions.keys());

  function step(now){
    const t = clamp((now - startTime) / duration, 0, 1);
    const eased = easeOutQuad(t);
    // compute provisional positions
    const provisional = new Map();
    for (const id of ids){
      const s = startPositions.get(id);
      const tgt = targets.get(id) || s;
      const nx = s.x + (tgt.x - s.x) * eased;
      const ny = s.y + (tgt.y - s.y) * eased;
      provisional.set(id, {x:nx, y:ny});
    }

    // collision blocking: ensure enemy units do not pass through other units
    // simple approach: if two units (of any player) would be closer than allowed, push the moving one back along its path to avoid overlap
    const adjusted = new Map(provisional);
    for (const a of units){
      const pa = provisional.get(a.id);
      if (!pa) continue;
      for (const b of units){
        if (a.id === b.id) continue;
        const pb = provisional.get(b.id);
        if (!pb) continue;
        // allowed minimal distance based on sizes
        const ra = getRadius(a), rb = getRadius(b);
        const minD = (ra + rb) - ( (ra+rb) * mergeThresh ); // threshold for considering too-close
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        if (d < minD + COLLIDE_BUFFER){
          // push 'a' back along its path toward its start
          const start = startPositions.get(a.id);
          const dir = {x: pa.x - start.x, y: pa.y - start.y};
          const L = len(dir);
          if (L > 1e-6){
            const allowedMove = Math.max(0, L - (minD + COLLIDE_BUFFER - d));
            const ratio = allowedMove / (L || 1);
            const nx = start.x + dir.x * ratio;
            const ny = start.y + dir.y * ratio;
            adjusted.set(a.id, {x:nx, y:ny});
          } else {
            adjusted.set(a.id, {x:pa.x, y:pa.y});
          }
        }
      }
    }

    // commit adjusted positions to units for rendering (do not overwrite stored x,y until final)
    for (const u of units){
      const p = adjusted.get(u.id);
      if (p){
        u.renderX = p.x;
        u.renderY = p.y;
        // update dir to be movement direction for visual (perpendicular rotation)
        const s = startPositions.get(u.id);
        const mv = {x: p.x - s.x, y: p.y - s.y};
        if (len(mv) > 0.5){
          u.dir = norm(mv);
        }
      } else {
        u.renderX = u.x;
        u.renderY = u.y;
      }
    }

    // draw without arrows (we are animating)
    draw(true);

    if (t < 1){
      requestAnimationFrame(step);
    } else {
      // finalize positions
      for (const u of units){
        u.x = u.renderX !== undefined ? u.renderX : u.x;
        u.y = u.renderY !== undefined ? u.renderY : u.y;
        delete u.renderX; delete u.renderY;
      }
      if (typeof onComplete === 'function') onComplete();
    }
  }

  requestAnimationFrame(step);
}

function easeOutQuad(t){ return t*(2-t); }

/* ========== HELPERS: sizes, merge, remove ========== */
function getRadius(u){
  // approximate radius from strength (for collision & merge)
  return SIZE_BASE + Math.sqrt(u.strength);
}
function mergeOverlaps(){
  if (!allowOverlap) return;
  const merged = [];
  const used = new Set();
  for (let i=0;i<units.length;i++){
    if (used.has(units[i].id)) continue;
    let base = {...units[i]};
    for (let j=i+1;j<units.length;j++){
      if (used.has(units[j].id)) continue;
      if (units[j].player !== base.player) continue;
      const d = dist(base, units[j]);
      const ra = getRadius(base), rb = getRadius(units[j]);
      const overlap = (ra + rb) - d;
      if (overlap > Math.min(ra,rb) * mergeThresh){
        // merge
        base.strength += units[j].strength;
        base.initialStrength = Math.max(base.initialStrength||0, units[j].initialStrength||0);
        used.add(units[j].id);
      }
    }
    merged.push(base);
  }
  units = merged;
}

function removeWeak(){
  units = units.filter(u => u.strength >= (u.initialStrength * MIN_FRACTION));
}

/* ========== RENDERING ========== */
function draw(hideArrows=false){
  ctx.clearRect(0,0,CANVAS_W,CANVAS_H);

  // draw middle line separator
  ctx.save();
  ctx.strokeStyle = '#203142';
  ctx.setLineDash([6,6]);
  ctx.beginPath();
  ctx.moveTo(CANVAS_W/2, 6);
  ctx.lineTo(CANVAS_W/2, CANVAS_H-6);
  ctx.stroke();
  ctx.restore();

  // draw planned arrows (if any) — arrows hidden only during actual battle / animation when hideArrows true
  if (!hideArrows && (phase === 'movementSetup' || phase === 'placement')){
    for (const u of units){
      if (u.planned && u.visible){
        drawArrow(u.x, u.y, u.planned.dir.x * u.planned.len + u.x, u.planned.dir.y * u.planned.len + u.y, u.player);
      }
    }
  }

  // draw units
  for (const u of units){
    if (!u.visible) continue;
    const sizeW = getRectSize(u); // width
    const sizeH = getRectHeight(u);
    // compute rotation: rectangle is perpendicular to movement dir, so angle = angle(dir) + 90deg
    const facing = u.dir || {x:1,y:0};
    const angle = Math.atan2(facing.y, facing.x) + Math.PI/2;
    const cx = u.renderX !== undefined ? u.renderX : u.x;
    const cy = u.renderY !== undefined ? u.renderY : u.y;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    // fill rectangle
    ctx.fillStyle = u.player === 1 ? '#06b6d4' : '#fb7185';
    // stroke
    ctx.strokeStyle = '#08303a';
    ctx.lineWidth = 1;
    roundRect(ctx, -sizeW/2, -sizeH/2, sizeW, sizeH, 6, true, true);
    ctx.restore();

    // draw value behind rectangle (opposite to facing)
    const backOffset = 6 + Math.max(sizeW, sizeH)/2;
    const textX = cx - (facing.x * backOffset);
    const textY = cy - (facing.y * backOffset);
    const fontSize = Math.max(10, 10 + Math.log(u.strength+1)*3);
    ctx.fillStyle = '#e6eef6';
    ctx.font = `${Math.round(fontSize)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Math.round(u.strength), textX, textY);

    // highlight if selected
    if (selectedId === u.id && phase === 'movementSetup'){
      ctx.beginPath();
      ctx.strokeStyle = '#ffd54d';
      ctx.lineWidth = 2;
      ctx.ellipse(cx, cy, sizeW, sizeH, angle, 0, Math.PI*2);
      ctx.stroke();
    }
  }

  // HUD
  uiUpdate();
}

function getRectSize(u){
  // width proportional to sqrt(strength)
  return (SIZE_BASE*2) + Math.sqrt(u.strength)*3;
}
function getRectHeight(u){
  return (SIZE_BASE) + Math.sqrt(u.strength)*1.4;
}

function drawArrow(x1,y1,x2,y2,player){
  // simple arrow
  ctx.save();
  ctx.strokeStyle = player===1 ? '#0ea5a4' : '#f43f5e';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1,y1);
  ctx.lineTo(x2,y2);
  ctx.stroke();
  // triangle head
  const angle = Math.atan2(y2-y1, x2-x1);
  const headlen = 8;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headlen*Math.cos(angle - Math.PI/6), y2 - headlen*Math.sin(angle - Math.PI/6));
  ctx.lineTo(x2 - headlen*Math.cos(angle + Math.PI/6), y2 - headlen*Math.sin(angle + Math.PI/6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// rounded rectangle helper
function roundRect(ctx, x, y, w, h, r, fill, stroke){
  if (r === undefined) r = 5;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

/* ========== UTILITIES ========== */
function unitAtPoint(x,y){
  for (let i = units.length - 1; i >= 0; i--){
    const u = units[i];
    const rx = getRectSize(u)/2, ry = getRectHeight(u)/2;
    const dx = Math.abs(x - u.x), dy = Math.abs(y - u.y);
    if (dx <= rx && dy <= ry) return u;
  }
  return null;
}

function resetGame(){
  units = [];
  phase = 'idle';
  currentPlacingPlayer = 1;
  currentPlanningPlayer = 1;
  placedCounts = {1:0,2:0};
  plannedCounts = {1:0,2:0};
  selectedId = null;
  nextId = 1;
  uiUpdate();
  draw();
}

/* ========== POST-BATTLE CLEANUPS ========== */
function removeWeak(){
  units = units.filter(u => u.strength >= u.initialStrength * MIN_FRACTION);
}

/* ========== MERGE + REMOVE duplicates (callable externally but also in flow) ========== */
function mergeOverlaps(){
  if (!allowOverlap) return;
  const newUnits = [];
  const used = new Set();
  for (let i=0;i<units.length;i++){
    if (used.has(units[i].id)) continue;
    let base = {...units[i]};
    for (let j=i+1;j<units.length;j++){
      if (used.has(units[j].id)) continue;
      if (units[j].player !== base.player) continue;
      const d = dist(base, units[j]);
      const ra = getRadius(base), rb = getRadius(units[j]);
      const overlap = (ra + rb) - d;
      if (overlap > Math.min(ra,rb) * mergeThresh){
        base.strength += units[j].strength;
        base.initialStrength = Math.max(base.initialStrength || 0, units[j].initialStrength || 0);
        used.add(units[j].id);
      }
    }
    newUnits.push(base);
  }
  units = newUnits;
}

/* ========== STARTUP ========== */
// start with empty canvas and show initial info
uiUpdate();
draw();

/* ========== small convenience: auto-draw loop to show hover / dynamic states ========== */
setInterval(()=>{ draw(); }, 1200);

// End of script.js
