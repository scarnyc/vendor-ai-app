export default function Home() {
  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        padding: '32px',
        gap: '24px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 14,
          background: 'linear-gradient(135deg, #8E89FF 0%, #6c64f0 100%)',
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 32,
          color: '#fff',
          boxShadow: '0 6px 20px rgba(142, 137, 255, 0.35)',
        }}
        aria-hidden="true"
      >
        V
      </div>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 28,
          fontWeight: 700,
          margin: 0,
        }}
      >
        Vendor AI
      </h1>
      <p style={{ color: 'var(--color-text-mute)', maxWidth: 460, margin: 0 }}>
        Scaffold up. Workbench, persona rail, case tabs, decision packet, and HITL
        gate land in subsequent tasks. See <code style={{ fontFamily: 'var(--font-mono)' }}>DESIGN.md</code> for the spec.
      </p>
    </main>
  );
}
