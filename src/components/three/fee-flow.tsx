"use client";

// "How it works" scene: five stations on a baseboard, one per step.
// Fees (green packets) leave the bonding curve, pass the Pons fee escrow and fall into the epoch pot.
// Payouts leave the pot only through a pair of nodes that agreed, then a Merkle root, then one leaf.
// Illustrative motion only; it carries no amounts.
import { Edges, Line } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { P } from "./palette";

export const STATION_X = [-5.2, -2.6, 0, 2.6, 5.2];
const LEAVES = [-0.66, -0.22, 0.22, 0.66];
/** Station bodies sit a step lighter than the hero field so their faces read at this distance. */
const BODY = "#363636";

type SceneProps = { active: number | null; animate: boolean };

function Station({ x, active, children, width = 1.9 }: { x: number; active: boolean; children: ReactNode; width?: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, d) => {
    if (g.current) g.current.position.y = THREE.MathUtils.damp(g.current.position.y, active ? 0.08 : 0, 8, d);
  });
  return (
    <group position={[x, 0, 0]}>
      {/* baseboard */}
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[width, 0.04, 1.5]} />
        <meshStandardMaterial color={P.solid} roughness={0.95} />
        <Edges color={active ? P.edgeActive : P.edge} />
      </mesh>
      <group ref={g}>{children}</group>
    </group>
  );
}

function Solid({ geometry, position, active, color = BODY }: {
  geometry: THREE.BufferGeometry;
  position?: [number, number, number];
  active: boolean;
  color?: string;
}) {
  return (
    <mesh geometry={geometry} position={position}>
      <meshStandardMaterial color={color} roughness={0.9} metalness={0.02} />
      <Edges color={active ? P.edgeActive : P.edge} threshold={20} />
    </mesh>
  );
}

function curveWall() {
  // a bonding curve, extruded: price rises as supply sells
  const s = new THREE.Shape();
  s.moveTo(-0.7, 0);
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    s.lineTo(-0.7 + u * 1.4, 0.12 + Math.pow(u, 2.1) * 1.05);
  }
  s.lineTo(0.7, 0);
  s.lineTo(-0.7, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: false });
  g.translate(0, 0.04, -0.25);
  return g;
}

type Packet = { mesh: THREE.Mesh; curve: THREE.CatmullRomCurve3 | null; t0: number; dur: number; kind: "fee" | "pay"; leaf: number };

