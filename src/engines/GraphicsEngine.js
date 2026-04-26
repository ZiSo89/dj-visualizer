// src/engines/GraphicsEngine.js — Phase 3 + Phase 5 (SolarSystem + ColorPalettes)
// ─────────────────────────────────────────────────────────────────
// Three.js scene + ParticleSystem + HolographicHand
// + SolarSystem + ColorSystem
// Auto quality manager reserved for Phase 6
// ─────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { state, updateState } from '../core/StateManager.js';
import { on } from '../core/EventBus.js';
import { mediapipeToThreeJS } from '../utils/CoordinateMapper.js';

// ════════════════════════════════════════════════════════════════
// Hand topology — finger connections for HolographicHand
// ════════════════════════════════════════════════════════════════
const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],           // Thumb
  [0,5],[5,6],[6,7],[7,8],           // Index
  [0,9],[9,10],[10,11],[11,12],      // Middle
  [0,13],[13,14],[14,15],[15,16],    // Ring
  [0,17],[17,18],[18,19],[19,20],    // Pinky
  [5,9],[9,13],[13,17]               // Palm cross
];

// ════════════════════════════════════════════════════════════════
// StarField — Milky Way background (replaces particle system)
// ════════════════════════════════════════════════════════════════
class StarField {
  constructor(scene) {
    this.scene = scene;
    this._init();
  }

  _init() {
    // Circular star sprite via canvas
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const ctx2d = canvas.getContext('2d');
    const grad = ctx2d.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0,   'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1,   'rgba(255,255,255,0)');
    ctx2d.fillStyle = grad;
    ctx2d.fillRect(0, 0, 32, 32);
    const starTex = new THREE.CanvasTexture(canvas);

    const TOTAL = 14000;
    const positions = new Float32Array(TOTAL * 3);
    const colors    = new Float32Array(TOTAL * 3);

    // Realistic stellar color palette
    const palette = [
      new THREE.Color(0xffffff),  // white (G-type)
      new THREE.Color(0xbbddff),  // blue-white (A-type)
      new THREE.Color(0x99bbff),  // blue (B/O-type)
      new THREE.Color(0xffeedd),  // warm white (F-type)
      new THREE.Color(0xffddaa),  // orange (K-type)
      new THREE.Color(0xfff6e8),  // slight warm white
    ];

    for (let i = 0; i < TOTAL; i++) {
      const i3 = i * 3;
      let x, y, z;

      if (i < 2500) {
        // Central galactic bulge — minimum 60 units away
        const r     = 60 + Math.random() * 80;
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        x = r * Math.sin(phi) * Math.cos(theta);
        y = r * Math.sin(phi) * Math.sin(theta) * 0.35;
        z = r * Math.cos(phi);
      } else if (i < 11500) {
        // Galactic disk — thin flat band, minimum 60 units from centre
        const r     = 60 + Math.pow(Math.random(), 1.2) * 260;
        const theta = Math.random() * Math.PI * 2;
        const thick = Math.max(2, 12 * (1 - r / 320));
        x = r * Math.cos(theta);
        y = (Math.random() - 0.5) * thick;
        z = r * Math.sin(theta);
      } else {
        // Sparse stellar halo — large sphere, minimum 120 units
        const r     = 120 + Math.random() * 230;
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        x = r * Math.sin(phi) * Math.cos(theta);
        y = r * Math.sin(phi) * Math.sin(theta);
        z = r * Math.cos(phi);
      }

      positions[i3]     = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;

      const col        = palette[Math.floor(Math.random() * palette.length)];
      const brightness = 0.4 + Math.random() * 0.6;
      colors[i3]     = col.r * brightness;
      colors[i3 + 1] = col.g * brightness;
      colors[i3 + 2] = col.b * brightness;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.9,
      map: starTex,
      alphaMap: starTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true
    });

    this.points = new THREE.Points(geo, mat);
    this.scene.add(this.points);
  }

  update(deltaTime) {
    // Very slow galactic drift rotation
    if (this.points) this.points.rotation.y += deltaTime * 0.0015;
  }

  setColor() { /* no-op — stars keep their natural colors */ }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// ════════════════════════════════════════════════════════════════
// HolographicHand
// ════════════════════════════════════════════════════════════════
class HolographicHand {
  constructor(scene, handedness) {
    this.handedness = handedness;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.pulsePhase = 0;

    // 21 landmark spheres (shared geometry, individual materials)
    const sphereGeo = new THREE.SphereGeometry(0.015, 6, 6);
    this.spheres = Array.from({ length: 21 }, () => {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00ffff, transparent: true, opacity: 0.9,
        depthTest: false
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.renderOrder = 999;
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    });

    // Connection lines
    this.lines = CONNECTIONS.map(() => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3()
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0x0088ff, transparent: true, opacity: 0.6,
        depthTest: false
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.renderOrder = 998;
      this.group.add(line);
      return line;
    });

