import type { GalleryScene } from "../config/sceneCatalog";
import { Sheet } from "../ui/Sheet";

/** The credit CC BY asks for: creator, source, license, and what Oculo changed. */
export function SceneCreditsSheet({
  scenes,
  onClose,
  title = scenes.length === 1 ? scenes[0]!.title : "Scene credits",
}: {
  scenes: readonly GalleryScene[];
  onClose: () => void;
  title?: string;
}) {
  return (
    <Sheet title={title} onClose={onClose} className="scene-credits-sheet">
      <SceneCreditList scenes={scenes} />
    </Sheet>
  );
}

export function SceneCreditList({ scenes }: { scenes: readonly GalleryScene[] }) {
  return (
    <ul className="scene-credits">
      {scenes.map((scene) => (
        <li key={scene.id}>
          <strong>{scene.title}</strong>
          <span>
            by{" "}
            <a href={scene.credit.authorUrl} target="_blank" rel="noreferrer">
              {scene.credit.author}
            </a>{" "}
            ·{" "}
            <a href={scene.credit.sourceUrl} target="_blank" rel="noreferrer">
              Source on SuperSplat
            </a>
          </span>
          <span>
            Licensed under{" "}
            <a href={scene.credit.licenseUrl} target="_blank" rel="noreferrer">
              {scene.credit.license}
            </a>
          </span>
          <small>{scene.credit.changes}</small>
        </li>
      ))}
    </ul>
  );
}
