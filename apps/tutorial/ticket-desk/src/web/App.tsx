import { MementoProvider } from "@memento/react";
import { useEffect, useState } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";
import { type Config, getConfig } from "./api.ts";
import { BoardPage } from "./BoardPage.tsx";
import { type Session, SessionContext } from "./session.ts";
import { TicketPage } from "./TicketPage.tsx";

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState("igor");
  const [locale, setLocale] = useState<Session["locale"]>("en");

  useEffect(() => {
    getConfig().then(setConfig, (reason) => setError(String(reason.message)));
  }, []);

  if (error) return <p className="notice">{error}</p>;
  if (!config) return null;

  return (
    <SessionContext.Provider value={{ ...config, user, locale }}>
      <MementoProvider baseUrl="/memento" apiKey={config.memento_key} locale={locale}>
        <BrowserRouter>
          <header className="topbar">
            <Link to="/" className="brand">
              Ticket desk
            </Link>
            <label>
              Signed in as{" "}
              <select value={user} onChange={(e) => setUser(e.target.value)}>
                {config.users.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Language{" "}
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as Session["locale"])}
              >
                <option value="en">English</option>
                <option value="sr">Srpski</option>
              </select>
            </label>
          </header>
          <Routes>
            <Route path="/" element={<BoardPage />} />
            <Route path="/t/:id" element={<TicketPage />} />
          </Routes>
        </BrowserRouter>
      </MementoProvider>
    </SessionContext.Provider>
  );
}
