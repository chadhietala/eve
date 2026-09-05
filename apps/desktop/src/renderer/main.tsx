import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) throw new Error("The desktop renderer has no mount point.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