    this.landmarkPositions = Array.from({ length: 21 }, () => new THREE.Vector3());
  }

  update(handData) {
    if (!handData || !handData.detected || !handData.landmarks) {
      this.spheres.forEach(s => { s.visible = false; });
      this.lines.forEach(l => { l.visible = false; });
      return;
    }

    this.pulsePhase += 0.05;
    const pulseScale = 1 + Math.sin(this.pulsePhase) * 0.05;
    const pinching = handData.pinching;

    // Update landmark positions — track total movement for lazy line updates
    let moved = 0;
    handData.landmarks.forEach((lm, i) => {
      const { x, y, z } = mediapipeToThreeJS(lm.x, lm.y, lm.z);
      moved += Math.abs(x - this.landmarkPositions[i].x)
             + Math.abs(y - this.landmarkPositions[i].y);
      this.landmarkPositions[i].set(x, y, z);

      this.spheres[i].position.copy(this.landmarkPositions[i]);
      this.spheres[i].scale.setScalar(pulseScale);
      this.spheres[i].visible = true;

      // Pinch highlight: thumb tip (4) and index tip (8) → magenta
      const isPinchPoint = (i === 4 || i === 8);
      this.spheres[i].material.color.setHex(
        (isPinchPoint && pinching) ? 0xff00ff : 0x00ffff
      );
    });

    // Only update line geometry buffers when landmarks actually moved
    if (moved > 0.002) {
      CONNECTIONS.forEach(([a, b], idx) => {
        const line = this.lines[idx];
        const positions = line.geometry.attributes.position;
        positions.setXYZ(0, ...this.landmarkPositions[a].toArray());
        positions.setXYZ(1, ...this.landmarkPositions[b].toArray());
        positions.needsUpdate = true;
        line.visible = true;
      });
    } else {
      this.lines.forEach(l => { l.visible = true; });
    }
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.spheres.forEach(s => { s.geometry.dispose(); s.material.dispose(); });
    this.lines.forEach(l => { l.geometry.dispose(); l.material.dispose(); });
  }
}

// ════════════════════════════════════════════════════════════════
// ColorSystem — smooth palette transitions between planets
// ════════════════════════════════════════════════════════════════
const PALETTES = {
  sun:     { ambient: 0x553322, pointLight: 0xffcc66, particle: 0xff6600, fog: 0x0a0400, bg: 0x050200 },
  mercury: { ambient: 0x443333, pointLight: 0xddccbb, particle: 0xaaaaaa, fog: 0x060404, bg: 0x020202 },
  venus:   { ambient: 0x554422, pointLight: 0xffcc88, particle: 0xffaa44, fog: 0x0a0602, bg: 0x050301 },
  earth:   { ambient: 0x224466, pointLight: 0x66aaff, particle: 0x00ccff, fog: 0x000a10, bg: 0x000508 },
  mars:    { ambient: 0x553311, pointLight: 0xff6622, particle: 0xff2200, fog: 0x0a0200, bg: 0x050100 },
  jupiter: { ambient: 0x332255, pointLight: 0xcc66ff, particle: 0x8800ff, fog: 0x06000a, bg: 0x030005 },
  saturn:  { ambient: 0x444422, pointLight: 0xffee44, particle: 0xffaa00, fog: 0x0a0800, bg: 0x050400 },
  uranus:  { ambient: 0x224444, pointLight: 0x44ffee, particle: 0x00ffdd, fog: 0x000a0a, bg: 0x000505 },
  neptune: { ambient: 0x111155, pointLight: 0x4466ff, particle: 0x0022ff, fog: 0x00000a, bg: 0x000003 }
};

class ColorSystem {
  constructor(ambientLight, pointLight, particleSystem, scene) {
    this.ambientLight = ambientLight;
    this.pointLight = pointLight;
    this.particleSystem = particleSystem;
    this.scene = scene;
    this.fromPalette = this._hexPalette('sun');
    this.toPalette = this._hexPalette('sun');
    this.lerpT = 1.0;
  }

  _hexPalette(name) {
    const p = PALETTES[name];
    return {
      ambient:    new THREE.Color(p.ambient),
      pointLight: new THREE.Color(p.pointLight),
      particle:   new THREE.Color(p.particle),
      fog:        new THREE.Color(p.fog),
      bg:         new THREE.Color(p.bg)
    };
  }

