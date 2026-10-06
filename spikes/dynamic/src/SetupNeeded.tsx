export function SetupNeeded() {
  return (
    <main className="shell">
      <header className="top">
        <span className="brand">Isotherm</span>
        <span className="pill warn">setup</span>
      </header>
      <section className="card">
        <h2>Dynamic environment ID missing</h2>
        <p>
          Copy <code>env.example</code> to <code>.env.local</code> and set <code>VITE_DYNAMIC_ENVIRONMENT_ID</code> to the
          Sandbox environment ID from the Dynamic dashboard (Developers → SDK &amp; API Keys). Then restart{' '}
          <code>npm run dev</code> or rebuild.
        </p>
        <p className="muted">This screen only shows when the ID is absent or still the all-zero placeholder.</p>
      </section>
    </main>
  );
}
