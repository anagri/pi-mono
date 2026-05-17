import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OAuthCallback } from "./OAuthCallback";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
// Static path discrimination — the OAuth popup must NOT boot the Worker (which would re-open
// the Dexie connection and race the main tab). We render a tiny standalone component that just
// forwards the redirect to window.opener and closes itself.
const isOAuthCallback = window.location.pathname === "/oauth/callback";
createRoot(root).render(<StrictMode>{isOAuthCallback ? <OAuthCallback /> : <App />}</StrictMode>);
