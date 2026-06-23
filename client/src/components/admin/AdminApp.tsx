import { useState } from "react";
import { useAdminApi } from "../../hooks/useAdminApi";
import { Overview } from "./Overview";
import { GameList } from "./GameList";
import "../../admin.css";

type Page = "overview" | "games" | "game-detail";

const ADMIN_BASE = import.meta.env.BASE_URL + "api/admin";

export function AdminApp() {
  const [authenticated, setAuthenticated] = useState<boolean>(
    !!sessionStorage.getItem("admin_token")
  );
  const [token, setToken] = useState<string>(
    sessionStorage.getItem("admin_token") ?? ""
  );
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [page, setPage] = useState<Page>("overview");
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  const { fetchOverview, fetchGames, fetchGameDetail } = useAdminApi();
  // fetchGameDetail will be used in Task 6
  void fetchGameDetail;

  function navigateToGame(gameId: string) {
    setSelectedGameId(gameId);
    setPage("game-detail");
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const res = await fetch(`${ADMIN_BASE}/overview`, {
        headers: { Authorization: `Bearer ${password}` },
      });
      if (res.status === 401) {
        setLoginError("Invalid password");
        return;
      }
      if (!res.ok) {
        setLoginError(`Server error: ${res.status}`);
        return;
      }
      sessionStorage.setItem("admin_token", password);
      setToken(password);
      setAuthenticated(true);
    } catch {
      setLoginError("Network error — is the server running?");
    } finally {
      setLoginLoading(false);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem("admin_token");
    setToken("");
    setAuthenticated(false);
    setPassword("");
  }

  if (!authenticated) {
    return (
      <div className="admin-app">
        <div className="admin-login">
          <h2>Admin</h2>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={loginLoading || !password}>
              {loginLoading ? "Checking..." : "Sign in"}
            </button>
          </form>
          {loginError && <div className="error">{loginError}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-app">
      <div className="admin-header">
        <h1>raising intelligences — admin</h1>
        <button onClick={handleLogout}>Sign out</button>
      </div>
      <div className="admin-nav">
        <button
          className={page === "overview" ? "active" : ""}
          onClick={() => setPage("overview")}
        >
          Overview
        </button>
        <button
          className={page === "games" || page === "game-detail" ? "active" : ""}
          onClick={() => setPage("games")}
        >
          Games
        </button>
      </div>
      <main>
        {page === "overview" && (
          <Overview fetchOverview={fetchOverview} token={token} />
        )}
        {page === "games" && (
          <GameList
            fetchGames={(opts) => fetchGames(token, opts)}
            onSelectGame={navigateToGame}
          />
        )}
        {page === "game-detail" && (
          <div className="loading">
            Game detail for {selectedGameId} — coming in Task 6
          </div>
        )}
      </main>
    </div>
  );
}
