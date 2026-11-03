import "@jsudc/react/styles.css";
import "@memento/react/styles.css";
import "@vola/react/styles.css";
import "./desk.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
