"use client";

// Claim page scene: the epoch's payout Merkle tree as a maquette. Leaves are small graphite blocks on a
// baseboard, inner nodes float above, the root sits on top. When a proof is loaded, the path from the
// wallet's leaf to the root lights green one level at a time (leaf, then each computed parent) and the
// sibling hashes the proof supplies get white hairline edges. Green appears only when the path verifies.
import { Edges, Line } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { SceneModel } from "@/lib/dapp/merkle-model";
import { P } from "./palette";

const BODY = "#333333";
const SIBLING_EDGE = "#e8e8e8";
const MISMATCH_EDGE = "#d0675e";
/** Seconds per level of the leaf-to-root walk. */
const STEP = 0.32;

type Props = { model: SceneModel; animate: boolean };
type LineRef = { material: { opacity: number } } | null;

function Tree({ model, animate }: Props) {
  const { invalidate, pointer } = useThree();
  const unit = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const board = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(
    () => () => {
      unit.dispose();
      board.dispose();
    },
    [unit, board],
  );

  // All connectors that are not on the lit path: one LineSegments.
  const connectors = useMemo(() => {
    const pts: number[] = [];
    for (const e of model.edges) {
      if (e.path && model.verified) continue;
      pts.push(e.a[0], e.a[1], 0, e.b[0], e.b[1], 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [model]);
  useEffect(() => () => connectors.dispose(), [connectors]);

  const lit = model.verified === true;
  const pathEdges = useMemo(() => (lit ? model.edges.filter((e) => e.path) : []), [model, lit]);

  const mats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const segs = useRef<LineRef[]>([]);
  const glow = useRef<Float32Array>(new Float32Array(0));
  const walk = useRef({ key: "", t: 0 });
  const group = useRef<THREE.Group>(null);
  const base = useMemo(() => new THREE.Color(BODY), []);
  const green = useMemo(() => new THREE.Color(P.signal), []);

  useEffect(() => {
    glow.current = new Float32Array(model.nodes.length);
    invalidate();
  }, [model, invalidate]);

  useFrame((_, delta) => {
    if (walk.current.key !== model.pathKey) walk.current = { key: model.pathKey, t: 0 };
    walk.current.t = animate ? walk.current.t + delta : Infinity;
    const reached = walk.current.t / STEP; // levels reached so far

    model.nodes.forEach((n, i) => {
      const m = mats.current[i];
      if (!m) return;
      const target = lit && n.state === "path" && reached >= n.order ? 1 : 0;
      const g = animate ? THREE.MathUtils.damp(glow.current[i] ?? 0, target, 9, delta) : target;
      glow.current[i] = g;
      m.color.copy(base).lerp(green, g * 0.92);
      m.emissive.copy(green).multiplyScalar(g * 0.18);
    });
    pathEdges.forEach((e, i) => {
      const l = segs.current[i];
      if (!l) return;
      const target = reached >= e.order + 1 ? 1 : 0;
      l.material.opacity = animate ? THREE.MathUtils.damp(l.material.opacity, target, 9, delta) : target;
    });

    // Gentle pointer parallax (only while animating; reduced motion keeps a still frame).
    const g = group.current;
    if (g) {
      const ty = animate ? pointer.x * 0.16 - 0.1 : -0.1;
      const tx = animate ? -pointer.y * 0.05 : 0;
      g.rotation.y = animate ? THREE.MathUtils.damp(g.rotation.y, ty, 3, delta) : ty;
      g.rotation.x = animate ? THREE.MathUtils.damp(g.rotation.x, tx, 3, delta) : tx;
    }
  });

  const cx = (model.bounds.minX + model.bounds.maxX) / 2;
  const boardW = model.base.x1 - model.base.x0;
  const boardX = (model.base.x0 + model.base.x1) / 2;

  return (
    <group ref={group}>
      <group position={[-cx, 0, 0]}>
        {/* baseboard under the bottom row */}
        <mesh geometry={board} position={[boardX, model.base.y - 0.02, 0]} scale={[boardW, 0.04, 1.3]}>
          <meshStandardMaterial color={P.solid} roughness={0.95} />
          <Edges color={P.edge} />
        </mesh>

        <lineSegments geometry={connectors}>
          <lineBasicMaterial color={lit ? P.edge : "#4a4a4a"} />
        </lineSegments>

        {pathEdges.map((e, i) => (
          <Line
            key={`${model.pathKey}-${i}`}
            ref={(l) => {
              segs.current[i] = l as unknown as LineRef;
            }}
            points={[
              [e.a[0], e.a[1], 0],
              [e.b[0], e.b[1], 0],
            ]}
            color={P.signal}
            lineWidth={1.6}
            transparent
            opacity={animate ? 0 : 1}
          />
        ))}

        {model.nodes.map((n, i) => {
          const edge =
            n.state === "sibling"
              ? SIBLING_EDGE
              : n.isRoot && model.verified === false
                ? MISMATCH_EDGE
                : n.state === "path"
                  ? P.edgeActive
                  : n.state === "collapsed"
                    ? "#5a5a5a"
                    : P.edge;
          const h = n.state === "collapsed" ? n.size * 0.45 : n.size;
          const w = n.state === "collapsed" ? n.size * 1.25 : n.size;
          return (
            <mesh key={n.id} geometry={unit} position={[n.x, n.y, 0]} scale={[w, h, n.size]}>
              <meshStandardMaterial
                ref={(m) => {
                  mats.current[i] = m;
                }}
                color={BODY}
                roughness={0.9}
                metalness={0.02}
              />
              <Edges color={edge} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

/** Frames the whole tree for the canvas aspect, camera slightly above, looking down at the maquette. */
const FOV = 28;

function Fit({ model }: { model: SceneModel }) {
  const { camera, size, invalidate } = useThree();
  const fit = useMemo(() => {
    const aspect = size.width / Math.max(1, size.height);
    const { minX, maxX, minY, maxY } = model.bounds;
    const bottom = Math.min(minY, model.base.y);
    const halfW = Math.max(2, (maxX - minX) / 2 + 0.75);
    const halfH = Math.max(1.3, (maxY - bottom) / 2 + 0.3);
    const t = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    return { d: Math.max(halfH / t, halfW / (t * aspect)) * 1.02, cy: (maxY + bottom) / 2 - 0.12 };
  }, [size.width, size.height, model]);

  useEffect(() => {
    camera.position.set(0, fit.cy + fit.d * 0.2, fit.d);
    camera.lookAt(0, fit.cy, 0);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, fit, invalidate]);

  return <fog attach="fog" args={[P.bg, fit.d * 0.9, fit.d * 2.6]} />;
}

export default function MerkleTreeCanvas({
  model,
  animate,
  frameloop,
}: Props & { frameloop: "always" | "demand" }) {
  return (
    <Canvas
      frameloop={frameloop}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false }}
      camera={{ fov: FOV, near: 0.1, far: 200, position: [0, 2, 12] }}
      onCreated={({ gl }) => gl.setClearColor(P.bg)}
      aria-hidden
    >
      <Fit model={model} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#ffffff", "#0c0c0c", 0.6]} />
      <directionalLight position={[-4, 8, 7]} intensity={1.8} />
      <directionalLight position={[3, 2.5, 9]} intensity={0.7} />
      <Tree model={model} animate={animate} />
    </Canvas>
  );
}
