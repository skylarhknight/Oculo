import { durationMs, prefersReducedMotion } from "../theme/motion";
import { readToken } from "../theme/tokens";

/**
 * A shared-element flight: `target` has just been laid out in its final place; a copy
 * of it starts where the tapped element was (`from`) and glides into place above
 * everything, so no clipping parent cuts it off, then hands over to the real element.
 * Does nothing with Reduce Motion or without the Web Animations API.
 */
export function flyFrom(from: DOMRect, target: HTMLElement): Animation | undefined {
  if (prefersReducedMotion() || typeof target.animate !== "function") return undefined;
  const to = target.getBoundingClientRect();
  if (!(to.width > 0 && to.height > 0 && from.width > 0 && from.height > 0)) return undefined;
  const ghost = target.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("flight-ghost");
  Object.assign(ghost.style, {
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
  });
  document.body.append(ghost);
  const radius = readToken("--radius-lg", "12px");
  const flight = ghost.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${
          from.width / to.width
        }, ${from.height / to.height})`,
        borderRadius: radius,
      },
      { transform: "none", borderRadius: "0" },
    ],
    {
      duration: durationMs("--dur-sheet"),
      easing: readToken("--ease-reveal", "cubic-bezier(0.16, 1, 0.3, 1)"),
    },
  );
  target.style.visibility = "hidden";
  const land = () => {
    target.style.visibility = "";
    ghost.remove();
  };
  flight.addEventListener("finish", land);
  flight.addEventListener("cancel", land);
  return flight;
}
