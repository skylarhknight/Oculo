// Global styles load first so screen and component stylesheets can refine them.
import "./theme/tokens.css";
import "./ui/ui.css";
import "./components/components.css";
import "./shotSheet.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
