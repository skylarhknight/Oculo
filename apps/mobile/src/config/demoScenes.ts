import { migrateScene, type SceneDescriptor } from "@oculo/scene-schema";

export interface DemoScene {
  title: string;
  eyebrow: string;
  description: string;
  descriptor: SceneDescriptor;
  accent: string;
  availableOffline: boolean;
}

// The first starter is licensed and shipped with the app. The remaining public
// Spark examples require a network connection and are not copied into the bundle.
export const DEMO_SCENES: readonly DemoScene[] = [
  {
    title: "Small Garden",
    eyebrow: "Offline starter · Garden study",
    description:
      "Explore a photographed garden and compose a close-up among flowers and sculptures.",
    descriptor: migrateScene({
      id: "small-garden",
      name: "Small Garden",
      splatUrl: "/scenes/small-garden/small-garden.sog",
      // SuperSplat's published viewer rotates its SOG object 180° around Z.
      splatQuaternion: [0, 0, 1, 0],
      initialCameraPose: {
        // Published camera position; quaternion looks at the saved viewer target.
        position: [2.821625232696533, 8.570806503295898, 2.578657865524292],
        quaternion: [
          -0.12859633970447537, 0.3645865573144021, 0.050914892225768796, 0.9208405385243863,
        ],
      },
      source: "bundled",
      attribution: {
        text: "Small Garden — scbenoit · CC BY 4.0",
        url: "https://superspl.at/scene/108dd868",
        license: "CC BY 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    }),
    accent: "#d9ff72",
    availableOffline: true,
  },
  {
    title: "Painted Bedroom",
    eyebrow: "Online demo · Interior study",
    description: "Stream a public Spark example and compose a controlled establishing shot.",
    descriptor: migrateScene({
      id: "painted-bedroom",
      name: "Painted Bedroom",
      splatUrl: "https://storage.googleapis.com/forge-dev-public/painted_bedroom.spz",
      splatQuaternion: [1, 0, 0, 0],
      initialCameraPose: {
        position: [0, 0, 3],
        quaternion: [0, 0, 0, 1],
      },
      source: "bundled",
    }),
    accent: "#d9ff72",
    availableOffline: false,
  },
  {
    title: "Snow Street",
    eyebrow: "Online demo · Exterior study",
    description: "Stream a public Spark example and block a measured move through a wintry street.",
    descriptor: migrateScene({
      id: "snow-street",
      name: "Snow Street",
      splatUrl: "https://sparkjs.dev/assets/splats/snow-street.spz",
      splatQuaternion: [1, 0, 0, 0],
      initialCameraPose: {
        position: [0, 0, 3],
        quaternion: [0, 0, 0, 1],
      },
      source: "bundled",
    }),
    accent: "#ffad7a",
    availableOffline: false,
  },
  {
    title: "Open Valley",
    eyebrow: "Online demo · Landscape study",
    description: "Stream a public Spark example and design a slow reveal across open terrain.",
    descriptor: migrateScene({
      id: "valley",
      name: "Open Valley",
      splatUrl: "https://sparkjs.dev/assets/splats/valley.spz",
      splatQuaternion: [1, 0, 0, 0],
      initialCameraPose: {
        position: [0, 0, 3],
        quaternion: [0, 0, 0, 1],
      },
      source: "bundled",
    }),
    accent: "#7ed7ff",
    availableOffline: false,
  },
] as const;

// Bundled bytes are pinned just like imported assets; the locator is resolved at runtime.
const starter = DEMO_SCENES[0]!.descriptor;
starter.asset = {
  versionId: "bundled-small-garden-v1",
  fingerprint: {
    status: "verified",
    algorithm: "sha256",
    digest: "68ef9089854aeb84ace37ce51c2ded9404151db86f2e47d8d64ed5f25ce95cb6",
  },
  format: { name: "sog", version: null },
  byteSize: 13081550,
  locator: { kind: "local", relativePath: "scenes/small-garden/small-garden.sog" },
};
