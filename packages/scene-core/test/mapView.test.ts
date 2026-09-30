import { describe, expect, it } from "vitest";
import { Euler, MathUtils, Object3D, Quaternion, Vector3 } from "three";
import {
  encloseBounds,
  fitDistance,
  groundEyePose,
  headingToward,
  ISOMETRIC_ELEVATION,
  orbitPose,
  tweenPose,
  yawOf,
  type ViewPose,
} from "../src/mapView.js";
import { buildProceduralMannequin, Mannequin, MANNEQUIN_NODES } from "../src/mannequin.js";
import { Spring, Tween, angleDelta, decay, easeDive } from "../src/motion.js";

const forwardOf = (quaternion: readonly [number, number, number, number]) =>
  new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...quaternion));

describe("map view geometry", () => {
  it("fits the scene's bounding sphere in the narrower field of view", () => {
    const distance = fitDistance(10, 22, 0.5);
    const horizontal = Math.atan(Math.tan(MathUtils.degToRad(11)) * 0.5);
    expect(distance).toBeCloseTo((10 / Math.sin(horizontal)) * 1.02, 6);
    expect(fitDistance(10, 22, 2)).toBeLessThan(distance);
  });

  it("orbits at the isometric angle, looking at the target", () => {
    const pose = orbitPose({
      target: [1, 2, 3],
      azimuth: Math.PI / 4,
      elevation: ISOMETRIC_ELEVATION,
      distance: 10,
    });
    const toTarget = new Vector3(1, 2, 3).sub(new Vector3(...pose.position)).normalize();
    expect(forwardOf(pose.quaternion).dot(toTarget)).toBeCloseTo(1, 6);
    expect(new Vector3(...pose.position).distanceTo(new Vector3(1, 2, 3))).toBeCloseTo(10, 6);
    expect(Math.asin(-toTarget.y)).toBeCloseTo(ISOMETRIC_ELEVATION, 6);
    expect(yawOf(pose.quaternion)).toBeCloseTo(Math.PI / 4, 6);
  });

  it("stands at eye height with a level horizon, facing the heading", () => {
    const pose = groundEyePose([2, 0.5, -1], 0.8, 1.6);
    expect(pose.position).toEqual([2, 2.1, -1]);
    const forward = forwardOf(pose.quaternion);
    expect(forward.y).toBeCloseTo(0, 9);
    expect(yawOf(pose.quaternion)).toBeCloseTo(0.8, 9);
    const euler = new Euler().setFromQuaternion(new Quaternion(...pose.quaternion), "YXZ");
    expect(euler.z).toBeCloseTo(0, 9);
  });

  it("aims a heading from the figure toward a point", () => {
    const heading = headingToward([0, 0, 0], [3, 0, -3]);
    const forward = forwardOf(groundEyePose([0, 0, 0], heading, 1).quaternion);
    expect(forward.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(forward.z).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it("grows the bounds just enough to frame cameras outside the scene", () => {
    const bounds = { center: [0, 0, 0] as const, radius: 2 };
    expect(encloseBounds(bounds, [[1, 0, 0]])).toEqual(bounds);
    const grown = encloseBounds(bounds, [[0, 6, 0]]);
    expect(grown.radius).toBeCloseTo(4, 6);
    expect(grown.center[1]).toBeCloseTo(2, 6);
  });

  it("tweens exactly onto both ends and arcs above the straight line", () => {
    const from: ViewPose = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fov: 50 };
    const to: ViewPose = { position: [10, 0, 0], quaternion: [0, 1, 0, 0], fov: 22 };
    expect(tweenPose(from, to, 0, 4)).toEqual(from);
    expect(tweenPose(from, to, 1, 4)).toEqual(to);
    const middle = tweenPose(from, to, 0.5, 4);
    expect(middle.position[1]).toBeCloseTo(2, 6);
    expect(middle.fov).toBeCloseTo(36, 6);
  });
});

describe("motion primitives", () => {
  it("settles springs and decays velocity independent of frame rate", () => {
    const spring = new Spring(0, 170, 26);
    spring.target = 1;
    for (let i = 0; i < 120; i += 1) spring.update(16);
    expect(spring.value).toBeCloseTo(1, 3);
    const coarse = decay(decay(10, 50, 100), 50, 100);
    expect(coarse).toBeCloseTo(decay(10, 100, 100), 9);
    expect(decay(10, 100, 100)).toBeCloseTo(5, 9);
  });

  it("finishes tweens exactly and immediately when motion is off", async () => {
    const seen: number[] = [];
    const tween = new Tween(100, (t) => seen.push(t));
    tween.update(40);
    tween.update(1000);
    await tween.done;
    expect(seen).toEqual([0.4, 1]);
    const instant = new Tween(0, (t) => seen.push(t));
    await instant.done;
    expect(seen.at(-1)).toBe(1);
    expect(easeDive(0)).toBe(0);
    expect(easeDive(1)).toBe(1);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 9);
  });
});

describe("cinematographer mannequin", () => {
  it("builds every animated joint procedurally, with the eye at 1.0", () => {
    const figure = buildProceduralMannequin();
    const names = new Set<string>();
    figure.traverse((object) => names.add(object.name));
    for (const name of MANNEQUIN_NODES) expect(names).toContain(name);
    const head = figure.getObjectByName("head")!;
    figure.updateMatrixWorld(true);
    const world = new Vector3().setFromMatrixPosition(head.matrixWorld);
    expect(world.y).toBeCloseTo(0.93, 6);
  });

  it("stands, is carried with a lean, and lands back on the ground", () => {
    const mannequin = new Mannequin();
    mannequin.setFigure(buildProceduralMannequin());
    expect(mannequin.jointNames).toEqual(expect.arrayContaining([...MANNEQUIN_NODES]));
    mannequin.eyeHeight = 2;
    mannequin.placeAt(new Vector3(0, 1, 0), 0);
    for (let i = 0; i < 60; i += 1) mannequin.update(16);
    expect(mannequin.displayedGround.y).toBeCloseTo(1, 6);
    mannequin.pickUp();
    mannequin.carryTo(new Vector3(4, 1, 0));
    for (let i = 0; i < 10; i += 1) mannequin.update(16);
    expect(mannequin.state).toBe("carried");
    mannequin.drop(true);
    for (let i = 0; i < 120; i += 1) mannequin.update(16);
    expect(mannequin.state).toBe("idle");
    expect(mannequin.position.toArray()).toEqual([4, 1, 0]);
    expect(mannequin.displayedGround.distanceTo(new Vector3(4, 1, 0))).toBeLessThan(1e-6);
  });

  it("returns home when released over nothing and faces its heading", () => {
    const mannequin = new Mannequin();
    mannequin.setFigure(new Object3D());
    mannequin.placeAt(new Vector3(1, 0, 1), 0);
    mannequin.pickUp();
    mannequin.carryTo(undefined);
    mannequin.drop(false);
    for (let i = 0; i < 120; i += 1) mannequin.update(16);
    expect(mannequin.position.toArray()).toEqual([1, 0, 1]);
    mannequin.setHeading(Math.PI * 2 + 0.5, false);
    expect(angleDelta(mannequin.currentHeading, 0.5)).toBeCloseTo(0, 9);
  });
});

describe("map view session", () => {
  it("lets a close that starts while the rise is finishing win", async () => {
    const { MapView } = await import("../src/mapView.js");
    const element = Object.assign(new EventTarget(), {
      clientWidth: 400,
      clientHeight: 800,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
      setPointerCapture: () => undefined,
    }) as unknown as HTMLElement;
    const map = new MapView({ element, raycast: () => undefined });
    const rig = { position: [0, 1.6, 0] as const, quaternion: [0, 0, 0, 1] as const, fov: 50 };
    const entered = map.enter({
      rig,
      bounds: { center: [0, 0, 0], radius: 5 },
      eyeHeight: 1.6,
      reduceMotion: false,
    });
    for (let i = 0; i < 20; i += 1) map.update(100);
    const closed = map.exit(rig);
    await entered;
    for (let i = 0; i < 20; i += 1) map.update(100);
    await closed;
    expect(map.phase).toBe("off");
  });

  it("spins a preview turntable that pauses under the finger and eases back in", async () => {
    const { MapView } = await import("../src/mapView.js");
    const element = Object.assign(new EventTarget(), {
      clientWidth: 400,
      clientHeight: 800,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 800 }),
      setPointerCapture: () => undefined,
    }) as unknown as HTMLElement;
    const map = new MapView({ element, raycast: () => undefined });
    const rig = { position: [0, 1.6, 0] as const, quaternion: [0, 0, 0, 1] as const, fov: 50 };
    const entered = map.enter({
      rig,
      bounds: { center: [0, 0, 0], radius: 5 },
      eyeHeight: 1.6,
      figure: false,
      reduceMotion: true,
    });
    map.update(16);
    await entered;
    map.setAutoRotate(0.5);
    const start = map.currentAzimuth;
    for (let i = 0; i < 10; i += 1) map.update(100);
    expect(map.currentAzimuth - start).toBeCloseTo(0.5, 5);

    const pointer = (type: string) =>
      Object.assign(new Event(type), { pointerId: 1, clientX: 200, clientY: 400 });
    element.dispatchEvent(pointer("pointerdown"));
    const held = map.currentAzimuth;
    for (let i = 0; i < 10; i += 1) map.update(100);
    expect(map.currentAzimuth).toBe(held);
    element.dispatchEvent(pointer("pointerup"));
    // Still paused shortly after letting go, spinning again once idle.
    for (let i = 0; i < 10; i += 1) map.update(100);
    expect(map.currentAzimuth).toBeCloseTo(held, 5);
    for (let i = 0; i < 40; i += 1) map.update(100);
    expect(map.currentAzimuth).toBeGreaterThan(held + 0.2);
  });
});
