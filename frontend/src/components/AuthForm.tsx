// login / register form with toggle.
// uses email + password auth via the api client.

import { useState, type FormEvent } from "react";
import { login, register } from "../api/client";

interface AuthFormProps {
  onAuth: () => void;
}

export default function AuthForm({ onAuth }: AuthFormProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // client-side password length check (backend enforces the real rules)
    if (!isLogin && password.length < 8) {
      setError("password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      if (isLogin) {
        await login(email, password);
      } else {
        await register(email, password);
      }
      onAuth();
    } catch (e) {
      setError(e instanceof Error ? e.message : "authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="glass-card auth-card">
        <h2>{isLogin ? "sign in" : "create account"}</h2>

        <form onSubmit={handleSubmit} id="auth-form">
          <label htmlFor="auth-email">email</label>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />

          <label htmlFor="auth-password">password</label>
          <input
            id="auth-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={isLogin ? "current-password" : "new-password"}
          />

          <button
            id="auth-submit-btn"
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading ? "..." : isLogin ? "sign in" : "register"}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}

        <p className="auth-toggle">
          {isLogin ? "no account?" : "already have an account?"}{" "}
          <button
            id="auth-toggle-btn"
            className="btn-link"
            type="button"
            onClick={() => {
              setIsLogin(!isLogin);
              setError(null);
            }}
          >
            {isLogin ? "register" : "sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