function Scene({ active, animate }: SceneProps) {
  const [x0, x1, x2, x3, x4] = STATION_X;
  const { invalidate } = useThree();
  const geo = useMemo(
    () => ({
      wall: curveWall(),
      escrow: new THREE.BoxGeometry(0.95, 0.95, 0.95),
      slot: new THREE.BoxGeometry(0.5, 0.02, 0.1),
      pot: new THREE.CylinderGeometry(0.62, 0.58, 0.55, 48, 1, true),
      potBase: new THREE.CylinderGeometry(0.58, 0.58, 0.04, 48),
      fill: new THREE.CylinderGeometry(0.6, 0.6, 1, 48),
      node: new THREE.BoxGeometry(0.5, 0.5, 0.5),
      tree: new THREE.BoxGeometry(0.2, 0.2, 0.2),
      packet: new THREE.BoxGeometry(0.11, 0.11, 0.11),
    }),
    [],
  );
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo]);

  const feePath = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        [
          [x0 + 0.62, 1.25, 0],
          [x0 + 1.45, 1.75, 0],
          [x1, 1.3, 0],
          [x1, 1.0, 0],
          [x1 + 0.1, 1.25, 0.05],
          [x1 + 1.35, 1.6, 0],
          [x2, 0.95, 0],
          [x2, 0.3, 0],
        ].map((p) => new THREE.Vector3(...(p as [number, number, number]))),
        false,
        "centripetal",
      ),
    [x0, x1, x2],
  );
  const payPath = (leaf: number) =>
    new THREE.CatmullRomCurve3(
      [
        [x2, 0.55, 0],
        [x2 + 0.9, 1.45, 0],
        [x3, 0.95, 0],
        [x3 + 1.3, 1.75, 0],
        [x4, 1.36, 0],
        [x4 + LEAVES[leaf] * 0.6, 0.9, 0],
        [x4 + LEAVES[leaf], 0.43, 0],
      ].map((p) => new THREE.Vector3(...(p as [number, number, number]))),
      false,
      "centripetal",
    );

  const packets = useMemo<Packet[]>(
    () =>
      Array.from({ length: 12 }, () => ({
        mesh: new THREE.Mesh(geo.packet, new THREE.MeshBasicMaterial({ color: P.signal, transparent: true, opacity: 0 })),
        curve: null,
        t0: -99,
        dur: 2.4,
        kind: "fee" as const,
        leaf: 0,
      })),
    [geo.packet],
  );
  const packetGroup = useRef<THREE.Group>(null);
  useEffect(() => {
    const g = packetGroup.current;
    if (!g) return;
    packets.forEach((p) => g.add(p.mesh));
    return () => packets.forEach((p) => {
      g.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    });
  }, [packets]);

  const fill = useRef<THREE.Mesh>(null);
  const level = useRef(0.18);
  const pairA = useRef<THREE.MeshStandardMaterial>(null);
  const pairB = useRef<THREE.MeshStandardMaterial>(null);
  const leafMats = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const glowPair = useRef(0);
  const glowLeaf = useRef([0, 0, 0, 0]);
  const nextFee = useRef(0);
  const nextPay = useRef(1.2);
  const leafCursor = useRef(0);
  const dark = useMemo(() => new THREE.Color(BODY), []);
  const green = useMemo(() => new THREE.Color(P.signal), []);

  // still frame for reduced motion
  useEffect(() => {
    if (animate) return;
    level.current = 0.32;
    glowPair.current = 1;
    glowLeaf.current = [0, 1, 0, 0];
    packets[0].curve = feePath;
    packets[0].t0 = -1;
    packets[0].dur = 2;
    invalidate();
  }, [animate, feePath, packets, invalidate]);

  useFrame((state, delta) => {
    const now = animate ? state.clock.elapsedTime : 0;
    if (animate && now > nextFee.current) {
      const p = packets.find((k) => k.curve === null);
      if (p) Object.assign(p, { curve: feePath, t0: now, dur: 2.3, kind: "fee" });
      nextFee.current = now + 0.7;
    }
    if (animate && now > nextPay.current) {
      const p = packets.find((k) => k.curve === null);
      const leaf = leafCursor.current++ % 4;
      if (p) Object.assign(p, { curve: payPath(leaf), t0: now, dur: 2.8, kind: "pay", leaf });
      nextPay.current = now + 2.6;
    }

    for (const p of packets) {
      if (!p.curve) continue;
      const u = animate ? (now - p.t0) / p.dur : 0.62;
      const mat = p.mesh.material as THREE.MeshBasicMaterial;
      if (u >= 1) {
        if (p.kind === "fee") level.current = Math.min(0.46, level.current + 0.012);
        else glowLeaf.current[p.leaf] = 1;
        p.curve = null;
        mat.opacity = 0;
        continue;
      }
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      p.curve.getPointAt(Math.min(0.999, Math.max(0, e)), p.mesh.position);
      // hidden while inside the escrow vault, and fading at the ends
      const inVault = p.kind === "fee" && Math.abs(p.mesh.position.x - x1) < 0.42 && p.mesh.position.y < 1.12;
      mat.opacity = inVault ? 0 : Math.min(1, u * 8, (1 - u) * 10);
      if (p.kind === "pay" && Math.abs(p.mesh.position.x - x3) < 0.3) glowPair.current = 1;
      if (p.kind === "pay" && u < 0.08) level.current = Math.max(0.12, level.current - 0.004);
    }

    if (animate) {
      glowPair.current = Math.max(0, glowPair.current - delta * 0.55);
      glowLeaf.current = glowLeaf.current.map((g) => Math.max(0, g - delta * 0.45));
    }
    if (fill.current) {
      const h = level.current;
      fill.current.scale.y = h;
      fill.current.position.y = 0.06 + h / 2;
    }
    pairA.current?.color.copy(dark).lerp(green, glowPair.current * 0.9);
    pairB.current?.color.copy(dark).lerp(green, glowPair.current * 0.9);
    leafMats.current.forEach((m, i) => m?.color.copy(dark).lerp(green, glowLeaf.current[i] * 0.9));
  });

  const is = (i: number) => active === i;
  const treeNodes: [number, number][] = [[0, 1.36], [-0.44, 0.9], [0.44, 0.9]];

  return (
    <group>
      {/* guides: where money is allowed to move */}
      <Line points={feePath.getPoints(80)} color={P.guide} lineWidth={1} dashed dashSize={0.08} gapSize={0.07} />
      <Line points={payPath(1).getPoints(80)} color={P.guide} lineWidth={1} dashed dashSize={0.08} gapSize={0.07} />

      <Station x={x0} active={is(0)}>
        <Solid geometry={geo.wall} active={is(0)} />
      </Station>

      <Station x={x1} active={is(1)}>
        <Solid geometry={geo.escrow} position={[0, 0.52, 0]} active={is(1)} />
        <mesh geometry={geo.slot} position={[0, 1.0, 0]}>
          <meshBasicMaterial color="#050505" />
        </mesh>
      </Station>

      <Station x={x2} active={is(2)}>
        <mesh geometry={geo.potBase} position={[0, 0.06, 0]}>
          <meshStandardMaterial color={P.solidLift} roughness={0.9} />
        </mesh>
        <mesh geometry={geo.fill} ref={fill} position={[0, 0.15, 0]}>
          <meshStandardMaterial color={P.signalDim} roughness={0.85} emissive={P.signalDim} emissiveIntensity={0.25} />
        </mesh>
        <mesh geometry={geo.pot} position={[0, 0.33, 0]}>
          <meshStandardMaterial color={P.solidLift} roughness={0.9} side={THREE.DoubleSide} transparent opacity={0.55} />
          <Edges color={is(2) ? P.edgeActive : P.edge} threshold={30} />
        </mesh>
      </Station>

      <Station x={x3} active={is(3)}>
        {[-0.42, 0.42].map((dx, i) => (
          <mesh key={dx} geometry={geo.node} position={[dx, 0.29, 0]}>
            <meshStandardMaterial ref={i === 0 ? pairA : pairB} color={BODY} roughness={0.9} />
            <Edges color={is(3) ? P.edgeActive : P.edge} />
          </mesh>
        ))}
        <Line points={[[-0.42, 0.56, 0], [0, 0.95, 0], [0.42, 0.56, 0]]} color={is(3) ? P.edgeActive : P.edge} lineWidth={1} />
      </Station>

      <Station x={x4} active={is(4)}>
        {treeNodes.map(([tx, ty]) => (
          <mesh key={`${tx}${ty}`} geometry={geo.tree} position={[tx, ty, 0]}>
            <meshStandardMaterial color={BODY} roughness={0.9} />
            <Edges color={is(4) ? P.edgeActive : P.edge} />
          </mesh>
        ))}
        {LEAVES.map((lx, i) => (
          <mesh key={lx} geometry={geo.tree} position={[lx, 0.42, 0]}>
            <meshStandardMaterial ref={(m) => { leafMats.current[i] = m; }} color={BODY} roughness={0.9} />
            <Edges color={is(4) ? P.edgeActive : P.edge} />
          </mesh>
        ))}
        {[
          [[0, 1.36, 0], [-0.44, 0.9, 0]],
          [[0, 1.36, 0], [0.44, 0.9, 0]],
          [[-0.44, 0.9, 0], [-0.66, 0.42, 0]],
          [[-0.44, 0.9, 0], [-0.22, 0.42, 0]],
          [[0.44, 0.9, 0], [0.22, 0.42, 0]],
          [[0.44, 0.9, 0], [0.66, 0.42, 0]],
        ].map((pts, i) => (
          <Line key={i} points={pts as [number, number, number][]} color={is(4) ? P.edgeActive : P.edge} lineWidth={1} />
        ))}
      </Station>

      <group ref={packetGroup} />
    </group>
  );
}

