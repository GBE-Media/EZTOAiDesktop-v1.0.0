import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

console.log('[MAIN] Starting EZTO Ai application...');
console.log('[MAIN] Root element:', document.getElementById("root"));

try {
  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error('Root element not found!');
  }
  
  console.log('[MAIN] Creating React root...');
  const root = createRoot(rootElement);
  
  console.log('[MAIN] Rendering App component...');
  root.render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
  
  console.log('[MAIN] App rendered successfully!');
} catch (error) {
  console.error('[MAIN] Error starting app:', error);
  document.body.innerHTML = `
    <div style="padding: 20px; color: red; font-family: monospace; background: #0a0a0a; min-height: 100vh;">
      <h1>Error Loading Application</h1>
      <pre>${error}</pre>
    </div>
  `;
}
