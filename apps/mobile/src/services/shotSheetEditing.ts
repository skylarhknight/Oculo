import type { SceneWorkspace, Shot } from "../types/project";

/** Editable names are independent of both stable IDs and sheet sequence. */
export function nextShotName(shots: readonly Shot[]): string {
  const used = new Set(shots.map((shot) => shot.name.trim().toLowerCase()));
  let number = 1;
  for (const shot of shots) {
    const match = /^shot\s+(\d+)$/i.exec(shot.name.trim());
    if (
      match &&
      Number.isSafeInteger(Number(match[1])) &&
      Number(match[1]) < Number.MAX_SAFE_INTEGER
    )
      number = Math.max(number, Number(match[1]) + 1);
  }
  let name = `Shot ${String(number).padStart(2, "0")}`;
  while (used.has(name.toLowerCase())) {
    number = number >= Number.MAX_SAFE_INTEGER ? 1 : number + 1;
    name = `Shot ${String(number).padStart(2, "0")}`;
  }
  return name;
}

/** Keep persisted and in-memory selection consistent after deleting a shot. */
export function deleteShotFromProject(project: SceneWorkspace, shotId: string): SceneWorkspace {
  const shots = project.shots.filter((shot) => shot.id !== shotId);
  const ids = new Set(shots.map((shot) => shot.id));
  return {
    ...project,
    shots,
    ...(project.shotSheet === undefined
      ? {}
      : {
          shotSheet: {
            version: 1,
            excludedShotIds: [...new Set(project.shotSheet.excludedShotIds)].filter((id) =>
              ids.has(id),
            ),
          },
        }),
  };
}

export function reorderShot(
  project: SceneWorkspace,
  shotId: string,
  direction: -1 | 1,
): SceneWorkspace["shots"] {
  const shots = [...project.shots];
  const index = shots.findIndex((shot) => shot.id === shotId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= shots.length) return shots;
  [shots[index], shots[target]] = [shots[target]!, shots[index]!];
  return shots;
}

export function setShotIncluded(
  project: SceneWorkspace,
  shotId: string,
  included: boolean,
): NonNullable<SceneWorkspace["shotSheet"]> {
  const excluded = new Set(project.shotSheet?.excludedShotIds ?? []);
  if (included) excluded.delete(shotId);
  else if (project.shots.some((shot) => shot.id === shotId)) excluded.add(shotId);
  return {
    version: 1,
    excludedShotIds: [...excluded].filter((id) => project.shots.some((shot) => shot.id === id)),
  };
}
