"use client";

// Hero scene: a field of idle GPU nodes. A job drops onto two nodes at once; when their results
// agree the pair lights up and an arc joins them (the two-node check). Now and then a pair
// disagrees: grey arc, no light, unpaid. Purely illustrative: no numbers, no node count.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { P } from "./palette";

type Props = { animate: boolean; dense: boolean };

const SPACING = 1;
const TILE = 0.72;
const SLOTS = 7;
const DROP = 0.5; // s: job falls onto both nodes
const CHECK = 0.55; // s: arc draws
const HOLD = 1.6; // s: lit
const FADE = 1.1; // s
const LIFE = DROP + CHECK + HOLD + FADE;
const ARC_SEGMENTS = 40;

/** Deterministic pseudo-random so SSR/CSR and reloads look the same. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Slot = {
  a: number;
  b: number;
  t0: number;
  agree: boolean;
  line: THREE.Line;
  dropA: THREE.Mesh;
  dropB: THREE.Mesh;
  active: boolean;
};

function Field({ animate, dense }: Props) {
  const cols = dense ? 40 : 20;
  const rows = dense ? 22 : 14;
  const count = cols * rows;
  const mesh = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const linesGroup = useRef<THREE.Group>(null);
  const { pointer, invalidate } = useThree();

  const tiles = useMemo(() => {
    const rnd = mulberry32(4663);
    return Array.from({ length: count }, (_, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x = (c - (cols - 1) / 2) * SPACING;
      const z = (r - (rows - 1) / 2) * SPACING - 3;
      // low, slightly uneven blocks: a city of machines seen from above
      const h = 0.1 + Math.pow(rnd(), 2.4) * 0.45;
      return { x, z, h };
    });
  }, [count, cols, rows]);

  const geometry = useMemo(() => new RoundedBoxGeometry(TILE, 1, TILE, 2, 0.06), []);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.92, metalness: 0.02 }),
    [],
  );
  const base = useMemo(() => new THREE.Color(P.solid), []);
  const lift = useMemo(() => new THREE.Color(P.solidLift), []);
  const signal = useMemo(() => new THREE.Color(P.signal), []);
  const glow = useRef(new Float32Array(count)); // 0..1 light per tile
  const targetBuf = useMemo(() => new Float32Array(count), [count]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);

  // static layout + colours
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    tiles.forEach((t, i) => {
      tmp.position.set(t.x, t.h / 2, t.z);
      tmp.scale.set(1, t.h, 1);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      m.setColorAt(i, (i * 7) % 11 === 0 ? lift : base);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [tiles, tmp, base, lift]);

  // pair slots: arc line + two job drops each
  const slots = useMemo<Slot[]>(() => {
    const dropGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    return Array.from({ length: SLOTS }, () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((ARC_SEGMENTS + 1) * 3), 3));
      g.setDrawRange(0, 0);
      const line = new THREE.Line(
        g,
        new THREE.LineBasicMaterial({ color: P.signal, transparent: true, opacity: 0, depthWrite: false }),
      );
      const mk = () =>
        new THREE.Mesh(dropGeo, new THREE.MeshBasicMaterial({ color: P.paper, transparent: true, opacity: 0 }));
      return { a: 0, b: 0, t0: -99, agree: true, line, dropA: mk(), dropB: mk(), active: false };
    });
  }, []);

  useEffect(() => {
    const g = linesGroup.current;
    if (!g) return;
    slots.forEach((s) => g.add(s.line, s.dropA, s.dropB));
    return () => {
      slots.forEach((s) => {
        g.remove(s.line, s.dropA, s.dropB);
        s.line.geometry.dispose();
        (s.line.material as THREE.Material).dispose();
        (s.dropA.material as THREE.Material).dispose();
        (s.dropB.material as THREE.Material).dispose();
      });
      slots[0]?.dropA.geometry.dispose();
    };
  }, [slots]);

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  const rnd = useMemo(() => mulberry32(46630), []);
  const nextSpawn = useRef(0.3);
  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(), []);

  function spawn(s: Slot, now: number) {
    // pick two nodes where the eye rests (right of the copy on wide screens), 2..6 cells apart
    for (let tries = 0; tries < 20; tries++) {
      const c = Math.floor(dense ? cols * 0.6 + rnd() * cols * 0.32 : cols * 0.15 + rnd() * cols * 0.7);
      const r = Math.floor(dense ? rows * 0.38 + rnd() * rows * 0.5 : rows * 0.45 + rnd() * rows * 0.4);
      const dc = Math.round((rnd() - 0.5) * 10);
      const dr = Math.round((rnd() - 0.5) * 6);
      const c2 = c + dc;
      const r2 = r + dr;
      const dist = Math.hypot(dc, dr);
      if (c2 < 0 || c2 >= cols || r2 < 0 || r2 >= rows || dist < 2 || dist > 6.5) continue;
      const a = r * cols + c;
      const b = r2 * cols + c2;
      if (slots.some((o) => o.active && (o.a === a || o.b === a || o.a === b || o.b === b))) continue;
      s.a = a;
      s.b = b;
      s.t0 = now;
      s.agree = rnd() > 0.16;
      s.active = true;
      const A = tiles[a];
      const B = tiles[b];
      const start = new THREE.Vector3(A.x, A.h + 0.02, A.z);
      const end = new THREE.Vector3(B.x, B.h + 0.02, B.z);
      const mid = start.clone().lerp(end, 0.5);
      mid.y += 0.5 + start.distanceTo(end) * 0.28;
      curve.v0.copy(start);
      curve.v1.copy(mid);
      curve.v2.copy(end);
      const pos = s.line.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i <= ARC_SEGMENTS; i++) {
        const p = curve.getPoint(i / ARC_SEGMENTS);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      (s.line.material as THREE.LineBasicMaterial).color.set(s.agree ? P.signal : P.disagree);
      return;
    }
  }

  // Reduced motion: a still frame with a few agreed pairs.
  useEffect(() => {
    if (animate) return;
    slots.slice(0, 4).forEach((s, i) => {
      spawn(s, 0);
      s.agree = true;
      (s.line.material as THREE.LineBasicMaterial).color.set(P.signal);
      s.t0 = -(DROP + CHECK + 0.2 + i * 0.01);
    });
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animate]);

  useFrame((state, delta) => {
    const now = animate ? state.clock.elapsedTime : 0;
    const m = mesh.current;
    if (!m) return;

    if (animate && now > nextSpawn.current) {
      const free = slots.find((s) => !s.active);
      if (free) spawn(free, now);
      nextSpawn.current = now + 0.55 + rnd() * 0.65;
    }

    const target = targetBuf;
    target.fill(0);
    for (const s of slots) {
      if (!s.active) continue;
      const t = now - s.t0;
      if (animate && t > LIFE) {
        s.active = false;
        s.line.geometry.setDrawRange(0, 0);
        (s.dropA.material as THREE.MeshBasicMaterial).opacity = 0;
        (s.dropB.material as THREE.MeshBasicMaterial).opacity = 0;
        continue;
      }
      const A = tiles[s.a];
      const B = tiles[s.b];
      // 1. job drops onto both nodes
      const dropT = Math.min(1, Math.max(0, t / DROP));
      const ease = 1 - Math.pow(1 - dropT, 3);
      const dropVisible = t < DROP + 0.12 ? 1 : 0;
      s.dropA.position.set(A.x, THREE.MathUtils.lerp(A.h + 2.2, A.h + 0.08, ease), A.z);
      s.dropB.position.set(B.x, THREE.MathUtils.lerp(B.h + 2.2, B.h + 0.08, ease), B.z);
      (s.dropA.material as THREE.MeshBasicMaterial).opacity = dropVisible * 0.95;
      (s.dropB.material as THREE.MeshBasicMaterial).opacity = dropVisible * 0.95;
      // 2. results compared: arc draws between the pair
      const arcT = Math.min(1, Math.max(0, (t - DROP) / CHECK));
      s.line.geometry.setDrawRange(0, Math.floor(arcT * ARC_SEGMENTS) + 1);
      const fadeT = Math.min(1, Math.max(0, (t - DROP - CHECK - HOLD) / FADE));
      (s.line.material as THREE.LineBasicMaterial).opacity = (arcT > 0 ? 0.9 : 0) * (1 - fadeT);
      // 3. agreed pairs light up
      if (s.agree && t > DROP + CHECK * 0.9) {
        const l = 1 - fadeT;
        target[s.a] = Math.max(target[s.a], l);
        target[s.b] = Math.max(target[s.b], l);
      }
    }

    let dirty = false;
    for (let i = 0; i < count; i++) {
      const g = glow.current[i];
      const next = animate ? THREE.MathUtils.damp(g, target[i], 9, delta) : target[i];
      if (Math.abs(next - g) > 0.002 || (!animate && next !== g)) {
        glow.current[i] = next;
        col.copy((i * 7) % 11 === 0 ? lift : base).lerp(signal, next * 0.92);
        m.setColorAt(i, col);
        const t = tiles[i];
        tmp.position.set(t.x, (t.h + next * 0.12) / 2, t.z);
        tmp.scale.set(1, t.h + next * 0.12, 1);
        tmp.updateMatrix();
        m.setMatrixAt(i, tmp.matrix);
        dirty = true;
      }
    }
    if (dirty) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }

    // gentle pointer parallax
    if (group.current && animate) {
      group.current.rotation.y = THREE.MathUtils.damp(group.current.rotation.y, pointer.x * 0.06, 2.5, delta);
      group.current.rotation.x = THREE.MathUtils.damp(group.current.rotation.x, -pointer.y * 0.025, 2.5, delta);
    }
  });

  return (
    <group ref={group}>
      <instancedMesh ref={mesh} args={[geometry, material, count]} frustumCulled={false} />
      <group ref={linesGroup} />
    </group>
  );
}

export default function NodeFieldCanvas({
  animate,
  dense,
  frameloop,
}: Props & { frameloop: "always" | "demand" | "never" }) {
  return (
    <Canvas
      frameloop={frameloop}
      dpr={dense ? [1, 1.75] : [1, 1.25]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: dense ? [3, 12.5, 12.5] : [0, 12, 11], fov: dense ? 30 : 36, near: 0.1, far: 80 }}
      onCreated={({ camera, scene, gl }) => {
        if (dense) camera.lookAt(4.2, 0, -1.2);
        else camera.lookAt(0, 0, -0.5);
        scene.fog = new THREE.Fog(P.bg, 13, 30);
        gl.setClearColor(P.bg);
      }}
      aria-hidden
    >
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#ffffff", "#0c0c0c", 0.55]} />
      <directionalLight position={[-6, 12, 5]} intensity={2.4} />
      <directionalLight position={[8, 4, -6]} intensity={0.35} />
      <Field animate={animate} dense={dense} />
    </Canvas>
  );
}
