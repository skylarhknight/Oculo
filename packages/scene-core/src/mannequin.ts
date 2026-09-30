import type { Object3D } from "three";
import {
  CircleGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Euler,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Material,
} from "three";
import { Spring, angleDelta, clamp01, easeOutBack } from "./motion.js";

/**
 * The map-view cinematographer: a faceless clay mannequin with a red scarf. The model
 * is authored in Blender (tools/blender/cinematographer.py) with named joint nodes and
 * an eye height of 1.0; everything that moves is animated here with springs, so the
 * figure reacts to how it is dragged rather than replaying canned clips.
 */

export const MANNEQUIN_NODES = [
  "root",
  "hips",
  "torso",
  "neck",
  "head",
  "arm_L",
  "arm_R",
  "forearm_L",
  "forearm_R",
  "leg_L",
  "leg_R",
  "scarf_wrap",
  ...(["A", "B"] as const).flatMap((tail) =>
    [1, 2, 3, 4].map((index) => `scarf_tail_${tail}_${index}`),
  ),
] as const;

export type MannequinNode = (typeof MANNEQUIN_NODES)[number];

const CLAY = 0xededf2;
const JOINT = 0xdbdbe3;
const SCARF = 0xff5a36;
const GHOST = new Color(0xff453a);

export type MannequinState = "idle" | "carried" | "falling" | "hidden";

interface Joint {
  readonly node: Object3D;
  readonly rest: Quaternion;
}

/** Builds the Blender figure from primitives, with the same node names and pivots. */
export function buildProceduralMannequin(): Object3D {
  const clay = new MeshStandardMaterial({ color: CLAY, roughness: 0.82 });
  const joint = new MeshStandardMaterial({ color: JOINT, roughness: 0.7 });
  const scarf = new MeshStandardMaterial({ color: SCARF, roughness: 0.6 });
  const blob = (radii: [number, number, number], material: Material, at: Vector3) => {
    const mesh = new Mesh(new SphereGeometry(1, 16, 10), material);
    mesh.scale.set(...radii);
    mesh.position.copy(at);
    return mesh;
  };
  const node = (name: string, parent: Object3D, pivot: Vector3, world: Vector3) => {
    const object = new Group();
    object.name = name;
    object.position.copy(pivot.clone().sub(world));
    parent.add(object);
    return object;
  };
  const root = new Group();
  root.name = "root";
  const hips = node("hips", root, new Vector3(0, 0.56, 0), new Vector3());
  hips.add(blob([0.098, 0.075, 0.068], clay, new Vector3(0, -0.025, 0)));
  const torso = node("torso", hips, new Vector3(0, 0.6, 0), new Vector3(0, 0.56, 0));
  torso.add(blob([0.114, 0.13, 0.066], clay, new Vector3(0, 0.155, 0)));
  const neck = node("neck", torso, new Vector3(0, 0.885, 0), new Vector3(0, 0.6, 0));
  neck.add(blob([0.034, 0.045, 0.034], joint, new Vector3(0, 0.015, 0)));
  const head = node("head", neck, new Vector3(0, 0.93, 0), new Vector3(0, 0.885, 0));
  head.add(blob([0.066, 0.082, 0.072], clay, new Vector3(0, 0.07, 0)));
  for (const [side, sign] of [
    ["L", 1],
    ["R", -1],
  ] as const) {
    const arm = node(
      `arm_${side}`,
      torso,
      new Vector3(sign * 0.14, 0.845, 0),
      new Vector3(0, 0.6, 0),
    );
    arm.add(blob([0.03, 0.12, 0.03], clay, new Vector3(sign * 0.012, -0.1, 0)));
    const forearm = node(
      `forearm_${side}`,
      arm,
      new Vector3(sign * 0.165, 0.64, 0),
      new Vector3(sign * 0.14, 0.845, 0),
    );
    forearm.add(blob([0.026, 0.13, 0.026], clay, new Vector3(0, -0.12, 0)));
    const leg = node(
      `leg_${side}`,
      hips,
      new Vector3(sign * 0.058, 0.5, 0),
      new Vector3(0, 0.56, 0),
    );
    leg.add(blob([0.044, 0.25, 0.044], clay, new Vector3(0, -0.23, 0)));
    leg.add(blob([0.032, 0.024, 0.066], clay, new Vector3(0, -0.475, 0.03)));
  }
  const wrap = node("scarf_wrap", neck, new Vector3(0, 0.872, 0), new Vector3(0, 0.885, 0));
  wrap.add(blob([0.068, 0.025, 0.062], scarf, new Vector3()));
  for (const tail of ["A", "B"] as const) {
    let parent: Object3D = wrap;
    let world = new Vector3(0, 0.872, 0);
    for (let index = 1; index <= 4; index += 1) {
      const top =
        index === 1
          ? new Vector3(tail === "A" ? 0.022 : 0.044, 0.85, 0.07)
          : world.clone().setY(world.y - 0.044);
      const segment = node(`scarf_tail_${tail}_${index}`, parent, top, world);
      segment.add(blob([0.016, 0.026, 0.005], scarf, new Vector3(0, -0.024, 0)));
      parent = segment;
      world = top;
    }
  }
  return root;
}

