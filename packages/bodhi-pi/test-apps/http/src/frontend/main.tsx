import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Navigate to="/http" replace />} />
				<Route path="*" element={<App />} />
			</Routes>
		</BrowserRouter>
	</StrictMode>,
);
