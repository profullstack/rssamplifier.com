export const metadata = {
  title: 'Offline',
  description: 'You are offline.',
};

/**
 * Shown by the service worker when a navigation fails and nothing is cached.
 */
export default function OfflinePage() {
  return (
    <>
      <h1>You&apos;re offline</h1>
      <p className="lede">
        This directory reads live from the database, so there is nothing useful to show without a
        connection. Pages you have already visited may still open.
      </p>
      <p>
        <a className="pill" href="/">
          Try again
        </a>
      </p>
    </>
  );
}
