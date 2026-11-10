import { useEffect, useState, type FormEvent } from 'react';
import { clearSecret, getSecret, setSecret, setUnauthorizedHandler } from './api';
import { useRoute } from './hooks';
import { UsersList } from './UsersList';
import { UserPage } from './UserPage';

export function App() {
  const [secret, setSecretState] = useState(getSecret);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSecretState(null);
      setLoginError('Unauthorized: the admin secret was rejected. Log in again.');
    });
  }, []);

  // Flash notes belong to the page they were raised for.
  useEffect(() => {
    if (route.name !== 'users') setFlash(null);
  }, [route]);

  if (!secret) {
    return (
      <Login
        error={loginError}
        onLogin={(s) => {
          setSecret(s);
          setSecretState(s);
          setLoginError(null);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="header">
        <a href="#/" className="brand">
          Agent chat admin
        </a>
        <nav>
          <a href="#/">Users</a>
        </nav>
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => {
            clearSecret();
            setSecretState(null);
          }}
        >
          Log out
        </button>
      </header>
      <main className="main">
        {flash && (
          <div className="flash">
            <span>{flash}</span>
            <button className="btn btn-small" onClick={() => setFlash(null)}>
              Dismiss
            </button>
          </div>
        )}
        {route.name === 'users' ? (
          <UsersList />
        ) : (
          <UserPage
            key={route.userId}
            userId={route.userId}
            onDeleted={(msg) => {
              setFlash(msg);
              location.hash = '#/';
            }}
          />
        )}
      </main>
    </div>
  );
}

function Login({ error, onLogin }: { error: string | null; onLogin: (secret: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) onLogin(value.trim());
  };
  return (
    <div className="login">
      <form className="panel login-panel" onSubmit={submit}>
        <h1>Agent chat admin</h1>
        <label className="field">
          <span>Admin secret</span>
          <input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={!value.trim()}>
          Log in
        </button>
      </form>
    </div>
  );
}
