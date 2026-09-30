import { useState } from "react";
import mediaExportLicense from "../../public/licenses/mediabunny-MPL-2.0.txt?raw";
import mediaExportNotice from "../../public/licenses/mediabunny-NOTICE.txt?raw";
import lucideNotice from "../../public/licenses/lucide-icons.txt?raw";
import iconNotice from "../../public/licenses/oculo-icon.txt?raw";
import { RELEASE_LINKS } from "../config/release";
import { SCENE_GALLERY } from "../config/sceneCatalog";
import { Sheet } from "../ui/Sheet";
import { SceneCreditList } from "./SceneCredits";

export function ReleaseLinks() {
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  return (
    <nav className="release-links" aria-label="Help and legal information">
      <button className="license-link" onClick={() => setCreditsOpen(true)}>
        Scene credits
      </button>
      {creditsOpen && (
        <Sheet title="Scene credits" onClose={() => setCreditsOpen(false)}>
          <SceneCreditList scenes={SCENE_GALLERY} />
          <details>
            <summary>App icon</summary>
            <pre className="license-text">{iconNotice}</pre>
          </details>
          <details>
            <summary>Interface icons</summary>
            <pre className="license-text">{lucideNotice}</pre>
          </details>
        </Sheet>
      )}
      <button className="license-link" onClick={() => setLicenseOpen(true)}>
        Media export license
      </button>
      {licenseOpen && (
        <Sheet title="Media export license" onClose={() => setLicenseOpen(false)}>
          <pre className="license-text">{mediaExportNotice}</pre>
          <p>
            <a
              href="https://github.com/Vanilagy/mediabunny/tree/v1.56.1"
              target="_blank"
              rel="noopener noreferrer"
            >
              Mediabunny 1.56.1 source code
            </a>
          </p>
          <details>
            <summary>Mozilla Public License 2.0</summary>
            <pre className="license-text">{mediaExportLicense}</pre>
          </details>
        </Sheet>
      )}

      {RELEASE_LINKS.privacy && (
        <a href={RELEASE_LINKS.privacy} target="_blank" rel="noopener noreferrer">
          Privacy policy
        </a>
      )}
      {RELEASE_LINKS.terms && (
        <a href={RELEASE_LINKS.terms} target="_blank" rel="noopener noreferrer">
          Terms of use
        </a>
      )}
      {RELEASE_LINKS.support && (
        <a href={RELEASE_LINKS.support} target="_blank" rel="noopener noreferrer">
          Help and support
        </a>
      )}
    </nav>
  );
}