  transitionTo(planetName) {
    this.fromPalette = {
      ambient:    this.ambientLight.color.clone(),
      pointLight: this.pointLight.color.clone(),
      particle:   this.fromPalette.particle.clone(),
      fog:        this.scene.fog.color.clone(),
      bg:         this.scene.background.clone()
    };
    this.toPalette = this._hexPalette(planetName);
    this.lerpT = 0.0;
  }

  update(deltaTime) {
    if (this.lerpT >= 1.0) return;
    this.lerpT = Math.min(1.0, this.lerpT + deltaTime * 0.12);
    const t = this.lerpT;

    this.ambientLight.color.copy(this.fromPalette.ambient).lerp(this.toPalette.ambient, t);
    this.pointLight.color.copy(this.fromPalette.pointLight).lerp(this.toPalette.pointLight, t);
    this.scene.fog.color.copy(this.fromPalette.fog).lerp(this.toPalette.fog, t);
    this.scene.background.copy(this.fromPalette.bg).lerp(this.toPalette.bg, t);

    const particleColor = this.fromPalette.particle.clone().lerp(this.toPalette.particle, t);
    this.particleSystem.setColor(particleColor);
  }
}

// ════════════════════════════════════════════════════════════════
// SolarSystem — planets, sun, camera fly-to
// ════════════════════════════════════════════════════════════════
const PLANET_DATA = [
  { name: 'mercury', radius: 0.12, distance:  2.2, orbitSpeed: 0.020,  rotationSpeed: 0.040, texture: null,           color: 0x998877 },
  { name: 'venus',   radius: 0.30, distance:  3.3, orbitSpeed: 0.013,  rotationSpeed: 0.008, texture: null,           color: 0xddaa66 },
  { name: 'earth',   radius: 0.40, distance:  4.8, orbitSpeed: 0.008,  rotationSpeed: 0.030, texture: 'earth.jpg',   color: 0x2255aa },
  { name: 'mars',    radius: 0.22, distance:  6.5, orbitSpeed: 0.005,  rotationSpeed: 0.029, texture: 'mars.jpg',    color: 0xcc4422 },
  { name: 'jupiter', radius: 0.90, distance: 10.0, orbitSpeed: 0.002,  rotationSpeed: 0.070, texture: 'jupiter.jpg', color: 0xddaa55 },
  { name: 'saturn',  radius: 0.75, distance: 14.0, orbitSpeed: 0.0012, rotationSpeed: 0.065, texture: null,           color: 0xddcc88 },
  { name: 'uranus',  radius: 0.55, distance: 18.0, orbitSpeed: 0.0007, rotationSpeed: 0.050, texture: null,           color: 0x88ddcc },
  { name: 'neptune', radius: 0.50, distance: 22.0, orbitSpeed: 0.0005, rotationSpeed: 0.040, texture: null,           color: 0x3355ee }
];
// Only textured planets are navigation targets (fist gesture)
const CAMERA_TARGETS = ['sun', 'earth', 'mars', 'jupiter'];