/** A soft radial disc (ground shadow) or ring (dust, "you are here"), drawn with a shader. */
function softDisc(color: number, ring: boolean): Mesh<CircleGeometry, ShaderMaterial> {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color(color) },
      uOpacity: { value: ring ? 0 : 0.3 },
      uInner: { value: 0.72 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: ring
      ? `uniform vec3 uColor; uniform float uOpacity; uniform float uInner; varying vec2 vUv;
         void main() { float r = distance(vUv, vec2(0.5)) * 2.0;
           float band = smoothstep(uInner - 0.18, uInner, r) * (1.0 - smoothstep(0.92, 1.0, r));
           gl_FragColor = vec4(uColor, band * uOpacity); }`
      : `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
         void main() { float r = distance(vUv, vec2(0.5)) * 2.0;
           gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.0, 1.0, r)) * uOpacity); }`,
  });
  const mesh = new Mesh(new CircleGeometry(1, 48), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * The figure placed in world space: position is the point under its feet, heading the
 * camera yaw it will look along after the teleport.
 */
export class Mannequin {
  readonly group = new Group();
  private readonly body = new Group();
  private readonly lights = new Group();
  private figure: Object3D | undefined;
  private readonly joints = new Map<string, Joint>();
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly baseColors = new Map<MeshStandardMaterial, Color>();
  private readonly shadow = softDisc(0x000000, false);
  private readonly dust = softDisc(0xffffff, true);
  private readonly beacon = softDisc(0xffffff, true);
  private readonly aim = new Group();
  private readonly aimArrow: Mesh;
  private readonly aimRing: Mesh;
  private readonly aimMaterials: MeshBasicMaterial[] = [];

  state: MannequinState = "hidden";
  /** Scene units from the feet to the eyes; the figure scales to match. */
  eyeHeight = 1;
  /** Drawn a little larger than life so the figure reads on a phone-sized overview. */
  displayScale = 1.5;

  get displayHeight(): number {
    return this.eyeHeight * this.displayScale;
  }
  reduceMotion = false;

  private readonly ground = new Vector3();
  private readonly carryTarget = new Vector3();
  private readonly previous = new Vector3();
  private readonly velocity = new Vector3();
  private heading = 0;
  private readonly headingSpring = new Spring(0, 200, 24);
  private readonly lift = new Spring(0, 260, 18);
  private readonly appear = new Spring(0, 220, 16);
  private readonly squash = new Spring(0, 320, 12);
  private readonly tiltX = new Spring(0, 140, 14);
  private readonly tiltZ = new Spring(0, 140, 14);
  private readonly legSwing = new Spring(0, 90, 5);
  private readonly ghost = new Spring(0, 200, 26);
  private readonly aimShown = new Spring(0, 220, 22);
  private readonly fade = new Spring(1, 200, 26);
  private readonly tails = Array.from({ length: 8 }, () => new Spring(0, 120, 7));
  private fallVelocity = 0;
  private dustAge = Infinity;
  private beaconAge = 0;
  private clock = 0;
  private readonly beaconAt = new Vector3();

  constructor() {
    this.group.name = "cinematographer";
    this.group.visible = false;
    const hemisphere = new HemisphereLight(0xffffff, 0x8a8f99, 1.7);
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(-2, 4, 3);
    this.lights.add(hemisphere, key);

    this.shadow.renderOrder = 1;
    this.beacon.material.uniforms.uInner!.value = 0.8;
    const aimMaterial = new MeshBasicMaterial({
      color: 0xffd60a,
      transparent: true,
      opacity: 0,
      depthTest: false,
      side: DoubleSide,
    });
    const arrowMaterial = aimMaterial.clone();
    this.aimMaterials.push(aimMaterial, arrowMaterial);
    this.aimRing = new Mesh(
      new RingGeometry(0.34, 0.37, 64, 1, Math.PI * 0.62, Math.PI * 1.76),
      aimMaterial,
    );
    this.aimRing.rotation.x = -Math.PI / 2;
    this.aimArrow = new Mesh(new ConeGeometry(0.07, 0.16, 3), arrowMaterial);
    this.aimArrow.rotation.x = -Math.PI / 2;
    this.aimArrow.position.set(0, 0, -0.44);
    this.aimRing.renderOrder = 3;
    this.aimArrow.renderOrder = 3;
    this.aim.add(this.aimRing, this.aimArrow);
    this.group.add(this.lights, this.shadow, this.dust, this.beacon, this.body, this.aim);
  }

  /** Uses the authored model, or the procedural stand-in when it cannot load. */
  setFigure(figure: Object3D): void {
    if (this.figure) this.body.remove(this.figure);
    this.figure = figure;
    this.joints.clear();
    this.materials.length = 0;
    this.baseColors.clear();
    figure.traverse((object) => {
      if (
        (MANNEQUIN_NODES as readonly string[]).includes(object.name) &&
        !this.joints.has(object.name)
      )
        this.joints.set(object.name, { node: object, rest: object.quaternion.clone() });
      if (object instanceof Mesh) {
        const source = Array.isArray(object.material) ? object.material : [object.material];
        const copies = source.map((material: Material) => {
          const copy =
            material instanceof MeshStandardMaterial
              ? material.clone()
              : new MeshStandardMaterial({ color: CLAY, roughness: 0.8 });
          copy.transparent = true;
          this.materials.push(copy);
          this.baseColors.set(copy, copy.color.clone());
          return copy;
        });
        object.material = Array.isArray(object.material) ? copies : copies[0]!;
        object.renderOrder = 4;
      }
    });
    this.body.add(figure);
  }

  get hasFigure(): boolean {
    return this.figure !== undefined;
  }

  /** Names of the joints found in the current figure (for diagnostics and tests). */
  get jointNames(): string[] {
    return [...this.joints.keys()];
  }

  get position(): Vector3 {
    return this.ground.clone();
  }

  /** Where the figure is drawn right now (it may still be flying to its target). */
  get displayedGround(): Vector3 {
    return this.body.position.clone();
  }

  get currentHeading(): number {
    return this.heading;
  }

  /** Stands the figure on a spot, popping in from nothing. */
  placeAt(ground: Vector3, heading: number): void {
    this.ground.copy(ground);
    this.carryTarget.copy(ground);
    this.previous.copy(ground);
    this.body.position.copy(ground);
    this.heading = heading;
    this.headingSpring.snap(heading);
    this.lift.snap(0);
    this.appear.snap(this.reduceMotion ? 1 : 0);
    this.appear.target = 1;
    this.fade.snap(1);
    this.state = "idle";
    this.group.visible = true;
  }

  /** Pulsing ring marking where the camera stands now ("you are here"). */
  markOrigin(ground: Vector3 | undefined): void {
    this.beacon.visible = ground !== undefined;
    if (ground) this.beaconAt.copy(ground);
  }

  pickUp(): void {
    if (this.state === "hidden") return;
    this.state = "carried";
    this.lift.target = 0.42;
    if (!this.reduceMotion) this.lift.kick(3.2);
  }

  /** Follows a ground point while carried; `undefined` means nowhere valid under the finger. */
  carryTo(ground: Vector3 | undefined): void {
    if (this.state !== "carried") return;
    this.ghost.target = ground ? 0 : 1;
    if (ground) this.carryTarget.copy(ground);
  }

  /** Lets go over the current target; returns false when released over nothing. */
  drop(valid: boolean): void {
    if (valid) {
      this.ground.copy(this.carryTarget);
      this.state = "falling";
      this.fallVelocity = 0;
      this.ghost.target = 0;
    } else {
      // Spring home to where it stood before the drag.
      this.carryTarget.copy(this.ground);
      this.ghost.target = 0;
      this.lift.target = 0;
      this.state = "idle";
    }
  }

  setHeading(heading: number, animate = true): void {
    this.heading = this.headingSpring.target + angleDelta(this.headingSpring.target, heading);
    this.headingSpring.target = this.heading;
    if (!animate || this.reduceMotion) this.headingSpring.snap(this.heading);
  }

  showAim(visible: boolean): void {
    this.aimShown.target = visible ? 1 : 0;
  }

  /** 0..1 progress of the camera diving into the figure; it shrinks away near the end. */
  setDiveProgress(progress: number): void {
    this.fade.snap(1 - clamp01((progress - 0.72) / 0.22));
  }

  hide(): void {
    this.state = "hidden";
    this.group.visible = false;
    this.showAim(false);
    this.aimShown.snap(0);
  }

  update(dtMs: number): void {
    if (this.state === "hidden") return;
    const seconds = Math.max(0, dtMs) / 1000;
    this.clock += seconds;
    const scale = this.displayHeight;
    const calm = this.reduceMotion;

    // Travel: carried figures chase the finger with a quick critically damped follow.
    if (this.state === "carried" || this.state === "idle") {
      const follow = calm ? 1 : 1 - 0.5 ** (dtMs / 38);
      this.body.position.lerp(this.carryTarget, follow);
    }
    if (this.state === "falling") {
      // Gravity in figure heights per second squared: a short, weighty drop.
      this.body.position.copy(this.ground);
      this.fallVelocity += 15.7 * seconds;
      this.lift.snap(Math.max(0, this.lift.value - this.fallVelocity * seconds));
      if (this.lift.value <= 0 || calm) this.land();
    }

    if (seconds > 0) {
      this.velocity
        .copy(this.body.position)
        .sub(this.previous)
        .divideScalar(seconds * scale);
    }
    this.previous.copy(this.body.position);

    if (this.state !== "falling") this.lift.update(dtMs);
    this.appear.update(dtMs);
    this.squash.update(dtMs);
    this.headingSpring.update(dtMs);
    this.ghost.update(dtMs);
    this.aimShown.update(dtMs);

    // Lean against the drag, like something held from above, and let the legs swing.
    const heading = this.headingSpring.value;
    const forward = new Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const right = new Vector3(Math.cos(heading), 0, -Math.sin(heading));
    const carried = this.state === "carried" ? 1 : 0;
    const clampTilt = (value: number) => Math.max(-0.45, Math.min(0.45, value));
    this.tiltX.target = calm ? 0 : clampTilt(-this.velocity.dot(forward) * 0.09 * carried);
    this.tiltZ.target = calm ? 0 : clampTilt(this.velocity.dot(right) * 0.09 * carried);
    this.tiltX.update(dtMs);
    this.tiltZ.update(dtMs);
    this.legSwing.target = calm ? 0 : -this.velocity.dot(forward) * 0.05 * carried;
    this.legSwing.update(dtMs);

    const appear = calm ? 1 : Math.max(0, this.appear.value);
    const squash = this.squash.value;
    const size = scale * appear * this.fade.value;
    this.body.scale.set(size * (1 + squash * 0.5), size * (1 - squash), size * (1 + squash * 0.5));
    this.body.rotation.set(0, 0, 0);
    this.body.quaternion.setFromEuler(
      new Euler(this.tiltX.value, heading + Math.PI, -this.tiltZ.value, "YXZ"),
    );
    // Lifted figures hover; the offset is in body space so it scales with the figure.
    if (this.figure) this.figure.position.y = Math.max(0, this.lift.value);

    this.pose(dtMs, carried, calm);
    this.updateEffects(dtMs, carried, calm);
  }

  private land(): void {
    this.lift.snap(0);
    this.state = "idle";
    this.carryTarget.copy(this.ground);
    this.body.position.copy(this.ground);
    if (!this.reduceMotion) {
      this.squash.snap(0);
      this.squash.kick(Math.min(4.5, 1.8 + this.fallVelocity * 0.35));
      this.dustAge = 0;
    }
  }

  private pose(dtMs: number, carried: number, calm: boolean): void {
    const t = this.clock;
    const rotate = (name: MannequinNode, x: number, y = 0, z = 0) => {
      const joint = this.joints.get(name);
      if (!joint) return;
      joint.node.quaternion
        .copy(joint.rest)
        .multiply(new Quaternion().setFromEuler(new Euler(x, y, z)));
    };
    const breathe = calm ? 0 : Math.sin(t * Math.PI * 0.5);
    const torso = this.joints.get("torso");
    if (torso) torso.node.scale.set(1 + breathe * 0.012, 1 + breathe * 0.015, 1 + breathe * 0.012);
    rotate(
      "head",
      calm ? 0 : Math.sin(t * 0.7) * 0.04,
      calm ? 0 : Math.sin(t * 0.45) * 0.22 * (1 - carried),
    );
    // Carried: arms lift and flail a little; legs dangle and trail the motion.
    const flail = calm ? 0 : Math.sin(t * 9) * 0.12 * carried;
    rotate("arm_L", 0, 0, 0.55 * carried + flail);
    rotate("arm_R", 0, 0, -0.55 * carried + flail);
    rotate("forearm_L", -0.5 * carried, 0, 0.2 * carried);
    rotate("forearm_R", -0.5 * carried, 0, -0.2 * carried);
    const kick = calm ? 0 : Math.sin(t * 7) * 0.18 * carried;
    rotate("leg_L", this.legSwing.value + kick, 0, 0.08 * carried);
    rotate("leg_R", this.legSwing.value * 0.8 - kick, 0, -0.08 * carried);

    // Scarf tails: each segment springs toward a sway that lags further down the chain.
    const speed = Math.min(6, this.velocity.length());
    const forwardSpeed = this.velocity.dot(
      new Vector3(-Math.sin(this.headingSpring.value), 0, -Math.cos(this.headingSpring.value)),
    );
    ["A", "B"].forEach((tail, tailIndex) => {
      for (let index = 1; index <= 4; index += 1) {
        const spring = this.tails[tailIndex * 4 + index - 1]!;
        const sway = calm
          ? 0
          : Math.sin(t * 2.1 - index * 0.7 + tailIndex * 1.3) * (0.06 + carried * 0.25) +
            forwardSpeed * 0.1 * index * (tailIndex ? 0.8 : 1);
        spring.target = sway - speed * 0.04 * carried * index;
        spring.update(dtMs);
        rotate(
          `scarf_tail_${tail as "A" | "B"}_${index as 1 | 2 | 3 | 4}`,
          spring.value,
          0,
          sway * 0.3,
        );
      }
    });

    // Ghost when over nothing valid: red, translucent.
    const ghost = this.ghost.value;
    for (const material of this.materials) {
      const base = this.baseColors.get(material);
      if (base) material.color.copy(base).lerp(GHOST, ghost * 0.85);
      material.opacity = (1 - ghost * 0.5) * this.fade.value;
      material.depthWrite = material.opacity > 0.99;
    }
  }

  private updateEffects(dtMs: number, carried: number, calm: boolean): void {
    const scale = this.displayHeight;
    // Contact shadow stays on the ground under the figure and fades as it rises.
    const height = Math.max(0, this.lift.value);
    this.shadow.position.set(
      this.body.position.x,
      this.body.position.y + scale * 0.01,
      this.body.position.z,
    );
    const shadowSize = scale * 0.3 * (1 - Math.min(0.5, height * 0.8)) * this.fade.value;
    this.shadow.scale.setScalar(Math.max(1e-4, shadowSize));
    this.shadow.material.uniforms.uOpacity!.value =
      (0.34 - height * 0.4) * Math.max(0, this.appear.value);

    // Landing dust: a ring that races outward and fades.
    this.dustAge += dtMs;
    const dustT = this.dustAge / 520;
    this.dust.visible = dustT < 1 && !calm;
    if (this.dust.visible) {
      this.dust.position.set(this.ground.x, this.ground.y + scale * 0.015, this.ground.z);
      this.dust.scale.setScalar(scale * (0.18 + easeOutBack(dustT, 0.4) * 0.55));
      this.dust.material.uniforms.uOpacity!.value = 0.75 * (1 - dustT) ** 2;
    }

    // "You are here": a slow breathing ring where the camera currently stands.
    this.beaconAge += dtMs;
    if (this.beacon.visible) {
      const pulse = calm ? 0.5 : (this.beaconAge % 1800) / 1800;
      this.beacon.position.set(this.beaconAt.x, this.beaconAt.y + scale * 0.012, this.beaconAt.z);
      this.beacon.scale.setScalar(scale * (0.14 + pulse * 0.26));
      this.beacon.material.uniforms.uOpacity!.value = 0.55 * (1 - pulse) * (1 - carried * 0.5);
    }

    // Aim gizmo: an arc around the feet with an arrow pointing where the camera will look.
    const aim = clamp01(this.aimShown.value);
    this.aim.visible = aim > 0.01;
    this.aim.position.set(
      this.body.position.x,
      this.body.position.y + scale * 0.03,
      this.body.position.z,
    );
    this.aim.rotation.set(0, this.headingSpring.value, 0);
    this.aim.scale.setScalar(scale * (0.8 + aim * 0.2));
    const glow = calm ? 1 : 0.8 + Math.sin(this.clock * 4) * 0.2;
    for (const material of this.aimMaterials) material.opacity = aim * glow;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material: Material) => material.dispose());
      }
    });
  }
}

/** Loads the authored model lazily; falls back to the procedural figure. */
export async function loadMannequinFigure(url: string | undefined): Promise<Object3D> {
  if (!url) return buildProceduralMannequin();
  try {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const gltf = await new GLTFLoader().loadAsync(url);
    const root = gltf.scene.getObjectByName("root") ?? gltf.scene;
    return root;
  } catch {
    return buildProceduralMannequin();
  }
}