/**
 * Wide screens: all five stations in frame. Narrow screens: the camera glides to the active station,
 * so each step gets a readable close-up instead of a tiny diorama.
 */
function Fit({ focus }: { focus: number | null }) {
  const { camera, size, invalidate } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const narrow = aspect < 1.6;
  const target = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3(0, 0.7, 0));

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const halfW = narrow ? 1.35 : 6.25;
    const d = halfW / (Math.tan(vfov / 2) * aspect);
    const x = narrow ? STATION_X[focus ?? 2] : 0;
    target.current.set(x, 1.5 + d * 0.3, Math.max(narrow ? 4.2 : 7, d));
    look.current.set(x, narrow ? 0.62 : 0.68, 0);
    if (cam.position.lengthSq() === 0 || !narrow) {
      cam.position.copy(target.current);
      cam.lookAt(look.current);
    }
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, aspect, narrow, focus, invalidate]);

  const lookNow = useRef(new THREE.Vector3(0, 0.7, 0));
  useFrame((_, d) => {
    if (!narrow) return;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, target.current.x, 3, d);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, target.current.y, 3, d);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, target.current.z, 3, d);
    lookNow.current.lerp(look.current, 1 - Math.exp(-3 * d));
    camera.lookAt(lookNow.current);
  });
  return null;
}

export default function FeeFlowCanvas({ active, animate, frameloop }: SceneProps & { frameloop: "always" | "demand" | "never" }) {
  return (
    <Canvas
      frameloop={frameloop}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false }}
      camera={{ fov: 26, near: 0.1, far: 80 }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(P.bg);
        scene.fog = new THREE.Fog(P.bg, 14, 30);
      }}
      aria-hidden
    >
      <Fit focus={active} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#ffffff", "#0c0c0c", 0.6]} />
      <directionalLight position={[-4, 8, 7]} intensity={1.8} />
      <directionalLight position={[3, 2.5, 9]} intensity={0.7} />
      <Scene active={active} animate={animate} />
    </Canvas>
  );
}
