import { useState } from "react";

import { api } from "./api";

export const Login = ({ onAuthed }: { onAuthed: () => void }) => {
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState(
    () => localStorage.getItem("sketchspace:username") ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      if (username.trim()) {
        localStorage.setItem("sketchspace:username", username.trim());
      }
      onAuthed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <form className="panel" onSubmit={submit}>
        <h1>SketchSpace</h1>
        <p className="muted">This instance is password protected.</p>

        <label>
          Your name
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Shown to collaborators"
            autoComplete="nickname"
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
};
