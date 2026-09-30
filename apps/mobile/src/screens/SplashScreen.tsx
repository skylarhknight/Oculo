/**
 * Brand mark shown while local projects and preferences load: the eye draws itself,
 * the iris opens, the wordmark rises, and the whole mark fades as the gallery comes up.
 * The shapes match assets/icon.svg.
 */
export function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <div className="splash" data-leaving={leaving} aria-hidden={leaving} role="status">
      <span className="splash__mark">
        <svg className="eye" viewBox="0 0 1024 1024" aria-hidden="true">
          <path
            className="eye__lid"
            pathLength={1}
            d="M152 512 C252 348 348 276 448 276 H576 C676 276 772 348 872 512 C772 676 676 748 576 748 H448 C348 748 252 676 152 512 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth={64}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle
            className="eye__iris"
            cx={512}
            cy={512}
            r={128}
            fill="none"
            stroke="currentColor"
            strokeWidth={64}
          />
        </svg>
      </span>
      <span className="splash__word">Oculo</span>
      <span className="visually-hidden">Opening your projects</span>
    </div>
  );
}
