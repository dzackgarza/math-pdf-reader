// Library shell: table, collections sidebar, inspector and command palette land in M2.

export default function App() {
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Library">
        <h1>PDF Bucket</h1>
      </nav>
      <main className="library" aria-label="Items" />
      <aside className="inspector" aria-label="Details" />
    </div>
  );
}