class SolarSystem {
  constructor(scene, camera, colorSystem) {
    this.scene = scene;
    this.camera = camera;
    this.colorSystem = colorSystem;
    this.targetIndex = 0;

    // Texture loader
    const loader = new THREE.TextureLoader();

    // ── Sun ──
    const sunGeo = new THREE.SphereGeometry(1.5, 32, 32);
    const sunMat = new THREE.MeshBasicMaterial({ map: loader.load('assets/textures/sun.jpg') });
    this.sun = new THREE.Mesh(sunGeo, sunMat);
    scene.add(this.sun);

    // Sun glow — camera-facing sprite for realistic corona effect
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const gc = glowCanvas.getContext('2d');
    const gg = gc.createRadialGradient(128, 128, 0, 128, 128, 128);
    gg.addColorStop(0,    'rgba(255, 230, 130, 1.0)');
    gg.addColorStop(0.15, 'rgba(255, 150,  30, 0.8)');
    gg.addColorStop(0.4,  'rgba(255,  60,   0, 0.35)');
    gg.addColorStop(0.7,  'rgba(255,  20,   0, 0.10)');
    gg.addColorStop(1,    'rgba(0,     0,   0, 0)');
    gc.fillStyle = gg;
    gc.fillRect(0, 0, 256, 256);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(glowCanvas),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    }));
    this.sunGlow.scale.set(12, 12, 1);
    scene.add(this.sunGlow);

    // ── Planets ──
    this.planets = [];
    this.orbitAngles = [];
    for (const pd of PLANET_DATA) {
      const geo = new THREE.SphereGeometry(pd.radius, 24, 24);
      const mat = pd.texture
        ? new THREE.MeshStandardMaterial({
            map: loader.load('assets/textures/' + pd.texture),
            emissiveMap: loader.load('assets/textures/' + pd.texture),
            emissive: 0xffffff,
            emissiveIntensity: 0.3
          })
        : new THREE.MeshStandardMaterial({
            color: pd.color,
            emissive: pd.color,
            emissiveIntensity: 0.3
          });
      const mesh = new THREE.Mesh(geo, mat);
      const angle = Math.random() * Math.PI * 2;
      this.orbitAngles.push(angle);
      mesh.position.set(
        Math.cos(angle) * pd.distance,
        0,
        Math.sin(angle) * pd.distance
      );
      scene.add(mesh);
      this.planets.push(mesh);
    }

    // Earth atmosphere — soft blue glow shell
    const earthAtmIdx = PLANET_DATA.findIndex(p => p.name === 'earth');
    if (earthAtmIdx >= 0) {
      const atmGeo = new THREE.SphereGeometry(PLANET_DATA[earthAtmIdx].radius * 1.22, 32, 32);
      const atmMat = new THREE.MeshBasicMaterial({
        color: 0x4499ff,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide
      });
      this.earthAtmosphere = new THREE.Mesh(atmGeo, atmMat);
      this.planets[earthAtmIdx].add(this.earthAtmosphere);
    }

    // Saturn ring — wide, tilted, semi-transparent
    const saturnIdx = PLANET_DATA.findIndex(p => p.name === 'saturn');
    if (saturnIdx >= 0) {
      const ringGeo = new THREE.RingGeometry(1.05, 1.85, 64);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xddcc88, transparent: true, opacity: 0.45,
        side: THREE.DoubleSide, depthWrite: false
      });
      this.saturnRing = new THREE.Mesh(ringGeo, ringMat);
      this.saturnRing.rotation.x = Math.PI / 2.5;
      this.planets[saturnIdx].add(this.saturnRing);
    }

    // Uranus ring — thin, nearly edge-on
    const uranusIdx = PLANET_DATA.findIndex(p => p.name === 'uranus');
    if (uranusIdx >= 0) {
      const uRingGeo = new THREE.RingGeometry(0.78, 0.94, 48);
      const uRingMat = new THREE.MeshBasicMaterial({
        color: 0x88ddcc, transparent: true, opacity: 0.30,
        side: THREE.DoubleSide, depthWrite: false
      });
      this.uranusRing = new THREE.Mesh(uRingGeo, uRingMat);
      this.uranusRing.rotation.x = Math.PI / 2.05; // nearly vertical (97° axial tilt)
      this.uranusRing.rotation.z = Math.PI / 8;
      this.planets[uranusIdx].add(this.uranusRing);
    }

    // Moon — orbits Earth
    const earthIdx = PLANET_DATA.findIndex(p => p.name === 'earth');
    const moonGeo = new THREE.SphereGeometry(0.1, 16, 16);
    const moonMat = new THREE.MeshStandardMaterial({
      color: 0xcccccc, emissive: 0xcccccc, emissiveIntensity: 0.2
    });
    this.moon = new THREE.Mesh(moonGeo, moonMat);
    this.moonOrbitAngle = 0;
    this.moonDistance = 0.8;
    this.moonSpeed = 0.02;
    this.earthIdx = earthIdx;
    scene.add(this.moon);

    // ── Camera lerp state ──
    this.cameraLerpT = 1.0;
    this.cameraFrom = new THREE.Vector3();
    this.cameraTo = new THREE.Vector3();
    this.lookAtTarget = new THREE.Vector3();
    // Initial camera look-at for when not animating
    this.currentLookAt = new THREE.Vector3(0, 0, 0);
    this.prevLookAtTarget = new THREE.Vector3(0, 0, 0);
    this.nextLookAtTarget = new THREE.Vector3(0, 0, 0);
    this.targetOrbitAngleH = 0;
    this.targetOrbitAngleV = 0.3;
    this.targetOrbitRadiusForTravel = 4;

    // ── Hand-driven orbit, zoom & roll (with momentum) ──
    this.orbitAngleH = 0;
    this.orbitAngleV = 0.5;     // slight top-down to see all planets on start
    this.orbitVelH = 0;
    this.orbitVelV = 0;
    this.orbitRadius = 38;      // start far enough to see all 8 planets
    this.zoomVel     = 0;       // zoom velocity (delta-based)
    this.zoomActive  = false;
    this.prevZoomDist = 0;
    this.frameActive = false;
    this.cameraRoll    = 0;     // camera roll angle (radians)
    this.cameraRollVel = 0;     // roll angular velocity
    // Per-hand pinch tracking
    this.leftPinch  = { active: false, prevX: 0, prevY: 0, deltaX: 0, deltaY: 0 };
    this.rightPinch = { active: false, prevX: 0, prevY: 0, deltaX: 0, deltaY: 0 };

    // ── Orbit path lines ──
    this.orbitPaths = [];
    for (const pd of PLANET_DATA) {
      const segments = 128;
      const pts = [];
      for (let j = 0; j <= segments; j++) {
        const a = (j / segments) * Math.PI * 2;
        pts.push(new THREE.Vector3(
          Math.cos(a) * pd.distance, 0, Math.sin(a) * pd.distance
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: 0x224466, transparent: true, opacity: 0.25,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      this.orbitPaths.push(line);
    }
  }

  prevTarget() {
    this.targetIndex = (this.targetIndex - 1 + CAMERA_TARGETS.length) % CAMERA_TARGETS.length;
    this._flyToTarget();
  }

  advanceTarget() {
    this.targetIndex = (this.targetIndex + 1) % CAMERA_TARGETS.length;
    this._flyToTarget();
  }

  _flyToTarget() {
    const name = CAMERA_TARGETS[this.targetIndex];
    updateState('camera.currentTarget', name);
    updateState('camera.isAnimating', true);

    this.targetOrbitAngleH = 0;
    this.targetOrbitAngleV = 0.3;
    this.orbitVelH = 0;
    this.orbitVelV = 0;
    this.cameraRoll    = 0;
    this.cameraRollVel = 0;
    this.targetOrbitRadiusForTravel = ({ sun: 5, earth: 2, mars: 1.8, jupiter: 4 })[name] ?? 3;

    this.prevLookAtTarget = this.lookAtTarget.clone();
    if (name === 'sun') {
      this.nextLookAtTarget = new THREE.Vector3(0, 0, 0);
    } else {
      const idx = PLANET_DATA.findIndex(p => p.name === name);
      this.nextLookAtTarget = this.planets[idx].position.clone();
    }

    this.cameraFrom.copy(this.camera.position);
    this.cameraLerpT = 0.0;

    this.colorSystem.transitionTo(name);
    console.log('[SolarSystem] → ' + name);
  }

  // ── Per-hand pinch: L/R Y → tilt+roll, X → horizontal orbit ──
  startPinch(side, x, y) {
    const p = side === 'left' ? this.leftPinch : this.rightPinch;
    p.active = true; p.prevX = x; p.prevY = y; p.deltaX = 0; p.deltaY = 0;
  }

  updatePinch(side, x, y) {
    const p = side === 'left' ? this.leftPinch : this.rightPinch;
    if (!p.active) return;
    p.deltaX = x - p.prevX;
    p.deltaY = y - p.prevY;
    p.prevX = x; p.prevY = y;
  }

  stopPinch(side) {
    const p = side === 'left' ? this.leftPinch : this.rightPinch;
    p.active = false; p.deltaX = 0; p.deltaY = 0;
  }

  // ── Hand interaction: palm distance delta → zoom velocity ──
  setZoom(palmDist) {
    if (!this.zoomActive) {
      // First frame — just store baseline, don't zoom yet
      this.zoomActive = true;
      this.prevZoomDist = palmDist;
      return;
    }
    const delta = palmDist - this.prevZoomDist;
    // Closer (delta < 0) → zoom in (smaller radius), apart (delta > 0) → zoom out
    this.zoomVel += delta * 3;
    this.prevZoomDist = palmDist;
  }

  stopZoom() {
    this.zoomActive = false;
  }

  _getPlanetPos(name) {
    const idx = PLANET_DATA.findIndex(p => p.name === name);
    return idx >= 0 ? this.planets[idx].position : new THREE.Vector3();
  }

  update(deltaTime) {
    // Rotate sun
    this.sun.rotation.y += 0.001;

    // Orbit planets
    for (let i = 0; i < PLANET_DATA.length; i++) {
      this.orbitAngles[i] += PLANET_DATA[i].orbitSpeed;
      const d = PLANET_DATA[i].distance;
      this.planets[i].position.set(
        Math.cos(this.orbitAngles[i]) * d,
        0,
        Math.sin(this.orbitAngles[i]) * d
      );
      this.planets[i].rotation.y += PLANET_DATA[i].rotationSpeed;
    }

    // Moon orbits Earth
    this.moonOrbitAngle += this.moonSpeed;
    const earthPos = this.planets[this.earthIdx].position;
    this.moon.position.set(
      earthPos.x + Math.cos(this.moonOrbitAngle) * this.moonDistance,
      0.05,
      earthPos.z + Math.sin(this.moonOrbitAngle) * this.moonDistance
    );

    // ── Per-hand pinch → orbit + roll ──
    const lDX = this.leftPinch.deltaX,  lDY = this.leftPinch.deltaY;
    const rDX = this.rightPinch.deltaX, rDY = this.rightPinch.deltaY;
    this.leftPinch.deltaX  = 0; this.leftPinch.deltaY  = 0;
    this.rightPinch.deltaX = 0; this.rightPinch.deltaY = 0;
    const lA = this.leftPinch.active, rA = this.rightPinch.active;
    if (lA || rA) {
      // X (average) → horizontal orbit
      this.orbitVelH += ((lA && rA) ? (lDX + rDX) * 0.5 : lA ? lDX : rDX) * 0.12;
      if (lA && rA) {
        // Both pinching: average Y → tilt, differential Y → roll
        this.orbitVelV  -= (lDY + rDY) * 0.5 * 0.06;
        this.cameraRollVel += (lDY - rDY) * 0.06;
      } else {
        this.orbitVelV -= (lA ? lDY : rDY) * 0.08;
      }
    }
    // Apply orbit momentum (with damping)
    this.orbitAngleH += this.orbitVelH;
    this.orbitAngleV += this.orbitVelV;
    this.orbitAngleV = Math.max(-1.2, Math.min(1.2, this.orbitAngleV));
    const anyPinching = lA || rA;
    const dragDamp = anyPinching ? 0.85 : 0.96;
    this.orbitVelH *= dragDamp;
    this.orbitVelV *= dragDamp;
    // Camera roll momentum
    this.cameraRoll += this.cameraRollVel;
    this.cameraRollVel *= 0.94;

    // Apply zoom velocity (with damping + limits)
    this.orbitRadius += this.zoomVel;
    this.zoomVel *= 0.92;
    if (Math.abs(this.zoomVel) < 0.001) this.zoomVel = 0;
    this.orbitRadius = Math.max(4, Math.min(25, this.orbitRadius));

    // Update lookAt to track orbiting planet
    const name = CAMERA_TARGETS[this.targetIndex];
    if (name !== 'sun') {
      const pos = this._getPlanetPos(name);
      this.lookAtTarget.copy(pos);
    }

    // Compute orbit camera position around target
    const r = this.orbitRadius;
    const h = this.orbitAngleH;
    const v = this.orbitAngleV;
    const orbitPos = new THREE.Vector3(
      this.lookAtTarget.x + r * Math.cos(v) * Math.sin(h),
      this.lookAtTarget.y + r * Math.sin(v),
      this.lookAtTarget.z + r * Math.cos(v) * Math.cos(h)
    );

    // Fly-to animation on scene change (~1 second)
    if (this.cameraLerpT < 1.0) {
      this.cameraLerpT = Math.min(1.0, this.cameraLerpT + deltaTime * 1.5);
      const t = this._easeInOut(this.cameraLerpT);

      // Gradually blend orbit angles + radius toward new defaults
      this.orbitAngleH += (this.targetOrbitAngleH - this.orbitAngleH) * 0.02;
      this.orbitAngleV += (this.targetOrbitAngleV - this.orbitAngleV) * 0.02;
      this.orbitRadius += (this.targetOrbitRadiusForTravel - this.orbitRadius) * 0.02;

      // Smoothly update lookAt — track moving planet during travel
      const name = CAMERA_TARGETS[this.targetIndex];
      if (name !== 'sun') {
        this.nextLookAtTarget.copy(this._getPlanetPos(name));
      }
      this.lookAtTarget.lerpVectors(this.prevLookAtTarget, this.nextLookAtTarget, t);

      // Recompute orbit position using blended lookAt
      const orbitPos2 = new THREE.Vector3(
        this.lookAtTarget.x + this.orbitRadius * Math.cos(this.orbitAngleV) * Math.sin(this.orbitAngleH),
        this.lookAtTarget.y + this.orbitRadius * Math.sin(this.orbitAngleV),
        this.lookAtTarget.z + this.orbitRadius * Math.cos(this.orbitAngleV) * Math.cos(this.orbitAngleH)
      );

      this.camera.position.lerpVectors(this.cameraFrom, orbitPos2, t);
      this.currentLookAt.lerp(this.lookAtTarget, 0.03);

      if (this.cameraLerpT >= 1.0) {
        updateState('camera.isAnimating', false);
        this.currentLookAt.copy(this.lookAtTarget);
      }
    } else {
      // Normal orbit — smoothly follow orbit position
      this.camera.position.lerp(orbitPos, 0.08);
      this.currentLookAt.lerp(this.lookAtTarget, 0.05);
    }

    // Apply camera roll via camera.up before lookAt
    const fwd = new THREE.Vector3()
      .subVectors(this.currentLookAt, this.camera.position).normalize();
    const rollQ = new THREE.Quaternion().setFromAxisAngle(fwd, this.cameraRoll);
    this.camera.up.set(0, 1, 0).applyQuaternion(rollQ);
    this.camera.lookAt(this.currentLookAt);
  }

  _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  dispose() {
    this.scene.remove(this.sun);
    this.sun.geometry.dispose();
    this.sun.material.dispose();
    this.scene.remove(this.sunGlow);
    this.sunGlow.material.map?.dispose();
    this.sunGlow.material.dispose();
    for (const p of this.planets) {
      this.scene.remove(p);
      p.geometry.dispose();
      p.material.dispose();
    }
    for (const line of this.orbitPaths) {
      this.scene.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.scene.remove(this.moon);
    this.moon.geometry.dispose();
    this.moon.material.dispose();
  }
}

// ════════════════════════════════════════════════════════════════
// GraphicsEngine
// ════════════════════════════════════════════════════════════════
const GraphicsEngine = {
  renderer: null,
  scene:    null,
  camera:   null,
  particleSystem: null,
  holoHands: null,
  crossQuads: null,   // 3 quads (4 edges each) connecting L↔R
  crossQuadGlow: null,

  async init(canvasElement) {
    // Renderer — always max quality
    this.renderer = new THREE.WebGLRenderer({ canvas: canvasElement, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000008);
    this.scene.fog = new THREE.FogExp2(0x000008, 0.008);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      75, window.innerWidth / window.innerHeight, 0.1, 1000
    );
    this.camera.position.set(0, 0, 5);

    // Lights
    this.ambientLight = new THREE.AmbientLight(0x334455, 2);
    this.scene.add(this.ambientLight);
    this.sunLight = new THREE.PointLight(0xffffff, 3, 200);
    this.sunLight.position.set(0, 0, 0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.setScalar(1024);
    this.scene.add(this.sunLight);

    // Sub-systems
    this.particleSystem = new StarField(this.scene);

    // Hand layer — fixed in front of camera so hands stay visible
    // during camera fly-to. Z=-5 matches original camera distance.
    this.handLayer = new THREE.Group();
    this.handLayer.position.set(0, 0, -5);
    this.camera.add(this.handLayer);
    this.scene.add(this.camera); // camera must be in scene for children to render

    this.holoHands = {
      left:  new HolographicHand(this.handLayer, 'left'),
      right: new HolographicHand(this.handLayer, 'right')
    };

    // Cross-hand quads: 4 points per stem → closed quadrilateral
    // Bass(orange):  L_thumb→L_index→R_index→R_thumb
    // Drums(red):    L_thumb→L_middle→R_middle→R_thumb
    // Melody(yellow): L_thumb→L_ring→R_ring→R_thumb
    const CROSS_COLORS = [0xff8800, 0xff4444, 0xffff00];
    // 4 lines per quad × 3 stems = 12 lines
    this.crossQuads = CROSS_COLORS.map(color => {
      const edges = [];
      for (let e = 0; e < 4; e++) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(), new THREE.Vector3()
        ]);
        const mat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        line.renderOrder = 1000;
        this.handLayer.add(line);
        edges.push(line);
      }
      return edges;
    });
    // Glow duplicates per quad
    this.crossQuadGlow = CROSS_COLORS.map(color => {
      const edges = [];
      for (let e = 0; e < 4; e++) {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(), new THREE.Vector3()
        ]);
        const mat = new THREE.LineBasicMaterial({
          color, transparent: true, opacity: 0.25,
          blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        line.renderOrder = 999;
        this.handLayer.add(line);
        edges.push(line);
      }
      return edges;
    });
    // 4 corner dots per quad × 3 stems = 12 dots
    const dotGeo = new THREE.SphereGeometry(0.025, 6, 6);
    this.crossDots = CROSS_COLORS.flatMap(color => {
      return [0, 1, 2, 3].map(() => {
        const mat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthTest: false
        });
        const mesh = new THREE.Mesh(dotGeo, mat);
        mesh.visible = false;
        mesh.renderOrder = 1001;
        this.handLayer.add(mesh);
        return mesh;
      });
    });

    // ── Solar System + Color System ──
    this.colorSystem = new ColorSystem(this.ambientLight, this.sunLight, this.particleSystem, this.scene);
    this.solarSystem = new SolarSystem(this.scene, this.camera, this.colorSystem);

    // EffectComposer + Bloom post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.6,   // strength
      0.4,   // radius
      0.78   // threshold — only bright objects (sun, glows) bloom
    );
    this.composer.addPass(this.bloomPass);

    // Resize + EventBus
    this._boundResize = () => this._onResize();
    window.addEventListener('resize', this._boundResize);

    console.log('[GraphicsEngine] initialized');
  },

  update(deltaTime) {
    if (!this.renderer) return;

    const { hands } = state;

    this.particleSystem.update(deltaTime);
    this.holoHands.left.update(hands.left);
    this.holoHands.right.update(hands.right);

    // Cross-hand quads: L_thumb→L_finger→R_finger→R_thumb (closed)
    const CROSS_TIPS = [8, 12, 16]; // index, middle, ring
    const THUMB = 4;
    const bothVisible = hands.left.detected && hands.left.landmarks &&
                        hands.right.detected && hands.right.landmarks;

    for (let i = 0; i < 3; i++) {
      const edges = this.crossQuads[i];
      const glow = this.crossQuadGlow[i];
      const dots = this.crossDots.slice(i * 4, i * 4 + 4);

      // Cross-quad lines hidden
      edges.forEach(e => e.visible = false);
      glow.forEach(e => e.visible = false);
      dots.forEach(d => d.visible = false);
      continue;

      const tipIdx = CROSS_TIPS[i];
      const lThumb = hands.left.landmarks[THUMB];
      const lFinger = hands.left.landmarks[tipIdx];
      const rFinger = hands.right.landmarks[tipIdx];
      const rThumb = hands.right.landmarks[THUMB];

      const pts = [
        mediapipeToThreeJS(lThumb.x, lThumb.y, lThumb.z),
        mediapipeToThreeJS(lFinger.x, lFinger.y, lFinger.z),
        mediapipeToThreeJS(rFinger.x, rFinger.y, rFinger.z),
        mediapipeToThreeJS(rThumb.x, rThumb.y, rThumb.z)
      ];

      // 4 edges: 0→1, 1→2, 2→3, 3→0
      for (let e = 0; e < 4; e++) {
        const a = pts[e], b = pts[(e + 1) % 4];
        for (const line of [edges[e], glow[e]]) {
          const pos = line.geometry.attributes.position;
          pos.setXYZ(0, a.x, a.y, a.z);
          pos.setXYZ(1, b.x, b.y, b.z);
          pos.needsUpdate = true;
          line.visible = true;
        }
      }

      // 4 corner dots
      pts.forEach((p, j) => {
        dots[j].position.set(p.x, p.y, p.z);
        dots[j].visible = true;
      });
    }

    // Solar system + color palette
    this.solarSystem?.update(deltaTime);
    this.colorSystem?.update(deltaTime);

    this.composer.render();
  },

  advanceScene() {
    this.solarSystem?.advanceTarget();
  },

  prevScene() {
    this.solarSystem?.prevTarget();
  },

  startPinch(side, x, y) {
    this.solarSystem?.startPinch(side, x, y);
  },

  updatePinch(side, x, y) {
    this.solarSystem?.updatePinch(side, x, y);
  },

  stopPinch(side) {
    this.solarSystem?.stopPinch(side);
  },

  setZoom(frameHeight) {
    this.solarSystem?.setZoom(frameHeight);
  },

  stopZoom() {
    this.solarSystem?.stopZoom();
  },

  _onResize() {
    if (!this.camera || !this.renderer) return;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer?.setSize(innerWidth, innerHeight);
  },

  destroy() {
    this.solarSystem?.dispose();
    this.particleSystem?.dispose();
    this.holoHands?.left.dispose();
    this.holoHands?.right.dispose();
    this.crossQuads?.flat().forEach(l => { l.geometry.dispose(); l.material.dispose(); this.handLayer?.remove(l); });
    this.crossQuadGlow?.flat().forEach(l => { l.geometry.dispose(); l.material.dispose(); this.handLayer?.remove(l); });
    this.crossDots?.forEach(d => { d.geometry.dispose(); d.material.dispose(); this.handLayer?.remove(d); });
    if (this.handLayer) { this.camera?.remove(this.handLayer); }
    this.renderer?.dispose();
    window.removeEventListener('resize', this._boundResize);
  }
};

export default GraphicsEngine;
